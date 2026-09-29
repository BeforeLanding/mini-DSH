import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ProjectContextRuntime } from '../src/core/project-context-runtime.js'
import { resolveInside } from '../src/utils/path.js'

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
    assert.equal(loaded.contentBytes, Buffer.byteLength('root-rulesrc-rule') + Buffer.byteLength(JSON.stringify(loaded.metadata)))
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

test('native path checks accept internal directory aliases including Windows short names without allowing escape', async () => {
  const f = await fixture()
  try {
    const canonical = await fs.realpath(f.workspace)
    const aliasRoot = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:MINI_DSH_TEST_PATH).ShortPath'], {
        encoding: 'utf8', env: { ...process.env, MINI_DSH_TEST_PATH: f.workspace },
      }).trim()
      : f.workspace
    assert.ok(aliasRoot)
    await fs.mkdir(path.join(canonical, 'shared'))
    await fs.writeFile(path.join(canonical, 'shared', 'AGENTS.md'), 'internal-rule')
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    await fs.symlink(path.join(aliasRoot, 'shared'), path.join(canonical, 'alias'), linkType)
    const loader = new ProjectContextRuntime(aliasRoot)
    const result = await loader.load('alias')
    assert.equal(result.workspace, canonical)
    assert.equal(result.directory, 'shared')
    assert.equal(result.rules[0].source, 'shared/AGENTS.md')
    assert.equal(result.rules[0].content, 'internal-rule')
    assert.equal(resolveInside(canonical, 'alias/new/file.txt'), path.join(canonical, 'alias/new/file.txt'))
    const outside = path.join(f.directory, 'outside')
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(canonical, 'escape'), linkType)
    await assert.rejects(loader.load('escape'), /path escapes/)
    assert.throws(() => resolveInside(canonical, 'escape/new/file.txt'), /path escapes/)
  } finally { await f.close() }
})

test('project metadata selects nearest explicit package and config markers without executing scripts', async () => {
  const f = await fixture()
  try {
    await fs.mkdir(path.join(f.workspace, '.git'))
    await fs.mkdir(path.join(f.workspace, 'app'))
    await fs.writeFile(path.join(f.workspace, 'package.json'), JSON.stringify({ packageManager: 'npm@11', scripts: { test: 'parent-test' } }))
    await fs.writeFile(path.join(f.workspace, 'app', 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.22.0', engines: { node: '>=22' },
      scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'executed\', \'bad\')"', check: 'node check.mjs', postinstall: 'must-not-load' } }))
    for (const name of ['tsconfig.json', 'pnpm-lock.yaml', 'README.md']) await fs.writeFile(path.join(f.workspace, name), 'marker-only')
    const loader = new ProjectContextRuntime(f.workspace)
    const result = await loader.load('app')
    assert.equal(result.metadata.repositoryRoot, '.')
    assert.equal(result.metadata.package?.path, 'app/package.json')
    assert.equal(result.metadata.package?.source, 'app/package.json')
    assert.equal(result.metadata.package?.packageManager, 'pnpm@11.22.0')
    assert.equal(result.metadata.package?.node, '>=22')
    assert.equal(result.metadata.package?.scripts.check, 'node check.mjs')
    assert.deepEqual(Object.keys(result.metadata.package!.scripts), ['test', 'check'])
    assert.deepEqual(result.metadata.markers.map(m => m.kind), ['typescript', 'pnpm-lock', 'readme'])
    await assert.rejects(fs.access(path.join(f.workspace, 'app', 'executed')))
    await fs.writeFile(path.join(f.workspace, 'app', 'package.json'), '{"scripts":{"lint":"updated"}}')
    assert.deepEqual((await loader.load('app')).metadata.package?.scripts, { lint: 'updated' })
  } finally { await f.close() }
})

test('non-Git and missing, malformed or oversized project configs degrade with explicit notices', async () => {
  const f = await fixture()
  try {
    const loader = new ProjectContextRuntime(f.workspace)
    const empty = await loader.load()
    assert.deepEqual(empty.metadata, { repositoryRoot: null, markers: [], notices: [] })
    await fs.mkdir(path.join(f.workspace, 'app'))
    await fs.writeFile(path.join(f.workspace, 'package.json'), '{"scripts":{"test":"parent"}}')
    await fs.writeFile(path.join(f.workspace, 'app', 'package.json'), '{')
    const invalid = await loader.load('app')
    assert.equal(invalid.metadata.package, undefined)
    assert.match(invalid.metadata.notices.join('\n'), /app\/package.json/)
    await fs.writeFile(path.join(f.workspace, 'app', 'package.json'), '{"scripts":{"test":7,"check":"ok"}}')
    const script = await loader.load('app')
    assert.deepEqual(script.metadata.package?.scripts, { check: 'ok' })
    assert.match(script.metadata.notices.join('\n'), /invalid test script/)
    const capped = await new ProjectContextRuntime(f.workspace, { maxFileBytes: 1 }).load('app')
    assert.equal(capped.metadata.package, undefined)
    assert.match(capped.metadata.notices.join('\n'), /maxFileBytes/)
    const aggregate = await new ProjectContextRuntime(f.workspace, { maxContentBytes: 1 }).load('app')
    assert.equal(aggregate.metadata.package, undefined)
    assert.match(aggregate.metadata.notices.join('\n'), /maxContentBytes/)
    assert.equal(aggregate.contentBytes, 0)
  } finally { await f.close() }
})

test('project metadata never reads outward symlink configs or README bodies', async () => {
  const f = await fixture()
  try {
    const outside = path.join(f.directory, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'package.json'), '{"scripts":{"test":"external-secret"}}')
    if (process.platform === 'win32') await fs.symlink(outside, path.join(f.workspace, 'package.json'), 'junction')
    else await fs.symlink(path.join(outside, 'package.json'), path.join(f.workspace, 'package.json'))
    await fs.writeFile(path.join(f.workspace, 'README.md'), 'readme-body-not-for-injection'.repeat(1000))
    const context = await new ProjectContextRuntime(f.workspace).load()
    assert.equal(context.metadata.package, undefined)
    assert.match(context.metadata.notices.join('\n'), /package.json/)
    assert.doesNotMatch(JSON.stringify(context), /external-secret|readme-body-not-for-injection/)
    assert.deepEqual(context.metadata.markers, [{ path: 'README.md', kind: 'readme' }])
  } finally { await f.close() }
})
