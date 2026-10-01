import type { ApprovalRequest, SandboxConfig } from './contracts.js'
import path from 'node:path'
import { resolveInside } from '../utils/path.js'

// 只写标准输出、无法发起网络请求的命令。它们参数里的 URL 是数据，不是请求目标。
const stdoutOnlyCommands = new Set(['echo', 'printf'])

// 取网命令里「取值不是网络目标」的旗标。这些旗标后面的 token 只是取值，不做主机判定——
// 否则 `curl -o out.txt http://localhost/x` 会把输出文件名 out.txt 当成主机而误拒
// （`wget -O page.html`、`curl -sS -o out.json` 同理）。
// 默认仍是「检查」：不在此列（如 --url、-x/--proxy、--resolve、--connect-to）的旗标取值就是目标本身，
// 漏列一个旗标的代价是多拒，误列一个的代价是漏检——所以这张表只收「值确定不是目标」的那些。
// 短旗标按工具分别登记：同一个字母含义不同，curl 的 -O 是布尔量，wget 的 -O 取文件名。
const nonTargetValueFlags: Record<string, Set<string>> = {
  curl: new Set([
    '-o', '--output', '-D', '--dump-header', '-w', '--write-out', '-A', '--user-agent',
    '-e', '--referer', '-b', '--cookie', '-c', '--cookie-jar', '-u', '--user', '-d', '--data',
    '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii',
    '-T', '--upload-file', '-F', '--form', '--form-string', '-E', '--cert', '--key',
    '--cacert', '--capath', '-K', '--config', '-m', '--max-time', '--connect-timeout',
    '--retry', '--retry-delay', '--retry-max-time', '--limit-rate', '--max-filesize',
    '-X', '--request', '-r', '--range', '-H', '--header', '-z', '--time-cond',
    '-C', '--continue-at', '-Q', '--quote', '-t', '--telnet-option', '-P', '--ftp-port',
    '-y', '--speed-time', '-Y', '--speed-limit', '--interface', '--local-port',
    '--proto', '--proto-redir', '--oauth2-bearer',
  ]),
  wget: new Set([
    '-O', '--output-document', '-o', '--output-file', '-P', '--directory-prefix',
    '-U', '--user-agent', '-e', '--execute', '-T', '--timeout', '-t', '--tries',
    '-w', '--wait', '--waitretry', '--read-timeout', '--dns-timeout', '--connect-timeout',
    '-i', '--input-file', '-B', '--base', '--header', '--post-data', '--post-file',
    '--user', '--password', '--load-cookies', '--save-cookies', '--ca-certificate',
    '--certificate', '--private-key', '--limit-rate', '--referer', '--bind-address',
  ]),
  // NX-19-2 起纳入的工具。这些旗标的取值仍可能是文件名或数字，不是目标；
  // 未列出的旗标（如 ssh 的 -J／-W、nc 的 -x 代理、rsync 的 --rsh 里的主机）按默认检查处理。
  ssh: new Set([
    '-i', '--identity', '-o', '--option', '-l', '--login', '-p', '--port', '-F', '--config',
    '-E', '--log-file', '-c', '--cipher-spec', '-m', '--mac-spec', '-b', '--bind-interface',
    '-e', '--escape-char', '-Q', '--query-option', '-S', '--ctl-path',
  ]),
  sftp: new Set([
    '-i', '--identity', '-o', '--option', '-P', '--port', '-F', '--config', '-S', '--ssh',
    '-B', '--buffer-size', '-b', '--batch-file', '-c', '--cipher', '-l', '--limit',
  ]),
  scp: new Set([
    '-i', '--identity', '-o', '--option', '-P', '--port', '-F', '--config', '-S', '--program',
    '-c', '--cipher', '-l', '--limit',
  ]),
  rsync: new Set([
    '-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--files-from', '--log-file',
    '--password-file', '--temp-dir', '-T', '--port', '--rsync-path', '--bwlimit', '--timeout',
    '--contimeout', '--chmod', '--max-size', '--min-size', '--compare-dest', '--copy-dest',
    '--link-dest', '--partial-dir', '--out-format', '--sockopts', '--usermap', '--groupmap',
    '--address', '--suffix', '--backup-dir',
  ]),
  nc: new Set(['-w', '--wait', '-p', '--source-port', '-s', '--source', '-q', '--quit-delay', '-I', '--length', '-O', '--send-buffer', '-T', '--tos', '-G', '--source-routing-hop']),
  netcat: new Set(['-w', '--wait', '-p', '--source-port', '-s', '--source', '-q', '--quit-delay', '-I', '--length', '-O', '--send-buffer', '-T', '--tos', '-G', '--source-routing-hop']),
  ncat: new Set(['-w', '--wait', '-p', '--source-port', '-s', '--source', '-q', '--quit-delay', '-I', '--length', '-O', '--send-buffer', '-T', '--tos', '-G', '--source-routing-hop']),
  telnet: new Set(['-l', '-b', '-e', '-n', '-S', '-X', '-L']),
  ping: new Set(['-c', '-i', '-W', '-w', '-s', '-t', '-p', '-M', '-Q', '-I', '-S', '-T', '-l', '-A', '-B', '-F']),
  dig: new Set(['-b', '-c', '-f', '-k', '-p', '-q', '-t', '-y', '-E']),
  nslookup: new Set(['-port', '-querytype', '-type', '-class', '-server', '-timeout', '-retry', '-domain', '-domainname', '-rc', '-vc']),
  host: new Set(['-t', '-type', '-c', '-class', '-p', '-port', '-w', '-W', '-R', '-m', '-T', '-C']),
}

