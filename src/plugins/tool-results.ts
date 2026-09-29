import type { Context } from '@deepseek-ai/cordis'
import { ToolResultStore, utf8Prefix, type ResultStoreConfig } from '../core/tool-result-store.js'
import { positiveLimit } from '../core/bounded-text.js'

export const name = 'mini-tool-results'
export const inject = ['tools', 'sandbox']
export interface ToolResultsConfig extends Partial<ResultStoreConfig> { maxPreviewBytes?: number }

export function apply(ctx: Context, config: ToolResultsConfig = {}) {
  const directory = config.directory ?? '.mini-dsh/tool-results'
  const store = new ToolResultStore({ ...config, directory: ctx.sandbox.resolvePath(directory) })
  const maxPreviewBytes = positiveLimit(config.maxPreviewBytes, 16 * 1024, 'maxPreviewBytes')
  ctx.effect(() => ctx.tools.setResultProjection(async (tool, result, execution) => {
    if (tool === 'read_tool_result' || !execution.sessionId) return result
    const text = ctx.tools.renderResult(result), bytes = Buffer.from(text)
    if (bytes.length <= maxPreviewBytes) return result
    ctx.sandbox.resolvePath(directory)
    const saved = await store.save(execution.sessionId, text, execution.signal)
    const preview = utf8Prefix(bytes, maxPreviewBytes).toString('utf8')
    return { ...result, value: { ...saved, preview }, content: [{ type: 'text', text: `${preview}\n[tool_result ${JSON.stringify({ ...saved, originalBytes: bytes.length })}; use read_tool_result with ref and offset=0]` }] }
  }), 'register tool result projection')
  ctx.effect(() => ctx.tools.register({
    name: 'read_tool_result',
    description: 'Read a stored tool result from this session using its ref. UTF-8 byte offset starts at 0; use nextOffset until eof. captureTruncated means collection was bounded. References survive restart while result files remain.',
    parameters: { type: 'object', properties: { ref: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 1, maximum: store.maxReadBytes } }, required: ['ref'] },
    async execute(args, execution) {
      ctx.sandbox.resolvePath(directory)
      return store.read(execution.sessionId, args.ref, args.offset, args.maxBytes, execution.signal)
    },
  }), 'register read_tool_result')
}
