import type { ChatResponse } from './contracts.js'

export type ProviderErrorKind = 'auth' | 'invalid_request' | 'context_overflow' | 'rate_limit' | 'transient' | 'timeout' | 'cancelled' | 'protocol' | 'unknown'
const safeMessages: Record<ProviderErrorKind, string> = {
  auth: 'Provider authentication failed', invalid_request: 'Provider rejected the request', context_overflow: 'Provider context window exceeded',
  rate_limit: 'Provider rate limit reached', transient: 'Provider temporarily unavailable', timeout: 'Provider request timed out',
  cancelled: 'Provider request cancelled', protocol: 'Provider response was invalid', unknown: 'Provider request failed',
}
export class ProviderError extends Error {
  readonly safeMessage: string
  constructor(public readonly kind: ProviderErrorKind, public readonly status?: number, public readonly retryable = false, public readonly providerRequestId?: string) {
    super(safeMessages[kind])
    this.name = 'ProviderError'
    this.safeMessage = safeMessages[kind]
  }
}

export function classifyHttpError(status: number, preview = '', requestId?: string): ProviderError {
  const kind: ProviderErrorKind = status === 401 || status === 403 ? 'auth'
    : status === 429 ? 'rate_limit'
    : status === 408 || status === 504 ? 'timeout'
    : status >= 500 ? 'transient'
    : /context.{0,30}(?:length|window)|maximum.{0,30}(?:context|tokens)/i.test(preview) ? 'context_overflow'
    : status >= 400 && status < 500 ? 'invalid_request' : 'unknown'
  return new ProviderError(kind, status, kind === 'rate_limit' || kind === 'transient' || kind === 'timeout', requestId && /^[\w.:-]{1,128}$/.test(requestId) ? requestId : undefined)
}

export function classifyTransportError(error: unknown, aborted = false): ProviderError {
  if (aborted || (error instanceof Error && error.name === 'AbortError')) return new ProviderError('cancelled')
  if (error instanceof Error && error.name === 'TimeoutError') return new ProviderError('timeout', undefined, true)
  if (error instanceof TypeError) return new ProviderError('transient', undefined, true)
  return new ProviderError('unknown')
}

export class ModelStreamError extends Error {
  constructor(message: string, public partial: ChatResponse, cause?: unknown) { super(message, { cause }) }
}
