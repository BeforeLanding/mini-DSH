import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHarness } from '../../src/app/create-harness.js'
import { CLI_BUDGET } from '../../src/core/budget.js'
import type { ToolCall } from '../../src/core/contracts.js'
import { createDockerCandidateRunner } from './docker-candidate.js'
import { mapHostToContainer } from './protocol.js'
import { compareSourceTrees, describeSourceMismatch, parseRawDiff, parseTreeListing,
  summarizeRawDiff } from './source-consistency.js'

const root = process.env.RUNNER_TEMP ?? os.tmpdir()
const runId = process.env.GITHUB_RUN_ID
if (!runId || !/^\d+$/.test(runId)) throw new Error('candidate PoC requires a GitHub Actions run id')
const directory = path.join(root, 'swebench-poc')
const evidenceDirectory = path.join(directory, 'result')
const candidate = path.join(directory, 'candidate')
const official = JSON.parse(await fs.readFile(path.join(evidenceDirectory, 'manifest.json'), 'utf8'))
assert.equal(official.status, 'official-gold-scored-twice')
assert.equal(official.instanceId, 'sympy__sympy-20590')
assert.equal(official.runs.length, 2)
const image: string = official.imageDigests[0]
assert.equal(image, 'swebench/sweb.eval.x86_64.sympy_1776_sympy-20590@sha256:3a282752833ce34730ee0621e22033501c993f45742775ca57f04c9ff27178a0')
const row = JSON.parse(await fs.readFile(path.join(evidenceDirectory, 'one-instance.json'), 'utf8'))[0]
assert.equal(row.instance_id, official.instanceId)

