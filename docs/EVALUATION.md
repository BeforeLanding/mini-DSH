# 评测证据

本仓库区分三类证据，它们不能互相替代：

[2026-10-25 的组件优化](COMPONENT-OPTIMIZATION.md)增加了一个冻结的前后对照**离线机制与资源**基准（`pnpm bench:components`）。它的预览保真度、事件访问次数和文件打开次数不估计模型能力。原始基线字节和协议固定在 CI 中；历史模型运行结果保持不变。

1. **回归 fixture**（`test/fixtures/`、`pnpm fixtures:check`）验证 Harness 机制：投影、压缩、审批闸门、持久化和恢复。
2. **合成公开样例**（`docs/samples/`）验证事件格式、一次成功的脚本化修复，以及一条 provider 失败/恢复路径。它们是脚本化的，不得读作模型能力结果。
3. **真实模型运行**不在本仓库发布，展示面（README 和讲解页）也不使用模型评测数字作为能力主张。历史 NX-45 run 的原始提示和输出保持私密；发布一个校验和并不会把它的摘要升级为可复现证据。真正的公开实验需要新的冻结协议、已批准的预算和隐私审查。

## `docs/samples/` 里有什么

| Episode | 场景 | 证明了什么 |
| --- | --- | --- |
| `normal-fix` | 对 `repair` fixture 执行脚本化编辑 | 事件完整、验收执行、usage 与成本可复算 |
| `provider-recovery` | 同一任务；第一次 provider 调用返回 429，随后成功 | `model/retry` 关联失败尝试与下一次尝试；run 完成，两次尝试都计入 |

每个 episode 目录包含：

- `events.jsonl`：会话日志，可用 `mini-dsh inspect` 读取。
- `patch.diff`：实际应用的脚本化编辑。
- `verification.json`：验收结果及其输出。
- `manifest.json`：schema 版本、源码提交与脏标记、模型标签、预算、任务集与顺序种子、工具 schema 摘要、策略版本、环境、价格快照和缺失数据计数。
- `report.json`：状态、请求/重试/工具计数、provider usage、成本、缺失 usage。
- `SHA256SUMS`：上述每个文件的摘要。

事件通过把临时工作区和主目录替换为 `<tmp>` 和 `<home>` 完成脱敏。其中不包含 API key、真实用户提示或私有工具输出。校验和描述的是脱敏后的文件。

## 离线复算

不需要 API key，也不需要网络：

```sh
pnpm build
node dist/scripts/recompute-report.js docs/samples --check
```

该命令校验每个校验和，从 `events.jsonl` 重建 `report.json`，检查 `inspect` 看到完整日志，并把重新生成的表格与 `docs/RESULTS.md` 比较。CI 通过 `test/public-evidence.test.ts` 运行同一套逻辑。

重新生成样例（只使用脚本化 fixture；不发出 provider 请求）：

```sh
pnpm evidence:export
```

## 成本口径

样例在每个 manifest 中使用**合成**价格快照：

```
(inputTokens - cacheReadTokens) × inputPrice
+ cacheReadTokens × cacheReadPrice
+ outputTokens × outputPrice
```

价格按每百万 token 计，并归一化为 USD。结果是估算，不是 provider 账单。来自估算（非 provider）尝试的 usage 不计入总和，而是列在 `costBasis` 中；绝不当作 0。真实运行必须分别说明 usage 覆盖率和未知成本。

## 已知限制

- 两个样例不估计成功率，`n=2` 无法支撑任何能力主张。
- 脚本化适配器是 fixture 驱动器，不是模型。`normal-fix` 和 `provider-recovery` 只演示机制。
- 价格快照仅作说明。只有与 provider 账单核对后，才可以称为“付费”。
- 本仓库不发布历史 NX-45 的原始提示或模型输出。
