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
