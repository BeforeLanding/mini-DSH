# 开发进度

### NX-12 Windows CI 短路径修复（2026-09-29）

失败运行 36536233812：Ubuntu Node 22/24 通过，Windows 两组均在内部 junction 规则读取时误报越界。本地用真实 8.3 路径复现：fs.realpathSync 保留 junction 目标的短路径，而 fs.promises.realpath 返回长路径；原本相同目录因此比较失败。路径闸门统一使用 fs.realpathSync.native，与异步加载器一致，不放宽工作区边界。

新增跨平台目录别名回归，Windows 通过系统 ShortPath 构造 junction，验证规则加载、规范化来源和未创建文件的内部路径；外部 junction 及其未创建子路径继续拒绝。pnpm check（54 文件）、pnpm test（87/87，无跳过）与 git diff --check 通过。本步独立提交并推送后再核验四组 CI；提交时尚无远端修复成功结论。

### NX-12e 项目上下文集成与 NX-12 完成（2026-09-29）

新增依赖实际 sandbox 工作区的 project-context 插件，动态 system 提示词及只读 project_context 工具共用有界加载器，标注权限、作用域、脚本未验证及查询不改变工具 cwd。CLI 默认 coding，可用 MINI_DSH_PROFILE=general 保留通用身份；MINI_DSH_PROJECT_DIRECTORY 只控制初始上下文目录。注册前校验，释放时移除上下文和工具；README 与示例环境同步使用方式。

四条真实 Cordis/模拟模型集成覆盖模型收到来源/目录规则、其他目录查询、规则动态刷新、真实文件读 cwd、脚本不执行、审批/越界不放宽、释放与初始失败；容量和动态规则超限均在模型调用前停止。pnpm check（54 文件）、pnpm test（86/86，无跳过）通过，提交前核对 diff。未调用付费 API，未核验本轮跨平台 CI。

NX-12 按五步完成：a c5dd04b、b 94ad6e0、c 3a18c8b、d 20e8e3b；e 本步独立提交后报告编号。每步测试通过并提交后才进入下一步；下一开发主线可推进 NX-07 有界读取/搜索。

### NX-12d 显式项目元数据（2026-09-29）

只查看目标祖先链，选择最近 package.json 的包管理器、Node 要求和 test/check/typecheck/lint/build 字符串入口，标注来源；Git、TS、锁文件和 README 只发现标记，不读取 README 正文。脚本仅作为数据，不执行。缺失、非法或过大配置给出明确退化信息；最近配置无效时不冒用父配置。元数据使用剩余总字节预算，规则保持完整。

三条新增回归验证最近配置、动态更新、不执行带副作用脚本、非 Git/缺失/错误配置、预算和越界配置。pnpm check（52 文件）、pnpm test（82/82，无跳过）通过；提交前检查 diff。规则步骤已提交 3a18c8b；本步提交后再开始 NX-12e。

### NX-12c 有界目录规则加载（2026-09-29）

新增 ProjectContextRuntime，只查询工作区至目标目录的祖先链，父规则在前；返回路径、真实来源、目录作用域、原文及字节数。每次重新读取；读取/总内容/祖先层数可配置，规则超限、非文件、无效 UTF-8 和越界明确失败，缺失规则退化为空列表。工作区内目录别名按真实目录应用规则。

四条新增回归覆盖根/子/兄弟/工作区外父规则、更新删除、中文字节等号/超限、非法配置、目录类型和软链。Windows 普通文件软链创建遇到 EPERM，已用 junction 验证真实路径和越界；Linux 保留文件软链分支，本地不声称 Linux 验证。pnpm check（52 文件）、pnpm test（79/79，无跳过）、git diff --check 通过。身份步骤已提交 94ad6e0；本步提交后再开始 NX-12d。

### NX-12b 可配置编程身份（2026-09-29）

runtime-context 新增 general/coding 身份选择，底层默认 general；coding 身份要求检查代码和用户已有改动、遵循目录规则、保留权限/审批、按真实检查结果报告，并使用用户语言。无效配置在注册前拒绝；本步未接入仓库扫描或修改 CLI 默认。

