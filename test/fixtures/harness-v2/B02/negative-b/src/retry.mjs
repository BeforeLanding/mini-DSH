import { MAX_ATTEMPTS } from './config.mjs'
import { retryable, abortError } from './errors.mjs'
import { makeAttempt } from './attempt.mjs'
import { nextTurn } from './delay.mjs'
export async function retry(payload, transport, signal) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw abortError()
    try { return await transport(makeAttempt(payload, attempt)) }
    catch (error) {
      if (!retryable(error)) return null
      if (attempt + 1 >= MAX_ATTEMPTS) throw error
      if (signal?.aborted) throw abortError()
      await nextTurn()
    }
  }
}
