# PR #7 核心实现独立复核

日期：2026-10-27。范围：`main@a5d9191` 到 `feat/memory-team`；初审 head `c766d7d`，修复后代码 head `525ecc9`。基于源码、失败注入和实际测试重新核验，不把原实现文档或既有绿灯当作正确性证明。

## 已修复发现

1. **P1：共享 wall deadline 未覆盖工具和审批。** 250 ms 限额下，原实现仍等到 1500 ms 的挂起工具/审批自行返回。`afdaca5` 将组 deadline、未知用量、超额及持久化失败接入普通和人工摘要 run 的取消控制，停止在途等待并保留唯一终态。回归：`test/task-group-budget.test.ts` 的 wall deadline 与 unknown sibling usage 用例。
2. **P1：worker 发布失败后其它子任务脱离批次。** 原 `Promise.all` 提前拒绝并释放租约，其它 worker 继续执行。`bc4ef50` 先取消，再等待所有 worker 收尾；排队子任务不启动，取消后的迟到正文不成为 completed。回归：`test/delegation-recovery.test.ts` 的 publication failure 注入。
3. **P2：提案幂等身份遗漏工具批次。** 同 run 跨响应复用 toolCallId 时，新提案被误认为旧调用。`9750558` 将 toolSequence 纳入身份，保持原批次重放幂等和每 run 三条上限。回归：`test/memory-integration.test.ts` 的 repeated tool ids 用例。
4. **P1：独立只读会话看不到外部撤销。** reader 一直复用启动时的 Map，writer 撤销后仍能召回。`525ecc9` 在只读查询前串行重读并完整验证日志，失败时拒绝读取，保留原任务冻结视图的成员边界。回归：`test/memory-recall.test.ts` 的 already-open read-only 用例。

四项均先执行新增回归并观察失败，再修复；独立提交，可分别回退。没有改动 CI 门槛、锁文件、包管理器版本或已有实验结果。

## 五个重点的复核结论

- **共享预算：** root/child、main/summary/retry 共用持久化预留与结算，工具准入绑定 session/run/工具批次；检查并发竞争、root floor、重复结算、超额和未知 usage。恢复保持原 wall deadline，不重新发放额度。
- **取消与崩溃恢复：** 父取消到达运行中子任务，排队任务 skipped；四个窗口分别验证预留未派发、派发但 usage 未知、已结算、已写结果制品。恢复不请求 provider，unknown 用量继续阻止派发；普通工具的 unknown 不自动重放。结果保留父会话拥有的副本及摘要校验。
- **子 Agent 权限：** 三种只读角色各自创建 Harness；中央不可扩展白名单同时限制 schemas 和 execute，并校验 builtin origin/read effect。无 Bash、MCP、写文件、递归委派或记忆提案工具；宿主误配被拒绝。Reviewer 结果绑定候选内容 hash，文件变化后标 stale。
- **记忆批准：** 模型只可提案，候选不进普通召回；批准命令绑定记录 ID、revision 和内容 digest。检查 CAS、显式 supersedes、来源事件归属、敏感信息拒绝、过期/来源损坏/文件变化、撤销，以及跨会话撤销。
- **项目隔离：** 默认以工作区 realpath 派生项目 ID；不同工作区分别存储，显式 projectId 才共享。路径遍历、越界软链仍经已有真实路径闸门；MemoryView、来源和结果引用分别校验项目/会话归属。

这些是可信宿主中的应用层能力与路径边界，不是针对恶意本机进程的 OS 安全隔离。不遵守 AbortSignal 的外部工作可能继续物理运行；Harness 停止等待、拒绝迟到成功并保留未知用量。估算 token 预留不构成供应商金额硬上限。

## 验证证据

- Node 24.16.0；`node scripts/build.js`、`node scripts/check-syntax.js`：222 个产物语法通过。
- `node node_modules/@biomejs/biome/bin/biome check .`：251 个文件，零诊断。
- 正常用户权限 `node --test --test-timeout=60000 dist/test/*.test.js`：**564 tests / 534 pass / 0 fail / 30 skipped**，19.43 秒。日志 `D:\Agent\outputs\pr7-final-tests-20261027.log` 不入库。30 项是现有平台条件跳过，OS 隔离以 Linux CI 的专门 job 为证。
- `node dist/scripts/demo-memory.js` 与 `node dist/scripts/demo-team.js`：全部通过；真实 provider 请求 0。后者包含成功、非法结果、取消和排队 skipped，脚本 usage 不表示真实账单。
- PR CI：[代码 head 525ecc9 的运行](https://github.com/BeforeLanding/mini-DSH/actions/runs/40427461496) 六项全部通过：Ubuntu/Windows × Node 22/24、Isolation、Package install。已读隔离 job 日志确认 38 tests / 38 pass / 0 fail / 0 skipped；Windows Node 22 为 564 / 534 pass / 0 fail / 30 平台 skipped。最终文档提交须再次确认对应 head 的六项 CI 全绿后才合并。
- 未执行付费模型、效果实验、发布或部署；EV-02 仍为 prepared。记忆/委派和 postCompactionPrune 均保持默认关闭，保留 NX-51 负结果。

## 合并判据

四项发现已修复，本地验收通过；五个重点未发现其它阻塞项。最终 head 的跨平台四项测试、Isolation 和 Package install 均通过、无未解决审查线程且仍可无冲突合并时，采用 merge commit 保留独立历史。SWE-bench 手动 PoC 按普通 PR 配置跳过，不当作已运行。
