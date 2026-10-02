import type { ApprovalRequest, SandboxConfig } from './contracts.js'
import os from 'node:os'
import path from 'node:path'
import { resolveInside } from '../utils/path.js'

// NX-32：命令闸门是**有意的粗粒度形状检查**，不是 shell 解析器。
//
// 收缩前这里装着约 380 行的启发式词法：分词后的命令段状态机、`$(...)`／反引号／`sh -c`／`eval`
// 的递归抽取、按引号与转义语义的环境展开与 `for`／`NAME=` 绑定、保留字与算子之后的命令位前视，
// 以及三种取网工具操作数模型。它们的判据是「这串文本会不会被 shell 执行」——而 shell 的语法是
// 上下文相关的，用启发式逼近它**没有终点**：NX-26 补了保留字，NX-30 补了算子，NX-31 又冒出包装
// 命令（`env curl x`／`timeout 5 curl x`），后面还有进程替换、`sh -c` 嵌套混淆。每修一处必露下一处，
// 而它占到了整个 `src/` 的 14.6%，是最大的单个文件。
//
// 最要紧的是：**它在唯一没有审批兜底的地方（`autoApprove`，评测跑用的就是它）也拦不住**——文档
// 早已写明 `node -e`／`python -c` 的程序字符串不在覆盖内，而实测里模型自己写 `node -e` 探针有 75 次。
//
// 因此这里只保留**少量、稳定、无误判**的判据，其余一律撤回并登记为已知缺口（见 R-20 与矩阵）：
//   ① 三个整串正则：`sudo`／`su`、递归删除、`curl|wget` 管道进 shell
//   ② token 上的 `..` 路径分量、反斜杠 UNC、盘符与绝对路径、系统路径，以及对工作区外路径与软链的解析
//   ③ 出网：**按工具拦**——命令段的首个词是取网工具即拒，不看目标、不做操作数模型
// 真正的边界不在这里：工作区与软链由 `utils/path.ts` 的 `resolveInside` 守住（文件工具与 bash 的
// cwd 直接调它，不经本文件），危险操作由人工审批守住。两者都不是操作系统隔离。

// 出网判据：这些工具**整段被拒**。原来这里是一张「工具 → 操作数模型」的表（url-or-host／operand／
// remote-spec），要逐工具判断「哪个位置参数才是目标」，还配了每种工具「取值不是目标」的旗标白名单。
// 那份知识既脆弱又判不全（漏一个旗标就误拒），换来的精度却只体现在 `curl -o out.txt host` 这类
// 组合上。现在改成按段首工具名一刀切：**不解析目标，也就不需要那些表**。
const networkCommands = new Set([
  'curl', 'wget', 'ssh', 'sftp', 'scp', 'rsync', 'nc', 'netcat', 'ncat', 'telnet',
  'ping', 'dig', 'nslookup', 'host',
])

const hereDocumentShells = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const maxHereDocuments = 16
const maxHereDocumentBytes = 256 * 1024
const maxHereDocumentDepth = 3

type HereDocumentRedirect = {
  delimiter: string
  stripTabs: boolean
  shellConsumer: boolean
}

type HereDocumentSplit = {
  commandText: string
  shellBodies: string[]
  error?: string
}

type HereDocumentBudget = { count: number; bodyBytes: number }

