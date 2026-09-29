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
      const events = parseLog(await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8'), sessionId)
      return new JsonlStore(dir, sessionId, file, lock, token, events)
    } catch (error) {
      await file?.close(); await lock.close(); await fs.unlink(path.join(dir, 'writer.lock'))
      throw error
    }
  }
  append(event: SessionEvent): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('event store is closed'))
    // Serialize at enqueue time, so later caller mutations cannot affect disk.
    const line = JSON.stringify(event) + '\n'
    const seq = event.seq
    const next = this.#queue.then(async () => {
      if (event.sessionId !== this.sessionId || seq !== this.#seq + 1) throw new Error('event sequence/session mismatch')
      await this.file.writeFile(line, 'utf8')
      await this.file.sync()
      this.#seq = seq
    })
    this.#queue = next
    // Keep rejection observable through append/read/close without an unhandled rejection.
    void next.catch(() => {})
    return next
  }
  async read() { await this.#queue; return parseLog(await fs.readFile(path.join(this.directory, 'events.jsonl'), 'utf8'), this.sessionId) }
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
// Full payload validation is applied by the recovery layer; envelopes are never skipped.
export function parseLog(text: string, sessionId: string): SessionEvent[] {
  if (text && !text.endsWith('\n')) throw new Error('incomplete JSONL tail; preserve and quarantine before recovery')
  const events: SessionEvent[] = []
  const ids = new Set<string>()
  for (const line of text.split('\n').slice(0, -1)) {
    let event: unknown
    try { event = JSON.parse(line) } catch (error) { throw new Error(`corrupt JSONL record ${events.length + 1}`, { cause: error }) }
    if (!isRecord(event) || event.version !== 1 || event.sessionId !== sessionId || event.seq !== events.length + 1 || typeof event.id !== 'string' || ids.has(event.id) || typeof event.at !== 'string' || typeof event.type !== 'string' || !isRecord(event.data)) throw new Error(`invalid event envelope/version/sequence at ${events.length + 1}`)
    ids.add(event.id)
    events.push(event as unknown as SessionEvent)
  }
  return events
}
