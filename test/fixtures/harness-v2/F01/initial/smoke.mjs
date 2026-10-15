import assert from 'node:assert/strict'
import { slugify } from './src/index.mjs'
assert.equal(slugify('  Blue   Sky  '), 'blue-sky')
