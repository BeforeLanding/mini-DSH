import { compare } from './compare.mjs'
export function decide(input) { if (input.remoteDeleted) return 'delete'; const order = compare(input.localRev, input.remoteRev); return order < 0 ? 'pull' : order > 0 ? 'push' : 'noop' }
