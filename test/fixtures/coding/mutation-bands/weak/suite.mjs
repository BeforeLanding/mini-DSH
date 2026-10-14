// 工作区里现成的自测：只跑规格里给出的那几个例子。它可以作为起点，但杀不够变异体。
import assert from 'node:assert/strict'
import { bandOf } from './src/bands.mjs'

assert.equal(bandOf(95), 'A')
assert.equal(bandOf(85), 'B')
assert.equal(bandOf(75), 'C')
assert.equal(bandOf(65), 'D')
assert.throws(() => bandOf(Number.NaN))
assert.throws(() => bandOf(-1))
assert.throws(() => bandOf(101))

console.log('check ok')
