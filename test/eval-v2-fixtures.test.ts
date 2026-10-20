import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createV2Fixture, harnessV2Ids, harnessV2Root, publicFileScope } from '../scripts/eval-v2-fixtures.js'
import { runFixtureTask, scriptedAdapter } from '../scripts/eval-fixture.js'
import { evalPolicy } from '../scripts/eval-runner.js'

const runtimeRoot = process.env.MINI_DSH_V2_RUNTIME
const isolation = runtimeRoot ? { runtimeRoot } : undefined

test('every public V2 stage states the exact editable-file boundary', async () => {
  for (const id of harnessV2Ids) {
    const root = path.join(harnessV2Root, id)
    const meta = JSON.parse(await fs.readFile(path.join(root, 'meta.json'), 'utf8')) as { editable: string[]; artifact?: string }
    const expected = publicFileScope(meta)
    const single = path.join(root, 'TASK.md')
    const files = (await fs.stat(single).then(() => true, () => false)) ? [single] :
      (await fs.readdir(path.join(root, 'TASKS'))).filter(name => name.endsWith('.md')).map(name => path.join(root, 'TASKS', name))
    for (const file of files) assert.ok((await fs.readFile(file, 'utf8')).split(/\r?\n/).includes(expected), `${id}/${path.basename(file)}: scope differs from meta.json`)
  }
})

test('calibration projects have independent initial trees and no hidden verifier in candidate files', async () => {
  const digests = new Map<string, string>()
  for (const id of ['UC01', 'BC01', 'FC01', 'RC01', 'TC01'] as const) {
    const root = path.join(harnessV2Root, id, 'initial')
    const files: string[] = []
    const visit = async (directory: string) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) await visit(target)
        else files.push(target)
      }
    }
    await visit(root)
    assert.ok(!files.some(file => /^(?:verify\.mjs|oracle(?:[\\/]|$)|reference(?:[\\/]|$))/i.test(path.relative(root, file))))
    const hash = createHash('sha256')
    for (const file of files.sort()) hash.update(path.relative(root, file)).update(await fs.readFile(file))
    const digest = hash.digest('hex')
    assert.ok(![...digests.values()].includes(digest), `${id} duplicates a calibration project`)
    digests.set(id, digest)
    const formal = path.join(harnessV2Root, `${id[0]}04`, 'initial')
    const formalFiles: string[] = []
    const visitFormal = async (directory: string) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) await visitFormal(target)
        else formalFiles.push(target)
      }
    }
    await visitFormal(formal)
    const formalHash = createHash('sha256')
    for (const file of formalFiles.sort()) formalHash.update(path.relative(formal, file)).update(await fs.readFile(file))
    assert.notEqual(digest, formalHash.digest('hex'), `${id} duplicates a formal project`)
  }
})

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

for (const id of ['U03', 'B03', 'F03', 'R03', 'T03'] as const) test(`${id} information task has independently checked reference and counterexamples`, { skip: !isolation }, async () => {
  const fixture = await createV2Fixture(id, isolation)
  try {
    const initial = await fixture.evaluate()
    assert.equal(initial.passed, false, `${id} initial`)
    if (id === 'R03') {
      assert.equal(initial.groups[0]?.passed, true)
      assert.equal(initial.groups[1]?.passed, true)
      assert.equal(initial.groups[2]?.passed, false)
    }
    await fixture.applyReference()
    const reference = await fixture.evaluate()
    assert.equal(reference.passed, true, `${id}: ${JSON.stringify(reference.groups)}`)
    for (const negative of ['negative-a', 'negative-b'] as const) {
      await fixture.applyCounterexample(negative)
      const result = await fixture.evaluate()
      assert.equal(result.passed, false, `${id}/${negative}`)
      assert.ok(result.groups.some(group => !group.passed), `${id}/${negative} must fail a contract group`)
    }
  } finally { await fixture.close() }
})

test('information tasks ship relevant searchable diagnostics across a multi-module project', async () => {
  for (const id of ['U03', 'B03', 'F03', 'R03', 'T03'] as const) {
    const source = path.join(harnessV2Root, id, 'initial', 'src')
    const visit = async (directory: string): Promise<number> => {
      let count = 0
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) count += entry.isDirectory() ? await visit(path.join(directory, entry.name)) : entry.name.endsWith('.mjs') ? 1 : 0
      return count
    }
    assert.ok((await visit(source)) >= 12, `${id} must have at least twelve source modules`)
    const diagnostic = path.join(harnessV2Root, id, 'initial', id === 'R03' ? 'cases/regressions.ndjson' : `logs/${id === 'B03' ? 'batches' : id === 'F03' ? 'imports' : 'incident'}.ndjson`)
    const content = await fs.readFile(diagnostic, 'utf8')
    assert.ok(Buffer.byteLength(content) > 16 * 1024, `${id} must have a realistic bounded-output opportunity`)
    assert.ok(content.trim().split(/\r?\n/).every(line => typeof JSON.parse(line) === 'object'))
  }
})

