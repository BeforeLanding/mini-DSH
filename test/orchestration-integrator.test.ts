import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { commitAll, findCommitByTrailer, git, headCommit, stageAll } from '../src/orchestration/git.js'
import { WorktreeManager } from '../src/orchestration/worktrees.js'
import { newRootId } from '../src/orchestration/store.js'
import { collectAndCommit } from '../src/orchestration/integrator.js'

async function repository(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-integrator-'))
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const repo = path.join(root, 'repo')
  await fs.mkdir(repo)
  await git(repo, ['init', '--quiet'])
  await git(repo, ['config', 'core.autocrlf', 'false'])
  await fs.writeFile(path.join(repo, 'a.txt'), 'base\n')
  await stageAll(repo)
  const baseCommit = await commitAll(repo, 'initial')
  const rootId = newRootId(), manager = new WorktreeManager(repo, rootId, path.join(root, 'orch'))
  const attemptId = 'at_00000000-0000-4000-8000-000000000020'
  const attempt = await manager.createAttempt({ attemptId, subtaskId: 'st-1', epoch: 1, baseCommit })
  return { repo, rootId, baseCommit, attempt, attemptId }
}

test('a worker commit is normalized into one host commit with attempt trailers', async t => {
  const { repo, rootId, baseCommit, attempt, attemptId } = await repository(t)
  await fs.writeFile(path.join(attempt.path, 'a.txt'), 'worker\n')
  await stageAll(attempt.path)
  const workerCommit = await commitAll(attempt.path, 'worker commit without trailer')
  assert.equal(await headCommit(attempt.path), workerCommit)
  const collected = await collectAndCommit({
    worktree: attempt.path, baseCommit, writeSet: ['a.txt'], rootId, attemptId, subtaskId: 'st-1',
  })
  assert.equal(collected.outcome, 'succeeded')
  assert.deepEqual(collected.changedFiles, ['a.txt'])
  assert.notEqual(collected.commit, workerCommit)
  assert.equal(await findCommitByTrailer(repo, attempt.branch, attemptId), collected.commit)
  assert.equal((await git(attempt.path, ['rev-list', '--count', `${baseCommit}..${collected.commit}`])).trim(), '1')
  assert.equal(await fs.readFile(path.join(attempt.path, 'a.txt'), 'utf8'), 'worker\n')
})
