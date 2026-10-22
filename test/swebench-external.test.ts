import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildExternalRunArgs, externalLabels, renderExternalArgv, validateExternalCommand } from '../scripts/swebench/external-contract.js'
import {
  classifyExternalStatus, containsSecret, externalBudgetExceeded, externalDatasetRow, externalOverrideConfig, externalCost,
  readExternalPrediction, readExternalUsage, redactSecrets,
} from '../scripts/swebench/external.js'
import type { SwebenchInstance } from '../scripts/swebench/protocol.js'

const command = ['{python}', '-m', 'minisweagent.run.benchmarks.swebench', '--subset', '{dataset}', '--split', 'test',
  '--output', '{output}', '--workers', '1', '--redo-existing', '-c', '{upstream_config}', '-c', '{config}']

const instance: SwebenchInstance = {
  instance_id: 'demo__task-1', repo: 'demo/repo', base_commit: 'a'.repeat(40), version: '1.0',
  environment_setup_commit: 'b'.repeat(40), problem_statement: 'Fix the bug',
}
const prices = { currency: 'USD' as const, inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 2,
  capturedAt: '2026-10-21', source: 'test' }

test('the external command template is validated and rendered as a whole argv', () => {
  assert.deepEqual(validateExternalCommand(command), command)
  assert.throws(() => validateExternalCommand(['python', '-m', 'x']), /start with \{python\}/)
  assert.throws(() => validateExternalCommand(command.filter(argument => argument !== '--split')), /--split/)
  assert.throws(() => validateExternalCommand(command.map(argument => argument === 'test' ? 'dev' : argument)), /--split test/)
  assert.throws(() => validateExternalCommand(command.map(argument => argument === '1' ? '2' : argument)), /--workers 1/)
  assert.throws(() => validateExternalCommand([...command, '--filter', 'x']), /--filter/)
  assert.throws(() => validateExternalCommand([...command, '--model', 'x']), /--model/)
  assert.throws(() => validateExternalCommand(command.map(argument => argument === '{python}' ? 'x{python}' : argument)), /whole argv/)
  assert.throws(() => validateExternalCommand(command.map(argument => argument === '{dataset}' ? '{unknown}' : argument)), /unknown/)
  assert.throws(() => validateExternalCommand([...command, '-c', '{config}']), /duplicate|exactly two configs/)
  const rendered = renderExternalArgv(command, {
    python: '/venv/bin/python', dataset: '/tmp/dataset', config: '/tmp/config.episode.yaml', output: '/tmp/output',
    workspace: '/tmp/workspace', instance: instance.instance_id, image: 'sha256:x', model: 'deepseek/deepseek-flash',
    upstream_config: '/venv/swebench.yaml',
  })
  assert.equal(rendered[0], '/venv/bin/python')
  assert.equal(rendered[rendered.indexOf('--subset') + 1], '/tmp/dataset')
  assert.throws(() => renderExternalArgv(command, { python: '/venv/bin/python', dataset: '/tmp/d', config: '/tmp/c', output: '',
    workspace: '', instance: '', image: '', model: '', upstream_config: '/tmp/u' }), /missing external command value/)
  assert.throws(() => renderExternalArgv(command, { python: '/venv/bin/python', dataset: '/tmp/{x}', config: '/tmp/c', output: '/tmp/o',
    workspace: '', instance: '', image: '', model: '', upstream_config: '/tmp/u' }), /contains braces/)
})

test('the external container args match the candidate isolation profile and are labelled', () => {
  const labels = externalLabels({ batchId: 'batch 1', instanceId: 'demo__task-1', armId: 'baseline', index: 3 })
  assert.match(labels.episode, /^[A-Za-z0-9_.-]+$/)
  const args = buildExternalRunArgs({ workspace: '/tmp/workspace with space', uid: 1000, gid: 1000, labels })
  assert.deepEqual(args.slice(0, 8), ['--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only'])
  assert.ok(args.includes('--network') && args[args.indexOf('--network') + 1] === 'none')
  assert.ok(args.includes('--read-only'))
  assert.ok(args.includes('--user') && args[args.indexOf('--user') + 1] === '1000:1000')
  assert.ok(args.includes('--mount') && args[args.indexOf('--mount') + 1] === 'type=bind,src=/tmp/workspace with space,dst=/testbed')
  assert.ok(args.includes('--label') && args[args.indexOf('--label') + 1] === `mini-dsh.external.batch=${labels.batch}`)
  assert.throws(() => buildExternalRunArgs({ workspace: '/tmp/a,b', uid: 1000, gid: 1000, labels }), /comma|character/)
  assert.throws(() => buildExternalRunArgs({ workspace: 'relative', uid: 1000, gid: 1000, labels }), /absolute/)
  assert.throws(() => buildExternalRunArgs({ workspace: '/tmp/w', uid: -1, gid: 1000, labels }), /uid\/gid/)
})

