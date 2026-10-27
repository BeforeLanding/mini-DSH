import { execFileSync } from 'node:child_process'

// The evaluation commit may change the harness and tests, but it must run the
// exact product source named by sourceBaseCommit.
export function assertV2ProductSourceUnchanged(repository: string, sourceBaseCommit: string, evaluationCommit: string): void {
  try {
    execFileSync('git', ['diff', '--quiet', sourceBaseCommit, evaluationCommit, '--', 'src'], { cwd: repository, stdio: 'ignore' })
  } catch {
    throw new Error('component evaluation commit changes product src/** after sourceBaseCommit')
  }
}
