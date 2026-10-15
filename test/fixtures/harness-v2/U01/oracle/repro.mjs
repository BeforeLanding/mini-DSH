import assert from 'node:assert/strict'
import { resolveConfig } from './src/resolve.mjs'

const result = resolveConfig({ fileText: 'region=eu\nretries=4', explicit: { region: 'ap', retries: 0 } })
assert.deepEqual(result, { region: 'ap', retries: 0 })
