import assert from 'node:assert/strict'
import { classifyTransfer } from './src/index.mjs'
assert.equal(classifyTransfer({ amountCents: 100 }), 'allow')
