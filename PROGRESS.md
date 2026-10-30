# 开发进度

更新：2026-10-30。本页只维护当前 main 的状态、实际阻塞与下一步；历史实验与分支决定按原日期归档，不再作为当前开发清单。

## 当前状态

- **交付范围：单 Agent、本地工作区。** TypeScript / Cordis CLI 保留文件与 Bash 工具、项目规则、版本化检查证据、上下文投影/压缩/回读、预算、JSONL 持久化与恢复、只读日志检查、显式配置 MCP。
- **记忆与只读协作仅保留在独立分支。** `46b8fb1` 撤回 PR #7 对 main 的集成；完整实现、审查修复与后续评测保留在 [feat/memory-team-eval-v2@2f2dca9](https://github.com/BeforeLanding/mini-DSH/tree/2f2dca9f4f968485d9eb5f950f2accf173ce4539)，暂不合入 main，不列为本版交付待办。分支会话使用独立目录。
- **SWE 正式实验保持分支隔离。** main 保留旧版预注册与零模型评分通道，正式四臂实现与结果在 [feat/swebench-formal-results@dc7e659](https://github.com/BeforeLanding/mini-DSH/tree/dc7e659883b9729f6f10510d5067f31a42361fee)，不重新合入 main；不把它写成“尚未执行”的 main 任务。
- **组件开发评测已收口。** 三组件离线对照与实际开发消融均有记录；真实归因均为 `inconclusive`，摘要后裁剪继续默认关闭。历史样本不支撑泛化或效率收益主张，见 [开发批结果](docs/context-budget/COMPONENT-LOO-PAID-RESULT.md)。
- **main 功能撤回验收已通过。** `src/` 与 PR #7 第一父提交 `a5d9191` 一致；构建和 202 文件语法检查、232 文件 lint 通过；正常用户环境完整回归 546 项：516 pass、0 fail、30 平台条件 skipped。公开样例复算、编程夹具及组件基准通过。命令与边界见 [PORT-1 证据](docs/context-budget/CHANGES.md#port-1-main-撤回记忆与只读协作2026-10-30)。
- **新代码 CI 待本次运行确认。** [CI 41045952548](https://github.com/BeforeLanding/mini-DSH/actions/runs/41045952548) 对应 `46b8fb1`；不能用撤回前的旧绿灯代替。main 后续若仅修改文档，引用此代码基线并检查实际 diff。

## 阻塞

- 暂无已确认的单 Agent 功能阻塞；本次代码 CI 和交付材料验收待收尾。
- 30 项本地跳过需要 Linux 隔离环境，须由当前代码提交的 CI isolation job 核验，不能计作本地通过。
- 演示录制按用户要求暂缓。npm、面向使用者的 tag/Release、ECS 部署及新付费评测不属于本轮交付，不作为源码作品投递前置条件。

## 下一步

1. 完成 PORT-2 文档一致性检查与 PORT-3 当前源码验收记录，核对 `46b8fb1` 的 required CI。
2. 核对本地简历锚点与五题问答；个人实际贡献和 AI 辅助范围由本人确认，不根据 Git 作者名代作身份判断。
3. 演示录制待用户恢复；记忆/协作后续开发、付费实验和公开发布由后续明确任务决定。

## 历史记录

- [2026-09-28 至 2026-09-30](docs/history/PROGRESS-2026-09-28--2026-09-30.md)
- [2026-10-01 至 2026-10-28](docs/history/PROGRESS-2026-10-01--2026-10-28.md)：保存原进度、当时的阻塞与下一步；不代表现行计划。
- [逐项改动与验收](docs/context-budget/CHANGES.md)、[当前收尾清单](docs/context-budget/TASKS.md)

## 更新规则

- 当前状态发生变化才更新本页；逐提交命令与结果记入 CHANGES，历史状态归档。
- 不修改历史实验数字来描述当前实现；未执行、平台跳过及未获支持的结论明确标注。
