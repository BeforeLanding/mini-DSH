import test from 'node:test'
import assert from 'node:assert/strict'
import { pathsOverlap, validatePlan } from '../src/orchestration/plan.js'
import type { PlanInput } from '../src/orchestration/contracts.js'

const allow = () => ({ action: 'allow' as const })
const subtask = (id: string, writeSet: string[], dependsOn?: string[]): PlanInput['subtasks'][number] => ({
  id, title: `task ${id}`, objective: `implement ${id}`, writeSet,
  ...(dependsOn ? { dependsOn } : {}), acceptance: { commands: ['node --test'] },
})
const plan = (subtasks: PlanInput['subtasks']): PlanInput => ({ version: 1, rationale: 'split by file', subtasks })

test('a DAG plan is layered into waves and marked parallel when a wave has independent subtasks', () => {
  const result = validatePlan(plan([
    subtask('st-1', ['src/a.mjs']),
    subtask('st-2', ['src/b.mjs']),
    subtask('st-3', ['src/index.mjs'], ['st-1', 'st-2']),
  ]), { maxSubtasks: 4, inspectCommand: allow })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.decision.waves, [['st-1', 'st-2'], ['st-3']])
  assert.equal(result.decision.mode, 'parallel')
})

test('dependency depth, not declaration order, decides the wave', () => {
  const result = validatePlan(plan([
    subtask('st-1', ['a.txt']),
    subtask('st-3', ['c.txt'], ['st-2']),
    subtask('st-2', ['b.txt'], ['st-1']),
  ]), { inspectCommand: allow })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.decision.waves, [['st-1'], ['st-2'], ['st-3']])
})

test('cycles, same-wave write-set intersections and protected paths are rejected', () => {
  const cycle = validatePlan(plan([subtask('st-1', ['a.txt'], ['st-2']), subtask('st-2', ['b.txt'], ['st-1'])]), { inspectCommand: allow })
  assert.equal(cycle.ok, false)
  if (!cycle.ok) assert.match(cycle.errors.join('\n'), /cycle/)
  const duplicate = validatePlan(plan([subtask('st-1', ['src/a.txt', 'src/a.txt'])]), { inspectCommand: allow })
  assert.equal(duplicate.ok, false)
  if (!duplicate.ok) assert.match(duplicate.errors.join('\n'), /duplicate/)
  const overlap = validatePlan(plan([subtask('st-1', ['src/']), subtask('st-2', ['src/a.txt'])]), { inspectCommand: allow })
  assert.equal(overlap.ok, false)
  if (!overlap.ok) assert.match(overlap.errors.join('\n'), /overlapping write sets/)
  const sameFile = validatePlan(plan([subtask('st-1', ['src/a.txt']), subtask('st-2', ['src/a.txt'])]), { inspectCommand: allow })
  assert.equal(sameFile.ok, false)
  const protectedPath = validatePlan(plan([subtask('st-1', ['.git/config'])]), { inspectCommand: allow })
  assert.equal(protectedPath.ok, false)
  if (!protectedPath.ok) assert.match(protectedPath.errors.join('\n'), /protected path/)
})

test('cross-wave write-set overlap is allowed because later waves see the integrated result', () => {
  const result = validatePlan(plan([
    subtask('st-1', ['src/']),
    subtask('st-2', ['src/a.txt'], ['st-1']),
  ]), { inspectCommand: allow })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.decision.waves, [['st-1'], ['st-2']])
})

test('acceptance commands must pass the workspace command gate', () => {
  const denied = validatePlan(plan([{ ...subtask('st-1', ['a.txt']), acceptance: { commands: ['sudo rm -rf /'] } }]), {
    inspectCommand: () => ({ action: 'deny', reason: 'sudo/su is blocked' }),
  })
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.match(denied.errors.join('\n'), /command gate/)
  const real = validatePlan(plan([subtask('st-1', ['a.txt'])]), { workspace: process.cwd() })
  assert.equal(real.ok, true)
})

test('mode selection is explicit and parallel can be forced or refused', () => {
  const singleOnly = plan([subtask('st-1', ['a.txt'])])
  const auto = validatePlan(singleOnly, { inspectCommand: allow })
  assert.equal(auto.ok, true)
  if (auto.ok) assert.equal(auto.decision.mode, 'single')
  const forcedSingle = validatePlan(plan([subtask('st-1', ['a.txt']), subtask('st-2', ['b.txt'])]), { mode: 'single', inspectCommand: allow })
  assert.equal(forcedSingle.ok, true)
  if (forcedSingle.ok) assert.equal(forcedSingle.decision.mode, 'single')
  const refusedParallel = validatePlan(singleOnly, { mode: 'parallel', inspectCommand: allow })
  assert.equal(refusedParallel.ok, false)
  if (!refusedParallel.ok) assert.match(refusedParallel.errors.join('\n'), /parallel mode requires/)
})

test('maxSubtasks and structural errors are bounded', () => {
  const tooMany = validatePlan(plan([subtask('st-1', ['a']), subtask('st-2', ['b'])]), { maxSubtasks: 1, inspectCommand: allow })
  assert.equal(tooMany.ok, false)
  if (!tooMany.ok) assert.match(tooMany.errors.join('\n'), /maxSubtasks/)
  const structural = validatePlan({ version: 1, rationale: '', subtasks: [] }, { inspectCommand: allow })
  assert.equal(structural.ok, false)
  if (!structural.ok) assert.match(structural.errors.join('\n'), /subtasks/)
  assert.equal(pathsOverlap('src/', 'src/a.txt'), true)
  assert.equal(pathsOverlap('src/a.txt', 'src/a'), false)
  assert.equal(pathsOverlap('.git', '.git/'), true)
})
