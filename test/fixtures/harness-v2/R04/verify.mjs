import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { executeScenario, reportGroups } from '../_shared/probe.mjs'
const workspace = process.argv[2], report = process.argv[3]
const run = code => executeScenario(workspace, `import { createCart,addItem,removeItem,checkout,badge,summary } from './src/index.mjs'; ${code}`)
await reportGroups(report, [
  ['business-behavior', async () => assert.deepEqual(await run(`const c=createCart(); addItem(c,'a',150,2); addItem(c,'b',20,1); console.log('__V2_RESULT__'+JSON.stringify({total:checkout(c),count:badge(c)}));`), { total: 320, count: 3 })],
  ['all-consumers', async () => assert.deepEqual(await run(`const c=createCart(); addItem(c,'z',5,1); addItem(c,'a',10,2); addItem(c,'a',7,3); removeItem(c,'z'); console.log('__V2_RESULT__'+JSON.stringify({rows:summary(c),total:checkout(c),count:badge(c)}));`), { rows: [{ sku: 'a', priceCents: 7, quantity: 3 }], total: 21, count: 3 })],
  ['map-representation', async () => assert.deepEqual(await run(`const c=createCart(); console.log('__V2_RESULT__'+JSON.stringify({map:c.state instanceof Map,empty:summary(c)}));`), { map: true, empty: [] })],
  ['legacy-detached', async () => {
    for (const file of ['api/cart.mjs', 'actions/add.mjs', 'actions/remove.mjs', 'consumers/checkout.mjs', 'consumers/badge.mjs', 'consumers/summary.mjs', 'state/cart.mjs']) {
      assert.doesNotMatch(await fs.readFile(path.join(workspace, 'src', file), 'utf8'), /legacy\.mjs/, `${file} still references legacy state`)
    }
    assert.deepEqual(await run(`const c=createCart(); addItem(c,'x',10,1); console.log('__V2_RESULT__'+JSON.stringify(checkout(c)));`), 10)
  }],
])
