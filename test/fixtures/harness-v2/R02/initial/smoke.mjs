import assert from 'node:assert/strict'
import { greetUser } from './src/index.mjs'
assert.equal(greetUser({ a: { name: 'Ada' } }, 'a'), 'Hello Ada')
