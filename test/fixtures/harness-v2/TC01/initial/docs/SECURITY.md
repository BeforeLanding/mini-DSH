# Webhook接收合同

`createVerifier(secret, nowMs)` 返回带 `verify({id,at,signature})` 的对象。签名是 HMAC-SHA256(secret, `${id}:${at}`) 的hex串；签名错误返回false。只有 `|nowMs-at| <= 300000` 的有效签名首次事件返回true，同一实例内重复id返回false。错误/过期尝试不占用id，另一个实例有独立已见集合。