test/coding-profile.test.ts 三条回归覆盖 general 兼容、coding 行为约束、配置拒绝与插件释放。pnpm check（50 文件）、pnpm test（75/75，无跳过）与 git diff --check 通过。契约步骤已提交 c5dd04b；本步提交后再开始 NX-12c。

### NX-12a 目录与加载契约（2026-09-29）

开始 NX-12，按 a 契约、b 编程身份、c 规则加载、d 项目元数据、e 插件/工具集成拆成五次独立提交。R-14 与 PLAN 明确工作区边界、祖先链加载、目录作用域、来源标注和可配置体积/深度限制；规则读取失败不静默截短，配置发现不授权执行脚本。底层 general 兼容，CLI 后续默认 coding。

本步仅文档，git diff --check 与契约一致性核对通过，未重跑功能测试。NX-12b～e 尚未实现；每一步提交后再开展下一步。

### 小内容即时提交规则强化（2026-09-29）

按用户要求强化 AGENTS、PLAN 和 TASKS：开发前列出子步骤及验收/提交边界，每完成一个小内容验证通过后立即提交，提交后才开始下一个内容。每次 diff 只能包含一个独立结果及其直接相关测试/证据，父任务完成时核对实际子步骤提交。

NX-05a 的 f06cbfb 包含多个可分别验收的内容，作为粒度过大的反例保留；后续 fixture、公共支撑、工具闭环和额外失败边界须逐步提交，不自动重写已有历史。本轮仅修改提交规则和记录，git diff --check 与规则一致性检查通过；未重跑功能测试，72/72 为此前 NX-05a 的结果。

### NX-05a 编程 fixture 与独立验收完成（2026-09-29）

新增 boundary、options、interface 三个无依赖编程任务，包含中文任务、完整初始代码、源码参考解和工作区外的行为验收器。每次运行新建临时目录，只复制初始代码；提供受保护文件完整性核验、10 秒/32 KiB 的可配置验收上界和经路径确认的目录清理。runner 使用 TypeScript，fixture 输入使用可直接运行的 Node ESM，避免引入额外安装/编译依赖。

新增 pnpm fixtures:check 命令：三项初始状态均退出 1（0/3），参考解均退出 0（3/3）；基线记录于 [fixture 说明](test/fixtures/coding/README.md)。真实 Cordis + 文件/Bash 的预设模拟模型流程均通过（3/3），其中 options 演示修复不完整→失败检查→再次编辑→通过。run completed 和独立行为验收分别断言，没有修改生产运行状态/验证事件契约。

八条新增回归覆盖基线/参考解、独立临时目录和清理、真实工具闭环、公开测试篡改、跨文件部分修改、导入提前退出、挂起超时及输出超限。正常用户权限 pnpm check（49 文件）、pnpm test（72/72，无失败或跳过）、pnpm fixtures:check（退出 0）与 git diff --check 通过。模拟模型使用已知参考修改，不代表自主编程成功率；未调用付费 API，尚未核验本次跨平台 CI。下一主线为 NX-12 仓库规则/检查入口上下文和 NX-07 有界读取搜索，NX-05b 与 NX-15 仍未实现。

### F3 崩溃恢复投影信息修复（2026-09-29）

latestRun 在未完成 run 的事件重放中处理 context/projection：按发生顺序去重合并裁剪任务 ID，恢复最近一次输入估算。Loop 在记录候选投影时更新估算，即使 context_overflow 未调度模型也保持观测一致；候选投影不冒充实际请求或 usage。正常终态快照优先，reset 和同 task 的其他 run 不混入。

pnpm check（46 文件）、pnpm test（64/64，无跳过）与 git diff --check 通过；test/store.test.ts 覆盖七个崩溃位置、重复恢复、终态及 reset，test/context.test.ts 验证 overflow 输入观测。诊断脚本三个输出均符合修复结果：F1 保留旧历史、3 条消息和 100 输出额度；F2 报 timeout、20ms、提交 uncertain；F3 恢复 synthetic-old-task 与输入估算 1234。原始事件不改写，没有付费模型调用；本轮尚未核验跨平台 CI。F1～F3 / NX-01～NX-03 已完成，后续路线状态同步。