function segmentCommandWord(line: string, redirectStart: number) {
  let segmentStart = 0
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let index = 0; index < redirectStart; index++) {
    const char = line[index]
    if (escaped) { escaped = false; continue }
    if (char === '\\' && quote !== "'") { escaped = true; continue }
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') { quote = char; continue }
    if (/[|;&]/.test(char)) segmentStart = index + 1
  }
  const segment = line.slice(segmentStart, redirectStart)
  const word = segment.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s|;&<>]+/)?.[0] ?? ''
  return word.replace(/^["']|["']$/g, '')
}

function hereDocumentRedirects(line: string): HereDocumentRedirect[] | undefined {
  const redirects: HereDocumentRedirect[] = []
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (escaped) { escaped = false; continue }
    if (char === '\\' && quote !== "'") { escaped = true; continue }
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === '#' && (index === 0 || /[\s|;&]/.test(line[index - 1]))) break
    if (char !== '<' || line[index - 1] === '<' || line[index + 1] !== '<' || line[index + 2] === '<') continue

    const redirectStart = index
    index += 2
    const stripTabs = line[index] === '-'
    if (stripTabs) index++
    while (line[index] === ' ' || line[index] === '\t') index++
    if (index >= line.length || /[|;&<>\r\n]/.test(line[index])) return undefined

    let delimiter = ''
    let delimiterQuote: "'" | '"' | undefined
    let delimiterEscaped = false
    for (; index < line.length; index++) {
      const delimiterChar = line[index]
      if (delimiterEscaped) { delimiter += delimiterChar; delimiterEscaped = false; continue }
      if (delimiterChar === '\\' && delimiterQuote !== "'") { delimiterEscaped = true; continue }
      if (delimiterQuote) {
        if (delimiterChar === delimiterQuote) delimiterQuote = undefined
        else delimiter += delimiterChar
        continue
      }
      if (delimiterChar === "'" || delimiterChar === '"') { delimiterQuote = delimiterChar; continue }
      if (/[\s|;&<>\r\n]/.test(delimiterChar)) break
      delimiter += delimiterChar
    }
    if (delimiterQuote || delimiterEscaped || !delimiter) return undefined

    const consumer = segmentCommandWord(line, redirectStart).replace(/\\/g, '/')
    redirects.push({ delimiter, stripTabs, shellConsumer: hereDocumentShells.has(path.posix.basename(consumer)) })
    index--
  }
  return redirects
}

function splitHereDocuments(command: string, budget: HereDocumentBudget): HereDocumentSplit {
  let cursor = 0
  let commandText = ''
  const shellBodies: string[] = []
  while (cursor < command.length) {
    const lineEnd = command.indexOf('\n', cursor)
    const afterLine = lineEnd < 0 ? command.length : lineEnd + 1
    const line = command.slice(cursor, lineEnd < 0 ? command.length : lineEnd)
    const redirects = hereDocumentRedirects(line)
    commandText += command.slice(cursor, afterLine)
    cursor = afterLine
    if (redirects === undefined) return { commandText, shellBodies, error: 'here-document delimiter is malformed' }
    if (redirects.length === 0) continue
    budget.count += redirects.length
    if (budget.count > maxHereDocuments) return { commandText, shellBodies, error: `more than ${maxHereDocuments} here-documents are blocked` }

    for (const redirect of redirects) {
      const bodyStart = cursor
      let bodyEnd = -1
      while (cursor <= command.length) {
        const candidateEnd = command.indexOf('\n', cursor)
        const candidateAfter = candidateEnd < 0 ? command.length : candidateEnd + 1
        const rawCandidate = command.slice(cursor, candidateEnd < 0 ? command.length : candidateEnd).replace(/\r$/, '')
        const candidate = redirect.stripTabs ? rawCandidate.replace(/^\t+/, '') : rawCandidate
        if (candidate === redirect.delimiter) {
          bodyEnd = cursor
          cursor = candidateAfter
          break
        }
        if (candidateEnd < 0) break
        cursor = candidateAfter
      }
      if (bodyEnd < 0) return { commandText, shellBodies, error: 'here-document is not terminated' }
      const body = command.slice(bodyStart, bodyEnd)
      budget.bodyBytes += Buffer.byteLength(body)
      if (budget.bodyBytes > maxHereDocumentBytes) {
        return { commandText, shellBodies, error: `here-document bodies exceed ${maxHereDocumentBytes} bytes` }
      }
      if (redirect.shellConsumer) {
        shellBodies.push(redirect.stripTabs ? body.replace(/^\t/gm, '') : body)
      }
    }
  }
  return { commandText, shellBodies }
}

// `..` 逃逸的判据是 **token 级**的（NX-18）：问「这个 token 是不是一个以 `..` 为分量的路径」，而不是
// 「整串文本里有没有出现过两个点」。三条同时成立才算：
//   ① 去引号正文**不含空白**——含空白的 token 不是可寻址路径。这条先例来自 NX-24-5（真实的根级目录名
//      不以空白开头），本次沿用而不是新立，于是 `echo "see ../docs for details"` 放行。
//   ② 按 `[\\/=]` 切分后**存在一个分量恰为 `..`**——判分量而不判子串：`a..b`、`...`、`a/x../y` 都不算。
//      `=` 一并计入边界，否则 `--file=../secret` 会因「分量是 `--file=..`」被放过去，顺着这次放宽新开一个洞。
//   ③ 正文含分隔符，**或**它在原串里是**裸词**。这是本轮唯一的放宽：只放过引号成词且无分隔符的 `..`
//      （真实语料里那是正则，如 `grep -n ".." src/index.ts`），裸 `..`（`ls ..`、`cd ..`）照旧拒绝。
// 已知不修的相邻形状：`--grep=..` 这类「`=` 后紧跟 `..` 且无分隔符」的惰性文本仍被拒——它与 `--dir=..`
// 在形状上无判据可用，按 NX-29 的口径处理：**没有可用的形状判据就不放宽**。判据与残险见 R-20 与 PLAN 的 D-17。
function isPathEscape(raw: string, body: string) {
  if (/\s/.test(body)) return false
  if (!body.split(/[\\/=]/).includes('..')) return false
  return /[\\/=]/.test(body) || raw === body
}

