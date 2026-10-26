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

## MA-03（2026-10-26）

- 可选 `delegate_tasks` 在同步工具内部用最多两个 worker 执行、整任务累计最多四个子任务；主循环仍串行。contextRefs 为本任务已确认 read_file 的工作区相对路径，宿主绑定并复核哈希，拒绝外部或陈旧引用。
- 子 Harness 复用已注册适配器的验证入口，独立日志与只读工具、受父组预算约束；显式模型容量来自适配器或父 run 配置，不猜自定义模型容量。MemoryView 继承父任务批准版本，子退出不关闭根记忆存储。
- 结果有 schema/版本证据/完整包装大小检查；超大、非法或陈旧结果标 invalid_result。每份完整结果保存制品及 SHA-256，宿主发布父会话拥有的副本，既有 read_tool_result owner 校验继续有效。父日志保留完整关系并校验终态一致性。
- 预算补边：未知/角色拒绝工具调用也经过组准入；模型取消即保留未知用量，后到响应不重新打开账目。所有行为仍默认关闭。
- build、协作/预算 7/7、角色与原集成前置通过；全库 Biome 239 文件无诊断。四 child 队列峰值并发 2，12 次脚本化请求与根账本逐项相等，父/子记忆视图 digest 相同、跨 owner 回读拒绝、非法结果与递归角色拒绝均验收。provider 请求 0。

## MA-04（2026-10-26）

- pendingTools 通用封口前，只对绑定原 run/工具/批次和内置 delegation manifest 的调用协调恢复。复用合法制品，未启动标 skipped、无结果标 interrupted；账本先对账，未知 provider usage 阻止继续派发；不调用模型或重跑子 Agent。已有普通 unknown 结果不新增第二条结果。
- 恢复核对原始制品 hash、父会话结果副本 owner/hash 及 batch 摘要；缺失/损坏证据不伪装成功，回退普通 unknown。父 run 保留 error，不把 child 结果补齐冒充父任务完成。
- 取消传给正在执行的子任务，排队子任务不启动；dispose 等待已启动协作收尾。若父控制流已把工具封为 unknown，保留该诊断，不追溯改写。取消不证明远端网络请求已消失，未确认 usage 仍占预算。
- inspect 新增根组汇总与 `--tree` 子角色/会话/终态元数据；根组 usage 包括所有子请求，不能再加一次 child usage。原日志格式和旧读取器行为保留。
- build、协作恢复/正常批次/原 inspect 11/11，原摘要恢复与文档锚点定向通过；Biome 241 文件无诊断。四个崩溃窗口（预留、派发、结算、制品）、父取消与排队不启动均验收，provider 请求 0。

## MA-02b 账本收口（2026-10-26）

- 在追加之前拒绝重复派发、已结算请求的释放、未派发请求的结算；这些非法调用不能写下一条会导致日志恢复失败的事件。晚到的合法结算保持原根任务作用域，不因新的逻辑任务已创建而丢失证据。
- build 与 budget 定向 5/5 通过；新增拒绝路径后同一日志仍能通过 parseLog。此边界独立提交，不与 Reviewer 行为合并。

## MA-05（2026-10-26）

- reviewer 复用只读机制，输入带有候选路径/哈希/digest 和最多 8 KiB 的 task 基线至当前候选 diff；完整 diff 过大时明确要求拆分。候选信息作为子会话 user/message 保存，审查不生成验证通过或写入批准。
- 返回前复核所有候选锚点（包括没有发现问题的审查），外部变化标 stale；结果保存 candidate digest 和锚点。新增只读 `review_status` 有界查询当前任务审查的版本有效性，主 Agent 后续编辑后旧 review 显示 stale。它是原提案单一委派工具之外的读取入口，不创建子 Agent。
- build 与 reviewer/委派/恢复 9/9；完整 suite 552 tests / 522 pass / 0 fail / 30 平台 skipped，58.1 秒；syntax 219 文件、Biome 243 文件无诊断。验证固定 diff、根再次编辑失效、外部变化与空 findings 失效、review 不能替代检查。provider 请求 0。

## MA-03b 输入与准入边界（2026-10-26）

- 子结果只允许 findings/unresolved 及约定的证据字段，模型不能通过额外字段覆盖宿主生成的 delegationId/status/ref。子任务输入同样拒绝未声明字段。
- 在第一个 await 之前取得逻辑任务分工租约，拒绝同时提交的第二批；结果额度不能高于持久化协议的 16 KiB 包装上限。第一版并发/累计上限可收窄，扩大需另修协议。
- build、协作/恢复/reviewer 9/9、全库 Biome 243 文件无诊断。测试增加伪造结果字段、越界配置和同时第二批准入拒绝，模型请求仍为脚本化调用。

## EV-01（2026-10-26）

- 生产通过 MINI_DSH_DELEGATION / TEAM_DIR / TEAM_LIMITS / TASK_GROUP_BUDGET 显式开启并展示配置；CLI `/budget` 展示已存在的组账目，`--show-config` 不创建 team 目录或请求模型。记忆额度支持显式 JSON 配置并拒绝未知键。
- demo:memory 验证候选、跨 session 召回、文件变化与模拟时钟过期；demo:team 保存成功、invalid_result、父取消与排队 skipped 轨迹。scripted usage 只用于账本机制，输出显式标记 synthetic，不作为供应商用量或能力证据。
- 零模型演示全部 PASS；team 共 14 次脚本请求、真实 provider 请求 0，取消后两条未知 usage 保留约 40K 的估算预留（具体值随有界包装长度变化）。证据 `.demo-runs/team-1793025231110/`；四崩溃窗口制品通过测试导出至 `.demo-runs/recovery-20261026/`，均不入库。
- build、CLI/配置/inspect/记忆集成 21/21；恢复 5/5；Biome 244 文件无诊断。旧功能默认配置仍不安装记忆/协作工具。

## EV-02 零付费准备（2026-10-26）

- 新建独立 memory-team-development-v1、四条件、4 个公开开发蓝图及所有组共同可读的经验包；postCompactionPrune 四份清单均显式 false。没有编辑 NX-50/NX-51 四臂或比较器。
- eval-memory-team 支持干净 HEAD 冻结四份 manifest 与 validate-only：检查共同模型/预算/准备数据、源码及数据 SHA-256、四种实际 Harness 工具装配，拒绝缺臂、重复臂、不同额度、过期来源、付费或正式标记。正文按 LF 规范化，原始数据文件另有精确字节摘要。
- build、定向 eval 3/3、全库 Biome 248 文件无诊断；零模型验证。独立目标验收器和准备/目标两阶段真实执行器尚未实施，价格与金额未冻结，付费调用 0；因此仅标 prepared，不把 16 个拟议开发 episode 或正式 128 个目标 episode 当成已执行。
