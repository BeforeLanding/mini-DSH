import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createV2Fixture, harnessV2Root } from '../scripts/eval-v2-fixtures.js'
import { runFixtureTask, scriptedAdapter } from '../scripts/eval-fixture.js'
import { evalPolicy } from '../scripts/eval-runner.js'

const runtimeRoot = process.env.MINI_DSH_V2_RUNTIME
const isolation = runtimeRoot ? { runtimeRoot, distro: 'Ubuntu' } : undefined

test('U01 has four independent behavior groups and rejects initial, two distinct bad probes, and protected-file edits', { skip: !isolation }, async () => {
  const fixture = await createV2Fixture('U01', isolation)
  try {
    const initial = await fixture.evaluate()
    assert.equal(initial.passed, false)
    await fixture.applyReference()
    const reference = await fixture.evaluate()
    assert.equal(reference.passed, true, JSON.stringify(reference.groups))
    assert.deepEqual(reference.groups.map(group => group.passed), [true, true, true, true])
    await fixture.applyCounterexample('negative-a')
    const alwaysFail = await fixture.evaluate()
    assert.equal(alwaysFail.passed, false)
    assert.equal(alwaysFail.groups[1]?.passed, false)
    await fixture.applyCounterexample('negative-b')
    const alwaysPass = await fixture.evaluate()
    assert.equal(alwaysPass.passed, false)
    assert.equal(alwaysPass.groups[0]?.passed, false)
    await fixture.applyReference()
    await fs.writeFile(path.join(fixture.workspace, 'docs', 'SPEC.md'), 'tampered')
    assert.equal((await fixture.evaluate()).passed, false)
  } finally { await fixture.close() }
})

test('the V2 fixture root has no hidden verifier in its public initial project', async () => {
  const initial = await fs.readdir(path.join(harnessV2Root, 'U01', 'initial'))
  assert.ok(!initial.includes('verify.mjs'))
  assert.ok(!initial.includes('reference'))
  assert.ok(!initial.includes('oracle'))
})

test('B01 rejects the shifted page and empty-input regression while retaining four contract groups', { skip: !isolation }, async () => {
  const fixture = await createV2Fixture('B01', isolation)
  try {
    const initial = await fixture.evaluate()
    assert.equal(initial.passed, false)
    await fixture.applyReference()
    const reference = await fixture.evaluate()
    assert.equal(reference.passed, true, JSON.stringify(reference.groups))
    await fixture.applyCounterexample('negative-a')
    assert.equal((await fixture.evaluate()).groups[0]?.passed, false)
    await fixture.applyCounterexample('negative-b')
    assert.equal((await fixture.evaluate()).groups[2]?.passed, false)
  } finally { await fixture.close() }
})

for (const id of ['F01', 'R01', 'T01'] as const) test(`${id} rejects its initial and two counterexample states`, { skip: !isolation }, async () => {
  const fixture = await createV2Fixture(id, isolation)
  try {
    const initial = await fixture.evaluate()
    assert.equal(initial.passed, false)
    if (id === 'R01') assert.equal(initial.groups[0]?.passed, true, 'refactor baseline behavior must already hold')
    await fixture.applyReference()
    const reference = await fixture.evaluate()
    assert.equal(reference.passed, true, JSON.stringify(reference.groups))
    assert.equal(reference.groups.length, 4)
    for (const negative of ['negative-a', 'negative-b'] as const) {
      await fixture.applyCounterexample(negative)
      const result = await fixture.evaluate()
      assert.equal(result.passed, false, `${id}/${negative}`)
      assert.ok(result.groups.some(group => !group.passed), `${id}/${negative} must fail a behavior group`)
    }
  } finally { await fixture.close() }
})

for (const id of ['U02', 'B02', 'F02', 'R02', 'T02'] as const) test(`${id} has a passing reference and two rejected counterexamples`, { skip: !isolation }, async () => {
  const fixture = await createV2Fixture(id, isolation)
  try {
    const initial = await fixture.evaluate()
    assert.equal(initial.passed, false, `${id} initial`)
    if (id === 'R02') assert.equal(initial.groups[1]?.passed, true, 'refactor baseline business behavior must already hold')
    await fixture.applyReference()
    const reference = await fixture.evaluate()
    assert.equal(reference.passed, true, `${id}: ${JSON.stringify(reference.groups)}`)
    assert.equal(reference.groups.length, 4)
    for (const negative of ['negative-a', 'negative-b'] as const) {
      await fixture.applyCounterexample(negative)
      const result = await fixture.evaluate()
      assert.equal(result.passed, false, `${id}/${negative}`)
      assert.ok(result.groups.some(group => !group.passed), `${id}/${negative} must fail a contract group`)
    }
  } finally { await fixture.close() }
})

test('new repro and edit tasks run through the actual isolated Harness with four group readings', { skip: !isolation }, async () => {
  assert.ok(isolation)
  const directory = await fs.mkdtemp(path.join(harnessV2Root, 'temporary-evidence-'))
  try {
    for (const id of ['U01', 'B01'] as const) {
      const outcome = await runFixtureTask(id, scriptedAdapter, { ...evalPolicy, contextWindowTokens: 1_000_000 },
        undefined, undefined, undefined, path.join(directory, id, 'snapshots'), isolation)
      assert.equal(outcome.status, 'completed', `${id}: ${outcome.error}`)
      assert.equal(outcome.accepted, true, `${id}: ${outcome.acceptance?.output}`)
      assert.equal(outcome.acceptance?.groups?.length, 4)
      assert.ok(outcome.episode?.stages[0]?.snapshotHash)
    }
  } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
})
