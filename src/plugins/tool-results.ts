import type { Context } from '@deepseek-ai/cordis'
import { ToolResultStore, previewWindow, utf8Suffix, PREVIEW_TAIL_DIVISOR, type ResultStoreConfig } from '../core/tool-result-store.js'
import { positiveLimit } from '../core/bounded-text.js'
import type { CommandResult, CommandStream } from '../core/command-runner.js'
import type { AvailableRange } from '../core/tool-result-store.js'

export const name = 'mini-tool-results'
export const inject = ['tools', 'sandbox']
export interface ToolResultsConfig extends Partial<ResultStoreConfig> { maxPreviewBytes?: number }

export function apply(ctx: Context, config: ToolResultsConfig = {}) {
  const directory = config.directory ?? '.mini-dsh/tool-results'
  const store = new ToolResultStore({ ...config, directory: ctx.sandbox.resolvePath(directory) })
  const maxPreviewBytes = positiveLimit(config.maxPreviewBytes, 16 * 1024, 'maxPreviewBytes')
  const tailLimit = Math.max(1, Math.floor(maxPreviewBytes / PREVIEW_TAIL_DIVISOR))
  ctx.effect(() => ctx.tools.setResultProjection(async (tool, result, execution) => {
    // read_history 与 read_tool_result 一样，输出已由调用方自己的 maxBytes 限定；再套一层预览截断与
    // 结果存储只会把「按 seq 分页」变成「按 ref 分页」。
    if (tool === 'read_tool_result' || tool === 'read_history' || !execution.sessionId) return result
    if (tool === 'bash' && (result.value as CommandResult | null)?.type === 'command') {
      const project = async (stream: CommandStream, limit: number): Promise<CommandStream> => {
        const bytes = Buffer.from(stream.text)
        if (bytes.length <= limit && !stream.truncated) return stream
        const tailSource = stream.truncated ? Buffer.from(stream.tail ?? '') : bytes
        const { head, tail, omittedBytes, resumeOffset } = previewWindow(bytes, tailSource, stream.bytes, limit, tailLimit)
        const preview = head.toString('utf8')
        // Explicitly replace a capture tail even when no full character fits.
        const window = { tail: tail.length ? tail.toString('utf8') : undefined, omittedBytes, resumeOffset }
        try {
          ctx.sandbox.resolvePath(directory)
          const saved = stream.truncated
            ? await store.saveSparse(execution.sessionId!, stream.text,
              utf8Suffix(tailSource, Math.max(0, stream.bytes - bytes.length)).toString('utf8'), stream.bytes, execution.signal)
            : await store.save(execution.sessionId!, stream.text, execution.signal)
          return { ...stream, text: preview, ...window, previewTruncated: true, ref: saved.ref,
            storedBytes: saved.bytes, storageTruncated: saved.truncated,
            ...('availableRanges' in saved ? { availableRanges: saved.availableRanges as AvailableRange[] } : {}) }
        } catch (error) {
          return { ...stream, text: preview, ...window, previewTruncated: true,
            storageError: error instanceof Error ? error.message : String(error) }
        }
      }
      const value = result.value as CommandResult
      const stdout = await project(value.stdout, Math.ceil(maxPreviewBytes / 2))
      const stderr = await project(value.stderr, Math.floor(maxPreviewBytes / 2))
      const projected = { ...value, stdout, stderr }
      // NX-39：把「这一份被换成了预览」提到 ToolResult 上，让运行时有可数的信号。只认流自己的
      // previewTruncated，不认 storageTruncated——后者是存盘时的上限，与进历史的那份是不是预览无关。
      return { value: projected, isError: result.isError || !!stdout.storageError || !!stderr.storageError,
        previewTruncated: !!stdout.previewTruncated || !!stderr.previewTruncated,
        content: [{ type: 'text', text: JSON.stringify(projected, null, 2) }] }
    }
    const text = ctx.tools.renderResult(result), bytes = Buffer.from(text)
    if (bytes.length <= maxPreviewBytes) return result
    ctx.sandbox.resolvePath(directory)
    const saved = await store.save(execution.sessionId, text, execution.signal)
    const { head, tail, omittedBytes, resumeOffset } = previewWindow(bytes, bytes, bytes.length, maxPreviewBytes, tailLimit)
    const preview = head.toString('utf8')
    const window = { ...(tail.length ? { tail: tail.toString('utf8') } : {}), omittedBytes, resumeOffset }
    return { ...result, value: { ...saved, preview, ...window }, previewTruncated: true,
      content: [{ type: 'text', text: `${preview}\n[tool_result ${JSON.stringify({ ...saved, originalBytes: bytes.length, ...window })}; use read_tool_result with ref and offset=${resumeOffset}]` }] }
  }), 'register tool result projection')
  ctx.effect(() => ctx.tools.register({
    name: 'read_tool_result',
    exposeErrors: true,
    origin: 'builtin', effect: 'read',
    description: 'Read a stored tool result from this session using its ref. Truncated results may include text (head), tail (end), omittedBytes (missing middle) and resumeOffset (middle start). UTF-8 byte offset starts at 0; use nextOffset until eof. For sparse command output, availableRanges identifies readable byte intervals; unavailable=true means the requested middle was not saved and nextOffset points to the tail. captureTruncated means collection was bounded. References survive restart while result files remain.',
    parameters: { type: 'object', properties: { ref: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 1, maximum: store.maxReadBytes } }, required: ['ref'] },
    async execute(args, execution) {
      ctx.sandbox.resolvePath(directory)
      return store.read(execution.sessionId, args.ref, args.offset, args.maxBytes, execution.signal)
    },
  }), 'register read_tool_result')
}
