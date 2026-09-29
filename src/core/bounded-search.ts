import fs from 'node:fs/promises'
import path from 'node:path'
import type { Arguments } from './contracts.js'
import { positiveLimit, textLines, ScanLimit } from './bounded-text.js'

export interface SearchLimits { maxResults: number; maxOutputBytes: number; maxEntries: number; maxDepth: number; maxFileBytes: number; maxTotalBytes: number }

export async function searchFiles(resolve: (requested: unknown) => string, match: (file: string, pattern: string) => boolean, args: Arguments, limits: SearchLimits, signal: AbortSignal, grep: boolean) {
  const directory = args.path === undefined ? '.' : args.path
  if (typeof directory !== 'string') throw new Error('path must be a string')
  resolve(directory)
  if (args.pattern !== undefined && typeof args.pattern !== 'string') throw new Error('pattern must be a string')
  if (grep && (typeof args.query !== 'string' || !args.query)) throw new Error('query must be a nonempty string')
  if (args.includeIgnored !== undefined && typeof args.includeIgnored !== 'boolean') throw new Error('includeIgnored must be a boolean')
  const offset = args.offset ?? 0
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a nonnegative safe integer')
  const maxResults = positiveLimit(args.maxResults, limits.maxResults, 'maxResults', limits.maxResults)
  const matches: string[] = [], skipped: Record<string, number> = {}
  let entries = 0, scannedBytes = 0, seen = 0, outputBytes = 0, reason = 'eof'
  const skip = (cause: string) => { skipped[cause] = (skipped[cause] ?? 0) + 1 }
  async function* walk(relative: string, depth: number): AsyncGenerator<string> {
    signal.throwIfAborted()
    if (depth > limits.maxDepth) throw new ScanLimit('depth')
    const handle = await fs.opendir(resolve(relative))
    for await (const entry of handle) {
      signal.throwIfAborted()
      if (++entries > limits.maxEntries) throw new ScanLimit('entries')
      if (!args.includeIgnored && ['.git', 'node_modules', 'dist', '.mini-dsh'].includes(entry.name)) { skip('ignored'); continue }
      const file = path.join(relative, entry.name)
      if (entry.isSymbolicLink()) { skip('symlink'); continue }
      if (entry.isDirectory()) yield* walk(file, depth + 1)
      else if (entry.isFile()) yield file.replace(/\\/g, '/')
    }
  }
  const add = (value: string): boolean => {
    if (seen++ < offset) return true
    const size = Buffer.byteLength(JSON.stringify(value)) + 1
    if (outputBytes + size > limits.maxOutputBytes) { seen--; reason = 'output_bytes'; return false }
    matches.push(value); outputBytes += size
    if (matches.length >= maxResults) { reason = 'max_results'; return false }
    return true
  }
  try {
    outer: for await (const file of walk(directory, 0)) {
      if (!match(file, args.pattern as string ?? '')) continue
      if (!grep) { if (!add(file)) break; continue }
      const target = resolve(file), stat = await fs.stat(target)
      if (stat.size > limits.maxFileBytes) { skip('file_bytes'); continue }
      if (scannedBytes + stat.size > limits.maxTotalBytes) throw new ScanLimit('scan_bytes')
      scannedBytes += stat.size
      try {
        for await (const line of textLines(target, stat.size || 1, limits.maxOutputBytes, signal)) {
          if (line.text.includes(args.query as string) && !add(`${file}:${line.line}:${line.text}`)) break outer
        }
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof ScanLimit) skip('file_changed')
        else if (error instanceof Error && /binary|encoded data|line byte limit/.test(error.message)) skip('unsupported_text')
        else throw error
      }
    }
  } catch (error) {
    if (!(error instanceof ScanLimit)) throw error
    reason = error.message
  }
  return { matches, nextOffset: offset + matches.length, eof: reason === 'eof', reason, entries: Math.min(entries, limits.maxEntries), scannedBytes, skipped }
}
