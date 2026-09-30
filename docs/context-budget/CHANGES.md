# 改动与验收证据

更新：2026-09-30。本文件保存任务的详细行为、验证、提交和 CI 证据；可扫描状态见 [TASKS](TASKS.md)。以下任务证据从原 TASKS 原样迁入，原 CHANGES 的实现总结保留在文末。

## NX-08b 评测运行器与整批上限强制
- 关联：M7；承接 NX-08a 的导出契约。状态：done（2026-09-30，本地通过，四组合 CI 待提交后核验）。本次不调用真实模型。
- NX-08b / `scripts/eval-runner.ts` 固定单次 run 预算与三阶段整批上限，按阶段串行执行并累计 runs/requests/tokens，触顶中止该阶段并在报告中与任务结果分开呈现；`scripts/eval-fixture.ts` 把「插件栈 + 适配器 + fixture 验收」做成适配器注入的驱动，真实适配器与模拟适配器共用同一条路径；`pnpm eval:offline` 用模拟模型跑完筛查阶段 12 个任务 / `pnpm check`（74 文件 → 78 文件）、`pnpm test`（160/160，无失败/跳过）、`pnpm fixtures:check`（初始 0/12、参考 12/12）、`pnpm eval:offline`（planned 12、executed 12、aborted null、completed 12、accepted 12、66 请求 / 194,474 token，退出码 0）通过 / done / 本步提交后回填。
- 上限语义由 7 个用例固定：预注册常数与 PLAN 一致且阶段上限之和等于全程上限；上限恰好等于计划数时不误报中止；调小上限复现整批中止且已执行 run 仍保留各自状态与验收结论；请求上限在启动负担不起的 run 之前停止；整批上限不中断已开始的 run，超出量以单次 run 为上界；单次执行失败只记在该 run 上、不中止阶段；运行器经真实 Harness 驱动 fixture 的接线。
- 分工写入 PLAN：单次预算在 run 内由 Agent 循环强制，整批上限由运行器在 run 前后检查；开跑前用“累计 ≥ 上限”、跑完用“累计 > 上限” / done / 本步提交后回填。
- 未纳入本步：真实适配器接入与筛查跑（NX-08d）、估算误差实验（NX-08c）。12 个任务的完整离线跑由 `pnpm eval:offline` 承担，CI 内只以 2 个 fixture 覆盖接线，以免把 12 次真实子进程验收再加进 Windows CI。

## NX-08a 评测导出契约与投影归属
- 关联：M7；依赖 NX-06 的 request trace。状态：done（2026-09-30，本地通过，四组合 CI 待提交后核验）。本次不调用真实模型。
- NX-08a / `context/projection` 增加可选 `requestId`，与随后 `model/start` 同号，使投影归属成为日志中可读的事实而非位置推断；发射端在投影之前生成 id，因此因 `context_overflow`／token 预算未发出的请求仍带 id 可辨。`requestTrace` 优先按 id 归属，旧日志无该字段时退回“同一 run 内最近投影”，并以 `projectionLink` 如实标注所用方式；新增 `unsentProjections` 与每 run 终值 `counters`（补齐 `activeDurationMs`／`approvalDurationMs`），未结束的 run 报 `null` 而不是起始零值。事件信封仍为 version 1，新字段可选并按仓库既有 `optionalString` 惯例校验 / `pnpm check`（74 文件）、`pnpm test`（153/153，无失败/跳过）、`pnpm fixtures:check`（初始 0/12、参考 12/12）通过；新增用例覆盖同一 run 多次投影的按 id 归属、缺 id 的位置回退、未发出请求单列、计数空值、真实循环下投影与 `model/start` 同号及溢出后投影无对应请求 / done / 本步提交后回填。
- 未纳入本步：整批上限的运行器侧强制（NX-08b）与估算误差实验（NX-08c）。REQUIREMENTS 尚无 NX-08 条目，是否补 R-20 待定。

