import assert from 'node:assert/strict'
import { renderReceipt } from './src/index.mjs'
assert.equal(renderReceipt([{ unitCents: 150, quantity: 2 }]), 'Total: $3.00')