test('the external dataset row contains only sanitized fields and the digest image', () => {
  const row = externalDatasetRow(instance, 'swebench/image@sha256:abc')
  assert.equal(row.image_name, 'swebench/image@sha256:abc')
  assert.equal(row.problem_statement, instance.problem_statement)
  for (const hidden of ['patch', 'test_patch', 'FAIL_TO_PASS', 'PASS_TO_PASS', 'hints_text']) assert.ok(!(hidden in row))
  assert.throws(() => externalDatasetRow({ ...instance, problem_statement: '' }, 'x'), /problem statement/)
})

test('the override config keeps the native prompt and matches the candidate sandbox', () => {
  const config = externalOverrideConfig({ model: 'deepseek/deepseek-flash', caps: {
    maxCostUsd: 0.5, maxModelRequests: 64, maxToolCalls: 128, wallClockMs: 900_000, maxOutputTokens: 16_384, maxTotalTokens: 416_667,
  }, paths: { episodeDirectory: '/tmp/episode', workspace: '/tmp/workspace', datasetDirectory: '/tmp/dataset',
    configPath: '/tmp/config.yaml', outputDirectory: '/tmp/output', upstreamConfigPath: '/venv/swebench.yaml' },
  uid: 1000, gid: 1001, labels: { batch: 'b', episode: 'e' } })
  const agent = config.agent as Record<string, unknown>
  const environment = config.environment as Record<string, unknown>
  const model = config.model as Record<string, unknown>
  assert.equal(agent.step_limit, 64)
  assert.equal(agent.cost_limit, 0.5)
  assert.equal(environment.cwd, '/testbed')
  assert.deepEqual(environment.interpreter, ['bash', '-lc'])
  assert.deepEqual(environment.forward_env, [])
  assert.ok((environment.run_args as string[]).includes('--network'))
  assert.equal((environment.env as Record<string, string>).BASH_ENV, '')
  assert.equal(model.model_name, 'deepseek/deepseek-flash')
  assert.equal((model.model_kwargs as Record<string, unknown>).max_tokens, 16_384)
  assert.deepEqual((model.model_kwargs as Record<string, unknown>).thinking, { type: 'enabled' })
  assert.ok(!JSON.stringify(config).includes('API_KEY'))
})

test('external usage reads provider usage from the trajectory and refuses to zero-fill gaps', () => {
  const reading = readExternalUsage({ info: { exit_status: 'Submitted', model_stats: { api_calls: 2, instance_cost: 0.01 } }, messages: [
    { role: 'assistant', extra: { response: { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } } }, actions: [{ command: 'ls' }] } },
    { role: 'assistant', extra: { response: { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, prompt_cache_hit_tokens: 10 } }, actions: [{ command: 'git diff' }] } },
    { role: 'exit', extra: { exit_status: 'Submitted', submission: 'diff' } },
  ] })
  assert.equal(reading.unknown, false)
  assert.equal(reading.inputTokens, 150)
  assert.equal(reading.outputTokens, 30)
  assert.equal(reading.cacheReadTokens, 50)
  assert.equal(reading.modelRequests, 2)
  assert.equal(reading.toolCalls, 2)
  assert.equal(reading.reportedCostUsd, 0.01)
  const cost = externalCost(reading, prices)
  assert.equal(cost.unknown, false)
  assert.ok((cost.costUsd ?? 0) > 0)

  const missing = readExternalUsage({ info: { model_stats: { api_calls: 1 } }, messages: [{ role: 'assistant', extra: { response: { usage: {} } } }] })
  assert.equal(missing.unknown, true)
  assert.match(missing.reasons.join(' '), /unreadable usage/)

  const cacheWrite = readExternalUsage({ info: { model_stats: { api_calls: 1 } }, messages: [{ role: 'assistant', extra: {
    response: { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cache_creation_input_tokens: 3 } } } }] })
  assert.equal(cacheWrite.unknown, true)

  const countMismatch = readExternalUsage({ info: { model_stats: { api_calls: 3 } }, messages: [{ role: 'assistant', extra: {
    response: { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } } }] })
  assert.equal(countMismatch.unknown, true)
  assert.match(countMismatch.reasons.join(' '), /api_calls=3/)
})

