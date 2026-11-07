import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  branchExists, cherryPick, cherryPickAbort, cherryPickInProgress, commitAll, findCommitByTrailer, git, headCommit,
  repositoryRoot, stageAll, stagedChangedFiles, treeOf, worktreeList,
} from '../src/orchestration/git.js'
import { WorktreeManager, attemptBranch, integrationBranchName } from '../src/orchestration/worktrees.js'
import { newRootId } from '../src/orchestration/store.js'

async function repository(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-git-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const repo = path.join(root, 'repo')
  await fs.mkdir(repo)
  await git(repo, ['init', '--quiet'])
  // 宿主 git 调用使用临时 HOME，但 Windows 的系统配置仍可能开启 autocrlf；测试钉住字节内容。
  await git(repo, ['config', 'core.autocrlf', 'false'])
  await fs.writeFile(path.join(repo, 'a.txt'), 'base\n')
  await stageAll(repo)
  const baseCommit = await commitAll(repo, 'initial')
  return { root, repo, baseCommit }
}

test('git helpers report the repository, tree and clean/dirty state', async t => {
  const { repo, baseCommit } = await repository(t)
  assert.equal(await repositoryRoot(repo), path.resolve(repo))
  assert.equal(await headCommit(repo), baseCommit)
  assert.match(await treeOf(repo, baseCommit), /^[a-f0-9]{40,64}$/)
  const manager = new WorktreeManager(repo, newRootId(), path.join(repo, '..', 'orch'))
  assert.deepEqual(await manager.assertClean(), { baseCommit, dirty: 0 })
  await fs.writeFile(path.join(repo, 'dirty.txt'), 'x')
  await assert.rejects(manager.assertClean(), /uncommitted change/)
  assert.deepEqual(await manager.assertClean({ allowDirty: true }), { baseCommit, dirty: 1 })
  await fs.rm(path.join(repo, 'dirty.txt'))
})

test('attempt worktrees commit within their branch and integrate by cherry-pick', async t => {
  const { root, repo, baseCommit } = await repository(t)
  const rootId = newRootId(), manager = new WorktreeManager(repo, rootId, path.join(root, 'orch'))
  const base = await manager.createBaseSnapshot(baseCommit)
  assert.equal(await headCommit(base), baseCommit)
  assert.equal(await fs.readFile(path.join(base, 'a.txt'), 'utf8'), 'base\n')

  const first = await manager.createAttempt({ attemptId: 'at_00000000-0000-4000-8000-000000000010', subtaskId: 'st-1', epoch: 1, baseCommit })
  assert.equal(first.branch, attemptBranch(rootId, 'st-1', 1))
  assert.equal(await branchExists(repo, first.branch), true)
  await assert.rejects(manager.createAttempt({ attemptId: 'at_00000000-0000-4000-8000-000000000011', subtaskId: 'st-1', epoch: 1, baseCommit }), /branch already exists/)
  await fs.writeFile(path.join(first.path, 'a.txt'), 'first\n')
  await fs.writeFile(path.join(first.path, 'first.txt'), 'one\n')
  await stageAll(first.path)
  assert.deepEqual((await stagedChangedFiles(first.path, baseCommit)).sort(), ['a.txt', 'first.txt'])
  const firstCommit = await commitAll(first.path, 'first change', [`Mini-DSH-Root: ${rootId}`, 'Mini-DSH-Attempt: at_00000000-0000-4000-8000-000000000010'])
  assert.match(firstCommit, /^[a-f0-9]{40,64}$/)
  assert.equal(await findCommitByTrailer(repo, first.branch, 'at_00000000-0000-4000-8000-000000000010'), firstCommit)

  const integration = await manager.createIntegration(baseCommit)
  assert.equal(integration.branch, integrationBranchName(rootId))
  const applied = await cherryPick(integration.path, firstCommit)
  assert.equal(applied.ok, true)
  assert.deepEqual(applied.args, ['-c', 'user.name=mini-dsh', '-c', 'user.email=mini-dsh@localhost', 'cherry-pick', '-x', firstCommit])
  assert.equal(await fs.readFile(path.join(integration.path, 'a.txt'), 'utf8'), 'first\n')
  assert.equal(await cherryPickInProgress(integration.path), false)

  const second = await manager.createAttempt({ attemptId: 'at_00000000-0000-4000-8000-000000000012', subtaskId: 'st-2', epoch: 1, baseCommit })
  await fs.writeFile(path.join(second.path, 'a.txt'), 'second\n')
  await stageAll(second.path)
  const secondCommit = await commitAll(second.path, 'conflicting change')
  const integrationHead = await headCommit(integration.path)
  const conflict = await cherryPick(integration.path, secondCommit)
  assert.equal(conflict.ok, false, `${conflict.result.stdout.text}
${conflict.result.stderr.text}`)
  assert.equal(await cherryPickInProgress(integration.path), true)
  await cherryPickAbort(integration.path)
  assert.equal(await headCommit(integration.path), integrationHead)

  await manager.cleanup()
  assert.equal(await branchExists(repo, first.branch), false)
  assert.equal(await branchExists(repo, integration.branch), false)
  assert.deepEqual(await worktreeList(repo), [path.resolve(repo)])
  assert.equal(await fs.readFile(path.join(repo, 'a.txt'), 'utf8'), 'base\n')
  assert.deepEqual(await manager.assertClean(), { baseCommit, dirty: 0 })
})

test('prepare commands run inside the worktree and block the attempt on failure', async t => {
  const { root, repo, baseCommit } = await repository(t)
  const rootId = newRootId()
  const manager = new WorktreeManager(repo, rootId, path.join(root, 'orch'), { prepareCommand: 'echo prepared > prepared.txt' })
  const attempt = await manager.createAttempt({ attemptId: 'at_00000000-0000-4000-8000-000000000013', subtaskId: 'st-1', epoch: 1, baseCommit })
  await manager.prepare(attempt.path)
  assert.equal((await fs.readFile(path.join(attempt.path, 'prepared.txt'), 'utf8')).trim(), 'prepared')
  const failing = new WorktreeManager(repo, newRootId(), path.join(root, 'orch2'), { prepareCommand: 'echo broken >&2; exit 7' })
  const other = await failing.createAttempt({ attemptId: 'at_00000000-0000-4000-8000-000000000014', subtaskId: 'st-1', epoch: 1, baseCommit })
  await assert.rejects(failing.prepare(other.path), /prepare command failed.*broken/s)
})
