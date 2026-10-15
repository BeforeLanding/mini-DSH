# 交易日志格式

每行一个JSON对象：`{batch, kind, amountCents}`。`kind` 为 `sale` 或 `refund`；sale金额非负，refund金额**已经带负号**，因此净额是所有 `amountCents` 的代数和。同批次可交错出现，汇总按 batch 名升序输出 `{batch,totalCents}`。不允许改变输入行对象。
