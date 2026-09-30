import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { buildQuery } = await import(pathToFileURL(path.join(process.argv[2], 'src/query.mjs')).href)
const input = { z: null, b: ['x y', 'a&b'], a: 0, empty: [], flag: false }; const before = structuredClone(input); assert.equal(buildQuery(input), 'a=0&b=x%20y&b=a%26b&flag=false'); assert.equal(buildQuery({ 'a b': '/' }), 'a%20b=%2F'); assert.equal(buildQuery({}), ''); assert.deepEqual(input, before)
console.log('acceptance passed: query')