test('the external watchdog uses the same token budget as the candidate', () => {
  const caps = { maxCostUsd: 0.5, maxModelRequests: 64, maxToolCalls: 128, wallClockMs: 900_000, maxOutputTokens: 16_384, maxTotalTokens: 416_667 }
  const reading = readExternalUsage({ info: { model_stats: { api_calls: 1 } }, messages: [{ role: 'assistant', extra: {
    response: { usage: { prompt_tokens: 400_000, completion_tokens: 20_000, total_tokens: 420_000 } } } }] })
  assert.equal(externalBudgetExceeded(reading, caps, prices), 'token_budget')
  const small = readExternalUsage({ info: { model_stats: { api_calls: 1 } }, messages: [{ role: 'assistant', extra: {
    response: { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } } } }] })
  assert.equal(externalBudgetExceeded(small, caps, prices), null)
})

test('external prediction parsing distinguishes missing, empty, and malformed entries', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-external-pred-'))
  try {
    await fs.writeFile(path.join(directory, 'preds.json'), JSON.stringify({ [instance.instance_id]: {
      instance_id: instance.instance_id, model_name_or_path: 'deepseek/deepseek-flash', model_patch: 'diff --git a/x b/x\n' } }))
    const valid = await readExternalPrediction(directory, instance.instance_id)
    assert.equal(valid.prediction?.model_patch, 'diff --git a/x b/x\n')
    assert.equal(valid.reasons.length, 0)
    await fs.writeFile(path.join(directory, 'preds.json'), JSON.stringify({ [instance.instance_id]: {
      instance_id: instance.instance_id, model_name_or_path: 'm', model_patch: null } }))
    const empty = await readExternalPrediction(directory, instance.instance_id)
    assert.equal(empty.prediction?.model_patch, '')
    await fs.writeFile(path.join(directory, 'preds.json'), '{')
    assert.match((await readExternalPrediction(directory, instance.instance_id)).reasons.join(' '), /cannot read/)
    assert.match((await readExternalPrediction(path.join(directory, 'missing'), instance.instance_id)).reasons.join(' '), /cannot read/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('external status mapping is explicit and conservative', () => {
  assert.equal(classifyExternalStatus({ miniExitStatus: 'Submitted', exitCode: 0 }), 'completed')
  assert.equal(classifyExternalStatus({ miniExitStatus: 'LimitsExceeded', exitCode: 0 }), 'budget')
  assert.equal(classifyExternalStatus({ miniExitStatus: 'TimeExceeded', exitCode: 0 }), 'timeout')
  assert.equal(classifyExternalStatus({ miniExitStatus: 'ContextWindowExceededError', exitCode: 0 }), 'budget')
  assert.equal(classifyExternalStatus({ miniExitStatus: 'AuthenticationError', exitCode: 0 }), 'infrastructure')
  assert.equal(classifyExternalStatus({ miniExitStatus: 'RepeatedFormatError', exitCode: 0 }), 'failed')
  assert.equal(classifyExternalStatus({ miniExitStatus: 'Submitted', exitCode: 0, killedBy: 'cost' }), 'budget')
  assert.equal(classifyExternalStatus({ miniExitStatus: 'Submitted', exitCode: 0, timedOut: true }), 'timeout')
  assert.equal(classifyExternalStatus({ miniExitStatus: 'UnknownError', exitCode: 1 }), 'infrastructure')
})

test('secret redaction only touches full key values and never short strings', () => {
  const key = 'sk-test-1234567890'
  assert.equal(redactSecrets(`before ${key} after`, [key]), 'before [REDACTED] after')
  assert.equal(containsSecret(`before ${key}`, [key]), true)
  assert.equal(containsSecret('short', ['abc']), false)
})
