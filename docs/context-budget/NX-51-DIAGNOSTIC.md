# NX-51：BC01 大输出与按需回读开发实验

状态：离线施工与冻结准备；真实模型 12 次尚未授权。独立协议 `NX-51-BC01-log-2arm-v1`，不并入 NX-42 正式题或 NX-45 六题开发批，也不改旧证据。

## 问题与任务

在原 BC01 本地日界线 bug 修复和相同四组隐藏产物验收下，比较 4 KiB 与 256 KiB 无关诊断日志时，Baseline／Full 的可靠完成、provider 输入／输出／缓存 token、估算费用、调用、回读和主动时间。Full 输入若较少，但请求更多、耗时更长或正确性更差，逐项照报。三次重复仅作开发诊断，不作显著性或泛化结论；复合 Full 不能把收益单独归因于前缀冻结或主动压缩。

BC01 原始题面、业务源码、参考解、隐藏验收和反例保持不变。每个候选额外获得受保护的 `diagnostic.mjs`，公开任务要求先用 bash 运行，再完成原修复，并在最终答复写 `DIAGNOSTIC_VALUE=<值>`。脚本输出精确 4,096 或 262,144 ASCII 字节：首行 `DIAGNOSTIC_OFFSET` 给 UTF-8 字节偏移，诊断行从正中开始，其余为无关填充。每个重复的值由固定 SHA-256 规则生成；同重复同负载的两臂获得逐字节相同的脚本和输出。答案不写在题面，脚本源码也没有值的明文。只认会话中的 `node diagnostic.mjs` Bash 工具结果与最终答复，不从外部注入日志。

## 固定日程与配置

固定顺序为三个重复，每次先 4 KiB 再 256 KiB，各负载包含相邻的 Baseline／Full：

1. 重复 0：4 KiB Baseline → Full；256 KiB Full → Baseline。
2. 重复 1：4 KiB Full → Baseline；256 KiB Baseline → Full。
3. 重复 2：4 KiB Baseline → Full；256 KiB Full → Baseline。

合计 6 个双臂 block、12 条 episode，两个臂各先行三次。先跑条件的结果不会改变同 block 下一条。两臂沿用 `resolveV2Arms(1_000_000, '1m')`，工具 schema、自动审批、隔离、模型、thinking、采样和整题预算相同；共享上限为累计 1M token、64 次主／摘要模型请求、128 次工具调用、600 秒主动时间。Baseline 使用当前 live／无界预览配置，Full 使用 frozen／16 KiB 预览和当前上下文管理；不改生产策略、预算或模型序列。

模型预定 `deepseek/deepseek-flash`，API 模型 ID 与预期回显 `deepseek-flash`，thinking enabled，采样 provider-default（不发送 temperature、top_p 或 seed）。2026-10-18 查阅[官方价格与模型页](https://api-docs.deepseek.com/quick_start/pricing/)：版本 `DeepSeek-V4.1-Flash-1017`、1M 窗口、峰时每百万缓存命中输入 `$0.006`、未命中输入 `$0.30`、输出 `$1.20`；[官方思考模式页](https://api-docs.deepseek.com/guides/thinking_mode/)说明 thinking 可显式启用，temperature 在此模式无效，Flash 的 top_p 有效范围为 0.95–1.0。最终冻结写入当时的价格快照，执行前仍须核对官方页面；版本／价格变化须重新冻结。manifest 包含代码 HEAD、BC01 全部文件和相关源码 SHA-256、工具 schema SHA-256、模型与价格快照、日程、预算及 digest；必须从干净 HEAD 生成，validate-only 在无密钥情况下核对这些值和固定 WSL/bwrap 隔离。

## 记录、停止与费用

每条固定分母内分别记录原业务四组产物验收、诊断命令是否实际成功执行、诊断是否早于首个编辑、正确值是否实际出现于工具结果正文、最终值是否正确、run 状态与停止原因。可靠完成要求这些条件都通过、run completed、证据完整且 provider usage 无缺失；仅从脚本源码推算出答案而工具结果从未显示值，不算可靠完成。正常任务失败仍进入记录和所有资源合计，并继续下一条。未执行项列 missing，基础设施或 provider 错误、缺 provider usage、快照/验收证据异常、金额闸门拒绝则停批并保留已发生的开销。报告按负载和臂分组，另保留全部逐次记录；provider usage 与本地 ChatRequest 输入估算分开，费用是根据 usage 和峰时价的估算，不是账单。

历史 NX-45 的 BC01 四条旧 episode 按上述峰时价重算约 `$0.04384`，机械放大为本批 12 条约 `$0.1315`；新增 256 KiB 输出与额外请求可能显著增加输入，因此仅把约 `$0.2–1` 作为粗量级预期，不当作费用上界。保守预留复用 NX-45 公式：每条按 1M token 全以最高 `$1.20/M`、20% 余量，再计一次跨 token 闸门的 1M 输入和 16,384 输出，得 `$1.7596608`；12 条加协议探针 `$0.0196608` 为 `$21.1355904`。建议本批授权上限 **`$22`**；这是刻意宽松的安全上限，不是预计账单。逐请求金额闸门仍以前述峰时价和 provider usage 运行，未知 usage 停批。任何旧批授权均不适用。付费执行须另获本批明确金额上限授权，使用新证据目录；不得追加失败重试或删改结果。

离线冻结命令：`node dist/scripts/eval-diagnostic-run.js --freeze-config <仓库外配置.json> --output <新manifest.json>`；无密钥预检：设置 `MINI_DSH_V2_RUNTIME` 后运行 `node dist/scripts/eval-diagnostic-run.js --manifest <manifest.json> --validate-only`。获本批金额授权后才可执行 `node dist/scripts/eval-diagnostic-run.js --manifest <manifest.json> --evidence-root <新目录> --max-usd 22 --execute`。冻结配置需给出本节模型、端点、thinking、采样及带来源、UTC 时间和美元峰时价格的快照。