// 取网工具与它们的操作数模型。
// - url-or-host：位置参数可能是本地文件（curl 的输出、wget 的日志），只有形状像目标才检查。
// - operand：命令行里**第一个非旗标位置参数就是目标**（ssh、nc、ping 这类），所以单标签主机名
//   `ssh myhost` 也算命中；其后的位置参数是远端命令，不检查。
// - remote-spec：只有 `[user@]host:path` 这种远端规格才是目标（scp、rsync）。裸文件名 `report.pdf`
//   即便含点也是本地操作数——这正是「文件名伪主机」误报的来源。
// 清单是尽力而为，不承诺完整；未列入的工具不受这些判定约束。
const networkTools: Record<string, 'url-or-host' | 'operand' | 'remote-spec'> = {
  curl: 'url-or-host', wget: 'url-or-host',
  scp: 'remote-spec', rsync: 'remote-spec',
  ssh: 'operand', sftp: 'operand', nc: 'operand', netcat: 'operand', ncat: 'operand',
  telnet: 'operand', ping: 'operand', dig: 'operand', nslookup: 'operand', host: 'operand',
}

// 从 `[user@]host`、dig 的 `@server`、`host:port`／`host:path`、`[ipv6]:port` 里取出主机名；
// 纯数字（端口）由调用方判掉。IPv6 保留方括号，与 URL.hostname 及 allowHosts 的写法一致。
function hostOfOperand(token: string) {
  let value = token
  const at = value.lastIndexOf('@')
  if (at !== -1) value = value.slice(at + 1)
  const bracketed = /^\[([^\]]+)\]/.exec(value)
  if (bracketed) return `[${bracketed[1]}]`
  return value.split(/[:/\\]/, 1)[0] ?? ''
}

// scp／rsync 的远端规格；Windows 盘符（`C:\x`）是本地路径而不是远端主机。
function remoteSpecHost(token: string) {
  if (/^[A-Za-z]:[\\/]/.test(token)) return null
  const spec = /^(?:[^@:/\\]+@)?([^@:/\\]+):/.exec(token)
  return spec ? spec[1] : null
}

function hostnameOrNull(url: string) {
  try { return new URL(url).hostname } catch { return null }
}

