# 上下文与执行预算管理：计划与设计

更新：2026-09-30。M0 至 M4 的功能已实现，NX-15 本地实现与验收完成、远端推送/CI 待授权；证据见 TASKS/PROGRESS。需求见 [REQUIREMENTS](REQUIREMENTS.md)，执行状态见 [TASKS](TASKS.md) 和 [PROGRESS](../../PROGRESS.md)。本文件是技术决策和默认参数的唯一维护位置；初值可配置，已测量模拟 JSONL 追加成本；未经付费模型的真实任务质量实验。

## 当前实现
## NX-15 决策
- Bash 的可选 verification={files:[...]} 显式选择验证；文件路径相对工作区，默认最多 100 个、每个最多 1 MiB（可配置），复用 NX-13 有界 UTF-8 快照、missing 与 SHA-256 和真实路径。只保证声明范围，依赖/目录新增及检查中改后恢复等未观察变化不能自动证明。
- 新增 verification/start 与 verification/result，保持事件 version=1 与已有 run 终态。start 包含 verificationId、command/cwd、可选 toolCallId、files 的 path/hash/location；落盘后才能启动命令。result 包含原始有界 CommandResult 和检查后 files；检查后快照错误记录为 unavailable，不能把零退出误报通过。取消或崩溃可以留下 unknown，不重放。
- 结果与意图严格一一配对、task/run scope 校验；取消清理的迟到结果允许属于原 run。查询仅用 confirmedEvents，重新核验声明路径、hash/location，并标记后续文件工具修改（即使改回原字节）。已完成检查的退出状态与当前版本分开显示；同 task 所有失败保留。没有全部任务验收自动标记。
- 报告分页验证记录并显示文件工具变更、未覆盖文件和 runStatus；模型与 CLI 均使用只读查询。文件范围和输出限额可配置；日志随验证结果持久化，Bash 工具结果继续提供 NX-14 引用。不增加后台执行或付费模型调用。

## NX-14 决策
- 使用独立前台执行核心，Bash 插件仍负责输入、路径与审批。结果 version=1/type=command，状态为 exited / spawn_error / timed_out / cancelled；exitCode 与 signal 保留实际 close 值，时长从 spawn 前单调计时，不包含审批。
- maxCaptureBytes 为两流共享字节额度；分别标注截断，UTF-8 边界不完整尾部舍弃，非 UTF-8 字节替换解码。timeoutMs 是插件配置，不由模型扩大。cwd 默认为 sandbox.workspace，可指定工作区内现存目录；真实路径在审批后复核，应用策略不承诺 OS 隔离或消除所有外部竞态。
- 工具 output 增加可选 isError 分类，不以抛异常丢失已执行结果。大命令日志逐流投影，使用既有 ToolResultStore/read_tool_result；每流保留预览及 ref/存储截断，元信息不被整段日志预览覆盖。取消后不使用新 signal 绕过取消写存储；留下有界日志和明确存储错误。
- 沿用现有 tool/result JSON 文本，不修改事件版本；run completed 仍只表示运行段结束，命令退出 0 不是任务验收。
- run 的主动超时/取消先结束等待时，沿用 unknown 结果，不等待命令清理来改写唯一终态；直接工具调用的取消结果在进程 close 后返回结构化 cancelled。unknown 恢复不重放。取消后日志存储不得绕过已取消 signal。

严格 TypeScript / NodeNext 编译产物运行；Session 使用版本化 JSONL 事件恢复；Loop 实现上下文投影、执行预算与同 task 续跑；DeepSeek 归一化 usage 并限制输出；CLI 提供 /budget、/continue 和 session 恢复。原始基线及逐步变更保留在 PROGRESS。

## 首阶段之后的方向

NX-05a 使用三个无外部依赖的 Node ESM 编程 fixture。初始代码复制到每次新建的临时工作区，任务说明、参考解及可信验收器留在工作区外；独立 Node 子进程执行行为验收，配置超时和输出上界，退出码与受保护文件完整性共同决定通过。模拟模型使用预设工具序列验证 Harness，不能作为自主编程成功率证据。run completed 与 fixture 验收分别报告，不修改运行事件契约；真实模型评测留待 NX-08。工作目录隔离不等于操作系统安全隔离。

