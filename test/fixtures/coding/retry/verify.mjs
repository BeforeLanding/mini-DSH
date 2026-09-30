import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { retry } = await import(pathToFileURL(path.join(process.argv[2], 'src/retry.mjs')).href)
let calls = 0; assert.equal(await retry(async () => { if (++calls < 3) throw new Error('temporary'); return 9 }, 4).catch(() => undefined), 9); assert.equal(calls, 3); let once = 0; assert.equal(await retry(async () => { once++; return 0 }, 5), 0); assert.equal(once, 1); const last = new Error('last'); let fails = 0; await assert.rejects(retry(async () => { fails++; throw last }, 2), error => error === last); assert.equal(fails, 2)
console.log('acceptance passed: retry')
