import { isDeepStrictEqual } from 'node:util'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { SwebenchRunManifest } from './protocol.js'

export const COMPONENT_PROTOCOL = 'swe-components-v1'

// WSL can execute the Windows checkout, but Git cannot follow a Windows
// absolute worktree pointer. Confine the adaptation to these source queries;
// exporting GIT_DIR would redirect later candidate-workspace Git operations.
export function sourceGitPrefix(pointer: string, directory: string, platform: string): string[] {
  if (platform !== 'linux' || !/^\/mnt\/[a-z]\//.test(directory)) return []
  const match = /^gitdir: ([A-Za-z]):[\\/]([^\r\n]+)\r?\n?$/.exec(pointer)
  if (!match) return []
  return ['--git-dir', `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replaceAll('\\', '/')}`, '--work-tree', directory,
    '-c', 'core.autocrlf=true']
}

export function sourceGitArgs() {
  try { return sourceGitPrefix(fs.readFileSync(path.join(process.cwd(), '.git'), 'utf8'), process.cwd(), process.platform) }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error.code === 'EISDIR' || error.code === 'ENOENT')) return []
    throw error
  }
}

export function componentArmDefinitions() {
  // The historical 52k pressure line was never reached before the cumulative
  // 416k episode limit. Separate the compaction trigger from the hard input
  // target, leaving room to amortize a short summary over later requests.
  const budget = { inputTargetTokens: 65_536, compactionBudgetTokens: 16_384, compactionMaxTokens: 2_048,
    auto: true, postCompactionPrune: false }
  const harness = { toolOutput: true, toolOutputMaxPreviewBytes: 16_384, projectContext: true }
  return [
    { id: 'full', system: 'mini-dsh' as const, role: 'full same-source harness', budget, harness },
    { id: 'harness-baseline', system: 'mini-dsh' as const, role: 'same-source minimal baseline', budget: { ...budget, auto: false }, harness: { ...harness, toolOutput: false, projectContext: false } },
    { id: 'without-context', system: 'mini-dsh' as const, role: 'full minus automatic context compaction', budget: { ...budget, auto: false }, harness },
    { id: 'without-tool-output', system: 'mini-dsh' as const, role: 'full minus bounded tool previews and recall', budget, harness: { ...harness, toolOutput: false } },
    { id: 'without-project-context', system: 'mini-dsh' as const, role: 'full minus injected scoped project guidance', budget, harness: { ...harness, projectContext: false } },
    { id: 'baseline', system: 'external' as const, role: 'same-model external mini-SWE-agent system comparison', budget: {}, harness: undefined },
  ]
}

export const COMPONENT_PAIRS = [
  ['full', 'harness-baseline'], ['full', 'without-context'], ['full', 'without-tool-output'],
  ['full', 'without-project-context'], ['full', 'baseline'],
] as const

export function validateComponentProtocol(manifest: SwebenchRunManifest) {
  if ((manifest.selection as { protocol?: unknown })?.protocol !== COMPONENT_PROTOCOL) return
  const expected = componentArmDefinitions()
  if (!isDeepStrictEqual(manifest.arms.map(arm => arm.id), expected.map(arm => arm.id))) throw new Error('component protocol requires all six ordered arms')
  if (manifest.environment.commandEnvironment !== 'testbed-v1') throw new Error('component protocol requires testbed-v1')
  const full = manifest.arms[0]!
  for (const [index, definition] of expected.entries()) {
    const actual = manifest.arms[index]!
    if (actual.system !== definition.system || !isDeepStrictEqual(actual.model, full.model)) throw new Error(`component protocol model/system drift: ${actual.id}`)
    if (!isDeepStrictEqual(actual.harness, definition.harness)) throw new Error(`component protocol harness drift: ${actual.id}`)
    const { maxModelRequests: _r, maxToolCalls: _t, maxActiveDurationMs: _a, maxOutputTokens: _o, ...budget } = actual.budget
    if (!isDeepStrictEqual(budget, definition.budget)) throw new Error(`component protocol budget drift: ${actual.id}`)
  }
  const selection = manifest.selection as { sourceCommit?: unknown }
  if (manifest.freezeStatus === 'frozen' && (typeof selection.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(selection.sourceCommit))) throw new Error('component protocol requires sourceCommit')
}

export function assertComponentSource(manifest: SwebenchRunManifest) {
  if ((manifest.selection as { protocol?: unknown })?.protocol !== COMPONENT_PROTOCOL) return
  validateComponentProtocol(manifest)
  const selection = manifest.selection as { sourceCommit: string }
  // Also reject untracked source files: a clean tracked diff alone does not pin
  // the code being executed. Documentation-only follow-up commits are allowed.
  const paths = ['src', 'scripts', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'plugins.config.ts']
  const prefix = sourceGitArgs()
  const diff = spawnSync('git', [...prefix, 'diff', '--quiet', selection.sourceCommit, '--', ...paths])
  const untracked = spawnSync('git', [...prefix, 'ls-files', '--others', '--exclude-standard', '--', ...paths], { encoding: 'utf8' })
  if (diff.status !== 0 || untracked.status !== 0 || untracked.stdout.trim()) throw new Error('component source differs from frozen sourceCommit; rebuild and refreeze')
}
