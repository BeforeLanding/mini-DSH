import { aboveThreshold } from './threshold.mjs'
import { exempt } from './exemption.mjs'
export const needsReview = input => aboveThreshold(input) && !exempt(input)
