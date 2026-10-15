import { REVIEW_LIMIT } from './limit.mjs'
import { amountOf } from '../input/amount.mjs'
export const aboveThreshold = input => amountOf(input) >= REVIEW_LIMIT
