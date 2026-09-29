import { BudgetStop } from './budget.js'
import type { BudgetPolicy, RunState, StopReason } from './budget.js'
export interface Clock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
}
export const systemClock: Clock = {
  now: () => performance.now(), setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
}
export class RunBudgetRuntime {
  #controller = new AbortController()
  #timer: unknown
  #started: number
  #pausedAt?: number
  #pausedMs = 0
  #approvalMs = 0
  #closed = false
  #cancel = () => this.stop('cancelled')
  constructor(public policy: Readonly<BudgetPolicy>, private state: RunState, private userSignal?: AbortSignal, private clock: Clock = systemClock) {
    this.#started = clock.now()
    userSignal?.addEventListener('abort', this.#cancel, { once: true })
    if (userSignal?.aborted) this.#cancel()
    this.#schedule()
  }
  get signal() { return this.#controller.signal }
  get activeDurationMs() { return Math.max(0, (this.#pausedAt ?? this.clock.now()) - this.#started - this.#pausedMs) }
  get approvalDurationMs() { return this.#approvalMs + (this.#pausedAt === undefined ? 0 : this.clock.now() - this.#pausedAt) }
  get stopReason(): Exclude<StopReason, 'completed'> | undefined {
    if (this.userSignal?.aborted) return 'cancelled'
    if (this.signal.aborted && this.signal.reason instanceof BudgetStop) return this.signal.reason.reason
    if (this.policy.maxActiveDurationMs !== undefined && this.activeDurationMs >= this.policy.maxActiveDurationMs) return 'timeout'
    return undefined
  }
  stop(reason: Exclude<StopReason, 'completed'>) { if (!this.signal.aborted && !this.#closed) this.#controller.abort(new BudgetStop(reason, this.state)) }
  check() { const reason = this.stopReason; if (reason) { this.stop(reason); throw new BudgetStop(reason, this.state) } }
  outputAllowance(inputTokens: number): number | undefined {
    if (this.policy.maxTotalTokens === undefined) return this.policy.maxOutputTokens
    const maximum = this.policy.maxOutputTokens ?? 16_384
    const minimum = this.policy.minimumOutputTokens ?? Math.min(4096, maximum)
    const remaining = this.policy.maxTotalTokens - this.state.counters.totalTokens - inputTokens
    if (remaining < minimum) throw new BudgetStop('token_budget', this.state)
    return Math.min(maximum, remaining)
  }
  #schedule() {
    this.clock.clearTimeout(this.#timer)
    if (this.#closed || this.#pausedAt !== undefined || this.signal.aborted || this.policy.maxActiveDurationMs === undefined) return
    const remaining = this.policy.maxActiveDurationMs - this.activeDurationMs
    if (remaining <= 0) this.stop('timeout')
    else this.#timer = this.clock.setTimeout(() => this.#schedule(), Math.min(remaining, 2_147_483_647))
  }
  async wait<T>(work: () => Promise<T>, timeoutMs?: number, timeoutReason: 'request_timeout' | 'approval_timeout' = 'request_timeout'): Promise<T> {
    this.check()
    let timer: unknown
    let abort: () => void = () => {}
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(new BudgetStop(this.stopReason ?? 'cancelled', this.state))
      this.signal.addEventListener('abort', abort, { once: true })
      if (timeoutMs !== undefined) {
        const deadline = this.clock.now() + timeoutMs
        const schedule = () => {
          const remaining = deadline - this.clock.now()
          if (remaining <= 0) this.stop(timeoutReason)
          else timer = this.clock.setTimeout(schedule, Math.min(remaining, 2_147_483_647))
        }
        schedule()
      }
    })
    try {
      if (this.signal.aborted) abort()
      const value = await Promise.race([work(), interrupted])
      return value
    } finally { this.clock.clearTimeout(timer); this.signal.removeEventListener('abort', abort) }
  }
  async approve<T>(work: () => Promise<T>): Promise<T> {
    this.check()
    if (this.#pausedAt !== undefined) throw new Error('nested approval is unsupported')
    this.#pausedAt = this.clock.now()
    this.clock.clearTimeout(this.#timer)
    try { return await this.wait(work, this.policy.approvalTimeoutMs ?? 300_000, 'approval_timeout') }
    finally {
      const pausedMs = this.clock.now() - this.#pausedAt
      this.#pausedMs += pausedMs
      this.#approvalMs += pausedMs
      this.#pausedAt = undefined
      this.#schedule()
    }
  }
  dispose() {
    this.#closed = true
    this.clock.clearTimeout(this.#timer)
    this.userSignal?.removeEventListener('abort', this.#cancel)
  }
}
