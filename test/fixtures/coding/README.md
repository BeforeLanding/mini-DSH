# 编程任务 fixture（NX-05a / NX-05b）

这 12 个无依赖 Node ESM 小项目用于验证 Harness 的读文件、编辑和执行检查流程。模拟模型按预设工具序列执行，参考解由测试驱动方持有；它们不代表真实模型自主编程成功率。

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

每项的 `initial/` 是完整初始工作区，`reference/src/` 仅保存参考修改，`verify.mjs` 是独立行为验收器。公开检查位于初始工作区的 `check.mjs`，命令为 `node check.mjs`。所有项目不需安装依赖、API Key 或网络。

## 运行

在仓库根目录执行：

```powershell
pnpm fixtures:check
pnpm test
```

`fixtures:check` 为每个任务新建临时目录，复制初始代码、执行独立验收、应用参考解、再次验收，然后删除本次创建的目录。逐行 JSON 包含初始/参考结果的 passed、退出码、输出及受保护文件变更；全部 12 项均符合“初始失败、参考通过”时命令退出 0，否则退出 1。

测试入口为 [coding-fixtures.test.ts](../../coding-fixtures.test.ts)。它实际装配 Cordis 与文件/Bash 工具，用模拟适配器读取源码、检查失败、编辑并重跑。options 故意先只修 separator，收到 skipEmpty 的失败后再补修；interface 和 inventory 各编辑两个源码文件。最终 run 状态与独立验收结果分别检查，模型回答不会直接变成验收通过。

复用接口在 [coding-fixtures.ts](../../../scripts/coding-fixtures.ts)：`createFixture(id)` 返回 workspace、task、参考 edits、applyReference、evaluate 和 close。创建者须在 finally 调用 close；参考 edits 只供离线测试驱动使用，后续真实模型评测只发送 task 和初始工作区。`evaluate` 默认超时 10 秒、输出上限 32 KiB，可通过 timeoutMs / maxOutputBytes 配置。

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
