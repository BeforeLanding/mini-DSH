# SWE-bench Verified subset: pre-registration and execution adapter

2026-10-30：新组件优化位于独立实验分支，新增同源 full/逐项消融、真实触发读数与 testbed 环境修复。[当前冻结与运行边界](context-budget/SWE-COMPONENT-EFFECTS.md) 记录 30 条开发计划及 Docker 阻塞；真实模型请求 0，以下历史正式结果不变。

**Status (2026-10-24).** The pre-registered 50-task, four-arm formal batch has completed all 200 paid model episodes and all 200 official scores. The results and budget-parity limitation are recorded below. The historical “50 tasks ≈ $2 / 10 minutes” figure from an external GPT-5 experiment is not a promise for this project.

## Formal four-arm result (2026-10-24, 50 tasks per arm)

The frozen formal manifest used source commit `8b3047c`, SWE-bench Verified at revision `c104f840…`, the same `deepseek/deepseek-flash` model across four arms, and a nominal 416,666 input+output-token cap per episode. All 200 scheduled episodes ran. Official SWE-bench v3.0.17 scoring under the final `score3` run IDs returned 200 results, **0 scoring errors and 0 infrastructure failures**. The run statuses were 129 budget stops and 71 normal completions. Six core evidence checksums pass.

- Candidate mini-DSH: **26/50 = 52%**, Wilson 95% interval 38.5%–65.2%; 37 budget stops.
- External mini-SWE-agent 2.4.6 baseline: **27/50 = 54%**, Wilson 40.4%–67.0%; 22 budget stops.
- Context-reference: **28/50 = 56%**, Wilson 42.3%–68.8%; 36 budget stops.
- Context-proposed: **27/50 = 54%**, Wilson 40.4%–67.0%; 34 budget stops.

The pre-declared paired candidate/baseline cells are both resolved 24, candidate-only 2, baseline-only 3, neither 21; rate difference −2 percentage points and exact two-sided McNemar p=1. The context-reference/context-proposed cells are both 26, reference-only 2, proposed-only 1, neither 21; difference +2 points and p=1. These small discordant counts do not establish a capability difference.

The baseline's watchdog checks between model steps. **22/50 baseline episodes exceeded the shared nominal token cap** by one final response, compared with 0/50 in each mini-DSH arm; baseline maximum was 457,686 tokens, about 9.8% above the cap. One over-cap baseline episode resolved. The frozen sensitivity rule excludes over-cap resolutions while keeping all 50 tasks in the denominator: candidate **26/50**, baseline **26/50**, context-reference **28/50**, context-proposed **27/50**. This is a conservative sensitivity reading, not a replacement for official scores. Nominal cap configuration did not ensure exact consumed-token parity, so the 27/50 vs 26/50 primary comparison is not a clean capability claim.

Provider-usage cost estimate at the frozen prices is **$3.618705108 known usage**, plus **one episode with unknown exact usage** after a transient model retry. It is not an invoice. The first official scoring attempts were interrupted by Docker Desktop; all paid episodes were already saved. Final `score3` rescored only those patches after the environment recovered and made no additional model requests. The final report is `D:\Agent\outputs\mini-dsh-swebench-formal-20261022\formal-report.json`; frozen sensitivity result is `formal-token-sensitivity.json`; compact final archive excluding workspaces is `formal-evidence-final.tar.gz` (SHA-256 `fb58277adf09d9f303b80d23a811a0e24ccbae5d499a0e734da57122c52b40bd`). Full original evidence remains at `/home/jeffery/swebench-evidence-4arm-formal-20261022`. Hidden scoring rows and score logs are local evidence, not for publication.

## Development observation (2026-10-21, n=5, candidate only)

