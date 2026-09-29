import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProjectContextRuntime } from '../src/core/project-context-runtime.js'

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-dsh-context-'))
  const workspace = path.join(directory, 'workspace')
  await fs.mkdir(workspace)
  return { directory, workspace, async close() {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
    await fs.rm(directory, { recursive: true, force: true })
  } }
}

test('project rules follow only the target ancestor chain with explicit scopes and fresh reads', async () => {
  const f = await fixture()
  try {
    await fs.mkdir(path.join(f.workspace, 'src', 'nested'), { recursive: true })
    await fs.mkdir(path.join(f.workspace, 'other'))
    await fs.writeFile(path.join(f.directory, 'AGENTS.md'), 'outside-parent')
    await fs.writeFile(path.join(f.workspace, 'AGENTS.md'), 'root-rule')
    await fs.writeFile(path.join(f.workspace, 'src', 'AGENTS.md'), 'src-rule')
    await fs.writeFile(path.join(f.workspace, 'other', 'AGENTS.md'), 'sibling-rule')
    const loader = new ProjectContextRuntime(f.workspace)
    const loaded = await loader.load('src/nested')
    assert.deepEqual(loaded.rules.map(r => [r.path, r.source, r.scope, r.content]), [
      ['AGENTS.md', 'AGENTS.md', '.', 'root-rule'], ['src/AGENTS.md', 'src/AGENTS.md', 'src', 'src-rule'],
    ])
    assert.equal(loaded.directory, 'src/nested')
    assert.equal(loaded.contentBytes, Buffer.byteLength('root-rulesrc-rule'))
    assert.equal((await loader.load()).rules.length, 1)
    await fs.writeFile(path.join(f.workspace, 'src', 'AGENTS.md'), 'updated-rule')
    assert.equal((await loader.load('src')).rules.at(-1)?.content, 'updated-rule')
    await fs.unlink(path.join(f.workspace, 'src', 'AGENTS.md'))
    assert.equal((await loader.load('src')).rules.length, 1)
  } finally { await f.close() }
})

test('rule loading rejects file, aggregate and ancestor limits without returning partial rules', async () => {
  const f = await fixture()
  try {
    await fs.mkdir(path.join(f.workspace, 'child'))
    await fs.writeFile(path.join(f.workspace, 'AGENTS.md'), '中文')
    await fs.writeFile(path.join(f.workspace, 'child', 'AGENTS.md'), 'abc')
    assert.equal((await new ProjectContextRuntime(f.workspace, { maxFileBytes: 6, maxContentBytes: 9 }).load('child')).contentBytes, 9)
    await assert.rejects(new ProjectContextRuntime(f.workspace, { maxFileBytes: 5 }).load(), /maxFileBytes/)
    await assert.rejects(new ProjectContextRuntime(f.workspace, { maxContentBytes: 8 }).load('child'), /maxContentBytes/)
    await assert.rejects(new ProjectContextRuntime(f.workspace, { maxDirectories: 1 }).load('child'), /maxDirectories/)
    await assert.rejects(new ProjectContextRuntime(f.workspace).load('AGENTS.md'), /must be a directory/)
    for (const value of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => new ProjectContextRuntime(f.workspace, { maxFileBytes: value }), /invalid project context/)
    assert.throws(() => new ProjectContextRuntime(f.workspace, { unknown: 1 } as object), /invalid project context/)
    assert.throws(() => new ProjectContextRuntime(f.workspace, { toString: 1 } as object), /invalid project context/)
  } finally { await f.close() }
})

test('missing rules degrade to an empty list; invalid UTF-8 and non-file rules fail explicitly', async () => {
  const f = await fixture()
  try {
    const loader = new ProjectContextRuntime(f.workspace)
    assert.deepEqual((await loader.load()).rules, [])
    await fs.writeFile(path.join(f.workspace, 'AGENTS.md'), Buffer.from([0xe4, 0xb8]))
    await assert.rejects(loader.load(), /project context AGENTS.md/)
    await fs.unlink(path.join(f.workspace, 'AGENTS.md'))
    await fs.mkdir(path.join(f.workspace, 'AGENTS.md'))
    await assert.rejects(loader.load(), /not a regular file/)
  } finally { await f.close() }
})

test('rule loading rejects escaped directories and outward file/directory symlinks', async () => {
  const f = await fixture()
  try {
    const outside = path.join(f.directory, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'AGENTS.md'), 'must-not-load')
    const loader = new ProjectContextRuntime(f.workspace)
    await assert.rejects(loader.load('../outside'), /path escapes/)
    await fs.symlink(outside, path.join(f.workspace, 'outward'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(loader.load('outward'), /path escapes/)
    await fs.symlink(process.platform === 'win32' ? outside : path.join(outside, 'AGENTS.md'), path.join(f.workspace, 'AGENTS.md'), process.platform === 'win32' ? 'junction' : 'file')
    await assert.rejects(loader.load(), /path escapes/)
    await fs.unlink(path.join(f.workspace, 'AGENTS.md'))
    if (process.platform === 'win32') {
      await fs.mkdir(path.join(f.workspace, 'shared'))
      await fs.writeFile(path.join(f.workspace, 'shared', 'AGENTS.md'), 'internal-rule')
      await fs.symlink(path.join(f.workspace, 'shared'), path.join(f.workspace, 'alias'), 'junction')
      assert.equal((await loader.load('alias')).rules[0].source, 'shared/AGENTS.md')
      assert.equal((await loader.load('alias')).rules[0].scope, 'shared')
    } else {
      await fs.writeFile(path.join(f.workspace, 'shared.md'), 'internal-rule')
      await fs.symlink(path.join(f.workspace, 'shared.md'), path.join(f.workspace, 'AGENTS.md'))
      assert.equal((await loader.load()).rules[0].source, 'shared.md')
      assert.equal((await loader.load()).rules[0].scope, '.')
    }
  } finally { await f.close() }
})
