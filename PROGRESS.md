# 开发进度

更新：2026-09-30。历史逐步记录已整体迁入 [2026-09-28 至 2026-09-30 归档](docs/history/PROGRESS-2026-09-28--2026-09-30.md)；本文件只维护当前状态、阻塞和下一步。

## 当前状态

- 主分支基线：TypeScript / Cordis 本地 coding agent harness；`pnpm check`、150 项测试及 12 项 fixture 基线在本轮本地验证通过。
- T1 已完成：Deploy ECS 仅由 `vMAJOR.MINOR.PATCH` tag push 或带明确 ref 的 `workflow_dispatch` 触发，普通 main/PR 不部署；目标提交必须属于 main 历史。
- T1 提交：`2ac85bd`（工作流）与 `92507d4`（纯文档探针）。[CI 36662206000](https://github.com/BeforeLanding/mini-DSH/actions/runs/36662206000) 四组成功；[CI 36662393361](https://github.com/BeforeLanding/mini-DSH/actions/runs/36662393361) 的 Windows Node22 首次因 fixture 子进程超时失败，失败作业重跑后成功。两个 SHA 均无 Deploy ECS run。
- T2 已实现：main push 忽略 `docs/**`、`PROGRESS.md`、`README.md`、`AGENTS.md` 与 `docs/history/**`；pull_request、Ubuntu/Windows × Node22/24 matrix 和 concurrency 未变。
- T2 提交：`263d439`；[CI 36662938984](https://github.com/BeforeLanding/mini-DSH/actions/runs/36662938984) 四组成功。纯文档提交 `ef46988` 的 workflow run 与 check run 均为 0，路径过滤已远端验收。
- T3 已完成：本文件从 500 行历史日志改为 31 行当前状态页，原文移动归档；TASKS 从 336 行降为 39 行，详细证据迁入 CHANGES，证据集合与链接检查通过。

## 阻塞

- 无功能阻塞。
- GitHub Actions 的 Windows fixture 偶有子进程时限波动；本轮一次失败重跑成功，未改测试时限。
- T6 Biome 仍待只读诊断；在用户选择方案前不修改 Biome、依赖或 CI 门禁。

## 下一步

1. 按新文档结构修订 AGENTS 提交粒度规则。
2. 完成版本标签与回滚规范。
3. 运行 Biome 只读诊断并等待用户选择修复或移除。

## 更新规则

- 本文件只在当前状态、实际阻塞或下一步发生变化时更新，不再逐提交追加历史日志。
- 任务清单只保留可扫描状态；详细实现与验收证据进入 CHANGES，阶段性过程进入 `docs/history/`。
- 未执行的检查明确标注；设计完成不写成功能完成，跨平台结论只引用实际 CI。
