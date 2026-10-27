import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { assertV2ProductSourceUnchanged } from '../scripts/eval-v2-provenance.js'

test('component evaluation commits may change documentation but cannot change product source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-dsh-v2-source-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'safe.directory=*', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim()
  try {
    git('init', '-q')
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'src', 'product.ts'), 'export const value = 1\n')
    git('add', '.'); git('commit', '-qm', 'source')
    const source = git('rev-parse', 'HEAD')
    fs.writeFileSync(path.join(root, 'README.md'), 'evaluation notes\n')
    git('add', '.'); git('commit', '-qm', 'evaluation')
    assert.doesNotThrow(() => assertV2ProductSourceUnchanged(root, source, git('rev-parse', 'HEAD')))
    fs.writeFileSync(path.join(root, 'src', 'product.ts'), 'export const value = 2\n')
    git('add', '.'); git('commit', '-qm', 'unexpected product edit')
    assert.throws(() => assertV2ProductSourceUnchanged(root, source, git('rev-parse', 'HEAD')), /changes product src/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
