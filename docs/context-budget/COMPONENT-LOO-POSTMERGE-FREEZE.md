# 组件逐项消融：合并后零付费重冻（2026-10-27）

状态：PR [#8](https://github.com/BeforeLanding/mini-DSH/pull/8) 已以 merge commit `54a1921962e42be5fd4e7dab23e71c02be0edf8b` 合并，六项 CI 全绿。新评测代码包含源码身份与双向质量差异检查。以该 main 为 full 臂重新冻结；三个回退臂在各自源码提交上应用相同评测修复。四份 `--validate-only` 均通过，48 条仅是计划，实际模型 episode 0、provider 请求 0。

## 本次冻结

- full：源码 `0b8b9736b7da181ade20d7a33dea480bd985aa46`；评测 `54a1921962e42be5fd4e7dab23e71c02be0edf8b`；digest `31b9b58387c32fe17ddb5d0657fd52266a2bd6b7db83b9eaa350e637bbebd2cb`。
- no-preview：源码 `38b4730315bdc93fe116a8e817d6ef0eac5627f3`；评测 `d27a016a39ad3139aa57912087c4bab069dc498c`；digest `22359059357399c196e40114682276f204334409a5c8cee04cba491621a91250`。
- no-projection：源码 `de7558cb95f7ca98d5d3497f6293ed2371fb6c5d`；评测 `8a9f5c2310b9228253708b8470f1b0fab5c152fc`；digest `8c54ba9dac165e2c833afae2db0db3fd2ed3420f376aaad1862f191f5844b313`。
- no-report：源码 `ddc04fc951edf3b567d9b19405e52f9b85a5aecd`；评测 `d3a8429cad3b3d306ac7fa04df21694c69fb4d46`；digest `5627852b418a0857291c4e27e654f51736f4c8347c454214064711457b841688`。

四臂 manifest 各 6 题、12 条、单 `context` 执行臂，显式 `postCompactionPrune=false`。规范化后的共同参数和全部非组件冻结文件逐字相同，tool schema 相同；各回退臂的源码哈希差异恰好等于协议声明的精确路径。`sourceBaseCommit` 到评测 HEAD 的 `src/**` 无差异，runner 再次检查。四次预检均报告 `isolation=wsl-bwrap`、`paidRequests=0`；仓库外 `D:\Agent\outputs\component-eval-postmerge-freeze-20261027\evidence\` 为空。

复用源码提交上已经产生的离线探针，确认 `sourceCommit` 与新 manifest 的 sourceBaseCommit 相同，套件哈希、case id 及投影/报告输出哈希一致。full 与回退臂的预览通过数 12/12→0/12，fullRecall 四臂 12/12；投影 propertyReads 32,982→2,284,323；报告 snapshotOpens 6→91。新评测 HEAD 的 check 与定向测试分别通过：full 14/14、no-preview 14/14、no-projection 15/15、no-report 15/15。

[机器记录](../samples/component-loo-postmerge-freeze-20261027.json) 包含四份 manifest 文件哈希、commit、tool schema、探针及日志 SHA-256、零付费验收布尔项。完整 config/manifest/probe/log 与只读审计脚本在上述仓库外目录；旧 [首次准备记录](COMPONENT-EVAL-CLOSURE.md) 仍按旧固定 HEAD 保留，不充作此次重冻结果。

## 模型、价格与金额

2026-10-27 从 [DeepSeek 官方模型与价格页](https://api-docs.deepseek.com/quick_start/pricing/)核对：`deepseek-flash` 回显模型版本为 `DeepSeek-V4.1-Flash-1017`，支持 thinking，窗口 1M；峰值每百万 token 为缓存命中输入 $0.006、未命中输入 $0.30、输出 $1.20。四份 manifest 共用新快照 `capturedAt=2026-10-27T12:51:07Z`。离线冻结没有发起付费模型探针；实际开跑仍须确认 provider 回显与 usage。

用 `developmentReserveUsd` 对 `context` 臂、每批 12 条按峰值价计算：每条储备 $1.7596608；12 条加协议探针储备 $21.1355904。拟定硬上限 **每批 $22，四批合计 $88**，按 `full → no-preview → no-projection → no-report` 依次执行。每批固定分母 12；任一批 incomplete、usage 未知或基础设施停批时不启动下一批。上述金额是预留上限，尚未获得本批付费授权；实际估价按 provider usage 重算，不冒充账单。

## 下一步

先确认 full 批的具体执行授权：模型 `deepseek/deepseek-flash`、thinking enabled、六题 `U02/B03/F01/F02/R04/T04` 各两次、12 条、单批最高 $22，证据目录另建于 `D:\Agent\outputs\component-eval-postmerge-freeze-20261027\evidence\full`。通过后再按同样预算和独立证据目录申请其余三批。复跑须重新授权，不能缩小分母或把不完整批次当作通过。正式模型效果、显著性与组件取舍要等 48 条真实观测后才报告。
