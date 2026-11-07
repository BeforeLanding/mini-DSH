import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { decodeOrchestrationLog, validateOrchestrationData } from './validation.js'
import type { OrchEventData, OrchEventType, OrchestrationEvent, OrchestrationEventUnion } from './contracts.js'

const ROOT_ID = /^rt_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export const newRootId = () => `rt_${randomUUID()}`
export function assertRootId(rootId: string) {
  if (!ROOT_ID.test(rootId)) throw new Error('invalid orchestration root id')
}
export const orchestrationDirectory = (baseDirectory: string, rootId: string) => {
  assertRootId(rootId)
  return path.join(baseDirectory, rootId)
}
// 内容寻址的有界制品：结果、验证摘要与报告。文件名由内容哈希决定，重复写入天然幂等。
export async function writeArtifact(directory: string, value: unknown, maxBytes = 64 * 1024) {
  const text = JSON.stringify(value)
  const bytes = Buffer.byteLength(text)
  if (bytes > maxBytes) throw new Error(`artifact exceeds ${maxBytes} bytes`)
  const hash = createHash('sha256').update(text).digest('hex')
  const dir = path.resolve(directory)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const target = path.join(dir, `sha256-${hash}.json`)
  const handle = await fs.open(target, 'wx', 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
    throw error
  })
  if (handle) { try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() } }
  return { ref: `sha256:${hash}`, path: target, bytes }
}

// 编排日志：单写入者、逐条 fsync、写前日志。与会话日志（core/event-store.ts）分开存放，
// 会话事件契约不变；writer.lock 的语义与 JsonlStore 相同（第二个进程拒绝打开）。
export class OrchestrationStore {
  #queue: Promise<void> = Promise.resolve()
  #closed = false
  #failed: unknown
  #seq: number
  #events: OrchestrationEventUnion[]
  private constructor(readonly directory: string, readonly rootId: string, private file: FileHandle, private lock: FileHandle, private token: string, events: OrchestrationEventUnion[], private now: () => string) {
    this.#events = events
    this.#seq = events.length
  }
  static async open(directory: string, rootId: string, options: { now?: () => string } = {}) {
    assertRootId(rootId)
    const dir = path.resolve(directory)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const token = randomUUID()
    const lock = await fs.open(path.join(dir, 'writer.lock'), 'wx', 0o600).catch(error => { throw new Error('orchestration writer lock exists; verify stale locks explicitly', { cause: error }) })
    let file: FileHandle | undefined
    try {
      await lock.writeFile(JSON.stringify({ token, pid: process.pid })); await lock.sync()
      file = await fs.open(path.join(dir, 'orchestration.jsonl'), 'a+', 0o600)
      const events = decodeOrchestrationLog(await fs.readFile(path.join(dir, 'orchestration.jsonl'), 'utf8'), rootId)
      return new OrchestrationStore(dir, rootId, file, lock, token, events, options.now ?? (() => new Date().toISOString()))
    } catch (error) {
      await file?.close(); await lock.close(); await fs.unlink(path.join(dir, 'writer.lock')).catch(() => {})
      throw error
    }
  }
  // 尾部半行只能由操作者显式隔离：先校验前缀是完整且合法的日志，再复制原文留档并截断。
  static async quarantineTail(directory: string, rootId: string) {
    assertRootId(rootId)
    const dir = path.resolve(directory), lockPath = path.join(dir, 'writer.lock')
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const lock = await fs.open(lockPath, 'wx', 0o600)
    try {
      const target = path.join(dir, 'orchestration.jsonl')
      const text = await fs.readFile(target, 'utf8')
      if (!text.length || text.endsWith('\n')) throw new Error('no incomplete tail to quarantine')
      const prefix = text.slice(0, text.lastIndexOf('\n') + 1)
      decodeOrchestrationLog(prefix, rootId)
      const backup = path.join(dir, `orchestration.quarantine-${randomUUID()}.jsonl`)
      const copy = await fs.open(backup, 'wx', 0o600)
      try { await copy.writeFile(text); await copy.sync() } finally { await copy.close() }
      const file = await fs.open(target, 'r+')
      try { await file.truncate(prefix.length); await file.sync() } finally { await file.close() }
      return backup
    } finally {
      await lock.close()
      await fs.unlink(lockPath).catch(() => {})
    }
  }
  append<K extends OrchEventType>(type: K, data: OrchEventData[K]): Promise<OrchestrationEvent<K>> {
    if (this.#closed) return Promise.reject(new Error('orchestration store is closed'))
    const operation = this.#queue.then(async () => {
      if (this.#failed) throw new Error('orchestration persistence failed', { cause: this.#failed })
      validateOrchestrationData(type, data as unknown as Record<string, unknown>)
      const event = { v: 1, rootId: this.rootId, seq: this.#seq + 1, id: `ev_${randomUUID()}`, at: this.now(), type, data } as OrchestrationEvent<K>
      try {
        await this.file.writeFile(JSON.stringify(event) + '\n', 'utf8')
        await this.file.sync()
      } catch (error) {
        // 半条写入之后继续追加会把尾部损坏变成中间损坏；失败即封存，交由恢复流程隔离。
        this.#failed = error
        throw error
      }
      this.#seq = event.seq
      this.#events.push(event as OrchestrationEventUnion)
      return event
    })
    this.#queue = operation.then(() => {}, () => {})
    return operation
  }
  // GroupJournal.read 是同步接口：协调器在 openJournal 时读取已有预算事件。
  // 缓存只在 append 落盘成功后更新，所以读到的永远是已持久化的事实。
  events(): readonly OrchestrationEventUnion[] { return this.#events }
  async read() {
    await this.#queue
    return decodeOrchestrationLog(await fs.readFile(path.join(this.directory, 'orchestration.jsonl'), 'utf8'), this.rootId)
  }
  async close() {
    if (this.#closed) return
    this.#closed = true
    let failure: unknown
    try { await this.#queue } catch (error) { failure = error }
    await this.file.close(); await this.lock.close()
    const lockPath = path.join(this.directory, 'writer.lock')
    const owner: unknown = JSON.parse(await fs.readFile(lockPath, 'utf8'))
    if (!owner || typeof owner !== 'object' || (owner as { token?: unknown }).token !== this.token) throw new Error('orchestration writer lock ownership changed')
    await fs.unlink(lockPath)
    if (failure) throw failure
  }
}
