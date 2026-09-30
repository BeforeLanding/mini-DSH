import { SandboxRuntime } from '../../dist/src/core/sandbox-runtime.js'

// Diagnostic matrix for the NX-17 command gate review, not regression assertions or CI gates
// (the contract lives in test/core.test.ts). Run after pnpm build. No model, no filesystem write,
// no real command: every case only goes through SandboxRuntime.inspectCommand.

const workspace = process.cwd()
const sandbox = new SandboxRuntime({ workspace, autoApprove: true })
const locked = new SandboxRuntime({ workspace, autoApprove: true, allowHosts: ['api.internal'] })

// [group, expected, command, runtime] — expected is the target contract, so a "known gap" row is one the
// gate does not meet yet: NX-18 rows are false positives the gate still denies, NX-19 rows are real
// escapes the gate still allows.
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

  ['known gap NX-18', 'allow', 'echo "see ../docs for details"'],
  ['known gap NX-18', 'allow', 'grep -n ".." src/index.ts'],
  ['known gap NX-19', 'deny', 'bash -c "curl http://example.com"'],
  ['known gap NX-19', 'deny', 'echo "$(curl https://example.com)"'],
  ['known gap NX-19', 'deny', 'nc example.com 80'],
  ['known gap NX-19', 'deny', 'cat \\\\server\\share\\secret'],
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
console.log('a gap row reading "met" means NX-18 / NX-19 changed that shape: re-check it, then move it into the contract groups')
