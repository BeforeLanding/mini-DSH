# 配置合同

导出 `resolveConfig({ fileText, explicit })`。默认配置为 `region: "us"`、`retries: 2`。`fileText` 是逐行 `key=value` 的文本，只识别 `region` 与 `retries`；无该项时使用默认值。显式选项优先于文件，文件优先于默认值。显式 `retries: 0` 是有效值。返回新对象，不修改输入。非法的 retries 应抛 `RangeError`。
