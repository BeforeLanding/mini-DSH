import { normalize } from './input.mjs'
import { decide } from './decision.mjs'
import { output } from './output.mjs'
export const decideSync = raw => output(decide(normalize(raw)))