## OPS-01 停止文档提交触发生产部署
- OPS-01a / Deploy ECS 改为 `vMAJOR.MINOR.PATCH` 标签或手动 ref 触发，目标须属于 main 历史 / 正常用户权限 `pnpm check`（74 文件）、`pnpm test`（150/150，无失败/跳过）、`pnpm fixtures:check`（初始 0/12、参考 12/12）、YAML 结构、三个内嵌 Bash 块、bundle 失败边界与 `git diff --check` 通过 / done / 2ac85bd；[CI 36662206000](https://github.com/BeforeLanding/mini-DSH/actions/runs/36662206000) 四组 success，同一 SHA 没有 Deploy ECS run。
- OPS-01b / 以仅修改 TASKS/PROGRESS 的提交验证纯文档 main push / 首次 CI 36662393361 的 Windows Node22 因 merge fixture 子进程 10 秒超时失败，其余 149 项和三组 matrix 通过；失败作业重跑后四组 success，同一 SHA 始终无 Deploy ECS run，远端 `workflow_dispatch` 必填 ref 可见，`git diff --check` 通过 / done / 92507d4。

## OPS-02 CI push 路径过滤
- OPS-02a / main push 忽略 docs、PROGRESS、README、AGENTS 与 history，PR 仍全量触发 / YAML 结构与触发配置、matrix、concurrency 检查通过；正常用户权限 `pnpm check`（74 文件）、`pnpm test`（150/150，无失败/跳过）、`pnpm fixtures:check`（初始 0/12、参考 12/12）及 `git diff --check` 通过 / done / 263d439；[CI 36662938984](https://github.com/BeforeLanding/mini-DSH/actions/runs/36662938984) 四组 success，纯文档提交 ef46988 的 workflow run 与 check run 均为 0。

## OPS-03 文档当前状态化
- OPS-03a / 将 500 行 PROGRESS 原文移动到 `docs/history/PROGRESS-2026-09-28--2026-09-30.md`，根文件保留当前状态、阻塞、下一步 31 行 / 18 个外部 URL、90 个 SHA 集合一致，7 个相对链接随目录修正后均可达，`git diff --check` 通过 / done / ef46988。
- OPS-03b / TASKS 改为一行状态清单，原 336 行详细行为、验证和证据迁入本文件并保留原 CHANGES 实现总结 / TASKS 降至 39 行，CHANGES 为 430 行；任务 ID、提交 SHA、CI URL、非标题证据行、35 个清单锚点与相对链接检查通过，`git diff --check` 通过 / done / 本步提交后回填。

## OPS-04 修订提交粒度规则
- OPS-04a / 以“可独立 revert 且存在可观察行为差异”为提交边界；同一能力的重复扩展按行为类别分组，不按 fixture 机械拆分；保留三项禁止合并的反模式，并让任务、证据和 PROGRESS 更新职责与新结构一致 / AGENTS 不再含“每完成一个小内容”“多个独立 fixture”或“每提交同步 PROGRESS”，明确保留“同属一个任务”“最后一起跑测试”“减少提交次数”，相关段落一致性检索及 `git diff --check` 通过 / done / 本步提交后回填。

## OPS-05 版本标签与发布锚点
- OPS-05a / 定义不可移动的 `vMAJOR.MINOR.PATCH` annotated tag、精确 SHA 的 main/CI 前置核验、tag push 部署、可选同名 GitHub Release、手动旧 tag 重部署与服务器上一版本回滚 / 7 个 Bash 代码块语法、触发规范必需字段、相对链接、任务锚点及 `git diff --check` 通过；本地 tag 数仍为 0 / done / 本步提交后回填；未创建或推送实际 tag/release。

## NX-06 请求 trace 与编程结果报告
- 关联：M7、R-19；依赖 NX-14/NX-15；状态：done（2026-09-30，本地及四组合 CI 通过）。
- NX-06a / 固定 trace、报告身份/用量/停止语义及隐私、分页边界 / REQUIREMENTS、PLAN、TASKS、PROGRESS 一致，`git diff --check` / done / c5ebe81。
- NX-06b / 已确认事件的请求 trace 核心，正确关联投影、usage、响应、工具结果和证据 ID / 纯回答、批工具、失败/skipped/unknown、重复 toolCallId、缺失末包、分页、续跑/reset 单元测试，`pnpm check` / done / b39e82a。
- NX-06c / 注册有界 `request_trace` 模型工具 / session 必需、参数范围、插件释放、恢复读取与既有工具清单回归，`pnpm check` 和针对性测试 / done / 513de75。
- NX-06d / task_report 增加 session/current run、全部 run、累计 counters/usage 与停止原因 / completed/预算停止/续跑/running/恢复/reset，保留文件 hash 与命令证据，针对性测试及 `pnpm check` / done / 04b4b57。
- NX-06e / CLI `/trace`、增强 `/report` 展示与 README 收尾 / UTF-8 字节分页、恢复后零模型调用、完整 `pnpm check`、`pnpm test`、`pnpm fixtures:check`、`git diff --check` / done / 08158b9；[CI 36661121345](https://github.com/BeforeLanding/mini-DSH/actions/runs/36661121345) 四组 success。
- 每步验证并回填后独立提交、推送，再开始下一步；跨平台结论仅在实际 CI 完成后记录。无真实模型/付费请求。

## NX-05b 将编程任务集扩展到 12 项
- CI-05b-a / 核实 CD 工作流及近期 CI 结论，记录 Windows Node24 的 CLI 输出等待超时证据与修复边界 / 对照 workflow、运行结论和失败日志，`git diff --check` / done / 64f370b。
- CI-05b-b / 只放宽实测慢流程的 CLI 输出等待与测试上限，保留其他等待上限 / `pnpm check` 72 文件、CLI 5/5、全量 147/147、`git diff --check` / done / 83e6396；[CI 36658529725](https://github.com/BeforeLanding/mini-DSH/actions/runs/36658529725) 四组 success，[Deploy ECS 36658656903](https://github.com/BeforeLanding/mini-DSH/actions/runs/36658656903) 实际部署校验通过。
- CI-05b-c / 回填精确 CI/CD 证据与完成状态 / `git diff --check`、最新 main CI 核验 / 本步文档提交后核验，不继续追加自身验收记录。
- 关联：M7；基于 NX-05a 的独立临时工作区、参考解与可信验收器；状态：四类各三项本地及四组合 CI 验收完成（2026-09-30）。上一轮仅完成数量及短任务验收；先前 CI 只证明当时的代码通过。
- NX-05b12a / 修正状态，固定 12 项四类各三的映射、逐步验收与提交边界 / `git diff --check` / done / 73ebb4d。
- NX-05b12b / merge 改为双模块接口任务，与 interface、inventory 构成多文件三项 / 初始 0/12、参考 12/12，遗漏任一模块仍失败，Cordis 工具流程 27/27，`pnpm check` 72 文件 / done / 86e5f9b。
- NX-05b12c / 工作区外验收保护非源码诊断文件，提供大日志定位测试支撑 / 嵌套诊断文件被篡改即拒，`pnpm check` 72 文件、fixture 回归 28/28 / done / 7f59566。
- NX-05b12d / pagination 加入 66 KiB、350 行诊断日志及 grep/续读定位流程 / 线索在第 320 行，初始 0/12、参考 12/12，工具搜索/读取/编辑/重测 28/28，`pnpm check` 72 文件 / done / 222c212 + 2822d79（前一提交漏纳被忽略的日志，后一提交修复并重验）。
- NX-05b12e / query 加入大诊断日志及 grep/续读定位流程 / 线索在第 320 行，初始 0/12、参考 12/12，工具回归 28/28，`pnpm check` 72 文件 / done / dc8ad78。
- NX-05b12f / csv 同范围 / 线索在第 320 行，初始 0/12、参考 12/12，工具回归 28/28，`pnpm check` 72 文件 / done / 7eca20f。
- NX-05b12g / 预算停止与显式续跑的通用测试支撑 / 真实 Cordis 两段运行、已完成工具不重放、skipped 调用后补做，`pnpm check` 72 文件、fixture 回归 29/29 / done / 786e9ae。
- NX-05b12h / dedupe 任务约束与显式续跑 / 首次对象 identity、严格 id 区分、预算停止→继续→独立验收，`pnpm check` 72 文件、fixture 回归 30/30、初始 0/12、参考 12/12 / done / e299adf。
- NX-05b12i / retry 任务约束与显式续跑 / 成功值 0、最终错误 identity、预算停止→继续→独立验收，`pnpm check` 72 文件、fixture 回归 31/31、初始 0/12、参考 12/12 / done / c35a75a。
- NX-05b12j / summary 任务约束与显式续跑 / 负值/零值及原数组保持，预算停止→显式继续→独立验收，检查未重复已执行副作用；`pnpm check` 72 文件、fixture 回归 32/32、初始 0/12、参考 12/12 / done / 0b47d65。
- NX-05b12k / 四类各三总体验收、文档及提交证据 / `pnpm check`（72 文件）、`pnpm test`（147/147）、`pnpm fixtures:check`（初始 0/12、参考 12/12）、三份大日志均被 Git 跟踪、`git diff --check` / done / 53e5aba；[CI 36657576782](https://github.com/BeforeLanding/mini-DSH/actions/runs/36657576782) 四组 success。
- 分类以主要验证场景计：单文件 boundary/options/normalize；多文件 interface/inventory/merge；大文件或日志定位 pagination/query/csv；长任务约束与续跑 dedupe/retry/summary。长任务类须有真实分段运行证据；模拟模型只证明 Harness 流程，不代表自主编程成功率。
- 补齐提交顺序：a 73ebb4d → b 86e5f9b → c 7f59566 → d 222c212、修复 d2 2822d79 → e dc8ad78 → f 7eca20f → g 786e9ae → h e299adf → i c35a75a → j 0b47d65；k 为本步说明。旧 `NX-05b` 记录和当时 CI 保留为历史基线，不把当时通过解释为本轮场景覆盖已验收。
- 精确 SHA 53e5aba222d0c58a446509e53ce4da8c57e5623d 的 [CI 36657576782](https://github.com/BeforeLanding/mini-DSH/actions/runs/36657576782) Windows/Ubuntu × Node22/24 四组 success。远端证据回填为独立文档提交，提交后核验最新 main CI，不无限追加自身验收记录。
- NX-05b0 / 固定九项新增任务及提交边界 / `git diff --check` / done / 56b3c8e。
- NX-05b1 / normalize 任务、初始代码、公开检查、参考解、独立验收与注册 / `pnpm fixtures:check` 初始 0/4、参考 4/4；Cordis 流程回归 10/10；`git diff --check` / done / a11f510。
- NX-05b2 / dedupe 同范围 / `pnpm fixtures:check` 初始 0/5、参考 5/5；Cordis 流程回归 12/12；`git diff --check` / done / 4761987。
- NX-05b3 / pagination 同范围 / `pnpm fixtures:check` 初始 0/6、参考 6/6；Cordis 流程回归 14/14；`git diff --check` / done / 2992fb8。
- NX-05b4 / query 同范围 / `pnpm fixtures:check` 初始 0/7、参考 7/7；Cordis 流程回归 16/16；`git diff --check` / done / 7b97939。
- NX-05b5 / retry 同范围 / `pnpm fixtures:check` 初始 0/8、参考 8/8；Cordis 流程回归 18/18；`git diff --check` / done / 4d35a39。
- NX-05b6 / merge 同范围 / `pnpm fixtures:check` 初始 0/9、参考 9/9；Cordis 流程回归 20/20；`git diff --check` / done / a6db3d2。
- NX-05b7 / csv 同范围 / `pnpm fixtures:check` 初始 0/10、参考 10/10；Cordis 流程回归 22/22；`git diff --check` / done / f60ea98。
- NX-05b8 / inventory 同范围 / `pnpm fixtures:check` 初始 0/11、参考 11/11；Cordis 流程回归 24/24；`git diff --check` / done / b258056。
- NX-05b9 / summary 同范围 / `pnpm fixtures:check` 初始 0/12、参考 12/12；Cordis 流程回归 26/26；`git diff --check` / done / 0c7511d。
- NX-05b10 / 12 项总体验收与使用说明 / `pnpm check`（72 文件）、`pnpm test`（141/141）、`pnpm fixtures:check`（初始 0/12、参考 12/12）、`git diff --check` / done / 73cf6e1。
- 九项逐步覆盖字符串规整、去重、分页、查询编码、异步重试、深层合并、CSV 引号解析、跨文件库存计算与聚合统计。每项工作区仅含任务初始代码与公开检查；参考修改及独立验收留在工作区外。每项验证和提交后再开发下一项，不合并提交。
- 原路线曾设想单文件、多文件、大文件/日志定位、长任务/续跑各三项。此轮 12 项主要覆盖短小确定性任务，后两类分布尚未实现；真实模型能力与这些场景的通过率均未测量。用户明确授权后已推送 `origin/main`；精确 SHA 6d1fd3b439678c5bb5eb518a9c0f2f2607af1032 的 [CI 36655224744](https://github.com/BeforeLanding/mini-DSH/actions/runs/36655224744) Ubuntu/Windows × Node22/24 四组均 success。
- NX-05b11 / 明确授权后的远端验收回填 / 精确 SHA、四组作业与 `git diff --check` / done / 独立文档提交后核验最新 main CI，不循环追加自身验收记录。

## NX-15 编程验证记录与交付报告
- 状态：done（2026-09-30）；关联 R-18，依赖 NX-13/NX-14；本地及四组合 CI 通过。
- NX-15a / 需求、契约和提交边界 / git diff --check 通过 / done / 0a6383f；已推送。
- NX-15b / 验证意图、结果、版本查询与 JSONL 校验恢复 / pnpm check（70 文件）、pnpm test（117/117，无跳过）、git diff --check / done / 4d1ea34；已推送。
- NX-15c / Bash 显式 verification 文件范围、审批后快照和结果记录 / pnpm check（71 文件）、Bash/验证记录 7/7、git diff --check / done / 6744816；已推送。
- NX-15d1 / task_report 文件覆盖与验证分页 / pnpm check（72 文件）、报告/验证/变更 7/7、git diff --check / done / 67acc56；已推送。
- NX-15d2 / CLI /report 和结束交付报告、coding 提示 / pnpm check（72 文件）、pnpm test（122/122，无跳过）、git diff --check / done / a79b495；已推送。
- NX-15c2 / 意图落盘等待后的 cwd 复核 / pnpm check（72 文件）、真实目录换址与 Bash 6/6、git diff --check / done / 4849b16，先于 e；已推送。
- NX-15e / 用户文档、实际提交与本地最终验收 / 正常用户权限 pnpm check（72 文件）、pnpm test（123/123，fail0/skipped0）、pnpm fixtures:check（初始 0/3、参考 3/3）、git diff --check / done / 87360a1；已推送，CI 36653379987 四组合 success。
- 实际提交顺序 a 0a6383f → b 4d1ea34 → c 6744816 → d1 67acc56 → d2 a79b495 → c2 4849b16 → e 87360a1；逐步验收与提交，无 squash/amend/rebase，无付费 API。
- 先前推送遭自动审批拒绝；用户随后明确授权推送至 GitHub 并核验 CI，七个提交已推送 origin。87360a1 的 [CI 36653379987](https://github.com/BeforeLanding/mini-DSH/actions/runs/36653379987) Ubuntu/Windows × Node22/24 四组合 success，每组 check72/test123/123、fail0/skipped0。
- 验证通过仅覆盖显式文件与命令，不自动证明任务验收。本地 Windows/Node24 与本轮精确提交 CI 均有实际证据，不套用 NX-14 的历史 CI。

- NX-15f / 明确授权后的远端验收回填 / 精确 SHA 与四组作业/日志核验、git diff --check / done / 独立文档提交后核验最新 main CI，不继续循环生成验收提交。

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
- NX-14a：需求、决策与提交边界；git diff --check；done；33520cf。
- NX-14b：独立前台执行核心、两流有界采集与执行状态；正常用户权限 node scripts/build.js、node scripts/check-syntax.js（67 文件）、node --test dist/test/command-runner.test.js（2/2）、git diff --check；done；8cec028。
- NX-14c：Bash 结构化结果、错误分类与 cwd 审批/闸门；正常用户权限 node scripts/build.js、node scripts/check-syntax.js（68 文件）、node --test dist/test/*.test.js（111/111）、git diff --check；done；3f05f34。
- NX-14d：逐流大日志引用与元信息保留；正常用户权限 node scripts/build.js、node scripts/check-syntax.js（68 文件）、node --test dist/test/tool-results.test.js（6/6）、git diff --check；done；254008f。
- NX-14e1：取消/超时部分日志、终止信号和进程树清理；正常权限 build、syntax（68 文件）、command-runner 4/4、git diff --check；done；556f66a。
- NX-14e2：命令结果 JSONL 恢复、不重放与失败不等于 run 失败；正常权限 build、syntax（68 文件）、tool-results 7/7、git diff --check；done；557f27f。
- NX-14e3：README/路线与实际提交收尾；正常权限 pnpm check（68 文件）、pnpm test（115/115，无跳过）、pnpm fixtures:check（初始 0/3、参考 3/3）、git diff --check；557f27f 的 CI 36651228195 四组合均 success；done；本步文档提交后报告编号。

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

---

## 首阶段实现总结（原 CHANGES）

更新：2026-09-29。开发范围为 `cfee2b5..7110917`，共 21 个独立提交，按用户指定顺序逐次推送到 `BeforeLanding/mini-DSH/main`。随后 `5969363` 清理项目注释。本文件按最终实现整理；逐步验证和历史失败记录见 [PROGRESS](../../PROGRESS.md)。

### 实现结果

项目从 JavaScript、内存会话和无固定预算的 Agent 循环，扩展为严格 TypeScript、可持久化恢复、可解释上下文投影和执行预算的 Agent Harness。CLI 可以查看预算及任务状态，显式续跑预算停止的任务。核心仍依赖服务契约，可替换模型、工具和存储；未注入预算的旧调用继续兼容。

已有 Bash、文件工具、路径/软链闸门、人工审批和 Cordis 插件生命周期保留。本次主要增加运行治理与恢复能力，没有新增自动摘要、自动重试或自动模型切换。

### 1. TypeScript 迁移与工具链

- 固定 TypeScript 7.0.2，增加 Node 类型；采用 ES2022、NodeNext、strict、noEmitOnError、verbatimModuleSyntax 和 sourceMap。
- 核心、插件、模型、工具、入口、插件配置与测试迁移到 `.ts`；`allowJs=false`。构建引导与产物语法检查脚本保留 JavaScript。
- 新增 [contracts.ts](../../src/core/contracts.ts)：明确消息、模型适配器、工具、Agent、执行上下文、回调和版本化事件接口；Cordis Context 使用类型增强。
- `pnpm typecheck` 只检查类型；`pnpm build` 先检查再清理固定 dist 目录并编译；start/test/check 使用编译产物。动态插件配置导入、启动工作目录和 `.env` 加载语义保留。
- CI 使用固定 pnpm 和锁文件，在 Ubuntu/Windows × Node22/24 执行类型、构建、语法与测试检查。

提交：`80bdffd` 工具链 → `a784b76` 核心 → `5104a99` 插件/模型/工具 → `79fb509` 测试与 CI。

### 2. 契约、状态、持久化与 usage

- [budget.ts](../../src/core/budget.ts) 校验未知字段、负数、非有限值和非安全整数。配置按 runtime 默认 → Agent → 单次调用覆盖，并在 run 开始时形成不可变快照；次数和总额度可以为 0。
- 区分 session、task、run；一次新输入开启 task，继续任务开启关联的新 run。记录模型/工具次数、输入/输出/总 token、主动时间、审批时间、裁剪任务 ID 和停止状态。
- 每个 run 只有一个终态；成功调用继续返回字符串，预算停止通过 `BudgetStop` 暴露原因和状态。终态写入未确认时不报告 completed；写盘失败报告错误并禁止新调度。
- [event-store.ts](../../src/core/event-store.ts) 实现带版本、唯一事件 ID 和递增 seq 的 JSONL；单写入者锁、串行追加和 sync。调度模型/工具前确认关键事件已写入，保存 usage、结果与终态后再推进。
- [session-runtime.ts](../../src/core/session-runtime.ts) 从事件恢复消息、状态、模型/预算设置与累计用量，不执行历史工具。reset 追加事件并切换可见历史，不删除原日志或更换 session ID。
- 未开始执行的历史调用补 skipped；已开始但没有确认结果的调用标 unknown，禁止自动续跑。恢复校验工作区、版本、结构、序号及请求生命周期；尾部半条记录须显式备份隔离，中部损坏不能静默跳过，损坏 UTF-8 尾部按原字节保留。
- [deepseek.ts](../../src/models/deepseek.ts) 支持 `max_tokens`、usage-only 流末包、finishReason 和完整响应判定；缓存/推理细分不重复计费，重复末包不重复结算。截断、残缺参数、无效响应或重复调用 ID 不进入工具执行。
- 供应商 usage 优先；缺失或中断使用统一估算，来源明确为 estimated/uncertain。流片段按 250ms 或 4KiB 合并记录，不作为完整 assistant 消息重复派生。

提交：`36f33c0` 配置 → `d024eb8` 生命周期 → `597df26` JSONL → `737f154` 恢复 → `8fe37eb` usage；`87f5941` 补估算与流式日志，`6b9d858` 加固失败边界。

### 3. 上下文管理

- [token-estimator.ts](../../src/core/token-estimator.ts) 估算完整请求，包含 system、历史、reasoning、调用 ID/参数、工具 schema 和协议封装；ASCII 字符按 0.3、其他 Unicode 码点按 1.0，加每消息 32、每请求 256 token 的工程近似。
- [context-runtime.ts](../../src/core/context-runtime.ts) 按完整 task 分组，包含该任务的所有 run；请求前优先移除最旧的完整已结束任务，工具调用/结果不能拆开。
- 保留 system、安全规则、当前用户输入及当前 task 的全过程。投影只改变发送给模型的消息集合，原始事件不变；状态记录被移除的 task ID。
- 输入必须满足输入目标，且输入估算 + 输出预留 + 安全余量不超过模型窗口；余量为 `max(配置下限, ceil(输入估算 × 10%))`。保护集合仍装不下时，以 context_overflow 停止，模型请求次数保持不变。
- 模型容量来自明确配置或适配器能力元数据；切换模型重新计算。官方 DeepSeek 端点默认模型提供保守 1,000,000 token 能力，自定义端点/模型需要显式容量。

提交：`87f5941` 估算 → `6111fcd` 分组 → `63ebe08` 投影 → `b1fb3a3` 容量停止。

### 4. 执行预算

- 模型次数包含最终回答请求和失败请求；工具次数按实际进入工具入口计，失败及拒批也计，skipped 不计。批量调用依序执行，超额度部分补齐结果；最后一次模型请求给完整纯文本可完成，若还要求工具则全部跳过后停止。
- [run-budget-runtime.ts](../../src/core/run-budget-runtime.ts) 使用可注入单调时钟，区分主动运行、审批等待、模型请求期限与用户取消。审批暂停主动计时，但有独立超时；模型和工具都接收组合 AbortSignal，结束清理计时器与监听器。
- 请求前从累计 token 余额预留输入和输出；余额变少时降低输出上限，无法保留最低输出时停止。响应后按 provider 或估算 usage 结算；重复发送的输入逐请求累计，实际超出估算时禁止后续调度。
- 停止状态包括 completed、max_steps、max_tool_calls、timeout、request_timeout、approval_timeout、token_budget、context_overflow、output_limit、cancelled、error。执行入口按取消、主动期限、对应次数、token、容量检查，竞态不产生多个终态。

提交：`c0fcdf6` 次数 → `ddcc2b0` 时间/取消 → `ac9f15a` 累计 token；`6b9d858` 修复工具取消传递与超长计时器边界。

### 5. 续跑、CLI 与恢复入口

- `agent.continue()` 和 `/continue` 在同 task 下创建新的 run，用当前有效配置刷新本段额度，保留任务累计；不追加重复用户输入、不重放已完成工具，模型根据 skipped 结果重新规划。
- completed 任务不能继续；unknown 需要先核验副作用后开始明确的新任务；context_overflow 在上下文配置与模型未变化时拒绝继续，避免仅刷新次数仍重复失败。
- [cli.ts](../../src/plugins/cli.ts) 新增 `/budget` 查看配置/状态和 `/budget {"maxModelRequests":8}` JSON 覆盖；显示 run、task 累计、usage 来源、停止原因和裁剪范围。`/model` 与 `/budget` 设置写入日志，恢复及 reset 保留当前设置。
- CLI 默认写入 `~/.mini-dsh/sessions/<sessionId>/events.jsonl` 并打印 session ID；设置 `MINI_DSH_SESSION_DIR` 覆盖目录，`MINI_DSH_SESSION_ID` 在同一规范化工作区恢复。退出等待写入并释放锁。
- 运行及审批中按 Esc 取消，方向键不会误取消；保留 `/tools`、`/models`、`/model`、`/history`、`/prompt`、`/reset`、`/exit`。
- `.env` 可配置 `MINI_DSH_BUDGET` JSON、`MINI_DSH_WORKSPACE`、`MINI_DSH_AUTO_APPROVE` 和可选 `CONTEXT7_API_KEY`。注释清理后环境示例仅保留实际默认赋值，可选项说明集中在 README 和本文件。

提交：`4c2ec65` 续跑 → `c86b895` CLI/默认持久化 → `4600379` 集成验收 → `7110917` CI 证据。

### CLI 默认值

- 每段模型请求 64 次，工具调用 128 次，主动时间 600,000ms，总 token 2,000,000。
- 输入目标 65,536，最大输出 16,384，最低输出预留 4,096；安全余量下限 2,048。
- 模型请求期限 180,000ms，审批期限 300,000ms；Bash 保留原有 30 秒期限与 32KiB 输出截断。
- 核心未注入次数/总预算时保留旧兼容行为；CLI 主动注入以上有限默认值。人工等待不扣主动时间，task 累计不随 /continue 清零。

### 验证结果与实际边界

- 原 22 条回归保留，增加 35 条有意义边界/集成测试，共 57/57，无跳过；本地类型、构建及 46 文件语法检查通过。
- 功能提交 `4600379`、交接提交 `7110917` 和注释清理提交 `5969363` 的 Ubuntu/Windows × Node22/24 CI 全部成功；[交接 CI](https://github.com/BeforeLanding/mini-DSH/actions/runs/36508994607)、[注释清理 CI](https://github.com/BeforeLanding/mini-DSH/actions/runs/36509575091)。注释清理后本地再次 57/57。
- 真实 Cordis/JSONL/文件工具集成：预算停止后关闭并重建实例再继续，文件 mtime 未改变，证明没有重复写入；任务总计模型 3 次、工具 1 次，内存和磁盘事件一致。
- [benchmark-store.ts](../../scripts/benchmark-store.ts) 可复现 1,000 次纯模拟 sync 追加：Windows Node24 单机约 645ms、每次约 0.645ms、读取校验约 3.86ms。结果是单机样本，不是吞吐或掉电耐久性承诺。
- 测试无需 API Key，模型请求使用模拟；Bash/文件/持久化为真实操作。未做付费模型任务质量实验；token 近似可能有误差，不能作为精确账单或严格费用上限。
- 不遵守 AbortSignal 的第三方工具可能继续执行，结果按 unknown 处理；恢复只重建事件状态，不恢复文件系统快照；失效 writer.lock 不自动清除。
- 未引入摘要、向量记忆、自动重试、费用预算或多 Agent 共享预算；Biome 暂不作为 CI 门槛。

### 本次追加的注释清理

`5969363` 删除已跟踪源码/测试/脚本中的行注释、块注释和行尾注释，同时清理 CI 版本旁注、`.env.example` 注释及 README 运行代码块注释。URL、正则和字符串内容、中文说明文档及实际 `.env` 保留。编译器生成的 sourceMappingURL 是既有调试映射指令，sourceMap 配置继续保留。

完整提交顺序可用 `git log --reverse --oneline cfee2b5..7110917` 查阅；具体设计参数见 [PLAN](PLAN.md)，逐项需求和证据见 [REQUIREMENTS](REQUIREMENTS.md)、[TASKS](TASKS.md)。
