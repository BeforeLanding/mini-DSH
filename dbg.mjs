import fs from 'node:fs'
import path from 'node:path'
const root = '.eval-evidence/smoke-full'
const runs = fs.readFileSync(path.join(root, 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
for (const run of runs) {
  console.log('status', run.status, 'accepted', run.accepted, 'counters', JSON.stringify(run.counters))
  for (const stage of run.tasks ?? []) {
    console.log('  stage', { taskId: stage.taskId, status: stage.status, projections: stage.projections, est: stage.estimatedInputTokens, max: stage.maxEstimatedInputTokens, firstPruned: stage.firstPrunedProjection, unsent: stage.unsentProjections, usage: stage.usageSources })
  }
}
const sessions = path.join(root, 'sessions', 'audit')
for (const id of fs.readdirSync(sessions)) {
  const log = fs.readFileSync(path.join(sessions, id, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  console.log('\n=== session', id, 'events', log.length, '===')
  for (const e of log) {
    if (e.type === 'context/projection') console.log(`proj  est=${e.data.estimatedInputTokens} removed=${e.data.removedTaskIds.length}`)
    if (e.type === 'model/usage') console.log(`usage in=${e.data.usage.inputTokens} out=${e.data.usage.outputTokens} reasoning=${e.data.usage.reasoningTokens ?? 0} src=${e.data.usage.source}`)
    if (e.type === 'model/end') console.log(`end   finish=${e.data.finishReason ?? '-'}`)
    if (e.type === 'tool/start') console.log(`tool> ${e.data.name} ${JSON.stringify(e.data.arguments ?? {}).slice(0, 160)}`)
    if (e.type === 'tool/result') console.log(`tool< ${e.data.name} bytes=${Buffer.byteLength(e.data.content ?? '')} status=${e.data.status ?? '-'}`)
    if (e.type === 'file/change-result') console.log(`edit  ${e.data.status} ${e.data.path ?? ''}`)
  }
}
