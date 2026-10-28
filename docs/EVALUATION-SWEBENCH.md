# SWE-bench Verified 子集：预注册与执行适配器

**状态（2026-10-24）。** 预注册的 50 任务四臂正式批次已完成全部 200 次付费模型 episode 和全部 200 个官方评分。结果与预算对齐限制记录在下方。外部 GPT-5 实验的历史“50 任务 ≈ $2 / 10 分钟”数字不是本项目的承诺。

**展示边界（2026-10-28）。** 仓库 README 与讲解页不把这些数字作为能力主张展示。本页仍是协议、结果与证据边界的参考文档；它不是基准排行榜。

## 正式四臂结果（2026-10-24，每臂 50 任务）

冻结的正式 manifest 使用源码提交 `8b3047c`、修订版 `c104f840…` 的 SWE-bench Verified、四臂共用的 `deepseek/deepseek-flash` 模型，以及每个 episode 名义上 416,666 输入+输出 token 上限。全部 200 个计划 episode 均已运行。在最终 `score3` run ID 下按官方 SWE-bench v3.0.17 评分，返回 200 个结果，**0 个评分错误、0 个基础设施失败**。运行状态为 129 次预算停止和 71 次正常完成。六项核心证据校验和全部通过。

- 候选 mini-DSH：**26/50 = 52%**，Wilson 95% 区间 38.5%–65.2%；37 次预算停止。
- 外部 mini-SWE-agent 2.4.6 基线：**27/50 = 54%**，Wilson 40.4%–67.0%；22 次预算停止。
- 上下文参考臂：**28/50 = 56%**，Wilson 42.3%–68.8%；36 次预算停止。
- 上下文提议臂：**27/50 = 54%**，Wilson 40.4%–67.0%；34 次预算停止。

预声明的候选/基线配对单元格：两边都解决 24，仅候选 2，仅基线 3，都未解决 21；比率差 −2 个百分点，精确双侧 McNemar p=1。上下文参考/提议配对：两边都解决 26，仅参考 2，仅提议 1，都未解决 21；差 +2 个百分点，p=1。这些不一致计数很小，不能确立能力差异。

基线的 watchdog 在模型步之间检查。**22/50 个基线 episode 因最后一个响应超出共享的名义 token 上限**，而每条 mini-DSH 臂都是 0/50；基线最大值为 457,686 token，约超上限 9.8%。有一个超上限的基线 episode 被解决。冻结的敏感性规则剔除超上限的解决，分母仍保留全部 50 个任务：候选 **26/50**、基线 **26/50**、上下文参考 **28/50**、上下文提议 **27/50**。这是保守的敏感性读数，不替代官方分数。名义上限配置并不能保证实际消耗 token 完全对齐，所以 27/50 对 26/50 的主要比较不是干净的能力主张。

按冻结价格估算的 provider usage 成本为 **$3.618705108 已知 usage**，另有**一个 episode 在一次短暂的模型重试后精确 usage 未知**。这不是账单。最初的官方评分尝试被 Docker Desktop 中断；所有付费 episode 当时已保存。最终 `score3` 只在这些 patch 上、环境恢复后重新评分，没有再发出模型请求。最终报告是 `formal-report.json`（本地证据，未发布）；冻结的敏感性结果是 `formal-token-sensitivity.json`；排除工作区的紧凑最终归档是 `formal-evidence-final.tar.gz`（SHA-256 `fb58277adf09d9f303b80d23a811a0e24ccbae5d499a0e734da57122c52b40bd`）。完整原始证据仍在开发机上，未发布。隐藏评分行和评分日志属于本地证据，不用于发布。

## 开发观察（2026-10-21，n=5，仅候选臂）

- 计划 5 个 episode 执行了 5 个；0 基础设施失败，0 评分错误，0 未知 usage episode。
- 2/5 解决（`astropy__astropy-14539`、`pallets__flask-5014`）；2 个未解决；1 个空 patch（`matplotlib__matplotlib-23299`）。
- 4/5 episode 在单任务 token 上限处结束（`budget`）；1 个正常完成。已解决的 astropy patch 是在其预算停止前产出的。
- 按冻结峰值价格的 provider usage 估算：整批 **$0.0918**（单任务上限 $0.50，批次上限 $2.50）。Token：输入 1,565,239，输出 41,522，缓存读取 1,454,464；主动时间 8m38s。
- 2/5 的 Wilson 95% 区间为 11.8%–76.9%。n=5、单臂且没有同模型基线，这是**开发诊断**，不是成功率主张。预算停止频率说明 $0.50 的单任务上限对该子集偏紧；正式批次前应重新审视。
- 证据：本地开发批次目录（未发布）；`score.*.log` 和隐藏测试行不用于发布。

