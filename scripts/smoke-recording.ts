import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ModelStreamError } from '../src/core/model-error.js'
import type { Adapter, ChatRequest, ChatResponse } from '../src/core/contracts.js'

export interface SmokeWireOptions {
  provider: 'deepseek'
  baseUrl: 'https://api.deepseek.com'
  thinking: 'enabled' | 'disabled'
  sampling: 'provider-default'
  stream: true
  includeUsage: true
}
export interface SmokeVersion { codeSHA: string; fixtureId: string; manifestDigest: string; toolSchemaSha256: string }
export interface SmokeLimits { main: number; summary: number }
type Json = null | string | number | boolean | Json[] | { [key: string]: Json }

function stable(value: unknown): string {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  return JSON.stringify(value)
}
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const workspaceToken = '$' + '{WORKSPACE}'
const normalize = (value: unknown, workspace: string): Json => {
  if (typeof value === 'string') return value.replaceAll(workspace, workspaceToken).replaceAll(workspace.replaceAll('\\', '/'), workspaceToken)
  if (Array.isArray(value)) return value.map(item => normalize(item, workspace))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, normalize(item, workspace)]))
  return value as Json
}

export function requestMaterial(request: ChatRequest, wire: SmokeWireOptions, workspace: string) {
  if (request.purpose !== 'main' && request.purpose !== 'summary') throw new Error('smoke recording requires an explicit main/summary purpose')
  if (!request.model || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens! <= 0) throw new Error('smoke request requires model and maxOutputTokens')
  return normalize({ purpose: request.purpose, model: request.model, maxOutputTokens: request.maxOutputTokens,
    system: request.system ?? '', messages: request.messages ?? [], tools: request.tools ?? [], wire }, workspace)
}
export function requestFingerprint(material: Json) { return sha(stable(material)) }

export function snapshotFixture(workspace: string) {
  const files: { path: string; sha256: string; contentBase64: string }[] = []
  let bytes = 0
  const visit = (directory: string, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) throw new Error(`smoke fixture rejects hidden entries and links: ${entry.name}`)
      const name = path.posix.join(relative, entry.name)
      const source = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(source, name)
      else if (entry.isFile()) {
        const content = fs.readFileSync(source)
        bytes += content.length
        if (bytes > 1024 * 1024) throw new Error('smoke fixture snapshot exceeds 1 MiB')
        files.push({ path: name, sha256: sha(content), contentBase64: content.toString('base64') })
      } else throw new Error(`unsupported fixture entry: ${name}`)
    }
  }
  visit(workspace)
  return { files, sha256: sha(stable(files.map(({ path, sha256 }) => ({ path, sha256 })))) }
}

interface Header { kind: 'header'; format: 'mini-dsh-smoke-recording-v1'; version: SmokeVersion; fixture: ReturnType<typeof snapshotFixture>; wire: SmokeWireOptions; limits: SmokeLimits }
interface Start { kind: 'start'; index: number; purpose: 'main' | 'summary'; fingerprint: string; request: Json }
interface Chunk { kind: 'chunk'; index: number; channel: 'content' | 'reasoning'; text: string }
interface End { kind: 'end'; index: number; status: 'returned' | 'error'; response: ChatResponse; error?: string }
type Record = Header | Start | Chunk | End

export function restoreSmokeFixture(recordingFile: string, destination: string) {
  const first = fs.readFileSync(recordingFile, 'utf8').split(/\r?\n/, 1)[0]
  const header = JSON.parse(first) as Header
  if (header.kind !== 'header' || header.format !== 'mini-dsh-smoke-recording-v1' || !Array.isArray(header.fixture?.files)) throw new Error('invalid smoke fixture header')
  const checked = header.fixture.files.map(item => {
    if (typeof item.path !== 'string' || !item.path || item.path.startsWith('/') || item.path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || !/^[A-Za-z0-9_./-]+$/.test(item.path)) throw new Error('invalid smoke fixture path')
    const content = Buffer.from(item.contentBase64, 'base64')
    if (sha(content) !== item.sha256) throw new Error('smoke fixture content hash mismatch')
    return { name: item.path, content }
  })
  if (new Set(checked.map(item => item.name)).size !== checked.length) throw new Error('duplicate smoke fixture path')
  fs.mkdirSync(destination, { recursive: false })
  for (const item of checked) {
    const target = path.join(destination, item.name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, item.content, { flag: 'wx' })
  }
  if (snapshotFixture(destination).sha256 !== header.fixture.sha256) throw new Error('smoke fixture snapshot hash mismatch')
  return header.fixture.sha256
}

