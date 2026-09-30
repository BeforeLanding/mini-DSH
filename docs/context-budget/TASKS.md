# 任务清单

更新：2026-09-30。每项只保留当前状态和证据入口；行为、边界、逐步提交与完整验收记录见 [CHANGES](CHANGES.md)。状态：`todo`、`in_progress`、`blocked`、`done`。

- **OPS-01 停止文档提交触发生产部署 — done**：提交 [2ac85bd](https://github.com/BeforeLanding/mini-DSH/commit/2ac85bd1bcd69b85ed0329847cf3791a87472bd4)、纯文档探针 `92507d4`、[CI 36662206000](https://github.com/BeforeLanding/mini-DSH/actions/runs/36662206000)；[详细证据](CHANGES.md#ops-01-停止文档提交触发生产部署)。
- **OPS-02 CI push 路径过滤 — done**：提交 [263d439](https://github.com/BeforeLanding/mini-DSH/commit/263d439efd064ba27870dd8b2e6d95c11e581430)、[CI 36662938984](https://github.com/BeforeLanding/mini-DSH/actions/runs/36662938984)、纯文档提交 `ef46988` 为 0 个 run/check；[详细证据](CHANGES.md#ops-02-ci-push-路径过滤)。
- **OPS-03 文档当前状态化 — done**：PROGRESS 归档提交 `ef46988`；TASKS/CHANGES 证据迁移为本步提交；[详细证据](CHANGES.md#ops-03-文档当前状态化)。
- **NX-06 请求 trace 与编程结果报告 — done**：提交 [08158b9](https://github.com/BeforeLanding/mini-DSH/commit/08158b9)、[CI 36661121345](https://github.com/BeforeLanding/mini-DSH/actions/runs/36661121345)；[详细证据](CHANGES.md#nx-06-请求-trace-与编程结果报告)。
- **NX-05b 将编程任务集扩展到 12 项 — done**：提交 [53e5aba](https://github.com/BeforeLanding/mini-DSH/commit/53e5aba)、[CI 36657576782](https://github.com/BeforeLanding/mini-DSH/actions/runs/36657576782)；[详细证据](CHANGES.md#nx-05b-将编程任务集扩展到-12-项)。
- **NX-15 编程验证记录与交付报告 — done**：提交 [87360a1](https://github.com/BeforeLanding/mini-DSH/commit/87360a1)、[CI 36653379987](https://github.com/BeforeLanding/mini-DSH/actions/runs/36653379987)；[详细证据](CHANGES.md#nx-15-编程验证记录与交付报告)。
- **CD-02 修复服务器 GitHub 下载失败 — done**：提交 [c9f452c](https://github.com/BeforeLanding/mini-DSH/commit/c9f452c)、[Deploy ECS 36574173979](https://github.com/BeforeLanding/mini-DSH/actions/runs/36574173979)；[详细证据](CHANGES.md#cd-02-修复服务器-github-下载失败)。
- **CD-01 阿里云 CLI 发布 — done**：提交 [a632121](https://github.com/BeforeLanding/mini-DSH/commit/a632121)、[Deploy ECS 36550955877](https://github.com/BeforeLanding/mini-DSH/actions/runs/36550955877)；[详细证据](CHANGES.md#cd-01-阿里云-cli-发布)。
- **NX-14 结构化命令执行结果 — done**：提交 [557f27f](https://github.com/BeforeLanding/mini-DSH/commit/557f27f)、[CI 36651228195](https://github.com/BeforeLanding/mini-DSH/actions/runs/36651228195)；[详细证据](CHANGES.md#nx-14-结构化命令执行结果)。
- **NX-13 可靠编辑、冲突与变更交付 — done**：提交 [4c9501c](https://github.com/BeforeLanding/mini-DSH/commit/4c9501c)、[CI 36545691239](https://github.com/BeforeLanding/mini-DSH/actions/runs/36545691239)；[详细证据](CHANGES.md#nx-13-可靠编辑冲突与变更交付)。
- **NX-12 coding profile 与仓库上下文 — done**：提交 `c5dd04b`～`20e8e3b` 及最终集成证据；[详细证据](CHANGES.md#nx-12-coding-profile-与仓库上下文)。
- **NX-12 Windows 短路径 junction 修复 — done**：[详细证据](CHANGES.md#nx-12-ci-修复windows-短路径-junction)。
- **NX-05a 三个编程 fixture 与独立验收 — done**：[详细证据](CHANGES.md#nx-05a-三个编程-fixture-与独立验收)。
- **F1 输出额度与历史裁剪联动 — done**：[详细证据](CHANGES.md#f1-输出额度与历史裁剪联动)。
- **F2 最终持久化 deadline 与提交不确定性 — done**：[详细证据](CHANGES.md#f2-最终持久化-deadline-与提交不确定性)。
- **F3 崩溃恢复的投影观测一致性 — done**：[详细证据](CHANGES.md#f3-崩溃恢复的投影观测一致性)。
- **CB-00 文档基线 — done**：[详细证据](CHANGES.md#cb-00-文档基线)。
- **CB-17 恢复开发基线 — done**：[详细证据](CHANGES.md#cb-17-恢复开发基线)。
- **CB-15 TypeScript 工具链与迁移 — done**：[CI 36504218629](https://github.com/BeforeLanding/mini-DSH/actions/runs/36504218629)；[详细证据](CHANGES.md#cb-15-typescript-工具链与迁移)。
- **CB-01 配置与预算契约 — done**：[详细证据](CHANGES.md#cb-01-配置与预算契约)。
- **CB-02 执行状态与事件 — done**：[详细证据](CHANGES.md#cb-02-执行状态与事件)。
- **CB-11 JSONL 事件存储 — done**：[详细证据](CHANGES.md#cb-11-jsonl-事件存储)。
- **CB-03 模型 usage 与输出限制 — done**：[详细证据](CHANGES.md#cb-03-模型-usage-与输出限制)。
- **CB-12 Session 重建与未知执行识别 — done**：[详细证据](CHANGES.md#cb-12-session-重建与未知执行识别)。
- **CB-04 请求 token 估算 — done**：[详细证据](CHANGES.md#cb-04-请求-token-估算)。
- **CB-05 上下文裁剪与输出投影 — done**：[详细证据](CHANGES.md#cb-05-上下文裁剪与输出投影)。
- **CB-06 步数与工具调用调度 — done**：[详细证据](CHANGES.md#cb-06-步数与工具调用调度)。
- **CB-07 Deadline 与用户取消 — done**：[详细证据](CHANGES.md#cb-07-deadline-与用户取消)。
- **CB-08 累计 token 预算接入 — done**：[详细证据](CHANGES.md#cb-08-累计-token-预算接入)。
- **CB-13 预算停止后的 `/continue` — done**：[详细证据](CHANGES.md#cb-13-预算停止后的-continue)。
- **CB-09 CLI 与用户文档 — done**：[详细证据](CHANGES.md#cb-09-cli-与用户文档)。
- **CB-10 集成验收与交接 — done**：[CI 36508829785](https://github.com/BeforeLanding/mini-DSH/actions/runs/36508829785)；[详细证据](CHANGES.md#cb-10-集成验收与交接)。
- **CB-18 实习导向评估与后续规划 — done（评估）**：[CI 36514313704](https://github.com/BeforeLanding/mini-DSH/actions/runs/36514313704)；[详细证据](CHANGES.md#cb-18-实习导向评估与后续规划)。
- **CB-19 按 mini coding agent harness 定位修订路线 — done（文档）**：[详细证据](CHANGES.md#cb-19-按-mini-coding-agent-harness-定位修订路线)。
- **NX-07 有界代码读取、搜索与大结果回读 — done**：提交 [6c03300](https://github.com/BeforeLanding/mini-DSH/commit/6c03300)、[CI 36538591870](https://github.com/BeforeLanding/mini-DSH/actions/runs/36538591870)；[详细证据](CHANGES.md#nx-07-有界代码读取搜索与大结果回读)。
