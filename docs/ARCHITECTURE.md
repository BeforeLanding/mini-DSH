# Architecture

mini-DSH is a TypeScript ESM coding-agent harness built on Cordis plugins. The core is replaceable at the edges: CLI, model provider, tools, and MCP servers are plugins or adapters.

## Event-sourced session

- `src/core/event-store.ts` appends every event to `events.jsonl` and waits for the disk write where the contract requires durability.
- `src/core/contracts.ts` defines the event union; `src/core/event-validation.ts` validates payloads at runtime.
- `src/core/session-runtime.ts` rebuilds visible state, derives messages, and seals one terminal `run/finish` per run.
- A recorded `tool_call` always gets a result, including `skipped`, `unknown`, or cancelled outcomes. Recovery never re-executes an unknown tool result.

## Request projection and compaction

- `src/core/context-runtime.ts` groups history by task, protects the current task, and removes only complete older tasks when the projection does not fit.
- `src/core/compaction-plan.ts` plans a contiguous shadow range inside the current task; the original events are never deleted.
- `src/core/compaction-runtime.ts` asks the model for a structured summary, persists it, and inserts a code-generated frame with the covered event range. `read_history` allows bounded recall by event number.
- Three thresholds are named: hard input cap, pressure trigger (0.8 of the compaction budget), and post-compaction target (0.65). If pressure compaction does not reach the target or barely reduces input, the run suppresses further pressure attempts and records `context/pressure-suppressed`; the overflow fallback stays available.

## Models, retries, and budget

- `src/models/deepseek.ts` is the provider adapter. It classifies failures into a bounded `ProviderError` kind and never stores response bodies or headers in errors.
- `src/core/model-dispatch.ts` gates each attempt; `src/core/run-budget-runtime.ts` accounts requests, active time, tokens, approvals, and cancellation.
- `src/core/model-error.ts` and `run/error` events make the failure stage and safe message visible to `inspect`. A missing usage value is `unknown`, never zero.
- `src/core/token-calibration.ts` observes estimate error from provider usage only and keeps the opt-in calibration layer conservative (multiplier ≥ 1).

## Tools and approvals

- `src/core/tool-runtime.ts` executes every tool through one central authorization hook before the tool body runs.
- `src/core/tool-authorization.ts` trusts only built-in tools whose declared effect matches the registry. Unknown/external tools always ask; an approval is bound to the tool call, argument digest, workspace, and policy version.
- File tools keep real-path and symlink checks before and after approval. Bash uses an explicitly constructed child environment and an independent temporary HOME. This is an application policy, not OS isolation.

## MCP

- MCP is opt-in and empty by default (`src/app/mcp-config.ts`). It loads only a user-level config or an explicit path, accepts secrets only as `${ENV_NAME}` references, and never auto-loads a workspace config.
- MCP tools are namespaced by `serverName`, treated as unknown-effect tools, and registered through the same `ToolRuntime`. Connection failures, timeouts, and disconnects stay local to that server.

## Isolation and evidence

- `scripts/eval-v2-isolation.ts` has a Windows WSL→bwrap backend and a Linux native bwrap backend behind one interface. Preflight verifies namespaces, no network interface, workspace writes, hidden host paths, and descendant termination.
- The required CI isolation job installs bubblewrap, prepares the pinned Node runtime, and fails on any skipped required test.
- `scripts/recompute-report.ts` verifies `SHA256SUMS`, rebuilds `report.json` from `events.jsonl`, and compares `docs/RESULTS.md`. Synthetic samples are separate from capability claims.

## Installed CLI

`mini-dsh` exposes `--help`, `--version`, `--show-config`, `inspect`, and the offline `demo [fix]`. Interactive use needs `DEEPSEEK_API_KEY`; `demo`, `inspect`, and `--show-config` do not.
