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

- Dataset revision `c104f840cc67f8b6eec6f759ebc8b2693d585d4a` and official v3.0.17 harness commit `3f01bd622c0a22c00406139f69a234ef08225f22` are pinned for the first no-model probe. The downloaded 500-row parquet was SHA-256 checked (`a45b1fe4e2f0c8390b2b2938ac83e92ed5979000856808f3679c07812e9e6dcd`). The full 50-task subset still needs its own frozen selection file and image digests.
- ~~A no-model PoC proving: a known test patch is scored through the official adjudication channel; the candidate workspace and container `/testbed` see the same tree; the candidate container has no provider key, host HOME, Docker socket, or oracle mount; cleanup leaves no residue.~~ **Completed for `sympy__sympy-20590`**; see the candidate PoC section below.
- ~~Per-instance image digests, frozen after that PoC.~~ **Frozen for this instance**: `swebench/sweb.eval.x86_64.sympy_1776_sympy-20590@sha256:3a282752833ce34730ee0621e22033501c993f45742775ca57f04c9ff27178a0`. The 50-task selection and its image digests are not frozen.
- A same-model baseline configuration and a price snapshot.
- Explicit authorization for paid model calls and any new cloud/compute resources.

## Pinned no-model adjudication probe

`scripts/swebench/poc_official.py` first verifies the dataset bytes, official harness commit, 500-row count and fixed `sympy__sympy-20590` base commit. Its `--execute` path uses the **public gold patch only for the scoring-channel probe**, with two distinct run IDs, and requires both official reports to resolve the instance. It records the pulled image RepoDigest and checks for leftover containers. Gold text remains in a temporary single-instance JSON file and must never be passed to an Agent run. This proves only the official adjudication channel, not mini-DSH's ability to solve the task.

The existing CI workflow has an explicit `workflow_dispatch` input `swebench_poc`; ordinary PR CI leaves this resource-heavy job off. The local preflight passed with the pinned dataset and official checkout. The manually triggered [CI run 39387381791](https://github.com/BeforeLanding/mini-DSH/actions/runs/39387381791) scored the fixed gold patch twice with distinct run IDs: both official reports resolved the instance with zero errors and no leftover containers. The pulled image digest is `swebench/sweb.eval.x86_64.sympy_1776_sympy-20590@sha256:3a282752833ce34730ee0621e22033501c993f45742775ca57f04c9ff27178a0`. Local Docker Desktop remains unavailable to this account; the candidate workspace and file/Bash consistency portion remains a separate acceptance step.

### Candidate workspace PoC (completed for the pinned instance)

`scripts/swebench/poc-candidate.ts` exports the pinned image checkout into a host candidate directory, proves that host file tools and container Bash edit the same tree, then stops the candidate container. Only after the scripted zero-model Agent ends does the controller apply the known public patch, export the candidate diff, and submit it to an independent official scoring run. The final manual [CI run 39395532729](https://github.com/BeforeLanding/mini-DSH/actions/runs/39395532729) at commit `f52699c` passed all seven jobs.

Earlier attempts stopped at the checkout guard ([39388591825](https://github.com/BeforeLanding/mini-DSH/actions/runs/39388591825), [39389384812](https://github.com/BeforeLanding/mini-DSH/actions/runs/39389384812), [39389944509](https://github.com/BeforeLanding/mini-DSH/actions/runs/39389944509)). The image HEAD is `5efaed257c694e4452b4c8361aae1cd9cdefd6d1` (tree `67df329…`) while the dataset base is `cffd4e0f86fefd4802349a9f9b19ed70934ea354` (tree `7d23c02…`). A recursive path-by-path object comparison over 1828 entries found **content-identical trees**: 1758 paths differ only by mode (`100644 -> 100755`), and `git diff-tree --raw` reports 1758 `M` records with zero object changes. The guard still rejects any content, added/removed path, or type difference; it records this evidence in `candidate-evidence.json` and normalises the worktree modes to the base before the Agent starts.

The candidate container uses the same pinned image digest, `--network none`, a read-only root, a single rw `/testbed` bind mount, no privileged mode, `--cap-drop ALL`, and the host runner uid/gid so both sides can edit files without restoring capabilities. It has no provider key, host HOME, Docker socket, or oracle mount; a path escape is rejected. The scripted adapter made **0 provider requests**. Host `write_file` was readable by container Bash, and a container append was readable by host `read_file`.

The exported candidate patch scored in a fresh official run: 1 submitted / 1 completed / 1 resolved, 0 unresolved, 0 empty patches, 0 errors, 0 unstopped containers, 0 unremoved images. The gold patch was scored twice more in the same run (both resolved, 0 errors). This proves the candidate tool path, patch export, and independent scoring channel. It does **not** prove mini-DSH's model capability, the 5-task development batch, or the formal 50-task subset; those runs require separate paid-model authorization.

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
