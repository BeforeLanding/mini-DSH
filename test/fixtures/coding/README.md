# 编程任务 fixture（NX-05a）

这三个无依赖 Node ESM 小项目用于验证 Harness 的读文件、编辑和执行检查流程。模拟模型按预设工具序列执行，参考解由测试驱动方持有；它们不代表真实模型自主编程成功率。

## 任务与文件

- `boundary`：修复空集合、尾部和小数索引边界；任务见 [TASK.md](boundary/TASK.md)。
- `options`：扩展 separator / skipEmpty，保留默认行为与原数组；任务见 [TASK.md](options/TASK.md)。
- `interface`：金额返回值变为对象，同时修改收据调用方；任务见 [TASK.md](interface/TASK.md)。

每项的 `initial/` 是完整初始工作区，`reference/src/` 仅保存参考修改，`verify.mjs` 是独立行为验收器。公开检查位于初始工作区的 `check.mjs`，命令为 `node check.mjs`。所有项目不需安装依赖、API Key 或网络。

## 运行

在仓库根目录执行：

```powershell
pnpm fixtures:check
pnpm test
```

`fixtures:check` 为每个任务新建临时目录，复制初始代码、执行独立验收、应用参考解、再次验收，然后删除本次创建的目录。逐行 JSON 包含初始/参考结果的 passed、退出码、输出及受保护文件变更；三个任务均符合“初始失败、参考通过”时命令退出 0，否则退出 1。

测试入口为 [coding-fixtures.test.ts](../../coding-fixtures.test.ts)。它实际装配 Cordis 与文件/Bash 工具，用模拟适配器读取源码、检查失败、编辑并重跑。options 故意先只修 separator，收到 skipEmpty 的失败后再补修；interface 编辑两个源码文件。最终 run 状态与独立验收结果分别检查，模型回答不会直接变成验收通过。

复用接口在 [coding-fixtures.ts](../../../scripts/coding-fixtures.ts)：`createFixture(id)` 返回 workspace、task、参考 edits、applyReference、evaluate 和 close。创建者须在 finally 调用 close；参考 edits 只供离线测试驱动使用，后续真实模型评测只发送 task 和初始工作区。`evaluate` 默认超时 10 秒、输出上限 32 KiB，可通过 timeoutMs / maxOutputBytes 配置。

可信验收器不从候选工作区读取测试逻辑；package.json / check.mjs 的内容和软链状态也受检查。公开检查被删改、只迁移一半接口或导入时提前退出都不会被这组回归误判为通过。临时目录与子进程不是操作系统安全隔离；这是已知离线 fixture 的验收设施，不声称能防御任意恶意代码。未新增生产验证事件、版本关联或任务交付报告，这些仍属于 NX-15。

## 修改前基线（2026-09-29）

环境：Windows / Node v24.16.0 / pnpm 11.22.0。实际命令 `pnpm fixtures:check` 退出 0：

- boundary：初始退出 1，`clampIndex(0, 0)` 实际 0、期望 -1；参考解退出 0。
- options：初始退出 1，自定义 separator 实际 `a, , b`、期望 `a||b`；参考解退出 0。
- interface：初始退出 1，空数组金额实际 0、期望 `{ amount: 0, currency: 'CNY' }`；参考解退出 0。

三个初始状态验收 0/3，三个参考解验收 3/3；三个预设模拟模型工具流程验收 3/3。这些是 fixture/Harness 基线，未调用付费模型，未测量真实模型质量。跨平台结论须另以本次 CI 为证。