项目定位为仿 DeepSeek Harness 的 mini coding agent harness。M5 起按 [编程 Harness 开发路线](../INTERNSHIP_ROADMAP.md) 推进：收尾已复现预算边界 → 仓库上下文/代码定位/可靠编辑/执行验证闭环 → 编程任务评测 → 按失败证据增强长任务能力。求职演示随开发积累。保持现有 Cordis 服务与模型适配器边界；运行终态和代码验证结果分别建模。

后续功能不改变 D-02 当前 task 完整保护和 D-05 run 终态；NX-13/NX-15 的新增事件见各自决策。实现 NX-16 等涉及契约的任务前，须先在本专题补充对应需求与设计决策；不把未来压缩行为混入现有完成记录。

## 实施顺序与里程碑
1. M0 文档基线：已完成；规则、需求、计划、任务和进度可追溯。
2. M0.5 TypeScript 迁移（CB-15）：先恢复依赖，建立类型/构建链，分批迁移源码和测试，不改变既有行为。出口：原 22 条测试、构建、配置路径和 CI 矩阵通过。
3. M1 契约、存储与观测（CB-01、02、03、11、12）：定义事件和预算状态，实现 JSONL、重建及 usage。出口：重启能恢复，重放不执行工具，记录可信用量与唯一终态。
4. M2 请求投影（CB-04、05）：估算完整请求，按目标移除旧历史，跨 run 保留当前 task。出口：原文不变、工具配对完整、无法容纳明确停止。
5. M3 预算与继续（CB-06、07、08、13）：调度前检查额度、取消在途工作、补齐工具结果、接续任务。出口：耗尽后无新调度，继续不自动重放旧工具。
6. M4 CLI 与验收（CB-09、10）：预算状态、帮助、真实 Cordis 集成和全量回归。出口：R-01 至 R-13 有实际证据，Node 22/24 × Windows/Ubuntu CI 通过。

按出口推进，迁移与功能开发分开提交；不预先承诺工期。

## 小步开发与提交流程
用户要求每完成一小部分就提交一次。一个步骤应只有一个主要目的、有可观察结果、能独立验证和回退；一个 CB 任务可以拆成多个提交，不能只按整项任务或里程碑提交。

**执行门槛：当前小内容验证通过、证据回填并提交后，才允许开始下一个小内容。** 此要求适用于所有 CB/NX 任务及一次请求中的多个开发内容。开发前在 TASKS 列出子步骤、对应验收及提交边界，并向用户说明；用户要求完成整个任务，不表示可以合并该任务的全部变更为一次提交。

提交前逐项核对 diff 是否包含多个可独立验证或回退的结果，若包含则拆分；拆分以行为和验收为依据，不以文件数或行数为唯一标准。每个小内容的实现、直接相关测试和必要文档放在同次提交；验证失败先修复或记录阻塞，不继续叠加下一项功能。完成时在 TASKS/PROGRESS 记录实际子步骤提交，保留已有历史，不通过自动重写提交伪造小步记录。

例如 NX-05a 应先交付最小隔离运行/验收支撑及首个 fixture，再分别增加第二、第三个 fixture，之后独立交付模拟模型的真实工具闭环及额外验收失败边界；每步验收后立即提交。此前 f06cbfb 将这些内容集中在一个提交中，作为粒度过大的反例保留；今后不能仅因它们都属于 NX-05a 而再次合并。

每步循环：选定子步骤及验收 → 更新任务为进行中 → 实现并补必要测试 → 执行针对性检查及适用回归 → 查看 diff → 回填 TASKS/PROGRESS → 本地提交 → 报告提交号、验证与下一步。代码、相关测试和进度同次提交；不能先提交失败测试作为已完成工作。

