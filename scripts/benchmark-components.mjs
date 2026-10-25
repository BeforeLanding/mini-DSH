import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'

// Offline production-component probes. No provider, model driver, hidden checks or Bash.
const options = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2], process.argv[3 + i * 2]]))
assert.equal((process.argv.length - 2) % 2, 0, 'options must be --name value pairs')
for (const key of Object.keys(options)) assert.ok(['--root', '--out', '--compare', '--component'].includes(key), `unknown option ${key}`)
const root = path.resolve(options['--root'] ?? fileURLToPath(new URL('../', import.meta.url)))
const load = relative => import(pathToFileURL(path.join(root, 'dist', relative)).href)
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const tools = await load('src/plugins/tools.js'), sandbox = await load('src/plugins/sandbox.js')
const systemPrompt = await load('src/plugins/system-prompt.js')
const results = await load('src/plugins/tool-results.js')
const { surfaceSeqs } = await load('src/core/compaction-plan.js')
const { SessionRuntime } = await load('src/core/session-runtime.js')
const { snapshot } = await load('src/core/file-edit.js')
const { taskReport } = await load('src/core/task-verification.js')
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-components-'))
const signal = new AbortController().signal

function command(stdout, stderr = '') {
  const stream = text => ({ text, bytes: Buffer.byteLength(text), truncated: false })
  return { type: 'command', version: 1, command: 'synthetic-check', cwd: '.', status: 'exited', exitCode: 0,
    signal: null, durationMs: 0, timedOut: false, cancelled: false, stdout: stream(stdout), stderr: stream(stderr) }
}

async function toolCases() {
  const ctx = new Context()
  try {
    await ctx.plugin(tools); await ctx.plugin(systemPrompt); await ctx.plugin(sandbox, { workspace, autoApprove: true })
    ctx.sandbox.setApprover(async () => true)
    await ctx.plugin(results, { maxPreviewBytes: 64 })
    let payload = '', kind = 'text'
    ctx.tools.register({ name: 'probe', execute: () => payload })
    ctx.tools.register({ name: 'bash', execute: () => kind === 'stderr' ? command('', payload) : command(payload) })
    const records = []
    for (const type of ['text', 'stdout', 'stderr']) {
      const limit = type === 'text' ? 64 : 32
      for (const [variant, text, marker] of [
        ['one-over', 'x'.repeat(limit) + '!', '!'],
        ['near-tail', 'x'.repeat(limit) + 'END', 'END'],
        ['unicode', '中'.repeat(Math.floor(limit / 3)) + '终', '终'],
        ['long', 'x'.repeat(512) + 'END', 'END'],
      ]) {
        payload = text; kind = type
        const result = await ctx.tools.execute(type === 'text' ? 'probe' : 'bash', {}, { sessionId: 'offline' })
        assert.equal(result.isError, false)
        const item = type === 'text' ? { ...result.value, text: result.value.preview } : result.value[type]
        assert.equal(typeof item?.text, 'string', `missing preview for ${type}-${variant}: ${JSON.stringify(result)}`)
        const visibleBytes = Buffer.byteLength(item.text) + Buffer.byteLength(item.tail ?? '')
        const recalled = await ctx.tools.execute('read_tool_result', { ref: item.ref, maxBytes: 4096 }, { sessionId: 'offline' })
        assert.equal(recalled.isError, false); assert.equal(recalled.value.content, payload)
        records.push({ id: `${type}-${variant}`, limit, originalBytes: Buffer.byteLength(payload), visibleBytes,
          withinLimit: visibleBytes <= limit, tailVisible: (item.tail ?? item.text).endsWith(marker), fullRecall: true })
      }
    }
    return records
  } finally { await ctx.fiber.dispose() }
}

function history(pairs) {
  const events = []
  const add = (type, data) => {
    const event = { version: 1, seq: events.length + 1, at: '2026-10-25T00:00:00.000Z', sessionId: 's', taskId: 't', runId: 'r', type, data }
    events.push(event); return event.seq
  }
  const request = add('user/message', { content: 'Preserve the original request.' })
  const covered = []
  for (let i = 0; i < pairs; i++) {
    covered.push(add('assistant/tool_calls', { toolCalls: [{ id: `c${i}`, name: 'probe', arguments: { value: i } }] }))
    covered.push(add('tool/result', { toolCallId: `c${i}`, content: 'synthetic result '.repeat(20) }))
  }
  const tail = add('assistant/message', { content: 'Uncompacted tail.' })
  const summaries = []
  const summarize = seqs => add('context/summary', { startSeq: 1, trigger: 'explicit', budgetTokens: 10000,
    projectedTokens: 9000, shadowedSeqs: seqs, shadowedTokens: 2000, summaryTokens: 50, retainedNodes: 2, summary: 'done', frame: 'summary' })
  for (let i = 0; i < covered.length; i += 32) summaries.push(summarize(covered.slice(i, i + 32)))
  const nested = summarize(summaries.slice(0, 4))
  return { events, expected: [request, nested, ...summaries.slice(4), tail] }
}

function compactionCases() {
  return [64, 256, 1024].map(pairs => {
    const { events, expected } = history(pairs)
    const before = hash(events)
    let propertyReads = 0
    const counted = events.map(event => new Proxy(event, { get(target, key, receiver) {
      if (key === 'seq' || key === 'type') propertyReads++
      return Reflect.get(target, key, receiver)
    } }))
    const actual = surfaceSeqs(counted)
    assert.deepEqual(actual, expected); assert.equal(hash(events), before)
    const timings = []
    for (let i = 0; i < 5; i++) {
      const start = performance.now(); surfaceSeqs(events); timings.push(performance.now() - start)
    }
    return { id: `history-${pairs}`, events: events.length, propertyReads, outputSha256: hash(actual),
      correct: true, medianMs: timings.sort((a, b) => a - b)[2] }
  })
}

