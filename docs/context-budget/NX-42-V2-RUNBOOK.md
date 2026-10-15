# NX-42 V2 运行与证据手册

本仓库现在有20道正式题、5道独立校准题、四组配置、隔离执行、冻结清单和报告器。当前没有真实模型读数；`eval:v2 --plan-only`的清单、脚本模型的通过率和合成统计用例均不能当作Baseline/Full的成功率。

## 离线准入

在Windows工作树准备依赖与WSL Ubuntu的固定Node运行时。按[隔离说明](NX-42-V2-ISOLATION.md)设置`MINI_DSH_V2_RUNTIME`；正式候选Bash必须在bubblewrap中，评测器在宿主运行隐藏验收。先跑`pnpm check`、`pnpm test`、`pnpm lint`、`pnpm fixtures:check`、`pnpm eval:offline`，以及正式/校准两份`pnpm eval:v2 -- --split ... --tier 2m --window <真实模型窗口> --evidence-root <不存在的目录> --plan-only`。若本机pnpm引导受限，按AGENTS规则用`node scripts/build.js`、`node scripts/check-syntax.js`、`node --test dist/test/*.test.js`、本地Biome二进制及对应dist脚本复核，明确记录差异。

## 校准与冻结

一次付费批次必须先选定精确模型ID、供应商回显标签、`thinking`、API端点、真实上下文窗口，并从供应商当时的价格页保存来源和时间；`priceSnapshot`需要`source`、ISO `capturedAt`、`currency: "USD"`、`inputPerMillion`、`outputPerMillion`、`cacheReadPerMillion`，不得填零价占位。把这些字段连同`split`、`tier`、`window`、`model`、`echoedModel`、`thinking`、`sampling: "provider-default"`、`baseUrl`写入工作树外的单独JSON配置文件；适配器当前不发送temperature或seed，不能声称解码已固定。旧批次中`deepseek-v4-flash`的回显标签是`deepseek-flash`，新批次须重新探测核对。校准只需Baseline/Full，每档5题×2臂×2次=20 episode；按[预注册方案](NX-42-EVAL-V2-PLAN.md)先看2M档，仅在其9～10次Baseline成功时才考察1M，失败或机制不足按方案封存。正式批次必须使用校准选定档，20题×4臂×3次=240 episode，不因中途成功率提前停止。

提交全部源码与题目后，在干净工作树运行`pnpm eval:v2-freeze -- --config <配置JSON> --output <新manifest.json>`。冻结命令拒绝脏工作树和覆盖旧文件；manifest记录完整题目、隐藏验收输入、四组策略、顺序、代码/提示/规则hash、Git提交及价格快照。用`pnpm eval:v2-run -- --manifest <manifest.json> --validate-only`零付费复核冻结文件及WSL隔离，再申请批次授权。任何文件变化须重新冻结并作为新版本报告。

## 付费批次边界

取得**该批次单独的金额授权**后，运行`pnpm eval:v2-run -- --manifest <manifest.json> --evidence-root <新目录> --max-usd <授权美元上限> --execute`。脚本在模型调用前检查配置、未占用证据目录、固定WSL候选隔离和可读取的凭证；两次小型模型协议探测记入证据。金额上限按当前价格的最贵token类别为一个完整配对block预留保守额度，不够下一block时停止并标为incomplete。异常证据或模型回显不符立即停止；网络请求被中断而未留下provider usage时，token推算费用可能低于实际账单，须对照供应商账单。正式批次金额与授权在校准实耗后另行确定，不能沿用校准授权。

每个episode保存独立session、四阶段快照和候选退出后的验收读数；`runs.jsonl`逐行落盘，`manifest.json`、`probe.json`、`report.json`共存于新证据目录。未运行的episode保留固定计划分母和成功率范围，不能写成已经执行的失败。单独重生报告用`pnpm eval:v2-report -- --manifest <manifest.json> --runs <runs.jsonl> --output <新report.json>`，输出拒绝覆盖；报告的`observationsDigest`钉住输入记录顺序。报告对结构化数据能分出已执行工具错误与跳过，但当前事件没有独立的“策略/参数拒绝”分类，也无法可靠把预期失败测试与意外命令错误拆开，这两项按未知披露，不赋零值。
