import assert from 'node:assert/strict'
import { computeInvoice } from './src/index.mjs'
assert.equal(computeInvoice({ id: 'smoke', items: [{ priceCents: 1000, quantity: 1 }], zone: 'A' }).totalCents, 1100)