- 5/5 planned episodes executed; 0 infrastructure failures, 0 scoring errors, 0 unknown-usage episodes.
- 2/5 resolved (`astropy__astropy-14539`, `pallets__flask-5014`); 2 unresolved; 1 empty patch (`matplotlib__matplotlib-23299`).
- 4/5 episodes ended at the per-task token cap (`budget`); 1 completed normally. The resolved astropy patch was produced before its budget stop.
- Provider-usage estimate at the frozen peak prices: **$0.0918** for the batch (single-task cap $0.50, batch cap $2.50). Tokens: 1,565,239 input, 41,522 output, 1,454,464 cache-read; active time 8m38s.
- Wilson 95% interval for 2/5 is 11.8%–76.9%. With n=5, one arm and no same-model baseline, this is a **development diagnostic**, not a success-rate claim. The budget-stop frequency is evidence that the $0.50 per-task cap is tight for this subset; it should be revisited before the formal batch.
- Evidence: `D:\Agent\outputs\mini-dsh-swebench-dev-20261021` (local; `score.*.log` and the hidden test rows are not for publication).

## Four-arm development observation (2026-10-21, n=5, descriptive only)

The 4-arm development batch ran 20/20 planned episodes with 0 infrastructure failures, 0 scoring errors and 0 unknown-usage episodes; estimated provider cost **$0.471** and active time 45m40s.

| Arm | Resolved / planned | Budget stops | Completed | Estimated cost | Input tokens | Output tokens | Cache read |
|---|---:|---:|---:|---:|---:|---:|---:|
| candidate (mini-dsh) | 2/5 | 3 | 2 | $0.092 | 1,628,394 | 38,290 | 1,505,024 |
| baseline (mini-SWE-agent 2.4.6) | **3/5** | 0 | 5 | $0.201 | 5,410,255 | 100,280 | 5,245,696 |
| context-reference | 2/5 | 4 | 1 | $0.089 | 1,586,976 | 38,591 | 1,474,560 |
| context-proposed | 2/5 | 4 | 1 | $0.089 | 1,627,696 | 35,035 | 1,501,440 |

- The only arm-level difference is one task: `django__django-12273` resolved by the baseline and not by the three mini-DSH arms. Paired candidate/baseline: both resolved 2, baseline-only 1, candidate-only 0, neither 2; exact McNemar p=1. The context pair is identical on all five tasks (both 2, neither 3, p=1). **n=5 cannot support a capability claim.**
- **Budget parity was not established in this observation.** The mini-DSH arms hit the token cap derived from the $0.50 per-task cap (about 416k input+output tokens), while the baseline's `cost_limit` of $0.50 allowed it to use about 1.1M input tokens per episode because most input was cache hits. The baseline therefore had a larger effective token allowance; the 3/5 vs 2/5 difference is confounded by the budget policy, not a clean capability comparison. On 2026-10-21 the **shared-token-cap** policy was chosen and implemented: the external watchdog and the post-run check use the same `tokenCapFromUsd(perTask.maxCostUsd, prices)` value as the candidate (416,667 for $0.50 at these prices). The observation above predates this change; a four-arm development observation under the shared cap is still needed before the formal batch.
- Evidence: `D:\Agent\outputs\mini-dsh-swebench-4arm-dev-20261021b` (local; scoring logs and hidden test rows are not for publication). The first attempt was aborted by a missing `mcp` dependency in the baseline venv before any baseline model call; that incident and its $0.0175 candidate-only spend are recorded separately in CHANGES.

## Shared-token-cap four-arm development rerun (2026-10-22, n=5, descriptive only)

At source commit `309af44`, the same five development tasks and four-arm schedule ran 20/20 episodes with the shared 416,666-token nominal cap derived from the $0.50 per-task ceiling. Official scoring completed with 0 scoring errors, 0 infrastructure failures and 0 unknown-usage episodes. Estimated provider usage was **$0.373505046** against a separately authorized $10 batch configuration cap. Candidate resolved **1/5**, mini-SWE-agent baseline **2/5**, and each context arm **1/5**. Each arm had four budget stops and one normal completion. Paired candidate/baseline cells were both resolved 1, baseline-only 1, candidate-only 0, neither 3 (exact McNemar p=1); the two context arms resolved the same task. This remains a development diagnostic, not a capability claim.

The baseline watchdog applies the same nominal token cap but checks the trajectory between model steps. All four baseline budget-stop episodes exceeded it by one final response: total input+output tokens ranged from 427,115 to 453,214, or up to 8.8% above 416,666. The candidate's maximum was 403,611. One over-cap baseline episode (`astropy__astropy-14539`) resolved, so nominal cap parity does **not** prove exact consumed-token parity. The formal report must show per-arm over-cap counts and a sensitivity reading that excludes over-cap resolutions; any capability interpretation must retain this limitation.

