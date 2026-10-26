import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHarness } from '../src/app/create-harness.js'
import { memoryHash, recordObject, sha256 } from '../src/core/memory-contracts.js'
import { groupPolicy } from '../src/core/task-group-budget.js'
import type { TaskGroupPolicy } from '../src/core/task-group-budget.js'
import { CLI_BUDGET, resolveBudget } from '../src/core/budget.js'
import type { BudgetPolicy } from '../src/core/budget.js'

const repository = fileURLToPath(new URL('../../', import.meta.url))
export const MEMORY_TEAM_ARMS = ['single-memory-off', 'single-memory-on', 'team-memory-off', 'team-memory-on'] as const
export type MemoryTeamArm = typeof MEMORY_TEAM_ARMS[number]
export interface MemoryTeamManifest {
  version: 1; protocol: 'memory-team-development-v1'; phase: 'development'; arm: MemoryTeamArm
  source: { commit: string; codeDigest: string }; model: string; taskGroupPolicy: TaskGroupPolicy; runBudget: BudgetPolicy
  memory: boolean; team: boolean; postCompactionPrune: false
  experienceDigest: string; workflowDigest: string; workflowIds: string[]
  preparationAccessibleToAll: true; paidExecutionAuthorized: false; amountCapUsd: null; digest: string
}
function git(args: string[]) { return execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true }).trim() }
async function codeDigest() {
  const files = [...new Set(git(['ls-files', '-co', '--exclude-standard', '--', 'src', 'scripts', 'plugins.config.ts', 'package.json', 'pnpm-lock.yaml']).split('\n').filter(Boolean))].sort()
  const entries = await Promise.all(files.map(async file => [file, memoryHash((await fs.readFile(path.join(repository, file), 'utf8')).replace(/\r\n/g, '\n'))]))
  return memoryHash(JSON.stringify(entries))
}
function manifestDigest(manifest: Omit<MemoryTeamManifest, 'digest'> | MemoryTeamManifest) { const { digest: _digest, ...body } = manifest as MemoryTeamManifest; return memoryHash(JSON.stringify(body)) }
async function data() {
  const directory = path.join(repository, 'docs', 'memory-team', 'eval')
  const experience = await fs.readFile(path.join(directory, 'experience.json')), workflows = await fs.readFile(path.join(directory, 'workflows.json'))
  const pack = JSON.parse(workflows.toString('utf8')), facts = JSON.parse(experience.toString('utf8'))
  if (pack.version !== 1 || pack.phase !== 'development' || !Array.isArray(pack.workflows) || pack.workflows.length !== 4 || !Array.isArray(facts.records) || facts.records.length !== 4) throw new Error('invalid development preparation data')
  const ids = pack.workflows.map((workflow: Record<string, unknown>) => String(workflow.id))
  if (new Set(ids).size !== 4 || !pack.workflows.every((workflow: Record<string, unknown>) => recordObject(workflow.initialFiles) && recordObject(workflow.targetFiles) && typeof workflow.target === 'string')) throw new Error('invalid development workflows')
  for (const fact of facts.records) {
    const workflow = pack.workflows.find((workflow: Record<string, unknown>) => workflow.id === fact.workflowId)
    if (!workflow || typeof workflow.initialFiles[fact.sourcePath] !== 'string' || typeof fact.content !== 'string') throw new Error('experience has no common source')
  }
  return { experienceDigest: memoryHash(experience), workflowDigest: memoryHash(workflows), workflowIds: ids }
}
export async function prepareMemoryTeamManifests(): Promise<MemoryTeamManifest[]> {
  const shared = await data(), source = { commit: git(['rev-parse', 'HEAD']), codeDigest: await codeDigest() }
  return MEMORY_TEAM_ARMS.map(arm => {
    const body: Omit<MemoryTeamManifest, 'digest'> = { version: 1, protocol: 'memory-team-development-v1', phase: 'development', arm, source, model: 'deepseek/deepseek-v4-flash', taskGroupPolicy: { ...groupPolicy() }, runBudget: { ...CLI_BUDGET, contextWindowTokens: 1_000_000 }, memory: arm.endsWith('memory-on'), team: arm.startsWith('team-'), postCompactionPrune: false, ...shared, preparationAccessibleToAll: true, paidExecutionAuthorized: false, amountCapUsd: null }
    return { ...body, digest: manifestDigest(body) }
  })
}
export async function validateMemoryTeamManifests(manifests: MemoryTeamManifest[]) {
  const shared = await data()
  const currentCodeDigest = await codeDigest()
  if (manifests.length !== 4 || new Set(manifests.map(manifest => manifest.arm)).size !== 4 || MEMORY_TEAM_ARMS.some(arm => !manifests.some(manifest => manifest.arm === arm))) throw new Error('exactly four independent memory/team arms are required')
  const common = (manifest: MemoryTeamManifest) => JSON.stringify({ model: manifest.model, source: manifest.source, taskGroupPolicy: manifest.taskGroupPolicy, runBudget: manifest.runBudget, experienceDigest: manifest.experienceDigest, workflowDigest: manifest.workflowDigest, workflowIds: manifest.workflowIds })
  if (manifests.some(manifest => common(manifest) !== common(manifests[0]))) throw new Error('arm model, source, data and total budget must match')
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-team-validate-'))
  let providerCalls = 0
  try {
    for (const manifest of manifests) {
      if (manifest.version !== 1 || manifest.protocol !== 'memory-team-development-v1' || manifest.phase !== 'development' || manifest.digest !== manifestDigest(manifest) || !sha256(manifest.source.codeDigest) || !/^[a-f0-9]{40}$/.test(manifest.source.commit) || manifest.source.codeDigest !== currentCodeDigest || manifest.memory !== manifest.arm.endsWith('memory-on') || manifest.team !== manifest.arm.startsWith('team-') || manifest.postCompactionPrune !== false || manifest.paidExecutionAuthorized !== false || manifest.amountCapUsd !== null || manifest.preparationAccessibleToAll !== true || manifest.experienceDigest !== shared.experienceDigest || manifest.workflowDigest !== shared.workflowDigest || JSON.stringify(manifest.workflowIds) !== JSON.stringify(shared.workflowIds)) throw new Error(`invalid, stale or paid manifest: ${manifest.arm}`)
      groupPolicy(manifest.taskGroupPolicy)
      resolveBudget(manifest.runBudget)
      if (!['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro'].includes(manifest.model)) throw new Error('development model must match the registered production adapter')
      const harness = await createHarness({ workspace: temporary, profile: 'coding', runtimeClockMode: 'frozen', contextLayout: 'live', taskGroupPolicy: manifest.taskGroupPolicy,
        ...(manifest.memory ? { memory: { mode: 'recall', directory: path.join(temporary, 'memory'), readOnly: true } as const } : {}),
        ...(manifest.team ? { delegation: { mode: 'read-only', directory: path.join(temporary, 'teams') } as const } : {}),
        adapter: { provider: 'validation', model: 'no-network', chat: async () => { providerCalls++; throw new Error('validate-only cannot call a model') } } })
      try {
        if (harness.capabilityManifest.tools.includes('memory_search') !== manifest.memory || harness.capabilityManifest.tools.includes('delegate_tasks') !== manifest.team || harness.capabilityManifest.tools.includes('memory_propose')) throw new Error('manifest differs from actual Harness capabilities')
      } finally { await harness.dispose() }
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }) }
  if (providerCalls) throw new Error('validation dispatched a model request')
  return { valid: true, protocol: 'memory-team-development-v1', arms: manifests.map(manifest => manifest.arm), workflowsPerArm: 4, plannedDevelopmentEpisodes: 16, providerCalls: 0, paidExecutionAuthorized: false, limitation: 'Preparation validation only; no effect scores or paid execution path is enabled.' }
}
export async function freezeMemoryTeamManifests(directory: string) {
  if (git(['status', '--porcelain'])) throw new Error('freeze requires a clean repository')
  const manifests = await prepareMemoryTeamManifests(); await validateMemoryTeamManifests(manifests)
  const target = path.resolve(directory); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.mkdir(target)
  for (const manifest of manifests) await fs.writeFile(path.join(target, `${manifest.arm}.manifest.json`), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return target
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory, ...extra] = process.argv.slice(2)
  if (extra.length || !directory || !['--freeze', '--validate-only'].includes(mode)) throw new Error('usage: eval-memory-team --freeze <new-directory> | --validate-only <manifest-directory>; paid runs require a separate budget authorization and runner phase')
  if (mode === '--freeze') console.log(await freezeMemoryTeamManifests(directory))
  else {
    const manifests = await Promise.all(MEMORY_TEAM_ARMS.map(async arm => JSON.parse(await fs.readFile(path.join(directory, `${arm}.manifest.json`), 'utf8')) as MemoryTeamManifest))
    console.log(JSON.stringify(await validateMemoryTeamManifests(manifests), null, 2))
  }
}
