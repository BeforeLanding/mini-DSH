// 参考套件：逐条覆盖 docs/SPEC.md 的规则——段数上限、空段、缺段补零、以及「逐段」比较里的每一段。
// 它必须在当前源码与全部等价实现上退出 0，并杀掉全部变异体。
import assert from 'node:assert/strict'
import { compareVersions } from './src/versions.mjs'

// 规则 4：第一大段。
assert.equal(compareVersions('1.2.3', '2.0.0'), -1)
assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
assert.equal(compareVersions('10.0.0', '9.9.9'), 1)
// 规则 4：第二段也要比。
assert.equal(compareVersions('1.2.0', '1.3.0'), -1)
assert.equal(compareVersions('1.3.0', '1.2.0'), 1)
// 规则 4：第三段也要比——这正是「逐段」里最容易漏掉的一段。
assert.equal(compareVersions('1.2.3', '1.2.4'), -1)
assert.equal(compareVersions('1.2.4', '1.2.3'), 1)
assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
// 规则 4：全等是 0，而不是「左不小于右」。
assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
assert.equal(compareVersions('7.7.7', '7.7.7'), 0)
// 规则 3：缺的段视为 0。
assert.equal(compareVersions('1.2', '1.2.0'), 0)
assert.equal(compareVersions('1.2', '1.2.1'), -1)
assert.equal(compareVersions('1', '1.0.0'), 0)
assert.equal(compareVersions('1', '1.0.1'), -1)
assert.equal(compareVersions('2', '1.9.9'), 1)
// 规则 1、2。
assert.throws(() => compareVersions(42, '1.0.0'))
assert.throws(() => compareVersions('1.0.0', null))
assert.throws(() => compareVersions('1.2.3.4', '1.0.0'))
assert.throws(() => compareVersions('1..3', '1.0.0'))
assert.throws(() => compareVersions('', '1.0.0'))
assert.throws(() => compareVersions('.1.2', '1.0.0'))
assert.throws(() => compareVersions('1.2.x', '1.0.0'))
assert.throws(() => compareVersions('1.-2.0', '1.0.0'))

console.log('oracle suite ok')
