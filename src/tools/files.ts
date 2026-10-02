import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, Arguments, Execution } from '../core/contracts.js'
import path from 'node:path'
import { positiveLimit, readTextRange } from '../core/bounded-text.js'
import { searchFiles } from '../core/bounded-search.js'
import type { FileSnapshot } from '../core/file-edit.js'
import { snapshot, checkHash, replaceUnique, unifiedDiff, commitFile, validateText, fingerprint, FileSizeLimit } from '../core/file-edit.js'
import { TaskChanges, taskChanges } from '../core/task-changes.js'
import { taskReport } from '../core/task-verification.js'
import { requestTrace } from '../core/task-trace.js'

export const name = 'mini-tools-files'
export const inject = ['tools', 'sandbox']

export function matchFilePattern(filename: string, pattern = '') {
  const normalized = filename.replace(/\\/g, '/')
  if (!pattern.includes('*')) return normalized.includes(pattern)
  let expression = ''
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index++
        if (pattern[index + 1] === '/') { expression += '(?:.*/)?'; index++ }
        else expression += '.*'
      } else expression += '[^/]*'
    } else expression += char.replace(/[\^$+?.()|{}[\]\\]/g, '\\$&')
  }
  return new RegExp(`^(?:${pattern.includes('/') ? '' : '(?:.*/)?'}${expression})$`).test(normalized)
}

export interface FilesConfig { workspace?: string; maxLines?: number; maxOutputBytes?: number; maxScanBytes?: number; maxResults?: number; maxEntries?: number; maxDepth?: number; maxFileBytes?: number; maxEditBytes?: number; maxTrackedFiles?: number }

