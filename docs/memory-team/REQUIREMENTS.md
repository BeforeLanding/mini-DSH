# 项目记忆与只读协作需求

状态：实施中，2026-10-26。基线 `cc2b769`（main / PR #5 合并）；独立分支 `feat/memory-team`。原始设计为 2026-10-22《mini-DSH：项目记忆与 Multi-Agent 落地方案》。

1. 项目事实、验证方法、任务经验必须附带来源和文件版本；候选未经用户批准不参与普通召回。记忆不覆盖 AGENTS.md 和当前指令。
2. 项目按真实工作区路径隔离，显式绑定才共享；JSONL 是事实来源，索引可重建。写入需落盘、幂等和 revision 检查。
3. 工具按需、有界检索；新任务固定 MemoryView，每次读取仍检查撤销、期限、来源及文件锚点。reset 不删除项目记忆。
4. 主 Agent 是唯一 Agent 写入者。Analyst、Test designer、Reviewer 使用独立 Harness 和不可变工具白名单；无 Bash/MCP/递归委派/记忆写入。
5. 根任务统一约束 root/child/summary/retry 的请求、工具、token 和 wall deadline；原子预留、持久化后派发、按 requestId 结算，未知用量阻止继续派发。
6. 委派结果有界、结构化、附版本证据；父会话只接收经宿主发布的结果。恢复复用已确认结果，不重发未知请求，不放宽普通工具 unknown 语义。
7. 默认关闭记忆和委派。关闭时保持旧 schema、提示和事件行为。离线机制演示与真实模型效果分开。

本分支不执行付费模型、48 条消融或修改 PR #6 的四臂 manifest/比较器；保留负结果。`postCompactionPrune` 保持默认关闭，后续合并 PR #6 时专门核对。
