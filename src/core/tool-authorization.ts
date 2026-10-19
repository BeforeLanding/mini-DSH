import { createHash } from 'node:crypto'
import type { Arguments, Execution, ToolDefinition } from './contracts.js'
import type { SandboxRuntime } from './sandbox-runtime.js'

export const toolPolicyVersion = 'r02b-v1'

const builtins: Record<string, ToolDefinition['effect']> = {
  request_trace: 'read', task_report: 'read', read_file: 'read', task_changes: 'read', glob: 'read', grep: 'read',
  read_history: 'read', read_tool_result: 'read', project_context: 'read',
  write_file: 'write', edit_file: 'write', bash: 'exec',
}

const digest = (args: Arguments) => createHash('sha256').update(JSON.stringify(args)).digest('hex')

export async function authorizeTool(sandbox: Pick<SandboxRuntime, 'workspace' | 'resolvePath' | 'approve'>, tool: ToolDefinition, args: Arguments, execution: Execution) {
  execution.signal.throwIfAborted()
  const workspace = sandbox.workspace
  const before = digest(args)
  const resources = tool.resources?.(args) ?? []
  if (!Array.isArray(resources) || !resources.every(resource => typeof resource === 'string')) throw new Error('invalid tool resources')
  const resolved = resources.map(resource => sandbox.resolvePath(resource))
  const trusted = tool.origin === 'builtin' && builtins[tool.name] === tool.effect
  if (trusted) return

  const effect = tool.effect ?? 'unknown'
  const brief = JSON.stringify(args).slice(0, 2000)
  await sandbox.approve({ tool: tool.name, summary: `Tool ${tool.name} (${effect}); workspace=${workspace}; policy=${toolPolicyVersion}; toolCallId=${execution.toolCallId ?? '(direct)'}; argsSha256=${before}; resources=${JSON.stringify(resolved)}; args=${brief}`,
    signal: execution.signal, approval: execution.approval }, false)
  execution.signal.throwIfAborted()
  if (sandbox.workspace !== workspace || digest(args) !== before) throw new Error('tool arguments or workspace changed during approval')
  const after = (tool.resources?.(args) ?? []).map(resource => sandbox.resolvePath(resource))
  if (JSON.stringify(after) !== JSON.stringify(resolved)) throw new Error('tool resources changed during approval')
}
