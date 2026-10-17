# NX-44：专用真实 smoke 准备

本阶段只运行离线模拟模型。历史 NX-42 日志仍缺完整请求材料，不能严格回放。以下录制协议仅供未来三个固定 smoke 场景使用，不作为通用会话记录格式。

## 录制边界

`scripts/smoke-recording.ts` 在 adapter 边界记录每次调用的 `purpose=main|summary`、模型、输出上限、system、messages、工具 schema、固定 wire 配置、SHA-256 请求指纹、按顺序收到的已解析 provider 流事件（含工具参数增量、usage、模型回显）、content/reasoning 回调片段、完整或部分响应、finishReason 和错误类别（不保存原始 provider 错误正文）。摘要请求在 `ChatRequest` 中有显式 purpose，不能靠最后一句提示词猜测。fixture 初始文件以受控 base64 快照及逐文件 hash 保存；隐藏文件、链接和超过 1 MiB 的快照拒绝。版本字段包括代码 SHA、fixture ID、manifest digest 与工具 schema SHA。

录制文件用独占创建及本地文件权限 `0600`，每条记录写入后同步；它可能含真实模型推理和 fixture 内容，只能放在不提交的证据目录，不能复制到报告或输出到控制台。凭证不属于请求材料或 wire 配置，不写入录制文件。工作区绝对路径只经声明的 `${WORKSPACE}` 映射归一化。若其他动态材料不能按原样重建，回放应失败。

回放适配器没有真实 provider 引用；每次检查主/摘要全局顺序、完整请求材料和指纹，重放记录的流与响应，缺失/额外调用报错。仅在隔离 fixture 中执行副作用。录制文件是可复核证据，不提供防恶意改写签名；旧日志不具备此协议，不能据此升级为严格回放通过。

## 固定 smoke 清单与执行边界

`scripts/smoke-plan.ts` 是唯一的三项日程，`scripts/smoke-run.ts` 不接受题目、arm、重复数或重跑参数，也不调用 `eval-v2-run`。所有请求，包括探针、摘要、模型内部重试或失败响应，都经过同一 recorder 计数；usage 缺失或累计上限越界时即停止后续调用。未知副作用、预算停止或完成不可靠均不算通过。结果写入独立的 `smoke-report.json`，标记 `formalEffectStatistic=false`，不进入旧批次的 `runs.jsonl` 或效果报告。

| 场景 | 主/摘要请求 | 累计 token | 单次主/摘要输出 | 主动/墙钟时间 | 单请求超时 | 工具调用 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 协议探针 | 2/0 | 20,000 | 1,024/无 | 120/150 秒 | 60 秒 | 0 |
| 压缩后回读 | 4/1 | 300,000 | 16,384/8,192 | 600/660 秒 | 180 秒 | 16 |
| 短修复收尾 | 6/1 | 200,000 | 16,384/8,192 | 600/660 秒 | 180 秒 | 32 |

协议探针先检查一次完整文字流，再检查一次只构造、不执行的 `echo_probe` 工具流；要求模型回显、provider usage 和 finishReason。回读场景用合成会话写入哨兵事件，显式压缩后要求模型按事件号调用 `read_history` 并复述原值。修复场景用既有 `repair` fixture；候选进程退出、session 关闭、候选文件复制后才运行验收。三项按序执行，失败即停。命令副作用只在 bwrap 隔离的 fixture 内运行；付费入口在读取 API key 前完成冻结校验和隔离预检。

零付费入口：`node dist/scripts/smoke-run.js --manifest MANIFEST --validate-only`。它只核对 HEAD、固定日程、fixture、工具 schema 与清单摘要，返回 `paidRequests:0`，不读取凭证。未来经单独授权后才可使用 `--manifest MANIFEST --evidence-root NEW_DIRECTORY --max-usd 1.00 --execute`，并须预先设置既有 `MINI_DSH_V2_RUNTIME` 和 provider 凭证。`--execute` 要求新目录，不能指向正式评测证据。更换源码、价格或 fixture 必须重新冻结，不改旧清单。

## 价格与保守额度

冻结时从 [DeepSeek 官方价格](https://api-docs.deepseek.com/quick_start/pricing/) 取 `deepseek-flash`（DeepSeek-V4.1-Flash）峰时价：每百万缓存命中输入 $0.006、缓存未命中输入 $0.30、输出 $1.20。总价按每次 provider usage 的 `cacheReadTokens × 0.006 + (inputTokens - cacheReadTokens) × 0.30 + outputTokens × 1.20` 再除以一百万；缓存命中数缺失时全部输入按未命中计。一个带明示假设的点估计是 520,000 token 中 80% 输入、20% 输出且无缓存，约 $0.2496；这不是承诺用量。把全部 520,000 token 都按最高的输出单价计算为 $0.624，再加 20% 储备为 $0.7488。建议单批授权上限 $1.00；最后一次请求可能使累计 token 跨过上限，1M 上下文与 16,384 输出上限下，最坏多约 $0.32，故 $1.00 覆盖该单次越界的价格估算。provider 用量缺失、价格调整、服务端计数变化时实际费用不确定，应立即停机并核查账单。执行前重新检查官方价格与模型回显。