export function apply(ctx: Context, config: FilesConfig = {}) {
  const limits = {
    maxLines: positiveLimit(config.maxLines, 200, 'maxLines'),
    maxOutputBytes: positiveLimit(config.maxOutputBytes, 32 * 1024, 'maxOutputBytes'),
    maxScanBytes: positiveLimit(config.maxScanBytes, 8 * 1024 * 1024, 'maxScanBytes'),
  }
  const resolve = (requested: unknown) => ctx.sandbox.resolvePath(requested)
  const maxEditBytes = positiveLimit(config.maxEditBytes, 1024 * 1024, 'maxEditBytes')
  const maxTrackedFiles = positiveLimit(config.maxTrackedFiles, 100, 'maxTrackedFiles')
  const editing = new Set<string>()
  const relative = (target: string) => path.relative(ctx.sandbox.workspace, target).replace(/\\/g, '/')
  // Optional service lookup keeps direct, session-less file tools available.
  const sessions = () => ctx.get('sessions') as Context['sessions'] | undefined
  async function mutate(tool: 'edit_file' | 'write_file', args: Arguments, exec: Execution) {
    const target = resolve(args.path)
    const file = relative(target)
    const journal = TaskChanges.forExecution(sessions(), exec, maxTrackedFiles)
    if (editing.has(target)) throw new Error('file is already being edited; retry after the pending edit')
    editing.add(target)
    let changeId: string | undefined, committed = false
    try {
      const before = await snapshot(target, maxEditBytes, exec.signal)
      await journal?.observe(file, before)
      const observedHash = journal?.expected(file)
      checkHash(before.hash, args.expectedHash === undefined ? observedHash : args.expectedHash)
      let text: string, range: string
      if (tool === 'edit_file') {
        if (before.text === null) throw new Error('file does not exist; use write_file to create it')
        const replaced = replaceUnique(before.text, args.oldText, args.newText)
        text = replaced.text
        range = `line ${replaced.line}, replace ${Buffer.byteLength(args.oldText as string)} bytes with ${Buffer.byteLength(args.newText as string)} bytes`
      } else {
        validateText(args.content, maxEditBytes)
        text = args.content
        range = `${before.text === null ? 'create' : 'replace entire file'} (${Buffer.byteLength(text)} bytes)`
      }
      validateText(text, maxEditBytes)
      const diff = unifiedDiff(relative(target), before.text, text)
      changeId = await journal?.start({ path: file, tool, toolCallId: exec.toolCallId, before, after: { text, hash: fingerprint(text), mode: before.mode, location: before.location } })
      if (before.text === text) {
        if (changeId) await journal!.finish(changeId, 'unchanged')
        return { path: file, status: 'unchanged', beforeHash: before.hash, afterHash: before.hash, diff: '' }
      }
      const preview = Array.from(diff).slice(0, 4000).join('')
      await ctx.sandbox.approve({ tool, summary: `${tool} ${relative(target)}: ${range}\nexpectedHash=${before.hash}\n${preview}${preview.length < diff.length ? '\n[approval diff truncated]' : ''}`, signal: exec.signal, approval: exec.approval })
      await commitFile(() => resolve(args.path), before, text, maxEditBytes, exec.signal)
      committed = true
      if (changeId) await journal!.finish(changeId, 'applied')
      return { path: relative(target), status: 'applied', beforeHash: before.hash, afterHash: fingerprint(text), diff }
    } catch (error) {
      if (journal && !committed) {
        changeId ??= await journal.start({ path: file, tool, toolCallId: exec.toolCallId })
        await journal.finish(changeId, 'failed', error instanceof Error ? error.message : String(error))
      }
      if (committed) throw new Error('file was committed but result persistence is uncertain; verify before continuing', { cause: error })
      throw error
    } finally { editing.delete(target) }
  }
  const searchLimits = {
    ...limits,
    maxResults: positiveLimit(config.maxResults, 200, 'maxResults'),
    maxEntries: positiveLimit(config.maxEntries, 10000, 'maxEntries'),
    maxDepth: positiveLimit(config.maxDepth, 64, 'maxDepth'),
    maxFileBytes: positiveLimit(config.maxFileBytes, 1024 * 1024, 'maxFileBytes'),
    maxTotalBytes: limits.maxScanBytes,
  }
  const parameters = (properties: Arguments, required: string[] = []) => ({ type: 'object', properties, required })
  const string = { type: 'string' }
  const searchParameters = { path: string, pattern: string, includeIgnored: { type: 'boolean' }, offset: { type: 'integer', minimum: 0 }, maxResults: { type: 'integer', minimum: 1, maximum: searchLimits.maxResults } }
  const definitions: ToolDefinition[] = [
    {
      name: 'request_trace', description: 'Inspect a bounded request-by-request trace for the current task across continuation/restart. Links request/run identity, context projection, usage, completion, tool result status and file/check evidence IDs. Omits prompts, reasoning, arguments, result bodies and logs; pages are not snapshots.',
      parameters: parameters({ requestOffset: { type: 'integer', minimum: 0 }, maxRequests: { type: 'integer', minimum: 1, maximum: 100 } }),
      execute(args, exec) {
        const service = sessions()
        if (!exec.sessionId || !service) throw new Error('request_trace requires a session')
        const requestOffset = args.requestOffset ?? 0
        if (typeof requestOffset !== 'number' || !Number.isSafeInteger(requestOffset) || requestOffset < 0) throw new Error('requestOffset must be a nonnegative integer')
        return requestTrace(service, exec.sessionId, requestOffset, positiveLimit(args.maxRequests, 20, 'maxRequests', 100))
      },
    },
    {
      name: 'task_report', description: 'Inspect delivery evidence for the current task across continuation/restart: confirmed file edits, current-version check coverage, failed/unknown/stale checks and run status. Passing checks cover declared files/commands only and never assert task acceptance. File and verification pages are independent; use next offsets. Logs remain in verification events and original Bash results.',
      parameters: parameters({ fileOffset: { type: 'integer', minimum: 0 }, verificationOffset: { type: 'integer', minimum: 0 }, maxFiles: { type: 'integer', minimum: 1, maximum: maxTrackedFiles }, maxRecords: { type: 'integer', minimum: 1, maximum: 100 } }),
      async execute(args, exec) {
        const service = sessions()
        if (!exec.sessionId || !service) throw new Error('task_report requires a session')
        const offset = (value: unknown) => { if (value === undefined) return 0; if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('offset must be a nonnegative integer'); return value }
        return taskReport(service, exec.sessionId, file => resolve(file), maxEditBytes, exec.signal, offset(args.fileOffset), offset(args.verificationOffset), positiveLimit(args.maxFiles, Math.min(20, maxTrackedFiles), 'maxFiles', maxTrackedFiles), positiveLimit(args.maxRecords, 20, 'maxRecords', 100))
      },
    },
    {
      name: 'read_file', description: 'Read a bounded UTF-8 line range with line numbers and nextLine/eof. Includes a full-file SHA-256 for expectedHash when within the edit limit. Use startLine to continue.',
      parameters: parameters({ path: string, startLine: { type: 'integer', minimum: 1 }, maxLines: { type: 'integer', minimum: 1, maximum: limits.maxLines } }, ['path']),
      async execute(args, exec) {
        const target = resolve(args.path)
        let before: FileSnapshot | undefined
        try { before = await snapshot(target, maxEditBytes, exec.signal) }
        catch (error) { if (!(error instanceof FileSizeLimit)) throw error }
        if (before?.text === null) throw new Error('file does not exist')
        const result = await readTextRange(target, positiveLimit(args.startLine, 1, 'startLine'), positiveLimit(args.maxLines, limits.maxLines, 'maxLines', limits.maxLines), limits, exec.signal)
        if (before) checkHash((await snapshot(resolve(args.path), maxEditBytes, exec.signal)).hash, before.hash)
        if (before) await TaskChanges.forExecution(sessions(), exec, maxTrackedFiles)?.read(relative(target), before)
        return result + (before ? `\n[read_file hash=${before.hash}]` : '\n[read_file hash=unavailable reason=edit_byte_limit]')
      },
    },
    {
      name: 'write_file', description: 'Create or replace one bounded UTF-8 file after approval showing diff. Pass expectedHash from read_file (missing for creation). Conflicts refuse the write; successful result contains exact diff and hashes.',
      parameters: parameters({ path: string, content: string, expectedHash: string }, ['path', 'content']),
      async execute(args, exec) { return mutate('write_file', args, exec) },
    },
    {
      name: 'edit_file', description: 'Replace one unique exact oldText, preserving line endings, after approval showing range and diff. Pass expectedHash from read_file to reject stale edits. Returns diff and hashes.',
      parameters: parameters({ path: string, oldText: string, newText: string, expectedHash: string }, ['path', 'oldText', 'newText']),
      async execute(args, exec) { return mutate('edit_file', args, exec) },
    },
    {
      name: 'task_changes', description: 'Inspect confirmed file-tool edits and failed/unknown attempts for the current task, across continuation/restart. Returns baseline diff, hashes and current external-change flags; paginated by files. Bash/external changes are not attributed.',
      parameters: parameters({ includeDiff: { type: 'boolean' }, offset: { type: 'integer', minimum: 0 }, maxFiles: { type: 'integer', minimum: 1, maximum: maxTrackedFiles } }),
      async execute(args, exec) {
        const service = sessions()
        if (!exec.sessionId || !service) throw new Error('task_changes requires a session')
        if (args.includeDiff !== undefined && typeof args.includeDiff !== 'boolean') throw new Error('includeDiff must be boolean')
        const offset = args.offset ?? 0
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a nonnegative integer')
        return taskChanges(service, exec.sessionId, file => resolve(file), maxEditBytes, exec.signal, args.includeDiff !== false, offset, positiveLimit(args.maxFiles, maxTrackedFiles, 'maxFiles', maxTrackedFiles))
      },
    },
    {
      name: 'glob', description: 'List bounded workspace matches. Returns matches, nextOffset, eof, reason and skipped counts. Use path to narrow scans; offset rescans current files. Default ignores .git/node_modules/dist/.mini-dsh and skips symlinks.',
      parameters: parameters(searchParameters),
      async execute(args, exec) { return searchFiles(resolve, matchFilePattern, args, searchLimits, exec.signal, false) },
    },
    {
      name: 'grep', description: 'Search nonempty literal text with file/line numbers in bounded UTF-8 scans. Returns matches, nextOffset, eof, reason and skipped counts. Narrow path/pattern when scan limits are reached; includeIgnored opts into ignored directories.',
      parameters: parameters({ ...searchParameters, query: string }, ['query']),
      async execute(args, exec) { return searchFiles(resolve, matchFilePattern, args, searchLimits, exec.signal, true) },
    },
  ]
  for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition), `register ${definition.name}`)
}
