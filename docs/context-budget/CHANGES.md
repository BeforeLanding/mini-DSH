# 本次开发改动与功能梳理

更新：2026-09-29。开发范围为 `cfee2b5..7110917`，共 21 个独立提交，按用户指定顺序逐次推送到 `BeforeLanding/mini-DSH/main`。随后 `5969363` 清理项目注释。本文件按最终实现整理；逐步验证和历史失败记录见 [PROGRESS](../../PROGRESS.md)。

## 实现结果

项目从 JavaScript、内存会话和无固定预算的 Agent 循环，扩展为严格 TypeScript、可持久化恢复、可解释上下文投影和执行预算的 Agent Harness。CLI 可以查看预算及任务状态，显式续跑预算停止的任务。核心仍依赖服务契约，可替换模型、工具和存储；未注入预算的旧调用继续兼容。

已有 Bash、文件工具、路径/软链闸门、人工审批和 Cordis 插件生命周期保留。本次主要增加运行治理与恢复能力，没有新增自动摘要、自动重试或自动模型切换。

## 1. TypeScript 迁移与工具链

- 固定 TypeScript 7.0.2，增加 Node 类型；采用 ES2022、NodeNext、strict、noEmitOnError、verbatimModuleSyntax 和 sourceMap。
- 核心、插件、模型、工具、入口、插件配置与测试迁移到 `.ts`；`allowJs=false`。构建引导与产物语法检查脚本保留 JavaScript。
- 新增 [contracts.ts](../../src/core/contracts.ts)：明确消息、模型适配器、工具、Agent、执行上下文、回调和版本化事件接口；Cordis Context 使用类型增强。
- `pnpm typecheck` 只检查类型；`pnpm build` 先检查再清理固定 dist 目录并编译；start/test/check 使用编译产物。动态插件配置导入、启动工作目录和 `.env` 加载语义保留。
- CI 使用固定 pnpm 和锁文件，在 Ubuntu/Windows × Node22/24 执行类型、构建、语法与测试检查。

提交：`80bdffd` 工具链 → `a784b76` 核心 → `5104a99` 插件/模型/工具 → `79fb509` 测试与 CI。

## 2. 契约、状态、持久化与 usage

- [budget.ts](../../src/core/budget.ts) 校验未知字段、负数、非有限值和非安全整数。配置按 runtime 默认 → Agent → 单次调用覆盖，并在 run 开始时形成不可变快照；次数和总额度可以为 0。
- 区分 session、task、run；一次新输入开启 task，继续任务开启关联的新 run。记录模型/工具次数、输入/输出/总 token、主动时间、审批时间、裁剪任务 ID 和停止状态。
- 每个 run 只有一个终态；成功调用继续返回字符串，预算停止通过 `BudgetStop` 暴露原因和状态。终态写入未确认时不报告 completed；写盘失败报告错误并禁止新调度。
- [event-store.ts](../../src/core/event-store.ts) 实现带版本、唯一事件 ID 和递增 seq 的 JSONL；单写入者锁、串行追加和 sync。调度模型/工具前确认关键事件已写入，保存 usage、结果与终态后再推进。
- [session-runtime.ts](../../src/core/session-runtime.ts) 从事件恢复消息、状态、模型/预算设置与累计用量，不执行历史工具。reset 追加事件并切换可见历史，不删除原日志或更换 session ID。
- 未开始执行的历史调用补 skipped；已开始但没有确认结果的调用标 unknown，禁止自动续跑。恢复校验工作区、版本、结构、序号及请求生命周期；尾部半条记录须显式备份隔离，中部损坏不能静默跳过，损坏 UTF-8 尾部按原字节保留。
- [deepseek.ts](../../src/models/deepseek.ts) 支持 `max_tokens`、usage-only 流末包、finishReason 和完整响应判定；缓存/推理细分不重复计费，重复末包不重复结算。截断、残缺参数、无效响应或重复调用 ID 不进入工具执行。
- 供应商 usage 优先；缺失或中断使用统一估算，来源明确为 estimated/uncertain。流片段按 250ms 或 4KiB 合并记录，不作为完整 assistant 消息重复派生。

提交：`36f33c0` 配置 → `d024eb8` 生命周期 → `597df26` JSONL → `737f154` 恢复 → `8fe37eb` usage；`87f5941` 补估算与流式日志，`6b9d858` 加固失败边界。

## 3. 上下文管理

- [token-estimator.ts](../../src/core/token-estimator.ts) 估算完整请求，包含 system、历史、reasoning、调用 ID/参数、工具 schema 和协议封装；ASCII 字符按 0.3、其他 Unicode 码点按 1.0，加每消息 32、每请求 256 token 的工程近似。
- [context-runtime.ts](../../src/core/context-runtime.ts) 按完整 task 分组，包含该任务的所有 run；请求前优先移除最旧的完整已结束任务，工具调用/结果不能拆开。
- 保留 system、安全规则、当前用户输入及当前 task 的全过程。投影只改变发送给模型的消息集合，原始事件不变；状态记录被移除的 task ID。
- 输入必须满足输入目标，且输入估算 + 输出预留 + 安全余量不超过模型窗口；余量为 `max(配置下限, ceil(输入估算 × 10%))`。保护集合仍装不下时，以 context_overflow 停止，模型请求次数保持不变。
- 模型容量来自明确配置或适配器能力元数据；切换模型重新计算。官方 DeepSeek 端点默认模型提供保守 1,000,000 token 能力，自定义端点/模型需要显式容量。

提交：`87f5941` 估算 → `6111fcd` 分组 → `63ebe08` 投影 → `b1fb3a3` 容量停止。

## 4. 执行预算

