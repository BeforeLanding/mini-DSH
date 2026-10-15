import { normalize } from './input.mjs'
import { decide } from './policy/decision.mjs'
export const canAccess = request => decide(normalize(request))
