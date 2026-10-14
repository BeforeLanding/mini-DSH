import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { stableText } from '../src/core/system-prompt-runtime.js'
import * as systemPrompt from '../src/plugins/system-prompt.js'
import * as tools from '../src/plugins/tools.js'
import * as runtimeContext from '../src/plugins/runtime-context.js'
import * as projectContext from '../src/plugins/project-context.js'
import * as sandbox from '../src/plugins/sandbox.js'
import { runFixtureTask, scriptedAdapter, type Fixture, type FixtureAdapter } from '../scripts/eval-fixture.js'
import type { ChatRequest, ChatResponse } from '../src/core/contracts.js'

// 前缀缓存安全这一维要成立，必须同时钉住两件事：易变段落**确实每轮都在变**（否则因子空转，后面「关掉
// 提示优化掉 0 分」是假零），以及 layout: 'frozen' 能把首帧定住。前者是这组用例里最要紧的一条。
// 「每轮都在变」用 mock.timers 推进时钟来量，而不是等真实毫秒过去——否则断言会随机器快慢漂移。
const EPOCH = Date.parse('2026-01-01T00:00:00.000Z')

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-stable-'))
  return { workspace: directory, async close() {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
    await fs.rm(directory, { recursive: true, force: true })
  } }
}

test('stableText renders once and retries a failed render instead of pinning the failure', async () => {
  let renders = 0
  const stable = stableText(() => `value-${++renders}`)
  assert.equal(await stable(), 'value-1')
  assert.equal(await stable(), 'value-1')
  assert.equal(renders, 1, '第二次必须命中缓存，否则冻结这个动作等于没做')
  // 空串是合法渲染结果：把它当成「还没渲染过」会让每次装配都重算，冻结在最坏的情况下静默失效。
  let empties = 0
  const empty = stableText(() => { empties++; return '' })
  assert.equal(await empty(), '')
  assert.equal(await empty(), '')
  assert.equal(empties, 1)
  // 失败不缓存：下一轮重试，而不是把一个会话永久钉在失败状态上。
  let attempts = 0
  const flaky = stableText(() => { if (++attempts === 1) throw new Error('transient'); return 'recovered' })
  await assert.rejects(flaky(), /transient/)
  assert.equal(await flaky(), 'recovered')
  assert.equal(attempts, 2)
})

test('the runtime environment section is re-rendered every turn by default and pinned by layout frozen', async () => {
  mock.timers.enable({ apis: ['Date'], now: EPOCH })
  const live = new Context(), frozen = new Context()
  try {
    await live.plugin(systemPrompt)
    await live.plugin(runtimeContext, { workspace: 'synthetic-workspace' })
    const liveFirst = await live.systemPrompt.assemble()
    assert.match(liveFirst, /Time: 2026-01-01T00:00:00.000Z/)
    mock.timers.tick(1_500)
    const liveSecond = await live.systemPrompt.assemble()
    assert.match(liveSecond, /Time: 2026-01-01T00:00:01.500Z/)
    assert.notEqual(liveSecond, liveFirst, '缺省布局下系统提示每轮都变——前缀缓存从 Time 那一行起全部作废')

    // 把时钟拨回同一刻再渲染冻结臂：两臂在同一时刻的首帧必须逐字相同，否则这一维测到的就是「换了一段
    // 提示文本」而不是「同一段文本稳不稳」。
    mock.timers.reset()
    mock.timers.enable({ apis: ['Date'], now: EPOCH })
    await frozen.plugin(systemPrompt)
    await frozen.plugin(runtimeContext, { workspace: 'synthetic-workspace', layout: 'frozen' })
    const frozenFirst = await frozen.systemPrompt.assemble()
    assert.equal(frozenFirst, liveFirst)
    mock.timers.tick(1_500)
    assert.equal(await frozen.systemPrompt.assemble(), frozenFirst)
  } finally {
    mock.timers.reset()
    await live.fiber.dispose()
    await frozen.fiber.dispose()
  }
})

