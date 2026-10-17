# NX-44 smoke-v2 repair：零付费限定回放

2026-10-17，在 `98c8971` 的干净工作树开始；原始 `live/repair/recording.jsonl`、`replay-audit.json`、真实 session 事件和原 smoke 结论保持原样。证据位于 `D:/Agent/outputs/mini-dsh-repair-smoke-evidence-v2-20261017/`；本次新增 `replay-limited-audit.mjs`、`replay-limited-audit.json`、`replay-limited/`，不覆盖先前停在第 5 次请求的审计。

## 比较边界

采用 **B：限定字段指纹归一化**。只有关联到 `bash` tool call 的结构化 `command` 结果，才能把 `cwd` 从已登记的原 fixture 根与本次恢复 fixture 根映射到同一标记；子目录必须保留相同的工作区相对路径。`durationMs` 在指纹比较副本中置为同一值，原录制和回放 session 各自的实测值保留。其余模型请求文本原样比较，包括 Bash 命令、退出码、stdout/stderr 的文本、字节数和截断标记、状态、超时、取消、signal、工具调用参数及系统提示。录制请求自身的原始指纹也先重算校验。格式含糊、未登记根、额外请求均拒绝，无真实 API 后备。

因此结论是**限定归一化后的完整 Harness 回放**，不是模型可见文本字节一致回放。它验证在上述两个环境字段之外的请求内容、工具结果语义、六个录制响应的顺序、停止状态与退出候选一致；它不验证两次 Bash 执行耗时相等，也不证明这两个模型可见字段的原始字节相等。

反例测试覆盖 stdout、exitCode、命令文本与调用参数、超时、取消、截断、工作区相对路径及根外 cwd；这些变化均在提供响应前拒绝。仅根目录变化、仅耗时变化以及两者同时变化通过。

## 真实六轮与结果

真实 session 的第 3 轮执行 `edit_file`；第 4 轮运行 `node check.mjs`，公开检查退出 0；第 5 轮自写检查错误地断言组合价格为 27，实际为 25.2，退出 1；第 6 轮把预期改为 25.2，独立边界检查退出 0。随后因 **6 次主请求上限**在派发前停止，runStatus 为 `max_steps`，没有 `completed`。这是一次有限六轮轨迹，额外回放验证不构成模型无限循环或新一轮真实调用。

新隔离 fixture 恢复 hash `4d693e9adf9cfa437fe95ab74a6ff46d4ed07ce2242632bfe5259cc9c66e6028`；首分歧 **无**；消费 **6/6 主响应、0/0 摘要**，录制流全部消费。退出候选 `src/cart.mjs` 的 SHA-256 与真实退出候选同为 `967728a506d88c31b1d9e491ce01bec148491bbd7cd64273538f0f9accee503b`；独立验收 **passed**，`runStatus=max_steps`、`evidenceStatus=saved`。恢复出的 session 有 11 个工具开始事件，未知副作用 0。原录制的 `postrun-audit.json` 已对六条 start/end、指纹及 provider usage 作独立审计；本次不改其结论。

## 账本与验证

- 本次实际网络模型请求 **0**，新增模型费用 **$0**。回放 adapter 无 provider 引用，超出录制次数只在本地预派发拒绝。
- 已消费的 **6** 是录制响应数。原录制 provider usage 为输入 30,802、输出 2,866、合计 **33,668 token**；按当时峰时价格估算的**历史费用**为 `$0.012265848`。`amountGuard` 在回放读到同一个 `$0.012265848`，只是**模拟记账**，不代表本次实际消费。
- `node scripts/build.js`、`node scripts/check-syntax.js` 通过；定向回放测试 6/6；正常用户权限完整离线测试 **390 通过、30 跳过、0 失败**。沙箱内 WSL 被拒时 Bash 结果退出码和 stdout 不同，适配器在第 5 次请求正确拒绝；改在正常用户权限下重跑同一零网络脚本后全程消费。

## 下一版两臂探索建议（未执行）

建议 Baseline 与 Full 两臂对**每个完整 episode 使用相同的 1M 总 token、64 次模型请求、128 次工具调用、600 秒主动时间**，摘要也计入同一额度；相同题目、模型、权限、验收与价格快照，分臂报告预算停止和实际用量。依据：此前 2M 校准 Baseline 10/10、Full 6/10，Baseline 接近天花板；后续 1M 校准 Baseline 5/10、Full 4/10，Full 9/10 次实际触发主动机制，既保留难度也能观察机制。两次批次和模型版本并非同版可合并的效果估计，这只是下一版探索的统一资源建议；金额上限需按新价格和计划 episode 数另行估算及授权，不在本次执行。
