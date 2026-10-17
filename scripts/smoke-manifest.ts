import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createHarness } from '../src/app/create-harness.js'
import { smokeScenarios } from './smoke-plan.js'
import type { SmokeWireOptions } from './smoke-recording.js'

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export const smokeWire: SmokeWireOptions = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', thinking: 'enabled', sampling: 'provider-default', stream: true, includeUsage: true }
export const smokeModel = 'deepseek-flash'
export const smokeProtocol = 'NX-44-smoke-v2'
const repo = path.resolve(import.meta.dirname, '..', '..')

function git(...args: string[]) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim() }
function hashDirectory(directory: string): string {
  const entries: string[] = []
  const walk = (current: string, relative = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, entry.name)
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full, name)
      else if (entry.isFile()) entries.push(`${name}\0${sha(fs.readFileSync(full))}`)
      else throw new Error(`unsupported fixture source entry: ${name}`)
    }
  }
  walk(directory)
  return sha(entries.join('\n'))
}
export function currentCodeSHA() { return git('rev-parse', 'HEAD') }
export function assertCleanCode() { if (git('status', '--porcelain')) throw new Error('smoke freeze/run requires a clean worktree') }
export function smokeFixtureSourceSHA() { return hashDirectory(path.join(repo, 'test', 'fixtures', 'coding', 'repair')) }
export async function currentToolSchemaSHA() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-dsh-smoke-schema-'))
  try {
    const harness = await createHarness({ workspace, profile: 'coding', autoApprove: true })
    try { return harness.capabilityManifest.toolSchemaSha256 } finally { await harness.dispose() }
  } finally { fs.rmSync(workspace, { recursive: true }) }
}
export interface SmokeManifest {
  protocol: typeof smokeProtocol
  digest: string
  codeSHA: string
  toolSchemaSha256: string
  fixtureSourceSha256: string
  model: typeof smokeModel
  modelVersionLabel: 'DeepSeek-V4.1-Flash'
  echoedModel: string
  wire: SmokeWireOptions
  scenarios: typeof smokeScenarios
  price: { source: string; capturedAt: string; currency: 'USD'; peakCacheReadPerMillion: number; peakInputPerMillion: number; peakOutputPerMillion: number }
}
export function digestManifest(manifest: Omit<SmokeManifest, 'digest'>) { return sha(JSON.stringify(manifest)) }
export async function freezeSmokeManifest(priceCapturedAt: string, echoedModel = smokeModel): Promise<SmokeManifest> {
  assertCleanCode()
  const base: Omit<SmokeManifest, 'digest'> = { protocol: smokeProtocol, codeSHA: currentCodeSHA(), toolSchemaSha256: await currentToolSchemaSHA(), fixtureSourceSha256: smokeFixtureSourceSHA(), model: smokeModel, modelVersionLabel: 'DeepSeek-V4.1-Flash', echoedModel, wire: smokeWire, scenarios: smokeScenarios,
    price: { source: 'https://api-docs.deepseek.com/quick_start/pricing/', capturedAt: priceCapturedAt, currency: 'USD' as const, peakCacheReadPerMillion: 0.006, peakInputPerMillion: 0.30, peakOutputPerMillion: 1.20 } }
  return { ...base, digest: digestManifest(base) }
}
export async function verifySmokeManifest(manifest: SmokeManifest) {
  const { digest, ...base } = manifest
  if (manifest.protocol !== smokeProtocol || manifest.codeSHA !== currentCodeSHA() || JSON.stringify(manifest.scenarios) !== JSON.stringify(smokeScenarios) ||
    JSON.stringify(manifest.wire) !== JSON.stringify(smokeWire) || manifest.model !== smokeModel || manifest.modelVersionLabel !== 'DeepSeek-V4.1-Flash' || manifest.fixtureSourceSha256 !== smokeFixtureSourceSHA() ||
    manifest.toolSchemaSha256 !== await currentToolSchemaSHA() || digest !== digestManifest(base)) throw new Error('smoke manifest/code/scenario/schema mismatch')
}
