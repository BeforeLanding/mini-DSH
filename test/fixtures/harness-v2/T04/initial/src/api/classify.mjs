import { normalize } from '../input/normalize.mjs'
import { needsReview } from '../policy/decision.mjs'
import { labelFor } from '../output/format.mjs'
export const classifyTransfer = raw => labelFor(needsReview(normalize(raw)))