建议提交切分（每项至少一个，按实际复杂度继续拆）：
1. 恢复依赖和原测试基线。需要仓库变更才提交；仅安装或执行检查时提交必要验证记录，不制造无意义代码变更。
2. CB-15a：引入并锁定 TS 工具链，建立编译产物执行路径，旧 JS 行为保持；验证入口、配置和原测试。
3. CB-15b：迁移 core/类型契约；CB-15c：迁移 plugins/models/tools；CB-15d：迁移测试并收紧配置/CI。每批构建和原行为回归通过再提交，不与预算功能混合。
4. CB-01/02：配置校验与覆盖规则、任务/run 事件与唯一终态分别提交。
5. CB-11：串行追加/锁、写入失败、损坏恢复分别提交；CB-03：usage/输出限制；CB-12：重建与 unknown 识别。
6. CB-04/05：估算、完整分组、请求投影与容量停止分别提交。
7. CB-06/07/08：次数限制、主动时间/审批/取消、累计 token 分别提交。
8. CB-13/09：续跑核心、CLI 继续/预算状态分别提交。
9. CB-10：跨模块恢复与停止回归、CI/用户文档和最终验收分别提交。

普通步骤跑对应测试；修改公共契约/装配、完成迁移批次或阶段时跑类型/构建与完整测试。跨平台结论必须有实际 CI 证据，用户已授权每个小步提交后推送到 origin。提交标题写清本次结果，可采用 docs/chore/refactor/feat/fix/test 前缀。已完成提交保留，不自动 squash/amend/rebase。

## NX-13 编辑与交付决策

- 文件快照默认限额 1 MiB，可配置；完整字节指纹区分 missing 和空文件。读取大文件保留分段行为但说明无编辑指纹，编辑禁止超限。
- 唯一字面替换，统一 unified diff（共同前后缀裁剪，单 hunk，避免二次复杂度）。同目录临时文件 sync 后重新解析路径、核验目标，再 rename；取消在 rename 前不写目标，rename 后按实际成功记录。最终检查与 rename 仍有外部进程竞态，属于应用层乐观检测。
- 快照保存真实 location；提交使用真实目标路径，内部文件软链保持为软链，审批中目录/文件软链改指向也拒绝。显式 chmod 恢复原权限，避免 umask 改变权限；rename 已成功后临时清理错误不能倒置提交结果。
- 无 session 直接调用兼容；有 session 用首次观察与最近确认版本检测陈旧读取。显式 expectedHash 可在重新核验后指定当前版本。首次观察前用户改动作为基线保留。
- 新增 file/baseline、file/observed、file/change、file/change-result 事件；工具结果和 completed 语义保持。首次基线固定，重新读取更新观察指纹；成功编辑更新预期版本。意图含 before/after 快照并先 flush；结果落盘失败或崩溃留下 unknown，只投影已确认事件，不根据文件匹配推断成功。取消后的协作工具可以在 run 终态后追加同 run 的失败结果；恢复校验已知 run、唯一意图及结果配对。
- 用户在两次编辑间修改文件时，标记 externalChangesBetweenEdits 并输出逐次编辑 diff，避免首次基线至最新版本的差异夹带用户改动；最后一次成功编辑后的外部变化另标 externalChange。unknown 仅展示当前指纹，不断言外部归因。
- 逐次失败独立记录；清单按 task 重建、跨 run 保存，reset 隔离。CLI 有界展示，模型用 task_changes 查询；大结果继续用 NX-07 引用。文件工具之外的修改不自动归因。

## NX-12 仓库上下文决策

