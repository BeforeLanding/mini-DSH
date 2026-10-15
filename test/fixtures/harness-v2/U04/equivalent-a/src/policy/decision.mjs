export function decide(request) {
  if (request.role === 'admin') return true
  if (request.role === 'guest') return request.resource === 'public' && request.action === 'read'
  if (request.role !== 'staff') return false
  if (request.resource === 'internal' && request.action === 'export' && request.region === 'EU') return request.migrationGrant === true
  return request.resource === 'internal' || request.resource === 'public'
}
