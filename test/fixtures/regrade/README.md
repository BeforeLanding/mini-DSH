# 历史重评分样本（ET-3）

每个子目录是一份可移植的历史产物样本：`case.json`（来源、逐文件 sha256、预期判决、标注）加 `sample/`（最小产物）。原始证据（如 batch-01）在仓库外，样本只取 `packages/*/src`、各包的 `index.mjs` 与 `package.json`，**不带 `.mini-dsh/` 下的工具输出**。`.gitattributes` 对本目录关闭换行转换，保证 sha256 在 Windows 检出后不变。

## 它证明什么、不证明什么

`pnpm eval:regrade`（也由 `test/eval-regrade.test.ts` 在 CI 中执行）把样本复制到临时目录，用**当前版本**的隐藏验收器评分，输出一条新的 grade 记录（样本摘要、验收器文件哈希、`verdict`、`reason`、逐子任务结果）。CI 的检查标准是“实际判决等于预期判决”，判出 `unknown` 视为未通过；原始样本与 `case.json` 不被覆盖。

- 证明：**grader 对这份旧产物的判决符合预期**。
- 不证明：新版 Agent 不再犯同样的错。涉及模型决策的变化，需另行授权真实模型复验。全程零模型调用。
- 不得为了让回归变绿而放宽 grader。

## 判决

只有 `pass / fail / unknown`；`unknown` 必带原因：

| reason | 含义 |
| --- | --- |
| `missing_evidence` | 缺少验收目标文件（样本文件缺失、`sample/` 缺失或验收目标缺 `src`） |
| `incompatible` | 样本布局或所声明的夹具与当前 grader 契约不匹配（夹具 id 未知、`case.json` 不符合 schema、样本字节与记录的 sha256 不一致） |
| `grader_error` | 验收器没有给出有效判决：无法启动、超时、脚本不存在，或启动后异常退出（语法错误、未捕获异常、依赖错误、退出 0 却没有验收标记）；不计为任务失败 |

有效判决只有两种：退出码 0 且输出约定的验收标记（pass），或非零退出且输出含 `AssertionError`（fail，即验收器的断言确实不成立）。其余一律是 `grader_error`，因此损坏的验收器不会让“预期失败”的回归检查变绿。

## 现有样本

- `batch01-parallel-composite-S-1`：`orchestration-four-arm-v1` 第一批 S 臂第 1 次（`parallel-composite:S:1`）。预期 `fail`，失败任务 `st-3`（先去重再列名）。标注 `spec-asymmetry; batch comparison not supported`：该批 S/D 拿不到 `names` 覆盖全部人员的规格（ET-2 已对此后批次补齐），所以这份 `fail` 只说明 grader 判决如旧，**不能用来比较该批各臂**。

## 支持范围

本期只支持编排夹具类样本（`case.fixture` 须是 `orchestrationFixtureIds` 之一）。V2 评测已有阶段快照，可以作为后续样本来源，本次不接。
