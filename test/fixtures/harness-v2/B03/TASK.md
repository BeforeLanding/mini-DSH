# 从多批次交易日志定位局部汇总错误

文件范围：仅可修改以下已有文件：`src/aggregate/ledger.mjs`；其他已有文件（包括 package.json、规格和公开检查）不得修改。

`logs/batches.ndjson` 混合多个批次的 sale 与 refund；结算系统提供每批次的净额。当前 `summarizeBatches(lines)` 对一部分批次的汇总与结算不一致。请结合 `docs/FORMAT.md`、日志和模块链定位，修复 `src/aggregate/ledger.mjs`。退款日志的 `amountCents` 已经是负数；空输入返回空数组，输出按 batch 升序且与输入顺序无关。不能只针对日志里的特定批次ID硬编码，也不能改变其他批次正确结果。可正常使用搜索、聚合脚本和公开检查。