The first official-scoring attempt failed because the clean WSL run script did not place the SWE-bench Python venv on `PATH`; it made no extra model calls. A `--resume` pass verified all 20 paid episodes already existed, then re-scored only those saved patches with the pinned venv. All six top-level evidence checksums pass. Evidence: `D:\Agent\outputs\mini-dsh-swebench-formal-20261022\development-evidence` (12 MB, excluding workspaces); full original evidence remains in WSL at `~/swebench-evidence-4arm-dev-20261022-shared`.

## What is implemented

- `scripts/swebench/protocol.ts`: repository-stratified seeded selection; development/formal separation; gold-field sanitisation and rejection; deterministic arm-interleaved schedule; configuration-ceiling budget; official prediction validation; explicit host→container path mapping; episode summary that keeps infrastructure failures in the denominator and unknown cost separate; Wilson interval, exact McNemar and paired four-cell statistics.
- `scripts/swebench/preregister.ts`: writes one `swebench-run-manifest` with both batches, exclusions, arms, caps, prompt template, price snapshot and image digests. It is `draft` until every required field is present **and** `--finalize` is passed; the runner refuses a draft.
- `scripts/swebench/run.ts`: reuses `createHarness` for each episode, applies per-task request/tool/time/output/token caps, saves `events.jsonl`, terminal status, usage and the patch (including an empty patch), stops the batch on infrastructure failure or unknown usage, supports batch-level `--resume` without re-running finished episodes, and scores predictions independently with a new `run_id` per batch.
- `scripts/swebench/workspace.ts`: fixture workspaces for offline tests, and the official-image workspace path with the same constraints accepted by the no-model PoC (pinned digest, content check against the dataset base, `--network none`, read-only root, one rw `/testbed` mount, no privileges, host uid/gid).
- `scripts/swebench/report.ts`: recomputes the report from `runs.jsonl` and `scores.json`; reports planned vs executed denominators, per-arm Wilson intervals, declared paired cells, failure-taxonomy counts and the three pre-declared failure traces.
- `scripts/swebench/{external-contract,external,external-run,external-fingerprint}.ts`: the external-arm contract, one-row dataset/config generation, candidate-isomorphic container args, process timeout/watchdog, label-based container cleanup, trajectory/prediction parsing, provider-usage/cost normalisation, secret scanning and the frozen install fingerprint.
- `scripts/swebench/external-probe.ts`: zero-model acceptance probe for the external baseline.
- `scripts/swebench/run.ts`: dispatches `system: 'external'` to the external executor, preflights the install fingerprint and Docker images before creating evidence, and passes the external patch to the same independent scorer.
- Tests: `test/swebench-protocol.test.ts`, `test/swebench-preregister.test.ts`, `test/swebench-run.test.ts`, `test/swebench-external.test.ts` (scripted model, fixture workspace, fake external runner, mock independent scoring, empty patch, infrastructure stop, unknown usage stop, resume, draft/gold refusal, command template, dataset whitelist, usage/status parsing).

### Image environment commits

The official images may commit an environment change on top of the dataset base. The workspace accepts an image whose content differs **only** in a small, content-only set of build-metadata files (`pyproject.toml`, `setup.py`, `setup.cfg`, `requirements*.txt`, `environment.yml`, `Pipfile*`, `poetry.lock`, `tox.ini`; at most 8 paths). The episode then starts from the image HEAD and exports the patch against that same HEAD, so the Agent and the official scorer see the same tree. Evidence records `imageHead`, the dataset `baseCommit`, the effective `patchBase`, and the differing paths. Any added/removed path, any source-path change, or a larger diff is still refused before the Agent starts. The first observed case is `astropy__astropy-14539`, whose image pins `setuptools==68.0.0` in `pyproject.toml`.

### Same-model external baseline (mini-SWE-agent)

The external arm runs the **unmodified** mini-SWE-agent batch CLI; the repository does not fork its prompt, tool schema, agent loop or model client.

