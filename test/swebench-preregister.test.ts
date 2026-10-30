import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const script = path.resolve('dist/scripts/swebench/preregister.js')

async function run(args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 120_000 })
  if (result.status !== 0) throw new Error(`preregister failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

test('preregistration separates development and formal batches, sanitizes gold, and freezes only when complete', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-swebench-preregister-'))
  try {
    const rows = []
    for (let repo = 0; repo < 3; repo++) {
      for (let index = 0; index < 20; index++) {
        rows.push({ instance_id: `repo${repo}__task-${index + 1}`, repo: `org/repo${repo}`, base_commit: `base-${repo}-${index}`,
          problem_statement: `Problem ${repo}/${index}`, patch: 'gold patch', test_patch: 'hidden tests' })
      }
    }
    const dataset = path.join(directory, 'verified.json')
    await fs.writeFile(dataset, JSON.stringify(rows))
    const prices = path.join(directory, 'prices.json')
    await fs.writeFile(prices, JSON.stringify({ currency: 'USD', inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 2, capturedAt: '2026-10-20', source: 'official price page' }))
    const baselineCommand = JSON.stringify(['{python}', '-m', 'minisweagent.run.benchmarks.swebench', '--subset', '{dataset}',
      '--split', 'test', '--output', '{output}', '--workers', '1', '--redo-existing', '-c', '{upstream_config}', '-c', '{config}'])
    const common = ['--dataset', dataset, '--tasks', '50', '--seed', '42', '--dataset-revision', 'c104f840', '--harness-commit', '3f01bd6',
      '--arms', '4', '--model', 'test-model', '--context-window-tokens', '1000000', '--prices', prices,
      '--baseline-commit', 'a83fcae82d2a08f0ee0c688f9d137b3566c097f8', '--baseline-command', baselineCommand,
      '--baseline-version', '2.4.6', '--baseline-upstream-config-sha256', 'a'.repeat(64), '--baseline-install-sha256', 'b'.repeat(64)]
    const draftPath = path.join(directory, 'draft.json')
    await run([...common, '--out', draftPath])
    const draft = JSON.parse(await fs.readFile(draftPath, 'utf8'))
    assert.equal(draft.kind, 'swebench-run-manifest')
    assert.equal(draft.freezeStatus, 'draft')
    assert.ok(draft.missing.some((item: string) => /image digests/.test(item)))
    assert.equal(draft.development.instances.length, 5)
    assert.equal(draft.formal.instances.length, 50)
    const developmentIds = new Set(draft.development.instances.map((item: { instance_id: string }) => item.instance_id))
    assert.ok(draft.formal.instances.every((item: { instance_id: string }) => !developmentIds.has(item.instance_id)))
    assert.equal(draft.development.schedule.length, 5 * 4)
    assert.equal(draft.formal.schedule.length, 50 * 4)
    assert.ok(draft.formal.instances.every((item: Record<string, unknown>) => !('patch' in item) && !('test_patch' in item)))
    assert.ok(draft.formal.instances.every((item: Record<string, unknown>) => typeof item.problem_statement === 'string'))
    assert.equal(draft.paidRequests, 0)

    const digests: Record<string, string> = {}
    for (const item of [...draft.development.instances, ...draft.formal.instances]) digests[item.instance_id] = 'sha256:test'
    const digestsPath = path.join(directory, 'digests.json')
    await fs.writeFile(digestsPath, JSON.stringify(digests))
    const frozenPath = path.join(directory, 'frozen.json')
    await run([...common, '--image-digests', digestsPath, '--finalize', '--out', frozenPath])
    const frozen = JSON.parse(await fs.readFile(frozenPath, 'utf8'))
    assert.equal(frozen.freezeStatus, 'frozen')
    assert.deepEqual(frozen.missing, [])
    assert.deepEqual(frozen.formal.instances.map((item: { instance_id: string }) => item.instance_id), draft.formal.instances.map((item: { instance_id: string }) => item.instance_id))
    const devDigests = Object.fromEntries(draft.development.instances.map((item: { instance_id: string }) => [item.instance_id, 'sha256:test']))
    await fs.writeFile(digestsPath, JSON.stringify(devDigests))
    const devOnlyPath = path.join(directory, 'development-only.json')
    const devOutput = await run([...common, '--scope', 'development', '--batch-cap-usd', '17', '--image-digests', digestsPath, '--finalize', '--out', devOnlyPath])
    assert.match(devOutput, /batch hard cap \$17.00, scope development/)
    const devOnly = JSON.parse(await fs.readFile(devOnlyPath, 'utf8'))
    assert.equal(devOnly.freezeStatus, 'frozen')
    assert.equal(devOnly.executionScope, 'development')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
