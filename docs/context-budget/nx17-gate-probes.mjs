import { SandboxRuntime } from '../../dist/src/core/sandbox-runtime.js'

// Diagnostic matrix for the command gate, not regression assertions or CI gates (the contract lives in
// test/core.test.ts). Run after pnpm build. No model, no filesystem write, no real command: every case
// only goes through SandboxRuntime.inspectCommand.

const workspace = process.cwd()
const sandbox = new SandboxRuntime({ workspace, autoApprove: true })

// [group, expected, command] — expected is the target contract, so a "known gap" row is one the gate
// does not meet yet. **Gaps come in both directions and the direction is what the row says**:
// over-blocking (expect allow, get deny) — NX-18 lazy `..` text, NX-25 here-doc bodies;
// under-blocking (expect deny, get allow) — everything else below.
//
// **NX-32（2026-10-01）是一次有意的能力收缩，本矩阵因此比收缩前短得多。** 闸门删掉了整层启发式词法
// （`$()`／反引号／`sh -c`／`eval` 的递归抽取、按引号语义的环境展开与 `for`／`NAME=` 绑定、保留字与
// 算子之后的命令位前视、三种取网工具操作数模型与主机白名单），只留下四个整串正则、token 上的路径
// 与 UNC 判定、以及**按段首工具名**的粗粒度出网拦。判据与代价见 PLAN 的 D-16 与需求 R-20。
//
// 因此三处状态变了，逐条留证：
//   - **NX-23 闭合**：裸 URL 规则随操作数模型一起删除，`--grep <url>` 这类数据不再被当成目标。
//   - **NX-19／NX-24／NX-26／NX-30 由「已闭合」退回「已知缺口」**：它们在收缩前是 `closed:` 组，
//     现在其机制已不存在，整组降级为欠拦 gap。这不是回退——是本次撤回的直接结果。
//   - **新增 NX-32 两条**：非段首的 URL 操作数（`git clone <url>`）与变量间接（`X=..; cat $X/…`）。
const cases = [
  ['fixed: shell quoting', 'allow', 'node check.mjs && node --input-type=module -e "\nimport assert from \'node:assert/strict\'\n\n// nested plain objects merge recursively\nassert.deepEqual(1, 1)\n\nconst evil = JSON.parse(\'{\\"__proto__\\":{\\"polluted\\":true}}\')\n"'],
  ['fixed: shell quoting', 'allow', 'node -e "console.log(\\"a\\") // trailing"'],
  ['fixed: shell quoting', 'allow', 'echo "x\\" /etc/passwd"'],
  ['fixed: comment shape', 'allow', 'echo //'],
  ['fixed: comment shape', 'allow', 'ls -la; // done'],
  ['fixed: comment shape', 'allow', 'node -e "// comment"'],
  ['fixed: comment shape', 'allow', 'grep -n "//" src/index.ts'],
  ['fixed: inert URL', 'allow', 'echo "https://docs.example.com/guide"'],
  ['fixed: inert URL', 'allow', 'printf "%s\\n" "https://example.com"'],
  ['fixed: inert URL', 'allow', 'echo "https://example.com" || echo fallback'],

  // 词体类与「首分量含空白」的取舍：被引号成词的**正文**以 `/` 开头时不是可寻址的根级路径。
  // `awk '/stage(7|7)|phase 7/{f=1} f'` 还是「段界取 token 空隙、不按文本切分」的活证据——
  // 那个 `|` 在被引号吃掉的 token 内部，按文本切会凭空切出一段。
  ['fixed: quoted program text', 'allow', "awk '/^## 11/,/^## 12/' docs/SPEC.md"],
  ['fixed: quoted program text', 'allow', "sed -n '/^## *9/,/^## *10/p' docs/SPEC.md"],
  ['fixed: quoted program text', 'allow', "awk '/stage(7|7)|phase 7/{f=1} f' check.mjs"],
  ['fixed: quoted program text', 'allow', 'cat "/Program Files/secret"'],
  ['fixed: quoted program text', 'deny', 'cat /etc/passwd'],
  ['fixed: quoted program text', 'deny', 'ls /'],

  // NX-32 保留的四条判据之一：`..`、系统路径、工作区越界与软链、递归删除。
  ['kept: escape and system paths', 'deny', 'echo ../secret'],
  ['kept: escape and system paths', 'deny', 'cat /etc/passwd'],
  ['kept: escape and system paths', 'deny', 'ls /'],
  ['kept: escape and system paths', 'deny', 'ls //etc'],
  ['kept: escape and system paths', 'deny', 'cat //home/user/.ssh/id_rsa'],
  ['kept: escape and system paths', 'deny', 'cat //server/share/secret'],
  ['kept: escape and system paths', 'deny', 'rm -rf src'],
  ['kept: escape and system paths', 'deny', 'cat \\\\server\\share\\secret'],
  ['kept: escape and system paths', 'deny', 'cat \\\\?\\C:\\Windows\\win.ini'],
  // 环境展开撤销后，这一条仍被拒——靠的是**保留的 `..` 整串正则**，不是展开。
  ['kept: escape and system paths', 'deny', 'cat $MINI_DSH_TEST_ROOT/../etc/passwd'],
  // `//comment` 是 deny 的孪生行（它的 allow 兄弟在 `fixed: comment shape`）。
  ['kept: escape and system paths', 'deny', 'node -e "//comment"'],
  ['kept: escape and system paths', 'deny', 'for f in a /etc/passwd; do cat $f; done'],

  // 出网：只按**段首工具名**拦，不看目标。段首判定认路径前缀，也认 ; & | 换行切出的新段。
  ['kept: egress by segment head', 'deny', 'curl https://example.com'],
  ['kept: egress by segment head', 'deny', 'curl example.com'],
  ['kept: egress by segment head', 'deny', '/usr/bin/curl example.com'],
  ['kept: egress by segment head', 'deny', 'true && curl example.com'],
  ['kept: egress by segment head', 'deny', 'echo a; curl example.com'],
  ['kept: egress by segment head', 'deny', 'nc example.com 80'],
  ['kept: egress by segment head', 'deny', 'ssh user@example.com'],
  ['kept: egress by segment head', 'deny', 'scp report.pdf user@example.com:/tmp/'],
  ['kept: egress by segment head', 'allow', 'echo curl example.com'],
  ['kept: egress by segment head', 'allow', 'grep -n "curl" src/index.ts'],
  // 出网裁决排在路径检查**之后**：这一条的理由是系统路径，不是出网。
  ['kept: egress by segment head', 'deny', 'wget -O /etc/passwd http://localhost/x'],

  // 命令名不是取网工具、也不含路径时照旧放行——收缩不该伤到普通命令。
  ['kept: command shape', 'allow', 'echo $(date) https://example.com'],
  ['kept: command shape', 'allow', 'mkdir -p src/{a,b}/x'],
  ['kept: command shape', 'allow', 'find . -name x -exec grep -l y {} ;'],
  ['kept: command shape', 'allow', '(git status --porcelain || echo no-git)'],
  ['kept: command shape', 'allow', 'case a in a) echo hi;; esac'],
  ['kept: command shape', 'allow', 'ls -la; // done'],
  ['kept: command shape', 'allow', 'date | /usr/bin/grep foo'],

  // NX-23 的两行先在 `known gap NX-23` 里读到 met，再搬到这里（仓库惯例：先跑到 met 再搬）。
  ['closed: NX-23 URL as data', 'allow', 'git log --grep "https://github.com/x"'],
  ['closed: NX-23 URL as data', 'allow', 'npm install --registry https://registry.npmjs.org'],

  ['known gap NX-18', 'allow', 'echo "see ../docs for details"'],
  ['known gap NX-18', 'allow', 'grep -n ".." src/index.ts'],
  // NX-25：here-doc 正文被当命令词（正文是数据还是脚本取决于消费它的命令）。注意它的理由串在本轮
  // 变了——正文里的 `curl` 现在按段首工具名命中，是粗粒度判据的连带过拦，不是修好了。
  ['known gap NX-25', 'allow', "cat <<'EOF'\ncurl https://example.com\nEOF"],

  // NX-19 重开：嵌套执行不再被检查。收缩前这整组是 `closed:`，机制删除后没有替代品。
  ['known gap NX-19 reopened', 'deny', 'bash -c "curl http://example.com"'],
  ['known gap NX-19 reopened', 'deny', "sh -c 'wget http://example.com'"],
  ['known gap NX-19 reopened', 'deny', "env bash -c 'curl http://example.com'"],
  ['known gap NX-19 reopened', 'deny', "xargs bash -c 'curl http://example.com'"],
  ['known gap NX-19 reopened', 'deny', 'eval "curl http://example.com"'],
  ['known gap NX-19 reopened', 'deny', 'echo "$(curl https://example.com)"'],
  ['known gap NX-19 reopened', 'deny', 'echo "`curl https://example.com`"'],
  ['known gap NX-19 reopened', 'deny', 'echo "$(a$(b$(c$(curl http://example.com))))"'],

  // NX-24 重开：环境展开与绑定撤销后，变量间接不再被看得见。过拦那一侧同时消失（见下一条说明）。
  ['known gap NX-24 reopened', 'deny', 'cat $MINI_DSH_UNSET_VAR/file'],
  ['known gap NX-24 reopened', 'deny', 'X=/etc/passwd; cat $X'],
  ['known gap NX-24 reopened', 'deny', 'node -e "show(\'a: b$ad\')"'],
  ['known gap NX-24 reopened', 'deny', 'read x; echo $x'],

  // NX-26 重开：保留字之后的命令位不再前视。
  ['known gap NX-26 reopened', 'deny', 'for f in a b; do curl example.com; echo $f; done'],
  ['known gap NX-26 reopened', 'deny', 'if curl example.com; then echo ok; fi'],
  ['known gap NX-26 reopened', 'deny', 'while curl example.com; do echo x; done'],
  ['known gap NX-26 reopened', 'deny', 'do curl example.com'],

  // NX-30 重开：算子支与 `case` 臂体同属「命令位不由首 token 给出」这一族。
  ['known gap NX-30 reopened', 'deny', '(curl example.com)'],
  ['known gap NX-30 reopened', 'deny', '( curl example.com )'],
  ['known gap NX-30 reopened', 'deny', '{ curl example.com; }'],
  ['known gap NX-30 reopened', 'deny', "(bash -c 'curl http://x')"],
  ['known gap NX-30 reopened', 'deny', 'echo a; (curl example.com)'],
  ['known gap NX-30 arm body', 'deny', 'case a in a) curl example.com;; esac'],

  // NX-31（NX-30 期间新发现）：命令位被**包装命令**吃掉。语料 0 处。
  ['known gap NX-31', 'deny', 'timeout 5 curl example.com'],
  ['known gap NX-31', 'deny', 'env curl example.com'],

  // NX-32 新登记的两条：粗粒度判据不看目标、也不做变量展开，于是这两类不再被看见。
  // `git clone <url>` 是「非段首的 URL 操作数」——判据只认段首工具名，`git` 不是取网工具。
  ['known gap NX-32 url operand', 'deny', 'git clone https://example.com/x.git'],
  ['known gap NX-32 url operand', 'deny', 'echo "http://evil.example" | xargs curl'],
  ['known gap NX-32 url operand', 'deny', 'echo "http://evil.example" | cat > f'],
  ['known gap NX-32 variable indirection', 'deny', 'X=..; cat $X/secret'],
  ['known gap NX-32 variable indirection', 'deny', 'Y=/etc; cat $Y/passwd'],
]

// A contract row that misses its target is a regression to investigate; a gap row that meets it means the
// gap closed and the row should move up into the contract groups.
let drifted = 0
let open = 0
let met = 0
let group
for (const [label, expected, command] of cases) {
  if (label !== group) {
    group = label
    console.log(`\n${label}`)
  }
  const result = sandbox.inspectCommand(command)
  const actual = result.action
  const gap = label.startsWith('known gap')
  const state = actual === expected ? (gap ? 'met' : 'ok') : gap ? 'open' : 'drift'
  if (state === 'drift') drifted += 1
  if (state === 'open') open += 1
  if (state === 'met') met += 1
  console.log(`${state.padEnd(6)} ${actual.padEnd(5)} (want ${expected.padEnd(5)}) ${JSON.stringify(command)}`)
  if (result.reason) console.log(`       reason: ${result.reason}`)
}

console.log(`\n${drifted === 0 ? 'no contract drift' : `${drifted} contract case(s) drifted`}; ${open} known gap(s) still open${met ? `, ${met} gap row(s) now meet the target` : ''}`)
console.log('a gap row reading "met" means that known gap closed: re-check it, then move it into the contract groups')