// Git for Windows mounts its POSIX `/tmp` at the Windows user temp directory. Feeding that spelling
// directly to node:path instead resolves it from the current drive root (`D:\tmp`, for example), so
// the workspace gate rejects a path that the shell can legitimately use. Translate only this one
// observed mount point, then reuse the ordinary realpath/symlink boundary instead of string-whitelisting
// every `/tmp` token. Other platforms already agree with node:path and keep the workspace-only rule.
function resolveGitBashTemp(requested: string) {
  if (process.platform !== 'win32' || !/^\/tmp(?:\/|$)/.test(requested)) return undefined
  const normalized = path.posix.normalize(requested)
  if (normalized !== '/tmp' && !normalized.startsWith('/tmp/')) return undefined
  return resolveInside(os.tmpdir(), path.posix.relative('/tmp', normalized))
}

export class SandboxRuntime {
  workspace: string
  autoApprove: boolean
  #approver?: (request: ApprovalRequest) => Promise<boolean>
  constructor({ workspace = process.cwd(), autoApprove = false }: SandboxConfig = {}) {
    this.workspace = path.resolve(workspace)
    this.autoApprove = autoApprove
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
    if (typeof command !== 'string' || !command.trim()) return { action: 'deny' as const, reason: 'command is required' }
    return this.#inspect(command)
  }
  #inspect(command: string, hereDocumentDepth = 0, hereDocumentBudget: HereDocumentBudget = { count: 0, bodyBytes: 0 }): { action: 'allow' | 'deny'; reason: string | undefined } {
    const deny = (reason: string): { action: 'deny'; reason: string } => ({ action: 'deny', reason })
    const hereDocuments = splitHereDocuments(command, hereDocumentBudget)
    if (hereDocuments.error) return deny(hereDocuments.error)
    command = hereDocuments.commandText
    if (hereDocuments.shellBodies.length > 0 && hereDocumentDepth >= maxHereDocumentDepth) {
      return deny(`shell here-document nesting exceeds ${maxHereDocumentDepth} levels`)
    }
    for (const body of hereDocuments.shellBodies) {
      const result = this.#inspect(body, hereDocumentDepth + 1, hereDocumentBudget)
      if (result.action === 'deny') return { action: 'deny', reason: `in shell here-document: ${result.reason}` }
    }
    // 三个整串正则。它们不依赖分词，也不区分「数据」与「代码」——这正是它们**廉价且稳定**的原因。
    // D-18 只在到达这里之前剥离非 shell 的 here-doc 数据正文；普通引号里的同形文本仍承受这项代价。
    // `..` 原先是第四条，已按 NX-18 改成下面的 token 级判定：它承受的是同一句代价，但恰好有一条
    // 可用的形状判据（路径分量），另三条没有——所以只有它被放出来，另三条留在原状。
    if (/\b(?:sudo|su)\b/.test(command)) return deny('sudo/su is blocked')
    if (/\brm\s+(?:(?:-[A-Za-z]*r[A-Za-z]*|--recursive)\b|[^;&|\n]*\s(?:-[A-Za-z]*r[A-Za-z]*|--recursive)\b)/i.test(command)) return deny('recursive delete is blocked')
    if (/\b(?:curl|wget)\b[^\n]*\|\s*(?:\S*\/)?(?:sh|bash|zsh)\b/.test(command)) return deny('piping curl/wget into a shell is blocked')
    // 双引号按 shell 语义识别 \"：否则内联脚本（node -e "…"）里的转义引号会提前闭合引号，
    // 把注释和字符串碎片暴露成独立 token，闸门就会去检查 shell 根本看不到的“路径”。
    const tokens = [...command.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s|;&<>]+/g)]
    // 游标：上一个 token 的结束位置。段界取**两个 token 之间的空隙**里有没有 `|`／`;`／`&`／换行，
    // 而不是把整串按分隔符切开——`awk '/stage(7|7)|phase 7/{f=1} f'` 里的 `|` 在被引号吃掉的 token
    // 内部，按文本切会凭空切出一段来。
    let previousEnd = 0
    let egress = false
    for (let index = 0; index < tokens.length; index++) {
      const raw = tokens[index][0]
      const start = tokens[index].index ?? 0
      // 「本 token 是不是它所属段的第一个词」。它有两个用处，缺一不可：出网按段首工具名判，
      // 以及下面 `/bin`／`/usr/bin` 命令词豁免的兜底——**去掉它，`cp foo /usr/bin/evil` 会被那条
      // 白名单静默吃掉**（`/usr/bin/evil` 是实参不是命令，必须继续走越界解析）。
      const atSegmentStart = index === 0 || /[|;&\n]/.test(command.slice(previousEnd, start))
      // 必须在所有 continue 之前更新：下面每条 continue 都会跳过循环末尾，写在那里会少记一个 token。
      previousEnd = start + raw.length
      const token = raw.replace(/^["']|["']$/g, '')
      // `..` 逃逸排在最前：整串正则时代它也是最先求值的那条判据，这样保留「有 `..` 时理由就是 `..`」。
      if (isPathEscape(raw, token)) return deny('.. path escape is blocked')
      // 段首是取网工具即记下出网，**不去看它后面跟的是什么**。判定放在路径检查之前求值、之后裁决，
      // 这样 `wget -O /etc/passwd http://localhost/x` 的理由仍是系统路径而不是出网。
      if (atSegmentStart && networkCommands.has(path.posix.basename(token))) egress = true
      if (token === '/dev/null') continue
      if (atSegmentStart && /^\/(?:bin|usr\/bin)\/[^/]+$/.test(token)) continue
      if (/^\\\\[^\\/]+\\/.test(token)) {
        // 反斜杠 UNC：`\\server\share`、`\\?\C:\…`、`\\.\pipe\…`。正则要求 `\\`＋主机段＋`\`，
        // 不能用 `^\\\\` 一刀切——`printf '\\n'` 这类正当写法会中招。与位置无关，任意 token 都查。
        // 也不能只靠下面的路径分支：POSIX 上 path.resolve 会把 `\\server\share` 当成工作区内的
        // 相对名而放行，只有 Windows 才解析成 UNC。
        return deny('UNC path is blocked')
      }
      if (/^(?:\/|[A-Za-z]:[\\/])/.test(token)) {
        const normalized = token.replace(/\\/g, '/')
        if (/^\/(?:etc|dev|proc|sys|root|boot)(?:\/|$)/.test(normalized)) return deny('system path is blocked')
        // 纯分隔符串（//、///）不含路径分量，解析到的是根而非可读内容；单个 / 仍是真实的根目录操作数。
        if (/^\/{2,}$/.test(token)) continue
        // 任意条前导斜杠、但首个路径分量含空白的 token 不是可寻址的根级路径：真实的根级目录名不会
        // 以空白开头。这个形状来自被引号成词的**正文**——JS 注释（`// helper`）与 awk／sed 的程序
        // 正文（`/^## 11/,/^## 12/`）同形，此前只认双斜杠，于是单斜杠的 awk／sed 正文被当成绝对路径
        // 误拒（实测 782 次真实 bash 调用里 5 条）。系统路径与出网检查已在上面执行，不受影响；
        // 单个 `/`（首个分量为空）与 `//etc`、`//home/…`（首个分量干净）不在此列，仍走 resolvePath。
        if (/^\/+/.test(token) && /\s/.test(token.replace(/^\/+/, '').split('/')[0])) continue
        try {
          if (resolveGitBashTemp(token) !== undefined) continue
        } catch (error) { return deny(error instanceof Error ? error.message : String(error)) }
        try { this.resolvePath(token) } catch (error) { return deny(error instanceof Error ? error.message : String(error)) }
      }
    }
    if (egress) return deny('network tool is not covered by the command gate; it needs approval')
    return { action: 'allow', reason: undefined }
  }
  assertCommand(command: unknown) {
    const result = this.inspectCommand(command)
    if (result.action === 'deny') throw new Error(result.reason)
    return result
  }
}
