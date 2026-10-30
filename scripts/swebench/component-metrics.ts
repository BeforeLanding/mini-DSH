import fs from 'node:fs/promises'
import path from 'node:path'
import { decodeLog } from '../../src/core/event-store.js'
import type { SessionEvent } from '../../src/core/contracts.js'

// Counts are evidence of exposure, never acceptance or causal benefit. No tool
// output, command, project rule, prompt, or filename is copied into this view.
export function componentMetrics(events: readonly SessionEvent[]) {
  const count = (type: SessionEvent['type']) => events.filter(event => event.type === type).length
  const summaries = events.filter(event => event.type === 'context/summary-start')
  const calls = events.flatMap(event => event.type === 'assistant/tool_calls' ? event.data.toolCalls : [])
  const results = events.filter(event => event.type === 'tool/result')
  const projections = events.filter(event => event.type === 'context/projection')
  const checks = events.filter(event => event.type === 'verification/result')
  const seen = new Set<string>()
  let snapshotParseErrors = 0
  for (const event of events) if (event.type === 'context/snapshot' && event.data.name === 'project:context') {
    // The snapshot always exists even when no AGENTS.md applies. Count actual
    // nonempty rules, not the presence of a context plugin or its schema.
    const start = event.data.text.indexOf('{')
    try {
      const context = JSON.parse(event.data.text.slice(start)) as { rules?: { path?: string; content?: string }[] }
      if (start < 0 || !Array.isArray(context.rules)) throw new Error('missing rules list')
      for (const rule of context.rules) if (rule.content?.trim()) seen.add(rule.path ?? rule.content)
    } catch { snapshotParseErrors++ }
  }
  const successful = (name: string) => results.filter(event => event.data.name === name && event.data.status === 'completed' && !event.data.isError).length
  return {
    schemaVersion: 1 as const,
    complete: count('run/start') > 0 && count('run/start') === count('run/finish'),
    context: { attempts: summaries.length, applied: events.filter(event => event.type === 'context/summary-end' && event.data.outcome.kind === 'applied').length,
      declined: events.filter(event => event.type === 'context/summary-end' && event.data.outcome.kind === 'declined').length,
      peakEstimatedInputTokens: Math.max(0, ...projections.map(event => event.data.estimatedInputTokens)),
      historyReads: successful('read_history') },
    toolOutput: { previewTruncations: results.filter(event => event.data.previewTruncated).length,
      recallAttempts: calls.filter(call => call.name === 'read_tool_result').length, successfulRecalls: successful('read_tool_result'),
      errors: results.filter(event => event.data.isError).length },
    projectContext: { ruleVersions: count('context/project-version'), injectedRuleFiles: seen.size, queries: successful('project_context'), snapshotParseErrors },
    verification: { started: count('verification/start'), finished: checks.length,
      passed: checks.filter(event => event.data.commandResult.status === 'exited' && event.data.commandResult.exitCode === 0).length,
      failed: checks.filter(event => event.data.commandResult.status !== 'exited' || event.data.commandResult.exitCode !== 0).length,
      reportReads: successful('task_report'), changeReads: successful('task_changes') },
    retries: count('model/retry'),
  }
}

export type ComponentMetrics = ReturnType<typeof componentMetrics>

export async function readComponentMetrics(root: string, record: { sessionId?: string; eventsPath?: string }): Promise<ComponentMetrics | undefined> {
  if (!record.eventsPath || !record.sessionId) return undefined
  const target = path.resolve(root, record.eventsPath)
  const relative = path.relative(path.resolve(root), target)
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('component event path escapes evidence root')
  return componentMetrics(decodeLog(await fs.readFile(target), record.sessionId))
}

export function componentExposure(readings: readonly (ComponentMetrics | undefined)[], component: 'context' | 'toolOutput' | 'projectContext') {
  const available = readings.filter((reading): reading is ComponentMetrics => !!reading?.complete && (component !== 'projectContext' || reading.projectContext.snapshotParseErrors === 0))
  const triggered = available.filter(reading => component === 'context' ? reading.context.applied > 0
    : component === 'toolOutput' ? reading.toolOutput.previewTruncations > 0 : reading.projectContext.injectedRuleFiles > 0).length
  return { observedEpisodes: available.length, missingOrIncompleteEpisodes: readings.length - available.length, triggeredEpisodes: triggered,
    criterion: component === 'context' ? 'applied-summary' : component === 'toolOutput' ? 'bounded-preview' : 'nonempty-injected-scoped-rules',
    coverage: available.length !== readings.length ? 'unknown' as const : triggered > 0 ? 'observed' as const : 'not-exercised' as const }
}