- runtime-context 增加 general/coding 配置；CLI 装配入口默认 coding，底层插件默认 general，保持现有调用兼容。身份不直接绑定模型或 Loop。
- ProjectContextRuntime 只读取配置的 workspace 内从根到当前目录的祖先链；当前目录默认 `.`。可用 project_context 工具按需查询其他目录，查询不改变工具 cwd。目标目录不同于初始目录时，coding 身份要求先查询该目标作用域的规则。
- AGENTS.md 自父向子加载，保留相对来源及作用域；子规则只在其子树内覆盖父规则。规则内容属于项目指导，不能扩大沙箱权限，不把 README/配置/脚本里的文本提升为 Harness 授权。
- 加载限制可配置：maxFileBytes 默认 16 KiB，maxContentBytes 默认 32 KiB（规则原文与配置序列化内容合计），maxDirectories 默认 16；均为正安全整数。规则超限、不完整 UTF-8、非普通文件或越界软链明确失败，不注入残缺规则；元数据读取错误仅记录来源与原因，不注入非法内容。
- 项目元数据选当前目录祖先链中最近的 package.json，保留包管理器/Node engines/显式 test、check、typecheck、lint、build 脚本；tsconfig.json 与常见锁文件只查看存在性，Git 根只查看祖先链上的 .git 标记。没有 Git 或配置时显示未发现。README 仅提示存在和路径，正文按需读；不遍历依赖和仓库内部文件。
- 每次组装及按需查询重新读取；不执行外部命令、不自动安装、不自动检查。完整 system 继续参加现有 token 估算；上下文不足按现有 context_overflow 停止，不追加新的生产事件契约。

## 模块边界
- 事件存储：经存储接口串行追加/读取，关键事件等待可靠写入；第一版仅 JSONL。
- Session：重建消息、任务、用量和状态；重放没有外部副作用。
- ContextBudgetRuntime：估算、历史分组和请求投影；不修改原始事件。
- RunBudgetRuntime：次数、主动时间、token 预留/结算、停止状态。
- AgentLoopRuntime：协调请求投影、调度检查、响应结算、工具结果和资源清理。
- LlmRuntime / 适配器：传递输出上限，返回 usage/finishReason，保存 provider 所需 reasoning。
- Cordis 插件：服务装配、配置注入、注册释放；CLI 消费状态，不承担预算算法。
- 成功 agent.send() 仍返回字符串；停止拟采用带原因与状态的类型化错误，具体类型在 CB-01 实现时定稿。

## 设计决策及取舍

### D-01 范围
第一版包含 TypeScript、上下文投影、四类执行预算、JSONL、session 恢复和 /continue。摘要、长期记忆、费用预算和任意程序位置精确恢复不纳入；见需求文档。

### D-02 原始事件与请求投影
原始历史完整保存；请求只选择可容纳的完整旧任务/轮次，完整保留 system、安全规则和当前 task 的所有 run。过长停止，不自动摘要或截短当前过程。
替代：全量发送无法控制规模；最近 N 条可能切断工具协议；摘要/检索增加生成误差与新依赖。当前选择确定且可测，代价是旧信息可能不可见、长任务可能停止。

### D-03 计数与兼容
请求计实际进入模型适配器的调度（含失败和最终回答）；工具计进入执行入口的调度（含拒批和失败）；skipped 不计。底层未注入预算策略的旧调用兼容无上限；CLI 注入有限默认策略。
替代：只计成功会纵容无限失败循环；只限制 loop 无法约束单批工具数量。次数和实际用量分别记录，不自动重试。

### D-04 Token 与模型协议
每个候选历史集合先依据输入估算及 run 剩余额度计算实际输出预留，再检查容量；保留可行历史优先于按配置最大输出预留裁剪。最低输出不足、输入目标或窗口超限时，才移除下一组旧完整任务并重算；最终仍按 token 优先于 context 的顺序停止。
以实际 usage 结算，估算及输出预留用于请求前判断；缓存输入仍计 token，reasoning 是输出细分，不重复加算。缺少 usage 时估算已知输入/接收输出并标记不确定，不记零。适配器必须处理无新文本的流末包。
供应商能力按 endpoint/model/核验日期记录，不凭模型名猜窗口；不承诺严格计费上限。保留模型协议字段，包括无工具最终回答的 reasoning。

### D-05 时间与终态
回答、用量等执行事件先在主动预算内完成 flush 并复查，再生成唯一 run/finish。终态提交确认同样受剩余主动时间约束，且另受 finalizationTimeoutMs（默认 5000ms、可配置）限制。停止后的错误收尾仅使用该独立上界，保留原停止原因；成功确认后再次复查取消/deadline 才返回答案。

