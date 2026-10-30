import { spawnSync } from 'node:child_process'

export type CommandEnvironment = 'legacy' | 'testbed-v1'

export function validateCommandEnvironment(value: unknown): CommandEnvironment {
  if (value === undefined) return 'legacy'
  if (value !== 'legacy' && value !== 'testbed-v1') throw new Error('commandEnvironment must be legacy or testbed-v1')
  return value
}

// Keep the action in a separate argv element: quotes, newlines, $(), and shell
// control flow belong to the action, never to the activation wrapper.
export function commandInterpreter(environment: CommandEnvironment = 'legacy'): string[] {
  validateCommandEnvironment(environment)
  return environment === 'legacy' ? ['bash', '-lc'] : ['bash', '-lc',
    'source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && exec bash -c "$1"', 'mini-dsh-testbed']
}

export const TESTBED_PROBE = `python -c 'import json, sys, pytest; assert sys.prefix == "/opt/miniconda3/envs/testbed", sys.prefix; print(json.dumps({"python": sys.executable, "prefix": sys.prefix, "pytest": pytest.__version__}))'`

// A zero-model probe of the pinned image, with the same user/isolation and
// interpreter as both execution arms. Never falls back to the base Python.
export function probeCommandEnvironment(image: string, uid: number, gid: number) {
  if (!/^sha256:[0-9a-f]{64}$/.test(image)) throw new Error('environment probe requires a pinned image digest')
  const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev', '--user', `${uid}:${gid}`,
    '--env', 'HOME=/tmp', '--env', 'BASH_ENV=', '--workdir', '/testbed', image,
    ...commandInterpreter('testbed-v1'), TESTBED_PROBE], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 })
  if (result.status !== 0) throw new Error(`testbed environment preflight failed for ${image}: ${result.error?.message ?? result.stderr.slice(-1000)}`)
  const line = result.stdout.trim().split('\n').at(-1)!
  const reading = JSON.parse(line) as { python: string; prefix: string; pytest: string }
  if (reading.prefix !== '/opt/miniconda3/envs/testbed' || typeof reading.python !== 'string' || typeof reading.pytest !== 'string') throw new Error('invalid testbed environment probe')
  return { image, commandEnvironment: 'testbed-v1' as const, ...reading }
}

export const CANDIDATE_PATH_GUIDANCE = [
  '## SWE task environment',
  'Bash executes inside the pinned task container at /testbed, with the testbed conda environment activated for every command.',
  'File tools operate on the corresponding host checkout. Use workspace-relative paths for read_file, edit_file, write_file, grep, glob, bash cwd, and verification.files; omit bash cwd to use the repository root.',
  'A traceback path such as /testbed/pkg/file.py corresponds to pkg/file.py for file tools. Do not pass /testbed or /opt paths as tool cwd.',
  'Use the installed task dependencies. Keep checks focused and read_file pages at most 200 lines. Do not spend the run reinstalling the environment.',
].join('\n')
