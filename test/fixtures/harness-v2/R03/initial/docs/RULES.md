# 运单规则

重量 `weightKg` 必须大于0且不超过市场上限；最长边 `longestCm` 不超过100且大于0。国内市场 `domestic` 上限20kg，要求五位数字邮编 `postcode`。国际市场 `international` 上限10kg，要求非空 `customsCode`。通用原因使用 `weight` 与 `dimensions`；专属原因使用 `postcode` 与 `customs`。`validateShipment` 返回 `{ok:true}` 或 `{ok:false,reason}`。
