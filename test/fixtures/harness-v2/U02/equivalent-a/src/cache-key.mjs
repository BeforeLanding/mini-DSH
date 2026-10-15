export function cacheKey(request) { return `${request.tenant.length}:${request.tenant}|${request.id.length}:${request.id}` }
