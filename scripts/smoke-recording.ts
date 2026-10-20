import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ModelStreamError } from '../src/core/model-error.js'
import { ModelNotDispatchedError } from '../src/core/model-dispatch.js'
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
export interface SmokeLimits { main: number; summary: number; maxTotalTokens?: number; maxMainOutputTokens?: number; maxSummaryOutputTokens?: number; maxWallDurationMs?: number; requireProviderUsage?: boolean }
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
  const roots = new Set([workspace, path.resolve(workspace)])
  try { roots.add(fs.realpathSync(workspace)); roots.add(fs.realpathSync.native(workspace)) } catch { /* synthetic requests may have no local workspace */ }
  const forms = [...roots].flatMap(root => [JSON.stringify(root).slice(1, -1), root, root.replaceAll('\\', '/')]).sort((a, b) => b.length - a.length)
  const visit = (item: unknown): Json => {
    if (typeof item === 'string') return forms.reduce((text, form) => text.replaceAll(form, workspaceToken), item)
    if (Array.isArray(item)) return item.map(visit)
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([, nested]) => nested !== undefined).map(([key, nested]) => [key, visit(nested)]))
    return item as Json
  }
  return visit(value)
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
interface ProviderEvent { kind: 'provider-event'; index: number; event: unknown }
interface End { kind: 'end'; index: number; status: 'returned' | 'error' | 'rejected'; response: ChatResponse; error?: string }
type Record = Header | Start | Chunk | ProviderEvent | End

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
  let totalTokens = 0
  let blocked = false
  const startedAt = Date.now()
  let index = 0
  let closed = false
  const chat: Adapter['chat'] = async request => {
    if (closed) throw new ModelNotDispatchedError('smoke recorder is closed', 'other_limit')
    if (blocked) throw new ModelNotDispatchedError('smoke recorder stopped after missing usage or exceeded budget; no provider call made', 'usage_unknown')
    const material = requestMaterial(request, options.wire, options.workspace)
    const purpose = request.purpose!
    if (options.limits.maxWallDurationMs !== undefined && Date.now() - startedAt >= options.limits.maxWallDurationMs) throw new ModelNotDispatchedError('smoke wall duration ceiling exceeded; no provider call made', 'other_limit')
    const outputCeiling = purpose === 'main' ? options.limits.maxMainOutputTokens : options.limits.maxSummaryOutputTokens
    if (outputCeiling !== undefined && request.maxOutputTokens! > outputCeiling) throw new ModelNotDispatchedError(`smoke ${purpose} output ceiling exceeded; no provider call made`, 'other_limit')
    if (options.limits.maxTotalTokens !== undefined && totalTokens >= options.limits.maxTotalTokens) throw new ModelNotDispatchedError('smoke cumulative token ceiling exceeded; no provider call made', 'other_limit')
    if (counts[purpose] >= options.limits[purpose]) throw new ModelNotDispatchedError(`smoke ${purpose} request ceiling exceeded; no provider call made`, 'request_limit')
    counts[purpose]++
    const current = index++
    write({ kind: 'start', index: current, purpose, fingerprint: requestFingerprint(material), request: material })
    let response: ChatResponse
    try {
      response = await options.delegate({ ...request,
        onProviderEvent: event => { write({ kind: 'provider-event', index: current, event }); request.onProviderEvent?.(event) },
        onContent: text => { write({ kind: 'chunk', index: current, channel: 'content', text }); request.onContent?.(text) },
        onReasoning: text => { write({ kind: 'chunk', index: current, channel: 'reasoning', text }); request.onReasoning?.(text) },
      })
    } catch (error) {
      if (error instanceof ModelNotDispatchedError) {
        counts[purpose]--
        write({ kind: 'end', index: current, status: 'rejected', response: { complete: false }, error: error.reason })
        throw error
      }
      const partial = error instanceof ModelStreamError ? error.partial : { complete: false }
      // Provider error bodies are untrusted and can echo request headers. Keep only
      // the typed failure category; the partial stream and usage remain available.
      write({ kind: 'end', index: current, status: 'error', response: partial, error: error instanceof Error ? error.name : 'unknown error' })
      throw error
    }
    if (response.usage?.source === 'provider') totalTokens += response.usage.totalTokens
    else if (options.limits.requireProviderUsage) blocked = true
    if (options.limits.maxTotalTokens !== undefined && totalTokens > options.limits.maxTotalTokens) blocked = true
    if (blocked) {
      const error = response.usage?.source !== 'provider' ? 'smoke provider usage missing; further calls stopped' : 'smoke cumulative token ceiling exceeded after provider response'
      write({ kind: 'end', index: current, status: 'error', response, error })
      throw new Error(error)
    }
    write({ kind: 'end', index: current, status: 'returned', response })
    return response
  }
  return { chat, fixture, counts, get totalTokens() { return totalTokens }, close: () => { if (!closed) { closed = true; fs.closeSync(fd) } } }
}

