# NX-44：专用真实 smoke 准备

本阶段只运行离线模拟模型。历史 NX-42 日志仍缺完整请求材料，不能严格回放。以下录制协议仅供未来三个固定 smoke 场景使用，不作为通用会话记录格式。

## 录制边界

`scripts/smoke-recording.ts` 在 adapter 边界记录每次调用的 `purpose=main|summary`、模型、输出上限、system、messages、工具 schema、固定 wire 配置、SHA-256 请求指纹、按顺序收到的 content/reasoning 流片段、完整或部分响应、usage、finishReason 和错误。摘要请求在 `ChatRequest` 中有显式 purpose，不能靠最后一句提示词猜测。fixture 初始文件以受控 base64 快照及逐文件 hash 保存；隐藏文件、链接和超过 1 MiB 的快照拒绝。版本字段包括代码 SHA、fixture ID、manifest digest 与工具 schema SHA。

录制文件用独占创建及本地文件权限 `0600`，每条记录写入后同步；它可能含真实模型推理和 fixture 内容，只能放在不提交的证据目录，不能复制到报告或输出到控制台。凭证不属于请求材料或 wire 配置，不写入录制文件。工作区绝对路径只经声明的 `${WORKSPACE}` 映射归一化。若其他动态材料不能按原样重建，回放应失败。

回放适配器没有真实 provider 引用；每次检查主/摘要全局顺序、完整请求材料和指纹，重放记录的流与响应，缺失/额外调用报错。仅在隔离 fixture 中执行副作用。录制文件是可复核证据，不提供防恶意改写签名；旧日志不具备此协议，不能据此升级为严格回放通过。
