# 合成证据结果

这两个 episode 是 **脚本化/离线机制证据**，不是模型能力结果。它们验证事件格式、provider 失败恢复、验收和离线成本复算。不得作为基准分数报告。

成本使用每个 manifest 中的合成价格快照：`(input - cacheRead) × input + cacheRead × cacheReadPrice + output × outputPrice`，按每百万 token 归一化。这是样例估算，不是 provider 账单。

| Episode | 状态 | 验收通过 | 请求 | 重试 | 工具调用 | 工具错误 | 输入 | 缓存读取 | 输出 | 成本（USD） | 缺失 usage |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| normal-fix | completed | 是 | 5 | 0 | 4 | 1 | 4500 | 500 | 200 | 0.001218000 | 0 |
| provider-recovery | completed | 是 | 6 | 1 | 4 | 1 | 4500 | 500 | 200 | 0.001218000 | 0 |

离线复现：`pnpm build && node dist/scripts/recompute-report.js docs/samples --check`。该命令校验每个 `SHA256SUMS`，从 `events.jsonl` 回放报告，并与本文件比较。
