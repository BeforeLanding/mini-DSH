import assert from 'node:assert/strict'
import { validateShipment } from './src/index.mjs'
assert.deepEqual(validateShipment({ weightKg: 1, longestCm: 10, postcode: '12345' }, 'domestic'), { ok: true })
