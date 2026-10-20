# Engineering cases

Three decisions that are easy to get wrong, with the test or evidence that keeps them honest.

## 1. A provider attempt is not a tool side effect

**Problem.** A 429 or a dropped connection invites “just retry”. Retrying a request that already produced tool calls can execute a write twice. Retrying after a partial stream can also double-bill and change the next turn.

**Options.** Retry every failure uniformly; retry inside the adapter’s fetch loop; or retry only attempts that have not produced content or tool-call deltas, with each attempt separately gated and accounted.

**Choice.** Only 429, retryable 5xx, and connection-establishment failures are retried. Every attempt gets its own request id, passes the dispatch gate, and is settled into the budget ledger. `Retry-After` is parsed and bounded by the remaining wall clock. A partial response is saved, the attempt is closed, and the run stops; it is not silently re-sent. Provider `context_overflow` uses the existing compaction fallback with a finite retry budget, not the HTTP retry loop.

**Evidence.** `test/model-retry.test.ts` and `test/compaction-runtime.test.ts` cover 429→success, 503→success, 401 stop, timeout/cancel, retry-after over budget, and partial-stream stop. `provider-recovery` in `docs/samples/` shows a recorded retry and fully accounted attempts.

**Still fails.** The harness cannot prove that a provider did not execute something out of band. “Exactly once” is not claimed: there is no distributed transaction between a remote effect and the JSONL write.

## 2. Why a 9 MB output lost its last line

**Problem.** The first implementation kept the first N bytes of stdout and then called the tail of that truncated text “the tail”. For a coding agent, the real error is usually the last line. Large stdout could also starve stderr of buffer space.

**Options.** Keep a larger prefix; keep only the tail; or keep a bounded head and a ring-buffer tail per stream, draining both pipes continuously, with the full result stored separately.

**Choice.** Each stream has an 8 KiB head and an 8 KiB tail window; both pipes are drained even after the preview is full. The preview exposes the real end. Sparse storage records readable byte ranges and an explicit omitted middle. `read_tool_result` returns `unavailable` for a gap and points at the tail start; it never pretends the middle is retrievable.

**Evidence.** `test/tool-results.test.ts` generates >9 MB stdout with `FINAL_ERROR_MARKER` on the last line, plus a case with a large stdout and trailing stderr. The preview contains the real marker; memory remains bounded; the sparse ref reports the gap.

**Still fails.** A result larger than the disk quota or a storage error can still lose data. The status is then explicit (`storageError`/`truncated`), not silently presented as complete.

## 3. A lower cache bill is not automatically “more efficient”

**Problem.** Freezing the time prefix reduced cache reads dramatically, but the same runs used more requests, more tools, and more wall-clock time. Reporting only the bill would turn a mixed result into a win.

**Options.** Report the bill; report the success rate; or report both plus requests, tool calls, tokens (including unknown), and active time, with the frozen/live distinction.

**Choice.** Cost is always reported with usage coverage. Provider cache-read tokens are read from usage; a missing cache field is “unknown”, not zero. Estimated attempts are excluded from the provider-cost sum and listed separately. The report keeps success, requests, tool calls, and time beside the cost.

**Evidence.** `docs/RESULTS.md` uses the formula and lists unknown-cost counts. R06's `pnpm token:error` reports estimate error from provider usage only. The synthetic samples are explicitly not a capability score.

**Still fails.** Cache hit ratios depend on provider granularity, request shape, and session structure. A stable prefix is necessary but not sufficient for a cache hit; only provider usage can show the hit.
