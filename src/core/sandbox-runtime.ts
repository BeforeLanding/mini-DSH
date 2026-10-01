import type { ApprovalRequest, SandboxConfig } from './contracts.js'
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
//   ① 四个整串正则：`sudo`／`su`、递归删除、`curl|wget` 管道进 shell、`..` 逃逸
//   ② token 上的反斜杠 UNC、盘符与绝对路径、系统路径，以及对工作区外路径与软链的解析
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
  #inspect(command: string): { action: 'allow' | 'deny'; reason: string | undefined } {
    const deny = (reason: string): { action: 'deny'; reason: string } => ({ action: 'deny', reason })
    // 四个整串正则。它们不依赖分词，也不区分「数据」与「代码」——这正是它们**廉价且稳定**的原因，
    // 代价是会把引号里的同形文本一起拒掉（NX-18／NX-25 就是这么来的，已登记、不修）。
    if (/\b(?:sudo|su)\b/.test(command)) return deny('sudo/su is blocked')
    if (/\brm\s+(?:(?:-[A-Za-z]*r[A-Za-z]*|--recursive)\b|[^;&|\n]*\s(?:-[A-Za-z]*r[A-Za-z]*|--recursive)\b)/i.test(command)) return deny('recursive delete is blocked')
    if (/\b(?:curl|wget)\b[^\n]*\|\s*(?:\S*\/)?(?:sh|bash|zsh)\b/.test(command)) return deny('piping curl/wget into a shell is blocked')
    if (/(?:^|[\s"'=])(?:[^\s"']*[\\/])?\.\.(?:[\\/]|[\s"']|$)/.test(command)) return deny('.. path escape is blocked')
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
