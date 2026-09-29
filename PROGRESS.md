# 开发进度

更新：2026-09-28。文档基线完成；TypeScript 迁移和预算功能尚未实施。

当前状态：CB-17 恢复开发基线已完成；下一步 CB-15 TypeScript 工具链与迁移。历史 E-01 失败记录保留。

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
1. CB-15a：核验并锁定 TypeScript 工具链，建立编译产物执行路径，验证原行为后提交。
2. CB-15b 至 d：分批迁移核心、插件/模型/工具、测试及 CI，每批验证并提交。
3. CB-01 开始按计划推进契约、事件存储、请求投影、预算与继续；任务完成回填实际证据。
4. 后续核验编译器/类型依赖版本、协议兼容、估算误差、存储性能与实际任务质量。

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
