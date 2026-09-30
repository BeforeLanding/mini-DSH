import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { parseCsvLine } = await import(pathToFileURL(path.join(process.argv[2], 'src/csv.mjs')).href)
for (const [line, expected] of [['a,"b,c",d', ['a', 'b,c', 'd']], ['"a""b",,z', ['a"b', '', 'z']], [',', ['', '']], ['', ['']], ['"x,y"', ['x,y']], ['a,b,', ['a', 'b', '']]]) assert.deepEqual(parseCsvLine(line), expected, line)
console.log('acceptance passed: csv')
