import { compare } from './compare.mjs'
import { direction } from './direction.mjs'
import { isDeleted } from './tombstone.mjs'
export const decide = input => isDeleted(input) ? 'delete' : direction(compare(input.localRev, input.remoteRev))