- **Pin:** `mini-swe-agent==2.4.6`, git commit `a83fcae82d2a08f0ee0c688f9d137b3566c097f8`. The manifest records the version, upstream config SHA-256 and a hash of nine installed files (agent loop, prompts/config, Docker environment, LiteLLM model, SWE-bench entry point). `--verify-baseline` fills them; the runner recomputes them before any episode.
- **Command:** a frozen argv template with whole-element placeholders:
  `["{python}","-m","minisweagent.run.benchmarks.swebench","--subset","{dataset}","--split","test","--output","{output}","--workers","1","--redo-existing","-c","{upstream_config}","-c","{config}"]`. Supplying `-c` disables the built-in default config, so the pinned upstream config and the per-episode override are both passed. The dataset is generated as one sanitized row plus the digest-pinned `image_name`; it never contains `test_patch` or other hidden fields.
- **Sandbox:** the baseline starts its own container from the same image with the candidate's isolation profile: `--network none`, read-only root, host uid/gid, one writable `/testbed` bind mount, `--cap-drop ALL`, no-new-privileges, `bash -lc`, 30-second command timeout. The provider key lives only in the host process; `forward_env` is empty and every labeled container's environment is inspected before cleanup. Containers carry `mini-dsh.external.*` labels and are removed by label, never by mini's random name.
- **Prompt/context:** the native mini-SWE-agent prompt, single bash tool and linear context are used. Candidate vs baseline is therefore a **system-level** comparison, not an isolated prompt or context factor.
- **Limits:** `step_limit` = per-task model requests, `cost_limit` = per-task dollar cap (LiteLLM estimate), `wall_time_limit_seconds` = wall clock, `max_tokens` = output cap. A live trajectory watchdog enforces cost/request/action/time bounds between steps; the hard process timeout is the wall clock plus two minutes. The canonical cost is recomputed from provider usage and the frozen price snapshot, not from LiteLLM. The baseline's action count is not directly capped at the candidate's `maxToolCalls`; the report states this limitation.
- **Outcome:** patch comes only from `preds.json`; the workspace diff is diagnostic. Status maps `Submitted`→completed, `LimitsExceeded`/context-window→budget, `TimeExceeded`→timeout, auth/permission/unknown→infrastructure. Missing usage is never zero-filled and stops a priced batch. Empty submitted patches stay in the denominator.
- **Zero-model probe:** `swebench:external-probe` runs the real CLI + dataset + config + Docker + `DeterministicModel`, asserts `Submitted`, empty or submitted patch parsing, labeled-container cleanup and no provider key in the container. The 2026-10-21 probe passed with an empty patch and with a non-empty `README.rst` patch. Evidence: `D:\Agent\outputs\mini-dsh-swebench-external-probe-20261021`.
- **Frozen four-arm manifest:** `D:\Agent\outputs\mini-dsh-swebench-4arm-20261021\manifest-frozen.json` (schema 3, 20 development + 200 formal episodes, all external fields present, `freezeStatus: frozen`, `paidRequests: 0`, $110 configuration ceiling). The shared-cap rerun used a separately frozen $10 development manifest at `D:\Agent\outputs\mini-dsh-swebench-formal-20261022\manifest-development.json`; the formal split is separately frozen at a $100 batch configuration cap in `manifest-formal.json`. Both preserve the original task selection and schedule. Formal execution still requires all 50 pinned images locally and separate paid authorization. The earlier `manifest-draft.json` is retained as the pre-freeze record.

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

## Reviewable zero-cost draft (not frozen)

A real dataset run of the pre-registration was produced without model calls or Docker:

- Sanitized dataset: `D:\Agent\outputs\mini-dsh-swebench-preregistration-20261020\verified-sanitized.json` (500 rows; `instance_id`, `repo`, `base_commit`, `version`, `environment_setup_commit`, `problem_statement` only; gold/hidden fields absent).
- Candidate-only historical draft: `D:\Agent\outputs\mini-dsh-swebench-preregistration-20261020\manifest-draft.json`.
- Frozen four-arm manifest: `D:\Agent\outputs\mini-dsh-swebench-4arm-20261021\manifest-frozen.json`, schema 3, `seed=20261020`, development 5, formal 50, 11 repositories, 4 arms, 200 formal episodes + 20 development episodes; all external fields present (`mini-swe-agent` 2.4.6, config/install hashes, model `deepseek/deepseek-flash`, `candidate-isolation-v1`); budget ceiling $110.00 at $0.50/task/arm. This is a configuration ceiling, not an expected spend.
- `freezeStatus` is **frozen**, `paidRequests: 0`. The shared-cap development rerun and separately authorized $100-cap formal batch are recorded above. The manifest itself did not grant authorization; the user separately authorized both paid batches. If the per-task budget changes in a future batch, re-freeze rather than editing the frozen file.