- 模型次数包含最终回答请求和失败请求；工具次数按实际进入工具入口计，失败及拒批也计，skipped 不计。批量调用依序执行，超额度部分补齐结果；最后一次模型请求给完整纯文本可完成，若还要求工具则全部跳过后停止。
- [run-budget-runtime.ts](../../src/core/run-budget-runtime.ts) 使用可注入单调时钟，区分主动运行、审批等待、模型请求期限与用户取消。审批暂停主动计时，但有独立超时；模型和工具都接收组合 AbortSignal，结束清理计时器与监听器。
- 请求前从累计 token 余额预留输入和输出；余额变少时降低输出上限，无法保留最低输出时停止。响应后按 provider 或估算 usage 结算；重复发送的输入逐请求累计，实际超出估算时禁止后续调度。
- 停止状态包括 completed、max_steps、max_tool_calls、timeout、request_timeout、approval_timeout、token_budget、context_overflow、output_limit、cancelled、error。执行入口按取消、主动期限、对应次数、token、容量检查，竞态不产生多个终态。

提交：`c0fcdf6` 次数 → `ddcc2b0` 时间/取消 → `ac9f15a` 累计 token；`6b9d858` 修复工具取消传递与超长计时器边界。

## 5. 续跑、CLI 与恢复入口

- `agent.continue()` 和 `/continue` 在同 task 下创建新的 run，用当前有效配置刷新本段额度，保留任务累计；不追加重复用户输入、不重放已完成工具，模型根据 skipped 结果重新规划。
- completed 任务不能继续；unknown 需要先核验副作用后开始明确的新任务；context_overflow 在上下文配置与模型未变化时拒绝继续，避免仅刷新次数仍重复失败。
- [cli.ts](../../src/plugins/cli.ts) 新增 `/budget` 查看配置/状态和 `/budget {"maxModelRequests":8}` JSON 覆盖；显示 run、task 累计、usage 来源、停止原因和裁剪范围。`/model` 与 `/budget` 设置写入日志，恢复及 reset 保留当前设置。
- CLI 默认写入 `~/.mini-dsh/sessions/<sessionId>/events.jsonl` 并打印 session ID；设置 `MINI_DSH_SESSION_DIR` 覆盖目录，`MINI_DSH_SESSION_ID` 在同一规范化工作区恢复。退出等待写入并释放锁。
- 运行及审批中按 Esc 取消，方向键不会误取消；保留 `/tools`、`/models`、`/model`、`/history`、`/prompt`、`/reset`、`/exit`。
- `.env` 可配置 `MINI_DSH_BUDGET` JSON、`MINI_DSH_WORKSPACE`、`MINI_DSH_AUTO_APPROVE` 和可选 `CONTEXT7_API_KEY`。注释清理后环境示例仅保留实际默认赋值，可选项说明集中在 README 和本文件。

提交：`4c2ec65` 续跑 → `c86b895` CLI/默认持久化 → `4600379` 集成验收 → `7110917` CI 证据。

## CLI 默认值

- 每段模型请求 64 次，工具调用 128 次，主动时间 600,000ms，总 token 2,000,000。
- 输入目标 65,536，最大输出 16,384，最低输出预留 4,096；安全余量下限 2,048。
- 模型请求期限 180,000ms，审批期限 300,000ms；Bash 保留原有 30 秒期限与 32KiB 输出截断。
- 核心未注入次数/总预算时保留旧兼容行为；CLI 主动注入以上有限默认值。人工等待不扣主动时间，task 累计不随 /continue 清零。

## 验证结果与实际边界

- 原 22 条回归保留，增加 35 条有意义边界/集成测试，共 57/57，无跳过；本地类型、构建及 46 文件语法检查通过。
- 功能提交 `4600379`、交接提交 `7110917` 和注释清理提交 `5969363` 的 Ubuntu/Windows × Node22/24 CI 全部成功；[交接 CI](https://github.com/BeforeLanding/mini-DSH/actions/runs/36508994607)、[注释清理 CI](https://github.com/BeforeLanding/mini-DSH/actions/runs/36509575091)。注释清理后本地再次 57/57。
- 真实 Cordis/JSONL/文件工具集成：预算停止后关闭并重建实例再继续，文件 mtime 未改变，证明没有重复写入；任务总计模型 3 次、工具 1 次，内存和磁盘事件一致。
- [benchmark-store.ts](../../scripts/benchmark-store.ts) 可复现 1,000 次纯模拟 sync 追加：Windows Node24 单机约 645ms、每次约 0.645ms、读取校验约 3.86ms。结果是单机样本，不是吞吐或掉电耐久性承诺。
- 测试无需 API Key，模型请求使用模拟；Bash/文件/持久化为真实操作。未做付费模型任务质量实验；token 近似可能有误差，不能作为精确账单或严格费用上限。
- 不遵守 AbortSignal 的第三方工具可能继续执行，结果按 unknown 处理；恢复只重建事件状态，不恢复文件系统快照；失效 writer.lock 不自动清除。
- 未引入摘要、向量记忆、自动重试、费用预算或多 Agent 共享预算；Biome 暂不作为 CI 门槛。

## 本次追加的注释清理

`5969363` 删除已跟踪源码/测试/脚本中的行注释、块注释和行尾注释，同时清理 CI 版本旁注、`.env.example` 注释及 README 运行代码块注释。URL、正则和字符串内容、中文说明文档及实际 `.env` 保留。编译器生成的 sourceMappingURL 是既有调试映射指令，sourceMap 配置继续保留。

完整提交顺序可用 `git log --reverse --oneline cfee2b5..7110917` 查阅；具体设计参数见 [PLAN](PLAN.md)，逐项需求和证据见 [REQUIREMENTS](REQUIREMENTS.md)、[TASKS](TASKS.md)。
