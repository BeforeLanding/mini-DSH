# 阶段2：修复折扣税基

文件范围：仅可修改以下已有文件：`src/tax.mjs`、`src/total.mjs`；其他已有文件（包括 package.json、规格和公开检查）不得修改。

当前订单优惠后的税费仍按原价计算。修复税基：应按折后净额计税，无优惠订单保持原值。只可改 `src/tax.mjs`、`src/total.mjs`。
