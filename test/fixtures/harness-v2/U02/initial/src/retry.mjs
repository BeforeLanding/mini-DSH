import { MAX_ATTEMPTS } from './config.mjs'
import { retryable } from './errors.mjs'
export async function withRetry(request, transport) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try { return await transport({ ...request, attempt }) }
    catch (error) { if (attempt + 1 >= MAX_ATTEMPTS || !retryable(error)) throw error }
  }
}
