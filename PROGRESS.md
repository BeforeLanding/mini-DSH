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
