import { Context } from '@deepseek-ai/cordis'
import { CLI_BUDGET } from '../src/core/budget.js'
import { assertToolProtocol } from '../src/core/context-runtime.js'
import { JsonlStore } from '../src/core/event-store.js'
import type { ChatRequest, ChatResponse, ToolCall } from '../src/core/contracts.js'
import * as sessions from '../src/plugins/session.js'
import * as systemPrompt from '../src/plugins/system-prompt.js'
import * as tools from '../src/plugins/tools.js'
import * as llm from '../src/plugins/llm.js'
import * as agents from '../src/plugins/agent.js'
import * as agentLoop from '../src/plugins/agent-loop.js'
import * as sandbox from '../src/plugins/sandbox.js'
import * as files from '../src/tools/files.js'
import * as bash from '../src/tools/bash.js'

// NX-10 第三幕的子进程：它会被父进程**真的杀掉**，留下的残局就是一次真实崩溃的残局。
//
// 因此这里刻意没有 finally、没有信号处理、不调用 store.close()：正常退出路径根本不该被执行。
// 反过来，任何「先写个假的半拉日志再扮演崩溃」的做法都绕开了要展示的东西——真实的残留物是
// writer.lock（进程死时没人释放）与一条只有 tool/start 而没有 tool/result 的调用。
//
// 只装配到能跑 bash 为止，不装 runtime-context / project-context：这一幕的因果链只到事件日志，
// 装上规则反而让读者去找与结论无关的东西。
const [workspace, sessionDirectory, task] = process.argv.slice(2)
if (!workspace || !sessionDirectory || !task) throw new Error('usage: demo-unknown-child <workspace> <session-directory> <task>')

// 命令写下一个**真实的副作用文件**后阻塞。父进程等这个文件出现再动手，因此杀戮必然发生在命令
// 执行期间，不会与「命令已经跑完并写好 tool/result」抢时间。
const wedged: ToolCall = { id: 'wedged', name: 'bash', arguments: { command: 'echo started > .demo-side-effect; sleep 300' } }
let sent = false

const root = new Context()
for (const plugin of [sessions, systemPrompt, tools, llm, agents, agentLoop]) await root.plugin(plugin)
await root.plugin(sandbox, { workspace, autoApprove: true })
await root.plugin(files); await root.plugin(bash)
root.llm.register('scripted', {
  models: ['demo'], capabilities: { demo: { contextWindowTokens: 1_000_000 } },
  chat: async ({ messages = [] }: ChatRequest): Promise<ChatResponse> => {
    assertToolProtocol(messages)
    if (sent) return { content: '脚本化模型：预设序列执行完毕' }
    sent = true
    return { toolCalls: [wedged] }
  },
})
// workspace 必须进 meta：父进程恢复时会拿它校验（session-runtime.ts:43）。
const session = root.sessions.create({ source: 'demo-unknown', workspace })
const store = await JsonlStore.open(sessionDirectory, session.id)
root.sessions.attachStore(session.id, store)
const agent = root.agents.create({ name: 'demo-unknown-child', sessionId: session.id, model: 'scripted/demo', loop: root.agentLoop, budget: CLI_BUDGET })
// 握手：父进程靠这一行知道会话目录名，然后才开始等副作用文件。
process.stdout.write(`SESSION ${session.id}\n`)
await agent.send(task)