// 该 token 是不是「取值不是网络目标」的旗标，且它的取值是**下一个** token。
// 长旗标带 `=` 时取值内联（`--output=x`），不需要跳过下一个。短旗标允许合并（`-sS`、`-so`）：
// 只有合并串的**最后一个**字母取下一个 token 作值，`-os x` 的 s 是 o 的内联取值。
function takesValueFromNextToken(token: string, tool: string) {
  const flags = nonTargetValueFlags[tool]
  if (!flags) return false
  if (token.startsWith('--')) return !token.includes('=') && flags.has(token)
  if (!/^-[A-Za-z]+$/.test(token)) return false
  return flags.has(`-${token[token.length - 1]}`)
}

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
    // 双引号按 shell 语义识别 \"：否则内联脚本（node -e "…"）里的转义引号会提前闭合引号，
    // 把注释和字符串碎片暴露成独立 token，闸门就会去检查 shell 根本看不到的“路径”。
    const tokens = [...expanded.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s|;&<>]+/g)]
    let networkTool = false
    let networkToolWord = ''
    let pendingValueToken = false
    let hostOperandSeen = false
    let commandWord = ''
    let pipedDownstream = false
    for (let index = 0; index < tokens.length; index++) {
      const raw = tokens[index][0]
      const token = raw.replace(/^["']|["']$/g, '')
      const start = tokens[index].index ?? 0
      let executable = index === 0 || /[|;&\n]\s*$/.test(expanded.slice(0, start))
      const basename = path.posix.basename(token)
      if (executable) {
        networkTool = false
        networkToolWord = ''
        pendingValueToken = false
        hostOperandSeen = false
        commandWord = basename
        // 本段标准输出是否接到下游命令：下游可能真的取网，所以豁免只在纯输出时成立。
        pipedDownstream = expanded.slice(start + raw.length).split(/[;&\n]/)[0].replace(/\|\|/g, '').includes('|')
      }
      if (executable && networkTools[basename]) {
        networkTool = true
        networkToolWord = basename
      }
      // 上一个 token 是本工具「取值不是网络目标」的旗标时，本 token 只是它的取值，不做主机判定；
      // 但它仍要走下面的路径分支——`curl -o /etc/cron http://localhost/x` 必须继续被拒。
      const skipHostCheck = pendingValueToken
      pendingValueToken = false
      const urlLike = /^https?:\/\//i.test(token)
      const model = networkTool ? networkTools[networkToolWord] : undefined
      let outbound = false
      let targetHost: string | null = null
      if (urlLike) {
        // 整 token 恰为 URL 的形态与命令段无关：任何段里的裸 URL 都按目标判定。
        outbound = true
        targetHost = hostnameOrNull(token)
      } else if (model && !executable && !skipHostCheck && !token.startsWith('-')) {
        if (model === 'url-or-host') {
          if (/^(?:localhost|\d+\.\d+\.\d+\.\d+|\[[^\]]+\]|[\w-]+\.[\w.-]+)(?::\d+)?(?:\/|$)/.test(token)) {
            outbound = true
            targetHost = hostnameOrNull(`http://${token}`)
          }
        } else if (model === 'remote-spec') {
          const host = remoteSpecHost(token)
          if (host) { outbound = true; targetHost = host }
        } else if (!hostOperandSeen && !token.startsWith('+')) {
          // `+short` 这类 dig 选项不算位置参数；纯数字是端口不是主机。
          hostOperandSeen = true
          const host = hostOfOperand(token)
          if (host && !/^\d+$/.test(host)) { outbound = true; targetHost = host }
        }
      }
      if (outbound) {
        // echo/printf 只能写标准输出，其参数里的 URL 不构成出网；但本段一旦接管道，下游就可能取网，仍按原规则拦截。
        if (!(stdoutOnlyCommands.has(commandWord) && !pipedDownstream)) {
          if (targetHost === null || !this.allowHosts.includes(targetHost)) return deny('unauthorized outbound request')
        }
      } else if (/^(?:\/|[A-Za-z]:[\\/])/.test(token)) {
        const normalized = token.replace(/\\/g, '/')
        if (token === '/dev/null') { executable = false; continue }
        if (executable && /^\/(?:bin|usr\/bin)\/[^/]+$/.test(token)) { executable = false; continue }
        if (/^\/(?:etc|dev|proc|sys|root|boot)(?:\/|$)/.test(normalized)) return deny('system path is blocked')
        // 纯分隔符串（//、///）不含路径分量，解析到的是根而非可读内容；单个 / 仍是真实的根目录操作数。
        if (/^\/{2,}$/.test(token)) { executable = false; continue }
        // 双斜杠开头且首个路径分量含空白的 token 不是可寻址的根级路径：真实的根级目录名不会以空白开头，
        // 这个形状来自 JS 注释或内联脚本正文被引号成词。系统路径与出网检查已在上面执行，不受影响。
        if (/^\/{2,}/.test(token) && /\s/.test(token.replace(/^\/+/, '').split('/')[0])) { executable = false; continue }
        try { this.resolvePath(token) } catch (error) { return deny(error instanceof Error ? error.message : String(error)) }
      }
      if (networkTool && takesValueFromNextToken(token, networkToolWord)) pendingValueToken = true
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
