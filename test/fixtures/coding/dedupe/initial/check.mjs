import assert from 'node:assert/strict'
import { uniqueById } from './src/unique.mjs'
assert.deepEqual(uniqueById([{ id: 1 }, { id: 1 }]), [{ id: 1 }])
console.log('public checks passed')
