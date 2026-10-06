import type { Context } from '@deepseek-ai/cordis'
import { HISTORY_READ_MAX_BYTES, readHistory } from '../core/history-read.js'
import { positiveLimit } from '../core/bounded-text.js'

export const name = 'mini-read-history'
export const inject = ['tools', 'sessions']
export interface ReadHistoryConfig { maxBytes?: number }

// NX-34：摘要把一段历史换成 frame 之后，模型手里就只剩「第 N–M 号事件被替换了」这个门牌号。
// 这个工具是那张门牌号能兑现的入口。它刻意不挂进评测路径（scripts/eval-fixture.ts）：多一个工具条目
// 就改了 tools.schema，而 NX-08 两臂的对照要求工具表一致。
export function apply(ctx: Context, config: ReadHistoryConfig = {}) {
  const maxBytes = positiveLimit(config.maxBytes, HISTORY_READ_MAX_BYTES, 'maxBytes')
  ctx.effect(() => ctx.tools.register({
    name: 'read_history',
    description: 'Read this session original events by event number (seq), for recovering facts that a context summary dropped. Messages (user, assistant, tool calls and tool results) are rendered verbatim; every other event is listed by type only. The range is bounded by maxBytes and pages forward with nextSeq until eof. Reading does not modify the log.',
    parameters: { type: 'object', properties: { from: { type: 'integer', minimum: 1 }, to: { type: 'integer', minimum: 1 }, maxBytes: { type: 'integer', minimum: 1, maximum: maxBytes } }, required: ['from'] },
    execute(args, execution) {
      if (!execution.sessionId) throw new Error('read_history requires a session')
      return readHistory(ctx.sessions, execution.sessionId, args.from, args.to, args.maxBytes, maxBytes)
    },
  }), 'register read_history')
}
