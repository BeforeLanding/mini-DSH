# 项目记忆与只读协作变更证据

## MM-00（2026-10-26）

- 已从远端 `main@cc2b769` 创建独立 `feat/memory-team` / `D:\Agent\mini-DSH-memory-team`，未复制其他工作区未提交改动。
- PR #6 head 检查时为 `4cc3013`，不作为本分支基线；用户授权的四臂准备和 48 条付费执行由另一工作流负责。
- 本步骤只登记需求与提交边界；源码及功能均尚未实施。未调用模型，未修改旧评测协议。

## MM-01（2026-10-26）

- `memory-contracts.ts` / `memory-store.ts`：项目真实路径标识与显式绑定、独立 JSONL、持久化 opId receipt、串行 CAS、候选批准与显式 supersedes、撤销、单写入锁、只读打开与可重建索引。
- 写入先 sync 再发布内存状态；I/O 失败后拒绝继续写。日志按 schema/版本/序号和内容不变契约校验；部分尾部保留原文并拒绝打开，不自动丢弃。索引不作为读取事实来源。
- Node 24.16.0 / 锁定 TypeScript 7.0.2：`node scripts/build.js` 通过；定向 memory-store 5/5、docs-links 1/1 通过。覆盖重启 receipt、锁与显式共享、并发 CAS/冲突替代、容量/非法路径和损坏日志；未调用模型。
- 完整回归在 sandbox 内输出测试后未退出；按 AGENTS 指令改用正常用户权限的 `node --test --test-timeout=120000 dist/test/*.test.js`，528 tests / 498 pass / 0 fail / 30 skipped（隔离测试按既有平台条件跳过），35.2 秒。日志：工作区外 `outputs/memory-team-baseline-normal-20261026.tap`。定向 Biome 3 文件无诊断。跨平台结论等待本分支 CI。
