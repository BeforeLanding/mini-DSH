import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { calculateOrder } = await import(pathToFileURL(path.join(process.argv[2], 'src/order.mjs')).href)
const { formatOrder } = await import(pathToFileURL(path.join(process.argv[2], 'src/receipt.mjs')).href)
const lines = [{ sku: 'a', quantity: 2 }, { sku: 'x', quantity: 1 }, { sku: 'b', quantity: 3 }, { sku: 'y', quantity: 2 }], catalog = { a: 2.5, b: 1 }; const before = structuredClone(lines); assert.deepEqual(calculateOrder(lines, catalog), { total: 8, missing: ['x', 'y'] }); assert.equal(formatOrder(lines, catalog), 'Total: 8.00; missing: x,y'); assert.deepEqual(calculateOrder([], catalog), { total: 0, missing: [] }); assert.equal(formatOrder([], catalog), 'Total: 0.00; missing: none'); assert.deepEqual(lines, before)
console.log('acceptance passed: inventory')
