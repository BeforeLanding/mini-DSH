# 任务清单

## CD-02 修复服务器 GitHub 下载失败
- 状态：传包修复已实测成功；原 19f4ec9 在 git clone 超时，修复提交 c9f452c 已实际发布，最终验收记录提交后核验最新 main。
- CD-02a：离线 Git bundle 发布脚本，分 prepare/activate，构建失败或 SHA 不符不得切换；实现与本地验证完成，两个 Bash 脚本语法、真实 bundle 导入、错误 SHA/路径/REVISION 拒绝、pnpm check（65 文件）/test（107/107）和 git diff --check 通过。Windows 无 flock/原生 Linux 软链，本地锁用 fixture 替身，原子激活验收待 b 的 Linux runner 与服务器实际运行；独立提交。
- CD-02b：done；c9f452c；YAML、触发门槛、精确 checkout SHA/完整历史、两次 main 核验、三段 Bash 语法及 diff 检查通过。[CI 36573968144](https://github.com/BeforeLanding/mini-DSH/actions/runs/36573968144) 四组 success；[CD 36574173979](https://github.com/BeforeLanding/mini-DSH/actions/runs/36574173979) success，Linux fixture 含真实锁/软链原子激活通过，服务器 check65/test107/107（无跳过）、实际 HEAD/REVISION/共享链接/目录身份核验通过。
- CD-02c：真实部署结果记录完成，git diff --check 通过；独立验收文档提交后继续核验最新 main，不把本地记录等同最新部署。
- 保留 production Secrets、严格主机校验、服务器发布锁和旧版本；不读取模型密钥或会话内容。

## CD-01 阿里云 CLI 发布
- 状态：done；自动发布链路已实测通过，用户已确认发布后的启动入口正常进入 CLI，工作区与持久会话目录正确；模型请求先前已在 bootstrap 验证。
- CD-01a：仅手动触发的公网 SSH 连接/运行环境检查；YAML 解析、main/production/手动触发门槛核验、runner/remote 两段 Bash 语法和 git diff --check 均通过；done；73988b5；[公网预检 36550421451](https://github.com/BeforeLanding/mini-DSH/actions/runs/36550421451) success。
- CD-01b：CI 成功后部署对应 main SHA、串行发布和版本切换；done；a632121；YAML、成功/push/同仓库/main 门槛、精确 SHA、并发设置、runner/remote Bash 语法、pnpm check（65 文件）、pnpm test（107/107）和 git diff --check 通过；[CI 36550812881](https://github.com/BeforeLanding/mini-DSH/actions/runs/36550812881) 四组 success。
- CD-01c：首次 CD 实际发布、版本/目录保持核验及回滚说明；done；[Deploy ECS 36550955877](https://github.com/BeforeLanding/mini-DSH/actions/runs/36550955877) 首次因服务器 GitHub 连接中断失败，重试 attempt2 success，服务器 check（65 文件）/test（107/107、无跳过）及 HEAD/REVISION/共享链接/目录身份均通过。操作说明三个 Bash 代码块语法及 git diff --check 通过，回滚仅说明未执行；独立文档提交后报告编号。
- 不将真实服务器地址、公钥、私钥、模型密钥或实际会话日志写入仓库。运行时功能和事件契约保持；发布不重启已有 CLI。
- CD-01d：用户启动核验收尾；用户提供的启动输出确认 launcher、固定工作区、持久会话目录及模型配置正常；仅记录摘要，不保存会话 ID/原始日志；git diff --check；独立文档提交。

## NX-14 结构化命令执行结果
- NX-14a：需求、决策与提交边界；git diff --check；done；本步提交后报告编号。
- NX-14b：独立前台执行核心、两流有界采集与执行状态；正常用户权限 node scripts/build.js、node scripts/check-syntax.js（67 文件）、node --test dist/test/command-runner.test.js（2/2）、git diff --check；done；本步提交后报告编号。
- NX-14c：Bash 结构化结果、错误分类与 cwd 审批/闸门；正常用户权限 node scripts/build.js、node scripts/check-syntax.js（68 文件）、node --test dist/test/*.test.js（111/111）、git diff --check；done；本步提交后报告编号。
- NX-14d：逐流大日志引用与元信息保留；正常用户权限 node scripts/build.js、node scripts/check-syntax.js（68 文件）、node --test dist/test/tool-results.test.js（6/6）、git diff --check；done；本步提交后报告编号。
- NX-14e1：取消/超时部分日志、终止信号和进程树清理；正常权限 build、syntax（68 文件）、command-runner 4/4、git diff --check；done；本步提交后报告编号。
- NX-14e2：命令结果 JSONL 恢复、不重放与失败不等于 run 失败；正常权限 build、syntax（68 文件）、tool-results 7/7、git diff --check；done；本步提交后报告编号。
- NX-14e3：README/路线与实际提交收尾；check/test/fixtures、diff 和四组合 CI 核验；pending；独立文档提交，CI 按实际证据记录。

## NX-13 可靠编辑、冲突与变更交付
- 关联 R-16 / M6；状态：done（2026-09-29），patch 按需延后。
- NX-13a：需求、设计与分步边界；git diff --check；done；6081892。
- NX-13b：有界快照、指纹、唯一替换、原子替换和 diff 核心；pnpm check（62 文件）、node --test dist/test/file-edit.test.js（3/3）、git diff --check 通过；done；4b7cfd2。
- NX-13c：文件工具冲突保护与具体审批；pnpm check（63 文件）、pnpm test（101/101）、git diff --check 通过；done；489bcfa。
- NX-13d：持久基线、逐次结果和任务清单；pnpm check（65 文件）、pnpm test（105/105）、git diff --check 通过；done；97b7653。
- NX-13d2：复核原子替换的权限与内部软链目标稳定性；pnpm check（65 文件）、pnpm test（106/106）、git diff --check 通过；done；d802adc（先于 e）。
- NX-13e：CLI /changes /diff、结束清单与交付说明；pnpm check（65 文件）、pnpm test（107/107）、pnpm fixtures:check（初始 0/3，参考 3/3）、git diff --check 通过；done；4c9501c。
- NX-13f：最终实际提交清单、跨平台 CI 与文档收尾；git diff --check 与提交清单核验；done；仅文档，本步提交后报告编号。
- 每步均先验证、更新证据、独立提交并推送，再推进下一内容；补充的 d2 单独提交，保留全部历史。
- 最终功能提交 4c9501c 的 [CI 36545691239](https://github.com/BeforeLanding/mini-DSH/actions/runs/36545691239) 四组 Ubuntu/Windows × Node22/24 全部 success；本地 107/107 无跳过。核心 test/file-edit.test.ts、工具 test/file-tools.test.ts、持久记录 test/task-changes.test.ts、CLI/model test/cli.test.ts。无付费模型调用。

## NX-12 CI 修复：Windows 短路径 junction
- 状态：本地修复完成，提交后核验远端 CI（2026-09-29）。
- CI-12a / 统一真实路径解析，内部短路径 junction 不误报越界 / 本地复现、短路径及既有越界回归、pnpm check（54 文件）与 pnpm test（87/87，无跳过）、git diff --check 通过 / done / 本步独立提交后报告编号。
- 本步完成并提交后推送，核验 Ubuntu/Windows × Node 22/24 四组 CI；远端未通过前不报告修复已验收。

## NX-12 coding profile 与仓库上下文
- 关联：M6、R-14；依赖 NX-05a。
- 状态：done（2026-09-29）。
- NX-12a / 作用域与加载契约 / 核对 R-14 与 PLAN 的边界、来源、默认限制 / done（仅文档，git diff --check 通过）/ c5dd04b。
- NX-12b / general/coding 身份选择 / 配置、实际 prompt、无规则加载副作用和插件释放 / done（pnpm check 50 文件、pnpm test 75/75）/ 94ad6e0。
- NX-12c / 有界目录规则加载 / 祖先链与作用域、重新读取、超限/UTF-8/路径和软链 / done（pnpm check 52 文件、pnpm test 79/79）/ 3a18c8b。
- NX-12d / 显式项目配置与检查入口 / 最近配置、非 Git/缺失/非法/超限退化、不执行脚本 / done（pnpm check 52 文件、pnpm test 82/82）/ 20e8e3b。
- NX-12e / prompt 与按需工具集成 / 真实 Cordis 模型请求、其他目录查询、工作区边界与工具释放、完整回归 / done（pnpm check 54 文件、pnpm test 86/86）/ 本步提交后向用户报告编号。
- 每步验证并回填后立即提交，提交完成前不开始下一步。a～d 已分别核对提交，e 独立提交完成后报告最终编号；五项均有实际验收证据，不合并历史。

## 提交拆分要求

开始开发前必须在父任务下列出子步骤，每项写明独立结果、验收命令/标准及预计提交范围。每完成一个小内容并验证通过后立即提交，记录实际提交号，再开始下一项；一个父任务或一次用户请求不能代替这份拆分。具体规则见 [AGENTS](../../AGENTS.md) 和 [PLAN](PLAN.md)。

子步骤记录格式：`子步骤 ID / 单一结果 / 验收 / 状态 / 实际提交号`。父任务完成时核对每个子步骤都有实际证据与提交；未完成项保持未完成状态。

## 小内容即时提交规则强化
- 状态：done（2026-09-29，仅文档）。
- 行为：强化开发前拆分、提交后才开始下一步、diff 粒度检查及子步骤提交记录；明确 NX-05a 大提交为反例，保留现有提交历史。
- 验证：AGENTS / PLAN / 本清单规则一致；git diff --check。仅 Markdown 修改，不重跑功能测试。

## NX-05a 三个编程 fixture 与独立验收
- 关联：M6；依赖 NX-01～NX-03。
- 状态：done（2026-09-29）。
- 行为：提供边界修复、小功能扩展、跨文件接口修改的初始代码、中文任务、参考解；每次复制到独立临时目录，以工作区外的可信验收器核验实际文件行为。记录修改前基线并验证模拟模型经真实 Cordis 文件/Bash 工具执行失败→修改→重跑。
- 验证：三个初始状态均失败、三个参考解均通过；错误实现及篡改工作区测试不能伪造通过；重复运行、目录清理及完整回归。
- 证据：test/fixtures/coding 三套任务/初始代码/参考解/verify；scripts/coding-fixtures.ts / check-coding-fixtures.ts；test/coding-fixtures.test.ts 八条回归。正常用户权限 pnpm check（49 文件）、pnpm test（72/72，无跳过）、pnpm fixtures:check 与 git diff --check 通过。初始 0/3、参考 3/3、预设模拟模型工具流程 3/3；完整基线见 test/fixtures/coding/README.md。没有真实模型质量或本轮跨平台 CI 结论。

## F3 崩溃恢复的投影观测一致性
- 关联：R-08、R-11；NX-03、D-08。
- 状态：done（2026-09-29）。
- 行为：只重放当前 run 的 context/projection，去重归并 removedTaskIds，并保留最近一次候选投影的输入估算；不修改原事件，不执行模型或工具。
- 验证：多次投影后、model/start/usage 后及最终投影未发送时崩溃；正常终态恢复、reset 与同 task 新 run 隔离。
- 证据：test/store.test.ts 两条新增回归覆盖七个崩溃窗口、重复恢复、同 task 不同 run 和 reset；test/context.test.ts 核对 overflow 的投影估算；pnpm check（46 文件）、pnpm test（64/64，无跳过）、三个诊断及 git diff --check 通过。

## F2 最终持久化 deadline 与提交不确定性
- 关联：R-05、R-08、R-10；NX-02、D-05。
- 状态：done（2026-09-29）。
- 行为：回答及用量先在主动预算内确认，再提交唯一终态；终态确认受主动 deadline 和可配置收尾上界限制。超时或取消后不返回成功，提交不确定时阻止新 run；恢复以日志事实为准。
- 验证：最终 sync 跨 deadline、挂起、取消/完成竞态、失败和迟到完成；错误路径收尾有界。
- 证据：test/deadline.test.ts 四条新增回归及 test/integration.test.ts 的真实 Cordis/JSONL 恢复；pnpm check（46 文件）、pnpm test（62/62，无跳过）、诊断脚本与 git diff --check 通过。

## F1 输出额度与历史裁剪联动
- 关联：R-02、R-03、R-06、R-07；NX-01。
- 状态：done（2026-09-29）。
- 行为：每个候选完整历史集合先计算实际输出额度；仅在 token、输入目标或窗口不足时移除旧任务。
- 验证：完整历史可保留、窗口等号/差一、裁剪后重算和最低输出不足回归。
- 证据：src/core/context-runtime.ts / agent-loop-runtime.ts、test/context.test.ts；正常用户权限 pnpm check（46 文件）与 pnpm test（58/58，无跳过）通过。

状态：`todo` 待开始、`in_progress` 进行中、`blocked` 有明确阻塞、`done` 验收完成。每个任务完成时填写实际证据；验证方式不是通过证据。依赖项完成且关联决策定稿后再实施。

按 PLAN 的设计和初值实施；本清单只维护行为、验证、依赖、状态和实际证据。功能已实现；当前验收证据见各任务和 PROGRESS。

## CB-00 文档基线
- 关联：M0、D-01。
- 行为：建立仓库规则、专题需求/计划/任务入口与进度，记录源码基线及现有验证。
- 验证：相对链接可解析；需求、任务、决策相互对应；功能状态没有误标完成。
- 状态：done（2026-09-28）。
- 证据：本目录需求/计划/任务文档、根目录 AGENTS.md / PROGRESS.md、README 开发入口；[E-01 基线验证](../../PROGRESS.md)。

## CB-17 恢复开发基线
- 关联：M0.5 前置环境、CB-15。
- 依赖：CB-00。
- 行为：核验固定 pnpm、按锁文件安装依赖，区分沙箱访问限制与真实缺包；恢复完整核心/Cordis 测试基线，不调整版本或绕过签名。
- 验证：pnpm --version 为 11.22.0；pnpm install --frozen-lockfile、pnpm check、pnpm test；package.json/锁文件无非必要变更。
- 状态：done（2026-09-28）。
- 证据：正常用户权限下 pnpm --version 为 11.22.0；pnpm install --frozen-lockfile 退出码 0（Already up to date）；pnpm check 26 文件通过；pnpm test 22/22 通过，无跳过。package.json/锁文件无变更；详见 PROGRESS 的 E-02。

## CB-15 TypeScript 工具链与迁移
- 关联：R-13；M0.5；D-10。
- 依赖：CB-00、CB-17。
- 行为：核验并锁定 TypeScript/@types/node；建立 NodeNext / ES2022 / strict / noEmitOnError / sourceMap；分批迁移 src/test，编译产物运行；更新 CI、配置路径和命令说明。
- 验证：typecheck/build、编译后的 22 条原测试、无预算长循环、插件释放、动态 plugins.config 导入、cwd/.env 语义；Node 22/24 × Windows/Ubuntu；旧产物不能掩盖错误。
- 状态：done（2026-09-29）。
- 证据：四个迁移提交已推送；本地原 22/22 通过；GitHub CI 36504218629 的 Windows/Ubuntu × Node22/24 四组合成功。

## CB-01 配置与预算契约
- 关联：R-01、R-08、R-09；M1；D-03、D-06。
- 依赖：CB-00、CB-15。
- 行为：定稿配置优先级、默认值、零额度语义、状态接口和预算停止异常；run 开始校验并快照配置，成功字符串返回兼容。
- 验证：非法数字/边界、无预算长循环、单次覆盖、两次 run 隔离；校验失败前没有模型/工具请求；配置贯通插件与 send。
- 状态：done（2026-09-29）。
- 证据：调用>Agent>runtime默认的校验快照、有限整数/零额度、类型化BudgetStop、成功字符串；Cordis插件配置注入实际验证。pnpm check / test 42/42 通过。

## CB-02 执行状态与事件
- 关联：R-04、R-06、R-08；M1；D-05、D-06。
- 依赖：CB-01。
- 行为：建立 sessionId / taskId / runId、计数、用量来源和唯一终态；定义可版本化事件，派生聊天消息忽略状态事件。
- 验证：完成/错误/取消各一个终态；计数不会跨 run 泄漏；事件 seq 连续；reset 清理衍生状态；历史仍可派生。
- 状态：done（2026-09-29）。
- 证据：版本化事件、session/task/run ID、模型/工具调度计数、唯一终态与追加 reset 已实现；pnpm check / test 25/25 通过。事件副本隔离，最终文本保留 reasoning。

## CB-11 JSONL 事件存储
- 关联：R-10；M1；D-08、D-09。
- 依赖：CB-01、CB-02。
- 行为：定义存储接口，实现单写入者串行追加、序号/版本、关键事件落盘确认和错误传播；reset 追加事件。
- 验证：重启读取、尾部半条记录、中部损坏、重复/乱序事件、写盘失败后不再调度；日志只用模拟内容；追加成本使用实际样本测量。
- 状态：done（2026-09-29）。
- 证据：纯模拟1000次sync追加样本，约466KB；Windows Node24样本645.25ms，平均0.645ms/次，读取校验3.86ms。可复现脚本scripts/benchmark-store.ts；严格损坏/故障/恢复测试通过，单机样本不保证掉电耐久性。

## CB-03 模型 usage 与输出限制
- 关联：R-06、R-07；M1；D-04。
- 依赖：CB-01、CB-02。
- 行为：核验官方协议，归一化 usage/finishReason，支持可选输出 token 上限；无 usage 返回可解释估算。
- 验证：模拟 fetch/SSE 的完整、usage-only、缺失、重复、流中断；核对输出限制字段；残缺 tool JSON 不执行。
- 状态：done（2026-09-29）。
- 证据：官方 DeepSeek 协议（2026-09-29）+模型SSE模拟：usage-only/重复末包、max_tokens、reasoning不重复计，length/残缺JSON不执行；缺失及中断用统一估算。pnpm check / test 35/35 通过。

## CB-12 Session 重建与未知执行识别
- 关联：R-11；M1；D-08。
- 依赖：CB-02、CB-03、CB-11。
- 行为：从事件重建消息、任务、用量、模型和终态；重放不执行外部工作；识别 started 无结果的 unknown；保留 reasoning，区分不完整流。
- 验证：恢复前后状态比较；工具副作用完成但结果尚未落盘的崩溃样本不自动重试；reset 重启保持；版本不支持报错。
- 状态：done（2026-09-29）。
- 证据：严格事件恢复不重放工具；unknown/skipped、workspace校验、reset重启；流片段250ms或4KiB合并，不派生为完成答案；缺失usage恢复估算。pnpm check / test 35/35 通过。

## CB-04 请求 token 估算
- 关联：R-02、R-06；M2；D-04。
- 依赖：CB-01、CB-03。
- 行为：估算 system、messages、reasoning、schema 和开销；明确输出预留、安全余量和模型容量来源。
- 验证：中文/英文/代码/大 schema 固定样本；容量等号及超一边界；未知容量报配置问题；模型切换重新计算。
- 状态：done（2026-09-29）。
- 证据：完整请求估算+动态余量max(2048,input10%)；显式配置/适配器能力元数据，未知容量拒绝且无历史副作用；模型切换重算。pnpm check / test 39/39 通过。

## CB-05 上下文裁剪与输出投影
- 关联：R-02、R-03；M2；D-02。
- 依赖：CB-02、CB-04。
- 行为：分组完整旧任务/轮次，按目标移除最旧历史；保留当前 task 的所有 run、system 及调用配对；不截短当前过程；无法容纳则 context_overflow。
- 验证：多轮/多工具/reasoning/取消历史无孤立消息；事件原文深比较不变；重复投影确定；大 system、当前输入、当前调用组失败路径。
- 状态：done（2026-09-29）。
- 证据：投影后 input+输出预留+动态余量不超过窗口；必保留集合不容纳时 context_overflow 且零模型调度；原文不变。pnpm check / test 39/39 通过，含等号/超一、模型切换及大输入/system/schema。

## CB-06 步数与工具调用调度
- 关联：R-04、R-08；M3；D-03、D-06。
- 依赖：CB-01、CB-02。
- 行为：模型和工具调度前扣次数，达到限制不再调度；一批工具超额时补齐跳过结果，失败/拒批计入调度次数。
- 验证：0/1/N 步；最后一步完成；三工具剩余一额度；失败工具；下一次 run 恢复；无预算 20 调用回归保留。
- 状态：done（2026-09-29）。
- 证据：0/1/N 模型调度、最后完整回答、最后一步工具跳过；批量工具按额度顺序执行且全部配对，失败计次数；公共失败路径补齐结果。pnpm check / test 42/42 通过，原无预算20工具回归保留。

## CB-07 Deadline 与用户取消
- 关联：R-05、R-08；M3；D-05。
- 依赖：CB-01、CB-02、CB-06。
- 行为：按 PLAN 计单调主动时间，审批暂停且另限 5 分钟，模型请求另限 180 秒；组合 signal 并清理；迟到回调不覆盖终态。
- 验证：可控时钟下挂起模型、审批、工具；取消与超时竞态；超时后无新调度；多工具结果配对；释放后无遗留监听器；非协作工具限制明确。
- 状态：done（2026-09-29）。
- 证据：RunBudgetRuntime 可注入单调时钟、组合signal、主动deadline、模型独立超时、审批暂停与独立超时；阶段复查、资源清理、迟到流忽略，未知在途工具配对。pnpm check / test 45/45 通过；非协作工具仅停止等待，不能保证物理终止。

## CB-08 累计 token 预算接入
- 关联：R-02、R-06、R-07、R-08；M3；D-04、D-05。
- 依赖：CB-03、CB-04、CB-05、CB-06、CB-07。
- 行为：请求前判断剩余额度和输出预留，响应后结算；超限后不调度后续模型/工具，补齐已记录调用的结果。
- 验证：输入重复发送逐次计费；实际/估算两种来源；实际高于预估；失败/取消缺失 usage；零余额、最后额度、多个限制同时命中。
- 状态：done（2026-09-29）。
- 证据：请求前预留完整输入与最低输出、余额降低max_tokens；actual/estimated均累计重复输入，真实超估算停止后续调度并补齐结果；取消/失败保留不确定消耗。pnpm check / test 48/48 通过，验证次数/token/context停止优先级。

## CB-13 预算停止后的 /continue
- 关联：R-08、R-09、R-12；M3/M4；D-08。
- 依赖：CB-05、CB-06、CB-07、CB-08、CB-12。
- 行为：同 task 新 run，每段额度按 PLAN；未执行调用有 skipped 结果，模型重新规划；显示本段和任务累计用量；未知副作用不自动重试。
- 验证：预算停止→continue→完成；不重复用户输入/原工具；上下文保护跨 run；unknown 副作用不自动重试；context_overflow 不因额度刷新被忽略。
- 状态：done（2026-09-29）。
- 证据：续跑核心与CLI /continue实际串联，预算停止→继续→完成；task累计、跨run保护、completed/unknown/unchanged context明确反馈。pnpm check / test 52/52 通过。

## CB-09 CLI 与用户文档
- 关联：R-01、R-08、R-09；M4；D-05、D-06。
- 依赖：CB-05、CB-06、CB-07、CB-08。
- 行为：提供 `/budget`、用量来源和停止原因显示；更新帮助及环境配置说明；保留 /history、/prompt、/reset 语义。
- 验证：命令输出有效配置、最近状态和裁剪范围；模型切换、reset、流式部分输出、预算错误与用户取消区分；不泄漏密钥。
- 状态：done（2026-09-29）。
- 证据：真实Cordis CLI实现 /budget查看/JSON覆盖、/continue、run/task用量与裁剪范围；默认JSONL、session ID恢复、模型/预算设置持久化、reset追加与锁释放；README/.env.example更新。pnpm check / test 52/52 通过。

## CB-10 集成验收与交接
- 关联：R-01 至 R-13；M4。
- 依赖：CB-01 至 CB-09、CB-11 至 CB-13、CB-15。
- 行为：通过真实 Cordis 装配走通有预算 run、停止和恢复；审查配置入口、dispose 和旧契约；同步进度与风险。
- 验证：pnpm check/test；Windows/Ubuntu × Node 22/24 CI；需求逐项有证据；无需 API Key；保留 22 条原测试并增加有意义边界测试。
- 状态：done（2026-09-29）。
- 证据：R-01至R-13逐项证据见PROGRESS E-03；本地pnpm check/test 57/57；功能提交4600379的GitHub CI 36508829785四组合Windows/Ubuntu × Node22/24全部success。模拟模型、真实Cordis/Bash/文件及JSONL恢复；无付费API调用。

## CB-18 实习导向评估与后续规划

- 关联：R-02、R-05、R-09、R-11 的边界复核及后续开发方向。
- 行为：核对源码、测试、远程基线和 CI；复现交叉边界；产出求职导向的完成度、优先级及验收路线。
- 状态：done（2026-09-29，仅评估完成）。
- 证据：基线 ca1e2c4；pnpm check 46 文件、pnpm test 57/57；CI 36514313704 四组合 success；`node docs/context-budget/review-probes.mjs` 输出 F1～F3 诊断值。报告与新任务见 [完成度评估与后续路线](../INTERNSHIP_ROADMAP.md)。
- 后续：F1～F3 尚未修复；原 NX-01～NX-11 经 CB-19 按 coding agent 定位重排，并扩展至 NX-16，功能均为 todo。没有付费模型效果证据，不将规划标记为功能完成。

## CB-19 按 mini coding agent harness 定位修订路线

- 关联：用户明确的仿 DeepSeek Harness 项目定位；CB-18 后续规划。
- 行为：保留原评估及 F1～F3；将下一主线收敛到仓库上下文、可靠编辑、结构化命令结果、验证证据和编程评测；同步 README、需求/计划入口和进度。
- 状态：done（2026-09-29，仅文档修订完成）。
- 证据：核对 runtime-context 通用身份、files 编辑行为、Bash 文本结果及 Loop completed 路径；[开发路线](../INTERNSHIP_ROADMAP.md) 明确 M5～M9、NX-01～NX-16 的范围、依赖与验收。
- 验证：本轮仅 Markdown 变更，32 个本地链接、16 个父任务 ID、M5～M9 阶段及 `git diff --check` 均通过；未重跑功能测试，57/57 为 CB-18 基线结果。
- 后续：M5 加固后进入 M6 最小编程任务闭环；NX-05 先做 3 个 fixture，再扩至 12 个任务。运行时、prompt 和工具行为尚未改动。

## 新任务模板
- ID / 标题、关联需求 / 决策 / 里程碑、依赖。
- 行为：输入、输出、边界、失败与副作用。
- 验证：能观察到的结果及具体方法。
- 状态 / 日期、阻塞（如有）。
- 证据：实际命令、结果、源码 / 测试位置、日志或 CI 链接；没有执行则明确写“未执行”。

### CB-15 分步证据
- CB-15b：src/core/*.ts 与 utils/path.ts，pnpm check / test 成功；22/22 原回归通过，取消工具配对与软链检查保持。
- CB-15c：插件/模型/工具及入口迁移，Cordis Context 增强；pnpm check / test，22/22 原回归通过。
- CB-15d：allowJs=false；原测试及配置迁移，pnpm check / test 22/22 通过；CI 四组合保留，远程四组合已通过，最终功能验收 CI 36508829785。

## NX-07 有界代码读取、搜索与大结果回读
- 关联：M6、R-15；状态：done（2026-09-29）。
- NX-07a / 需求、参数与契约 / git diff --check / done（仅文档）/ 5ef5b2e。
- NX-07b / 分段文件读取 / pnpm check（56 文件）、pnpm test（89/89）/ done / 21ee528。
- NX-07c / 有界搜索和分页 / pnpm check（57 文件）、pnpm test（91/91）/ done / 04f5c4b。
- NX-07d / 持久结果存储与有界回读 / pnpm check（59 文件）、结果存储测试（2/2）/ done / dd45f75。
- NX-07e / 工具预览、Bash 采集及回读集成 / pnpm check（60 文件）、pnpm test（96/96）、pnpm fixtures:check / done / 6c03300。

NX-07b：done；src/core/bounded-text.ts 流式扫描和 src/tools/files.ts 分段读取；pnpm check（56 文件）、pnpm test（89/89，无跳过）通过。覆盖中文/CRLF、空文件、末行、输出/扫描上限、长行、非法编码、二进制、取消及非文件；NX-07a 提交 5ef5b2e。下一步搜索。

NX-07c：done；有界 glob/grep 返回 matches、nextOffset、eof、reason、扫描与跳过统计，支持 path/pattern/includeIgnored。目录流式遍历，条目/深度/单文件/累计扫描/输出有限额。pnpm check（57 文件）、pnpm test（91/91）及 git diff --check 通过。NX-07b 提交 21ee528；本步独立提交后推进结果存储。

NX-07d：done；ToolResultStore 使用 UUID、session 哈希、SHA-256、sync 和串行写入，保存有界采集并按字符边界分页回读；磁盘文件数/总字节有限额。pnpm check（59 文件）、node --test dist/test/tool-results.test.js（2/2）与 git diff --check 通过。覆盖重启、session 隔离、缺失/损坏、UTF-8 偏移、采集/磁盘额度、取消和失败后恢复；NX-07c 提交 04f5c4b。

NX-07e：done；结果投影可释放并保留错误状态，CLI 注册 read_tool_result，Bash 采集改为配置上限并标注超限；存储目录忽略提交。真实 Cordis 模型通过引用读取 40004 字节日志尾部，模型消息/事件只含有限预览；服务重建后同 session 可继续回读；错误日志、采集超限、无 session 兼容、存储失败与插件释放通过。pnpm check（60 文件）、pnpm test（96/96，无跳过）、pnpm fixtures:check（初始 0/3、参考 3/3）及 git diff --check 通过。本地 Windows Node24；未调用付费 API，远端 CI 提交后核验。NX-07d 提交 dd45f75。

- NX-07f / 最终提交与跨平台验收记录 / CI 36538591870 四组 success，提交清单核对与 git diff --check 通过 / done / 仅文档，本步提交后报告编号。

NX-07 最终验收：a 5ef5b2e、b 21ee528、c 04f5c4b、d dd45f75、e 6c03300，均在下一步开发前验证、独立提交并推送。最终功能提交 6c03300 的 [CI 36538591870](https://github.com/BeforeLanding/mini-DSH/actions/runs/36538591870) 四组 Ubuntu/Windows × Node22/24 全部 success。本地 check/test/fixtures 验收见 e；此收尾仅同步文档，无运行时改动，不重复功能测试。