test('the project context section follows the workspace by default and pins it under frozen while the tool stays live', async () => {
  const f = await workspace(), live = new Context(), frozen = new Context()
  try {
    await fs.writeFile(path.join(f.workspace, 'AGENTS.md'), 'rule-one')
    for (const root of [live, frozen]) {
      await root.plugin(systemPrompt); await root.plugin(tools)
      await root.plugin(sandbox, { workspace: f.workspace })
    }
    await live.plugin(projectContext)
    await frozen.plugin(projectContext, { layout: 'frozen' })
    assert.match(await live.systemPrompt.assemble(), /rule-one/)
    assert.match(await frozen.systemPrompt.assemble(), /rule-one/)

    await fs.writeFile(path.join(f.workspace, 'AGENTS.md'), 'rule-two')
    assert.match(await live.systemPrompt.assemble(), /rule-two/)
    const pinned = await frozen.systemPrompt.assemble()
    assert.match(pinned, /rule-one/)
    assert.doesNotMatch(pinned, /rule-two/)
    // 冻结只作用于系统提示这一份：查询工具照旧实时读盘，否则冻掉的就不只是前缀稳定性，而是实时读的能力。
    const queried = await frozen.tools.execute('project_context')
    assert.equal(queried.isError, false)
    assert.equal((queried.value as { rules: { content: string }[] }).rules[0]?.content, 'rule-two')
  } finally {
    await live.fiber.dispose()
    await frozen.fiber.dispose()
    await f.close()
  }
})

test('an unknown layout fails before either plugin registers a prompt entry', async () => {
  const f = await workspace(), plain = new Context(), withSandbox = new Context()
  try {
    await plain.plugin(systemPrompt)
    await assert.rejects(async () => { await plain.plugin(runtimeContext, { layout: 'stale' as 'frozen' }) }, /layout must be live or frozen/)
    assert.deepEqual(plain.systemPrompt.inspect(), { sections: [], contexts: [] })

    await withSandbox.plugin(systemPrompt); await withSandbox.plugin(tools)
    await withSandbox.plugin(sandbox, { workspace: f.workspace })
    await assert.rejects(async () => { await withSandbox.plugin(projectContext, { layout: 'stale' as 'frozen' }) }, /project context layout must be live or frozen/)
    assert.deepEqual(withSandbox.systemPrompt.inspect().contexts, [])
  } finally {
    await plain.fiber.dispose()
    await withSandbox.fiber.dispose()
    await f.close()
  }
})

// 对照 C 的因子到底触没触发，只能由**模型真的收到的那串系统提示**来回答：装了什么插件、段落有没有进
// 去、每轮稳不稳。这条用例走的是 runFixtureTask 本身，因此它同时钉住了「不传模式时评测路径一字不变」
// 这条既有各阶段的基线前提。
test('the eval assembly loads the volatile prompt sections only when asked, and pins them when asked', { timeout: 60_000 }, async () => {
  const capture = (fixture: Fixture) => {
    const inner = scriptedAdapter(fixture), systems: string[] = []
    const adapter: FixtureAdapter = {
      ...inner,
      chat: async (request: ChatRequest): Promise<ChatResponse> => {
        systems.push(request.system ?? '')
        // 时钟由这个用例推进，而不是等真实毫秒过掉：live 与 frozen 的差别因此是确定性的。
        mock.timers.tick(250)
        return inner.chat(request)
      },
    }
    return { adapter, systems }
  }
  const run = async (promptLayout?: { frozen: boolean }) => {
    let systems: string[] = []
    await runFixtureTask('boundary', fixture => {
      const captured = capture(fixture)
      systems = captured.systems
      return captured.adapter
    }, undefined, undefined, undefined, promptLayout)
    return systems
  }
  mock.timers.enable({ apis: ['Date'], now: EPOCH })
  try {
    const plain = await run()
    assert.ok(plain.length >= 2, '一次脚本化运行要发出多次请求，否则「每轮」无从谈起')
    assert.ok(plain.every(system => !/Runtime Context|Project Context/.test(system)),
      '不传模式时评测路径既不装载 runtime-context 也不装载 project-context，既有各阶段的基线因此不变')

    const live = await run({ frozen: false })
    assert.match(live[0]!, /Runtime Context/)
    assert.match(live[0]!, /## Project Context/)
    assert.ok(new Set(live).size > 1, 'live 布局下系统提示每轮都在变——前缀缓存从 Time 那一行起全部作废')

    const frozen = await run({ frozen: true })
    assert.match(frozen[0]!, /Runtime Context/)
    assert.equal(new Set(frozen).size, 1, 'frozen 布局下整个系统提示在会话内逐字不变')
    assert.ok(frozen.length === live.length, '两臂的装配只差 layout 一个字段，请求数必须相同')
  } finally { mock.timers.reset() }
})
