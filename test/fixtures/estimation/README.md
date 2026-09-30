# 输入估算误差语料（NX-08c）

这 40 个样本用于测量 `src/core/token-estimator.ts` 的输入估算与 DeepSeek 官方 tokenizer 的偏差。它不参与生产逻辑，也不调用模型 API。

## 语料

`corpus/<类别>/<名称>.txt`，四类各 10 个。样本是 Harness 实际会处理的文本，不是为凑比例生成的随机串。

- `chinese`：8 个来自 [编程任务 fixture](../coding/) 的 `TASK.md`（Harness 收到的真实任务文本），2 个来自 [README](../../../README.md) 与 [PLAN](../../context-budget/PLAN.md) 的连续段落。中文占比 53%，其余是标识符、路径与标点，和真实任务描述一致。
- `english`：10 个代表性英文输入——任务描述、缺陷报告、堆栈跟踪、代码评审、规格、提问、变更日志、验收标准、API 文档、邮件往来。本仓库内没有足量英文自然语言，这 10 个是为此编写的代表样本。
- `code`：10 个本仓库源码与 fixture 代码的原样拷贝（估算器自身、预算、有界读取/搜索、上下文运行时、可靠编辑、事件契约、评测运行器、fixture 源码与验收器）。代码样本共 32 KiB，是四类中体量最大的一类。
- `schema`：10 个结构化载荷——根 `package.json`、`tsconfig.json`、fixture 的 `package.json`、运行期实际下发的工具 schema 数组及其两个片段（`bash`、`request_trace`）、一次真实离线运行采集到的工具结果数组、以及一个 JSON Schema 与一个 OpenAPI 片段。

`code` 与 `schema` 中的拷贝是按内容固定的快照：源文件后续变化不会自动同步，因为参考 token 数是与这份文本绑定的。

## reference.json

`reference.json` 记录用官方 tokenizer 对上述语料测量得到的 token 数，以及测量时的来源：

- `tokenizer`：DeepSeek 文档提供的离线 tokenizer 包（`https://cdn.deepseek.com/api-docs/deepseek_v4_tokenizer.zip`），记 `tokenizer.json` 的 SHA-256、词表大小与工具版本。
- `estimator`：被测量的估算器文件及其 SHA-256。摘要变化表示估算器已改，`reference.json` 里的结论不再对应它。
- `corpus`：语料摘要（按 `id` 排序后对 `id\0正文` 拼接取 SHA-256）与样本数。
- `counts`：每个样本的字符数、ASCII 字符数与参考 token 数。

计数一律用 `add_special_tokens=false`，即只统计正文本身，不含 chat 模板与 BOS。

## 复现测量

`pnpm eval:estimate` 会用已提交的 `reference.json` 现算估算值并打印分布，不需要 Python。只有需要**重新测量参考值**（改动语料，或换用新的 tokenizer 包）时才需要下列步骤：

1. 下载并解包官方 tokenizer：

```powershell
curl -sSL -o tok.zip https://cdn.deepseek.com/api-docs/deepseek_v4_tokenizer.zip
unzip tok.zip
```

2. 用 Python 与 `tokenizers` 读取 `tokenizer.json` 并对语料逐样本计数，把结果写回 `reference.json`，同时更新 `tokenizer.sha256`、`estimator.sha256`、`corpus.sha256` 与 `verifiedAt`。

**必须走 `tokenizers.Tokenizer.from_file`，不要用官方 zip 里示例代码的 `transformers.AutoTokenizer.from_pretrained(dir, trust_remote_code=True)`。** 实测后者在该包上得到 `LlamaTokenizer`，对非 ASCII 返回空 id——`encode("修复索引边界问题")` 得到 `[]`，把中文算成 0 token；同一段文本在 Rust 路径下可完整往返，且中文比例与官方文档给出的 0.6 一致。

## 已知限制

- 只测字符级估算，不含 chat 模板开销。该包自带的 `chat_template` 完全不引用 `tools`（模板全文 0 次出现），用它渲染出的文本不含工具定义，而真实请求里工具 schema 占载荷字符的一半以上。因此这里**没有**端到端的真实请求 token 参考值，PLAN「官方依据」里"官方离线 tokenizer 与当前聊天模板的一致性尚未验证"一条由此得到证实而非假设。
- 样本量是每类 10 个，足以看出方向与量级，不足以给出稳定的尾部分位数。
- 参考值绑定在 2026-09-30 的 tokenizer 包上；官方更新 tokenizer 后需要重新测量。
