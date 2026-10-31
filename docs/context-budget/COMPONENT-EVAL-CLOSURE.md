# 组件评测收口：零付费冻结验收（2026-10-27）

状态：**CE-1、CE-2 完成；真实 provider 请求 0，付费 episode 0**。四份 manifest 各计划 12 条，共 48 条；已完成的只有冻结验证与离线机制测量，不是 48 条模型评测。付费执行未授权。

基线为 main `0b8b9736b7da181ade20d7a33dea480bd985aa46`，评测代码提交 `425138299f2cfd1586ad9d5e5a00e58f65ca5afb`。复用未合并 `3752ca4` 的 LOO 实现后补齐机器合同，未改写 NX-50/NX-51 原始结果或 2026-10-26 的旧准备材料。新协议的配置、允许变化与验收见 [消融协议](NX-51-COMPONENT-ABLATION.md)。

## 冻结身份

以下是本轮实际验证的源码提交、评测 HEAD 和 manifest digest。三个变体分别保存在远端 `component-closure/no-preview`、`component-closure/no-projection`、`component-closure/no-report`，均已推送；full 的评测 HEAD 是收口 PR 的 CE-1 提交。

- full：源码 `0b8b9736b7da181ade20d7a33dea480bd985aa46`；评测 `425138299f2cfd1586ad9d5e5a00e58f65ca5afb`；digest `2a05b4971b55e6841afd61881aa5ae0989c931d34d0dae7d349f1384a4eaaa34`。
- no-preview：源码 `38b4730315bdc93fe116a8e817d6ef0eac5627f3`；评测 `429aacef840b61fca5b7380699de0be0028efef6`；digest `63676172263be0cc5374e4ef8cf3bc64db394a791e36329421ac0246911b0a9a`。
- no-projection：源码 `de7558cb95f7ca98d5d3497f6293ed2371fb6c5d`；评测 `208b1ebb56bff1736262f3194ccb5c3ee45b1cc8`；digest `7f1fb7188223c37d899377e3610120395e63a7ac83d351cc6efe85f97c30cff0`。
- no-report：源码 `ddc04fc951edf3b567d9b19405e52f9b85a5aecd`；评测 `606f1294493542fba9049f975770ad2bfb86564a`；digest `9f11b77ecbbc9d8a86ed6d3b8711b87ee6af5d3efe9f5eff30cfba0395161422`。

[机器可读记录](../samples/component-eval-closure-20261027.json) 包含完整 manifest 文件哈希、tool schema、probe 哈希、离线输出哈希、预检输出与日志哈希。完整 configs/manifests/probes/logs/audit.mjs 保存在仓库外 `D:\Agent\outputs\component-eval-closure-20261027\`；`evidence/` 为空。公开仓库不含模型提示词、输出或工具正文。

## 实际验收

四份 manifest 由干净的评测 HEAD 生成，并分别通过 `--validate-only`：每份 6 题、12 条计划、`isolation=wsl-bwrap`、`paidRequests=0`。每臂的源码提交与评测 HEAD 之间 `git diff --quiet SOURCE HEAD -- src` 通过，确认评测层没有偷偷改产品源码。

规范化后只排除 `variant`、源码/评测提交、派生 digest 和产品源码哈希，四份 manifest 其余字段逐字相同；产品源码哈希变化恰好等于协议的精确路径集合，没有路径新增/删除。四臂都显式冻结 `postCompactionPrune=false`，tool schema 相同；共同配置漂移由比较器回归测试拒绝。

离线探针证明开关生效：full 的预览通过 12/12，no-preview 为 0/12，但四臂 fullRecall 均 12/12；投影 propertyReads 合计 full 32,982、no-projection 2,284,323；报告 snapshotOpens 合计 full 6、no-report 91。投影/报告每个输出哈希均与 full 一致；不把离线 CPU/I/O 或保留信息差异宣称为模型收益。

CE-1 完整隔离测试 576/576、0 fail、0 skipped；最终 CLI 修正与类型导入清理后，check 224 files、相关五个测试文件 26/26、lint 253 files 0 诊断。fixture checker 25 项、offline 12/12 completed/accepted、components 三项基准均通过。回退源码分别通过 check 与相关测试：no-preview 14/14；no-projection 机制 4/4，另补实际 compaction-plan/runtime/recovery/trigger 46/46；no-report 6/6。未以不存在的旧测试文件名充作运行证据。

## 零付费复现

在上述固定评测 HEAD 的干净工作树安装 `pnpm install --frozen-lockfile`，再 `pnpm check`。Windows 使用已准备好的固定 Linux runtime：

```powershell
$env:MINI_DSH_V2_RUNTIME='D:\Agent\tmp\nx42-runtime\unpack'
node dist/scripts/eval-v2-freeze.js --config CONFIG.json --output NEW_MANIFEST.json
node dist/scripts/eval-v2-run.js --manifest NEW_MANIFEST.json --validate-only
```

CONFIG 按机器记录中的模型、价格快照与对应源码提交填写：`split=component-loo`、对应 `variant`、`tier=1m`、`window=1000000`；省略 gitCommit，由冻结器读取干净 HEAD。四份配置共用完全相同的价格快照。

在各自源码提交的干净工作树构建后，运行 `node scripts/benchmark-components.mjs --out NEW_PROBE.json`；probe 的 sourceCommit 必须对应 manifest.sourceBaseCommit。不要在评测 HEAD 上跑探针后把其身份改写成源码提交。

新冻结必须使用上面的固定评测 HEAD，不能拿 PR 最后的文档证据提交替代。CE-2 只增加验收记录与更新任务/进度，不修改冻结清单里的源码或消融协议。Windows 原始文件哈希受检出换行影响，跨平台重冻会产生新 digest，必须对四臂重新整体核验。

## 后续边界

2026-10-26 的价格/模型快照只用于本轮零付费验证，没有把它当作当前实时价格。实际付费前必须重新核对、重新冻结并单独授权具体批次及金额；当前 `$22/批、$88/四批` 只是旧快照下的储备上限。未执行 `--execute` 或付费协议探针，未合并 main、未发布，也没有模型有效性或统计显著性结论。
