import type { Context } from '@deepseek-ai/cordis'
import type { DelegationRuntime } from '../core/delegation-runtime.js'
export const name = 'mini-delegation'
export const inject = ['tools', 'systemPrompt']
export function apply(ctx: Context, config: { runtime: DelegationRuntime }) {
  ctx.effect(() => () => config.runtime.close(), 'cancel and close delegation children')
  ctx.effect(() => ctx.systemPrompt.section({ name: 'delegation:usage', order: 65, text: 'Use delegate_tasks for independent read-only investigations when they justify their shared cost. First read contextRefs files yourself. The batch waits for bounded child results; only you edit and run checks. Re-read key findings before editing; child agreement is not verification. Subtasks share this logical task budget and memory view. Do not delegate simple local work unnecessarily.' }), 'register delegation guidance')
  ctx.effect(() => ctx.tools.register({ name: 'delegate_tasks', origin: 'builtin', effect: 'delegate', exposeErrors: true,
    description: 'Run a bounded synchronous batch of independent read-only analyst, test_designer or version-bound reviewer tasks. contextRefs are workspace-relative paths already read with read_file in this task; the host binds hashes. Only this tool internally runs children concurrently. No child may write, execute commands, use MCP, or delegate. Results carry verified hashes and parent-owned read_tool_result refs.',
    parameters: { type: 'object', properties: { tasks: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', properties: { role: { enum: ['analyst', 'test_designer', 'reviewer'] }, objective: { type: 'string' }, contextRefs: { type: 'array', items: { type: 'string' } }, outputFocus: { type: 'string' } }, required: ['role', 'objective', 'contextRefs', 'outputFocus'], additionalProperties: false } } }, required: ['tasks'], additionalProperties: false },
    execute(args, execution) { return config.runtime.run(args.tasks, execution) },
  }), 'register delegate_tasks')
  ctx.effect(() => ctx.tools.register({ name: 'review_status', origin: 'builtin', effect: 'read', exposeErrors: true, description: 'Revalidate current-task reviewer candidates against current file hashes. A completed review can be stale after any edit; check this before using old review findings. Follow nextOffset while eof is false.',
    parameters: { type: 'object', properties: { offset: { type: 'integer', minimum: 0 } }, additionalProperties: false },
    execute(args, execution) { if (!execution.sessionId) throw new Error('review_status requires a session'); return config.runtime.reviewStatus(execution.sessionId, args.offset === undefined ? 0 : Number(args.offset)) },
  }), 'register review_status')
}
