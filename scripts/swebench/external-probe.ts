import fs from 'node:fs/promises'
import path from 'node:path'
import { tokenCapFromUsd, validateRunManifest } from './protocol.js'
import { preflightExternal, runExternalEpisode } from './external-run.js'
import { exportDockerWorkspace } from './workspace.js'

// Zero-model acceptance probe for the pinned external baseline. It runs the
// real mini-SWE-agent CLI, dataset loader, config merge and Docker transport
// with DeterministicModel, then checks the prediction/trajectory/label cleanup.
// It refuses to run without --execute so a typo cannot start containers.

function argument(name: string) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`)
  return value
}

async function main() {
  if (!process.argv.includes('--execute')) throw new Error('the external probe starts Docker; pass --execute explicitly')
  const manifestPath = path.resolve(argument('--manifest'))
  const manifest = validateRunManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')))
  const split = argument('--split')
  if (split !== 'development' && split !== 'formal') throw new Error('--split must be development or formal')
  const instanceId = argument('--instance')
  const python = argument('--python')
  const out = path.resolve(argument('--out'))
  const batch = manifest[split]
  const instance = batch.instances.find(value => value.instance_id === instanceId)
  if (!instance) throw new Error(`${instanceId} is not in the ${split} split`)
  const image = manifest.environment.imageDigests?.[instanceId]
  if (!image) throw new Error(`${instanceId} has no frozen image digest`)
  const arm = manifest.arms.find(value => value.system === 'external')
  if (!arm) throw new Error('manifest has no external arm')
  const preflight = await preflightExternal({ manifest, split, instances: [instance], images: manifest.environment.imageDigests ?? {}, python })

  await fs.mkdir(out, { recursive: false })
  const episodeDirectory = path.join(out, 'episode')
  await fs.mkdir(episodeDirectory, { recursive: true })
  const workspace = path.join(episodeDirectory, 'workspace')
  const exported = await exportDockerWorkspace({ image, baseCommit: instance.base_commit, target: workspace, exportName: 'mini-dsh-probe-export' })
  const action = process.argv.includes('--submit-patch')
    ? "printf '\\n' >> README.rst && git diff > /tmp/probe.patch && echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT && cat /tmp/probe.patch"
    : 'echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT'
  const cap = split === 'development' ? manifest.caps.developmentPerTask : manifest.caps.perTask
  const outcome = await runExternalEpisode({
    arm, instance, image, workspace, episodeDirectory, batchId: 'external-probe', index: 0,
    caps: { maxCostUsd: cap.maxCostUsd, maxModelRequests: cap.maxModelRequests, maxToolCalls: cap.maxToolCalls,
      wallClockMs: cap.wallClockMs, maxOutputTokens: cap.maxOutputTokens,
      maxTotalTokens: manifest.prices ? tokenCapFromUsd(cap.maxCostUsd, manifest.prices) : Number.MAX_SAFE_INTEGER },
    prices: manifest.prices, python,
    upstreamConfigPath: preflight.upstreamConfigPath, upstreamConfigSha256: preflight.upstreamConfigSha256,
    model: 'deterministic', apiKeyEnv: preflight.apiKeyEnv, modelClass: 'deterministic',
    modelExtra: { cost_per_call: 0, outputs: [{ role: 'assistant', content: 'submit',
      extra: { actions: [{ command: action }], cost: 0 } }] },
    timeoutMs: 180_000,
  })
  const summary = {
    probe: 'swebench-external-deterministic', manifest: path.basename(manifestPath), split, instanceId, image,
    baselineVersion: preflight.version, upstreamConfigSha256: preflight.upstreamConfigSha256, installSha256: preflight.installSha256,
    imageHead: exported.imageHead, patchBase: exported.patchBase, environmentCommit: exported.environmentCommit,
    status: outcome.status, emptyPatch: outcome.patch === '', submittedPatch: outcome.patch,
    miniExitStatus: outcome.external.miniExitStatus, containerIds: outcome.external.containerIds,
    containerEnvNames: outcome.external.containerEnvNames, leftoverContainerIds: outcome.external.leftoverContainerIds,
    secretLeak: outcome.external.secretLeak, usageUnknown: outcome.usageUnknown, usageReasons: outcome.external.usageReasons,
  }
  await fs.writeFile(path.join(out, 'probe.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify({ status: summary.status, emptyPatch: summary.emptyPatch, leftover: summary.leftoverContainerIds,
    secretLeak: summary.secretLeak, out }, null, 2))
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
