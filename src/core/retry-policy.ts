import { ProviderError } from './model-error.js'
import type { Clock } from './run-budget-runtime.js'

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.length > 128) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return Number.isSafeInteger(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1000 ? seconds * 1000 : undefined
  }
  if (!/^(?:[A-Za-z]{3},\s|[A-Za-z]+,\s|[A-Za-z]{3}\s)/.test(trimmed)) return undefined
  const date = Date.parse(trimmed)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

// attempt is the zero-based failed attempt. Only failures before streamed content
// are passed here; ModelStreamError is deliberately ineligible.
export function retryDelay(error: unknown, attempt: number, remainingMs: number, random = Math.random): number | undefined {
  if (!(error instanceof ProviderError) || attempt < 0 || attempt >= 2 || remainingMs <= 0) return undefined
  if (!(error.kind === 'rate_limit' && error.status === 429 ||
    error.kind === 'transient' && (error.status === undefined || error.status >= 500 && error.status <= 599))) return undefined
  const jitter = Math.floor(Math.max(0, Math.min(1, random())) * Math.min(8000, 500 * 2 ** attempt))
  const delay = Math.max(jitter, error.retryAfterMs ?? 0)
  return delay < remainingMs ? delay : undefined
}

export function waitForRetry(delayMs: number, signal: AbortSignal, clock: Clock): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { clock.clearTimeout(timer); reject(signal.reason ?? new Error('retry cancelled')) }
    const timer = clock.setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, delayMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