async function reportCases() {
  const records = []
  for (const checks of [1, 8, 32]) {
    const directory = path.join(workspace, `report-${checks}`)
    await fs.mkdir(directory)
    const resolve = file => path.join(directory, file)
    const sessions = new SessionRuntime(), session = sessions.create({ workspace: directory })
    const run = sessions.beginRun(session.id, {}, 'offline/probe')
    await fs.writeFile(resolve('source.mjs'), 'before')
    const before = await snapshot(resolve('source.mjs'), 1024, signal)
    await fs.writeFile(resolve('source.mjs'), 'after')
    await fs.writeFile(resolve('config.json'), '{}')
    const after = await snapshot(resolve('source.mjs'), 1024, signal)
    const config = await snapshot(resolve('config.json'), 1024, signal)
    const append = (type, data) => sessions.append(session.id, type, data, run)
    append('file/baseline', { path: 'source.mjs', snapshot: before })
    append('file/change', { changeId: 'change', path: 'source.mjs', tool: 'edit_file', before, after })
    append('file/change-result', { changeId: 'change', status: 'applied' })
    for (let i = 0; i < checks; i++) {
      const files = [{ path: 'source.mjs', hash: after.hash, location: after.location }, { path: 'config.json', hash: config.hash, location: config.location }]
      append('verification/start', { verificationId: `v${i}`, command: 'synthetic-check', cwd: '.', files })
      append('verification/result', { verificationId: `v${i}`, commandResult: { ...command(''), exitCode: checks > 1 && i === 0 ? 1 : 0 }, files })
    }
    sessions.finishRun(run, 'completed'); await sessions.flush(session.id)
    let snapshotOpens = 0
    const open = fs.open
    let report
    try {
      fs.open = async (...args) => { snapshotOpens++; return open.apply(fs, args) }
      report = await taskReport(sessions, session.id, resolve, 1024, signal, 0, 0, 20, 100)
    } finally { fs.open = open }
    assert.equal(report.acceptance, 'not_asserted'); assert.equal(report.verificationTotal, checks)
    assert.equal(report.files[0].verification, 'covered')
    assert.deepEqual(report.checks.map(item => item.status), Array.from({ length: checks }, (_, i) => checks > 1 && i === 0 ? 'failed' : 'passed'))
    const evidence = { files: report.files.map(item => ({ path: item.path, verification: item.verification, coveredBy: item.coveredBy })),
      checks: report.checks.map(item => ({ status: item.status, freshness: item.freshness })), acceptance: report.acceptance,
      filesEof: report.filesEof, verificationsEof: report.verificationsEof }
    records.push({ id: `report-${checks}`, checks, uniqueFiles: 2, snapshotOpens, correct: true, outputSha256: hash(evidence) })
  }
  return records
}

try {
  const modules = ['src/plugins/tool-results.js', 'src/core/tool-result-store.js', 'src/core/compaction-plan.js', 'src/core/task-verification.js', 'src/core/task-changes.js']
  const moduleSha256 = Object.fromEntries(await Promise.all(modules.map(async file => [file, hash(await fs.readFile(path.join(root, 'dist', file), 'utf8'))])))
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  const sourceCommit = await fs.readFile(path.join(root, 'source-commit.txt'), 'utf8').then(text => text.trim().replace(/^\uFEFF/, ''), () => git.stdout.trim())
  const report = { protocol: 'mini-dsh-components-v1', evidenceKind: 'offline-mechanism', sourceCommit,
    node: process.version, platform: process.platform, suiteSha256: hash(await fs.readFile(fileURLToPath(import.meta.url), 'utf8')),
    moduleSha256, tools: await toolCases(), compaction: compactionCases(), reports: await reportCases(), providerRequests: 0 }
  if (options['--compare']) {
    const baseline = JSON.parse(await fs.readFile(path.resolve(options['--compare']), 'utf8'))
    assert.equal(report.suiteSha256, baseline.suiteSha256, 'baseline and candidate must use the same frozen suite')
    assert.equal(report.protocol, baseline.protocol)
    const component = options['--component']
    assert.ok(component === undefined || ['tools', 'compaction', 'reports'].includes(component))
    const selected = component ? [component] : ['tools', 'compaction', 'reports']
    for (const key of selected) {
      assert.deepEqual(report[key].map(item => item.id), baseline[key].map(item => item.id))
      let improved = false
      for (const [i, item] of report[key].entries()) {
        const previous = baseline[key][i]
        if (key === 'tools') {
          assert.ok(item.withinLimit && item.tailVisible && item.fullRecall)
          improved ||= !previous.withinLimit || !previous.tailVisible
        } else {
          assert.equal(item.outputSha256, previous.outputSha256, 'optimization changed evidence/projection')
          const metric = key === 'compaction' ? 'propertyReads' : 'snapshotOpens'
          assert.ok(item[metric] <= previous[metric]); improved ||= item[metric] < previous[metric]
        }
      }
      assert.ok(improved, `${key}: no measured improvement`)
    }
    report.comparisonPassed = selected
  }
  if (options['--out']) await fs.writeFile(path.resolve(options['--out']), JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} finally { await fs.rm(workspace, { recursive: true, force: true }) }
