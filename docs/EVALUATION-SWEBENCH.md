# SWE-bench Verified subset: pre-registration and offline adaptation

This document describes the **protocol and offline adapters**, not a result. No SWE-bench task has been run, no task image has been pulled, and no paid model request has been made. The historical “50 tasks ≈ $2 / 10 minutes” figure from an external GPT-5 experiment is not a promise for this project.

## What is implemented

- `scripts/swebench/protocol.ts`: repository-stratified, seed-deterministic selection; configuration-ceiling budget; official prediction validation; explicit host→container path mapping; episode summary that keeps infrastructure failures in the denominator and unknown cost separate.
- `scripts/swebench/preregister.ts`: writes `instances.json` with the dataset revision, official harness commit, selected instances, arms, scoring rules, budget ceiling, missing image digests, and `paidRequests: 0`.
- `test/swebench-protocol.test.ts`: verifies determinism, exclusions, budget arithmetic, prediction shape, path escape rejection, and summary denominators.

## Frozen protocol (before any formal run)

1. **Dataset**: SWE-bench Verified at a fixed revision. Select 50 instances by repository-stratified round robin after a seeded within-repository shuffle. Do not select by prior results, gold-patch size, or an invented difficulty score.
2. **Exclusions**: publish a list before selection. A pre-run check may test image runnability only; it must not let the agent attempt the task first.
3. **Arms**: capability candidate (mini-DSH) vs same-model mini-SWE-agent baseline; context reference vs proposed, changing only compaction strategy. If the baseline cannot use the same model, report different-system results, not a harness effect.
4. **Runs**: first formal attempt per task and arm only. Provider HTTP retries stay inside that attempt and are fully accounted. `resolved@1` on the fixed subset is the primary metric.
5. **Caps**: per-task cost, request count, tool-call count, wall clock, and max output. Interleave arm order to reduce time/cache bias.
6. **Failure taxonomy**: timeout, budget stop, infrastructure failure, wrong answer, empty patch. Empty patches are saved. Infrastructure failures are not silently removed from the main denominator; an infrastructure-valid subset may be reported only as a secondary view.
7. **Cost**: unknown usage is reported as unknown, never zero. Known lower bound and missing ratio are reported together. “Paid” is used only after reconciliation with a provider bill.
8. **Statistics**: report the paired four-cell counts (both resolved, only A, only B, neither), Wilson intervals per arm, and a pre-declared paired analysis. Small samples do not justify a significance claim.

## Preconditions still blocking a real run

- A fixed dataset revision and the official harness commit.
- A no-model PoC proving: a known test patch is scored through the official adjudication channel; the candidate workspace and container `/testbed` see the same tree; the candidate container has no provider key, host HOME, Docker socket, or oracle mount; cleanup leaves no residue.
- Per-instance image digests, frozen after that PoC.
- A same-model baseline configuration and a price snapshot.
- Explicit authorization for paid model calls and any new cloud/compute resources.

## Commands

```sh
# Validate the offline protocol and adapters
pnpm build
node --test dist/test/swebench-protocol.test.js

# Freeze a subset once the dataset revision, harness commit, and caps are decided
node dist/scripts/swebench/preregister.js \
  --dataset verified.json --tasks 50 --seed 20261020 \
  --dataset-revision <revision> --harness-commit <official-commit> \
  --per-task-cap-usd 0.5 --arms 4 --out outputs/instances.json
```

The generated budget is a **ceiling**: `formal tasks × arms × per-task cap + development batch + compute reserve`. It is not an estimate that any task will be solved within the cap.
