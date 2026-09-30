import assert from 'node:assert/strict'
import { retry } from './src/retry.mjs'
let calls = 0; assert.equal(await retry(async () => { if (++calls < 2) throw new Error('temporary'); return 7 }, 2), 7)
console.log('public checks passed')
