# 项目记忆与只读协作任务

| 步骤 | 状态 | 独立交付与验收 |
| --- | --- | --- |
| MM-00 | done | 冻结 main 基线、并行开发边界、需求与提交顺序 |
| MM-01 | done | 项目隔离的候选存储；重启、幂等、CAS、锁、损坏尾部、索引重建 |
| MM-02 | done | 已批准记忆的确定性有界检索；快照、来源、失效与跨项目拒绝 |
| MM-03 | done | 提案/审核/撤销、CLI 与重放 receipt；模型不能批准 |
| MA-01 | done | 独立只读 Harness 与中央能力拒绝；资源释放 |
| MA-02 | done | 可恢复共享预算；并发竞争、重复结算、未知用量与 root floor |
| MA-03 | done | 双 worker 批次分工、有界结构化结果与父会话制品发布 |
| MA-04 | done | 取消、四个崩溃窗口、父子恢复与 inspect；未知请求不重发 |
| MA-05 | done | reviewer 的固定候选版本与 stale 检测 |
| EV-01 | done | 零模型 memory/team 演示与离线故障证据 |
| EV-02a | done | 四个蓝图改为客观交付；独立验收器；准备/目标两阶段执行器；记忆、子 Agent、摘要、重试的完整账目；16 episode 零付费装配验证 |
| EV-02b | awaiting authorization | 固定模型/价格/预算/金额上限并冻结 16 个开发目标 episode；付费执行需用户当次授权 |

每项完成后记录实际提交和检查，不把计划视为实现。里程碑结束运行 check/test/lint，隔离相关修改运行对应环境检查。

## EV-02 开发评测

- EV-02a（done，独立提交）：W01—W04 的公开目标改为 `answer.json` 精确字段 + W02 目标文件；独立验收器在候选退出后检查复制件，拒绝受保护文件变化和额外文件。执行器在同一 session 内跑 prepare/goal 两个 root task，共用 adapter 级 episode 守卫（v2.2：32 请求 / 64 工具 / 320k token / 900s / $0.50），完整归账 root、summary、child、retry、记忆查询和委派；冻结记忆快照由同一公开经验包生成。零付费验证覆盖 16 个 episode 装配、验收器正反例，provider 请求 0。详见 [评测协议](EVALUATION.md)。
- EV-02b（v2 / v2.1 executed, v2.2 frozen, no further paid run authorized）：v2 16/16、15 通过、$0.469586，但提示内嵌答案、W02 缺权威证据、W03 零委派，不作收益结论。v2.1 16/16、11 通过、$0.518104；委派 2 批/4 子会话，child 33,932 token；5 条失败全是验收口径歧义（W01 文档 vs 脚本、W04 `valid(NaN)` vs 标准谓词）。v2.2 只修正这两处口径并冻结，尚未付费重跑。

## PR #7 独立收口

- REV-01（done，独立提交）：让组 wall deadline / 未知用量中止整个 run，包括工具与审批等待；挂起工具、审批、唯一终态及未知用量续跑拒绝已验收。
- REV-02（done，独立提交）：已复现并修复 worker 发布失败后其它 worker 脱离批次；取消并收尾后才释放批次租约，取消后的迟到结果不标成功。
- REV-03（done，独立提交）：提案身份绑定工具批次；复用工具 ID 可创建不同候选，原调用仍幂等且不能绕过每 run 三条上限。
- REV-04（done，独立提交）：只读读者每次重新校验事实日志，外部撤销立即停止后续召回；损坏刷新失败关闭，恢复后仍保留任务冻结视图。
- REV-05（复核验收 done，独立提交）：完整 check/test/lint、权限/批准/项目隔离复核与两个零模型演示通过；代码 head 六项 CI 全绿，隔离 38/38 无跳过。审查结论允许合并，执行前仍检查最终文档 head 六项 CI；最终合并状态见 [PR #7](https://github.com/BeforeLanding/mini-DSH/pull/7) 和 [审查记录](REVIEW-PR7.md)。

独立修复提交：REV-01 `afdaca5`；REV-02 `bc4ef50`；REV-03 `9750558`；REV-04 `525ecc9`。

提交对照：MM-00 `aecad36`；MM-01 `86fb32e`；MM-02 `be0e8cd`；MM-03 `b0f52a0`；MA-01 `20a2118`；MA-02 `4ae2529`；MA-03 `985cc79`；MA-04 `ad3f29f`；MA-02b `5331a25`；MA-05 `e22ea3f`；MA-03b `2b00f4c`；EV-01 `cb87b19`；EV-02 准备 `3e1f113` / 配置语义 `386ad17`；合入 PR #6 `5016eae`。完整本地检查与清单摘要见 [验收记录](VALIDATION-20261026.md)，真实结果不得回填为已执行。
