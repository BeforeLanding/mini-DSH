# SWE-bench Verified 子集：预注册与执行适配器

**主分支状态（2026-10-28）。** PR #12 的四臂外部执行器和正式实验结果已从 main 撤回，完整实现和结果仅保留在 [feat/swebench-formal-results](https://github.com/BeforeLanding/mini-DSH/tree/feat/swebench-formal-results)。本页保留合并前的预注册、候选工作区和零模型评分通道说明；下文草案与限制描述该旧版实现，不代表实验从未执行。

**展示边界。** 本页的协议与零模型通道验证不是能力分数；README 不展示模型评测结果。

## 已实现的内容

- `scripts/swebench/protocol.ts`：按仓库分层的种子选择、开发/正式分离、gold 字段脱敏与拒绝、确定性的臂交错日程、配置上限预算、预测校验与主机到容器路径映射；汇总保留基础设施失败分母和未知成本，计算 Wilson 区间、精确 McNemar 与配对四格统计。
- `scripts/swebench/preregister.ts`：写入包含两个批次、排除项、臂、预算上限、提示模板、价格快照和镜像摘要的 manifest。必填字段齐全且显式传入 `--finalize` 后才可冻结；执行器拒绝草案。
- `scripts/swebench/run.ts`：复用 `createHarness`，应用单任务预算，保存事件、终态、usage 和 patch；基础设施失败或未知 usage 时停止；支持不重跑已完成 episode 的续跑与独立评分。
- `scripts/swebench/workspace.ts`：提供离线 fixture 与官方镜像工作区，保留固定摘要、数据集 base 内容校验、禁用网络、只读根、单个可写挂载、无特权和主机 uid/gid 等约束。
- `scripts/swebench/report.ts`：从原始运行与评分记录重算报告，保留计划/执行分母、各臂区间、配对结果、失败分类和预声明失败轨迹。
- 测试：协议、预注册与批次执行离线测试，覆盖脚本化模型、模拟评分、空 patch、基础设施失败、未知 usage、续跑以及草案/gold 拒绝。

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

- 脱敏数据集：500 行，仅包含 `instance_id`、`repo`、`base_commit`、`version`、`environment_setup_commit`、`problem_statement`，不含 gold 或隐藏评分字段；本地产物未发布。
- 历史草案 manifest：开发 5 任务、正式 50 任务，11 个仓库、4 臂，计划 200 个正式 episode 和 20 个开发 episode；每任务每臂 $0.50 时配置上限为 $110，不是预期花费。
- 本分支的旧版草案标记为 `draft`、`paidRequests: 0`，仍需填写候选模型、价格快照、同模型基线提交/命令和逐实例镜像摘要。正式冻结与已执行实验记录见独立 SWE 分支。

价格快照结构固定，值必须来自带采集日期的官方来源：

```json
{ "currency": "USD", "inputUsdPerMillion": null, "cachedInputUsdPerMillion": null,
  "outputUsdPerMillion": null, "capturedAt": "YYYY-MM-DD", "source": "official price page URL" }
```

把每个 `null` 替换为观测值；校验器拒绝缺失或非 USD 价格。

## 本分支旧版执行器的限制

- 执行前须具备冻结的任务选择、逐实例镜像摘要，以及带官方来源和采集日期的价格快照；未知 usage 不按零处理。
- 同模型 mini-SWE-agent 的提交与命令属于 manifest 契约，但本分支旧版批次执行器拒绝 `external` 臂。完整外部适配器仅保留在独立 SWE 分支。
- `--finalize` 要求开发批观察和预算确认已完成，不能仅填参数便宣称协议冻结。
- 官方 harness v3.0.17 须事先安装；执行器不自动安装或升级。
- 付费模型调用和新增计算资源须另获明确授权，manifest 不授予授权。此次撤回不发出模型请求。

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
  --prices prices.json --baseline-commit <mini-swe-agent-commit> \
  --baseline-command '["<baseline>","<args>"]' \
  --per-task-cap-usd 0.5 --batch-cap-usd <approved-cap> \
  --out outputs/run-manifest.json

# 执行批次（需要明确授权的预算上限；模型调用前先检查草案）
pnpm swebench:run -- --manifest outputs/run-manifest.json --dataset verified-sanitized.json \
  --evidence-root outputs/swebench-<batch> --split development --backend docker --scoring official \
  --batch-id <batch-id> --execute

# 恢复已停止的批次，不重试已完成或已中断的 episode
pnpm swebench:run ... --evidence-root outputs/swebench-<batch> --resume --execute

# 从原始证据重算报告
pnpm swebench:report -- --evidence-root outputs/swebench-<batch>
```

manifest 中的预算是**上限**：`正式任务数 × 臂数 × 单任务上限 + 开发批次 + 计算预留`。它不是“任何任务都会在上限内解决”的估计。单任务成本上限会按三个单价中最高者换算为保守的总 token 上限；实际成本随后只从 provider usage 估算。
