import assert from 'node:assert/strict'
import { runJob } from './src/index.mjs'
assert.equal(await runJob('x', async () => 'ok'), 'ok')
