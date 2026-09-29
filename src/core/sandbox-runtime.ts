import type { ApprovalRequest, SandboxConfig } from './contracts.js'
import path from 'node:path'
import { resolveInside } from '../utils/path.js'

export class SandboxRuntime {
  workspace: string
  autoApprove: boolean
  allowHosts: string[]
  #approver?: (request: ApprovalRequest) => Promise<boolean>
  constructor({ workspace = process.cwd(), autoApprove = false, allowHosts = ['localhost', '127.0.0.1', '[::1]'] }: SandboxConfig = {}) {
    this.workspace = path.resolve(workspace)
    this.autoApprove = autoApprove
    this.allowHosts = allowHosts
  }
  resolvePath(requested: unknown) { return resolveInside(this.workspace, requested) }
  setApprover(fn: (request: ApprovalRequest) => Promise<boolean>) {
    this.#approver = fn
    return () => { if (this.#approver === fn) this.#approver = undefined }
  }
  async approve(request: ApprovalRequest) {
    request.signal?.throwIfAborted()
    if (this.autoApprove) return { approved: true, source: 'auto' }
    if (!this.#approver) throw new Error('write requires user approval, but no approval channel is set')
    const approver = this.#approver
    const approved = await (request.approval ? request.approval(() => approver(request)) : approver(request))
    request.signal?.throwIfAborted()
    if (!approved) throw new Error('user rejected this operation')
    return { approved: true, source: 'user' }
  }
  inspectCommand(command: unknown) {
    const deny = (reason: string) => ({ action: 'deny', reason })
    if (typeof command !== 'string' || !command.trim()) return deny('command is required')
    // This policy catches accidental dangerous commands. Approval is the execution boundary.
    let expanded
    try {
      expanded = command.replace(/\$\{([A-Za-z_][\w]*)\}|\$([A-Za-z_][\w]*)/g, (_, braced, bare) => {
        const value = process.env[braced ?? bare]
        if (value === undefined) throw new Error('unset environment variable in command')
        return value
      })
      expanded = expanded.replace(/(^|[\s"'])~(?=\/|[\s"']|$)/g, (_, prefix) => {
        const home = process.env.HOME ?? process.env.USERPROFILE
        if (!home) throw new Error('unset home path')
        return prefix + home
      })
    } catch (error) { return deny(error instanceof Error ? error.message : String(error)) }
    if (/\b(?:sudo|su)\b/.test(expanded)) return deny('sudo/su is blocked')
    if (/\brm\s+(?:(?:-[A-Za-z]*r[A-Za-z]*|--recursive)\b|[^;&|\n]*\s(?:-[A-Za-z]*r[A-Za-z]*|--recursive)\b)/i.test(expanded)) return deny('recursive delete is blocked')
    if (/\b(?:curl|wget)\b[^\n]*\|\s*(?:\S*\/)?(?:sh|bash|zsh)\b/.test(expanded)) return deny('piping curl/wget into a shell is blocked')
    if (/(?:^|[\s"'=])(?:[^\s"']*[\\/])?\.\.(?:[\\/]|[\s"']|$)/.test(expanded)) return deny('.. path escape is blocked')
    // Tokenize quoted paths and redirections; this is intentionally not a shell parser.
    const tokens = [...expanded.matchAll(/"[^"]*"|'[^']*'|[^\s|;&<>]+/g)]
    let networkTool = false
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index][0].replace(/^["']|["']$/g, '')
      let executable = index === 0 || /[|;&\n]\s*$/.test(expanded.slice(0, (tokens[index].index ?? 0)))
      if (executable) networkTool = false
      const basename = path.posix.basename(token)
      if (executable && ['curl', 'wget'].includes(basename)) networkTool = true
      const urlLike = /^https?:\/\//i.test(token)
      const hostLike = networkTool && !token.startsWith('-') && /^(?:localhost|\d+\.\d+\.\d+\.\d+|\[[^\]]+\]|[\w-]+\.[\w.-]+)(?::\d+)?(?:\/|$)/.test(token)
      if (urlLike || hostLike) {
        try {
          const host = new URL(urlLike ? token : `http://${token}`).hostname
          if (!this.allowHosts.includes(host)) return deny('unauthorized outbound request')
        } catch { return deny('unauthorized outbound request') }
      } else if (/^(?:\/|[A-Za-z]:[\\/])/.test(token)) {
        const normalized = token.replace(/\\/g, '/')
        if (token === '/dev/null') { executable = false; continue }
        // Standard executable locations are allowed only at a command position.
        if (executable && /^\/(?:bin|usr\/bin)\/[^/]+$/.test(token)) { executable = false; continue }
        if (/^\/(?:etc|dev|proc|sys|root|boot)(?:\/|$)/.test(normalized)) return deny('system path is blocked')
        try { this.resolvePath(token) } catch (error) { return deny(error instanceof Error ? error.message : String(error)) }
      }
      executable = false
    }
    return { action: 'allow', reason: undefined }
  }
  assertCommand(command: unknown) {
    const result = this.inspectCommand(command)
    if (result.action === 'deny') throw new Error(result.reason)
    return result
  }
}
