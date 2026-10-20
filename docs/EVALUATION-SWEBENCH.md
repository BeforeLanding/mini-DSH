# SWE-bench Verified subset: pre-registration and execution adapter

**Status (2026-10-20).** The official no-model adjudication channel and the candidate workspace path are verified for one pinned instance. The batch runner, pre-registration and report path are implemented and pass a scripted, zero-model end-to-end test. **No paid model run has been executed**: there is no 5-task development result and no formal 50-task result. The historical “50 tasks ≈ $2 / 10 minutes” figure from an external GPT-5 experiment is not a promise for this project.

## What is implemented

- `scripts/swebench/protocol.ts`: repository-stratified seeded selection; development/formal separation; gold-field sanitisation and rejection; deterministic arm-interleaved schedule; configuration-ceiling budget; official prediction validation; explicit host→container path mapping; episode summary that keeps infrastructure failures in the denominator and unknown cost separate; Wilson interval, exact McNemar and paired four-cell statistics.
- `scripts/swebench/preregister.ts`: writes one `swebench-run-manifest` with both batches, exclusions, arms, caps, prompt template, price snapshot and image digests. It is `draft` until every required field is present **and** `--finalize` is passed; the runner refuses a draft.
- `scripts/swebench/run.ts`: reuses `createHarness` for each episode, applies per-task request/tool/time/output/token caps, saves `events.jsonl`, terminal status, usage and the patch (including an empty patch), stops the batch on infrastructure failure or unknown usage, supports batch-level `--resume` without re-running finished episodes, and scores predictions independently with a new `run_id` per batch.
- `scripts/swebench/workspace.ts`: fixture workspaces for offline tests, and the official-image workspace path with the same constraints accepted by the no-model PoC (pinned digest, content check against the dataset base, `--network none`, read-only root, one rw `/testbed` mount, no privileges, host uid/gid).
- `scripts/swebench/report.ts`: recomputes the report from `runs.jsonl` and `scores.json`; reports planned vs executed denominators, per-arm Wilson intervals, declared paired cells, failure-taxonomy counts and the three pre-declared failure traces.
- Tests: `test/swebench-protocol.test.ts`, `test/swebench-preregister.test.ts`, `test/swebench-run.test.ts` (scripted model, fixture workspace, mock independent scoring, empty patch, infrastructure stop, unknown usage stop, resume, draft/gold refusal).

## Frozen material for the first PoC

- Dataset revision `c104f840cc67f8b6eec6f759ebc8b2693d585d4a`; 500-row parquet SHA-256 `a45b1fe4e2f0c8390b2b2938ac83e92ed5979000856808f3679c07812e9e6dcd`.
- Official harness v3.0.17 commit `3f01bd622c0a22c00406139f69a234ef08225f22`.
- Instance `sympy__sympy-20590`; image `swebench/sweb.eval.x86_64.sympy_1776_sympy-20590@sha256:3a282752833ce34730ee0621e22033501c993f45742775ca57f04c9ff27178a0`.
- Local data and official harness checkout: `D:\Agent\outputs\mini-dsh-swebench-poc`.

## Verified no-model evidence

The manual [CI run 39395532729](https://github.com/BeforeLanding/mini-DSH/actions/runs/39395532729) at commit `f52699c` passed all seven jobs. Candidate evidence (`D:\Agent\outputs\mini-dsh-swebench-poc\ci-39395532729\candidate-evidence.json`):

- Image HEAD `5efaed…` vs dataset base `cffd4e0…`: 1828 paths content-identical; 1758 differ only by `100644→100755` mode; raw diff object changes 0. Content, added/removed paths or type changes are still rejected.
- Host `write_file` → container Bash and container Bash → host `read_file` both visible; path escape rejected.
- `network=none`, only `/testbed` mounted, read-only root, non-privileged, host uid/gid; **provider requests 0**.
- Candidate patch scored in a fresh official run: 1 submitted / 1 completed / 1 resolved / 0 errors; no leftover containers. Two independent gold runs also resolved.

The earlier official-channel run [39387381791](https://github.com/BeforeLanding/mini-DSH/actions/runs/39387381791) scored the gold patch twice with distinct run IDs as a channel check. Gold patches are used only by the scoring-channel probe and never enter an Agent run.

This proves the candidate tool path, patch export and independent scoring channel. It does **not** prove model capability or environment equivalence for all tasks.

## Preconditions still blocking a real run

- A frozen 50-task selection and per-instance image digests. The current `preregister` output lists the missing digests; it does not invent them.
- A same-model mini-SWE-agent baseline: commit and invocation are part of the manifest contract, but the batch runner intentionally refuses to execute an `external` arm. A dedicated adapter must be supplied and reviewed; otherwise only different-system results may be reported.
- A price snapshot with an official source and capture date. The runner refuses paid execution without one and never zero-fills unknown usage.
- Development-batch observations (5 tasks × arms) and a budget decision based on them. Until then the manifest remains `draft`; `--finalize` is an explicit claim that those prerequisites are met.
- Explicit user authorization for paid model calls and any new cloud/compute resources. The manifest records `paidRequests: 0`; it does not grant authorization.

## Commands

```sh
# Offline end-to-end acceptance (scripted model, fixture workspace, mock scorer; no key, no Docker, no network)
pnpm build
node --test dist/test/swebench-run.test.js

# Freeze the protocol (draft first; add --image-digests and --finalize only when complete)
node dist/scripts/swebench/preregister.js \
  --dataset verified.json --tasks 50 --dev-tasks 5 --seed 20261020 \
  --dataset-revision c104f840cc67f8b6eec6f759ebc8b2693d585d4a \
  --harness-commit 3f01bd622c0a22c00406139f69a234ef08225f22 \
  --model <model-id> --context-window-tokens 1000000 \
  --prices prices.json --baseline-commit <mini-swe-agent-commit> \
  --baseline-command '["<baseline>","<args>"]' \
  --per-task-cap-usd 0.5 --batch-cap-usd <approved-cap> \
  --out outputs/run-manifest.json

# Execute one batch (requires an explicitly approved cap; the draft check runs before any model call)
pnpm swebench:run --manifest outputs/run-manifest.json --dataset verified-sanitized.json \
  --evidence-root outputs/swebench-<batch> --split development --backend docker --scoring official \
  --batch-id <batch-id> --execute

# Resume a stopped batch without retrying finished or interrupted episodes
pnpm swebench:run ... --evidence-root outputs/swebench-<batch> --resume --execute

# Recompute the report from the raw evidence
pnpm swebench:report --evidence-root outputs/swebench-<batch>
```

The budget in the manifest is a **ceiling**: `formal tasks × arms × per-task cap + development batch + compute reserve`. It is not an estimate that any task is solved within the cap. The per-task cost cap is translated into a conservative total-token cap using the largest of the three unit prices; the actual cost is then estimated only from provider usage.