## 四臂开发观察（2026-10-21，n=5，仅描述）

四臂开发批次运行了 20/20 个计划 episode，0 基础设施失败、0 评分错误、0 未知 usage episode；估算 provider 成本 **$0.471**，主动时间 45m40s。

| 臂 | 解决 / 计划 | 预算停止 | 正常完成 | 估算成本 | 输入 token | 输出 token | 缓存读取 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 候选（mini-dsh） | 2/5 | 3 | 2 | $0.092 | 1,628,394 | 38,290 | 1,505,024 |
| 基线（mini-SWE-agent 2.4.6） | **3/5** | 0 | 5 | $0.201 | 5,410,255 | 100,280 | 5,245,696 |
| 上下文参考 | 2/5 | 4 | 1 | $0.089 | 1,586,976 | 38,591 | 1,474,560 |
| 上下文提议 | 2/5 | 4 | 1 | $0.089 | 1,627,696 | 35,035 | 1,501,440 |

- 唯一的臂级差异是一个任务：`django__django-12273` 被基线解决，三条 mini-DSH 臂未解决。候选/基线配对：都解决 2，仅基线 1，仅候选 0，都未解决 2；精确 McNemar p=1。上下文两臂在五个任务上完全相同（都解决 2，都未解决 3，p=1）。**n=5 无法支撑能力主张。**
- **本次观察没有建立预算对齐。** mini-DSH 各臂撞上由 $0.50 单任务上限换算出的 token 上限（约 416k 输入+输出 token），而基线 `cost_limit` 为 $0.50 时，由于大部分输入是缓存命中，每个 episode 可用约 1.1M 输入 token。因此基线的有效 token 额度更大；3/5 对 2/5 的差异被预算策略混杂，不是干净的能力比较。2026-10-21 选择并实现了 **共享 token 上限** 策略：外部 watchdog 和运行后检查都使用与候选臂相同的 `tokenCapFromUsd(perTask.maxCostUsd, prices)` 值（按这些价格，$0.50 对应 416,667）。上述观察早于该变更；正式批次前仍需一次共享上限下的四臂开发观察。
- 证据：本地四臂开发批次目录（未发布）；评分日志和隐藏测试行不用于发布。首次尝试因基线 venv 缺少 `mcp` 依赖而在任何基线模型调用前中止；该事故及其 $0.0175 的仅候选花费单独记录在 CHANGES。

## 共享 token 上限的四臂开发复跑（2026-10-22，n=5，仅描述）

在源码提交 `309af44`，同样的五个开发任务和四臂日程运行了 20/20 个 episode，共享的名义上限为由 $0.50 单任务上限换算出的 416,666 token。官方评分完成，0 评分错误、0 基础设施失败、0 未知 usage episode。估算 provider usage 为 **$0.373505046**，对应另行授权的 $10 批次配置上限。候选解决 **1/5**，mini-SWE-agent 基线 **2/5**，两个上下文臂各 **1/5**。每臂都有四次预算停止和一次正常完成。候选/基线配对：都解决 1，仅基线 1，仅候选 0，都未解决 3（精确 McNemar p=1）；两个上下文臂解决的是同一个任务。这仍是开发诊断，不是能力主张。

基线 watchdog 应用同样的名义 token 上限，但在模型步之间检查轨迹。全部四个基线预算停止 episode 都因最后一个响应超限：输入+输出 token 总量为 427,115 到 453,214，最多超出 416,666 的 8.8%。候选最大值为 403,611。有一个超上限的基线 episode（`astropy__astropy-14539`）被解决，所以名义上限对齐并**不能**证明实际消耗 token 对齐。正式报告必须给出每臂超上限计数，以及排除超上限解决的敏感性读数；任何能力解释都必须保留这一限制。

首次官方评分尝试失败，是因为干净的 WSL 运行脚本没有把 SWE-bench Python venv 放进 `PATH`；它没有产生额外模型调用。一次 `--resume` 通过确认全部 20 个付费 episode 已存在，然后用固定 venv 只重新评分这些已保存的 patch。六项顶层证据校验和全部通过。证据：本地开发证据目录（12 MB，不含工作区；未发布）；完整原始证据仍在本地 WSL 工作区，未发布。

## 已实现的内容

