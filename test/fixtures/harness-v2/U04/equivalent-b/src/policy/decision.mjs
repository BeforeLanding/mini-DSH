import { isEu } from '../regions/eu.mjs'
export const decide = request => {
  const basic = request.role === 'admin' || request.role === 'staff' && ['public', 'internal'].includes(request.resource) || request.role === 'guest' && request.resource === 'public' && request.action === 'read'
  if (!basic) return false
  return !(request.role === 'staff' && request.resource === 'internal' && request.action === 'export' && isEu(request) && !request.migrationGrant)
}
