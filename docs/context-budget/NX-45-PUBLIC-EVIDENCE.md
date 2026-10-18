# NX-45 可公开审阅的证据摘要

此页只提供最小、脱敏的仓库内索引。原始 manifest、24 条 episode 的事件日志、runs、报告、离线审计及更正脚本目前仅保存在本地归档，**未随仓库公开**；下面的 SHA-256 用于核对同一批文件，不能替代访问原始证据，也不表示第三方能从仓库独立重算每条请求。逐题结果与末尾事件观察见[探索结果](NX-45-EXPLORATION-RESULT.md)，完整配置和验收定义见[冻结协议](NX-45-DEVELOPMENT.md)，usage 更正方法见[离线更正](NX-45-USAGE-CORRECTION.md)。

## 来源与口径

- 协议 `NX-45-dev-2arm-v1`；运行时冻结代码 HEAD `fed19a7c648b9f7f49f4a0254f7f15c80c8df099`；2026-10-17 保存的已曝光开发集，六题、每题两次、每臂计划分母 12，24/24 已执行，无缺失。
- Baseline / Full 使用同一 `deepseek/deepseek-flash` 模型（当时标示版本 `DeepSeek-V4.1-Flash-1017`）、任务、工具和整题预算。整题上限为 1,000,000 累计 token、64 次模型请求、128 次工具调用、600 秒主动时间。Full 同时改变提示前缀、主动压缩目标和工具预览，无法单独识别某一机制的效果。
- “可靠完成”要求 run 为 `completed`、独立产物验收通过且证据齐全；产物验收是单独口径。Baseline 分别为 **11/12、11/12**；Full 分别为 **10/12、12/12**。Full 的两条 `token_budget` 退出候选通过验收，仍不算可靠完成。
- Full / Baseline 的模型请求为 **214 / 184**，工具调用 **364 / 331**，主动时间 **1,062,214.7 / 867,029.0 ms**。价格来源是原始 `manifest.json` 在 `2026-10-17T10:02:18Z` 记录的 `https://api-docs.deepseek.com/quick_start/pricing/` 快照；协议指定的历史峰时价格为未命中输入 $0.30、缓存命中输入 $0.006、输出 $1.20／百万 token。从原始 provider `model/usage` 事件按 episode 的 `requestId` 去重重算，Full / Baseline 的 episode usage 估价为 **$0.391956600 / $1.448544408**。缓存命中包含在输入 token 中；这不是供应商账单，也不是当前价格声明。
- 探针 usage 估价 $0.000031200，episode 加探针 $1.840532208；运行时金额闸门含完整探针预留的读数为 $1.860161808，属于另一口径。旧 `runs.jsonl` 在四条 Full 摘要 episode 少记缓存命中 43,264 token，离线更正未改原件。

这组数据未证明可靠完成率提升、统计显著性或泛化提升；费用差异也不能单独归因于稳定前缀或主动压缩。

## 原件核对指纹

以下为本地归档原件或更正文件的 SHA-256，按文件名定位；摘要不包含请求录制、提示正文或事件输出。`corrected-usage.json` 还保存六份顶层原件和 24 份事件日志的逐文件哈希及字段差异，目前亦仅本地保存。

| 文件 | SHA-256 |
| --- | --- |
| `manifest.json` | `c91452108cb4b51313dc7dc518f5921667f1293523e567f265e562233081cb69` |
| `runs.jsonl` | `aa81debbbe8c8f20b0aa0bfd795dfe89043ac41faa6a4bdd1de7bb3dd0d8897a` |
| `report.json` | `0f52c660526d8d38c20de07d937c1f4f2692b0a82b842f5a9ffa770969b1bbe3` |
| `report-offline.json` | `d17cd72c4409be97abd522f68843cbf87b1a428cde9369b83522112165da6019` |
| `offline-audit.json` | `1d35597054efaca51b13b3d5c74f5b68e7a0468f828be2284dafb690219eace6` |
| `probe.json` | `18708cb4594a5a65169a3362e9af776416b0efb63d55eaa83078e775329246c6` |
| `recalculate.py` | `e9ce25ec398b0de179ef6663332c423d9bc871ccdac5d76b7b23e042061d2536` |
| `corrected-usage.json` | `71848692fbc5c87204e86eb0d6dee5d8687284df777e571c651ad24006c67a8c` |

核验时应取得对应的本地原件，并逐个计算 SHA-256；仓库内摘要本身不能恢复原始事件，也不能验证供应商账单。
