import assert from 'node:assert/strict'
import { executeScenario, reportGroups } from '../_shared/probe.mjs'
const workspace = process.argv[2], report = process.argv[3]
const run = code => executeScenario(workspace, `import { createReport } from './src/index.mjs'; ${code}`)
await reportGroups(report, [
  ['basic-aggregate', async () => assert.deepEqual(await run(`const r=createReport(); r.add({id:'1',account:'a',amountCents:10}); r.add({id:'2',account:'b',amountCents:20}); console.log('__V2_RESULT__'+JSON.stringify(r.snapshot()));`), [{ account: 'a', totalCents: 10 }, { account: 'b', totalCents: 20 }])],
  ['incremental-updates', async () => assert.deepEqual(await run(`const r=createReport(); r.add({id:'1',account:'a',amountCents:10}); const before=r.snapshot(); r.add({id:'2',account:'a',amountCents:5}); console.log('__V2_RESULT__'+JSON.stringify({before,after:r.snapshot()}));`), { before: [{ account: 'a', totalCents: 10 }], after: [{ account: 'a', totalCents: 15 }] })],
  ['dedupe-and-order', async () => assert.deepEqual(await run(`const r=createReport(); r.add({id:'x',account:'z',amountCents:8}); r.add({id:'x',account:'a',amountCents:50}); r.add({id:'y',account:'a',amountCents:3}); console.log('__V2_RESULT__'+JSON.stringify(r.snapshot()));`), [{ account: 'a', totalCents: 3 }, { account: 'z', totalCents: 8 }])],
  ['csv-export', async () => assert.deepEqual(await run(`const r=createReport(); const empty=r.exportCsv(); r.add({id:'1',account:'z',amountCents:8}); r.add({id:'2',account:'a',amountCents:3}); console.log('__V2_RESULT__'+JSON.stringify({empty,full:r.exportCsv()}));`), { empty: 'account,totalCents\n', full: 'account,totalCents\na,3\nz,8\n' })],
])
