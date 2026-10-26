import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionRuntime } from './session-runtime.js'
import { MEMORY_RECALL_LIMITS, fitMemoryRecall, memoryScore, memoryTerms, memoryValidity } from './memory-retriever.js'
import type { MemoryRecall, MemoryRecallLimits } from './memory-retriever.js'
import { memoryHash, validateMemoryRecord } from './memory-contracts.js'
import type { MemoryProposal, MemoryRecord } from './memory-contracts.js'
import type { MemoryStore } from './memory-store.js'

export interface MemoryView { id: string; projectId: string; digest: string }
export interface MemoryViewSnapshot { projectId: string; digest: string; versions: { id: string; revision: number }[] }
export class MemoryRuntime {
  #views = new Map<string, { view: MemoryView; versions: Map<string, number> }>()
  readonly limits: Readonly<MemoryRecallLimits>
  constructor(readonly store: MemoryStore, limits: Partial<MemoryRecallLimits> = {}, private now: () => number = Date.now) {
    this.limits = Object.freeze({ ...MEMORY_RECALL_LIMITS, ...limits })
    for (const [key, value] of Object.entries(this.limits)) if (!(key in MEMORY_RECALL_LIMITS) || !Number.isSafeInteger(value) || value < 1) throw new Error(`invalid memory recall limit: ${key}`)
  }
  async createView(): Promise<MemoryView> {
    const records = (await this.store.records()).filter(record => record.state === 'approved').sort((a, b) => a.id.localeCompare(b.id))
    const versions = new Map(records.map(record => [record.id, record.revision]))
    const view = Object.freeze({ id: randomUUID(), projectId: this.store.projectId, digest: memoryHash(JSON.stringify([...versions])) })
    this.#views.set(view.id, { view, versions }); return view
  }
  releaseView(view: MemoryView) { this.#views.delete(view.id) }
  snapshot(view: MemoryView): MemoryViewSnapshot { return { projectId: view.projectId, digest: view.digest, versions: [...this.#versions(view)].map(([id, revision]) => ({ id, revision })) } }
  restoreView(snapshot: MemoryViewSnapshot): MemoryView {
    const versions = new Map(snapshot.versions.map(({ id, revision }) => [id, revision]))
    if (snapshot.projectId !== this.store.projectId || versions.size !== snapshot.versions.length || snapshot.digest !== memoryHash(JSON.stringify([...versions]))) throw new Error('invalid memory view snapshot')
    const view = Object.freeze({ id: randomUUID(), projectId: snapshot.projectId, digest: snapshot.digest })
    this.#views.set(view.id, { view, versions }); return view
  }
  async review(record: MemoryRecord) { return memoryValidity({ ...record, state: 'approved' }, this.store.workspace, this.store.directory, this.limits, this.now()) }
  #versions(view: MemoryView) {
    const stored = this.#views.get(view.id)
    if (!stored || stored.view.projectId !== view.projectId || stored.view.digest !== view.digest) throw new Error('unknown or cross-project memory view')
    return stored.versions
  }
  async search(view: MemoryView, query: string): Promise<MemoryRecall> {
    if (typeof query !== 'string' || !query.trim() || Buffer.byteLength(query) > 1024) throw new Error('memory query must be nonempty and at most 1024 bytes')
    return this.#recall(view, query)
  }
  async get(view: MemoryView, id: string): Promise<MemoryRecall> { return this.#recall(view, id, id) }
  async #recall(view: MemoryView, query: string, id?: string): Promise<MemoryRecall> {
    const versions = this.#versions(view), terms = memoryTerms(query)
    const result: MemoryRecall = { projectId: this.store.projectId, viewDigest: view.digest, queryDigest: memoryHash(query), items: [], filtered: {}, candidateLimitReached: false }
    const reject = (reason: keyof MemoryRecall['filtered']) => { result.filtered[reason] = (result.filtered[reason] ?? 0) + 1 }
    // Rank before bounded I/O. The journal caps the in-memory scan; maxCandidateChecks caps source/anchor work.
    const candidates = (await this.store.records()).filter(record => id ? record.id === id : versions.has(record.id))
      .map(record => ({ record, score: id ? 1 : memoryScore(record, terms) })).filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0))
    result.candidateLimitReached = candidates.length > this.limits.maxCandidateChecks
    for (const { record } of candidates.slice(0, this.limits.maxCandidateChecks)) {
      if (record.projectId !== view.projectId || versions.get(record.id) !== record.revision) { reject('not-visible'); continue }
      const reason = await memoryValidity(record, this.store.workspace, this.store.directory, this.limits, this.now())
      if (reason) { reject(reason); continue }
      if (result.items.length < this.limits.maxItems) result.items.push(record)
      else reject('capacity')
    }
    if (id && !candidates.length) reject('not-visible')
    return fitMemoryRecall(result, this.limits)
  }
  // Only confirmed original events from this task are accepted. Do not use visibleEvents: reset hides old evidence.
  async propose(opId: string, input: MemoryProposal, sessions: Pick<SessionRuntime, 'get' | 'flush' | 'confirmedEvents' | 'latestRun'>, sessionId: string) {
    const taskId = sessions.latestRun(sessionId)?.taskId
    if (!taskId) throw new Error('memory proposal requires an active task')
    const proposal = structuredClone(input)
    const sensitive = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\b(?:api[_-]?key|password|secret|access[_-]?token)\s*[=:]\s*["']?[A-Za-z0-9_/-]{12,}/i
    if (sensitive.test(JSON.stringify(proposal)) || proposal.anchors?.some(anchor => /^(?:\.env(?:\..*)?|\.npmrc|id_rsa|id_ed25519)$/i.test(path.basename(anchor.path)))) throw new Error('memory proposal contains a sensitive path or credential pattern')
    validateMemoryRecord({ ...proposal, tags: proposal.tags ?? [], id: 'validation', projectId: this.store.projectId, revision: 1, state: 'candidate', createdAt: new Date(this.now()).toISOString() }, this.store.limits)
    const receipt = await this.store.receipt(opId)
    if (receipt?.action === 'propose') {
      // A durable receipt wins over today's anchors. Revalidate command identity in the store, not today's facts.
      for (let i = 0; i < proposal.sources.length; i++) proposal.sources[i].artifactSha256 ??= receipt.records[0].sources[i]?.artifactSha256
      return this.store.propose(opId, proposal)
    }
    await sessions.flush(sessionId)
    const confirmed = new Set(sessions.confirmedEvents(sessionId).map(event => event.seq)), originals = sessions.get(sessionId).events
    const artifacts: { target: string; bytes: Buffer }[] = []
    for (const source of proposal.sources) {
      const event = originals.find(event => event.seq === source.seq && event.id === source.eventId && event.taskId === source.taskId)
      if (source.sessionId !== sessionId || source.taskId !== taskId || !event || !confirmed.has(event.seq) ||
          (event.type === 'tool/result' && (event.data.status !== 'completed' || event.data.isError)) ||
          !['user/message', 'assistant/message', 'tool/result', 'file/observed', 'verification/result'].includes(event.type)) throw new Error('memory source is not a confirmed allowed event in this task')
      if (event.type === 'verification/result' && event.data.commandResult.exitCode !== 0) throw new Error('memory verification source is not confirmed')
      const bytes = Buffer.from(JSON.stringify({ version: 1, sessionId, taskId, eventId: event.id, seq: event.seq, event }))
      if (sensitive.test(bytes.toString('utf8'))) throw new Error('memory source contains a credential pattern')
      if (bytes.length > this.limits.maxSourceBytes) throw new Error('memory source exceeds artifact limit')
      const hash = memoryHash(bytes)
      if (source.artifactSha256 !== undefined && source.artifactSha256 !== hash) throw new Error('memory source artifact mismatch')
      source.artifactSha256 = hash; artifacts.push({ target: path.join(this.store.directory, 'sources', `${hash}.json`), bytes })
    }
    // Anchors are host-verified before proposing and again at every recall. A candidate is never self-approved.
    const check: MemoryRecord = { ...proposal, tags: proposal.tags ?? [], id: 'validation', projectId: this.store.projectId, revision: 1, state: 'approved', createdAt: new Date(this.now()).toISOString() }
    await fs.mkdir(path.join(this.store.directory, 'sources'), { recursive: true, mode: 0o700 })
    for (const artifact of artifacts) {
      const file = await fs.open(artifact.target, 'wx', 0o600).catch(async error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !artifact.bytes.equals(await fs.readFile(artifact.target))) throw error
        return undefined
      })
      if (file) try { await file.writeFile(artifact.bytes); await file.sync() } finally { await file.close() }
    }
    const reason = await memoryValidity(check, this.store.workspace, this.store.directory, this.limits, this.now())
    if (reason) throw new Error(`memory proposal evidence invalid: ${reason}`)
    return this.store.propose(opId, proposal)
  }
}
