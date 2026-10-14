// 工作区里现成的自测：只跑规格里给出的那几个例子。它可以作为起点，但杀不够变异体。
import assert from 'node:assert/strict'
import { compareVersions } from './src/versions.mjs'

assert.equal(compareVersions('1.2.3', '2.0.0'), -1)
assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
assert.equal(compareVersions('10.0.0', '9.9.9'), 1)
assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
assert.throws(() => compareVersions(42, '1.0.0'))

console.log('check ok')