function normalizeBashResults(material: Json, fixtureRoot: string): Json {
  if (!material || typeof material !== 'object' || Array.isArray(material)) return material
  const messages = material.messages
  if (!Array.isArray(messages)) return material
  const bashCalls = new Set<string>()
  const normalized = messages.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call && typeof call === 'object' && !Array.isArray(call) && call.function && typeof call.function === 'object' && !Array.isArray(call.function) && call.function.name === 'bash' && typeof call.id === 'string') bashCalls.add(call.id)
      }
    }
    if (message.role !== 'tool' || typeof message.tool_call_id !== 'string' || !bashCalls.has(message.tool_call_id) || typeof message.content !== 'string') return message
    let result: { [key: string]: unknown }
    try { result = JSON.parse(message.content) as { [key: string]: unknown } } catch { throw new Error('smoke replay invalid Bash result; no API fallback') }
    if (result.type !== 'command' || result.version !== 1 || typeof result.cwd !== 'string' || typeof result.durationMs !== 'number' || !Number.isFinite(result.durationMs) || result.durationMs < 0) throw new Error('smoke replay invalid Bash result; no API fallback')
    const root = fixtureRoot.replace(/[\\/]$/, '')
    const cwd = result.cwd
    const relative = cwd === root || cwd === workspaceToken ? '' : cwd.startsWith(`${root}\\`) || cwd.startsWith(`${root}/`) ? cwd.slice(root.length + 1) : cwd.startsWith(`${workspaceToken}/`) ? cwd.slice(workspaceToken.length + 1) : null
    if (relative === null || (relative !== '' && relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..'))) throw new Error('smoke replay Bash cwd outside registered fixture; no API fallback')
    const cwdMatches = [...message.content.matchAll(/("cwd"\s*:\s*)("(?:\\.|[^"\\])*")/g)]
    const durationMatches = [...message.content.matchAll(/("durationMs"\s*:\s*)(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/g)]
    if (cwdMatches.length !== 1 || durationMatches.length !== 1) throw new Error('smoke replay ambiguous Bash result; no API fallback')
    const content = message.content.replace(cwdMatches[0]![0], `${cwdMatches[0]![1]}"${workspaceToken}${relative ? `/${relative.replaceAll('\\', '/')}` : ''}"`)
      .replace(durationMatches[0]![0], `${durationMatches[0]![1]}0`)
    return { ...message, content }
  })
  return { ...material, messages: normalized }
}

export function createSmokeReplay(options: { file: string; workspace: string; version: SmokeVersion; wire: SmokeWireOptions; recordedProjectWorkspace?: string; recordedBashFixtureWorkspace?: string }) {
  const records = fs.readFileSync(options.file, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line) as Record)
  const header = records.shift()
  if (header?.kind !== 'header' || header.format !== 'mini-dsh-smoke-recording-v1') throw new Error('invalid smoke recording header')
  if (stable(header.version) !== stable(options.version) || stable(header.wire) !== stable(options.wire)) throw new Error('smoke replay version or wire options mismatch')
  if (stable(header.fixture) !== stable(snapshotFixture(options.workspace))) throw new Error('smoke replay initial fixture mismatch')
  const streams = { main: 0, summary: 0 }
  let cursor = 0
  const chat: Adapter['chat'] = async request => {
    if (request.purpose === 'main' || request.purpose === 'summary') {
      if (streams[request.purpose] >= header.limits[request.purpose]) throw new ModelNotDispatchedError('recorded request ceiling reached; no API fallback', 'request_limit')
    }
    const material = requestMaterial(request, options.wire, options.workspace)
    const entry = records[cursor]
    if (options.recordedProjectWorkspace && typeof material === 'object' && !Array.isArray(material) && material !== null && typeof material.system === 'string') {
      const lines = material.system.split('\n')
      const index = lines.indexOf('## Project Context')
      if (index < 0 || index + 3 >= lines.length) throw new Error('smoke replay project context path mapping unavailable; no API fallback')
      const project = JSON.parse(lines[index + 3]!) as { workspace?: string }
      if (project.workspace !== workspaceToken) throw new Error('smoke replay project context workspace mismatch; no API fallback')
    }
    if (entry?.kind !== 'start' || entry.purpose !== request.purpose || entry.fingerprint !== requestFingerprint(entry.request)) throw new Error('smoke replay request fingerprint/order mismatch; no API fallback')
    const recordedRequest = options.recordedProjectWorkspace ? normalize(entry.request, options.recordedProjectWorkspace) : entry.request
    const expected = options.recordedBashFixtureWorkspace ? normalizeBashResults(recordedRequest, options.recordedBashFixtureWorkspace) : recordedRequest
    const actual = options.recordedBashFixtureWorkspace ? normalizeBashResults(material, options.workspace) : material
    if (requestFingerprint(expected) !== requestFingerprint(actual) || stable(expected) !== stable(actual)) throw new Error('smoke replay request fingerprint/order mismatch; no API fallback')
    cursor++
    streams[entry.purpose]++
    while (records[cursor]?.kind === 'chunk' || records[cursor]?.kind === 'provider-event') {
      const chunk = records[cursor++] as Chunk | ProviderEvent
      if (chunk.index !== entry.index) throw new Error('smoke replay stream index mismatch')
      if (chunk.kind === 'provider-event') request.onProviderEvent?.(chunk.event)
      else if (chunk.channel === 'content') request.onContent?.(chunk.text)
      else request.onReasoning?.(chunk.text)
    }
    const end = records[cursor++]
    if (end?.kind !== 'end' || end.index !== entry.index) throw new Error('smoke replay missing terminal response')
    if (end.status === 'rejected') throw new ModelNotDispatchedError('recorded pre-dispatch rejection', end.error === 'request_limit' || end.error === 'amount_limit' || end.error === 'usage_unknown' ? end.error : 'other_limit')
    if (end.status === 'error') throw new ModelStreamError(end.error ?? 'recorded stream error', end.response)
    return end.response
  }
  return { chat, streams, assertConsumed: () => { if (cursor !== records.length) throw new Error(`smoke replay has ${records.length - cursor} unconsumed events`) } }
}
