import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.argv[2]
const { normalizeName, normalizeEmail, normalizeAmount } = await import(pathToFileURL(path.join(root, 'src/normalize.mjs')).href)
const { auditRecords } = await import(pathToFileURL(path.join(root, 'src/audit.mjs')).href)

// 规整器本身：取值域与工作区数据集有意错开（quinn / frost / vertex.example），覆盖制表符、连续空白、
// 大小写、空值与已经规范的形式（幂等）。只看工作区那 1600 条记录会漏掉这些。
assert.equal(normalizeName('  quinn   frost  '), 'quinn frost')
assert.equal(normalizeName('quinn\tfrost'), 'quinn frost')
assert.equal(normalizeName('quinn frost'), 'quinn frost')
assert.equal(normalizeName(null), '')
assert.equal(normalizeEmail('  QUINN.FROST@Vertex.Example  '), 'quinn.frost@vertex.example')
assert.equal(normalizeEmail('quinn.frost@vertex.example'), 'quinn.frost@vertex.example')
assert.equal(normalizeAmount('7.5'), '7.50')
assert.equal(normalizeAmount(7), '7.00')

// 规范记录必须一条都不报。第 x1 条的三个原始字段各需要一条不同的规则（折叠空白、小写化、补两位小数），
// 因此这条断言同时钉住三条规则与「email 用的是 email 的规整器而不是名字的」。
assert.deepEqual(auditRecords([
  { id: 'x1', name: '  quinn   frost  ', email: 'QUINN.FROST@VERTEX.EXAMPLE', amount: '7.5', expected: { name: 'quinn frost', email: 'quinn.frost@vertex.example', amount: '7.50' } },
  { id: 'x2', name: 'quinn frost', email: 'quinn.frost@vertex.example', amount: '7.50', expected: { name: 'quinn frost', email: 'quinn.frost@vertex.example', amount: '7.50' } },
]), [])

// 反过来：结构上就不规范的记录必须被报出来，且报到正确的字段上。没有这一边，「让 auditRecords 恒返回
// 空数组」就能通过上面那条断言。
assert.deepEqual(
  auditRecords([
    { id: 'x3', name: 'quinn frost', amount: '7.50', expected: { name: 'quinn frost', amount: '7.50' } },
    { id: 'x4', name: 'quinn frost', email: 'quinn.frost@vertex.example', amount: 'abc', expected: { name: 'quinn frost', email: 'quinn.frost@vertex.example', amount: '0.00' } },
  ]).map(violation => `${violation.id}:${violation.field}`).sort(),
  ['x3:email', 'x4:amount'],
)
console.log('acceptance passed: audit')
