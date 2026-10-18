import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHarness } from '../src/app/create-harness.js'
import { createSmokeRecorder, createSmokeReplay, restoreSmokeFixture, type SmokeWireOptions } from './smoke-recording.js'

const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--output') throw new Error('usage: node dist/scripts/smoke-recording-demo.js --output NEW_DIRECTORY')
const directory = path.resolve(args[1]!)
await fs.mkdir(directory)
const workspace = path.join(directory, 'fixture')
await fs.mkdir(workspace)
await fs.writeFile(path.join(workspace, 'sentinel.txt'), 'synthetic fixture: blue lantern\n', { flag: 'wx' })
const assembled = await createHarness({ workspace, profile: 'coding' })
const schema = assembled.capabilityManifest.toolSchemaSha256
await assembled.dispose()
const version = { codeSHA: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), fixtureId: 'offline-recording-demo', manifestDigest: '0'.repeat(64), toolSchemaSha256: schema }
const wire: SmokeWireOptions = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', thinking: 'enabled', sampling: 'provider-default', stream: true, includeUsage: true }
const recording = path.join(directory, 'recording.jsonl')
let number = 0
const recorder = createSmokeRecorder({ file: recording, workspace, version, wire, limits: { main: 2, summary: 1 }, delegate: async request => {
  number++
  request.onContent?.(`synthetic-${number}`)
  return { content: `synthetic-${number}`, complete: true, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, source: 'provider', uncertain: false } }
} })
const make = (purpose: 'main' | 'summary', content: string) => ({ purpose, model: 'fixture', maxOutputTokens: 16, system: 'synthetic smoke', messages: [{ role: 'user' as const, content }], tools: [] })
await recorder.chat(make('main', 'inspect blue lantern'))
await recorder.chat(make('summary', 'summarize blue lantern'))
await recorder.chat(make('main', 'finish blue lantern'))
recorder.close()
const restored = path.join(directory, 'restored-fixture')
restoreSmokeFixture(recording, restored)
const replay = createSmokeReplay({ file: recording, workspace: restored, version, wire })
await replay.chat(make('main', 'inspect blue lantern'))
await replay.chat(make('summary', 'summarize blue lantern'))
await replay.chat(make('main', 'finish blue lantern'))
replay.assertConsumed()
console.log(JSON.stringify({ recording, restoredFixture: restored, requests: replay.streams, schemaSha256: schema, paidRequests: 0 }))
