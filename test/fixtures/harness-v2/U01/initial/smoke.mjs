import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveConfig } from './src/resolve.mjs'

assert.deepEqual(resolveConfig({ fileText: readFileSync('config/runtime.txt', 'utf8') }), { region: 'eu', retries: 4 })
console.log('smoke passed')
