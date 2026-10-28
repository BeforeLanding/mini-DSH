// Contract for the pinned external baseline.
//
// The external arm is the unmodified mini-SWE-agent batch CLI. The runner owns
// the episode inputs (one-row dataset, override config, workspace, labels) and
// parses the upstream predictions/trajectory. This module is deliberately
// dependency-free so both the preregistrar and the runner can validate the
// frozen command before any evidence directory or model call exists.

export const EXTERNAL_CONTRACT_VERSION = 1

export const EXTERNAL_PLACEHOLDERS = [
  'python', 'dataset', 'config', 'output', 'workspace', 'instance', 'image', 'model', 'upstream_config',
] as const

export type ExternalPlaceholder = typeof EXTERNAL_PLACEHOLDERS[number]

export interface ExternalLabels {
  batch: string
  episode: string
}

const placeholder = /^\{([^{}]+)\}$/
const placeholderToken = /\{[^{}]+\}/g

function unsafeArgument(value: string): boolean {
  return value.includes('\0') || value.includes('\n') || value.includes('\r')
}

function labelValue(value: string, fallback: string): string {
  const clean = value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 63)
  return clean || fallback
}

export function externalLabels(input: { batchId: string; instanceId: string; armId: string; index: number }): ExternalLabels {
  return {
    batch: labelValue(input.batchId, 'batch'),
    episode: labelValue(`${input.instanceId}-${input.armId}-${input.index}`, 'episode'),
  }
}

// Returns the command unchanged or throws. Placeholders must occupy a whole
// argv element: partial substitution would make the contract ambiguous.
export function validateExternalCommand(command: readonly string[]): string[] {
  if (!Array.isArray(command) || command.length === 0) throw new Error('external command must be a non-empty argv array')
  const seen = new Set<string>()
  for (const argument of command) {
    if (typeof argument !== 'string' || argument.length === 0) throw new Error('external command arguments must be non-empty strings')
    if (unsafeArgument(argument)) throw new Error('external command arguments must not contain NUL or newlines')
    const tokens = argument.match(placeholderToken) ?? []
    if (tokens.length === 0) {
      if (argument.includes('{') || argument.includes('}')) throw new Error(`external command argument has an unterminated placeholder: ${argument}`)
      continue
    }
    const match = placeholder.exec(argument)
    if (!match || tokens.length !== 1) throw new Error(`external command placeholder must occupy the whole argv element: ${argument}`)
    if (!(EXTERNAL_PLACEHOLDERS as readonly string[]).includes(match[1]!)) throw new Error(`unknown external command placeholder: ${match[1]}`)
    if (seen.has(match[1]!)) throw new Error(`duplicate external command placeholder: {${match[1]}}`)
    seen.add(match[1]!)
  }
  if (command[0] !== '{python}') throw new Error('external command must start with {python}')
  if (command[1] !== '-m' || !command[2] || command[2].startsWith('-') || command[2].includes('{')) {
    throw new Error('external command must invoke a Python module as {python} -m <module>')
  }
  for (const required of ['dataset', 'output', 'upstream_config', 'config']) {
    if (!seen.has(required)) throw new Error(`external command is missing required placeholder {${required}}`)
  }

  const indexOf = (names: readonly string[]) => command.findIndex(argument => names.includes(argument))
  const valueAfter = (names: readonly string[], label: string) => {
    const index = indexOf(names)
    if (index < 0 || index === command.length - 1) throw new Error(`external command is missing ${label}`)
    return command[index + 1]!
  }
  if (valueAfter(['--subset'], '--subset') !== '{dataset}') throw new Error('external command must pass --subset {dataset}')
  if (valueAfter(['--split'], '--split') !== 'test') throw new Error('external command must pass --split test')
  if (valueAfter(['--output', '-o'], '--output') !== '{output}') throw new Error('external command must pass --output {output}')
  if (valueAfter(['--workers', '-w'], '--workers') !== '1') throw new Error('external command must pass --workers 1')

  const configs = command
    .map((argument, index) => ({ argument, index }))
    .filter(({ argument }) => argument === '-c' || argument === '--config')
    .map(({ index }) => command[index + 1])
  if (configs.length !== 2 || configs[0] !== '{upstream_config}' || configs[1] !== '{config}') {
    throw new Error('external command must pass exactly two configs, first {upstream_config} then {config}')
  }

  for (const forbidden of ['--filter', '--slice', '--shuffle', '--model', '--environment-class', '--model-class']) {
    if (command.includes(forbidden)) throw new Error(`external command must not pass ${forbidden}; the dataset is one row and the model/environment come from the frozen config`)
  }
  // `-m` is Python's module flag only at index 1; anywhere else it is the
  // mini-SWE-agent model flag.
  if (command.slice(3).includes('-m')) throw new Error('external command must not pass -m after the Python module')
  for (const argument of command) {
    if (argument.startsWith('--model=') || argument.startsWith('--filter=') || argument.startsWith('--environment-class=')) {
      throw new Error(`external command must not pass ${argument.split('=')[0]}`)
    }
  }
  return [...command]
}

export function renderExternalArgv(command: readonly string[], values: Readonly<Record<ExternalPlaceholder, string>>): string[] {
  const rendered = command.map(argument => {
    const match = placeholder.exec(argument)
    if (!match) {
      if (argument.includes('{') || argument.includes('}')) throw new Error(`unresolved placeholder in external command: ${argument}`)
      return argument
    }
    const name = match[1] as ExternalPlaceholder
    const value = values[name]
    if (typeof value !== 'string' || value.length === 0) throw new Error(`missing external command value for {${name}}`)
    if (unsafeArgument(value)) throw new Error(`external command value for {${name}} contains NUL or newlines`)
    if (value.includes('{') || value.includes('}')) throw new Error(`external command value for {${name}} contains braces`)
    return value
  })
  for (const argument of rendered) if (unsafeArgument(argument)) throw new Error('rendered external command contains NUL or newlines')
  return rendered
}

// The baseline container uses the same isolation profile as the candidate:
// no network, read-only root, host uid/gid, one writable bind mount, no
// privileges. Labels are the only cleanup handle because mini names containers
// randomly and does not clean them after a batch.
export function buildExternalRunArgs(input: {
  workspace: string
  uid: number
  gid: number
  labels: ExternalLabels
}): string[] {
  const { workspace, uid, gid, labels } = input
  if (!workspace.startsWith('/')) throw new Error('external workspace must be an absolute POSIX path')
  if (/[,\n\r\0]/.test(workspace)) throw new Error('external workspace path contains a character Docker mount syntax cannot carry')
  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) throw new Error('external container requires a non-negative integer uid/gid')
  for (const value of [labels.batch, labels.episode]) {
    if (!/^[A-Za-z0-9_.-]{1,63}$/.test(value)) throw new Error(`invalid external container label value: ${value}`)
  }
  return [
    '--rm',
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev',
    '--user', `${uid}:${gid}`,
    '--env', 'HOME=/tmp',
    '--env', 'GIT_CONFIG_COUNT=1',
    '--env', 'GIT_CONFIG_KEY_0=safe.directory',
    '--env', 'GIT_CONFIG_VALUE_0=/testbed',
    '--mount', `type=bind,src=${workspace},dst=/testbed`,
    '--label', `mini-dsh.external.batch=${labels.batch}`,
    '--label', `mini-dsh.external.episode=${labels.episode}`,
  ]
}
