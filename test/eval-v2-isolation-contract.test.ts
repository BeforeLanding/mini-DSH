import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createIsolationBackend, isolatedCommandArgs, windowsToWslPath } from '../scripts/eval-v2-isolation.js'

test('Windows paths map to WSL /mnt paths without changing relative segments', () => {
  assert.equal(windowsToWslPath('C:\\Users\\Runner\\work space'), '/mnt/c/Users/Runner/work space')
  assert.equal(windowsToWslPath('d:\\agent\\mini-dsh'), '/mnt/d/agent/mini-dsh')
  assert.throws(() => windowsToWslPath('\\\\server\\share\\path'), /local Windows drive path/)
})

test('the WSL argument builder is explicit about its platform', () => {
  if (process.platform === 'win32') return
  assert.throws(() => isolatedCommandArgs({ workspace: process.cwd(), runtimeRoot: process.cwd() }, process.cwd(), 'true'), /only available on Windows/)
})

test('backend selection follows the platform and records a runtime fingerprint', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-v2-contract-'))
  try {
    const runtimeRoot = path.join(directory, 'runtime')
    await fs.mkdir(path.join(runtimeRoot, 'usr', 'bin'), { recursive: true })
    await fs.writeFile(path.join(runtimeRoot, 'usr', 'bin', 'node'), 'fake-runtime-node')
    const workspace = path.join(directory, 'workspace')
    await fs.mkdir(workspace)
    const backend = createIsolationBackend({ workspace, runtimeRoot })
    assert.equal(backend.kind, process.platform === 'win32' ? 'wsl-bwrap' : 'linux-bwrap')
    const manifest = await backend.capabilityManifest()
    assert.equal(manifest.platform, process.platform)
    assert.match(manifest.runtimeDigest, /^[a-f0-9]{64}$/)
    assert.equal(manifest.network, 'isolated')
    if (process.platform === 'win32') assert.throws(() => createIsolationBackend({ workspace, runtimeRoot, backend: 'bwrap' }), /requires Linux/)
    else assert.throws(() => createIsolationBackend({ workspace, runtimeRoot, backend: 'wsl' }), /requires Windows/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('a runtime without the pinned Node binary is rejected before any isolation call', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-v2-contract-'))
  try {
    const backend = createIsolationBackend({ workspace: directory, runtimeRoot: directory })
    await assert.rejects(async () => backend.capabilityManifest(), /ENOENT|no Linux Node binary/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
