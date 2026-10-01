import { SandboxRuntime } from '../../dist/src/core/sandbox-runtime.js'

// Diagnostic matrix for the NX-17 command gate review, not regression assertions or CI gates
// (the contract lives in test/core.test.ts). Run after pnpm build. No model, no filesystem write,
// no real command: every case only goes through SandboxRuntime.inspectCommand.

const workspace = process.cwd()
const sandbox = new SandboxRuntime({ workspace, autoApprove: true })
const locked = new SandboxRuntime({ workspace, autoApprove: true, allowHosts: ['api.internal'] })

// [group, expected, command, runtime] — expected is the target contract, so a "known gap" row is one the
// gate does not meet yet. All three open gaps are over-blocking, not under-blocking: NX-18 rows are
// lazy `..` text the gate still denies, NX-23 rows are URLs used as data, NX-24 rows are places where
// the gate's lexer still disagrees with a real shell.
// The `closed: NX-19 outbound closure` group was the `known gap NX-19` group until NX-19 landed;
// those four rows read `met` on 2026-10-01 before being moved down here.
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

  ['kept: escape and system paths', 'deny', 'echo ../secret'],
  ['kept: escape and system paths', 'deny', 'cat /etc/passwd'],
  ['kept: escape and system paths', 'deny', 'ls /'],
  ['kept: escape and system paths', 'deny', 'ls //etc'],
  ['kept: escape and system paths', 'deny', 'cat //home/user/.ssh/id_rsa'],
  ['kept: escape and system paths', 'deny', 'cat //server/share/secret'],
  ['kept: escape and system paths', 'deny', 'rm -rf src'],
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

  ['known gap NX-18', 'allow', 'echo "see ../docs for details"'],
  ['known gap NX-18', 'allow', 'grep -n ".." src/index.ts'],
  // NX-23：URL 是数据还是请求目标，当前只看「整 token 恰为 URL」的形状。同一条语义两种写法
  // 结果相反（`--grep=<url>` 放行、`--grep <url>` 拒绝）就是这一点的直接证据。
  ['known gap NX-23', 'allow', 'git log --grep "https://github.com/x"'],
  ['known gap NX-23', 'allow', 'npm install --registry https://registry.npmjs.org'],
  // NX-24：闸门词法仍与真实 shell 有系统偏差，三处各自机制不同。
  ['known gap NX-24', 'allow', "echo '$HOME'"],
  ['known gap NX-24', 'allow', 'kind=local; echo $kind'],
  ['known gap NX-24', 'allow', "cat <<'EOF'\ncurl https://example.com\nEOF"],
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
