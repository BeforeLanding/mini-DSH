import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { buildProvenance, fixtureDigest, fixtureProvenance, gitProvenance, samplingProvenance } from '../scripts/eval-provenance.js'
import { createDeepSeekAdapter } from '../src/models/deepseek.js'

test('a fixture digest covers content only, not line endings or listing order', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-digest-'))
  try {
    const fixture = path.join(root, 'boundary')
    await fs.mkdir(path.join(fixture, 'src'), { recursive: true })
    await fs.writeFile(path.join(fixture, 'TASK.md'), 'task\n')
    await fs.writeFile(path.join(fixture, 'src', 'index.mjs'), 'export const a = 1\n')
    const lf = await fixtureDigest('boundary', root)
    assert.match(lf, /^[0-9a-f]{64}$/)
    // 同一份内容在 Windows 上会被检出成 CRLF：摘要必须与 LF 时相同，否则同一份 fixture 在不同平台得到
    // 不同指纹，指纹就不再只反映内容（与 estimation-corpus 的语料摘要同一条理由）。
    await fs.writeFile(path.join(fixture, 'src', 'index.mjs'), 'export const a = 1\r\n')
    assert.equal(await fixtureDigest('boundary', root), lf)
    await fs.writeFile(path.join(fixture, 'src', 'index.mjs'), 'export const a = 2\n')
    assert.notEqual(await fixtureDigest('boundary', root), lf)
    // 新增文件同样要改变摘要：否则「摘要覆盖了 fixture 的全部字节」这句话是假的。
    await fs.writeFile(path.join(fixture, 'src', 'extra.mjs'), '\n')
    assert.notEqual(await fixtureDigest('boundary', root), lf)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('the aggregate digest is order-independent and still names which fixture changed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-set-'))
  try {
    for (const [id, content] of [['boundary', 'a'], ['merge', 'b']] as const) {
      await fs.mkdir(path.join(root, id))
      await fs.writeFile(path.join(root, id, 'TASK.md'), `${content}\n`)
    }
    const forward = await fixtureProvenance(['boundary', 'merge'], root)
    const reversed = await fixtureProvenance(['merge', 'boundary'], root)
    // 同一组 fixture 换个顺序必须得到同一个摘要，否则「对照 A 的两臂拿到相同任务集」无法由摘要核对。
    assert.equal(reversed.sha256, forward.sha256)
    assert.deepEqual(forward.ids, ['boundary', 'merge'])
    assert.deepEqual(reversed.ids, ['merge', 'boundary'])
    assert.equal(forward.perFixture.boundary, await fixtureDigest('boundary', root))
    // 改其中一个 fixture 必须让聚合摘要变化，并能在 perFixture 里点名是哪一个，而不是只说「这组不一样了」。
    await fs.writeFile(path.join(root, 'merge', 'TASK.md'), 'changed\n')
    const changed = await fixtureProvenance(['boundary', 'merge'], root)
    assert.notEqual(changed.sha256, forward.sha256)
    assert.equal(changed.perFixture.boundary, forward.perFixture.boundary)
    assert.notEqual(changed.perFixture.merge, forward.perFixture.merge)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('git provenance reports the revision, flags a dirty tree and degrades without throwing', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-git-'))
  const git = promisify(execFile)
  try {
    // 不是仓库时给出理由而不是抛错：评测不该因为环境里没有 git 就跑不起来。但「不知道出处」与
    // 「出处是这个提交」必须在报告里可区分，所以理由必须落在 error 上，不能静默留空。
    assert.deepEqual(gitProvenance(temp), { sha: null, dirty: null, error: 'not a git checkout (or git unavailable): this evidence cannot be tied to a revision' })
    await git('git', ['init', '--quiet'], { cwd: temp, windowsHide: true })
    await fs.writeFile(path.join(temp, 'tracked.txt'), 'value\n')
    await git('git', ['add', 'tracked.txt'], { cwd: temp, windowsHide: true })
    await git('git', ['-c', 'user.email=eval@example.com', '-c', 'user.name=eval', 'commit', '--quiet', '-m', 'init'], { cwd: temp, windowsHide: true })
    const clean = gitProvenance(temp)
    assert.match(clean.sha!, /^[0-9a-f]{40}$/)
    assert.equal(clean.dirty, false)
    assert.equal(clean.error, undefined)
    // 工作区脏时 HEAD 不代表被执行的代码：不拒绝开跑，但报告必须说出来。
    await fs.writeFile(path.join(temp, 'untracked.txt'), 'new\n')
    assert.deepEqual(gitProvenance(temp), { sha: clean.sha, dirty: true })
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
})

test('the sampling declaration matches the request body the adapter actually sends', async () => {
  const event = (data: unknown) => `data: ${JSON.stringify(data)}\n`
  let payload: Record<string, unknown> = {}
  const adapter = createDeepSeekAdapter({ apiKey: 'mock', fetch: async (_url, options) => {
    payload = JSON.parse(String(options?.body)) as Record<string, unknown>
    return new Response(event({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n')
  } })
  await adapter.chat({ model: 'mock', messages: [{ role: 'user', content: 'hi' }] })
  const declared = samplingProvenance()
  // 声明说 temperature/seed 不发送，就必须真的不在请求体里：适配器一旦开始发送采样参数，这条会红，
  // 从而逼着报告同步——而不是让报告继续宣称「不可复现」而实际上解码已经被固定。
  assert.equal(declared.temperature, null)
  assert.equal(declared.seed, null)
  assert.equal('temperature' in payload, false)
  assert.equal('seed' in payload, false)
  // thinking 是每次都发的，且它的默认值由环境变量决定，因此也必须与声明一致。
  assert.deepEqual(payload.thinking, { type: declared.thinking })
  assert.equal(samplingProvenance({ DEEPSEEK_THINKING: 'disabled' }).thinking, 'disabled')
})

test('the assembled provenance ties a run to its revision, fixtures and runtime', async () => {
  const repository = fileURLToPath(new URL('../../', import.meta.url))
  const provenance = await buildProvenance(repository, ['boundary', 'merge'], '2026-10-14T00:00:00.000Z')
  assert.equal(provenance.startedAt, '2026-10-14T00:00:00.000Z')
  assert.equal(provenance.runtime.node, process.version)
  assert.equal(provenance.sampling.temperature, null)
  assert.deepEqual(provenance.fixtures.ids, ['boundary', 'merge'])
  // 用 fixtureDigest 的默认目录复核聚合结果：探针与实际报告必须走同一个坐标，否则指纹对不上同一批文件。
  assert.equal(provenance.fixtures.perFixture.boundary, await fixtureDigest('boundary'))
  assert.match(provenance.fixtures.sha256, /^[0-9a-f]{64}$/)
  if (provenance.git.sha === null) assert.ok(provenance.git.error, 'a missing revision must come with a reason')
  else assert.match(provenance.git.sha, /^[0-9a-f]{40}$/)
})
