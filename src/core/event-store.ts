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
  for (const line of text.split('\n').slice(0, -1)) {
    let event: unknown
    try { event = JSON.parse(line) } catch (error) { throw new Error(`corrupt JSONL record ${events.length + 1}`, { cause: error }) }
    if (!isRecord(event) || event.version !== 1 || event.sessionId !== sessionId || event.seq !== events.length + 1 || typeof event.id !== 'string' || ids.has(event.id) || typeof event.at !== 'string' || typeof event.type !== 'string' || !isRecord(event.data)) throw new Error(`invalid event envelope/version/sequence at ${events.length + 1}`)
    if ((event.taskId !== undefined && typeof event.taskId !== 'string') || (event.runId !== undefined && typeof event.runId !== 'string')) throw new Error('invalid event scope')
    validatePayload(event.type, event.data)
    const parsed = event as unknown as SessionEvent
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
