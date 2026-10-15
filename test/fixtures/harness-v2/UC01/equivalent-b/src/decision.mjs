import { direction } from './direction.mjs'
import { compare } from './compare.mjs'
export const decide = input => input.remoteDeleted ? 'delete' : direction(compare(input.localRev, input.remoteRev))
