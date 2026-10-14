// 参考套件：逐条覆盖 docs/SPEC.md 的规则——折叠、首尾、兜底值、截断（含截在连字符上）。
// 它必须在当前源码与全部等价实现上退出 0，并杀掉全部变异体。
import assert from 'node:assert/strict'
import { slugify } from './src/slug.mjs'

// 规则 2、3、4、7：小写、折叠、去首尾。
assert.equal(slugify('Hello World'), 'hello-world')
assert.equal(slugify('Hello World!'), 'hello-world')
assert.equal(slugify('  Hello   World  '), 'hello-world')
assert.equal(slugify('a  --  b'), 'a-b')
assert.equal(slugify('Release 2.0'), 'release-2-0')
assert.equal(slugify('你好 Hello'), 'hello')
// 规则 5：整串没有字母数字时用兜底值，不只是空串。
assert.equal(slugify(''), 'untitled')
assert.equal(slugify('!!!'), 'untitled')
assert.equal(slugify('  ---  '), 'untitled')
assert.equal(slugify('!!!', { fallback: 'none' }), 'none')
// 规则 6：截断，以及截断后可能剩下的尾部连字符。
assert.equal(slugify('abcdefghij', { maxLength: 4 }), 'abcd')
assert.equal(slugify('ab cd ef', { maxLength: 3 }), 'ab')
assert.equal(slugify('ab cd ef', { maxLength: 8 }), 'ab-cd-ef')
assert.equal(slugify('ABCDEFGHIJ', { maxLength: 40 }), 'abcdefghij')
// 规则 1。
assert.throws(() => slugify(42))
assert.throws(() => slugify(null))
assert.throws(() => slugify('x', { fallback: '' }))
assert.throws(() => slugify('x', { maxLength: 0 }))
assert.throws(() => slugify('x', { maxLength: -3 }))
assert.throws(() => slugify('x', { maxLength: 1.5 }))
assert.throws(() => slugify('x', { maxLength: Number.NaN }))

console.log('oracle suite ok')
