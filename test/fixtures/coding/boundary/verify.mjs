import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { clampIndex } = await import(pathToFileURL(path.join(process.argv[2], 'src/index.mjs')).href)
for (const [index, length, expected] of [[0, 0, -1], [100, 0, -1], [-3, 4, 0], [0, 1, 0], [9, 1, 0], [3, 4, 3], [4, 4, 3], [99, 4, 3], [2.9, 4, 2], [-0.9, 4, 0]]) {
  assert.equal(clampIndex(index, length), expected, `clampIndex(${index}, ${length})`)
}
console.log('acceptance passed: boundary')
