# 阶段1：建立旧规格测试

当前 `src/` 实现 `docs/RULES.md` 旧版：金额≥1000分进入review，VIP可豁免。新建 `suite.mjs`，通过公开 `classifyTransfer` 建立旧行为测试，现阶段应在工作区实现上通过。不要改源码。
