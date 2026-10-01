import { SandboxRuntime } from '../../dist/src/core/sandbox-runtime.js'

// Diagnostic matrix for the NX-17 command gate review, not regression assertions or CI gates
// (the contract lives in test/core.test.ts). Run after pnpm build. No model, no filesystem write,
// no real command: every case only goes through SandboxRuntime.inspectCommand.

const workspace = process.cwd()
const sandbox = new SandboxRuntime({ workspace, autoApprove: true })
const locked = new SandboxRuntime({ workspace, autoApprove: true, allowHosts: ['api.internal'] })

// [group, expected, command, runtime] — expected is the target contract, so a "known gap" row is one the
// gate does not meet yet. Every open gap here is over-blocking, not under-blocking: NX-18 rows are lazy
// `..` text the gate still denies, NX-23 rows are URLs used as data, NX-25 is a here-doc body treated as
// a command word, NX-30 is a command position introduced by an untracked operator (`(`/`)`/`{`/`}`,
// a `case` arm body) rather than by a reserved word.
// Three groups were gap groups until their work landed, and their rows read `met` first:
// `closed: NX-19 outbound closure` (2026-10-01), the two `fixed: quote-blind expansion` rows
// moved out of `known gap NX-24` (2026-10-01, NX-24), and `closed: NX-26 reserved-word command
// position` (2026-10-01, NX-26) — the last one is the only gap that was *under*-blocking.
// NX-24's third row did **not** close and was re-registered as `known gap NX-25` (here-doc): it was
// split out because its mechanism is different — whether a here-doc body is data or a script depends
// on the command consuming it (`cat <<'EOF'` is data, `bash <<'EOF'` is executed).
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
  ['fixed: inert URL', 'allow', 'echo "https://api.internal"', locked],

  // NX-24：展开此前是引号盲、反斜杠盲的整串 replace，三处误拒。前两条原在 `known gap NX-24` 组，
  // 先读到 met 再移到这里；其余按实测补——782 次真实模型 bash 调用里 18 条 `for` 变量、2 条 `\$`、
  // 1 条单引号。净放宽到此为止：未知名字与无法证明安全的候选值照旧拒绝，且理由与出网／环境变量
  // **不同串**，免得以后调绑定规则污染别的用例判据。
  ['fixed: quote-blind expansion', 'allow', "echo '$HOME'"],
  ['fixed: quote-blind expansion', 'allow', 'kind=local; echo $kind'],
  ['fixed: quote-blind expansion', 'allow', 'for f in src/*.mjs; do echo "=== $f ==="; cat "$f"; done'],
  ['fixed: quote-blind expansion', 'allow', 'for n in 07 08 09 10; do node tmp-verify-$n.mjs > r$n.log 2>&1; echo "$n exit=$?"; done'],
  ['fixed: quote-blind expansion', 'allow', 'for f in delta plan-parse plan-merge; do cat "src/$f.mjs"; done'],
  ['fixed: quote-blind expansion', 'allow', 'echo \\$HOME'],
  ['fixed: quote-blind expansion', 'allow', 'sed -n "s/^## 11/x,\\$p" docs/SPEC.md'],
  ['fixed: quote-blind expansion', 'deny', 'cat $MINI_DSH_UNSET_VAR/file'],
  ['fixed: quote-blind expansion', 'deny', 'for f in a /etc/passwd; do cat $f; done'],
  ['fixed: quote-blind expansion', 'deny', 'X=/etc/passwd; cat $X'],
  // 双引号内**仍展开**：`$ad` 未定义即变空串，会静默改坏模型写的程序。这两条是本次最容易写错的一处。
  ['fixed: quote-blind expansion', 'deny', 'node -e "show(\'a: b$ad\')"'],
  ['fixed: quote-blind expansion', 'deny', 'read x; echo $x'],

  // NX-24：被引号成词的**正文**以 `/` 开头时，此前被当成绝对路径。既有规则已经认「双斜杠 + 首分量
  // 含空白」（JS 注释），但只认双斜杠，于是 awk／sed 的程序正文被误拒（实测 5 条）。改成任意条前导
  // 斜杠，判据本身不动。最后一行是**接受的连带**：首分量含空白的 POSIX 根路径不再算路径操作数
  // ——与既有 `//` 形态同一取舍，写在这里是为了让它成为记录在案的决定，而不是静默放宽。
  ['fixed: quoted program text', 'allow', "awk '/^## 11/,/^## 12/' docs/SPEC.md"],
  ['fixed: quoted program text', 'allow', "sed -n '/^## *9/,/^## *10/p' docs/SPEC.md"],
  ['fixed: quoted program text', 'allow', "awk '/stage(7|7)|phase 7/{f=1} f' check.mjs"],
  ['fixed: quoted program text', 'allow', 'cat "/Program Files/secret"'],
  ['fixed: quoted program text', 'deny', 'cat /etc/passwd'],
  ['fixed: quoted program text', 'deny', 'ls /'],

  ['kept: escape and system paths', 'deny', 'echo ../secret'],
  ['kept: escape and system paths', 'deny', 'cat /etc/passwd'],
  ['kept: escape and system paths', 'deny', 'ls /'],
  ['kept: escape and system paths', 'deny', 'ls //etc'],
  ['kept: escape and system paths', 'deny', 'cat //home/user/.ssh/id_rsa'],
  ['kept: escape and system paths', 'deny', 'cat //server/share/secret'],
  ['kept: escape and system paths', 'deny', 'rm -rf src'],
  // `//comment` 是 deny 的孪生行（它的 allow 兄弟在 `fixed: comment shape`）：放宽前导斜杠的条数
  // 只针对「首分量含空白」的正文形状，首分量干净的仍走 resolvePath。
  ['kept: escape and system paths', 'deny', 'node -e "//comment"'],
  ['kept: egress', 'deny', 'curl https://example.com'],
  ['kept: egress', 'deny', 'curl example.com'],
  ['kept: egress', 'deny', 'git clone https://example.com/x.git'],
  ['kept: egress', 'deny', 'echo "http://evil.example" | xargs curl'],
  ['kept: egress', 'deny', 'echo "http://evil.example" | cat > f'],
  ['kept: host allowlist', 'deny', 'curl https://example.com', locked],

  // NX-19 闭合的四种形状（原 `known gap NX-19` 组，四条先读到 met 再移到这里）+ 本轮新增的约定行。
  ['closed: NX-19 outbound closure', 'deny', 'bash -c "curl http://example.com"'],
  ['closed: NX-19 outbound closure', 'deny', 'echo "$(curl https://example.com)"'],
  ['closed: NX-19 outbound closure', 'deny', 'nc example.com 80'],
  ['closed: NX-19 outbound closure', 'deny', 'cat \\\\server\\share\\secret'],
  ['closed: NX-19 outbound closure', 'deny', "bash -c 'curl http://example.com'"],
  ['closed: NX-19 outbound closure', 'deny', "sh -c 'wget http://example.com'"],
  ['closed: NX-19 outbound closure', 'deny', "env bash -c 'curl http://example.com'"],
  ['closed: NX-19 outbound closure', 'deny', "xargs bash -c 'curl http://example.com'"],
  ['closed: NX-19 outbound closure', 'deny', 'eval "curl http://example.com"'],
  ['closed: NX-19 outbound closure', 'deny', 'ping example.com'],
  ['closed: NX-19 outbound closure', 'deny', 'dig +short example.com'],
  ['closed: NX-19 outbound closure', 'deny', 'scp report.pdf user@example.com:/tmp/'],
  ['closed: NX-19 outbound closure', 'deny', 'rsync -avz src/ example.com:/dest/'],
  ['closed: NX-19 outbound closure', 'deny', 'echo "`curl https://example.com`"'],
  ['closed: NX-19 outbound closure', 'deny', 'echo "$(a$(b$(c$(curl http://example.com))))"'],
  // 净放宽那一条（NX-19-1）：取值旗标，不是主机。
  ['closed: NX-19 outbound closure', 'allow', 'curl -o out.txt http://localhost/x'],
  ['closed: NX-19 outbound closure', 'allow', 'wget -O page.html http://localhost/'],
  ['closed: NX-19 outbound closure', 'allow', 'ssh -i key.pem localhost'],
  ['closed: NX-19 outbound closure', 'allow', 'nc -l 8080'],
  ['closed: NX-19 outbound closure', 'allow', "printf '\\\\n'"],
  // 惰性与已授权主机：闭合之后不得变成一刀切。
  ['closed: NX-19 outbound closure', 'allow', 'echo \'$(curl http://example.com)\''],
  ['closed: NX-19 outbound closure', 'allow', 'echo "$(curl http://localhost/health)"'],
  ['closed: NX-19 outbound closure', 'allow', 'bash -c "curl http://localhost/x"'],
  // allowHosts 在嵌套片段里同样生效：默认库放行，locked 库同一形状被拒、换成白名单主机又放行。
  ['closed: NX-19 outbound closure', 'deny', 'bash -c "curl http://localhost/x"', locked],
  ['closed: NX-19 outbound closure', 'allow', 'bash -c "curl https://api.internal/health"', locked],

  // NX-26（2026-10-01）：保留字之后的命令词按命令段起点处理。行从 `known gap NX-26` 搬来（先读到
  // met 再搬），保留字只在**自身处于命令段起点**、且是**原样未被引用、不含路径分隔符**的字面词时
  // 才算数；前视只作用于紧随的一个 token，所以 `<保留字> <rest>` 与顶层 `<rest>` 判定完全一致。
  ['closed: NX-26 reserved-word command position', 'deny', 'for f in a b; do curl example.com; echo $f; done'],
  ['closed: NX-26 reserved-word command position', 'deny', 'if curl example.com; then echo ok; fi'],
  ['closed: NX-26 reserved-word command position', 'deny', 'while curl example.com; do echo x; done'],
  ['closed: NX-26 reserved-word command position', 'deny', 'do curl example.com'],
  ['closed: NX-26 reserved-word command position', 'deny', 'for f in a; do curl example.com; done', locked],
  ['closed: NX-26 reserved-word command position', 'allow', 'for f in a; do curl https://api.internal/x; done', locked],
  // 两条记录在案的净放宽：`commandWord` 从此是 `echo`，与顶层同形状判定一致。
  ['closed: NX-26 reserved-word command position', 'allow', 'for f in a; do echo https://example.com; done'],
  ['closed: NX-26 reserved-word command position', 'allow', 'for f in a; do echo bash -c "curl https://evil/x"; done'],
  // 保留字自身必须在命令段起点（`do` 只是 `echo` 的实参），且必须是原样字面词（`"do"` 不是）。
  ['closed: NX-26 reserved-word command position', 'allow', 'echo do curl example.com'],
  ['closed: NX-26 reserved-word command position', 'allow', '"do" curl example.com'],
  // `case` 后面的词是主语不是命令：本项不覆盖 case 臂体（NX-30）。
  ['closed: NX-26 reserved-word command position', 'allow', 'case a in a) echo hi;; esac'],

  ['known gap NX-18', 'allow', 'echo "see ../docs for details"'],
  ['known gap NX-18', 'allow', 'grep -n ".." src/index.ts'],
  // NX-23：URL 是数据还是请求目标，当前只看「整 token 恰为 URL」的形状。同一条语义两种写法
  // 结果相反（`--grep=<url>` 放行、`--grep <url>` 拒绝）就是这一点的直接证据。
  ['known gap NX-23', 'allow', 'git log --grep "https://github.com/x"'],
  ['known gap NX-23', 'allow', 'npm install --registry https://registry.npmjs.org'],
  // NX-25：here-doc 正文被当命令词（NX-24 期间从 NX-24-③ 拆出，机制不同——正文是数据还是脚本
  // 取决于消费它的命令）。实测 782 次调用里只有 5 次用 `<<`。
  ['known gap NX-25', 'allow', "cat <<'EOF'\ncurl https://example.com\nEOF"],
  // NX-30：保留字以外的「命令位置引入符」——NX-26 只补了保留字这一支。`(`／`)`／`{`／`}` 在现有
  // 分词里归进 token 体（`[^\s|;&<>]+`），要先把算子集扩进去才谈得上判定；`case … in X)` 的臂体
  // 同理。方向与 NX-26 相同（收紧），但属「未跟踪算子」这一独立机制。
  ['known gap NX-30', 'deny', '(curl example.com)'],
  ['known gap NX-30', 'deny', '{ curl example.com; }'],
]

// A contract row that misses its target is a regression to investigate; a gap row that meets it means the
// gap closed and the row should move up into the contract groups.
let drifted = 0
let open = 0
let met = 0
let group
for (const [label, expected, command, runtime = sandbox] of cases) {
  if (label !== group) {
    group = label
    console.log(`\n${label}`)
  }
  const result = (runtime ?? sandbox).inspectCommand(command)
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
