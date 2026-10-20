# Synthetic evidence results

These two episodes are **scripted/offline mechanism evidence**, not model capability results. They verify event format, provider-failure recovery, acceptance, and offline cost recomputation. They must not be reported as a benchmark score.

Cost uses the synthetic price snapshot in each manifest: `(input - cacheRead) × input + cacheRead × cacheReadPrice + output × outputPrice`, normalized per million tokens. It is an estimate for the sample, not a provider bill.

| Episode | Status | Accepted | Requests | Retries | Tool calls | Tool errors | Input | Cache read | Output | Cost (USD) | Missing usage |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| normal-fix | completed | yes | 5 | 0 | 4 | 1 | 4500 | 500 | 200 | 0.001218000 | 0 |
| provider-recovery | completed | yes | 6 | 1 | 4 | 1 | 4500 | 500 | 200 | 0.001218000 | 0 |

Reproduce offline: `pnpm build && node dist/scripts/recompute-report.js docs/samples --check`. The command verifies every `SHA256SUMS`, replays reports from `events.jsonl`, and compares this file.