- `scripts/swebench/protocol.ts`：按仓库分层的种子选择；开发/正式分离；gold 字段脱敏与拒绝；确定性的臂交错日程；配置上限预算；官方预测校验；显式的主机→容器路径映射；episode 汇总在分母中保留基础设施失败、把未知成本单列；Wilson 区间、精确 McNemar 与配对四格统计。
- `scripts/swebench/preregister.ts`：写入一个包含两个批次的 `swebench-run-manifest`，包括排除项、臂、上限、提示模板、价格快照和镜像摘要。在每个必填字段齐全**且**传入 `--finalize` 之前，它都是 `draft`；runner 拒绝 draft。
- `scripts/swebench/run.ts`：每个 episode 复用 `createHarness`，应用单任务的请求/工具/时间/输出/token 上限，保存 `events.jsonl`、终止状态、usage 和 patch（包括空 patch）；遇到基础设施失败或未知 usage 时停止批次；支持批次级 `--resume` 且不重跑已完成 episode；用每批次新的 `run_id` 独立评分预测。
- `scripts/swebench/workspace.ts`：离线测试用的 fixture 工作区，以及官方镜像工作区路径——它沿用无模型 PoC 接受的同一组约束（固定摘要、与数据集 base 的内容校验、`--network none`、只读根、一个可写 `/testbed` 挂载、无特权、主机 uid/gid）。
- `scripts/swebench/report.ts`：从 `runs.jsonl` 和 `scores.json` 重算报告；报告计划/执行分母、每臂 Wilson 区间、声明的配对单元格、失败分类计数和三条预声明的失败轨迹。
- `scripts/swebench/{external-contract,external,external-run,external-fingerprint}.ts`：外部臂契约、单行数据集/配置生成、与候选同构的容器参数、进程超时/watchdog、按标签清理容器、轨迹/预测解析、provider usage/成本归一化、密钥扫描和冻结的安装指纹。
- `scripts/swebench/external-probe.ts`：外部基线的零模型验收探针。
- `scripts/swebench/run.ts`：把 `system: 'external'` 分派给外部执行器，在创建证据前预检安装指纹和 Docker 镜像，并把外部 patch 交给同一个独立评分器。
- 测试：`test/swebench-protocol.test.ts`、`test/swebench-preregister.test.ts`、`test/swebench-run.test.ts`、`test/swebench-external.test.ts`（脚本化模型、fixture 工作区、伪外部 runner、模拟独立评分、空 patch、基础设施停止、未知 usage 停止、resume、draft/gold 拒绝、命令模板、数据集白名单、usage/状态解析）。

### 镜像环境提交

官方镜像可能在数据集 base 之上提交一次环境变更。工作区接受这样的镜像：内容**只**在少量仅含构建元数据的文件上有差异（`pyproject.toml`、`setup.py`、`setup.cfg`、`requirements*.txt`、`environment.yml`、`Pipfile*`、`poetry.lock`、`tox.ini`；最多 8 个路径）。该 episode 随后从镜像 HEAD 开始，并基于同一 HEAD 导出 patch，因此 Agent 和官方评分器看到同一棵树。证据记录 `imageHead`、数据集 `baseCommit`、生效的 `patchBase` 以及差异路径。任何新增/删除路径、任何源码路径变更或更大的 diff 仍会在 Agent 启动前被拒绝。首个观察到的案例是 `astropy__astropy-14539`，其镜像在 `pyproject.toml` 中固定 `setuptools==68.0.0`。

### 同模型外部基线（mini-SWE-agent）

外部臂运行**未修改**的 mini-SWE-agent 批次 CLI；仓库不分叉它的提示、工具 schema、Agent 循环或模型客户端。

- **固定版本：** `mini-swe-agent==2.4.6`，git 提交 `a83fcae82d2a08f0ee0c688f9d137b3566c097f8`。manifest 记录版本、上游配置 SHA-256 和九个已安装文件的哈希（Agent 循环、提示/配置、Docker 环境、LiteLLM 模型、SWE-bench 入口点）。`--verify-baseline` 填充它们；runner 在任何 episode 前重新计算。
- **命令：** 冻结的 argv 模板，占位符是完整元素：
  `["{python}","-m","minisweagent.run.benchmarks.swebench","--subset","{dataset}","--split","test","--output","{output}","--workers","1","--redo-existing","-c","{upstream_config}","-c","{config}"]`。提供 `-c` 会禁用内置默认配置，因此固定上游配置和每 episode 覆盖都会传入。数据集生成为一行脱敏数据加摘要固定的 `image_name`；绝不包含 `test_patch` 或其他隐藏字段。
