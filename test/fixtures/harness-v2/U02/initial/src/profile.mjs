import { cacheKey } from './cache-key.mjs'
import { readCache, writeCache, clearCache } from './cache.mjs'
import { withRetry } from './retry.mjs'
export async function getProfile(request, transport) {
  const key = cacheKey(request)
  const cached = readCache(key)
  if (cached !== undefined) return cached
  const result = await withRetry(request, transport)
  writeCache(key, result)
  return result
}
export const resetProfiles = clearCache
