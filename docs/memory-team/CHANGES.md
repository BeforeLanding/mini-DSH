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

## MM-02（2026-10-26）

- `memory-retriever.ts` / `memory-runtime.ts`：已批准版本快照、标识符/中文二元词检索、确定性排序、来源制品与当前文件哈希复核、整条记录返回及完整包装的 token/字节上限。记录和索引不进入 system 全量注入。
- 为限定最坏 I/O，先在有界记录集合内进行词法排序，最多检查 64 个候选的来源与锚点；用 `candidateLimitReached` 明示未检查完的情况。这是对原提案“全部来源验证后排序”的有界实施修订。
- 最小来源只由当前任务已确认的允许事件生成；不借用可见历史解析 reset 前的记录。持久化 receipt 优先于今天的文件状态，重复 opId 仍校验原命令，不因丢失会话 receipt 重复新增。
- `node scripts/build.js`、memory-store/recall 9/9、定向 Biome 3 文件无诊断；模型调用 0。覆盖候选过滤、任务内视图不刷新、撤销/期限/文件变化/来源损坏、中文和标识符召回、有界结果、reset 后来源可达、未知及超大来源拒绝。

## MM-03（2026-10-26）

- 生产/评测共用 createHarness 可选安装 memory 插件；默认不安装、不改变旧工具或提示。`MINI_DSH_MEMORY=recall|assist`、目录与显式项目绑定接入生产配置，`--show-config` 用只读存储，不创建目录/锁。
- `memory_search/get/propose`、每 run 最多三条提案、用户专属 `/memory review/approve/forget`；批准绑定 revision 与完整记录 digest，并再次复核来源。源输入可只提供 seq，由宿主绑定本任务 session/task/event ids；模型不需要猜不可见的 event UUID。已知凭证形状与敏感锚点拒绝是窄过滤，不能宣称完整 DLP。
- `memory/view/query/proposal-receipt` 加入契约、运行时校验、原日志读取器与 inspect 词表；恢复使用原版本快照，不重新检索历史 tool/result。receipt 先落盘、跨日志 opId 对账；CLI 退出与 Harness dispose 释放记忆写锁。
- 完整离线回归：535 tests / 505 pass / 0 fail / 30 平台条件 skipped，34.5 秒（正常权限）。`node scripts/build.js`、`node scripts/check-syntax.js`、全库 Biome 230 文件无诊断；memory 集成/召回/存储 12/12。`demo-memory` 验候选不可召回、新 session 批准版本可召回、文件变更后拒绝；provider 请求 0。尚无真实模型效果证据。

## MA-01（2026-10-26）

- `agent-capabilities.ts` 与 createHarness 的 analyst/test_designer/reviewer 角色：独立服务与会话，文件插件只注册允许的读取工具；不加载 Bash/MCP/写入/报告工具。角色提示按实际能力渲染。
- ToolRuntime 不可变能力集合同时过滤 schemas/list 并在 execute 授权前验证工具名、builtin 来源和 read effect。伪造工具调用不能因 autoApprove 或自报 read 获得写入能力。
- 子角色关闭工作区内工具结果落盘，读取保留既有有界输出；会话日志由宿主保存。角色装配仍为应用策略，不声明 OS 隔离。
- `node scripts/build.js` 与角色/原集成/中央授权定向 8/8 通过；全库 Biome 232 文件无诊断。测试验证父子服务独立、20 KiB 读取不在工作区生成结果文件、伪造写调用不执行、角色不支持的配置被拒绝及 dispose 释放服务。未调用 provider。

## MA-02（2026-10-26）

- TaskGroupBudgetCoordinator 与 TaskGroups：按逻辑任务创建根账本，所有主请求/摘要/重试统一预留和结算，工具按 session/run/批次/调用标识计数。根 floor 防止子 Agent 耗尽交付额度；deadline 与额度跨恢复保留。
- 预留和派发意图落盘后调用 adapter，按 requestId 一次结算；重复结算不重复扣账，冲突 usage 拒绝。派发前崩溃释放；派发后缺 usage 保留 unknown 预留并阻止全组继续派发。超预留 usage 记录 overrun 并取消可取消请求。估算误差仍可能超额，不声明 token 计费硬上限。
- 显式 dispatchScope 传到中央 LlmRuntime 守门后从 provider 请求移除，关闭功能时 adapter 请求内容不变；工具能力检查继续独立有效。新增词表由 contracts/validation/JSONL parser/inspect 共同识别。
- build 通过；预算/角色/记忆集成/原摘要/文档定向 30/30；全库 Biome 235 文件无诊断。完整离线 suite 543 tests / 513 pass / 0 fail / 30 平台 skipped，54.9 秒。并发抢最后余额、root floor、双结算、工具重复、overrun、重启未决请求及摘要/重试归账均有测试，实际 provider 调用 0。
