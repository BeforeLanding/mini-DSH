import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { paginate } = await import(pathToFileURL(path.join(process.argv[2], 'src/page.mjs')).href)
const input = [1, 2, 3, 4, 5]; for (const [page, size, expected, pages] of [[1, 2, [1, 2], 3], [2, 2, [3, 4], 3], [3, 2, [5], 3], [4, 2, [], 3], [1, 8, input, 1]]) assert.deepEqual(paginate(input, page, size), { items: expected, totalPages: pages }); assert.deepEqual(paginate([], 1, 2), { items: [], totalPages: 0 }); assert.deepEqual(input, [1, 2, 3, 4, 5])
console.log('acceptance passed: pagination')
