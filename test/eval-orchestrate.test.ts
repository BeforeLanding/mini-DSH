import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assembleRunMatrix, evalArms, evalRepeats, evalTaskBudget, parseEvalArgs, providerSentinel,
  validateOfflineBatch, validateRunMatrix,
} from '../scripts/eval-orchestrate.js'
import { orchestrationFixtureIds } from '../scripts/orchestration-fixtures.js'

test('the four-arm matrix is complete and fair before any model call', () => {
  const specs = assembleRunMatrix({ model: 'scripted/none' })
  assert.equal(specs.length, orchestrationFixtureIds.length * evalArms.length * evalRepeats)
  const validation = validateRunMatrix(specs)
  assert.equal(validation.passed, true, validation.errors.join('; '))
  for (const spec of specs) assert.deepEqual(spec.budget, evalTaskBudget)
  const r = specs.find(spec => spec.taskId === 'parallel-composite' && spec.arm === 'R')!
  const serial = specs.find(spec => spec.taskId === 'parallel-composite' && spec.arm === 'R-serial')!
  assert.equal(r.execution.maxWorkers, 2)
  assert.equal(serial.execution.maxWorkers, 1)
  assert.deepEqual(r.plan, serial.plan)
  assert.equal(specs.find(spec => spec.arm === 'D')!.execution.delegation, 'read-only')
  assert.equal(specs.find(spec => spec.arm === 'S')!.execution.delegation, 'off')
})

test('the matrix gate rejects changed budgets and worker counts', () => {
  const specs = assembleRunMatrix()
  const tamperedBudget = structuredClone(specs)
  tamperedBudget.find(spec => spec.arm === 'D')!.budget.maxTotalTokens += 1
  assert.equal(validateRunMatrix(tamperedBudget).passed, false)
  const tamperedWorkers = structuredClone(specs)
  tamperedWorkers.find(spec => spec.arm === 'R-serial')!.execution.maxWorkers = 2
  assert.equal(validateRunMatrix(tamperedWorkers).passed, false)
  const missingArm = specs.filter(spec => spec.arm !== 'D')
  assert.equal(validateRunMatrix(missingArm).passed, false)
})

test('offline validation runs the verifier positive/negative cases with zero provider requests', async () => {
  const report = await validateOfflineBatch({ model: 'scripted/none' })
  assert.equal(report.passed, true, report.matrix.errors.join('; '))
  assert.equal(report.providerRequests, 0)
  assert.equal(report.runs, orchestrationFixtureIds.length * evalArms.length * evalRepeats)
  assert.ok(report.tasks.every(task => task.initialRejected && task.referenceAccepted))
  assert.equal(report.paidBatch.executed, false)
  assert.equal(report.omitted[0]?.id, 'D′')
})

test('the offline executor refuses paid execution and needs exactly one mode', () => {
  assert.deepEqual(parseEvalArgs(['--validate-only', '--model', 'scripted/test'], {}), { mode: 'validate-only', model: 'scripted/test' })
  assert.throws(() => parseEvalArgs([], {}), /exactly one of --validate-only, --plan-only or --rehearse/)
  assert.throws(() => parseEvalArgs(['--execute'], {}), /refusing --execute/)
  assert.throws(() => parseEvalArgs(['--validate-only', '--bogus'], {}), /unknown argument/)
  assert.deepEqual(parseEvalArgs(['--validate-only'], { MINI_DSH_EVAL_MODEL: 'env/model' }), { mode: 'validate-only', model: 'env/model' })
})

test('the provider sentinel fails loudly if anything calls chat during assembly', async () => {
  const sentinel = providerSentinel()
  await assert.rejects(sentinel.adapter.chat({ messages: [] } as never), /during --validate-only/)
  assert.equal(sentinel.requests, 1)
})
