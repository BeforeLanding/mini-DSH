import { compare } from './compare.mjs'
import { direction } from './direction.mjs'
export const decide = input => direction(compare(input.localRev, input.remoteRev))
