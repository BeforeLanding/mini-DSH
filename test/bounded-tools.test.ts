import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readTextRange } from '../src/core/bounded-text.js'

test('bounded read resumes Unicode/CRLF ranges and handles empty and final lines', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bounded-read-'))
  const file = path.join(directory, 'text')
  const limits = { maxLines: 2, maxOutputBytes: 100, maxScanBytes: 10000 }
  try {
    await fs.writeFile(file, '中文\r\n\r\nlast')
    const signal = new AbortController().signal
    assert.equal(await readTextRange(file, 1, 2, limits, signal), '1: 中文\n2: \n[read_file eof=false nextLine=3 reason=max_lines]')
    assert.equal(await readTextRange(file, 3, 2, limits, signal), '3: last\n[read_file eof=true nextLine=4 reason=eof]')
    assert.match(await readTextRange(file, 10, 2, limits, signal), /eof=true/)
    await fs.writeFile(file, '')
    assert.match(await readTextRange(file, 1, 2, limits, signal), /eof=true nextLine=1/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('bounded read reports scan/output limits and rejects long lines, binary, invalid UTF-8 and cancellation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bounded-read-'))
  const file = path.join(directory, 'text'), signal = new AbortController().signal
  const limits = { maxLines: 100, maxOutputBytes: 12, maxScanBytes: 100 }
  try {
    await fs.writeFile(file, '12345\n12345\n')
    assert.match(await readTextRange(file, 1, 100, limits, signal), /nextLine=2 reason=output_bytes/)
    assert.match(await readTextRange(file, 1, 100, { ...limits, maxScanBytes: 6 }, signal), /reason=scan_bytes/)
    await fs.writeFile(file, 'a'.repeat(10000))
    await assert.rejects(readTextRange(file, 1, 2, limits, signal), /line byte limit/)
    await fs.writeFile(file, Buffer.from([0xff, 10]))
    await assert.rejects(readTextRange(file, 1, 2, limits, signal), /encoded data/)
    await fs.writeFile(file, 'abc\0')
    await assert.rejects(readTextRange(file, 1, 2, limits, signal), /binary/)
    await assert.rejects(readTextRange(file, 1, 2, limits, AbortSignal.abort()), /abort/i)
    await assert.rejects(readTextRange(directory, 1, 2, limits, signal), /regular file|EISDIR|EPERM/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

import { searchFiles, type SearchLimits } from '../src/core/bounded-search.js'
import { matchFilePattern } from '../src/tools/files.js'
import { resolveInside } from '../src/utils/path.js'

const searchLimits: SearchLimits = { maxResults: 2, maxOutputBytes: 1024, maxEntries: 100, maxDepth: 4, maxFileBytes: 100, maxTotalBytes: 1000 }

test('bounded search pages literal matches, narrows directories and reports ignored/unsupported files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bounded-search-'))
  const signal = new AbortController().signal, resolve = (value: unknown) => resolveInside(directory, value)
  try {
    await fs.mkdir(path.join(directory, 'src'))
    await fs.mkdir(path.join(directory, 'node_modules'))
    await fs.writeFile(path.join(directory, 'node_modules', 'secret'), 'needle')
    await fs.writeFile(path.join(directory, 'src', 'a'), 'needle\nneedle\nneedle\n')
    await fs.writeFile(path.join(directory, 'src', 'binary'), Buffer.from([0, 1, 2]))
    await fs.writeFile(path.join(directory, 'src', 'invalid'), Buffer.from([0xff]))
    await fs.writeFile(path.join(directory, 'src', 'large'), 'x'.repeat(101))
    const args = { path: 'src', query: 'needle', pattern: 'a' }
    const first = await searchFiles(resolve, matchFilePattern, args, searchLimits, signal, true)
    assert.deepEqual(first.matches, ['src/a:1:needle', 'src/a:2:needle'])
    assert.equal(first.nextOffset, 2); assert.equal(first.eof, false)
    const last = await searchFiles(resolve, matchFilePattern, { ...args, offset: first.nextOffset }, searchLimits, signal, true)
    assert.deepEqual(last.matches, ['src/a:3:needle']); assert.equal(last.eof, true)
    const all = await searchFiles(resolve, matchFilePattern, { query: 'needle' }, { ...searchLimits, maxResults: 20 }, signal, true)
    assert.equal(all.skipped.ignored, 1); assert.equal(all.skipped.unsupported_text, 2); assert.equal(all.skipped.file_bytes, 1)
    const optIn = await searchFiles(resolve, matchFilePattern, { path: 'node_modules', query: 'needle', includeIgnored: true }, searchLimits, signal, true)
    assert.equal(optIn.matches.length, 1)
    await assert.rejects(searchFiles(resolve, matchFilePattern, { path: '..' }, searchLimits, signal, false), /escapes/)
    await assert.rejects(searchFiles(resolve, matchFilePattern, { offset: -1 }, searchLimits, signal, false), /offset/)
    await assert.rejects(searchFiles(resolve, matchFilePattern, { query: '' }, searchLimits, signal, true), /nonempty/)
    await assert.rejects(searchFiles(resolve, matchFilePattern, { maxResults: 3 }, searchLimits, signal, false), /positive/)
    await assert.rejects(searchFiles(resolve, matchFilePattern, {}, searchLimits, AbortSignal.abort(), false), /abort/i)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('search bounds entries, depth, aggregate scan and output while closing directory handles', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bounded-search-'))
  const signal = new AbortController().signal, resolve = (value: unknown) => resolveInside(directory, value)
  try {
    await fs.writeFile(path.join(directory, 'a'), 'needle\n')
    await fs.writeFile(path.join(directory, 'b'), 'needle\n')
    assert.equal((await searchFiles(resolve, matchFilePattern, { query: 'needle' }, { ...searchLimits, maxTotalBytes: 1 }, signal, true)).reason, 'scan_bytes')
    assert.equal((await searchFiles(resolve, matchFilePattern, {}, { ...searchLimits, maxEntries: 1, maxResults: 20 }, signal, false)).reason, 'entries')
    assert.equal((await searchFiles(resolve, matchFilePattern, {}, { ...searchLimits, maxOutputBytes: 1 }, signal, false)).reason, 'output_bytes')
    await fs.mkdir(path.join(directory, 'sub', 'deep'), { recursive: true })
    assert.equal((await searchFiles(resolve, matchFilePattern, { path: 'sub' }, { ...searchLimits, maxDepth: 1 }, signal, false)).eof, true)
    await fs.mkdir(path.join(directory, 'sub', 'deep', 'deeper'))
    assert.equal((await searchFiles(resolve, matchFilePattern, { path: 'sub' }, { ...searchLimits, maxDepth: 1 }, signal, false)).reason, 'depth')
    const controller = new AbortController()
    const abortingResolve = (value: unknown) => { if (value === 'a') controller.abort(); return resolve(value) }
    await assert.rejects(searchFiles(abortingResolve, matchFilePattern, { query: 'needle', pattern: 'a' }, searchLimits, controller.signal, true), /abort/i)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
