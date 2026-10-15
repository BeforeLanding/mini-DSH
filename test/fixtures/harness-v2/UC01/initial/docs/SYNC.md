# 同步判定

`decideSync({localRev,remoteRev,remoteDeleted})` 返回 `pull`、`push`、`noop` 或 `delete`。rev是十进制非负整数字符串，按数值比较；本地低则pull，高则push，相同noop。`remoteDeleted` 为真时删除标记优先，返回delete，以免复活远端已删文件。
