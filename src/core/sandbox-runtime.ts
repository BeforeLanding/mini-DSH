import type { ApprovalRequest, SandboxConfig } from './contracts.js'
import path from 'node:path'
import { resolveInside } from '../utils/path.js'

// 只写标准输出、无法发起网络请求的命令。它们参数里的 URL 是数据，不是请求目标。
const stdoutOnlyCommands = new Set(['echo', 'printf'])

// 引入命令位置的 shell 保留字：它们自己不是命令，**紧随其后的一个 token** 才是命令词的起点
// （`for f in a; do curl example.com; done` 里的 `curl`）。这是一份**闭集**：终结符（`fi`／`done`／
// `esac`）之后没有新命令，`case` 后面的词是主语不是命令，`in`／`!`／`time` 不引入命令位置。
const commandIntroducers = new Set(['if', 'elif', 'while', 'until', 'do', 'then', 'else'])

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

// 递归检查的上限。片段必是父串的真子串，终止性不靠上限；上限挡的是宽度与工作量。
// 超限即拒绝：若耗尽放行，`$(a$(b$(c$(curl x))))` 就成了一个明文可复制的绕过构造。
const maxInspectionDepth = 3
const maxExecutedFragments = 32

// 配平 `$(...)` 的括号。引号内的括号不计数（`$(echo ")")`）；找不到配对的 `)` 时返回 -1，
// 该形状交给分词器按原样处理。`$((1+2))` 也走这里——内容 `(1+2)` 会被当成片段再检查一次，
// 无害，且其中的 `$(...)` 照旧被抓到。
function matchClosingParen(command: string, open: number) {
  let depth = 0
  let index = open
  while (index < command.length) {
    const char = command[index]
    if (char === '\\') { index += 2; continue }
    if (char === "'") {
      const end = command.indexOf("'", index + 1)
      index = end === -1 ? command.length : end + 1
      continue
    }
    if (char === '"') {
      index += 1
      while (index < command.length && command[index] !== '"') index += command[index] === '\\' ? 2 : 1
      index += 1
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') { depth -= 1; if (depth === 0) return index }
    index += 1
  }
  return -1
}

// shell 里**真的会被执行**的嵌套文本：单引号之外、未被反斜杠转义的 `$(...)` 与反引号。
// 引号语义与分词器同源——NX-17 的头号根因就是闸门的分词与 shell 不一致：单引号内一切原样、
// 双引号内 `\X` 转义而 `$(...)` 与反引号仍会展开、引号外 `\X` 转义。
// 双引号内照常扫描，所以这里不维护双引号状态：每次跳过 `\X` 已经足够表达「$ 未被转义」。
function extractExecutedFragments(command: string) {
  const fragments: { text: string; origin: string }[] = []
  let index = 0
  while (index < command.length) {
    const char = command[index]
    if (char === '\\') { index += 2; continue }
    if (char === "'") {
      const end = command.indexOf("'", index + 1)
      index = end === -1 ? command.length : end + 1
      continue
    }
    if (char === '`') {
      let cursor = index + 1
      let text = ''
      while (cursor < command.length && command[cursor] !== '`') {
        if (command[cursor] === '\\' && cursor + 1 < command.length) { text += command[cursor + 1]; cursor += 2; continue }
        text += command[cursor]
        cursor += 1
      }
      fragments.push({ text, origin: 'in backtick substitution: ' })
      index = cursor + 1
      continue
    }
    if (char === '$' && command[index + 1] === '(') {
      const close = matchClosingParen(command, index + 1)
      if (close === -1) { index += 2; continue }
      fragments.push({ text: command.slice(index + 2, close), origin: 'in command substitution: ' })
      index = close + 1
      continue
    }
    index += 1
  }
  return fragments
}

// 会执行 `-c` 参数的解释器（按 basename 匹配，`/bin/bash` 同样命中）。
const shellWords = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

// 从 shell 词之后找 `-c` 族旗标（`-c`、`-lc`、`-ic`…）。遇到 `--`、非旗标或新的命令段就停：
// `bash -- -c x` 里的 `-c` 不是选项，`bash x.sh -c` 里的 `-c` 是脚本自己的参数。
// 找不到返回 -1。
function findShellCommandFlag(tokens: RegExpMatchArray[], expanded: string, shellIndex: number) {
  for (let index = shellIndex + 1; index < tokens.length; index++) {
    const start = tokens[index].index ?? 0
    if (/[|;&\n]\s*$/.test(expanded.slice(0, start))) return -1
    const token = tokens[index][0].replace(/^["']|["']$/g, '')
    if (token === '--' || !token.startsWith('-')) return -1
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(token)) return index
  }
  return -1
}

// shell 的去引号。单引号内原样；双引号内只解析 `\"`、`\\`、`\$`、`` \` ``，其余 `\X` 保留反斜杠；
// 引号外 `\X` 一律是 X。不能复用分词器那句 raw.replace(/^["']|["']$/g, '')——它不处理 `\$`，
// 于是 `bash -c "echo \$(curl x)"` 的替换会留在转义态里而漏检：外层 shell 早已把 `\$` 变成 `$`，
// 内层 bash 会真的执行它。
function unquoteShellArgument(raw: string) {
  let out = ''
  let index = 0
  while (index < raw.length) {
    const char = raw[index]
    if (char === '\\') {
      const next = raw[index + 1]
      if (next === undefined) { out += char; index += 1; continue }
      out += next
      index += 2
      continue
    }
    if (char === "'") {
      const end = raw.indexOf("'", index + 1)
      out += raw.slice(index + 1, end === -1 ? raw.length : end)
      index = end === -1 ? raw.length : end + 1
      continue
    }
    if (char === '"') {
      index += 1
      while (index < raw.length && raw[index] !== '"') {
        if (raw[index] === '\\' && index + 1 < raw.length) {
          const next = raw[index + 1]
          out += '"\\$`'.includes(next) ? next : `\\${next}`
          index += 2
          continue
        }
        out += raw[index]
        index += 1
      }
      index += 1
      continue
    }
    out += char
    index += 1
  }
  return out
}

// 环境变量引用。用 sticky 标志在指定位置尝试匹配，避免对整串反复扫描。
const envReference = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/y

// 同一条命令串里由 shell 自己绑定的名字。值要么是**候选值词表**（`for NAME in w1 w2 …` 逐个取值，
// 所以「拿哪个值去检查」本身是个决定，见 isSafeBindingWord），要么是「这个名字确实被绑定了，
// 但值无法静态证明无害」——被引用到就按 `unsafe` 里带的理由拒绝。只收两种静态可判的形状：
// `for NAME in <词表>` 与命令段起点的 `NAME=<字面量>`。**刻意不收 `read NAME`**：取值来自 stdin、
// 静态不可知，绑任何一个值都是猜测，按「不能证明安全就拒绝」处理。
type CommandBinding = { words: string[] } | { unsafe: string }
type CommandBindings = Map<string, CommandBinding>

// 与 #inspect 的分词器同源，保证「词」在两处含义一致。
const bindingWord = /"(?:[^"\\]|\\.)*"|'[^']*'|[^\s|;&<>]+/g

