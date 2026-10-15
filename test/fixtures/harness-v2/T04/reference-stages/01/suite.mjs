import assert from 'node:assert/strict'
import { classifyTransfer } from './src/index.mjs'
assert.equal(classifyTransfer({ amountCents: 900, vip: false }), 'allow')
assert.equal(classifyTransfer({ amountCents: 1100, vip: false }), 'review')
assert.equal(classifyTransfer({ amountCents: 1200, vip: true }), 'allow')
