# 编程任务 fixture（NX-05a / NX-05b）

这 12 个无依赖 Node ESM 小项目用于验证 Harness 的读文件、编辑和执行检查流程。模拟模型按预设工具序列执行，参考解由测试驱动方持有；它们不代表真实模型自主编程成功率。

**真实模型跑过之后，这条边界已经量化**（NX-08g0）：筛查批次 12/12、对照 A 6/6，两处都取满值——**结局方差为零，量不出差异**。机制是每个 fixture 都把公开且受保护的 `check.mjs` 放在工作区里、任务说明直接给出命令，模型因此只需**收敛到绿**而非**一次写对**。所以这组 fixture 测的是「有完整 oracle 时能否收敛」，不是「能否独立产出正确实现」；详细判据与补救成本排序见 [CHANGES 的 NX-08g0 节](../../../docs/context-budget/CHANGES.md#nx-08g0-任务集天花板效应定性边界与补救排序)。

`pipeline` 是这里的第 13 个、也是唯一一个**多阶段** fixture：它在同一个会话里按序下发十四个阶段（`TASKS/*.md`），后阶段依赖前阶段的产物。它不进筛查批次（见下）。

`audit` 是第 14 个、也是唯一一个为**对照 B**（有界工具输出）设计的 fixture：单任务，受保护的 `report.mjs` 打印约 0.9 MB 的违规报告（项目估算器口径约 277k token，是输入目标 65,536 的 **4.2 倍**），而公开的 `check.mjs` 只有一条断言、失败输出指不出任何字段——模型要看细节只能去跑报告，于是「工具输出是否有界」成为可观察量。它同时不进筛查批次与阶段序列，单独一份注册表 `boundedIds`。

## 任务与文件

- `boundary`：修复空集合、尾部和小数索引边界；任务见 [TASK.md](boundary/TASK.md)。
- `options`：扩展 separator / skipEmpty，保留默认行为与原数组；任务见 [TASK.md](options/TASK.md)。
- `interface`：金额返回值变为对象，同时修改收据调用方；任务见 [TASK.md](interface/TASK.md)。
- `normalize`：规整姓名中的空白与大小写；任务见 [TASK.md](normalize/TASK.md)。
- `dedupe`：按 id 保留首次出现的对象；任务见 [TASK.md](dedupe/TASK.md)。
- `pagination`：修复从 1 开始的分页偏移；任务见 [TASK.md](pagination/TASK.md)。
- `query`：构建稳定且正确编码的查询串；任务见 [TASK.md](query/TASK.md)。
- `retry`：异步操作失败后限次重试；任务见 [TASK.md](retry/TASK.md)。
- `merge`：递归合并嵌套配置并整体替换数组；任务见 [TASK.md](merge/TASK.md)。
- `csv`：处理引号、逗号和空字段的单行 CSV；任务见 [TASK.md](csv/TASK.md)。
- `inventory`：跨订单计算与收据模块修改接口；任务见 [TASK.md](inventory/TASK.md)。
- `summary`：按类别汇总事件数量和金额；任务见 [TASK.md](summary/TASK.md)。
- `pipeline`：分十四个阶段实现「模块依赖 → 构建计划」工具；阶段见 [TASKS/](pipeline/TASKS)。
- `audit`：修正字段规整逻辑与审计比对，使 1600 条记录全部与数据集给出的期望规范值一致；任务见 [TASK.md](audit/TASK.md)。数据集由 [generate.mjs](audit/generate.mjs) 确定性生成（计数、取值池与三条缺陷轴都在那个文件里），重跑同一条命令得到逐字节相同的 `initial/data/records.jsonl`。

每项的 `initial/` 是完整初始工作区，`reference/src/` 仅保存参考修改，`verify.mjs` 是独立行为验收器。公开检查位于初始工作区的 `check.mjs`，命令为 `node check.mjs`。所有项目不需安装依赖、API Key 或网络。

### 两种布局互斥

- **单任务**：`<id>/TASK.md`，驱动只发一次 `agent.send()`，会话里只有一个 task。
- **阶段序列**：`<id>/TASKS/*.md`，按**文件名**排序（顺序由 `01-`／`02-` 这类前缀承载，不由目录项返回顺序承载），驱动在同一会话内逐阶段 `agent.send()`。每次 `send` 分配新 `taskId`，先前结束的阶段因此成为可裁剪的旧任务——这是上下文对照（NX-08e）能产生差异的前提，单任务会话无论多大都不会触发裁剪。

同时存在两者、或 `TASKS/` 里没有 `.md`，`readTaskSequence` 都直接报错而不静默退回单任务：接受哪一种布局就决定了模型被要求做多少，而读者很难察觉。`pipeline` 的公开检查按阶段累积（`node check.mjs <阶段号>` 跑第 1 到该阶段的全部断言），`verify.mjs` 仍是**工作区终态**的一次判定，不按阶段拆分。

`pipeline` 的阶段数是按「累计历史要明显越过 65,536 的输入目标」定的。**6 阶段那版已被实测否证**：3 次重复里只有 2 次真正越过阈值，且都发生在最后 1～2 个阶段。10 阶段的诊断跑在第 6 个阶段越过、后 5 个阶段受裁剪，但按同样的读数，越过阈值的**绝对阶段号大致固定**（历史随阶段号近似线性增长），加阶段只是增加越界之后的阶段数——因此再扩到 14 阶段，让低波动的那条轨迹也留得下足够多的受处理阶段。**14 阶段这一版已被实测确认**：3 次 armB 全部触发裁剪（首次落在第 8/6/6 个阶段，受处理阶段 7/9/9），而 6 阶段那版是 3 次里 1 次完全不触发。依据与实测见 [PLAN](../../../docs/context-budget/PLAN.md#nx-08e1-多阶段依赖-fixturepipeline) 与 [CHANGES 的 NX-08e 节](../../../docs/context-budget/CHANGES.md#nx-08e-对照-a全历史-vs-现有裁剪实测)。

## 运行

在仓库根目录执行：

```powershell
pnpm fixtures:check
pnpm test
```

`fixtures:check` 遍历 `fixtureIds`（筛查批次 12 项 + 阶段序列 + 对照 B 仪器），为每个任务新建临时目录，复制初始代码、执行独立验收、应用参考解、再次验收，然后删除本次创建的目录。逐行 JSON 包含初始/参考结果的 passed、退出码、输出及受保护文件变更；全部 14 项均符合“初始失败、参考通过”时命令退出 0，否则退出 1。

`pnpm eval:offline` 只跑**筛查批次**（`screeningIds` 的 12 个单任务 fixture，对上 `phaseCaps.screening.runs = 12`）。多阶段序列属于对照 A 的仪器，不进筛查批次；它的驱动路径由 [eval-runner.test.ts](../../eval-runner.test.ts) 离线覆盖。

测试入口为 [coding-fixtures.test.ts](../../coding-fixtures.test.ts)。它实际装配 Cordis 与文件/Bash 工具，用模拟适配器读取源码、检查失败、编辑并重跑。options 故意先只修 separator，收到 skipEmpty 的失败后再补修；interface 和 inventory 各编辑两个源码文件。最终 run 状态与独立验收结果分别检查，模型回答不会直接变成验收通过。

复用接口在 [coding-fixtures.ts](../../../scripts/coding-fixtures.ts)：`createFixture(id)` 返回 workspace、`tasks`、参考 edits、applyReference、evaluate 和 close。创建者须在 finally 调用 close；参考 edits 只供离线测试驱动使用，后续真实模型评测只发送 `tasks` 和初始工作区。`evaluate` 默认超时 30 秒（`fixtureProcessTimeoutMs`）、输出上限 32 KiB，可通过 timeoutMs / maxOutputBytes 配置。注册表分四份：`screeningIds`（12 个单任务）、`sequenceIds`（阶段序列）、`boundedIds`（对照 B 的单任务仪器）、`fixtureIds`（三者之和，`fixtures:check` 用）。

可信验收器不从候选工作区读取测试逻辑；package.json / check.mjs 的内容和软链状态也受检查。公开检查被删改、只迁移一半接口或导入时提前退出都不会被这组回归误判为通过。临时目录与子进程不是操作系统安全隔离；这是已知离线 fixture 的验收设施，不声称能防御任意恶意代码。NX-05a 本步未新增生产验证事件、版本关联或任务交付报告；后续 NX-15 已独立实现显式文件范围验证与交付查询，仍不将普通 Bash 或 fixture 流程自动标为任务验收。

## 修改前基线（2026-09-29）

环境：Windows / Node v24.16.0 / pnpm 11.22.0。实际命令 `pnpm fixtures:check` 退出 0：

- boundary：初始退出 1，`clampIndex(0, 0)` 实际 0、期望 -1；参考解退出 0。
- options：初始退出 1，自定义 separator 实际 `a, , b`、期望 `a||b`；参考解退出 0。
- interface：初始退出 1，空数组金额实际 0、期望 `{ amount: 0, currency: 'CNY' }`；参考解退出 0。

三个初始状态验收 0/3，三个参考解验收 3/3；三个预设模拟模型工具流程验收 3/3。这是 NX-05a 历史基线，未调用付费模型，未测量真实模型质量。

## NX-05b 本地基线（2026-09-30）

Windows / Node v24.16.0 / pnpm 11.22.0：`pnpm fixtures:check` 初始 0/12、参考 12/12；`pnpm test` 141/141（其中 12 项模拟模型流程均通过）；`pnpm check` 72 文件语法通过，`git diff --check` 通过。每项参考解和验收器均留在候选工作区外。新增九项主要是短小、确定性的行为修复与扩展；原路线中按大文件/日志定位和长任务/续跑各三项分布的设想尚未覆盖，后续评测不能据此宣称这些场景的效果。没有付费模型实验。精确 SHA 6d1fd3b 的 [CI 36655224744](https://github.com/BeforeLanding/mini-DSH/actions/runs/36655224744) Ubuntu/Windows × Node22/24 四组均 success。

## NX-05b 场景分布补齐（2026-09-30）

- 单文件修复或扩展：`boundary`、`options`、`normalize`。
- 多文件修改：`interface`、`inventory`、`merge`。`merge` 的入口与辅助模块必须同步迁移，单改一个文件仍不能通过。
- 大诊断日志定位：`pagination`、`query`、`csv`。每项初始工作区有约 66 KiB、350 行合成日志，线索在第 320 行；模拟模型通过 grep 与有界行读取定位，再读取源码、修复并重测。日志由独立验收器保护。
- 预算约束与续跑：`dedupe`、`retry`、`summary`。每项模拟模型先因请求预算停止，保留已完成的失败检查和 skipped 编辑，再显式继续同一 task；成功后核对工具不重放与独立验收。代码本身仍是短任务，不能从这些模拟流程推断自然长任务成功率。

正常用户权限 `pnpm check`（72 文件）、`pnpm test`（147/147，无跳过）、`pnpm fixtures:check`（初始 0/12、参考 12/12）及 `git diff --check` 通过；精确 SHA 53e5aba 的 [CI 36657576782](https://github.com/BeforeLanding/mini-DSH/actions/runs/36657576782) Windows/Ubuntu × Node22/24 四组 success。没有使用付费模型。
