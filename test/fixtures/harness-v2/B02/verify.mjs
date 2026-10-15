import assert from 'node:assert/strict'
import { executeScenario, reportGroups } from '../_shared/probe.mjs'
const workspace = process.argv[2], report = process.argv[3]
const run = code => executeScenario(workspace, `import { runJob } from './src/index.mjs'; ${code}`)
await reportGroups(report, [
  ['retry-count', async () => assert.deepEqual(await run(`let calls=0; const result=await runJob('x', async () => { calls++; if(calls<3) throw Object.assign(new Error('temp'),{code:'TEMPORARY'}); return 'ok' }); console.log('__V2_RESULT__'+JSON.stringify({result,calls}));`), { result: 'ok', calls: 3 })],
  ['cancel-after-failure', async () => assert.deepEqual(await run(`const control=new AbortController(); let calls=0, name; try { await runJob('x', async () => { calls++; control.abort(); throw Object.assign(new Error('temp'),{code:'TEMPORARY'}) }, {signal:control.signal}) } catch(e) { name=e.name } console.log('__V2_RESULT__'+JSON.stringify({calls,name}));`), { calls: 1, name: 'AbortError' })],
  ['permanent-error', async () => assert.deepEqual(await run(`let calls=0, message; try { await runJob('x', async () => { calls++; throw new Error('permanent') }) } catch(e) { message=e.message } console.log('__V2_RESULT__'+JSON.stringify({calls,message}));`), { calls: 1, message: 'permanent' })],
  ['successful-return', async () => assert.deepEqual(await run(`let calls=0; const result=await runJob({id:7}, async ({payload,attempt}) => { calls++; return {payload,attempt} }); console.log('__V2_RESULT__'+JSON.stringify({result,calls}));`), { result: { payload: { id: 7 }, attempt: 0 }, calls: 1 })],
])
