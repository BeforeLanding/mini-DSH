# 扩展拼接选项

给 `src/join.mjs` 的 `joinWords(words, options)` 增加可选配置：separator 默认为 `, `，支持任意字符串（含空字符串）；skipEmpty 默认为 false，开启时仅过滤值为 `''` 的元素，不过滤空格。words 为字符串数组。

保留不传选项的原有行为，不改变输入数组。不得修改 package.json 或 check.mjs；运行 `node check.mjs`。独立验收额外覆盖空数组、默认值、只传一个选项及不同选项组合。