### F2 最终持久化 deadline 修复（2026-09-29）

答案与用量先在主动预算内确认；唯一终态提交等待也受主动 deadline 及 finalizationTimeoutMs（默认 5000ms）限制，返回前复查。错误收尾独立有界并保留原停止原因。终态写入已开始后的超时/取消/失败暴露 terminalCommit=uncertain，包含提交等待的实际观测时间；阻止继续、新任务及 reset，迟到确认不覆盖当前状态。重新读取日志按完整持久化事实恢复，不追加冲突终态；提交前计时快照和重启后无法重建的 sync 时间已在 R-05/D-05/README 明确。

pnpm check（46 文件）、pnpm test（62/62，无跳过）、node --check docs/context-budget/review-probes.mjs 与 git diff --check 通过。四条新增回归覆盖跨 deadline、挂起、取消/完成竞态、失败、迟到完成、有界错误收尾以及终态已/未落盘两种恢复；真实 Cordis/JSONL 集成继续通过。诊断 F2 返回 timeout、主动时间 20ms、提交 uncertain；F1 保留全部历史，F3 待修复。尚未核验本轮跨平台 CI。

### F1 输出额度与历史裁剪联动修复（2026-09-29）

每个候选历史集合依据当前 run 已消耗 token、输入估算和最低输出计算实际额度，再检查输入目标与窗口；不足时才移除最旧完整任务并重新计算。完整历史输入 754、余额 854、窗口 2902 的样例保留全部历史并发送 100 输出额度。原始事件保持不变，当前 task、system/schema 仍不可裁剪。

正常用户权限 pnpm check（46 文件）、pnpm test（58/58，无跳过）和 git diff --check 通过。新增交叉边界回归见 test/context.test.ts；F2、F3 待依次修复。

### mini coding agent harness 定位修订（2026-09-29）

按用户明确的“仿 DeepSeek Harness 的 mini coding agent harness”定位更新 [开发路线](docs/INTERNSHIP_ROADMAP.md) 及 README、需求/计划入口。保留 F1～F3 及原预算评估；新主线为 M5 边界收尾 → M6 仓库上下文/代码定位/可靠编辑/执行验证 → M7 编程评测，M8 长任务增强按证据选择，M9 求职展示随开发积累。

保留 NX-01～NX-11，新增 NX-12～NX-16；全部功能项仍为 todo。特别区分 run completed 与代码验证通过，现有通用身份、prompt、事件 schema 和工具行为没有修改。本轮仅文档，未重跑功能测试；57/57 与四组合 CI 是此前评估基线，不能作为新规划的验收证据。

本轮验证：32 个本地 Markdown 链接存在性检查、16 个父任务编号（NX-05 拆为 a/b 两步）及 M5～M9 阶段检查通过；`git diff --check` 通过。

### 实习导向评估与路线（2026-09-29）

