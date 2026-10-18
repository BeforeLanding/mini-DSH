# NX-44 smoke-v2：仅短修复重测

本清单是 NX-44 原批次的针对性诊断，不把结果并入正式效果统计，也不修改旧批次。当前阶段只冻结和离线验证；真实调用须另行授权。

## 冻结与执行合同

`smoke-freeze` 和 `smoke-run` 均须显式传 `--scenarios repair`。冻结文件的 `scenarios` 只含源码固定的 repair 项，并参与 digest。运行前同时核对 CLI 选择、清单、HEAD、工具 schema、fixture、wire 和 digest；执行循环只遍历清单所选项。不能用 CLI 临时追加协议或回读场景，也不能把篡改上限后重算 digest 的清单当作原日程。

repair 仍为 6 次主请求、1 次摘要、累计 200,000 token、主/摘要单次输出 16,384/8,192、主动/墙钟 600/660 秒、单请求 180 秒、最多 32 次工具调用。模型 ID `deepseek-flash`、thinking enabled、1M 上下文、默认采样及原题面、公开检查、独立验收均不变。官方在本次核价时把该模型版本标为 DeepSeek-V4.1-Flash-1017；这是 provider 版本元数据变化，不能把旧 NX-44 效果当作同版对照。执行前须再核对官方版本和价格，变化则停下重新冻结。

执行入口先校验清单与金额，再做 WSL/bwrap 隔离预检，最后才读取既有 provider 凭证。证据根目录必须尚不存在，由入口独占创建；结果只写 `smoke-report.json` 和 repair 子目录，`formalEffectStatistic=false`。任一失败或 usage 未知即停，不自动追加或重跑。

## 费用依据

[DeepSeek 官方价格](https://api-docs.deepseek.com/quick_start/pricing/)在本次核价时对 `deepseek-flash` 的峰时价格为每百万 token：缓存命中输入 $0.006、未命中输入 $0.30、输出 $1.20。已知费用估算为 `(cacheReadTokens × 0.006 + (inputTokens − cacheReadTokens) × 0.30 + outputTokens × 1.20) / 1,000,000`；缓存命中字段缺失时按全部输入未命中。没有 provider usage 的已派发请求列为未知，停止后续请求，不能按零计。

本场景 200,000 token 全按最高输出单价为 $0.24；其 20% 缓冲为 $0.048；按最多 1M 输入及 16,384 输出计算的最后一次主请求为 $0.3196608，摘要上限 8,192 输出对应 $0.3098304，故单请求最大值覆盖两者。下限为 `$0.24 + $0.048 + $0.3196608 = $0.6076608`。最后请求中部分 token 可能已经在 200,000 token 上限内，相加包含保守重叠；20% 缓冲是在此之外。拟议单批上限 $0.65。历史 repair 的 $0.011176248 峰时估算只作已观察点，不保证新版本用量或账单。

## 授权后的命令模板

从干净最终 HEAD 冻结到新的仓库外目录，生成后不可改动 manifest。`MINI_DSH_V2_RUNTIME` 的路径来自 [既有隔离部署记录](NX-42-V2-ISOLATION.md)，执行前仍须实际检查目录及预检；密钥只在既有环境或 `.env` 中提供，不写进命令。

```powershell
$env:MINI_DSH_V2_RUNTIME='D:\Agent\tmp\nx42-runtime\unpack'
node dist/scripts/smoke-run.js --manifest <新manifest绝对路径> --scenarios repair --validate-only
node dist/scripts/smoke-run.js --manifest <新manifest绝对路径> --scenarios repair --evidence-root <尚不存在的新证据目录> --max-usd 0.65 --execute
```

第二条真实调用命令必须等单独授权；冻结交接会给出实际绝对路径、digest 和准确命令。旧三场景清单与原批授权均不适用。

## 运行后的完整 Harness 回放

1. 先只读审计新 `recording.jsonl`：检查 header 的代码 SHA、fixture、manifest digest、工具 schema，逐条重算 start 指纹，确认每个 start 都有同 index 的终态、主/摘要顺序、流片段、usage 与 finishReason；未知或不完整的记录明确标记，不能声称严格回放通过。
2. 用 `restoreSmokeFixture` 将 header 的初始 fixture 恢复到**新建的隔离工作区**，不要使用真实用户目录或原候选目录。复查 fixture hash；把录制中 project-context JSON 的原 `workspace` 路径作为 `recordedProjectWorkspace` 的唯一允许映射。
3. 用 `createSmokeReplay` 构造无 provider 引用的 adapter，依录制请求的 system `Time:` 行向 `createHarness({ runtimeTime })` 注入时间；生产默认实时模式保持不变。主/摘要请求数和金额闸门沿用该批清单及报告，不允许隐含额外请求。候选 Bash 仍经已预检的 `createIsolatedCommandRunner` 和固定运行时，文件工具只作用于恢复的 fixture。
4. 用同一任务文本和 `smokeBudget(repair)` 运行完整 Harness，等待工具停止、session 关闭，再复制退出候选并用原 fixture 独立验收。比较逐请求指纹、工具结果、runStatus、候选 hash、artifactAcceptance 与 evidenceStatus，并调用 `replay.assertConsumed()`；记录首个分歧及已消费主/摘要数。
5. 任一请求的 system/messages/tools 或指纹不同，立即拒绝，不把旧响应喂给新请求。adapter 边界录制完整与完整 Harness 回放是两个结论；本阶段仅用一条合成 repair 响应验证了后者的基本路径，真实多请求轨迹须运行后单独核验。
