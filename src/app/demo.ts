import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHarness } from './create-harness.js'
import type { ChatRequest, ChatResponse, ToolCall } from '../core/contracts.js'
import { assertToolProtocol } from '../core/context-runtime.js'
import type { SessionEvent } from '../core/contracts.js'

// R11：安装包内的离线演示。不读 .env、不联网、不调用真实模型；项目与模型步骤都写死在这里，
// 因此 tarball 安装后不需要仓库的 test/fixtures 也能运行。
const initial = 'export function add(a, b) {\n  return a - b\n}\n'
const fixed = 'export function add(a, b) {\n  return a + b\n}\n'
const check = 'import { add } from \'./calc.mjs\'\nif (add(2, 3) !== 5) { console.error(\'FAIL: 2 + 3 !== 5\'); process.exit(1) }\nconsole.log(\'PASS: 2 + 3 = 5\')\n'

export async function runDemo({ quiet = false }: { quiet?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-demo-'))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, 'calc.mjs'), initial)
  await fs.writeFile(path.join(workspace, 'check.mjs'), check)
  const steps: ToolCall[] = [
    { id: 'check-before', name: 'bash', arguments: { command: 'node check.mjs' } },
    { id: 'read', name: 'read_file', arguments: { path: 'calc.mjs' } },
    { id: 'edit', name: 'edit_file', arguments: { path: 'calc.mjs', oldText: initial, newText: fixed } },
    { id: 'check-after', name: 'bash', arguments: { command: 'node check.mjs' } },
  ]
  let step = 0
  const chat = async (request: ChatRequest): Promise<ChatResponse> => {
    assertToolProtocol(request.messages ?? [])
    return step < steps.length ? { toolCalls: [steps[step++]!] } : { content: 'demo complete', complete: true, finishReason: 'stop' }
  }
  const harness = await createHarness({
    workspace, profile: 'general', autoApprove: true,
    adapter: { provider: 'demo', model: 'scripted', chat, capabilities: { demo: { contextWindowTokens: 1_000_000 } } },
  })
  try {
    harness.root.sandbox.setApprover(async () => true)
    const session = harness.root.sessions.create({ source: 'demo' })
    const agent = harness.root.agents.create({ sessionId: session.id, model: 'demo/scripted', loop: harness.root.agentLoop, budget: {
      contextWindowTokens: 1_000_000, maxModelRequests: 8, maxToolCalls: 8, maxTotalTokens: 1_000_000,
      inputTargetTokens: 100_000, maxOutputTokens: 1024, minimumOutputTokens: 1, auto: false,
    } })
    let output = ''
    const started = performance.now()
    await agent.send('Fix add() so that 2 + 3 = 5, then run node check.mjs.')
    const events: SessionEvent[] = harness.root.sessions.visibleEvents(session.id)
    const result = events.flatMap(event => event.type === 'tool/result' && event.data.toolCallId === 'check-after'
      ? [{ content: event.data.content, isError: event.data.isError === true }] : [])
    output = result.at(-1)?.content ?? ''
    const passed = result.at(-1)?.isError === false && /PASS: 2 \+ 3 = 5/.test(output)
    if (!quiet) {
      console.log('mini-dsh offline demo (scripted, no API key, no network)')
      console.log(`workspace: ${workspace}`)
      console.log(`steps: ${step}; events: ${events.length}; duration: ${(performance.now() - started).toFixed(0)}ms`)
      console.log(output.trim())
      console.log(passed ? 'demo result: PASS' : 'demo result: FAIL')
    }
    return { passed, events, workspace, output }
  } finally {
    await harness.dispose()
  }
}