终态写入开始后不能安全撤销，也不能追加相冲突的第二个终态。确认超时、取消或失败时，调用失败；当前进程暴露 terminalCommit.status=uncertain、终态快照及实际观测主动时间，禁止新 run，迟到写入不会改回 completed。须关闭并重新读取日志判定持久化事实：若唯一 completed 记录确已完整落盘，恢复按 completed；若未落盘，恢复按 running 崩溃窗口处理。run/finish 的计时为提交前快照，terminalCommit.activeDurationMs 为当前进程包含提交等待的观测值；重启无法精确重建最后 sync 时间。收尾上界不保证物理取消文件 IO。
用单调主动时间和组合 AbortSignal，审批暂停主动计时且单独超时；结束清理 timer/监听器。Promise.race 只停止等待，不替代取消。
同一 run 仅一个终态；已封存状态不被迟到回调覆盖。检查顺序：用户取消 → 主动 deadline → 对应调度次数 → token → 上下文容量。最后允许的完整回答可完成；超出 token 额度则停止后续调度。
非协作工具可能继续运行，不能保证物理终止；结果不确定标 unknown。

### D-06 工具结果与停止报告
已记录调用均有匹配结果：真实完成、明确未执行的 skipped、开始但无法确定结果的 unknown。补齐后直接报告状态，不再请求模型收尾。已完成写入不回滚；恢复不自动重试 unknown。
终态原因包括 completed、max_steps、max_tool_calls、timeout、token_budget、context_overflow、cancelled、error，以及 approval_timeout、request_timeout、output_limit 细分原因。

### D-07 默认额度
按下文参数执行，用户可配置覆盖；这些是工程初值，不是官方推荐或经过质量实验的最优值。完整输入与重复请求累计消耗分别受控。

### D-08 JSONL 与 /continue
无 run/finish 的恢复按同 run 的 context/projection 顺序去重累加 removedTaskIds，并更新最近一次 estimatedInputTokens；它表示候选请求投影，可能尚未发送，不代表供应商计费用量。实际请求调度仍以 model/start、计费仍以 model/usage 为准。已有终态快照优先，reset 和不同 run 的投影不混入当前 run。
采用事件日志作为事实来源，恢复只重建状态；区分 session（会话）、task（目标及所有续跑）和 run（一个执行段）。
替代：只存消息无法判断执行状态；只存快照缺少过程；SQLite 提供事务/索引但当前单写入者场景无需先引入数据库。多进程写入、复杂检索或重放瓶颈出现时重新评估 SQLite，保留存储替换接口。
/continue 同 task 新 run，模型根据已有结果重新规划。替代的精确程序位置恢复需要更多执行/审批快照；自动重放缺失结果可能重复副作用。代价是继续需新模型请求，也不恢复旧文件系统。

### D-09 Cordis 与测试框架
保留 Cordis 的依赖注入/释放和 node:test，核心保持可独立测试。替代 LangGraph/工作流系统可提供检查点，但需迁移执行模型，仍不能自动保证任意副作用只执行一次；出现复杂分支、多 Agent 和大量人工暂停时再评估。无需为预算测试迁移 Jest/Vitest。
离线模拟优先，真实模型实验另行记录；模拟可稳定验证边界，但不能证明真实协议和任务质量。

### D-10 TypeScript
采用 tsc strict 检查/编译，Node 执行 ESM。替代 JS + JSDoc 类型约束较弱；tsx 需另设类型检查；Node 类型剥离不检查类型且忽略 tsconfig。代价是新增构建链，收益是事件/状态/服务契约的错误更早暴露。
基线：NodeNext / ES2022，strict、noEmitOnError、verbatimModuleSyntax、sourceMap；输出 dist。import type 和 .js 相对导入；过渡 allowJs，最终收紧。TS/@types/node 版本在 CB-15 核验锁定，不用 any/关闭 strict 掩盖核心错误。
计划 typecheck / build / 编译产物 start、test；当前 package.json 仍是 JS 命令。保留入口/配置相对目录、cwd/.env 语义；校验后清理旧 dist，防止旧产物掩盖失败。tsc 不打包依赖。TS 不验证 JSONL/网络数据，仍需运行时校验。
建议使用 Node 24，保留 Node 22/24 CI；最低版本修改单独处理。

