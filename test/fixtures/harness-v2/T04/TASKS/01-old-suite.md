# 阶段1：建立旧规格测试

文件范围：已有文件均不得修改（包括 package.json、源码、规格和公开检查）；交付文件是根目录 `suite.mjs`。

当前 `src/` 实现 `docs/RULES.md` 旧版：金额≥1000分进入review，VIP可豁免。新建 `suite.mjs`，通过公开 `classifyTransfer` 建立旧行为测试，现阶段应在工作区实现上通过。不要改源码。