test('U04 has four advancing reference stages and a final rule that revokes the temporary grant', { skip: !isolation }, async () => {
  const fixture = await createV2Fixture('U04', isolation)
  try {
    assert.equal(fixture.tasks.length, 4)
    for (let stage = 1; stage <= 4; stage += 1) {
      await fixture.applyStageReference(stage)
      assert.equal(await fixture.verifyStageReference(stage), true, `stage ${stage}`)
    }
  } finally { await fixture.close() }
  const final = await createV2Fixture('U04', isolation)
  try {
    assert.equal((await final.evaluate()).passed, false)
    await final.applyReference()
    assert.equal((await final.evaluate()).passed, true)
    for (const negative of ['negative-a', 'negative-b'] as const) {
      await final.applyCounterexample(negative)
      assert.equal((await final.evaluate()).passed, false)
    }
  } finally { await final.close() }
})

for (const id of ['B04', 'F04', 'R04', 'T04'] as const) test(`${id} has four checked stages and a final four-group contract`, { skip: !isolation }, async () => {
  const staged = await createV2Fixture(id, isolation)
  try {
    assert.equal(staged.tasks.length, 4)
    for (let stage = 1; stage <= 4; stage += 1) {
      await staged.applyStageReference(stage)
      assert.equal(await staged.verifyStageReference(stage), true, `${id} stage ${stage}`)
    }
  } finally { await staged.close() }
  const final = await createV2Fixture(id, isolation)
  try {
    const initial = await final.evaluate()
    assert.equal(initial.passed, false)
    if (id === 'R04') assert.equal(initial.groups[0]?.passed, true, 'refactor starts with correct business behavior')
    await final.applyReference()
    const reference = await final.evaluate()
    assert.equal(reference.passed, true, `${id}: ${JSON.stringify(reference.groups)}`)
    for (const negative of ['negative-a', 'negative-b'] as const) {
      await final.applyCounterexample(negative)
      const result = await final.evaluate()
      assert.equal(result.passed, false, `${id}/${negative}`)
      assert.ok(result.groups.some(group => !group.passed))
    }
  } finally { await final.close() }
})

for (const id of ['BC01', 'FC01', 'TC01'] as const) test(`${id} calibration root rejects initial and counterexample states`, { skip: !isolation }, async () => {
  const fixture = await createV2Fixture(id, isolation)
  try {
    assert.equal(fixture.tasks.length, 1)
    assert.equal((await fixture.evaluate()).passed, false, `${id} initial`)
    await fixture.applyReference()
    const reference = await fixture.evaluate()
    assert.equal(reference.passed, true, `${id}: ${JSON.stringify(reference.groups)} ${reference.output}`)
    assert.equal(reference.groups.length, 4)
    for (const negative of ['negative-a', 'negative-b'] as const) {
      await fixture.applyCounterexample(negative)
      const result = await fixture.evaluate()
      assert.equal(result.passed, false, `${id}/${negative}`)
      assert.ok(result.groups.some(group => !group.passed), `${id}/${negative} must fail a contract group`)
    }
  } finally { await fixture.close() }
})

for (const id of ['UC01', 'RC01'] as const) test(`${id} calibration root has four verified stages and final rejection cases`, { skip: !isolation }, async () => {
  const staged = await createV2Fixture(id, isolation)
  try {
    assert.equal(staged.tasks.length, 4)
    for (let stage = 1; stage <= 4; stage += 1) {
      await staged.applyStageReference(stage)
      assert.equal(await staged.verifyStageReference(stage), true, `${id} stage ${stage}`)
    }
  } finally { await staged.close() }
  const final = await createV2Fixture(id, isolation)
  try {
    const initial = await final.evaluate()
    assert.equal(initial.passed, false)
    if (id === 'RC01') assert.equal(initial.groups[0]?.passed, true, 'refactor begins with correct scheduling')
    await final.applyReference()
    const reference = await final.evaluate()
    assert.equal(reference.passed, true, `${id}: ${JSON.stringify(reference.groups)} ${reference.output}`)
    for (const negative of ['negative-a', 'negative-b'] as const) {
      await final.applyCounterexample(negative)
      const result = await final.evaluate()
      assert.equal(result.passed, false, `${id}/${negative}`)
    }
  } finally { await final.close() }
})

test('a four-stage V2 task runs through one isolated Harness episode with four durable snapshots', { skip: !isolation }, async () => {
  assert.ok(isolation)
  const directory = await fs.mkdtemp(path.join(harnessV2Root, 'temporary-stage-evidence-'))
  try {
    const outcome = await runFixtureTask('B04', scriptedAdapter, { ...evalPolicy, maxModelRequests: 64, maxToolCalls: 128, maxTotalTokens: 2_000_000, maxActiveDurationMs: 600_000, contextWindowTokens: 1_000_000 },
      undefined, undefined, undefined, path.join(directory, 'snapshots'), isolation)
    assert.equal(outcome.status, 'completed', outcome.error)
    assert.equal(outcome.episode?.stages.length, 4)
    assert.equal(outcome.episode?.stages.every(stage => Boolean(stage.snapshotHash)), true)
    assert.equal(outcome.accepted, true, outcome.acceptance?.output)
  } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
})