function command(executable: string, args: string[], options: { cwd?: string; timeout?: number } = {}) {
  return commandRaw(executable, args, options).trim()
}
function commandRaw(executable: string, args: string[], options: { cwd?: string; timeout?: number } = {}) {
  return execFileSync(executable, args, { cwd: options.cwd, timeout: options.timeout ?? 30_000,
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
}
function docker(...args: string[]) { return command('docker', args) }
function removeOwned(name: string) {
  const filter = `name=^/${name}$`
  if (!docker('ps', '-aq', '--filter', filter)) return
  docker('rm', '-f', name)
  if (docker('ps', '-aq', '--filter', filter)) throw new Error(`candidate container remained after cleanup: ${name}`)
}

const exportName = `mini-dsh-export-${runId}`
const candidateName = `mini-dsh-candidate-${runId}`
let exported = false
let started = false
try {
  // Refuse a reused destination instead of deleting a potentially unrelated tree.
  await fs.mkdir(candidate)
  assert.equal(docker('ps', '-aq', '--filter', `name=^/${exportName}$`), '')
  exported = true
  docker('create', '--name', exportName, image, 'sh', '-lc', 'true')
  docker('cp', `${exportName}:/testbed/.`, candidate)
  const checkoutRoot = command('git', ['rev-parse', '--show-toplevel'], { cwd: candidate })
  const imageHead = command('git', ['rev-parse', 'HEAD'], { cwd: candidate })
  const baseObject = spawnSync('git', ['cat-file', '-t', official.baseCommit], { cwd: candidate,
    encoding: 'utf8', timeout: 30_000 })
  const imageTree = command('git', ['rev-parse', 'HEAD^{tree}'], { cwd: candidate })
  const baseTree = baseObject.status === 0 ? command('git', ['rev-parse', `${official.baseCommit}^{tree}`], { cwd: candidate }) : 'absent'
  if (path.resolve(checkoutRoot) !== path.resolve(candidate) || baseObject.status !== 0) {
    throw new Error(`official image checkout invalid: root=${checkoutRoot}; imageHead=${imageHead}; ` +
      `datasetBase=${official.baseCommit}; baseObject=${baseObject.status === 0 ? baseObject.stdout.trim() : 'absent'}; ` +
      `imageHeadSubject=${command('git', ['show', '-s', '--format=%s', 'HEAD'], { cwd: candidate })}`)
  }
  // Official images commit an environment step on top of the dataset base.
  // Compare every path's object id, not the tree hash: image setup may rewrite
  // modes (e.g. chmod -R 777) while leaving every blob byte-identical. Content
  // differences reject the checkout; mode-only differences are recorded.
  const comparison = compareSourceTrees(
    parseTreeListing(commandRaw('git', ['ls-tree', '-r', '-z', '--full-tree', official.baseCommit], { cwd: candidate })),
    parseTreeListing(commandRaw('git', ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], { cwd: candidate })))
  const raw = summarizeRawDiff(parseRawDiff(commandRaw('git', ['diff-tree', '-r', '--raw',
    '--no-commit-id', official.baseCommit, 'HEAD'], { cwd: candidate })))
  if (!comparison.contentEqual || raw.contentChanges !== 0) {
    throw new Error(`official image content differs from dataset base: ` +
      describeSourceMismatch({ imageHead, datasetBase: official.baseCommit, comparison, raw }) +
      `; imageTree=${imageTree}; baseTree=${baseTree}`)
  }
  // Content is identical, so it is safe to normalise HEAD and worktree modes to
  // the pinned base before the Agent starts. The evidence below preserves what
  // the image actually shipped.
  if (imageHead !== official.baseCommit) command('git', ['reset', '--hard', official.baseCommit], { cwd: candidate })
  const sourceConsistency = { imageHead, datasetBaseCommit: official.baseCommit, imageTree, baseTree,
    treeIdentical: imageTree === baseTree, contentEqual: true, entries: comparison.imageEntries,
    modeDifferenceCount: comparison.modeDifferences.length, modeTransitions: comparison.modeTransitions,
    rawDiffEntries: raw.entries, rawContentChanges: raw.contentChanges, rawStatuses: raw.statuses,
    comparison: 'recursive git ls-tree object ids ignoring mode; cross-checked with git diff-tree --raw' }
  assert.equal(command('git', ['rev-parse', 'HEAD'], { cwd: candidate }), official.baseCommit)
  assert.equal(command('git', ['status', '--porcelain'], { cwd: candidate }), '')
  assert.equal(mapHostToContainer(candidate, path.join(candidate, 'sympy')), '/testbed/sympy')
  assert.throws(() => mapHostToContainer(candidate, directory), /escapes its workspace/)

  assert.equal(docker('ps', '-aq', '--filter', `name=^/${candidateName}$`), '')
  started = true
  docker('run', '-d', '--name', candidateName, '--network', 'none', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev',
    // The official evaluation script runs `git config --global --add
    // safe.directory /testbed` before grading. The bind mount is owned by the
    // host runner, so git inside the container needs the same trust entry.
    // Passing it through git's environment config avoids writing to the
    // read-only container root and does not relax any other check.
    '--mount', `type=bind,src=${candidate},dst=/testbed`, '--workdir', '/testbed',
    '--env', 'GIT_CONFIG_COUNT=1', '--env', 'GIT_CONFIG_KEY_0=safe.directory',
    '--env', 'GIT_CONFIG_VALUE_0=/testbed', image, 'sh', '-lc', 'sleep 900')
  const container = JSON.parse(docker('inspect', candidateName))[0]
  assert.equal(container.HostConfig.NetworkMode, 'none')
  assert.equal(container.HostConfig.Privileged, false)
  assert.equal(container.HostConfig.ReadonlyRootfs, true)
  assert.deepEqual(container.Mounts.map((mount: { Destination: string }) => mount.Destination), ['/testbed'])
  assert.equal(path.resolve(container.Mounts[0].Source), path.resolve(candidate))
  assert.equal(container.Mounts[0].RW, true)
  assert.ok(!container.Config.Env.some((variable: string) => /^(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|GH_TOKEN)=/.test(variable)))
  docker('exec', candidateName, 'sh', '-lc', 'test ! -e /var/run/docker.sock && test ! -e /oracle && test ! -e /reference')
  assert.equal(docker('exec', '--workdir', '/testbed', candidateName, 'git', 'rev-parse', 'HEAD'), official.baseCommit)

  const calls: ToolCall[] = [
    { id: 'write', name: 'write_file', arguments: { path: 'mini_dsh_probe.txt', content: 'host-visible\n' } },
    { id: 'container-read', name: 'bash', arguments: { command: 'cat mini_dsh_probe.txt' } },
    { id: 'container-write', name: 'bash', arguments: { command: "printf 'container-visible\\n' >> mini_dsh_probe.txt" } },
    { id: 'host-read', name: 'read_file', arguments: { path: 'mini_dsh_probe.txt' } },
  ]
  let step = 0
  const results: { name: string; value: unknown; isError: boolean }[] = []
  const harness = await createHarness({ workspace: candidate, profile: 'coding', autoApprove: true,
    projectContext: false, toolOutput: false, commandRunner: createDockerCandidateRunner(candidate, candidateName),
    adapter: { provider: 'scripted', model: 'candidate', capabilities: { candidate: { contextWindowTokens: 1_000_000 } },
      chat: async () => step < calls.length ? { toolCalls: [calls[step++]!] } : { content: 'scripted candidate probe complete' } } })
  try {
    const session = harness.root.sessions.create({ source: 'swebench-poc', workspace: candidate })
    const agent = harness.root.agents.create({ name: 'candidate-poc', sessionId: session.id,
      model: 'scripted/candidate', loop: harness.root.agentLoop, budget: CLI_BUDGET })
    await agent.send('Run the fixed offline file and Bash visibility probe.', {
      onToolResult: result => results.push({ name: result.name, value: result.value, isError: result.isError }),
    })
  } finally { await harness.dispose() }
  assert.deepEqual(results.map(result => result.name), calls.map(call => call.name))
  assert.ok(results.every(result => !result.isError))
  const bashRead = results[1]!.value as { stdout: { text: string } }
  assert.equal(bashRead.stdout.text, 'host-visible\n')
  assert.equal(await fs.readFile(path.join(candidate, 'mini_dsh_probe.txt'), 'utf8'), 'host-visible\ncontainer-visible\n')
  assert.match(String(results[3]!.value), /container-visible/)
  removeOwned(candidateName)
  started = false

  // The public gold patch is introduced only after the scripted Agent has ended.
  // This tests candidate diff export and independent official scoring, not solving.
  await fs.rm(path.join(candidate, 'mini_dsh_probe.txt'))
  const applied = spawnSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: candidate,
    input: row.patch, encoding: 'utf8', timeout: 30_000 })
  if (applied.status !== 0) throw new Error(`known patch did not apply to candidate base: ${applied.stderr}`)
  const patch = command('git', ['diff', '--binary'], { cwd: candidate })
  assert.ok(patch)
  const prediction = path.join(evidenceDirectory, 'candidate-prediction.jsonl')
  await fs.writeFile(prediction, JSON.stringify({ instance_id: official.instanceId,
    model_name_or_path: 'mini-dsh-poc-no-model', model_patch: patch + '\n' }) + '\n')
  const scoreRun = `mini-dsh-${runId}-candidate`
  const scored = spawnSync('python', ['-m', 'swebench.harness.run_evaluation', '--dataset_name',
    path.join(evidenceDirectory, 'one-instance.json'), '--predictions_path', prediction,
    '--instance_ids', official.instanceId, '--max_workers', '1', '--timeout', '600',
    '--cache_level', 'instance', '--clean', 'false', '--namespace', 'swebench', '--run_id', scoreRun],
    { cwd: evidenceDirectory, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 8 * 1024 * 1024 })
  await fs.writeFile(path.join(evidenceDirectory, 'candidate-score.log'), `${scored.stdout ?? ''}\n${scored.stderr ?? ''}`)
  if (scored.status !== 0) throw new Error(`candidate patch scoring failed: ${scored.stderr?.slice(-3000)}`)
  const report = JSON.parse(await fs.readFile(path.join(evidenceDirectory, `mini-dsh-poc-no-model.${scoreRun}.json`), 'utf8'))
  assert.deepEqual(report.resolved_ids, [official.instanceId])
  assert.equal(report.error_instances, 0)
  assert.equal(docker('ps', '-aq', '--filter', `name=${scoreRun}`), '')
  const evidence = { status: 'candidate-path-and-score-passed', instanceId: official.instanceId,
    baseCommit: official.baseCommit, imageDigest: image, providerRequests: 0, toolCalls: calls.map(call => call.name),
    hostWriteVisibleInContainer: true, containerWriteVisibleOnHost: true, network: 'none',
    mounts: ['/testbed'], privileged: false, readonlyRoot: true, pathEscapeRejected: true,
    sourceConsistency, scoreRunId: scoreRun,
    candidatePatchSha256: createHash('sha256').update(patch + '\n').digest('hex'),
    resolvedIds: report.resolved_ids, errorInstances: report.error_instances }
  await fs.writeFile(path.join(evidenceDirectory, 'candidate-evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence))
} finally {
  if (started) removeOwned(candidateName)
  if (exported) removeOwned(exportName)
}
