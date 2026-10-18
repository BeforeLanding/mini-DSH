// Run after build. This creates no session and makes no model request.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHarness } from '../dist/src/app/create-harness.js'
import { resolveV2Arms } from '../dist/scripts/eval-v2-plan.js'

const allowed = new Set(['budget.inputTargetTokens', 'budget.compactionBudgetTokens', 'toolOutput.bounded', 'promptLayout.frozen'])
const diff = (left, right, prefix = '') => [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])].flatMap(key => {
  const name = prefix ? `${prefix}.${key}` : key
  const a = left?.[key], b = right?.[key]
  return a && b && typeof a === 'object' && typeof b === 'object' ? diff(a, b, name) : JSON.stringify(a) === JSON.stringify(b) ? [] : [name]
})
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-capabilities-'))
const instances = []
try {
  const production = await createHarness({ workspace, profile: 'coding' })
  instances.push(production)
  const arms = []
  for (const arm of resolveV2Arms(1_000_000, '1m')) {
    const instance = await createHarness({ workspace, profile: 'coding', autoApprove: true,
      contextLayout: arm.promptLayout.frozen ? 'frozen' : 'live',
      toolOutputMaxPreviewBytes: arm.toolOutput.bounded ? undefined : 64 * 1024 * 1024 })
    instances.push(instance)
    if (instance.capabilityManifest.toolSchemaSha256 !== production.capabilityManifest.toolSchemaSha256) throw new Error(`${arm.name}: tool schema differs from production`)
    arms.push({ name: arm.name, schemaSha256: instance.capabilityManifest.toolSchemaSha256, policy: instance.capabilityManifest.policy, budget: arm.budget, toolOutput: arm.toolOutput, promptLayout: arm.promptLayout })
  }
  const baseline = arms[0]
  for (const arm of arms) {
    const changes = diff({ budget: baseline.budget, toolOutput: baseline.toolOutput, promptLayout: baseline.promptLayout }, { budget: arm.budget, toolOutput: arm.toolOutput, promptLayout: arm.promptLayout })
    const unexpected = changes.filter(name => !allowed.has(name))
    if (unexpected.length) throw new Error(`${arm.name}: forbidden differences: ${unexpected.join(', ')}`)
    arm.allowedDifferencesFromBaseline = changes
  }
  process.stdout.write(`${JSON.stringify({ protocolCandidate: 'NX-42-eval-v2.1', toolSchemaSha256: production.capabilityManifest.toolSchemaSha256, tools: production.capabilityManifest.tools, allowedDifferences: [...allowed], arms }, null, 2)}\n`)
} finally {
  for (const instance of instances.reverse()) await instance.dispose()
  await fs.rm(workspace, { recursive: true, force: true })
}
