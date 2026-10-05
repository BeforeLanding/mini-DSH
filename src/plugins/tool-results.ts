import type { Context } from '@deepseek-ai/cordis'
import { ToolResultStore, utf8Prefix, utf8Suffix, PREVIEW_TAIL_DIVISOR, type ResultStoreConfig } from '../core/tool-result-store.js'
import { positiveLimit } from '../core/bounded-text.js'
import type { CommandResult, CommandStream } from '../core/command-runner.js'

export const name = 'mini-tool-results'
export const inject = ['tools', 'sandbox']
export interface ToolResultsConfig extends Partial<ResultStoreConfig> { maxPreviewBytes?: number }

export function apply(ctx: Context, config: ToolResultsConfig = {}) {
  const directory = config.directory ?? '.mini-dsh/tool-results'
  const store = new ToolResultStore({ ...config, directory: ctx.sandbox.resolvePath(directory) })
  const maxPreviewBytes = positiveLimit(config.maxPreviewBytes, 16 * 1024, 'maxPreviewBytes')
  const tailLimit = Math.max(1, Math.floor(maxPreviewBytes / PREVIEW_TAIL_DIVISOR))
  ctx.effect(() => ctx.tools.setResultProjection(async (tool, result, execution) => {
    if (tool === 'read_tool_result' || !execution.sessionId) return result
    if (tool === 'bash' && (result.value as CommandResult | null)?.type === 'command') {
      const limit = Math.max(1, Math.floor(maxPreviewBytes / 2))
      const project = async (stream: CommandStream): Promise<CommandStream> => {
        const bytes = Buffer.from(stream.text)
        if (bytes.length <= limit) return stream
        const head = utf8Prefix(bytes, limit)
        const preview = head.toString('utf8')
        const tail = utf8Suffix(bytes.subarray(head.length), tailLimit)
        const omittedBytes = bytes.length - head.length - tail.length
        try {
          ctx.sandbox.resolvePath(directory)
          const saved = await store.save(execution.sessionId!, stream.text, execution.signal)
          return { ...stream, text: preview, ...(omittedBytes > 0 ? { tail: tail.toString('utf8'), omittedBytes, resumeOffset: head.length } : {}), previewTruncated: true, ref: saved.ref,
            storedBytes: saved.bytes, storageTruncated: saved.truncated }
        } catch (error) {
          return { ...stream, text: preview, previewTruncated: true,
            storageError: error instanceof Error ? error.message : String(error) }
        }
      }
      const value = result.value as CommandResult
      const stdout = await project(value.stdout), stderr = await project(value.stderr)
      const projected = { ...value, stdout, stderr }
      return { value: projected, isError: result.isError || !!stdout.storageError || !!stderr.storageError,
        content: [{ type: 'text', text: JSON.stringify(projected, null, 2) }] }
    }
    const text = ctx.tools.renderResult(result), bytes = Buffer.from(text)
    if (bytes.length <= maxPreviewBytes) return result
    ctx.sandbox.resolvePath(directory)
    const saved = await store.save(execution.sessionId, text, execution.signal)
    const head = utf8Prefix(bytes, maxPreviewBytes)
    const preview = head.toString('utf8')
    const tail = utf8Suffix(bytes.subarray(head.length), tailLimit)
    const omittedBytes = bytes.length - head.length - tail.length
    const window = omittedBytes > 0 ? { tail: tail.toString('utf8'), omittedBytes, resumeOffset: head.length } : {}
    return { ...result, value: { ...saved, preview, ...window }, content: [{ type: 'text', text: `${preview}\n[tool_result ${JSON.stringify({ ...saved, originalBytes: bytes.length, ...window })}; use read_tool_result with ref and offset=0]` }] }
  }), 'register tool result projection')
  ctx.effect(() => ctx.tools.register({
    name: 'read_tool_result',
    description: 'Read a stored tool result from this session using its ref. Truncated results may include text (head), tail (end), omittedBytes (missing middle) and resumeOffset (middle start). UTF-8 byte offset starts at 0; use nextOffset until eof. captureTruncated means collection was bounded. References survive restart while result files remain.',
    parameters: { type: 'object', properties: { ref: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 1, maximum: store.maxReadBytes } }, required: ['ref'] },
    async execute(args, execution) {
      ctx.sandbox.resolvePath(directory)
      return store.read(execution.sessionId, args.ref, args.offset, args.maxBytes, execution.signal)
    },
  }), 'register read_tool_result')
}
