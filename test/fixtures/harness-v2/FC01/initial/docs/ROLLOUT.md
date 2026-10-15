# 发布依赖规则

settings形状为 `{flags:{name:boolean},requires:{name:[prerequisite,...]}}`。某flag未列出视为关闭；依赖链必须全部开启。缺失依赖关闭当前flag而不是抛错；只有图中可达环才抛 `RangeError`。未被查询的独立环不影响当前flag。
