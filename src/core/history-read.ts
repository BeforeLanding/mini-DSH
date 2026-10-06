import { utf8Prefix } from './tool-result-store.js'
import { positiveLimit } from './bounded-text.js'
import type { SessionEvent } from './contracts.js'
import type { SessionRuntime } from './session-runtime.js'

export const HISTORY_READ_MAX_BYTES = 16 * 1024

export interface HistoryRead {
  content: string
  nextSeq: number
  eof: boolean
  totalEvents: number
}

// 只把**会产生消息的那四类**事件的原文渲染出来。其余事件（run/start、model/fragment、file/change…）
// 只列类型与 seq：它们的载荷不是模型当时看到的内容，整份 JSON 灌进来只会把预算吃光而不回答任何问题。
// 这一点写在工具描述里，不假装「日志里的一切都能从这里逐字读回来」。
function renderEvent(event: SessionEvent): string {
  switch (event.type) {
    case 'user/message': return `[${event.seq}] user\n${event.data.content}`
    case 'assistant/message': return `[${event.seq}] assistant\n${event.data.content}`
    case 'assistant/tool_calls': {
      const calls = event.data.toolCalls.map(call => `→ ${call.name} ${JSON.stringify(call.arguments ?? {})}`)
      return [`[${event.seq}] assistant/tool_calls`, ...[event.data.content ?? '', ...calls].filter(Boolean)].join('\n')
    }
    case 'tool/result': {
      const state = event.data.status && event.data.status !== 'completed' ? ` (${event.data.status})` : ''
      return `[${event.seq}] tool/result ${event.data.name ?? ''}${state}\n${event.data.content}`
    }
    default: return `[${event.seq}] ${event.type}`
  }
}

function seqArg(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer event sequence number`)
  return value
}

// 按 seq 有界回读原始事件。它是「同一份日志产出同一个输入」的配套：摘要可以漏、可以错，但事件号还在，
// 事实就核对得回来。读取本身不产生任何可被遮蔽的内容——它只是一条普通的工具结果。
export function readHistory(
  sessions: Pick<SessionRuntime, 'visibleEvents'>, sessionId: string,
  from: unknown, to?: unknown, maxBytes?: unknown, ceiling = HISTORY_READ_MAX_BYTES,
): HistoryRead {
  const events = sessions.visibleEvents(sessionId)
  const start = seqArg(from, 'from')
  const lastSeq = events.at(-1)?.seq ?? 0
  if (start > lastSeq) throw new Error('from is outside this session history')
  const end = to === undefined ? lastSeq : seqArg(to, 'to')
  if (end < start) throw new Error('to must not be before from')
  const limit = positiveLimit(maxBytes, ceiling, 'maxBytes', ceiling)
  const parts: string[] = []
  let bytes = 0
  let nextSeq = end + 1
  let eof = true
  for (const event of events) {
    if (event.seq < start || event.seq > end) continue
    const rendered = `${renderEvent(event)}\n`
    const size = Buffer.byteLength(rendered)
    const room = limit - bytes
    if (size <= room) {
      parts.push(rendered)
      bytes += size
      continue
    }
    // 放不下整条事件。这一页还空着（room === limit）时把能放的部分放进去并**前进**到下一个 seq：
    // 否则同样的预算会一页页地重读同一条超大事件，调用方永远走不到 eof。页里已经有内容时则在它之前
    // 停下，让下一页从头完整地读它。
    if (room === limit) {
      const marker = `[event ${event.seq} truncated; ${size} bytes total; raise maxBytes to read it whole]\n`
      parts.push(marker + utf8Prefix(Buffer.from(rendered), Math.max(0, room - Buffer.byteLength(marker))).toString('utf8'))
      bytes = limit
      nextSeq = event.seq + 1
      eof = nextSeq > end
      break
    }
    nextSeq = event.seq
    eof = false
    break
  }
  let body = parts.join('')
  if (!eof) {
    const note = `\n[truncated; continue with read_history from=${nextSeq}]`
    const noteBytes = Buffer.byteLength(note)
    body = noteBytes < limit ? utf8Prefix(Buffer.from(body), limit - noteBytes).toString('utf8') + note : utf8Prefix(Buffer.from(body), limit).toString('utf8')
  }
  return { content: body || '[no events in this range]', nextSeq, eof, totalEvents: events.length }
}
