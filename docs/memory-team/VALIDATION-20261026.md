# 2026-10-26 实施验收与冻结

分支 `feat/memory-team`。最初基线 `cc2b769`；已合入 PR #6 的 `a5d9191`，合并提交 `5016eaef853be71fe968bea599efc24b621e1167`。功能未合并 main、未部署，真实 provider 调用和新增模型费用均为 0。

已验收 MM-01—03、MA-01—05：可审核项目记忆、独立只读角色、共享持久化预算、批次委派、取消与不重发恢复、候选版本审查。独立边界修复保留提交历史。记忆和协作默认关闭；postCompactionPrune 默认关闭及 NX-51 负结果保留。

## 本地检查

- Node 24.16.0，锁定 TypeScript 7.0.2；`pnpm install --frozen-lockfile --offline` 正常用户权限安装成功，未改锁文件或包管理器版本。
- `node scripts/build.js`、`node scripts/check-syntax.js`：222 文件通过。
- `node --test --test-timeout=120000 dist/test/*.test.js`：558 tests / 528 pass / 0 fail / 30 skipped，19.8 秒；30 项按现有平台/隔离条件跳过，不能据此声称本机完成 OS 隔离验收。原始 TAP 在工作区外 `D:\Agent\outputs\memory-team-main-merge-20261026.tap`。
- PR #6 默认关闭裁剪、委派恢复、预算与文档定向 31/31；合并后 eval 与文档 6/6。
- `node node_modules/@biomejs/biome/bin/biome check .`：251 文件，无诊断。
- `demo-memory` 与 `demo-team` 全部断言通过；后者保留成功、非法结果、取消与 skipped。usage 为合成数据，不是供应商真实消费。四崩溃窗口恢复均不调用模型。

## 独立开发清单

在干净的 `5016eae` 冻结四份 manifest，全部通过 `--validate-only`，实际模型派发 0。本地目录 `.eval-evidence/memory-team-dev-20261026-5016eae/`（不入库）；旧 `386ad17` 清单只保留历史，不用于新代码。共同源码指纹（LF 规范化）：`b2e32821c1aec102e5367a0f74c75124a9716ede9973ad2258221c5fa5fda862`。

- single-memory-off：`d58e065b80f46d8bf492e08af7bcf0e7dc90d17e2cb91148a2f286a257467dea`
- single-memory-on：`7997a0a2f5d9761605abeba5daa0d0fd001ccb37fe97a688536c7b681a8e5c37`
- team-memory-off：`47399f9b4dbd78d950e532719335165d9910cb0e010cf77912f2ac33059acba4`
- team-memory-on：`6d38d3033ec24aba45082a6bdec361d140abca9cf137a51cf65049be67e4b84e`

EV-02 状态为 prepared：4 个公开开发蓝图 × 4 条件只是 16 个拟议目标 episode。独立验收器、两阶段真实执行器、provider/价格快照、金额上限和效果实验尚未完成。与 Claude 的 48 条组件消融独立，不复用其结论或授权。
