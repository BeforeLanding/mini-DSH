# Evaluation evidence

This repository separates three kinds of evidence. They are not interchangeable:

1. **Regression fixtures** (`test/fixtures/`, `pnpm fixtures:check`) verify the harness mechanics: projection, compaction, approval gates, persistence, recovery.
2. **Synthetic public samples** (`docs/samples/`) verify the event format, one successful scripted repair, and one provider failure/recovery path. They are scripted and must not be read as model capability results.
3. **Real model runs** are not published in this repository. The historical NX-45 run kept its raw prompts and outputs private; its summary is not upgraded to reproducible evidence by publishing a checksum. A real public experiment needs a new frozen protocol, approved budget, and privacy review.

## What is in `docs/samples/`

| Episode | Scenario | What it proves |
| --- | --- | --- |
| `normal-fix` | Scripted edit of the `repair` fixture | Events are complete, acceptance runs, usage and cost are recomputable |
| `provider-recovery` | Same task; first provider call returns 429, then succeeds | `model/retry` links the failed and next attempt; the run completes and both attempts are accounted |

Each episode directory contains:

- `events.jsonl`: the session log, readable by `mini-dsh inspect`.
- `patch.diff`: the scripted edit that was applied.
- `verification.json`: acceptance result and its output.
- `manifest.json`: schema version, source commit and dirty flag, model label, budget, task set and order seed, tool-schema digest, policy version, environment, price snapshot, and missing-data counts.
- `report.json`: status, request/retry/tool counts, provider usage, cost, missing usage.
- `SHA256SUMS`: digest of every file above.

The events are sanitized by replacing the temporary workspace and home directory with `<tmp>` and `<home>`. No API key, real user prompt, or private tool output is included. Checksums describe the sanitized files.

## Offline recomputation

No API key and no network are required:

```sh
pnpm build
node dist/scripts/recompute-report.js docs/samples --check
```

The command verifies each checksum, rebuilds `report.json` from `events.jsonl`, checks that `inspect` sees a complete log, and compares the regenerated table with `docs/RESULTS.md`. CI runs the same logic through `test/public-evidence.test.ts`.

To regenerate the samples (only the scripted fixture is used; this makes no provider request):

```sh
pnpm evidence:export
```

## Cost口径

The sample uses a **synthetic** price snapshot in each manifest:

```
(inputTokens - cacheReadTokens) × inputPrice
+ cacheReadTokens × cacheReadPrice
+ outputTokens × outputPrice
```

Prices are per million tokens and normalized to USD. The result is an estimate, not a provider bill. Usage from an estimated (non-provider) attempt is excluded from the sum and listed in `costBasis`; it is never treated as zero. Real runs must state usage coverage and unknown cost separately.

## Known limits

- The two samples do not estimate a success rate, and `n=2` cannot support any capability claim.
- The scripted adapter is a fixture driver, not a model. `normal-fix` and `provider-recovery` demonstrate mechanisms only.
- The price snapshot is illustrative. Only reconciliation with a provider bill may be called “paid”.
- The repository does not publish the historical NX-45 raw prompts or model outputs.
