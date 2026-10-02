import { validatePayload } from './event-validation.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import type { SessionEvent } from './contracts.js'
export interface EventStore {
  append(event: SessionEvent): Promise<void>
  read(): Promise<SessionEvent[]>
  close(): Promise<void>
}
// NX-21：崩溃之后「这把锁还是不是陈旧的」由操作者判断，但仓库此前没有可脚本化的核验入口，只能由人
// 手删文件。这个形状是交给操作者的**证据**，不是结论：pidStatus 只是线索（见 processStatus 的注释），
// eventsTail 只说明销锁之后还需不需要先隔离尾部。判定与解除都留在人那边。
export interface LockInspection {
  present: boolean
  ownerReadable: boolean
  token?: string
  pid?: number
  modifiedAt?: string
  pidStatus: 'alive' | 'not-found' | 'inconclusive'
  eventsTail: 'complete' | 'incomplete' | 'missing'
}
export class JsonlStore implements EventStore {
  #queue: Promise<void> = Promise.resolve()
  #closed = false
  #seq: number
  private constructor(public directory: string, public sessionId: string, private file: FileHandle, private lock: FileHandle, private token: string, events: SessionEvent[]) { this.#seq = events.length }
  static async quarantineTail(directory: string, sessionId: string) {
    if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw new Error('invalid session id')
    const dir = path.resolve(directory, sessionId), lockPath = path.join(dir, 'writer.lock')
    const lock = await fs.open(lockPath, 'wx', 0o600)
    try {
      const target = path.join(dir, 'events.jsonl')
      const text = await fs.readFile(target)
      if (!text.length || text.at(-1) === 10) throw new Error('no incomplete tail to quarantine')
      const prefix = text.slice(0, text.lastIndexOf(10) + 1)
      decodeLog(prefix, sessionId)
      const backup = path.join(dir, `events.quarantine-${randomUUID()}.jsonl`)
      const copy = await fs.open(backup, 'wx', 0o600)
      try { await copy.writeFile(text); await copy.sync() } finally { await copy.close() }
      const file = await fs.open(target, 'r+')
      try { await file.truncate(prefix.length); await file.sync() } finally { await file.close() }
      return backup
    } finally { await lock.close(); await fs.unlink(lockPath) }
  }
  // 纯读：与 open 不同，这里**不 mkdir**，核验不能有副作用——目录不存在就是「无锁」。
  static async inspectLock(directory: string, sessionId: string): Promise<LockInspection> {
    if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw new Error('invalid session id')
    const dir = path.resolve(directory, sessionId)
    const inspection: LockInspection = { present: false, ownerReadable: false, pidStatus: 'inconclusive', eventsTail: await tailState(path.join(dir, 'events.jsonl')) }
    const stat = await fs.stat(path.join(dir, 'writer.lock')).catch(() => undefined)
    if (!stat?.isFile()) return inspection
    inspection.present = true
    inspection.modifiedAt = stat.mtime.toISOString()
    let owner: unknown
    try { owner = JSON.parse(await fs.readFile(path.join(dir, 'writer.lock'), 'utf8')) } catch { return inspection }
    if (!isRecord(owner)) return inspection
    const token = owner.token, pid = owner.pid
    if (typeof token === 'string' && typeof pid === 'number') {
      inspection.ownerReadable = true
      inspection.token = token
      inspection.pid = pid
      inspection.pidStatus = processStatus(pid)
    }
    return inspection
  }
  // 移除必须由操作者显式表达：他把检视里看到的那个 token 原样递回来，这里才动手。检视与移除之间若有
  // 新写入者拿到锁，token 对不上就拒绝——否则删掉的是一把**活锁**，两个写入者会撞进同一份日志。
  // 与 close() 的 ownership 检查同一套语义。它不读 pid、不做任何存活判断（PLAN 的持久化一节）。
  static async removeStaleLock(directory: string, sessionId: string, token: string) {
    if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw new Error('invalid session id')
    const lockPath = path.join(path.resolve(directory, sessionId), 'writer.lock')
    const text = await fs.readFile(lockPath, 'utf8').catch(error => { throw new Error('session writer lock is gone; nothing to remove', { cause: error }) })
    let owner: unknown
    try { owner = JSON.parse(text) } catch { owner = undefined }
    if (!isRecord(owner) || owner.token !== token) throw new Error('writer lock ownership changed')
    await fs.unlink(lockPath)
  }
  static async open(directory: string, sessionId: string) {
    if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw new Error('invalid session id')
    const dir = path.resolve(directory, sessionId)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const token = randomUUID()
    const lock = await fs.open(path.join(dir, 'writer.lock'), 'wx', 0o600).catch(error => { throw new Error('session writer lock exists; verify stale locks explicitly', { cause: error }) })
    let file: FileHandle | undefined
    try {
      await lock.writeFile(JSON.stringify({ token, pid: process.pid })); await lock.sync()
      file = await fs.open(path.join(dir, 'events.jsonl'), 'a+', 0o600)
      const events = decodeLog(await fs.readFile(path.join(dir, 'events.jsonl')), sessionId)
      return new JsonlStore(dir, sessionId, file, lock, token, events)
    } catch (error) {
      await file?.close(); await lock.close(); await fs.unlink(path.join(dir, 'writer.lock'))
      throw error
    }
  }
  append(event: SessionEvent): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('event store is closed'))
    const line = JSON.stringify(event) + '\n'
    const seq = event.seq
    const next = this.#queue.then(async () => {
      if (event.sessionId !== this.sessionId || seq !== this.#seq + 1) throw new Error('event sequence/session mismatch')
      await this.file.writeFile(line, 'utf8')
      await this.file.sync()
      this.#seq = seq
    })
    this.#queue = next
    void next.catch(() => {})
    return next
  }
  async read() { await this.#queue; return decodeLog(await fs.readFile(path.join(this.directory, 'events.jsonl')), this.sessionId) }
  async close() {
    if (this.#closed) return
    this.#closed = true
    let failure: unknown
    try { await this.#queue } catch (error) { failure = error }
    await this.file.close(); await this.lock.close()
    const lockPath = path.join(this.directory, 'writer.lock')
    const owner: unknown = JSON.parse(await fs.readFile(lockPath, 'utf8'))
    if (!isRecord(owner) || owner.token !== this.token) throw new Error('writer lock ownership changed')
    await fs.unlink(lockPath)
    if (failure) throw failure
  }
}
export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const errnoOf = (error: unknown): unknown => (error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined)
// pid 生存探针，**只作线索**：pid 复用意味着 alive 不能证明「持有者还在」，not-found 也不能证明「持有者
// 一定不在」（容器／命名空间里那个 pid 未必是本机的）。pid ≤ 0 一律 inconclusive——win32 上
// process.kill(0, 0) 会成功，直接问会拿到一个假的 alive。EPERM 表示进程存在但无权发信号，归入 alive。
function processStatus(pid: number): LockInspection['pidStatus'] {
  if (!Number.isInteger(pid) || pid <= 0) return 'inconclusive'
  try { process.kill(pid, 0); return 'alive' }
  catch (error) { const code = errnoOf(error); return code === 'ESRCH' ? 'not-found' : code === 'EPERM' ? 'alive' : 'inconclusive' }
}
// events.jsonl 的尾部状态决定「销完锁还要不要先隔离」。只看最后一个字节，口径与 decodeLog 一致：
// 末字节不是换行就是半条记录（空文件与缺文件分别按 complete／missing）。
async function tailState(eventsPath: string): Promise<LockInspection['eventsTail']> {
  const handle = await fs.open(eventsPath, 'r').catch(() => undefined)
  if (!handle) return 'missing'
  try {
    const size = (await handle.stat()).size
    if (!size) return 'complete'
    const last = new Uint8Array(1)
    await handle.read(last, 0, 1, size - 1)
    return last[0] === 10 ? 'complete' : 'incomplete'
  } finally { await handle.close() }
}
export function decodeLog(bytes: Uint8Array, sessionId: string) {
  if (bytes.length && bytes[bytes.length - 1] !== 10) throw new Error('incomplete JSONL tail; preserve and quarantine before recovery')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch (error) { throw new Error('corrupt UTF-8 in JSONL', { cause: error }) }
  return parseLog(text, sessionId)
}
export function parseLog(text: string, sessionId: string): SessionEvent[] {
  if (text && !text.endsWith('\n')) throw new Error('incomplete JSONL tail; preserve and quarantine before recovery')
  const events: SessionEvent[] = []
  const ids = new Set<string>()
  const runs = new Map<string, { taskId: string; ended: boolean }>()
  const requests = new Set<string>(), usages = new Set<string>(), ends = new Set<string>()
  const changes = new Map<string, { taskId: string; runId: string; planned: boolean }>(), results = new Set<string>()
  const verifications = new Map<string, { taskId: string; runId: string; data: import('./task-verification.js').VerificationStart }>(), verificationResults = new Set<string>()
  for (const line of text.split('\n').slice(0, -1)) {
    let event: unknown
    try { event = JSON.parse(line) } catch (error) { throw new Error(`corrupt JSONL record ${events.length + 1}`, { cause: error }) }
    if (!isRecord(event) || event.version !== 1 || event.sessionId !== sessionId || event.seq !== events.length + 1 || typeof event.id !== 'string' || ids.has(event.id) || typeof event.at !== 'string' || typeof event.type !== 'string' || !isRecord(event.data)) throw new Error(`invalid event envelope/version/sequence at ${events.length + 1}`)
    if ((event.taskId !== undefined && typeof event.taskId !== 'string') || (event.runId !== undefined && typeof event.runId !== 'string')) throw new Error('invalid event scope')
    validatePayload(event.type, event.data)
    const parsed = event as unknown as SessionEvent
    if (parsed.type === 'verification/start' || parsed.type === 'verification/result') {
      const run = parsed.runId ? runs.get(parsed.runId) : undefined
      if (!run || run.taskId !== parsed.taskId) throw new Error('verification event scope mismatch')
      const id = parsed.data.verificationId
      if (parsed.type === 'verification/start') {
        if (verifications.has(id) || run.ended) throw new Error('duplicate or late verification start')
        verifications.set(id, { taskId: parsed.taskId!, runId: parsed.runId!, data: parsed.data })
      } else {
        const start = verifications.get(id)
        if (!start || verificationResults.has(id) || start.taskId !== parsed.taskId || start.runId !== parsed.runId || start.data.command !== parsed.data.commandResult.command || start.data.cwd !== parsed.data.commandResult.cwd || JSON.stringify(start.data.files.map(f => f.path)) !== JSON.stringify(parsed.data.files.map(f => f.path))) throw new Error('missing/duplicate or mismatched verification result')
        verificationResults.add(id)
      }
    }
    if (parsed.type.startsWith('file/')) {
      const run = parsed.runId ? runs.get(parsed.runId) : undefined
      // A cooperative tool may finish journaling after cancellation seals the run.
      if (!run || run.taskId !== parsed.taskId) throw new Error('file event scope mismatch')
      if (parsed.type === 'file/change') {
        if (changes.has(parsed.data.changeId)) throw new Error('duplicate file change')
        changes.set(parsed.data.changeId, { taskId: parsed.taskId!, runId: parsed.runId!, planned: !!parsed.data.before && !!parsed.data.after })
      }
      if (parsed.type === 'file/change-result') {
        const change = changes.get(parsed.data.changeId)
        if (!change || results.has(parsed.data.changeId) || change.taskId !== parsed.taskId || change.runId !== parsed.runId || (parsed.data.status !== 'failed' && !change.planned)) throw new Error('missing/duplicate or mismatched file change result')
        results.add(parsed.data.changeId)
      }
    }
    if (parsed.type === 'run/start' || parsed.type === 'run/finish') {
      const state = parsed.data.state
      if (state.sessionId !== sessionId || parsed.runId !== state.runId || parsed.taskId !== state.taskId) throw new Error('run scope mismatch')
      if (parsed.type === 'run/start') {
        if (runs.has(state.runId)) throw new Error('duplicate run start')
        runs.set(state.runId, { taskId: state.taskId, ended: false })
      } else {
        const run = runs.get(state.runId)
        if (!run || run.ended || run.taskId !== state.taskId) throw new Error('missing/duplicate run terminal')
        run.ended = true
      }
    }
    if (parsed.type === 'model/start') {
      if (requests.has(parsed.data.requestId)) throw new Error('duplicate model request')
      requests.add(parsed.data.requestId)
    }
    if (parsed.type === 'model/usage' || parsed.type === 'model/end' || parsed.type === 'model/fragment') {
      const requestId = parsed.data.requestId
      if (!requests.has(requestId)) throw new Error('missing model request start')
      if (parsed.type === 'model/usage') { if (usages.has(requestId)) throw new Error('duplicate model usage'); usages.add(requestId) }
      if (parsed.type === 'model/end') { if (ends.has(requestId)) throw new Error('duplicate model end'); ends.add(requestId) }
      if (parsed.type === 'model/fragment' && ends.has(requestId)) throw new Error('fragment after model end')
    }
    ids.add(event.id)
    events.push(parsed)
  }
  return events
}
