import { randomUUID } from 'node:crypto'
import { contentHash } from '../core/content-hash.js'
import type { ApprovalRequest } from '../core/contracts.js'
import type { ApprovalRequestedData, ApprovalResolvedData } from './contracts.js'

// D8 的单条 FIFO 审批通道：worktree 内文件写入按策略自动批准，Bash 默认询问。
// 队列中同一时刻只显示一条；每条请求的超时从真正显示给用户时开始计算，等待队列的时间不计入。
export interface ApprovalBrokerPolicy { writes: 'auto' | 'ask'; bash: 'ask' | 'auto'; perRequestTimeoutMs: number }
export interface ApprovalBrokerOptions {
  policy: ApprovalBrokerPolicy
  prompt?: (request: ApprovalRequest, meta: { requestId: string; attemptId: string; writeSet?: string[] }) => Promise<boolean>
  writeSetFor?: (attemptId: string) => readonly string[] | undefined
  onRequested?: (data: ApprovalRequestedData) => void | Promise<void>
  onResolved?: (data: ApprovalResolvedData) => void | Promise<void>
}
interface Entry {
  requestId: string
  attemptId: string
  request: ApprovalRequest
  writeSet?: string[]
  resolve: (allowed: boolean) => void
  abort: AbortController
}
interface Decision { allowed: boolean; source: ApprovalResolvedData['source'] }

export class ApprovalBroker {
  #queue: Entry[] = []
  #active?: Entry
  #cancelled = new Set<string>()
  #closed = false
  #draining = false
  #drainPromise?: Promise<void>
  constructor(private readonly options: ApprovalBrokerOptions) {
    const timeout = options.policy.perRequestTimeoutMs
    if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('approval perRequestTimeoutMs must be a positive integer')
  }
  get pending() { return this.#queue.length + (this.#active ? 1 : 0) }
  async request(attemptId: string, request: ApprovalRequest): Promise<boolean> {
    const requestId = `ar_${randomUUID()}`
    const writeSet = this.options.writeSetFor?.(attemptId)?.slice(0, 64)
    const automatic = request.tool === 'write_file' || request.tool === 'edit_file'
      ? this.options.policy.writes === 'auto'
      : request.tool === 'bash' ? this.options.policy.bash === 'auto' : false
    if (automatic || this.#closed || this.#cancelled.has(attemptId)) {
      const decision: Decision = { allowed: automatic, source: automatic ? 'auto' : 'cancelled' }
      await this.#auditRequested(requestId, attemptId, request, writeSet)
      await this.#auditResolved(requestId, attemptId, request, decision)
      return decision.allowed
    }
    return new Promise<boolean>(resolve => {
      this.#queue.push({ requestId, attemptId, request, ...(writeSet ? { writeSet } : {}), resolve, abort: new AbortController() })
      if (!this.#draining) this.#drainPromise = this.#drain()
    })
  }
  // 队列中属于该 attempt 的请求立即拒绝；正在显示的请求被中止并记为 cancelled。
  cancelAttempt(attemptId: string) {
    this.#cancelled.add(attemptId)
    if (this.#active?.attemptId === attemptId) this.#active.abort.abort()
    const remaining: Entry[] = []
    for (const entry of this.#queue) {
      if (entry.attemptId === attemptId) void this.#settle(entry, { allowed: false, source: 'cancelled' })
      else remaining.push(entry)
    }
    this.#queue = remaining
  }
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#active?.abort.abort()
    const queued = this.#queue.splice(0)
    await Promise.all(queued.map(entry => this.#settle(entry, { allowed: false, source: 'cancelled' })))
    await this.#drainPromise
  }
  async #drain() {
    if (this.#draining) return
    this.#draining = true
    try {
      while (!this.#closed && this.#queue.length) {
        const entry = this.#queue.shift()!
        if (this.#cancelled.has(entry.attemptId)) { await this.#settle(entry, { allowed: false, source: 'cancelled' }); continue }
        await this.#run(entry)
      }
    } finally {
      this.#draining = false
    }
  }
  async #run(entry: Entry) {
    this.#active = entry
    try {
      await this.#auditRequested(entry.requestId, entry.attemptId, entry.request, entry.writeSet)
      const decision = await this.#ask(entry)
      await this.#settle(entry, decision)
    } finally {
      if (this.#active === entry) this.#active = undefined
    }
  }
  #ask(entry: Entry): Promise<Decision> {
    if (entry.request.signal?.aborted) return Promise.resolve({ allowed: false, source: 'cancelled' })
    if (!this.options.prompt) return Promise.resolve({ allowed: false, source: 'cancelled' })
    return new Promise<Decision>(resolve => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = (decision: Decision) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        entry.request.signal?.removeEventListener('abort', onRequestAbort)
        entry.abort.signal.removeEventListener('abort', onAttemptAbort)
        resolve(decision)
      }
      const onRequestAbort = () => done({ allowed: false, source: 'cancelled' })
      const onAttemptAbort = () => done({ allowed: false, source: 'cancelled' })
      entry.request.signal?.addEventListener('abort', onRequestAbort, { once: true })
      entry.abort.signal.addEventListener('abort', onAttemptAbort, { once: true })
      timer = setTimeout(() => done({ allowed: false, source: 'timeout' }), this.options.policy.perRequestTimeoutMs)
      this.options.prompt!(entry.request, {
        requestId: entry.requestId, attemptId: entry.attemptId, ...(entry.writeSet ? { writeSet: entry.writeSet } : {}),
      }).then(allowed => done({ allowed, source: 'user' }), () => done({ allowed: false, source: 'user' }))
    })
  }
  async #settle(entry: Entry, decision: Decision) {
    await this.#auditResolved(entry.requestId, entry.attemptId, entry.request, decision)
    entry.resolve(decision.allowed)
  }
  // 审批审计只用于统计与展示，不是恢复依据；审计写入失败不得让 worker 的审批永远挂起。
  async #auditRequested(requestId: string, attemptId: string, request: ApprovalRequest, writeSet?: string[]) {
    try {
      await this.options.onRequested?.({
        requestId, attemptId, tool: request.tool.slice(0, 64), summaryHash: contentHash(request.summary.slice(0, 16 * 1024)),
        ...(writeSet ? { writeSet } : {}),
      })
    } catch { /* best-effort audit */ }
  }
  async #auditResolved(requestId: string, attemptId: string, request: ApprovalRequest, decision: Decision) {
    try {
      await this.options.onResolved?.({
        requestId, attemptId, tool: request.tool.slice(0, 64), allowed: decision.allowed, source: decision.source,
      })
    } catch { /* best-effort audit */ }
  }
}