export function createSmokeRecorder(options: { file: string; workspace: string; version: SmokeVersion; wire: SmokeWireOptions; limits: SmokeLimits; delegate: Adapter['chat'] }) {
  const fixture = snapshotFixture(options.workspace)
  const fd = fs.openSync(options.file, 'wx', 0o600)
  const write = (entry: Record) => { fs.writeSync(fd, `${JSON.stringify(entry)}\n`); fs.fsyncSync(fd) }
  write({ kind: 'header', format: 'mini-dsh-smoke-recording-v1', version: options.version, fixture, wire: options.wire, limits: options.limits })
  const counts = { main: 0, summary: 0 }
  let index = 0
  let closed = false
  const chat: Adapter['chat'] = async request => {
    if (closed) throw new Error('smoke recorder is closed')
    const material = requestMaterial(request, options.wire, options.workspace)
    const purpose = request.purpose!
    if (++counts[purpose] > options.limits[purpose]) throw new Error(`smoke ${purpose} request ceiling exceeded; no provider call made`)
    const current = index++
    write({ kind: 'start', index: current, purpose, fingerprint: requestFingerprint(material), request: material })
    try {
      const response = await options.delegate({ ...request,
        onContent: text => { write({ kind: 'chunk', index: current, channel: 'content', text }); request.onContent?.(text) },
        onReasoning: text => { write({ kind: 'chunk', index: current, channel: 'reasoning', text }); request.onReasoning?.(text) },
      })
      write({ kind: 'end', index: current, status: 'returned', response })
      return response
    } catch (error) {
      const partial = error instanceof ModelStreamError ? error.partial : { complete: false }
      write({ kind: 'end', index: current, status: 'error', response: partial, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
  return { chat, fixture, counts, close: () => { if (!closed) { closed = true; fs.closeSync(fd) } } }
}

export function createSmokeReplay(options: { file: string; workspace: string; version: SmokeVersion; wire: SmokeWireOptions }) {
  const records = fs.readFileSync(options.file, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line) as Record)
  const header = records.shift()
  if (header?.kind !== 'header' || header.format !== 'mini-dsh-smoke-recording-v1') throw new Error('invalid smoke recording header')
  if (stable(header.version) !== stable(options.version) || stable(header.wire) !== stable(options.wire)) throw new Error('smoke replay version or wire options mismatch')
  if (stable(header.fixture) !== stable(snapshotFixture(options.workspace))) throw new Error('smoke replay initial fixture mismatch')
  const streams = { main: 0, summary: 0 }
  let cursor = 0
  const chat: Adapter['chat'] = async request => {
    const material = requestMaterial(request, options.wire, options.workspace)
    const entry = records[cursor++]
    if (entry?.kind !== 'start' || entry.purpose !== request.purpose || entry.fingerprint !== requestFingerprint(material) || stable(entry.request) !== stable(material)) throw new Error('smoke replay request fingerprint/order mismatch; no API fallback')
    streams[entry.purpose]++
    while (records[cursor]?.kind === 'chunk') {
      const chunk = records[cursor++] as Chunk
      if (chunk.index !== entry.index) throw new Error('smoke replay stream index mismatch')
      if (chunk.channel === 'content') request.onContent?.(chunk.text)
      else request.onReasoning?.(chunk.text)
    }
    const end = records[cursor++]
    if (end?.kind !== 'end' || end.index !== entry.index) throw new Error('smoke replay missing terminal response')
    if (end.status === 'error') throw new ModelStreamError(end.error ?? 'recorded stream error', end.response)
    return end.response
  }
  return { chat, streams, assertConsumed: () => { if (cursor !== records.length) throw new Error(`smoke replay has ${records.length - cursor} unconsumed events`) } }
}
