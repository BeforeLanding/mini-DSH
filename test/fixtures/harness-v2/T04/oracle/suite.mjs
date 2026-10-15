import assert from 'node:assert/strict'
import { classifyTransfer } from './src/index.mjs'
assert.equal(classifyTransfer({ amountCents: 799, vip: false }), 'allow')
assert.equal(classifyTransfer({ amountCents: 800, vip: false }), 'review')
assert.equal(classifyTransfer({ amountCents: 1200, vip: true }), 'review')
assert.equal(classifyTransfer({ amountCents: 100, vip: true }), 'allow')
