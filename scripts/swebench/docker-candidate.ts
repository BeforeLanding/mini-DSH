import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runCommand } from '../../src/core/command-runner.js'
import type { CommandOptions, CommandResult } from '../../src/core/command-runner.js'
import { mapHostToContainer } from './protocol.js'
import { commandInterpreter } from './command-environment.js'
import type { CommandEnvironment } from './command-environment.js'

const execFileAsync = promisify(execFile)

// The host file tools use candidateRoot; only Bash crosses into the already-created
// candidate container. No host environment variable is forwarded to docker exec.
export function createDockerCandidateRunner(candidateRoot: string, containerName: string,
  dependencies: { run?: (options: CommandOptions) => Promise<CommandResult>; terminate?: () => Promise<void>; commandEnvironment?: CommandEnvironment } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(containerName)) throw new Error('invalid candidate container name')
  let terminated = false
  const run = dependencies.run ?? runCommand
  const terminate = dependencies.terminate ?? (async () => {
    await execFileAsync('docker', ['rm', '-f', containerName], { timeout: 10_000,
      env: { PATH: process.env.PATH ?? '' } })
  })
  return async (options: CommandOptions): Promise<CommandResult> => {
    if (terminated) throw new Error('candidate container was terminated after timeout or cancellation')
    const containerCwd = mapHostToContainer(candidateRoot, options.cwd)
    const result = await run({ ...options, executable: 'docker',
      args: ['exec', '--workdir', containerCwd, containerName, ...commandInterpreter(dependencies.commandEnvironment), options.command], env: {} })
    if (result.timedOut || result.cancelled) {
      terminated = true
      await terminate()
    }
    return result
  }
}
