import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ignorePinnedImageBuildArtifact } from '../scripts/swebench/workspace.js'

test('only the pinned image may ignore its sole untracked build artifact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swebench-image-artifact-'))
  try {
    execFileSync('git', ['init', '-q', root])
    await fs.mkdir(path.join(root, 'build'))
    await fs.writeFile(path.join(root, 'build', 'generated.py'), 'generated\n')
    const digest = 'sha256:b2733e57feb4cfaeac24ab5ec496d4cb89a37db53bd0ca72eaededdb2ce19d1c'
    assert.equal(await ignorePinnedImageBuildArtifact('sha256:other', root), false)
    await fs.writeFile(path.join(root, 'unexpected.txt'), 'unexpected\n')
    assert.equal(await ignorePinnedImageBuildArtifact(digest, root), false)
    await fs.rm(path.join(root, 'unexpected.txt'))
    assert.equal(await ignorePinnedImageBuildArtifact(digest, root), true)
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '')
    assert.equal(await fs.readFile(path.join(root, 'build', 'generated.py'), 'utf8'), 'generated\n')
    execFileSync('git', ['add', '-A'], { cwd: root })
    assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).trim(), '')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
