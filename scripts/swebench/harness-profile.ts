import type { HarnessConfig } from '../../src/app/create-harness.js'

// SWE 评测里 mini-DSH 臂的两种装配。v1 是 2026-10 正式批次的候选装配；swe-full 打开为单任务长轨迹设计的
// 组件（紧凑命令结果、较小预览、任务工作流说明），预算侧的开关（observationWindow / budgetNotices /
// completionChecks）随 arm.budget 冻结在 manifest 里。两者都不改模型、工具集合或 Prompt 模板。
export type SwebenchHarness = 'v1' | 'swe-full'

export function validateSwebenchHarness(value: unknown): SwebenchHarness {
  if (value === undefined) return 'v1'
  if (value !== 'v1' && value !== 'swe-full') throw new Error('harness must be v1 or swe-full')
  return value
}

export const SWE_FULL_GUIDANCE = [
  '## Repository task workflow',
  'The repository is the workspace root. Bash runs inside the task container at /testbed (the same files) with the project Python environment activated. Use workspace-relative paths for file tools and bash cwd; a traceback path /testbed/pkg/mod.py is pkg/mod.py.',
  'Work in this order: (1) locate the relevant code with grep -n and short ranged reads; (2) reproduce the problem with a small script written under /tmp and run it; (3) fix the library source; (4) rerun the reproduction and the most relevant existing tests with the project runner (for example python -m pytest -q path/to/test_file.py -k name, or tests/runtests.py for Django); (5) stop with a short summary.',
  'Keep tool output small: grep -n, sed -n \'START,ENDp\', head/tail and quiet test flags. Never print whole large files or full test suites. Each request re-sends the conversation and older tool outputs are shortened automatically, so state key findings (file, line, cause) in your own words when you find them.',
  'Do not install packages, do not edit existing tests, and do not leave temporary files in the repository. Do not run git stash, checkout or reset on your own edits. Edits stay in the files if the run stops early, so apply a fix as soon as you are confident and refine it afterwards.',
].join('\n')

export function harnessOptions(harness: SwebenchHarness): Pick<HarnessConfig, 'toolOutputCommandFormat' | 'toolOutputMaxPreviewBytes' | 'hostGuidance'> {
  return harness === 'swe-full' ? { toolOutputCommandFormat: 'text', toolOutputMaxPreviewBytes: 8 * 1024, hostGuidance: SWE_FULL_GUIDANCE } : {}
}

// swe-full 臂冻结的预算开关：保留最近 4～11 条工具结果正文，每 8 条推进一次遮蔽。离线缓存模拟（正式批 1,053 次请求）：
// 估算输入相对 v1 −32%，前缀命中约 84%；冒烟批用过的窗口 6/步长 3 为 −33%、命中约 75%，输入费用高出近一半。
export const SWE_FULL_BUDGET = { observationWindow: 4, observationStep: 8, budgetNotices: true, completionChecks: true } as const
