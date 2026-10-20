import os from 'node:os'
import path from 'node:path'

// Only operational variables are inherited. Credentials, proxies, loader hooks and
// Git/SSH configuration require explicit caller configuration.
const common = ['PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMP', 'TEMP', 'TMPDIR']
const windows = ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)', 'PROCESSOR_ARCHITECTURE']

export function childEnvironment(home: string, additions: NodeJS.ProcessEnv = {}, parent: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (!path.isAbsolute(home)) throw new Error('child home must be absolute')
  const allowed = platform === 'win32' ? [...common, ...windows] : common
  const env: NodeJS.ProcessEnv = {}
  for (const name of allowed) {
    const key = Object.keys(parent).find(candidate => candidate.toLowerCase() === name.toLowerCase())
    if (key && parent[key] !== undefined) env[name] = parent[key]
  }
  env.HOME = home
  if (platform === 'win32') {
    env.USERPROFILE = home
    env.HOMEDRIVE = path.win32.parse(home).root.slice(0, 2)
    env.HOMEPATH = home.slice(2)
  } else {
    env.XDG_CONFIG_HOME = path.join(home, '.config')
    env.XDG_CACHE_HOME = path.join(home, '.cache')
  }
  for (const [name, value] of Object.entries(additions)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value === undefined || typeof value !== 'string') throw new Error('invalid explicit child environment variable')
    if (['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'].includes(name.toUpperCase())) throw new Error('child home cannot be overridden')
    env[name] = value
  }
  return env
}

export async function temporaryChildHome() {
  const fs = await import('node:fs/promises')
  return fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-child-'))
}