### D-11 验证与默认值调整
保留原 22 条行为测试和无预算长循环。使用模拟模型/SSE、可注入时钟、临时目录及真实 Cordis；测试调用次数、原事件不变、协议配对、单次终态、重启和副作用不重放。
后续实验比较输入 32K/64K/128K、输出 8K/16K/32K；覆盖短编辑、多文件修复、长日志及续跑。记录完成率、停止原因分布、实际 token、估算误差、延迟和重复副作用，再调整初值。

## 默认参数与行为

### 请求规模与估算
- 输入目标 65,536 token；输出上限 16,384（reasoning + 正文）；输出预留最低 4,096。
- 容量余量 max(2,048, ceil(estimatedInputTokens × 10%))。输入估算不含此余量；input <= 输入目标，且 input + 输出预留 + 余量 <= 模型窗口。
- DeepSeek 官方 1M 窗口先保守配置为 1,000,000；自定义端点必须明确能力。显式 max_tokens，不沿用供应商默认大额度。
- 可替换估算器初值：Unicode ASCII/非 ASCII 字符分别按 0.3/1.0 token，加上角色、调用 ID、参数 JSON、reasoning、schema 等实际序列化内容；每消息 32、每请求 256 token 封装开销。这不是真实 tokenizer，代码/特殊符号可能有误差，来源标 estimated。
- 先移除最旧已结束完整任务/轮次；不截短当前 task 过程。当前集合无法容纳时 context_overflow；/continue 不自动扩大输入目标。
- 输出触及 length 时标 output_limit，不执行残缺调用；usage 结算后记录估算偏差。

### 每段执行与续跑
- 模型请求 64 次，工具调用 128 次，主动时间 600,000ms，累计输入加输出 2,000,000 token。
- 主动时间包括组装、模型、工具和持久化；人工审批等待暂停，单次审批限 300,000ms。模型请求限 180,000ms，Bash 保留 30,000ms、Context7 保留 60,000ms，均受剩余主动时间约束。
- 最后一次模型请求若给出完整答案可完成；若继续要求工具，全部标 skipped 后停止，避免产生无法继续判断的副作用。其他批次按顺序执行至预算耗尽。
- 请求前预留输入、容量余量和输出；余额不足先降低输出上限，连最低预留也不足则 token_budget。最低预留不要求实际生成至少 4K。
- /continue 显式开启同 task 的新 run，默认追加相同额度；run 显示本段，task 持续累计次数/token/主动时间/续跑数。用户停留及审批等待另计，无隐藏任务总上限。
- completed 不继续；上下文配置未调整的 context_overflow 仍拒绝；取消后显式继续仍检查 unknown。unknown 副作用先核验，不自动重试。
- 64K/16K 控制工作集及单次生成；2M 限制重复发送的累计消耗。满 64 次请求不保证可用满，其他额度可能先触顶；不承诺严格费用上限。

### 持久化与 reset
- 默认 ~/.mini-dsh/sessions/<sessionId>/events.jsonl，可配置覆盖；记录规范化 workspace，恢复到其他目录不得直接执行。
- session 单写入者持锁，第二写入者失败；失效锁显式核验，不仅凭 PID 自动移除。
- 非流片段语义事件（请求/工具开始、结果、用量、终态、reset）串行追加并等待 sync，再调度后续操作；写入失败停止。新文件目录耐久性按平台核验，不承诺任意设备掉电保证。
- 流片段按 250ms 或 4KiB 合并追加，不逐 token sync；完成/中断追加状态并 sync。投影只用完整响应，不重复派生片段；崩溃可能丢失未写入尾部，明确标不完整。
- 尾部半条记录保护原文件并隔离后才能继续；中间损坏、缺序号、未知版本停止恢复，不静默跳过。
- reset 追加 session/reset，保留 sessionId、全局递增 seq 及文件；投影切换 epoch，旧任务不可继续；不物理删除日志。
- 保存 Harness 实际捕获内容；不自动解除 Bash 的 32 KiB 截断。日志不提交仓库，凭证不写事件；崩溃恢复不是文件系统快照。

