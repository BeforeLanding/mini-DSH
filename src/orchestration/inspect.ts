import fs from 'node:fs/promises'
import path from 'node:path'
import { decodeOrchestrationLog } from './validation.js'
import { foldOrchestration, orchestrationTotals } from './state.js'
import type { OrchestrationState } from './state.js'

// 只读查看：不取得 writer.lock，不写入任何文件；与会话日志的 inspect 保持同一纪律。
export async function loadOrchestration(target: string) {
  const logPath = target.endsWith('.jsonl') ? path.resolve(target) : path.join(path.resolve(target), 'orchestration.jsonl')
  const text = await fs.readFile(logPath, 'utf8')
  const first = text.split('\n', 1)[0]
  if (!first) throw new Error('orchestration log is empty')
  let record: unknown
  try { record = JSON.parse(first) } catch (error) { throw new Error('corrupt orchestration log header', { cause: error }) }
  if (!record || typeof record !== 'object' || Array.isArray(record) || typeof (record as { rootId?: unknown }).rootId !== 'string') throw new Error('orchestration log has no rootId')
  const rootId = (record as { rootId: string }).rootId
  const events = decodeOrchestrationLog(text, rootId)
  const state = foldOrchestration(events)
  return { logPath, rootId, events, state, totals: orchestrationTotals(state) }
}
export interface OrchestrationReport {
  logPath: string
  rootId: string
  state: OrchestrationState
  totals: ReturnType<typeof orchestrationTotals>
  events: number
}
export function formatOrchestration(report: OrchestrationReport) {
  const { state, totals } = report
  const lines = [
    `root ${report.rootId}  status=${state.status}`,
    `goal: ${state.goal}`,
    `repository: ${state.repository} @ ${state.baseCommit}`,
    `events: ${report.events}  log: ${report.logPath}`,
  ]
  if (state.decision) lines.push(`plan: version=${state.decision.planVersion} mode=${state.decision.mode} waves=${state.decision.waves.length}`)
  for (const attemptId of state.attemptOrder) {
    const attempt = state.attempts[attemptId]!
    const code = attempt.commit ? ` commit=${attempt.commit.slice(0, 12)}` : ''
    const changed = attempt.changedFiles.length ? ` files=${attempt.changedFiles.join(',')}` : ''
    const violations = attempt.scopeViolations.length ? ` violations=${attempt.scopeViolations.join(',')}` : ''
    lines.push(`attempt ${attemptId} ${attempt.subtaskId} epoch=${attempt.epoch} status=${attempt.status}${attempt.outcome ? ` outcome=${attempt.outcome}` : ''}${code}${changed}${violations}`)
    if (attempt.worktree) lines.push(`  worktree: ${attempt.worktree}`)
  }
  lines.push(`ledger: requests=${totals.requests} provider=${totals.providerTokens} estimated=${totals.estimatedTokens} unknown=${totals.unknownChargedTokens} outstanding=${totals.outstandingTokens} cacheRead=${totals.cacheReadTokens}`)
  if (state.integration) lines.push(`integration: ${state.integration.status} wave=${state.integration.wave} applied=${state.integration.applied.length} head=${state.integration.head ?? '-'} tree=${state.integration.tree ?? '-'}`)
  for (const verification of state.verifications) lines.push(`verify: exit=${verification.exitCode ?? 'null'} ${verification.command}`)
  for (const human of Object.values(state.human)) lines.push(`human: ${human.request.kind} ${human.response ? `-> ${human.response.choice}` : '(pending)'} ${human.request.prompt}`)
  if (state.finished) lines.push(`finished: ${state.finished.status}${state.finished.reportRef ? ` report=${state.finished.reportRef}` : ''}`)
  return lines.join('\n')
}
