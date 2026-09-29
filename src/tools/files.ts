import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, Arguments } from '../core/contracts.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { positiveLimit, readTextRange } from '../core/bounded-text.js'

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
    } else expression += char.replace(/[\^$+?.()|{}\[\]\\]/g, '\\$&')
  }
  return new RegExp(`^(?:${pattern.includes('/') ? '' : '(?:.*/)?'}${expression})$`).test(normalized)
}

export interface FilesConfig { workspace?: string; maxLines?: number; maxOutputBytes?: number; maxScanBytes?: number }

export function apply(ctx: Context, config: FilesConfig = {}) {
  const limits = {
    maxLines: positiveLimit(config.maxLines, 200, 'maxLines'),
    maxOutputBytes: positiveLimit(config.maxOutputBytes, 32 * 1024, 'maxOutputBytes'),
    maxScanBytes: positiveLimit(config.maxScanBytes, 8 * 1024 * 1024, 'maxScanBytes'),
  }
  const resolve = (requested: unknown) => ctx.sandbox.resolvePath(requested)
  const parameters = (properties: Arguments, required: string[] = []) => ({ type: 'object', properties, required })
  const string = { type: 'string' }
  async function* walk(directory = '.', signal?: AbortSignal): AsyncGenerator<string> {
    signal?.throwIfAborted()
    for (const entry of await fs.readdir(resolve(directory), { withFileTypes: true })) {
      signal?.throwIfAborted()
      const relative = path.join(directory, entry.name)
      if (entry.isDirectory()) yield* walk(relative, signal)
      else if (entry.isFile()) yield relative.replace(/\\/g, '/')
    }
  }
  const definitions: ToolDefinition[] = [
    {
      name: 'read_file', description: 'Read a bounded UTF-8 line range with line numbers and nextLine/eof. Use startLine to continue. Binary, invalid UTF-8 and oversized lines fail explicitly.',
      parameters: parameters({ path: string, startLine: { type: 'integer', minimum: 1 }, maxLines: { type: 'integer', minimum: 1, maximum: limits.maxLines } }, ['path']),
      async execute(args, exec) {
        return readTextRange(resolve(args.path), positiveLimit(args.startLine, 1, 'startLine'), positiveLimit(args.maxLines, limits.maxLines, 'maxLines', limits.maxLines), limits, exec.signal)
      },
    },
    {
      name: 'write_file', description: 'Write a UTF-8 file after approval.',
      parameters: parameters({ path: string, content: string }, ['path', 'content']),
      async execute(args, exec) {
        resolve(args.path)
        if (typeof args.content !== 'string') throw new Error('content must be a string')
        await ctx.sandbox.approve({ tool: 'write_file', summary: `write ${args.path}`, signal: exec.signal, approval: exec.approval })
        const target = resolve(args.path)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(resolve(args.path), args.content, { encoding: 'utf8', signal: exec.signal })
        return `wrote ${args.path}`
      },
    },
    {
      name: 'edit_file', description: 'Replace one unique occurrence of oldText after approval.',
      parameters: parameters({ path: string, oldText: string, newText: string }, ['path', 'oldText', 'newText']),
      async execute(args, exec) {
        if (typeof args.oldText !== 'string' || !args.oldText) throw new Error('oldText is required')
        if (typeof args.newText !== 'string') throw new Error('newText must be a string')
        const original = await fs.readFile(resolve(args.path), { encoding: 'utf8', signal: exec.signal })
        const index = original.indexOf(args.oldText)
        if (index < 0) throw new Error('oldText not found')
        if (original.indexOf(args.oldText, index + 1) >= 0) throw new Error('oldText is not unique; refusing an ambiguous edit')
        await ctx.sandbox.approve({ tool: 'edit_file', summary: `edit ${args.path}`, signal: exec.signal, approval: exec.approval })
        const target = resolve(args.path)
        if (await fs.readFile(target, 'utf8') !== original) throw new Error('file changed during approval; retry the edit')
        await fs.writeFile(resolve(args.path), original.slice(0, index) + args.newText + original.slice(index + args.oldText.length), { encoding: 'utf8', signal: exec.signal })
        return `edited ${args.path}`
      },
    },
    {
      name: 'glob', description: 'List workspace files matching a substring or wildcard.',
      parameters: parameters({ pattern: string }),
      async execute(args, exec) {
        const matches: string[] = []
        for await (const file of walk('.', exec.signal)) if (matchFilePattern(file, typeof args.pattern === 'string' ? args.pattern : '')) matches.push(file)
        return matches
      },
    },
    {
      name: 'grep', description: 'Find literal text in workspace files with line numbers.',
      parameters: parameters({ query: string, pattern: string }, ['query']),
      async execute(args, exec) {
        if (typeof args.query !== 'string') throw new Error('query must be a string')
        const query = args.query
        const matches: string[] = []
        for await (const file of walk('.', exec.signal)) {
          if (!matchFilePattern(file, typeof args.pattern === 'string' ? args.pattern : '')) continue
          const content = await fs.readFile(resolve(file), { encoding: 'utf8', signal: exec.signal })
          if (content.includes('\0')) continue
          content.split(/\r?\n/).forEach((line, index) => {
            if (line.includes(query)) matches.push(`${file}:${index + 1}:${line}`)
          })
        }
        return matches.join('\n')
      },
    },
  ]
  for (const definition of definitions) ctx.effect(() => ctx.tools.register(definition), `register ${definition.name}`)
}
