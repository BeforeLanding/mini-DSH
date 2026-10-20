import test from 'node:test'
import assert from 'node:assert/strict'
import { compareSourceTrees, describeSourceMismatch, parseRawDiff, parseTreeListing,
  summarizeRawDiff } from '../scripts/swebench/source-consistency.js'

const oid = (character: string) => character.repeat(40)
const listing = (...entries: [string, string, string, string][]) =>
  entries.map(([mode, type, object, path]) => `${mode} ${type} ${object}\t${path}\0`).join('')

test('tree listing keeps paths verbatim and rejects malformed records', () => {
  const parsed = parseTreeListing(listing(['100644', 'blob', oid('a'), 'sympy/core with space.py'],
    ['100755', 'blob', oid('b'), 'bin/test']))
  assert.deepEqual(parsed.map(entry => entry.path), ['sympy/core with space.py', 'bin/test'])
  assert.equal(parsed[0]?.mode, '100644')
  assert.throws(() => parseTreeListing('100644 blob not-an-oid\tpath\0'), /invalid git ls-tree/)
  assert.throws(() => parseTreeListing('100644 blob'), /invalid git ls-tree/)
})

test('identical blobs with changed modes compare as content-equal', () => {
  const base = parseTreeListing(listing(['100644', 'blob', oid('a'), 'README.md'],
    ['100644', 'blob', oid('b'), 'sympy/core.py']))
  const image = parseTreeListing(listing(['100755', 'blob', oid('a'), 'README.md'],
    ['100755', 'blob', oid('b'), 'sympy/core.py']))
  const comparison = compareSourceTrees(base, image)
  assert.equal(comparison.contentEqual, true)
  assert.deepEqual(comparison.differences, [])
  assert.equal(comparison.modeDifferences.length, 2)
  assert.deepEqual(comparison.modeTransitions, { '100644->100755': 2 })
})

test('a changed blob, added path, removed path, or changed type is a content difference', () => {
  const base = parseTreeListing(listing(['100644', 'blob', oid('a'), 'changed'],
    ['100644', 'blob', oid('b'), 'removed'], ['100644', 'blob', oid('c'), 'type']))
  const image = parseTreeListing(listing(['100755', 'blob', oid('d'), 'changed'],
    ['100755', 'blob', oid('e'), 'added'], ['100755', 'commit', oid('c'), 'type']))
  const comparison = compareSourceTrees(base, image)
  assert.equal(comparison.contentEqual, false)
  assert.deepEqual(comparison.differences.map(difference => [difference.kind, difference.path]), [
    ['content', 'changed'], ['removed', 'removed'], ['content', 'type'], ['added', 'added'],
  ])
})

test('raw diff separates mode-only M records from object and status changes', () => {
  const modeOnly = parseRawDiff(`:100644 100755 ${oid('a')} ${oid('a')} M\tREADME.md\n`)
  assert.deepEqual(summarizeRawDiff(modeOnly), { entries: 1, contentChanges: 0, statuses: { M: 1 } })
  const content = parseRawDiff(`:100644 100644 ${oid('a')} ${oid('b')} M\tREADME.md\n` +
    `:000000 100644 ${oid('0')} ${oid('c')} A\tnew.py\n`)
  assert.deepEqual(summarizeRawDiff(content), { entries: 2, contentChanges: 2, statuses: { M: 1, A: 1 } })
  assert.throws(() => parseRawDiff('not a raw diff line\n'), /invalid git diff-tree/)
})

test('mismatch description names bounded content differences without truncating the count', () => {
  const base = parseTreeListing(listing(['100644', 'blob', oid('a'), 'a'], ['100644', 'blob', oid('b'), 'b']))
  const image = parseTreeListing(listing(['100644', 'blob', oid('c'), 'a'], ['100644', 'blob', oid('d'), 'b']))
  const comparison = compareSourceTrees(base, image)
  const description = describeSourceMismatch({ imageHead: 'head', datasetBase: 'base', comparison, limit: 1 })
  assert.match(description, /contentDifferences=2/)
  assert.match(description, /\["content:a"\]/)
  assert.ok(!description.includes('content:b'))
})
