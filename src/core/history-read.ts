import { utf8Prefix } from './tool-result-store.js'
import { positiveLimit } from './bounded-text.js'
import type { SessionEvent } from './contracts.js'
import type { SessionRuntime } from './session-runtime.js'

export const HISTORY_READ_MAX_BYTES = 16 * 1024

export interface HistoryRead {
  content: string
  // 游标是一对：nextSeq 是「下一条要读的事件号」，nextOffset 是「该事件**渲染文本**里的字节偏移」。
  // nextSeq 前进时 nextOffset 归零，eof 时为 0。两个数必须一起带回，只带 nextSeq 会原地打转。
  nextSeq: number
  nextOffset: number
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

// 一页里装的是「事件渲染文本 + 换行」。偏移就量这个，不是量原始 JSON，也不是量事件正文。
const pageText = (event: SessionEvent) => `${renderEvent(event)}\n`

function seqArg(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer event sequence number`)
  return value
}

function offsetArg(value: unknown) {
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('offset must be a nonnegative safe integer')
  return value
}

// 按 seq 有界回读原始事件。它是「同一份日志产出同一个输入」的配套：摘要可以漏、可以错，但事件号还在，
// 事实就核对得回来。读取本身不产生任何可被遮蔽的内容——它只是一条普通的工具结果。
//
// 分页游标是 (from, offset) 一对，与 `read_tool_result` 的 (ref, offset) 同形：
//   - offset 量的是 from 那条事件**渲染文本**里的 UTF-8 字节偏移（0 表示从头读它）
//   - offset 等于该事件文本长度时归一化成「下一条事件、偏移 0」
//   - 一页绝不在中途把一条事件劈成两半；一条事件自己就大于一页时，给出有界前缀并把
//     nextSeq 停在它身上、nextOffset 指向断点——**剩下的字节下一次调用照样取得回来**
//
// 由此得到的性质比「nextSeq 必前进」更强也更有用：游标 (nextSeq, nextOffset) 按字典序严格前进，
// 而区间内每一条事件的每一个字节都能经有限次调用取回。**唯一会打转的用法是只跟 nextSeq、把
// offset 丢掉**——服务端无法区分「正确续读」与「从头重读同一条事件」，只能靠这对字段名和
// 页面末尾的提示语把误用挡住。这一点在工具描述里写明白，不假装它是服务端能兜住的事。
export function readHistory(
  sessions: Pick<SessionRuntime, 'visibleEvents'>, sessionId: string,
  from: unknown, to?: unknown, maxBytes?: unknown, ceiling = HISTORY_READ_MAX_BYTES, offset?: unknown,
): HistoryRead {
  const events = sessions.visibleEvents(sessionId)
  const start = seqArg(from, 'from')
  const lastSeq = events.at(-1)?.seq ?? 0
  if (start > lastSeq) throw new Error('from is outside this session history')
  const end = to === undefined ? lastSeq : seqArg(to, 'to')
  if (end < start) throw new Error('to must not be before from')
  const limit = positiveLimit(maxBytes, ceiling, 'maxBytes', ceiling)
  const at0 = offsetArg(offset)
  const inRange = events.filter(event => event.seq >= start && event.seq <= end)
  const rendered = inRange.map(event => Buffer.from(pageText(event)))

  // 提示语的长度上界：本区间内可能出现的最大游标（seq 不超过 end，offset 不超过 MAX_SAFE_INTEGER）。
  // **先把它留出来再装正文**——正文装完再裁剪提示语，会把上一页最后一条事件的尾巴剪掉，
  // 而 nextSeq 已经越过它，那些字节就再也取不回来了。
  const reserve = Buffer.byteLength(`\n[truncated; continue with read_history from=${end} offset=${Number.MAX_SAFE_INTEGER}]`)

  let begin = 0
  let at = at0
  if (at > 0) {
    const first = rendered[0]
    if (!first) throw new Error('offset must be 0 unless from identifies an event in this session history')
    if (at > first.length || (at < first.length && (first[at]! & 0xc0) === 0x80)) throw new Error(`offset must be a UTF-8 character boundary inside event ${start}`)
    if (at === first.length) { begin = 1; at = 0 }
  }

  const parts: Buffer[] = []
  let used = 0
  let nextSeq = end + 1
  let nextOffset = 0
  let eof = true
  for (let index = begin; index < rendered.length; index++) {
    const event = inRange[index]!
    const whole = rendered[index]!
    const bytes = index === begin && at > 0 ? whole.subarray(at) : whole
    const size = bytes.length
    // 装得下整条、而且它就是这个区间的最后一条：不需要提示语，本页到此为止（eof）。
    if (index === rendered.length - 1 && used + size <= limit) { parts.push(bytes); used += size; break }
    // 装得下整条、且还留得下提示语的位置：收下，继续看下一条。
    if (used + size + reserve <= limit) { parts.push(bytes); used += size; continue }
    if (used > 0) {
      // 本页已经有内容：停在它之前，让下一页从头完整地读它（偏移归零，因为下一条是**这条**事件）。
      nextSeq = event.seq
      eof = false
      break
    }
    // 本页还空着：这条事件自己就超过一页。给有界前缀，游标停在它身上，剩下的字节下次接着读。
    const room = limit - reserve
    if (room <= 0) throw new Error(`maxBytes cannot fit the continuation notice; raise it above ${reserve}`)
    const head = utf8Prefix(bytes, room)
    if (!head.length) throw new Error('maxBytes cannot fit the next UTF-8 character')
    parts.push(head)
    used += head.length
    nextSeq = event.seq
    nextOffset = at + head.length
    eof = false
    break
  }
  if (!eof) parts.push(Buffer.from(`\n[truncated; continue with read_history from=${nextSeq} offset=${nextOffset}]`))
  const body = Buffer.concat(parts).toString('utf8')
  return { content: body || '[no events in this range]', nextSeq, nextOffset, eof, totalEvents: events.length }
}