The price snapshot shape is fixed but its values must come from an official source with a capture date:

```json
{ "currency": "USD", "inputUsdPerMillion": null, "cachedInputUsdPerMillion": null,
  "outputUsdPerMillion": null, "capturedAt": "YYYY-MM-DD", "source": "official price page URL" }
```

Replace each `null` with the observed number; the validator rejects missing or non-USD prices.

## Historical execution preconditions (satisfied for the formal batch)

- A frozen 50-task selection and per-instance image digests. The current `preregister` output lists the missing digests; it does not invent them.
- The pinned mini-SWE-agent installation and every task image present locally. The external preflight recomputes the version/config/install fingerprint, checks the provider key's **name**, Docker/uid, and `docker image inspect` for the scheduled digests; it refuses before creating evidence. Images are not pulled implicitly by the preflight.
- A price snapshot with an official source and capture date. The runner refuses paid execution without one and never zero-fills unknown usage.
- The shared-cap four-arm development observation is complete; its baseline one-response overshoot must remain visible in the formal report and sensitivity reading.
- The official harness v3.0.17 must already be installed in the Python environment used by the runner (`python -m swebench.harness.run_evaluation`); the runner does not install or upgrade it.
- A separate hidden-rows file with `test_patch` and `FAIL_TO_PASS`/`PASS_TO_PASS`, passed as `--scoring-dataset`. The 50 formal rows have been generated from the dataset with SHA-256 `a45b1fe4…` at `D:\Agent\outputs\mini-dsh-swebench-formal-20261022\scoring-rows-formal.hidden.json` (file SHA-256 `db26064f…`). The Agent dataset stays sanitized; the runner validates each scored row against the frozen repo/base and writes the hidden rows only to a temporary directory for the official scorer, never into the evidence tree.
- Explicit user authorization for paid model calls and any new cloud/compute resources. The manifest records `paidRequests: 0`; it did not grant authorization. The user authorized the development rerun and the formal 200-episode batch separately.

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
  --prices prices.json --baseline-commit a83fcae82d2a08f0ee0c688f9d137b3566c097f8 \
  --baseline-command '["{python}","-m","minisweagent.run.benchmarks.swebench","--subset","{dataset}","--split","test","--output","{output}","--workers","1","--redo-existing","-c","{upstream_config}","-c","{config}"]' \
  --baseline-python /path/to/venv/bin/python --verify-baseline --baseline-api-key-env DEEPSEEK_API_KEY \
  --per-task-cap-usd 0.5 --batch-cap-usd <approved-cap> \
  --out outputs/run-manifest.json

# Zero-model external baseline probe (real CLI + Docker + DeterministicModel; no provider request)
pnpm swebench:external-probe -- --manifest outputs/run-manifest.json --split development \
  --instance <instance-id> --python /path/to/venv/bin/python --out outputs/external-probe --execute

# Execute one batch (requires an explicitly approved cap; the draft check runs before any model call)
pnpm swebench:run -- --manifest outputs/run-manifest.json --dataset verified-sanitized.json \
  --scoring-dataset scoring-rows.hidden.json --external-python /path/to/venv/bin/python \
  --evidence-root outputs/swebench-<batch> --split development --backend docker --scoring official \
  --batch-id <batch-id> --execute

# Resume a stopped batch without retrying finished or interrupted episodes
pnpm swebench:run ... --evidence-root outputs/swebench-<batch> --resume --execute

# Recompute the report from the raw evidence
pnpm swebench:report -- --evidence-root outputs/swebench-<batch>
```

The budget in the manifest is a **ceiling**: `formal tasks × arms × per-task cap + development batch + compute reserve`. It is not an estimate that any task is solved within the cap. The per-task cost cap is translated into a conservative total-token cap using the largest of the three unit prices; the actual cost is then estimated only from provider usage.
