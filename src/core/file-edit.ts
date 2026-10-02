import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'

export interface FileSnapshot { text: string | null; hash: string; mode?: number; location?: string }
export const fingerprint = (text: string | null) => text === null ? 'missing' : createHash('sha256').update(text, 'utf8').digest('hex')
export class FileSizeLimit extends Error {}

async function canonicalLocation(target: string): Promise<string> {
  const missing: string[] = []
  let current = target
  while (true) {
    try { return path.join(await fs.realpath(current), ...missing) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = path.dirname(current)
    if (parent === current) throw new Error('cannot resolve file location')
    missing.unshift(path.basename(current)); current = parent
  }
}

export async function snapshot(target: string, maxBytes: number, signal: AbortSignal): Promise<FileSnapshot> {
  signal.throwIfAborted()
  const location = await canonicalLocation(target)
  let handle: FileHandle | undefined
  try { handle = await fs.open(target, 'r') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, hash: 'missing', location }; throw error }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('expected a regular file')
    if (stat.size > maxBytes) throw new FileSizeLimit('edit byte limit exceeded')
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1))
    let count = 0
    while (count < bytes.length) {
      signal.throwIfAborted()
      const read = await handle.read(bytes, count, bytes.length - count, count)
      if (!read.bytesRead) break
      count += read.bytesRead
    }
    if (count > stat.size) throw new Error('file changed while reading; retry')
    const data = bytes.subarray(0, count)
    if (data.includes(0)) throw new Error('binary file is not supported')
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data)
    if (await canonicalLocation(target) !== location) throw new Error('file path changed while reading')
    return { text, hash: fingerprint(text), mode: stat.mode, location }
  } finally { await handle.close() }
}

export function checkHash(actual: string, expected: unknown) {
  if (expected !== undefined && (typeof expected !== 'string' || !/^(?:missing|[a-f0-9]{64})$/.test(expected))) throw new Error('expectedHash must be SHA-256 or missing')
  if (expected !== undefined && actual !== expected) throw new Error(`file conflict: expected ${expected}, found ${actual}; read again before editing`)
}

export function replaceUnique(original: string, oldText: unknown, newText: unknown) {
  if (typeof oldText !== 'string' || !oldText) throw new Error('oldText is required')
  if (typeof newText !== 'string') throw new Error('newText must be a string')
  const index = original.indexOf(oldText)
  if (index < 0) throw new Error('oldText not found; read the exact text including line endings')
  if (original.indexOf(oldText, index + 1) >= 0) throw new Error('oldText is not unique; refusing an ambiguous edit; include more surrounding text')
  return { text: original.slice(0, index) + newText + original.slice(index + oldText.length), line: original.slice(0, index).split('\n').length }
}

// A single bounded-cost hunk: equal prefix/suffix lines are omitted, interior stays exact.
export function unifiedDiff(file: string, before: string | null, after: string | null): string {
  if (before === after) return ''
  const lines = (text: string | null) => text ? text.match(/[^\n]*\n|[^\n]+$/g)! : []
  const a = lines(before), b = lines(after)
  let start = 0, endA = a.length, endB = b.length
  while (start < endA && start < endB && a[start] === b[start]) start++
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const countA = endA - start, countB = endB - start
  const render = (prefix: string, line: string) => prefix + line + (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n')
  const label = file.replace(/[\r\n\t]/g, '_')
  return `--- ${before === null ? '/dev/null' : 'a/' + label}\n+++ ${after === null ? '/dev/null' : 'b/' + label}\n@@ -${countA ? start + 1 : start},${countA} +${countB ? start + 1 : start},${countB} @@\n` +
    a.slice(start, endA).map(line => render('-', line)).join('') + b.slice(start, endB).map(line => render('+', line)).join('')
}

export function validateText(text: unknown, maxBytes: number): asserts text is string {
  if (typeof text !== 'string') throw new Error('content must be a string')
  if (text.includes('\0') || Buffer.from(text).toString('utf8') !== text) throw new Error('content must be valid UTF-8 text without NUL')
  if (Buffer.byteLength(text) > maxBytes) throw new FileSizeLimit('edit byte limit exceeded')
}

export async function commitFile(resolve: () => string, before: FileSnapshot, text: string, maxBytes: number, signal: AbortSignal) {
  validateText(text, maxBytes)
  signal.throwIfAborted()
  const requested = resolve()
  const target = before.location ?? await canonicalLocation(requested)
  if (await canonicalLocation(resolve()) !== target) throw new Error('file path changed before write')
  await fs.mkdir(path.dirname(target), { recursive: true })
  if (await canonicalLocation(resolve()) !== target) throw new Error('file path changed before write')
  const temporary = path.join(path.dirname(target), `.mini-dsh-edit-${randomUUID()}.tmp`)
  let handle: FileHandle | undefined
  let committed = false
  try {
    handle = await fs.open(temporary, 'wx', before.mode === undefined ? 0o666 : before.mode & 0o777)
    await handle.writeFile(text, { encoding: 'utf8', signal })
    if (before.mode !== undefined) await handle.chmod(before.mode & 0o777)
    await handle.sync()
    await handle.close(); handle = undefined
    signal.throwIfAborted()
    if (await canonicalLocation(resolve()) !== target) throw new Error('file path changed before commit')
    checkHash((await snapshot(target, maxBytes, signal)).hash, before.hash)
    signal.throwIfAborted()
    await fs.rename(temporary, target)
    committed = true
  } finally {
    await handle?.close()
    // A cleanup failure after rename must not turn a committed edit into a failed edit.
    // 这里是 finally 里**唯一**会抛出的路径，且只在 rename 从未成功（committed 为假）时才走：
    // 那种情况下没有「已被吞掉的原始异常」需要保护。规则按形状报警，此处按语义逐行豁免。
    // biome-ignore lint/correctness/noUnsafeFinally: 仅在尚未提交时抛出，见上一行
    try { await fs.rm(temporary, { force: true }) } catch (error) { if (!committed) throw error }
  }
}
