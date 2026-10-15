import { invalid } from './errors.mjs'
export function validateLimit(value) { if (!Number.isInteger(value) || value < 0) throw invalid('limit') }
export function validateAmount(value) { if (!Number.isInteger(value) || value < 1) throw invalid('amount') }
