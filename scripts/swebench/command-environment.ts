import { spawnSync } from 'node:child_process'
import type { SpawnSyncReturns } from 'node:child_process'

// 命令环境契约，两种执行臂（mini-DSH 候选与外部 mini-SWE-agent）共用同一个解释器。
// legacy 是 2026-10 正式批次的行为：bash -lc 在非 root uid、临时 HOME 下读不到镜像的 conda 激活，
// 命令落在 /opt/miniconda3 的 base Python 上（正式批 49/50 条候选轨迹出现缺包）。
// testbed-v1 显式激活 testbed 环境；激活失败则命令不执行，不回落到 base Python。
export type CommandEnvironment = 'legacy' | 'testbed-v1'

export function validateCommandEnvironment(value: unknown): CommandEnvironment {
  if (value === undefined) return 'legacy'
  if (value !== 'legacy' && value !== 'testbed-v1') throw new Error('commandEnvironment must be legacy or testbed-v1')
  return value
}

// 命令本身作为独立 argv 元素传入：引号、换行、$() 与控制流都属于命令，不会混进激活包装。
export function commandInterpreter(environment: CommandEnvironment = 'legacy'): string[] {
  validateCommandEnvironment(environment)
  return environment === 'legacy' ? ['bash', '-lc'] : ['bash', '-lc',
    'source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && exec bash -c "$1"', 'mini-dsh-testbed']
}

export const TESTBED_PROBE = `python -c 'import json, sys; assert sys.prefix == "/opt/miniconda3/envs/testbed", sys.prefix; print(json.dumps({"python": sys.executable, "prefix": sys.prefix}))'`

// 零模型探针：与两臂相同的用户、隔离参数与解释器，在发任何模型请求前确认镜像里确有 testbed 环境。
export function probeCommandEnvironment(image: string, uid: number, gid: number,
  dependencies: { run?: (args: string[]) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'> } = {}) {
  if (!/^sha256:[0-9a-f]{64}$/.test(image) && !/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error('environment probe requires a pinned image digest')
  const run = dependencies.run ?? ((args: string[]) => spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 }))
  const result = run(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev', '--user', `${uid}:${gid}`,
    '--env', 'HOME=/tmp', '--env', 'BASH_ENV=', '--workdir', '/testbed', image,
    ...commandInterpreter('testbed-v1'), TESTBED_PROBE])
  if (result.status !== 0) throw new Error(`testbed environment preflight failed for ${image}: ${result.error?.message ?? String(result.stderr).slice(-1000)}`)
  const reading = JSON.parse(String(result.stdout).trim().split('\n').at(-1)!) as { python: string; prefix: string }
  if (reading.prefix !== '/opt/miniconda3/envs/testbed') throw new Error(`invalid testbed environment probe for ${image}`)
  return { image, commandEnvironment: 'testbed-v1' as const, ...reading }
}
