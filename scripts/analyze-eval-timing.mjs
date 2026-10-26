#!/usr/bin/env node
// NX-51：只读复用已保存的评测轨迹，把主动耗时拆成模型等待、摘要、工具与投影开销。
// 不读取 .env、不调用模型、不修改证据目录。用法：
//   node scripts/analyze-eval-timing.mjs <batch-dir> [...]
// 每个 batch-dir 需包含 episodes/<name>/sessions/<session>/events.jsonl。
import fs from 'node:fs'
import path from 'node:path'

function readEvents(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

function loadEpisodes(batchDir) {
  const episodesDir = path.join(batchDir, 'episodes')
  if (!fs.existsSync(episodesDir)) throw new Error(`not a batch directory: ${batchDir}`)
  return fs.readdirSync(episodesDir).sort().map(name => {
    const sessionsDir = path.join(episodesDir, name, 'sessions')
    const events = []
    if (fs.existsSync(sessionsDir)) {
      for (const sid of fs.readdirSync(sessionsDir).sort()) {
        const file = path.join(sessionsDir, sid, 'events.jsonl')
        if (fs.existsSync(file)) events.push(...readEvents(file))
      }
    }
    events.sort((a, b) => a.seq - b.seq)
    return { name, events }
  })
}

function elapsed(a, b) { return new Date(b) - new Date(a) }

function analyze(episode) {
  const events = episode.events
  const start = events.find(event => event.type === 'run/start')
  const finish = [...events].reverse().find(event => event.type === 'run/finish')
  const wallMs = start && finish ? elapsed(start.at, finish.at) : null

  // 摘要请求 = 落在 context/summary-start … context/summary-end 之间的 model/start。
  const summaryRequests = new Set()
  let open = null
  for (const event of events) {
    if (event.type === 'context/summary-start') open = event.seq
    else if (event.type === 'context/summary-end' && open !== null) {
      for (const candidate of events) {
        if (candidate.type === 'model/start' && candidate.seq > open && candidate.seq < event.seq) {
          summaryRequests.add(candidate.data.requestId)
        }
      }
      open = null
    }
  }

  const usage = new Map()
  const ends = new Map()
  for (const event of events) {
    if (event.type === 'model/usage') usage.set(event.data.requestId, event.data.usage)
    if (event.type === 'model/end') ends.set(event.data.requestId, event.data)
  }

  const requests = []
  for (const event of events) {
    if (event.type !== 'model/start') continue
    const end = events.find(candidate => candidate.type === 'model/end' && candidate.data.requestId === event.data.requestId)
    const measured = usage.get(event.data.requestId)
    requests.push({
      summary: summaryRequests.has(event.data.requestId),
      durationMs: end ? elapsed(event.at, end.at) : null,
      inputTokens: measured?.inputTokens ?? 0,
      outputTokens: measured?.outputTokens ?? 0,
      reasoningTokens: measured?.reasoningTokens ?? 0,
    })
  }

  const tools = []
  for (const event of events) {
    if (event.type !== 'tool/start') continue
    const result = events.find(candidate => candidate.type === 'tool/result' && candidate.data.toolCallId === event.data.toolCallId)
    tools.push({ name: event.data.name, durationMs: result ? elapsed(event.at, result.at) : null,
      isError: result?.data.isError ?? null, resultBytes: result ? Buffer.byteLength(result.data.content ?? '') : 0 })
  }

  const main = requests.filter(request => !request.summary)
  const summary = requests.filter(request => request.summary)
  const modelMs = requests.reduce((sum, request) => sum + (request.durationMs ?? 0), 0)
  const summaryMs = summary.reduce((sum, request) => sum + (request.durationMs ?? 0), 0)
  const toolMs = tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0)
  const toolByName = {}
  for (const tool of tools) {
    if (!toolByName[tool.name]) toolByName[tool.name] = { calls: 0, durationMs: 0, errors: 0, resultBytes: 0 }
    const entry = toolByName[tool.name]
    entry.calls += 1
    entry.durationMs += tool.durationMs ?? 0
    entry.errors += tool.isError ? 1 : 0
    entry.resultBytes += tool.resultBytes
  }

  return {
    episode: episode.name,
    wallMs,
    requests: {
      main: main.length,
      summary: summary.length,
      mainMs: modelMs - summaryMs,
      summaryMs,
      modelMs,
      inputTokens: requests.reduce((sum, request) => sum + request.inputTokens, 0),
      outputTokens: requests.reduce((sum, request) => sum + request.outputTokens, 0),
      reasoningTokens: requests.reduce((sum, request) => sum + request.reasoningTokens, 0),
      summaryOutputTokens: summary.reduce((sum, request) => sum + request.outputTokens, 0),
      summaryReasoningTokens: summary.reduce((sum, request) => sum + request.reasoningTokens, 0),
      longOver10s: requests.filter(request => (request.durationMs ?? 0) > 10_000).length,
      durationsMs: requests.map(request => ({ kind: request.summary ? 'summary' : 'main', ms: Math.round(request.durationMs ?? 0), out: request.outputTokens, reasoning: request.reasoningTokens })),
    },
    tools: { calls: tools.length, errors: tools.filter(tool => tool.isError).length, toolMs, byName: toolByName },
    overheadMs: wallMs === null ? null : wallMs - modelMs - toolMs,
    removedTaskIds: finish?.data.state.removedTaskIds ?? [],
  }
}

function regression(rows, key) {
  const xs = rows.map(row => row[key])
  const ys = rows.map(row => row.wallMs)
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
    syy += (ys[i] - my) ** 2
  }
  return { slope: sxy / sxx, r2: (sxy * sxy) / (sxx * syy), count: n }
}

function aggregate(rows) {
  const sum = key => rows.reduce((total, row) => total + key(row), 0)
  const outputTokens = sum(row => row.requests.outputTokens)
  const wallMs = sum(row => row.wallMs)
  return {
    episodes: rows.length,
    wallMs,
    mainMs: sum(row => row.requests.mainMs),
    summaryMs: sum(row => row.requests.summaryMs),
    toolMs: sum(row => row.tools.toolMs),
    overheadMs: sum(row => row.overheadMs),
    mainRequests: sum(row => row.requests.main),
    summaryRequests: sum(row => row.requests.summary),
    inputTokens: sum(row => row.requests.inputTokens),
    outputTokens,
    reasoningTokens: sum(row => row.requests.reasoningTokens),
    summaryOutputTokens: sum(row => row.requests.summaryOutputTokens),
    summaryReasoningTokens: sum(row => row.requests.summaryReasoningTokens),
    toolCalls: sum(row => row.tools.calls),
    toolErrors: sum(row => row.tools.errors),
    longOver10s: sum(row => row.requests.longOver10s),
    msPerOutputToken: wallMs / outputTokens,
    wallVsOutput: regression(rows.map(row => ({ ...row, out: row.requests.outputTokens })), 'out'),
  }
}

const args = process.argv.slice(2)
if (!args.length) {
  console.error('usage: node scripts/analyze-eval-timing.mjs <batch-dir> [...]')
  process.exit(2)
}
const output = {}
for (const dir of args) {
  const label = path.basename(path.resolve(dir))
  const episodes = loadEpisodes(dir).map(analyze)
  output[label] = { episodes, aggregate: aggregate(episodes) }
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