- **沙箱：** 基线从同一镜像启动自己的容器，隔离配置与候选一致：`--network none`、只读根、主机 uid/gid、一个可写 `/testbed` 绑定挂载、`--cap-drop ALL`、no-new-privileges、`bash -lc`、30 秒命令超时。provider key 只存在于主机进程；`forward_env` 为空，每个带标签容器的环境在清理前都会被检查。容器带有 `mini-dsh.external.*` 标签，按标签删除，绝不按 mini 的随机名称删除。
- **提示/上下文：** 使用 mini-SWE-agent 原生提示、单个 bash 工具和线性上下文。因此候选对基线是**系统级**比较，不是隔离的提示或上下文因素。
- **限制：** `step_limit` = 单任务模型请求数，`cost_limit` = 单任务美元上限（LiteLLM 估算），`wall_time_limit_seconds` = wall clock，`max_tokens` = 输出上限。实时轨迹 watchdog 在步之间执行成本/请求/动作/时间边界；硬进程超时是 wall clock 加两分钟。规范成本从 provider usage 和冻结价格快照重算，不来自 LiteLLM。基线动作数没有直接按候选的 `maxToolCalls` 设限；报告会说明这一限制。
- **结局：** patch 只来自 `preds.json`；工作区 diff 仅用于诊断。状态映射 `Submitted`→完成，`LimitsExceeded`/上下文窗口→预算，`TimeExceeded`→超时，认证/权限/未知→基础设施。缺失 usage 绝不按零填充，并会停止计费批次。提交的空 patch 仍留在分母中。
- **零模型探针：** `swebench:external-probe` 运行真实 CLI + 数据集 + 配置 + Docker + `DeterministicModel`，断言 `Submitted`、空 patch 或已提交 patch 的解析、带标签容器清理以及容器内没有 provider key。2026-10-21 的探针以空 patch 和带非空 `README.rst` patch 通过。证据：本地探针目录（未发布）。
- **冻结的四臂 manifest：** `manifest-frozen.json`（本地，未发布；schema 3，20 个开发 episode + 200 个正式 episode，外部字段齐全，`freezeStatus: frozen`，`paidRequests: 0`，$110 配置上限）。共享上限复跑使用另行冻结的 $10 开发 manifest（`manifest-development.json`）；正式分片在 `manifest-formal.json` 中另行冻结为 $100 批次配置上限。两者都保留原始任务选择和日程。正式执行仍需要本地具备全部 50 个固定镜像，并另行获得付费授权。更早的 `manifest-draft.json` 作为冻结前记录保留。

## 首个 PoC 的冻结材料

- 数据集修订版 `c104f840cc67f8b6eec6f759ebc8b2693d585d4a`；500 行 parquet 的 SHA-256 为 `a45b1fe4e2f0c8390b2b2938ac83e92ed5979000856808f3679c07812e9e6dcd`。
- 官方 harness v3.0.17 提交 `3f01bd622c0a22c00406139f69a234ef08225f22`。
- 实例 `sympy__sympy-20590`；镜像 `swebench/sweb.eval.x86_64.sympy_1776_sympy-20590@sha256:3a282752833ce34730ee0621e22033501c993f45742775ca57f04c9ff27178a0`。
- 本地数据集和官方 harness checkout 保留在开发机上，不随仓库发布。

## 已验证的无模型证据

