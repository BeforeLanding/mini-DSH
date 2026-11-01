import type { SessionEvent } from './contracts.js'

// 单任务内的观测遮蔽：只改投影里的 tool/result 正文，不删不改日志里的原始事件。
// 旧任务裁剪以 task 为粒度，SWE 这类单任务长轨迹里永远不触发；这里补上 task 内部的那一层。
// 遮蔽按块推进（缺省每次 ceil(window/2) 条，可配置），避免每一轮都改写前缀而让前缀缓存逐轮失效。
export const OBSERVATION_HEAD_CHARS = 320
export const OBSERVATION_MARKER = '[harness: older tool output elided'

export function maskedObservationCount(results: number, window: number, step = Math.ceil(window / 2)) {
  step = Math.max(1, step)
  return Math.max(0, Math.floor((results - window) / step) * step)
}

export function observationStub(content: string, seq: number) {
  if (content.length <= OBSERVATION_HEAD_CHARS * 2) return content
  const cut = content.lastIndexOf('\n', OBSERVATION_HEAD_CHARS)
  const head = content.slice(0, cut > OBSERVATION_HEAD_CHARS / 2 ? cut : OBSERVATION_HEAD_CHARS)
  return `${head}\n${OBSERVATION_MARKER} (${content.length} chars); call read_history with from=${seq} to see it again, or re-run the command]`
}

export function maskObservations(events: SessionEvent[], taskId: string, window: number, step?: number): { events: SessionEvent[]; masked: number } {
  const results = events.filter(event => event.type === 'tool/result' && event.taskId === taskId)
  const count = maskedObservationCount(results.length, window, step)
  if (!count) return { events, masked: 0 }
  const targets = new Set(results.slice(0, count).map(event => event.seq))
  let masked = 0
  const projected = events.map(event => {
    if (event.type !== 'tool/result' || !targets.has(event.seq)) return event
    const content = observationStub(event.data.content, event.seq)
    if (content === event.data.content) return event
    masked++
    return { ...event, data: { ...event.data, content } }
  })
  return { events: projected, masked }
}
