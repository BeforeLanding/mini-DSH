# 开发进度

更新：2026-11-06。本页只维护当前 main 的状态、实际阻塞与下一步；历史实验与分支决定按原日期归档，不再作为当前开发清单。

## 当前状态

- **交付范围：单 Agent、本地工作区。** TypeScript / Cordis CLI 保留文件与 Bash 工具、项目规则、版本化检查证据、上下文投影/压缩/回读、预算、JSONL 持久化与恢复、只读日志检查、显式配置 MCP。
- **只读委派已回到 main（默认关闭，2026-11-06，M0）；项目记忆仍只在独立分支。** `MINI_DSH_DELEGATION=read-only` 时主 Agent 可调用 `delegate_tasks`，只读子 Agent 并发 2、共用任务组预算、崩溃后不重跑；关闭时工具 schema 哈希与 v0.2.0 相同（测试钉住）。记忆随 [feat/memory-team-eval-v2@2f2dca9](https://github.com/BeforeLanding/mini-DSH/tree/feat/memory-team-eval-v2) 暂不合入。后续多 Agent 编排按 [docs/superagent/DEVELOPMENT.md](docs/superagent/DEVELOPMENT.md) 的 M1—M4 推进。
- **SWE 实验：结果入 main，运行器留分支。** main 保留旧版预注册与零模型评分通道及移植后的组件；三臂运行器、manifest 与完整过程在 [improve/swe-harness-advantage-20261031@b4b7c43](https://github.com/BeforeLanding/mini-DSH/tree/b4b7c43)，结果摘要见 [SWE-BENCH-RESULTS](docs/SWE-BENCH-RESULTS.md)。更早的正式四臂实现在 [feat/swebench-formal-results@dc7e659](https://github.com/BeforeLanding/mini-DSH/tree/dc7e659883b9729f6f10510d5067f31a42361fee)，不重新合入 main。
- **SWE 长单任务组件已并入 main，默认关闭（2026-11-01）。** 观测遮蔽、预算提示、收尾检查与复核、紧凑命令结果、宿主提示从 SWE 分支移植；`CLI_BUDGET` 与默认能力清单不变，CLI 用户可经 `MINI_DSH_BUDGET` 打开前三项。SWE 运行器与原始证据仍在分支。
- **组件开发评测已收口。** 三组件离线对照与实际开发消融均有记录；真实归因均为 `inconclusive`，摘要后裁剪继续默认关闭。历史样本不支撑泛化或效率收益主张，见 [开发批结果](docs/context-budget/COMPONENT-LOO-PAID-RESULT.md)。
- **main 功能撤回验收已通过（v0.2.0 时点；M0 之后 `src/` 已新增只读委派，下列比对不再适用）。** `src/` 与 PR #7 第一父提交 `a5d9191` 一致；构建和 202 文件语法检查、232 文件 lint 通过；正常用户环境完整回归 546 项：516 pass、0 fail、30 平台条件 skipped。公开样例复算、编程夹具及组件基准通过。命令与边界见 [PORT-1 证据](docs/context-budget/CHANGES.md#port-1-main-撤回记忆与只读协作2026-10-30)。
- **当前代码 CI 全绿。** [CI 41211546998](https://github.com/BeforeLanding/mini-DSH/actions/runs/41211546998) 对应 PR #20 的 `7689c81`，其树与合并后的 main `4de3219` 相同；Ubuntu/Windows × Node 22/24、Linux isolation、Ubuntu package-install 六个必需 job 全部 success，SWE PoC 按配置 skipped，不计为已执行。相对验收基线 `46b8fb1`，`src/` 与依赖未变；之后的提交只改演示标题文案（`5fab772`）、文档、图片与文档回归测试。
- **README 已有脚本化演示动图（2026-10-31）。** 首屏的 [预算续跑动图](docs/images/demo-resume.gif) 由 [`scripts/demo-resume.tape`](scripts/demo-resume.tape) 驱动 `pnpm demo:resume` 录制，使用预设模型响应，不调用付费 API；架构图改为矢量源 [architecture.svg](docs/images/architecture.svg) 导出。完整讲解视频尚未录制。
- **v0.2.0 已发布（2026-11-01）。** 相对 v0.1.1 新增可选的长单任务组件（默认关闭）与 [SWE-bench 结果页](docs/SWE-BENCH-RESULTS.md)；标签 `v0.2.0` 指向 PR #24 的合并提交，[GitHub Release](https://github.com/BeforeLanding/mini-DSH/releases/tag/v0.2.0) 附 tarball 与 `SHA256SUMS`。v0.1.0（`4de3219`，首个版本）与 v0.1.1（`86bbd66`，依赖漏洞修复）的 Release 保留。npm 未发布。

## 阻塞

- 暂无已确认的单 Agent 功能或交付检查阻塞；本版代码 CI、Windows 仓库外安装与文档检查已完成，详见 [当前源码验收](docs/DELIVERY-20261030.md)。
- 30 项本地跳过的 Linux 隔离检查已由当前代码提交的 isolation job 核验，仍不计作本地通过。
- 完整讲解视频尚未录制，不作为源码作品投递前置条件。npm、ECS 部署及新付费评测不属于本轮交付，不作为源码作品投递前置条件。

## 下一步

1. 以 [v0.2.0 Release](https://github.com/BeforeLanding/mini-DSH/releases/tag/v0.2.0) 交付；源码验收见 [DELIVERY-20261030](docs/DELIVERY-20261030.md)，其后的演示标题与文档改动由上述 CI 覆盖。后续再有代码变化时重新验收并另发版本，不继续复用旧绿灯。
2. 核对本地简历锚点与五题问答；个人实际贡献和 AI 辅助范围由本人确认，不根据 Git 作者名代作身份判断。
3. 完整讲解视频待用户安排录制；记忆/协作后续开发、付费实验和 npm 发布由后续明确任务决定。

## 历史记录

- [2026-09-28 至 2026-09-30](docs/history/PROGRESS-2026-09-28--2026-09-30.md)
- [2026-10-01 至 2026-10-28](docs/history/PROGRESS-2026-10-01--2026-10-28.md)：保存原进度、当时的阻塞与下一步；不代表现行计划。
- [逐项改动与验收](docs/context-budget/CHANGES.md)、[当前收尾清单](docs/context-budget/TASKS.md)

## 更新规则

- 当前状态发生变化才更新本页；逐提交命令与结果记入 CHANGES，历史状态归档。
- 不修改历史实验数字来描述当前实现；未执行、平台跳过及未获支持的结论明确标注。
