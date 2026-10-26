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
| EV-01 | in_progress | 零模型 memory/team 演示与离线故障证据 |
| EV-02 | planned | 四条件同预算新协议及 validate-only；真实执行待授权 |

每项完成后记录实际提交和检查，不把计划视为实现。里程碑结束运行 check/test/lint，隔离相关修改运行对应环境检查。
