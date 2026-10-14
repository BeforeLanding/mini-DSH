// 工作区里现成的自测：只跑规格里给出的那几个例子。它可以作为起点，但杀不够变异体。
import assert from 'node:assert/strict'
import { slugify } from './src/slug.mjs'

assert.equal(slugify('Hello World'), 'hello-world')
assert.equal(slugify('Release 2.0'), 'release-2-0')
assert.equal(slugify(''), 'untitled')
assert.equal(slugify('!!!'), 'untitled')
assert.throws(() => slugify(42))

console.log('check ok')
