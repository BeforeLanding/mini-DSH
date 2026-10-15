export const cacheKey = request => [request.tenant, request.id].map(x => encodeURIComponent(x)).join('/')
