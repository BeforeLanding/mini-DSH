import { isDeepStrictEqual } from 'node:util'
import { spawnSync } from 'node:child_process'
import type { SwebenchRunManifest } from './protocol.js'

export const COMPONENT_PROTOCOL = 'swe-components-v1'

export function componentArmDefinitions() {
  const budget = { inputTargetTokens: 65_536, auto: true, postCompactionPrune: false }
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
  const diff = spawnSync('git', ['diff', '--quiet', selection.sourceCommit, '--', ...paths])
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...paths], { encoding: 'utf8' })
  if (diff.status !== 0 || untracked.status !== 0 || untracked.stdout.trim()) throw new Error('component source differs from frozen sourceCommit; rebuild and refreeze')
}
