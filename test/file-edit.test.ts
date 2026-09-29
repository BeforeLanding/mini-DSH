import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { snapshot, fingerprint, replaceUnique, unifiedDiff, commitFile, validateText } from '../src/core/file-edit.js'

test('file editing preserves exact Unicode/BOM/CRLF bytes and rejects ambiguous or unsupported text', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'file-edit-')), file = path.join(directory, 'a')
  const signal = new AbortController().signal
  try {
    const text = '\ufeff中文😀\r\nend'
    await fs.writeFile(file, text)
    const before = await snapshot(file, 100, signal)
    assert.equal(before.text, text); assert.equal(before.hash, fingerprint(text))
    const next = replaceUnique(text, '中文', '你好').text
    await commitFile(() => file, before, next, 100, signal)
    assert.equal(await fs.readFile(file, 'utf8'), next)
    assert.throws(() => replaceUnique('aaa', 'aa', 'b'), /not unique/)
    assert.throws(() => replaceUnique(text, 'absent', ''), /not found/)
    assert.throws(() => validateText('\ud800', 100), /UTF-8/)
    assert.throws(() => validateText('a'.repeat(101), 100), /byte limit/)
    await fs.writeFile(file, Buffer.from([255]))
    await assert.rejects(snapshot(file, 100, signal), /encoded data/)
    await fs.writeFile(file, 'a\0')
    await assert.rejects(snapshot(file, 100, signal), /binary/)
    await assert.rejects(snapshot(directory, 100, signal), /regular file|EISDIR|EPERM/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('atomic editing detects changed and newly created targets and cleans failed/cancelled temporary files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'file-conflict-')), file = path.join(directory, 'a')
  const signal = new AbortController().signal
  try {
    const missing = await snapshot(file, 100, signal)
    await fs.writeFile(file, 'user')
    await assert.rejects(commitFile(() => file, missing, 'agent', 100, signal), /conflict/)
    assert.equal(await fs.readFile(file, 'utf8'), 'user')
    const before = await snapshot(file, 100, signal)
    await assert.rejects(commitFile(() => file, before, 'agent', 100, AbortSignal.abort()), /abort/i)
    let resolves = 0
    await assert.rejects(commitFile(() => ++resolves > 2 ? path.join(directory, 'other') : file, before, 'agent', 100, signal), /path changed/)
    assert.deepEqual(await fs.readdir(directory), ['a'])
    await assert.rejects(snapshot(file, 1, signal), /byte limit/)
    await fs.rm(file)
    await commitFile(() => file, missing, '', 100, signal)
    assert.notEqual((await snapshot(file, 100, signal)).hash, 'missing')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('unified diff handles inserted/deleted lines, empty files, CRLF and missing final newline', () => {
  assert.equal(unifiedDiff('a', 'same', 'same'), '')
  assert.equal(unifiedDiff('a', 'a\nb\nc\n', 'a\nB\nc\n'), '--- a/a\n+++ b/a\n@@ -2,1 +2,1 @@\n-b\n+B\n')
  assert.match(unifiedDiff('a', null, '中文\r\n'), /\/dev\/null\n\+\+\+ b\/a\n@@ -0,0 \+1,1 @@\n\+中文\r\n/)
  assert.match(unifiedDiff('a', 'x', ''), /No newline at end of file/)
  assert.match(unifiedDiff('a', 'a\n', 'a\nb\n'), /@@ -1,0 \+2,1 @@/)
  assert.match(unifiedDiff('a', '', 'x'), /@@ -0,0 \+1,1 @@/)
})