手动 [CI run 39395532729](https://github.com/BeforeLanding/mini-DSH/actions/runs/39395532729) 在提交 `f52699c` 上通过了全部七个 job。候选证据（本地 CI 产物，不随仓库发布）：

- 镜像 HEAD `5efaed…` 对数据集 base `cffd4e0…`：1828 个路径内容相同；1758 个仅因 `100644→100755` 模式不同；原始 diff 对象变化为 0。内容、新增/删除路径或类型变更仍会被拒绝。
- 主机 `write_file` → 容器 Bash 和容器 Bash → 主机 `read_file` 均可见；路径逃逸被拒绝。
- `network=none`，仅挂载 `/testbed`，只读根，无特权，主机 uid/gid；**provider 请求 0**。
- 候选 patch 在新的官方 run 中评分：1 提交 / 1 完成 / 1 解决 / 0 错误；无残留容器。两次独立的 gold run 也都解决。

更早的官方通道 run [39387381791](https://github.com/BeforeLanding/mini-DSH/actions/runs/39387381791) 作为通道检查，用不同 run ID 对 gold patch 评分两次。Gold patch 仅用于评分通道探针，绝不进入 Agent run。

这证明了候选工具路径、patch 导出和独立评分通道。它**不**证明模型能力，也不证明所有任务的环境等价。

## 可审阅的零成本草案（未冻结）

预注册的一次真实数据集运行在无模型调用、无 Docker 的条件下产出：

- 脱敏数据集（本地产物，未发布）：500 行；仅 `instance_id`、`repo`、`base_commit`、`version`、`environment_setup_commit`、`problem_statement`；不含 gold/隐藏字段。
- 仅候选的历史草案 manifest（本地产物，未发布）。
- 冻结的四臂 manifest（本地产物，未发布），schema 3，`seed=20261020`，开发 5，正式 50，11 个仓库，4 臂，200 个正式 episode + 20 个开发 episode；全部外部字段齐全（`mini-swe-agent` 2.4.6、配置/安装哈希、模型 `deepseek/deepseek-flash`、`candidate-isolation-v1`）；在 $0.50/任务/臂下预算上限 $110.00。这是配置上限，不是预期花费。
- `freezeStatus` 为 **frozen**，`paidRequests: 0`。共享上限的开发复跑和另行授权的 $100 上限正式批次记录在上方。manifest 本身不授予授权；用户分别授权了两个付费批次。若未来批次修改单任务预算，应重新冻结，而不是编辑冻结文件。

价格快照结构固定，值必须来自带采集日期的官方来源：

```json
{ "currency": "USD", "inputUsdPerMillion": null, "cachedInputUsdPerMillion": null,
  "outputUsdPerMillion": null, "capturedAt": "YYYY-MM-DD", "source": "official price page URL" }
```

把每个 `null` 替换为观测值；校验器拒绝缺失或非 USD 价格。

## 历史执行前提（正式批次已满足）

- 冻结的 50 任务选择和每个实例的镜像摘要。当前 `preregister` 输出会列出缺失的摘要；它不会自行编造。
- 本机已安装固定版本的 mini-SWE-agent，并具备全部任务镜像。外部预检会重新计算版本/配置/安装指纹，检查 provider key 的**名称**、Docker/uid，并对计划中的摘要运行 `docker image inspect`；任一不满足都会在创建证据前拒绝。预检不会隐式拉取镜像。
- 带官方来源和采集日期的价格快照。没有它，runner 拒绝付费执行，并且绝不用零填充未知 usage。
- 共享上限的四臂开发观察已完成；其基线单响应超限必须继续出现在正式报告和敏感性读数中。
- 官方 harness v3.0.17 必须已安装在 runner 使用的 Python 环境中（`python -m swebench.harness.run_evaluation`）；runner 不负责安装或升级它。
- 单独的隐藏行文件，包含 `test_patch` 和 `FAIL_TO_PASS`/`PASS_TO_PASS`，通过 `--scoring-dataset` 传入。50 个正式行已从 SHA-256 为 `a45b1fe4…` 的数据集生成；本地隐藏行文件的 SHA-256 为 `db26064f…`，未发布。Agent 数据集保持脱敏；runner 会拿每条评分行与冻结的 repo/base 校验，并只把隐藏行写入临时目录供官方评分器使用，绝不放进证据树。
- 对付费模型调用及任何新增云/计算资源的明确用户授权。manifest 记录 `paidRequests: 0`；它不授予授权。用户分别授权了开发复跑和 200 episode 正式批次。

## 命令

```sh
# 离线端到端验收（脚本化模型、fixture 工作区、模拟评分器；无密钥、无 Docker、无网络）
pnpm build
node --test dist/test/swebench-run.test.js

# 冻结协议（先写草案；齐全后才加 --image-digests 和 --finalize）
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

# 零模型外部基线探针（真实 CLI + Docker + DeterministicModel；无 provider 请求）
pnpm swebench:external-probe -- --manifest outputs/run-manifest.json --split development \
  --instance <instance-id> --python /path/to/venv/bin/python --out outputs/external-probe --execute

# 执行一个批次（需要明确批准的上限；任何模型调用前先做草案检查）
pnpm swebench:run -- --manifest outputs/run-manifest.json --dataset verified-sanitized.json \
  --scoring-dataset scoring-rows.hidden.json --external-python /path/to/venv/bin/python \
  --evidence-root outputs/swebench-<batch> --split development --backend docker --scoring official \
  --batch-id <batch-id> --execute

# 恢复已停止的批次，不重试已完成或已中断的 episode
pnpm swebench:run ... --evidence-root outputs/swebench-<batch> --resume --execute

# 从原始证据重算报告
pnpm swebench:report -- --evidence-root outputs/swebench-<batch>
```

manifest 中的预算是**上限**：`正式任务数 × 臂数 × 单任务上限 + 开发批次 + 计算预留`。它不是“任何任务都会在上限内解决”的估计。单任务成本上限会按三个单价中最高者换算为保守的总 token 上限；实际成本随后只从 provider usage 估算。