## 官方依据
核验日期：2026-09-28；Chat Completions 于 2026-09-29 复核并通过模拟 SSE 协议测试。开发时模型版本变化需复核。
- [DeepSeek 模型说明](https://api-docs.deepseek.com/quick_start/pricing/)：当前窗口 1M、最大输出 384K，旧 deepseek-v4-flash 名称已映射新版 Flash。
- [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)：max_tokens、usage、reasoning 细分及流末包；[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)：工具模式的 reasoning 回传。
- [Token 说明](https://api-docs.deepseek.com/quick_start/token_usage/)：字符比例只是近似；官方离线 tokenizer 与当前聊天模板的一致性尚未验证。
- [Node TypeScript](https://nodejs.org/api/typescript.html)、[TS 模块](https://www.typescriptlang.org/docs/handbook/modules/reference.html)：类型剥离与 NodeNext；[文件 API](https://nodejs.org/api/fs.html)：写入协调和 sync；[测试 API](https://nodejs.org/api/test.html)：mock/计时器。
- [SQLite 原子提交](https://www.sqlite.org/atomiccommit.html)、[Node SQLite](https://nodejs.org/api/sqlite.html)：事务能力与 Node 22.5 起的内置接口；外部工具副作用不属于数据库事务。
- [LangGraph 持久化](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[中断副作用](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/interrupts.mdx)：检查点不免除副作用恢复责任。

## NX-07 有界工具决策
- read_file 默认 startLine=1、maxLines=200，输出最大 32 KiB；扫描最大 8 MiB，每次只读 8 KiB，单行超过输出上限明确失败，支持继续读取后续行。文件必须普通 UTF-8 文本；NUL/非法编码拒绝。
- glob/grep 默认 path='.'、offset=0、maxResults=200，最大输出 32 KiB；遍历最多 10000 条目，深度 64，单文件扫描 1 MiB、累计 8 MiB。流式目录遍历不跟随软链，默认忽略 .git/node_modules/dist，可 includeIgnored=true。分页 offset 为重新扫描后的匹配偏移，不承诺文件变化时稳定快照；超限返回原因和 nextOffset，无法越过扫描限额时提示缩小目录。
- 所有限额为正安全整数并可通过 files 配置调整；调用参数只可降低 maxLines/maxResults，不可扩大配置上限。
- 工具预览默认 16 KiB、结果采集最多 8 MiB、磁盘总额 64 MiB，均可配置。结果存储默认位于工作区 .mini-dsh/tool-results，随机 UUID 引用绑定 session，SHA-256 校验内容；无 session 时不创建引用而保留原运行时兼容。磁盘失败返回 ToolError，不静默丢失。容量耗尽明确失败，不自动删除历史。
- read_tool_result 以 UTF-8 字节偏移有界读取，返回 nextOffset/eof；偏移须落在字符边界。引用是数据，不是文件路径；没有同 session 或文件丢失/损坏时报错。回读工具本身不再次存储，释放插件移除其注册。
- Bash 保持审批、超时、退出码语义，改为采集最多 8 MiB（可配置），保留超限标记；失败日志也可引用。模型/JSONL 保存预览和引用，完整内容放在结果文件中，不修改历史事件或预算逻辑。

NX-07 集成补充：搜索也默认忽略 .mini-dsh；read/search 的 maxOutputBytes 限制正文/匹配载荷，不包含有界元数据与 JSON 格式包装。存储另设 maxFiles=1000，额度检查在单 ToolResultStore 实例内串行；多进程共享目录没有全局配额锁。CLI 默认注入结果投影，无 session 的底层调用保持兼容；回读上限默认 16 KiB。文件/Bash 采集有限与完整请求预算分别生效。
