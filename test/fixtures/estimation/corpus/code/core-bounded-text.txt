import fs from 'node:fs/promises'

export function positiveLimit(value: unknown, fallback: number, name: string, ceiling = Number.MAX_SAFE_INTEGER): number {
  const limit = value === undefined ? fallback : value
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0 || limit > ceiling) throw new Error(`${name} must be a positive safe integer <= ${ceiling}`)
  return limit
}

export class ScanLimit extends Error {}

export async function* textLines(target: string, maxScanBytes: number, maxLineBytes: number, signal: AbortSignal): AsyncGenerator<{ text: string; line: number; end: number; size: number }> {
  signal.throwIfAborted()
  const handle = await fs.open(target, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('expected a regular file')
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const chunk = Buffer.alloc(8192)
    let pending = Buffer.alloc(0), scanned = 0, line = 1, end = 0
    while (scanned < stat.size) {
      signal.throwIfAborted()
      if (scanned >= maxScanBytes) throw new ScanLimit('scan byte limit reached; narrow the range or increase configuration')
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, maxScanBytes - scanned), scanned)
      if (!bytesRead) break
      scanned += bytesRead
      const data = chunk.subarray(0, bytesRead)
      if (data.includes(0)) throw new Error('binary file is not supported')
      let start = 0
      for (let index = 0; index < data.length; index++) {
        if (data[index] !== 10) continue
        const part = data.subarray(start, index)
        if (pending.length + part.length > maxLineBytes) throw new Error('line byte limit exceeded')
        const bytes = Buffer.concat([pending, part])
        end += bytes.length + 1
        let text = decoder.decode(bytes)
        if (text.endsWith('\r')) text = text.slice(0, -1)
        yield { text, line: line++, end, size: stat.size }
        pending = Buffer.alloc(0)
        start = index + 1
      }
      if (pending.length + data.length - start > maxLineBytes) throw new Error('line byte limit exceeded')
      pending = Buffer.concat([pending, data.subarray(start)])
    }
    if (pending.length) yield { text: decoder.decode(pending), line, end: end + pending.length, size: stat.size }
  } finally { await handle.close() }
}

export interface ReadLimits { maxLines: number; maxOutputBytes: number; maxScanBytes: number }

export async function readTextRange(target: string, startLine: number, maxLines: number, limits: ReadLimits, signal: AbortSignal): Promise<string> {
  const output: string[] = []
  let bytes = 0, nextLine = startLine, eof = true, reason = 'eof'
  try {
    for await (const entry of textLines(target, limits.maxScanBytes, limits.maxOutputBytes, signal)) {
      if (entry.line < startLine) continue
      const text = `${entry.line}: ${entry.text}\n`
      if (bytes + Buffer.byteLength(text) > limits.maxOutputBytes) { eof = false; reason = 'output_bytes'; nextLine = entry.line; break }
      output.push(text); bytes += Buffer.byteLength(text); nextLine = entry.line + 1
      if (output.length >= maxLines) { eof = entry.end >= entry.size; reason = eof ? 'eof' : 'max_lines'; break }
    }
  } catch (error) {
    if (!(error instanceof ScanLimit)) throw error
    eof = false; reason = 'scan_bytes'
  }
  return output.join('') + `[read_file eof=${eof} nextLine=${nextLine} reason=${reason}]`
}