// 必须是「单独看就不可能指向工作区之外、也不含任何会被 shell 再解释的字符」的字面量。
// 只在**每个**候选值都通过时，用其中一个做代表检查才与逐值检查等价——任一项不通过就整条拒绝，
// 否则 `for f in a /etc/passwd; do cat $f; done` 只取首值就会被放过。
// 通配符（`*`、`?`）不在此列：`src/*.mjs` 只会在工作区内展开，而 `/*` 已被前导斜杠那条挡下。
function isSafeBindingWord(word: string) {
  if (!word || word.startsWith('~')) return false
  if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(word)) return false
  if (/[\\$`'"|;&<>(){}\[\]\s]/.test(word)) return false
  return !word.split(/[\\/]/).includes('..')
}

// `for NAME in <词表>`（值在 `;` 或换行处截断）与命令段起点的 `NAME=<字面量>`。两处都收集，
// 与文本顺序无关——因此 `cat $X; X=/etc/passwd` 也会拒绝：只会过拒，不会漏放。
// 赋值只认**命令段起点**（`^`／`;`／`&`／`|`／换行之后），否则 `curl -d name=x` 这类实参里的
// `name=x` 会被误当成赋值。
function collectCommandBindings(command: string): CommandBindings {
  const bindings: CommandBindings = new Map()
  for (const match of command.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\b([^\n;]*)/g)) {
    const words = [...match[2].matchAll(bindingWord)].map(item => item[0])
    bindings.set(match[1], words.length && words.every(isSafeBindingWord)
      ? { words }
      : { unsafe: 'unsafe for loop value in command' })
  }
  for (const match of command.matchAll(/(?:^|[;&|\n])\s*([A-Za-z_]\w*)=([^\s;&|]+)/g)) {
    if (bindings.has(match[1])) continue
    bindings.set(match[1], isSafeBindingWord(match[2])
      ? { words: [match[2]] }
      : { unsafe: 'unsafe assigned value in command' })
  }
  return bindings
}

// 环境展开按 shell 的**引号与转义**语义进行，而不是对整串做一次全局 replace（那是此前误拒的根因：
// `echo '$HOME'` 与 `X=1; echo $X` 都被展开后误判）。三条规则：
//   ① 单引号内一切都是字面量——不展开 `$`，`\` 也不是转义（bash 如此）。
//   ② `\` 与其后的一个字符**整对**原样复制、不参与展开：`\$HOME` 是字面量，而 `\\$HOME` 里的 `$`
//      仍会被展开——`\\` 已被整对吃掉，剩下的是裸 `$`。
//   ③ 双引号内**仍展开**（`cat "$HOME/.ssh/id_rsa"` 必须继续被拒，展开是特性不是 bug），
//      但双引号内的 `'` 是**字面量**、不得开启单引号区间——否则 `node -e "show('a: b$ad')"` 里的
//      `$ad` 会被当成惰性文本漏检，而 bash 在双引号内确实会展开它（未定义即变空串，静默改坏程序）。
// 不替换的字符逐字复制（含反斜杠与引号）：下游的 token 偏移、`..` 整串正则与片段抽取都建立在
// 这条串的原样形状上，改动它的形状等于同时改这三处的判据。
function expandEnvironment(command: string, bindings: CommandBindings) {
  let out = ''
  let index = 0
  let single = false
  let double = false
  while (index < command.length) {
    const char = command[index]
    if (single) {
      if (char === "'") single = false
      out += char
      index += 1
      continue
    }
    if (char === '\\') {
      out += command.slice(index, index + 2)
      index += 2
      continue
    }
    if (char === '"') {
      double = !double
      out += char
      index += 1
      continue
    }
    if (char === "'") {
      if (!double) single = true
      out += char
      index += 1
      continue
    }
    if (char === '$') {
      envReference.lastIndex = index
      const match = envReference.exec(command)
      if (match) {
        const name = match[1] ?? match[2]
        // 同串内的绑定优先于 process.env：shell 局部变量就是靠这个含义覆盖环境变量的。
        const bound = bindings.get(name)
        if (bound && 'unsafe' in bound) throw new Error(bound.unsafe)
        if (bound) {
          out += bound.words[0]
          index += match[0].length
          continue
        }
        const value = process.env[name]
        if (value === undefined) throw new Error('unset environment variable in command')
        out += value
        index += match[0].length
        continue
      }
    }
    // `~` 走同一趟扫描：只在词首边界展开，跟着 `/`、空白、引号或串尾才算词首。
    // 走同一趟之后它自动继承上面两条规则——单引号内的 `~` 与 `\~` 都不再展开。
    // 双引号内**保持展开**（与既有行为 parity）：本步只修单引号与反斜杠两处，不引入新的拒绝。
    if (char === '~' && (index === 0 || /[\s"']/.test(command[index - 1]))) {
      const next = command[index + 1]
      if (next === undefined || /[/\s"']/.test(next)) {
        const home = process.env.HOME ?? process.env.USERPROFILE
        if (!home) throw new Error('unset home path')
        out += home
        index += 1
        continue
      }
    }
    out += char
    index += 1
  }
  return out
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
    if (typeof command !== 'string' || !command.trim()) return { action: 'deny' as const, reason: 'command is required' }
    return this.#inspect(command, 0)
  }
  // 嵌套片段的统一入口：上限与拒绝理由只在这一处定义，`$()`／反引号与 `-c`／`eval` 共用。
  // 超限即拒绝而不是放行——否则 `$(a$(b$(c$(curl x))))` 就成了一个明文可复制的绕过构造。
  #inspectFragments(fragments: { text: string; origin: string }[], depth: number): { action: 'deny'; reason: string } | null {
    if (!fragments.length) return null
    if (fragments.length > maxExecutedFragments) return { action: 'deny', reason: 'too many nested command fragments to inspect' }
    if (depth >= maxInspectionDepth) return { action: 'deny', reason: 'nested command text is too deep to inspect' }
    for (const fragment of fragments) {
      const result = this.#inspect(fragment.text, depth + 1)
      if (result.action === 'deny') return { action: 'deny', reason: `${fragment.origin}${result.reason}` }
    }
    return null
  }
  #inspect(command: string, depth: number): { action: 'allow' | 'deny'; reason: string | undefined } {
    const deny = (reason: string): { action: 'deny'; reason: string } => ({ action: 'deny', reason })
    let expanded
    try {
      expanded = expandEnvironment(command, collectCommandBindings(command))
    } catch (error) { return deny(error instanceof Error ? error.message : String(error)) }
    if (/\b(?:sudo|su)\b/.test(expanded)) return deny('sudo/su is blocked')
    if (/\brm\s+(?:(?:-[A-Za-z]*r[A-Za-z]*|--recursive)\b|[^;&|\n]*\s(?:-[A-Za-z]*r[A-Za-z]*|--recursive)\b)/i.test(expanded)) return deny('recursive delete is blocked')
    if (/\b(?:curl|wget)\b[^\n]*\|\s*(?:\S*\/)?(?:sh|bash|zsh)\b/.test(expanded)) return deny('piping curl/wget into a shell is blocked')
    if (/(?:^|[\s"'=])(?:[^\s"']*[\\/])?\.\.(?:[\\/]|[\s"']|$)/.test(expanded)) return deny('.. path escape is blocked')
    // `$(...)` 与反引号里的文本会被 shell 真正执行，顶层分词看不见它们，所以先抽出来逐段检查。
    // 递归保留 allowHosts 等全部语义：片段走的是同一个 #inspect，不是「见到取网工具就拒」。
    const substituted = this.#inspectFragments(extractExecutedFragments(expanded), depth)
    if (substituted) return substituted
    // 双引号按 shell 语义识别 \"：否则内联脚本（node -e "…"）里的转义引号会提前闭合引号，
    // 把注释和字符串碎片暴露成独立 token，闸门就会去检查 shell 根本看不到的“路径”。
    const tokens = [...expanded.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s|;&<>]+/g)]
    let networkTool = false
    let networkToolWord = ''
    let pendingValueToken = false
    let hostOperandSeen = false
    let commandWord = ''
    let pipedDownstream = false
    // 上一个 token 是引入命令位置的保留字：本 token 按命令段起点处理。
    let pendingCommandPosition = false
    const scriptFragments: { text: string; origin: string }[] = []
    for (let index = 0; index < tokens.length; index++) {
      const raw = tokens[index][0]
      const token = raw.replace(/^["']|["']$/g, '')
      const start = tokens[index].index ?? 0
      let executable = index === 0 || /[|;&\n]\s*$/.test(expanded.slice(0, start)) || pendingCommandPosition
      // 只在本次迭代内有效，不跨词存活——这样「保留字之后的词」与「把同一个词写在首 token 位置」判定
      // 完全一致（跨词存活会把 `do echo curl example.com` 的实参 `curl` 当成命令词）。清零必须在这里、
      // 而不是循环末尾：下面几处 `continue` 会跳过末尾的清零，让旗标多活一个 token。
      pendingCommandPosition = false
      const basename = path.posix.basename(token)
      if (executable) {
        networkTool = false
        networkToolWord = ''
        pendingValueToken = false
        hostOperandSeen = false
        commandWord = basename
        // 本段标准输出是否接到下游命令：下游可能真的取网，所以豁免只在纯输出时成立。
        pipedDownstream = expanded.slice(start + raw.length).split(/[;&\n]/)[0].replace(/\|\|/g, '').includes('|')
        // 保留字只在**自身处于命令段起点**时才算数（`echo do curl x` 里的 `do` 只是实参），且必须是
        // **原样未被引用、不含路径分隔符**的字面词——shell 的保留字识别发生在展开与去引号之前，
        // 被引用的 `"do"` 与带路径的 `./do` 都不是保留字。用 token 而非 basename 正是为了这一条。
        if (raw === token && commandIntroducers.has(token)) pendingCommandPosition = true
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
      } else if (/^\\\\[^\\/]+\\/.test(token)) {
        // 反斜杠 UNC：`\\server\share`、`\\?\C:\…`、`\\.\pipe\…`。正则要求 `\\`＋主机段＋`\`，
        // 不能用 `^\\\\` 一刀切——`printf '\\n'` 这类正当写法会中招。与位置无关，任意 token 都查。
        // 也不能只靠下面的路径分支：POSIX 上 path.resolve 会把 `\\server\share` 当成工作区内的
        // 相对名而放行，只有 Windows 才解析成 UNC。
        return deny('UNC path is blocked')
      } else if (/^(?:\/|[A-Za-z]:[\\/])/.test(token)) {
        const normalized = token.replace(/\\/g, '/')
        if (token === '/dev/null') { executable = false; continue }
        if (executable && /^\/(?:bin|usr\/bin)\/[^/]+$/.test(token)) { executable = false; continue }
        if (/^\/(?:etc|dev|proc|sys|root|boot)(?:\/|$)/.test(normalized)) return deny('system path is blocked')
        // 纯分隔符串（//、///）不含路径分量，解析到的是根而非可读内容；单个 / 仍是真实的根目录操作数。
        if (/^\/{2,}$/.test(token)) { executable = false; continue }
        // 任意条前导斜杠、但首个路径分量含空白的 token 不是可寻址的根级路径：真实的根级目录名不会
        // 以空白开头。这个形状来自被引号成词的**正文**——JS 注释（`// helper`）与 awk／sed 的程序
        // 正文（`/^## 11/,/^## 12/`）同形，此前只认双斜杠，于是单斜杠的 awk／sed 正文被当成绝对路径
        // 误拒（实测 782 次真实 bash 调用里 5 条）。系统路径与出网检查已在上面执行，不受影响；
        // 单个 `/`（首个分量为空）与 `//etc`、`//home/…`（首个分量干净）不在此列，仍走 resolvePath。
        if (/^\/+/.test(token) && /\s/.test(token.replace(/^\/+/, '').split('/')[0])) { executable = false; continue }
        try { this.resolvePath(token) } catch (error) { return deny(error instanceof Error ? error.message : String(error)) }
      }
      if (networkTool && takesValueFromNextToken(token, networkToolWord)) pendingValueToken = true
      // shell 的 `-c` 参数与 `eval` 的参数都是**会被执行**的文本。这里**不以 executable 为前提**：
      // 否则 `env bash -c 'curl …'`、`nice -n 5 bash -c '…'`、`xargs bash -c '…'` 会成组漏检。
      // 但 echo/printf 只写标准输出，`-c` 只是它们的参数文本，所以豁免照旧生效。
      if (!(stdoutOnlyCommands.has(commandWord) && !pipedDownstream)) {
        if (shellWords.has(basename)) {
          const flag = findShellCommandFlag(tokens, expanded, index)
          if (flag !== -1) {
            let scriptIndex = flag + 1
            if (scriptIndex < tokens.length && unquoteShellArgument(tokens[scriptIndex][0]) === '--') scriptIndex += 1
            const script = tokens[scriptIndex]
            // `-c` 之后**恰好一个** token 是脚本，其余是位置参数（连 `-x` 也只是 `$0`）。
            if (script) scriptFragments.push({ text: unquoteShellArgument(script[0]), origin: 'in shell -c argument: ' })
          }
        } else if (basename === 'eval') {
          const tail = expanded.slice(start + raw.length)
          const cut = tail.search(/[;&|\n]/)
          const segmentEnd = cut === -1 ? expanded.length : start + raw.length + cut
          const args = tokens.slice(index + 1).filter(item => (item.index ?? 0) < segmentEnd)
          if (args.length) scriptFragments.push({ text: args.map(item => unquoteShellArgument(item[0])).join(' '), origin: 'in eval argument: ' })
        }
      }
      executable = false
    }
    const scripted = this.#inspectFragments(scriptFragments, depth)
    if (scripted) return scripted
    return { action: 'allow', reason: undefined }
  }
  assertCommand(command: unknown) {
    const result = this.inspectCommand(command)
    if (result.action === 'deny') throw new Error(result.reason)
    return result
  }
}
