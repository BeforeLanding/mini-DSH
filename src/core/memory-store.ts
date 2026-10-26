import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { MEMORY_LIMITS, memoryDigest, memoryHash, memoryId, recordObject, sha256, validateMemoryRecord } from './memory-contracts.js'
import type { MemoryLimits, MemoryProposal, MemoryRecord } from './memory-contracts.js'

interface MemoryEvent { version: 1; projectId: string; seq: number; opId: string; commandDigest: string; at: string; action: 'propose' | 'approve' | 'revoke'; records: MemoryRecord[] }
export interface MemoryStoreOptions { directory: string; workspace: string; projectId?: string; readOnly?: boolean; limits?: Partial<MemoryLimits> }
export async function memoryProjectId(workspace: string) {
  const real = await fs.realpath(workspace)
  return memoryHash(process.platform === 'win32' ? real.toLowerCase() : real)
}

// Independent journal: SessionEvent's vocabulary and recovery rules do not apply here.
export class MemoryStore {
  #records = new Map<string, MemoryRecord>()
  #ops = new Map<string, MemoryEvent>()
  #seq = 0
  #bytes = 0
  #queue: Promise<void> = Promise.resolve()
  #closed = false
  #failure: unknown
  private constructor(readonly directory: string, readonly workspace: string, readonly projectId: string, readonly limits: MemoryLimits,
    private file?: FileHandle, private lock?: FileHandle, private token?: string) {}
  get readOnly() { return !this.file }
  static async open(options: MemoryStoreOptions) {
    const workspace = await fs.realpath(options.workspace), projectId = options.projectId ?? await memoryProjectId(workspace)
    if (!sha256(projectId)) throw new Error('invalid memory project id')
    const limits = { ...MEMORY_LIMITS, ...options.limits }
    for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid memory limit: ${key}`)
    const directory = path.join(path.resolve(options.directory), projectId)
    const store = new MemoryStore(directory, workspace, projectId, Object.freeze(limits))
    try {
      if (!options.readOnly) {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 })
        store.lock = await fs.open(path.join(directory, 'writer.lock'), 'wx', 0o600).catch(error => { throw new Error('memory writer lock exists; open explicitly read-only or inspect the lock', { cause: error }) })
        store.token = randomUUID()
        await store.lock.writeFile(JSON.stringify({ token: store.token, pid: process.pid })); await store.lock.sync()
        store.file = await fs.open(path.join(directory, 'events.jsonl'), 'a+', 0o600)
      }
      await store.#load()
      return store
    } catch (error) {
      await store.file?.close(); await store.lock?.close()
      if (store.lock) await fs.unlink(path.join(directory, 'writer.lock'))
      throw error
    }
  }
  async #load() {
    const target = path.join(this.directory, 'events.jsonl')
    const stat = await fs.stat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && this.readOnly) return undefined; throw error })
    if (!stat) return
    if (stat.size > this.limits.maxJournalBytes) throw new Error('memory journal limit exceeded')
    const bytes = await fs.readFile(target)
    if (bytes.length && bytes.at(-1) !== 10) throw new Error('incomplete memory JSONL tail; preserve and quarantine before opening')
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    for (const line of source.split('\n').slice(0, -1)) {
      const event: unknown = JSON.parse(line)
      if (!recordObject(event) || event.version !== 1 || event.projectId !== this.projectId || event.seq !== this.#seq + 1 || !memoryId(event.opId) || this.#ops.has(event.opId) || !sha256(event.commandDigest) || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at)) || !['propose', 'approve', 'revoke'].includes(String(event.action)) || !Array.isArray(event.records) || !event.records.length || event.records.length > 2) throw new Error('invalid memory event/version/sequence')
      for (const record of event.records) {
        validateMemoryRecord(record, this.limits)
        const previous = this.#records.get(record.id)
        if (record.projectId !== this.projectId || record.revision !== (previous?.revision ?? 0) + 1 || (event.action === 'propose' ? previous !== undefined || record.state !== 'candidate' : !previous || !(['approved', 'superseded', 'revoked'].includes(record.state)))) throw new Error('invalid memory transition')
      }
      const records = event.records as MemoryRecord[]
      if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('duplicate memory revision')
      if (event.action === 'propose') {
        if (records.length !== 1 || records[0].approvedAt !== undefined) throw new Error('invalid candidate event')
      } else {
        const first = records[0], previous = this.#records.get(first.id)!
        const expected = event.action === 'approve'
          ? { ...previous, revision: previous.revision + 1, state: 'approved', approvedAt: first.approvedAt }
          : { ...previous, revision: previous.revision + 1, state: 'revoked' }
        if (JSON.stringify(first) !== JSON.stringify(expected) || (event.action === 'approve' && (previous.state !== 'candidate' || !first.approvedAt)) || (event.action === 'revoke' && records.length !== 1)) throw new Error('memory update changed immutable content')
        if (event.action === 'approve') {
          const conflict = [...this.#records.values()].find(other => other.key === first.key && other.state === 'approved')
          if (first.supersedes) {
            const old = this.#records.get(first.supersedes.id), replacement = records[1]
            if (old?.state !== 'approved' || old.revision !== first.supersedes.revision || old.key !== first.key || JSON.stringify(replacement) !== JSON.stringify({ ...old, revision: old.revision + 1, state: 'superseded' })) throw new Error('invalid superseding memory event')
          } else if (records.length !== 1 || conflict) throw new Error('conflicting memory event')
        }
      }
      this.#apply(event as unknown as MemoryEvent)
    }
    this.#bytes = bytes.length
  }
  #apply(event: MemoryEvent) {
    for (const record of event.records) this.#records.set(record.id, structuredClone(record))
    this.#ops.set(event.opId, structuredClone(event)); this.#seq = event.seq
  }
  async records() { await this.#queue; return structuredClone([...this.#records.values()]) }
  async get(id: string) { await this.#queue; return structuredClone(this.#records.get(id)) }
  async receipt(opId: string) { await this.#queue; return structuredClone(this.#ops.get(opId)) }
  #write(opId: string, action: MemoryEvent['action'], command: unknown, build: () => MemoryRecord[]): Promise<MemoryRecord[]> {
    if (this.#closed || this.readOnly) return Promise.reject(new Error('memory store is closed or read-only'))
    const digest = memoryHash(JSON.stringify(command))
    const next = this.#queue.then(async () => {
      if (this.#failure) throw new Error('memory storage failed; close and inspect before retrying', { cause: this.#failure })
      if (!memoryId(opId)) throw new Error('invalid memory opId')
      const existing = this.#ops.get(opId)
      if (existing) { if (existing.commandDigest !== digest || existing.action !== action) throw new Error('memory opId reused for a different operation'); return structuredClone(existing.records) }
      const records = build()
      for (const record of records) validateMemoryRecord(record, this.limits)
      const event: MemoryEvent = { version: 1, projectId: this.projectId, seq: this.#seq + 1, opId, commandDigest: digest, at: new Date().toISOString(), action, records }
      const line = JSON.stringify(event) + '\n'
      if (this.#bytes + Buffer.byteLength(line) > this.limits.maxJournalBytes) throw new Error('memory journal limit exceeded; maintenance required')
      try { await this.file!.writeFile(line, 'utf8'); await this.file!.sync() } catch (error) { this.#failure = error; throw error }
      this.#bytes += Buffer.byteLength(line); this.#apply(event)
      return structuredClone(records)
    })
    this.#queue = next.then(() => {}, () => {})
    return next
  }
  async propose(opId: string, input: MemoryProposal) {
    const proposal = structuredClone(input)
    return (await this.#write(opId, 'propose', proposal, () => {
      if ([...this.#records.values()].filter(record => record.state === 'candidate' || record.state === 'approved').length >= this.limits.maxActiveRecords) throw new Error('active memory limit exceeded')
      return [{ ...proposal, key: proposal.key.trim().toLowerCase(), tags: proposal.tags ?? [], id: randomUUID(), projectId: this.projectId, revision: 1, state: 'candidate', createdAt: new Date().toISOString() }]
    }))[0]
  }
  async approve(opId: string, id: string, revision: number, digest: string) {
    return (await this.#write(opId, 'approve', { id, revision, digest }, () => {
      const record = this.#records.get(id)
      if (record?.state !== 'candidate' || record.revision !== revision || memoryDigest(record) !== digest) throw new Error('memory approval revision/content mismatch')
      const changes: MemoryRecord[] = []
      const conflict = [...this.#records.values()].find(other => other.key === record.key && other.state === 'approved')
      if (record.supersedes) {
        const previous = this.#records.get(record.supersedes.id)
        if (previous?.state !== 'approved' || previous.revision !== record.supersedes.revision || previous.key !== record.key) throw new Error('memory superseded revision mismatch')
        changes.push({ ...previous, revision: previous.revision + 1, state: 'superseded' })
      }
      if (conflict && !changes.some(change => change.id === conflict.id)) throw new Error('conflicting approved memory; explicit supersedes required')
      return [{ ...record, revision: record.revision + 1, state: 'approved', approvedAt: new Date().toISOString() }, ...changes]
    }))[0]
  }
  async revoke(opId: string, id: string, revision: number) {
    return (await this.#write(opId, 'revoke', { id, revision }, () => {
      const record = this.#records.get(id)
      if (!record || record.revision !== revision) throw new Error('memory revision mismatch')
      return [{ ...record, revision: record.revision + 1, state: 'revoked' }]
    }))[0]
  }
  async rebuildIndex() {
    await this.#queue
    if (this.#closed || this.readOnly || this.#failure) throw new Error('memory index requires a healthy writer')
    const temporary = path.join(this.directory, `index-${randomUUID()}.tmp`)
    const file = await fs.open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify({ version: 1, projectId: this.projectId, seq: this.#seq, records: [...this.#records.values()] })); await file.sync() } finally { await file.close() }
    await fs.rename(temporary, path.join(this.directory, 'index.json'))
  }
  async close() {
    if (this.#closed) return
    this.#closed = true; await this.#queue
    await this.file?.close(); await this.lock?.close()
    if (this.lock) {
      const target = path.join(this.directory, 'writer.lock'), owner: unknown = JSON.parse(await fs.readFile(target, 'utf8'))
      if (!recordObject(owner) || owner.token !== this.token) throw new Error('memory writer lock ownership changed')
      await fs.unlink(target)
    }
  }
}