基于与 origin HEAD 一致的 ca1e2c4 完成 [完成度评估与后续路线](docs/INTERNSHIP_ROADMAP.md)。正常用户权限下重新运行 pnpm check（46 文件）和 pnpm test（57/57，无跳过）；只读核验基线 CI [36514313704](https://github.com/BeforeLanding/mini-DSH/actions/runs/36514313704)，Windows/Ubuntu × Node22/24 四组合 success。

新增离线诊断 `node docs/context-budget/review-probes.mjs`，复现 F1 输出额度收缩前提前裁剪、F2 最终提交超 deadline 仍 completed、F3 恢复遗漏投影观测。三个问题尚未修复；未改运行时功能、未调用付费 API。后续 NX-01～NX-11 均为 todo，按边界加固→评测/工具输出治理→求职展示推进。评估完成不代表后续功能完成。

文档与诊断检查：22 个本地 Markdown 链接存在性检查通过，`node --check docs/context-budget/review-probes.mjs` 和 `git diff --check` 通过。功能检查使用上述本次基线结果，文档变更后不重复执行不受影响的全量测试。

### 功能梳理（2026-09-29）
新增 [本次改动与实现功能](docs/context-budget/CHANGES.md)，按用户五阶段顺序归纳 21 个开发提交、模块职责、CLI/恢复入口、默认值、回归证据和实际边界；README 增加入口。本步仅文档变更，沿用注释清理后的 pnpm check / test 57/57 结果。

### 注释清理（2026-09-29）
按用户要求删除已跟踪源码、测试、脚本、CI、环境示例及 README 运行代码块中的注释；URL、正则、字符串和 Markdown 说明保留，实际 .env 未改动。pnpm check 类型/构建/46 文件语法通过，pnpm test 57/57，无跳过；git diff --check 通过。构建产物的 sourceMappingURL 属于调试映射指令，保留既有 sourceMap 配置。

更新：2026-09-29。五阶段功能已实现并逐步提交推送；本地 57/57 回归通过。功能提交 4600379 的跨平台 CI 四组合全部通过。

当前状态：严格 TS 迁移、契约/持久化、上下文管理、执行预算、续跑/CLI 已完成；原 22 条测试保留。历史基线及失败记录保留在下文，当前验收以末尾 E-03 为准。

## 已完成
- 仓库规则、需求、计划及任务清单已建立；TypeScript / Node ESM、Cordis、node:test、JSONL、请求投影和同 task 新 run 的 /continue 路线已确定。
- 用户给定 64 次模型请求、128 次工具调用、10 分钟，并授权调研确定其余默认值；统一保存在 [计划](docs/context-budget/PLAN.md)，工程初值待任务实验评估。
- 当前任务全部过程保留，无法容纳明确停止；预算触顶直接报告，不自动摘要、收尾或重试未知工具。
- 文档整理：选型、参数、官方依据合入计划，基线验证合入本文件；删除重复专题入口、选型、默认值和独立基线记录；已完成的文档准备任务合入本节，未开发的功能任务保留原 ID。
- 需求 R-01 至 R-13 对应任务清单；文档基线已在 43e3829（确认开发文档）提交。尚未安装 TS 工具链、迁移源码或实现预算功能。
- 用户已要求每个完成的小步骤创建本地提交；已将拆分、验证、证据回填和提交报告规则写入 AGENTS/PLAN。本步只修改开发流程文档。
- CB-17：正常用户权限下确认固定 pnpm、锁文件依赖、语法及完整核心/Cordis 测试通过；源码和依赖版本无须改动，补充沙箱访问限制的排查说明。

## 验证与阻塞
### 开发前基线 E-01（2026-09-28）
环境：Windows / Node v24.16.0；本地 main / c5fc9c4，未拉取或核验远程最新提交。
- node scripts/check-syntax.js：退出码 0，syntax ok: 26 files。
- node --test test/*.test.js：退出码 1；20 条核心测试通过，集成文件加载失败，汇总 tests 21 / pass 20 / fail 1；两条集成测试未执行，不是原 22 条全部通过。
- 错误：ERR_MODULE_NOT_FOUND，无法解析 node_modules/@deepseek-ai/cordis/index.js。目录存在但依赖不可用，阻塞完整集成基线。
- pnpm --version：引导 pnpm 11.22.0 失败，registry signature could not be verified，包 fetch failed；不能据此断言包被篡改。pnpm check/test 未取得结果，未绕过校验。
- 核心测试覆盖事件/reasoning、reset、服务释放、模型路由、无预算 20 次工具调用、流回调、取消配对、SSE/JSON、路径/软链、审批和文件匹配。未来通过结果另记，不覆盖本次失败。

### 文档检查
整理后六份文档的 17 个本地链接检查通过；13 项需求、11 项决策及 15 项任务引用有效；无已删除文档残留引用；文档空白和 git diff --check 通过。本次仅改文档，未重跑功能测试；没有真实模型、预算功能、TypeScript 构建或跨平台 CI 验证。

开发流程规则更新后，17 个本地链接、文档空白及 git diff --check 再次通过；本步只有 AGENTS、PLAN、PROGRESS 变更，不重跑功能测试，既有依赖阻塞仍保留。

### 开发基线恢复 E-02（2026-09-28）
环境：Windows / Node v24.16.0；以 9f74a33 为本次仓库起点。检测开始时已有 CB-17 的任务/进度改动，保留并补齐本任务验证。
- 同一检出中，沙箱下 Cordis 导入仍报 ERR_MODULE_NOT_FOUND；正常用户权限下解析到 .pnpm 内的 lib/index.js 并导入成功。此项确认历史失败与访问环境有关，不能直接视为真实缺包。
- 正常用户权限执行 pnpm --version：11.22.0，退出码 0。
- pnpm install --frozen-lockfile：Already up to date，退出码 0；未降级 pnpm、绕过签名或修改锁文件。
- pnpm check：syntax ok: 26 files，退出码 0。
- pnpm test：tests 22 / pass 22 / fail 0 / skipped 0，退出码 0；包括真实 Bash/文件工具、Cordis 全栈和可选/必需插件失败测试。
- package.json、pnpm-lock.yaml 和运行源码无变更。本次恢复属于环境核验与记录，不引入无必要代码修补。
- 本地完整基线阻塞解除；未触发或核验远程 CI，未调用真实模型。后续沙箱不可访问依赖/缓存时需在正常用户权限核验，不绕过校验。
- 本步 18 个本地文档链接、文档空白和 git diff --check 通过；CB-17 标记 done，CB-15 保持 todo。

## 下一步
原首阶段开发及验收已完成；优先修复 F1～F3（M5），随后按 [编程 Harness 开发路线](docs/INTERNSHIP_ROADMAP.md) 的 M6 建立最小代码修改与验证闭环，以 3 个编程 fixture 贯穿开发，再扩展 M7 真实模型评测。NX-01～NX-16 均未开始功能开发。

## 更新规则
本文件只保存当前状态、重要验证/失败、阻塞和下一步；任务级行为/证据维护在 [TASKS](docs/context-budget/TASKS.md)。参数和设计维护在 PLAN，验收维护在 REQUIREMENTS。done 必须有真实验收证据，设计完成不等于功能完成。

### CB-15a（2026-09-29）
已建立 TypeScript 7.0.2、Node 24 类型、strict NodeNext 编译链；过渡阶段 allowJs。start/test 使用 dist 产物，构建先类型检查再清理固定 dist，plugins.config 路径保持。pnpm check / test 通过，原 22/22 回归通过。下一步迁移核心。推送被自动审批要求确认具体 origin 目的地，等待确认。

### CB-15b（2026-09-29）
核心和路径闸门迁移 TypeScript，增加消息/工具/服务契约，strict 无隐式 any。pnpm check / test 成功，原 22/22 通过。CB-15a 已推送 origin，用户已确认 BeforeLanding/mini-DSH 为具体目的地。下一步插件、模型、工具。

### CB-15c（2026-09-29）
入口、Cordis 服务、DeepSeek、文件/Bash 工具迁移 TS；使用 Cordis Context 类型增强，保留注册释放。pnpm check / test 成功，原 22/22 通过；配置动态导入路径保持。修正 dist 忽略规则换行。下一步测试和 CI。

### CB-15d（2026-09-29）
原 22 条测试与 plugins.config 迁移 TS，关闭 allowJs；CI 使用类型/构建/产物检查，README/AGENTS 同步。pnpm check / test 通过，22/22 无跳过；Windows Node 24 本地通过。远程 Node22/24 × Ubuntu/Windows 矩阵尚待核验，未宣称跨平台通过。下一步配置契约。

### CB-01 配置快照（2026-09-29）
配置快照、覆盖和零额度校验已实现；pnpm check / test 24/24 通过，非法配置无事件或模型副作用。调度限制待后续阶段。

### CB-02 任务与终态（2026-09-29）
版本化事件、session/task/run ID、模型/工具调度计数、唯一终态与追加 reset 已实现；pnpm check / test 25/25 通过。事件副本隔离，最终文本保留 reasoning。

### CB-15 迁移验收（2026-09-29）
四个迁移提交已推送；本地原 22/22 通过；GitHub CI 36504218629 的 Windows/Ubuntu × Node22/24 四组合成功。

### CB-11 JSONL写入（2026-09-29）
JsonlStore 单写入者锁、串行 append+sync、序号检查、调度前 flush；写入故障无后续模型副作用。pnpm check / test 28/28 通过；尾部半条、中部损坏和重复序号有独立测试。恢复载荷校验待下一步。

### CB-12 Session恢复（2026-09-29）
恢复仅派生状态/消息并补齐 unknown/skipped；工作区不匹配拒绝执行，reset 重启生效；严格版本/载荷/序号校验和尾部原文隔离。pnpm check / test 30/30 通过。usage/流式恢复待适配器小步。

### CB-11 损坏恢复（2026-09-29）
JSONL 串行 sync、单写入者锁与写入故障屏障；严格载荷/序号/版本、半条尾部拒绝并提供显式备份隔离；pnpm check / test 30/30 通过。CLI 持久化入口待后续。

### CB-03 usage与输出协议（2026-09-29）
2026-09-29 核验 https://api-docs.deepseek.com/api/create-chat-completion/；max_tokens、include_usage、usage-only/重复末包归一化，reasoning 为输出子集；截断/残缺调用不执行。pnpm check / test 33/33 通过；缺失 usage 的统一估算在 CB-04 接入。

### CB-04 完整请求估算（2026-09-29）
token-estimator 按 PLAN ASCII0.3/其他Unicode1.0、每消息32/请求256，覆盖 system/reasoning/工具schema及协议；缺失/失败/中断 usage 标 estimated+uncertain；pnpm check / test 35/35 通过。容量判断在下一步。

### CB-03 usage结算（2026-09-29）
官方 DeepSeek 协议（2026-09-29）+模型SSE模拟：usage-only/重复末包、max_tokens、reasoning不重复计，length/残缺JSON不执行；缺失及中断用统一估算。pnpm check / test 35/35 通过。

### CB-12 流式恢复（2026-09-29）
严格事件恢复不重放工具；unknown/skipped、workspace校验、reset重启；流片段250ms或4KiB合并，不派生为完成答案；缺失usage恢复估算。pnpm check / test 35/35 通过。

### CB-05 历史分组（2026-09-29）
groupHistory 按完整 task 聚合，当前 task 与缺失结果组受保护；工具调用/结果完整性检查；原事件不变。pnpm check / test 36/36 通过。请求投影和容量停止待下一步。

### CB-05 请求投影（2026-09-29）
完整历史分组后按目标移除最旧完整任务，当前task/工具协议受保护；投影确定且不改原文，context/projection 记录移除任务。pnpm check / test 37/37 通过。容量停止下一小步接入。

### CB-05 容量停止（2026-09-29）
投影后 input+输出预留+动态余量不超过窗口；必保留集合不容纳时 context_overflow 且零模型调度；原文不变。pnpm check / test 39/39 通过，含等号/超一、模型切换及大输入/system/schema。

### CB-04 容量边界（2026-09-29）
完整请求估算+动态余量max(2048,input10%)；显式配置/适配器能力元数据，未知容量拒绝且无历史副作用；模型切换重算。pnpm check / test 39/39 通过。

### CB-06 次数限制（2026-09-29）
0/1/N 模型调度、最后完整回答、最后一步工具跳过；批量工具按额度顺序执行且全部配对，失败计次数；公共失败路径补齐结果。pnpm check / test 42/42 通过，原无预算20工具回归保留。

### CB-01 配置贯通（2026-09-29）
调用>Agent>runtime默认的校验快照、有限整数/零额度、类型化BudgetStop、成功字符串；Cordis插件配置注入实际验证。pnpm check / test 42/42 通过。

### CB-07 主动时间与取消（2026-09-29）
RunBudgetRuntime 可注入单调时钟、组合signal、主动deadline、模型独立超时、审批暂停与独立超时；阶段复查、资源清理、迟到流忽略，未知在途工具配对。pnpm check / test 45/45 通过；非协作工具仅停止等待，不能保证物理终止。

### CB-08 累计token（2026-09-29）
请求前预留完整输入与最低输出、余额降低max_tokens；actual/estimated均累计重复输入，真实超估算停止后续调度并补齐结果；取消/失败保留不确定消耗。pnpm check / test 48/48 通过，验证次数/token/context停止优先级。

### CB-13 续跑核心（2026-09-29）
agent.continue 同task新run关联previousRunId，每段独立计数，task累计及续跑数；不重复用户输入/旧工具；跨run上下文保护，completed/unchanged context/unknown拒绝。修复复用call ID的按发生顺序配对。pnpm check / test 50/50 通过；CLI入口下一步。

### CB-09 CLI状态与恢复（2026-09-29）
真实Cordis CLI实现 /budget查看/JSON覆盖、/continue、run/task用量与裁剪范围；默认JSONL、session ID恢复、模型/预算设置持久化、reset追加与锁释放；README/.env.example更新。pnpm check / test 52/52 通过。

### CB-13 CLI继续（2026-09-29）
续跑核心与CLI /continue实际串联，预算停止→继续→完成；task累计、跨run保护、completed/unknown/unchanged context明确反馈。pnpm check / test 52/52 通过。

### CB-11 CLI持久化验收（2026-09-29）
JSONL串行sync、单写入者锁、写入故障停止、尾部隔离和严格恢复；CLI默认持久化并在退出释放锁。pnpm check / test 52/52 通过，日志全为模拟内容。性能样本在最终回归记录。

### CB-10 持久化与取消边界加固（2026-09-29）
写盘失败禁止后续调度，未确认终态不报告completed；损坏UTF-8原字节隔离；模型载荷/重复调用校验；工具组合signal与Esc审批取消、超长timer回归通过。pnpm check / test 57/57通过，含待单独提交的持久化集成样本；最终CI待核验。

## 最终集成验收 E-03（2026-09-29）
- Windows / Node v24.16.0：pnpm check 类型/构建/46 文件语法通过；pnpm test 57/57，无跳过；全部模型请求为模拟，无 API Key 或付费请求。
- 真实 Cordis + JSONL + 文件工具：预算停止后关闭服务、重新读取日志并装配新实例，/continue 同 task 新 run；已写文件的 mtime 不变，任务累计模型 3 次/工具 1 次，内存/磁盘规范化事件一致。
- R-01/R-04：test/budget.test.ts 覆盖非法/零/N 额度、优先级、快照、最后回答与批量跳过；旧无预算 20 次工具回归保留。
- R-02/R-03：test/context.test.ts 覆盖完整请求估算、中文/schema/reasoning、容量等号/超界、模型切换、完整任务投影、原始事件不变与当前任务保护。
- R-05：test/deadline.test.ts 和 test/cli.test.ts 覆盖单调主动时间、审批暂停/超时、请求超时、取消竞态、Esc 取消审批、超长 timer 及监听器释放。
- R-06/R-07：test/model.test.ts、context/budget 覆盖 usage-only/重复末包、max_tokens、实际/估算结算、重复输入、截断与无效调用不执行。
- R-08/R-09：budget/cli/core/integration 覆盖唯一终态、run/task 状态、预算/裁剪范围、模型路由、插件释放与原始回归。
- R-10/R-11：test/store.test.ts 覆盖 sync 屏障、单写入者、写盘错误停止、严格版本/载荷/序号、尾部原字节备份、unknown/skipped、reset/workspace 与恢复无副作用。
- R-12：test/continue.test.ts、cli/integration 覆盖新 run 额度、已完成调用不重放、跨 run 保护与 unknown/unchanged context 拒绝。
- R-13：strict NodeNext/noEmitOnError/allowJs=false；源码、插件配置、测试和性能脚本 TS 化，编译产物运行；CI 四组合执行相同 check/test。
- 性能命令：pnpm build 后 node dist/scripts/benchmark-store.js 1000；每个事件 flush+sync，使用纯模拟 256 字符载荷；结果记录于 CB-11。仅代表单机样本，不承诺设备掉电保证。
- 已知限制：估算器不等于供应商 tokenizer；非协作第三方工具只能停止等待；unknown 副作用需要外部核验，writer.lock 不自动清除；Biome 尚未作为门槛（README 已说明）。

### CB-11 JSONL性能验收（2026-09-29）
纯模拟1000次sync追加样本，约466KB；Windows Node24样本645.25ms，平均0.645ms/次，读取校验3.86ms。可复现脚本scripts/benchmark-store.ts；严格损坏/故障/恢复测试通过，单机样本不保证掉电耐久性。

### E-03 跨平台验收结论
功能提交 4600379：GitHub CI [36508829785](https://github.com/BeforeLanding/mini-DSH/actions/runs/36508829785) 完成且 success；Windows/Ubuntu × Node22/24 四 job 均 success，编译检查和 57 条回归通过。最终加固提交 6b9d858 的 CI 36508694746 亦 success。本次所有功能步骤按用户顺序独立提交并逐次推送到确认的 origin。

### CB-10 集成验收完成（2026-09-29）
R-01至R-13逐项证据见PROGRESS E-03；本地pnpm check/test 57/57；功能提交4600379的GitHub CI 36508829785四组合Windows/Ubuntu × Node22/24全部success。模拟模型、真实Cordis/Bash/文件及JSONL恢复；无付费API调用。

### NX-07a（2026-09-29）
已补 R-15 和有界工具决策，拆为契约、读取、搜索、持久结果存储、工具/Bash 集成五个独立提交边界。当前仅文档，git diff --check 通过；功能尚未实现。

### NX-07b（2026-09-29）
read_file 增加 startLine/maxLines、行号、nextLine/eof 和截断原因，固定块读取并限制扫描/行长/输出；非法 UTF-8、二进制、非文件和取消明确失败。pnpm check（56 文件）、pnpm test（89/89）通过；diff 核对及 git diff --check 通过。契约提交 5ef5b2e 已推送，读取独立提交后推进搜索。

### NX-07c（2026-09-29）
搜索改为有界、可分页的结构化结果，默认忽略生成目录和 .mini-dsh，跳过软链/二进制/非法编码/过大文件并记录原因。新增分页、缩小范围、扫描/遍历/深度/输出额度与取消测试。pnpm check（57 文件）、pnpm test（91/91）通过；更新原 Cordis glob 契约断言，diff 核对通过。读取提交 21ee528 已推送。

### NX-07d（2026-09-29）
持久结果存储完成，UUID 引用只按同 session 读取，验证版本/哈希/文件大小，按 UTF-8 字节边界返回 nextOffset/eof/captureTruncated。保存限制采集大小、磁盘总额及 1000 文件（可配置），容量耗尽或写入失败明确报错。pnpm check（59 文件）及结果存储 2/2 边界测试通过，diff 核对通过；尚未集成工具预览。搜索提交 04f5c4b 已推送。

### NX-07e（2026-09-29）
工具结果投影与 CLI 集成完成：大输出保存后只记录预览/引用，read_tool_result 同 session 有界回读；Bash 成功/非零退出日志均可回读，采集超限明确标注。真实 Cordis 模拟模型读取超过旧 32 KiB 限额的日志尾部，重建服务继续回读；错误状态、存储失败、无 session 兼容和释放已验证。README/忽略规则同步。

首次验证因测试误用 RunState.stopReason 字段未编译；已改为实际 status 后重新通过 pnpm check（60 文件）、pnpm test（96/96）、pnpm fixtures:check（初始全部失败、参考全部通过）。diff 核对及 git diff --check 通过，未调用付费 API。结果存储提交 dd45f75 已推送；本步提交后核验远端 CI 并回填实际提交清单。
