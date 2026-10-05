import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { positiveLimit } from './bounded-text.js'
import { resolveInside } from '../utils/path.js'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function utf8Prefix(bytes: Buffer, maxBytes: number): Buffer {
  let end = Math.min(bytes.length, maxBytes)
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end)
}

export const PREVIEW_TAIL_DIVISOR = 8

export function utf8Suffix(bytes: Buffer, maxBytes: number): Buffer {
  let start = Math.max(0, bytes.length - maxBytes)
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return bytes.subarray(start)
}

export interface ResultStoreConfig { directory: string; maxCaptureBytes?: number; maxStoreBytes?: number; maxFiles?: number; maxReadBytes?: number }

export class ToolResultStore {
  readonly directory: string
  readonly maxCaptureBytes: number
  readonly maxStoreBytes: number
  readonly maxFiles: number
  readonly maxReadBytes: number
  #queue: Promise<unknown> = Promise.resolve()
  constructor(config: ResultStoreConfig) {
    this.directory = path.resolve(config.directory)
    this.maxCaptureBytes = positiveLimit(config.maxCaptureBytes, 8 * 1024 * 1024, 'maxCaptureBytes')
    this.maxStoreBytes = positiveLimit(config.maxStoreBytes, 64 * 1024 * 1024, 'maxStoreBytes')
    this.maxFiles = positiveLimit(config.maxFiles, 1000, 'maxFiles')
    this.maxReadBytes = positiveLimit(config.maxReadBytes, 16 * 1024, 'maxReadBytes')
  }
  save(sessionId: string, text: string, signal: AbortSignal) {
    const operation = this.#queue.then(async () => {
      signal.throwIfAborted()
      if (!sessionId) throw new Error('sessionId is required for result storage')
      const original = Buffer.from(text), kept = utf8Prefix(original, this.maxCaptureBytes)
      const record = { version: 1, owner: digest(sessionId), sha256: digest(kept.toString('utf8')), content: kept.toString('utf8'), truncated: kept.length < original.length }
      const payload = JSON.stringify(record)
      await fs.mkdir(this.directory, { recursive: true })
      let total = 0, files = 0
      for await (const entry of await fs.opendir(this.directory)) {
        signal.throwIfAborted()
        if (++files >= this.maxFiles) throw new Error('result store file limit reached')
        if (!entry.isFile()) throw new Error('unexpected entry in result store')
        total += (await fs.stat(resolveInside(this.directory, entry.name))).size
        if (total > this.maxStoreBytes) throw new Error('result store byte limit reached')
      }
      if (total + Buffer.byteLength(payload) > this.maxStoreBytes) throw new Error('result store byte limit reached')
      const ref = randomUUID(), target = resolveInside(this.directory, `${ref}.json`)
      signal.throwIfAborted()
      const handle = await fs.open(target, 'wx', 0o600)
      try { await handle.writeFile(payload, { encoding: 'utf8', signal }); await handle.sync() }
      catch (error) { await handle.close(); await fs.unlink(target).catch(() => {}); throw error }
      await handle.close()
      return { ref, bytes: kept.length, truncated: record.truncated }
    })
    this.#queue = operation.catch(() => {})
    return operation
  }
  async read(sessionId: string | undefined, ref: unknown, offset: unknown, maxBytes: unknown, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!sessionId) throw new Error('sessionId is required for result retrieval')
    if (typeof ref !== 'string' || !uuid.test(ref)) throw new Error('invalid result reference')
    const start = offset ?? 0
    if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0) throw new Error('offset must be a nonnegative safe integer')
    const limit = positiveLimit(maxBytes, this.maxReadBytes, 'maxBytes', this.maxReadBytes)
    const target = resolveInside(this.directory, `${ref}.json`)
    if (!(await fs.lstat(target)).isFile()) throw new Error('result must be a regular file')
    const handle = await fs.open(target, 'r')
    let record: unknown
    try {
      const stat = await handle.stat()
      const cap = this.maxCaptureBytes * 6 + 2048
      if (!stat.isFile() || stat.size > cap) throw new Error('invalid result record size')
      const bytes = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < bytes.length) {
        signal.throwIfAborted()
        const result = await handle.read(bytes, length, bytes.length - length, length)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      if (length !== stat.size) throw new Error('result changed during retrieval')
      record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
    } finally { await handle.close() }
    if (!record || typeof record !== 'object') throw new Error('invalid result record')
    const data = record as Record<string, unknown>
    if (data.version !== 1 || data.owner !== digest(sessionId)) throw new Error('result unavailable for this session')
    if (typeof data.content !== 'string' || typeof data.truncated !== 'boolean' || data.sha256 !== digest(data.content)) throw new Error('result integrity check failed')
    const content = Buffer.from(data.content)
    if (content.length > this.maxCaptureBytes) throw new Error('result capture limit exceeded')
    if (start > content.length || (start < content.length && (content[start] & 0xc0) === 0x80)) throw new Error('offset must be a UTF-8 character boundary inside the result')
    const page = utf8Prefix(content.subarray(start), limit)
    if (!page.length && start < content.length) throw new Error('maxBytes cannot fit the next UTF-8 character')
    return { ref, content: page.toString('utf8'), offset: start, nextOffset: start + page.length, eof: start + page.length === content.length, totalBytes: content.length, captureTruncated: data.truncated }
  }
}
