# R25 / K-025 宿主原生 Agent 留存回归

## 范围与实现

- 使用现有 Loom 权威删除投影与 Flow 撤权事务；没有新增业务权威或数据表。
- 原生关联只取 `FlowAgentMessage.RunID`、`StateJSON.request.conversationId`、`Task.InputJSON.cloudAgent.request.conversationId`，以及同用户原生父子运行和 `Task.AgentRunID`。`CloudAgentExecution.ConversationID` 是原生 root-run 分组，不能当成 Flow conversation ID。
- Flow 事务通过组合根注册的 `repository.PurgeVideoConversationCaches` 清理关联原生 execution、Pi session、journal、transcript、root/child Task、text replay delta。撤权阻断读取/恢复；擦除移除派生正文。用户原创消息、实际账单和 usage 不删除。
- `app.New` 注入现有 `flow.CheckVideoConversationProjection`。读取、续跑、会话落盘、任务创建、结果保存和 SSE 回放在受影响 scope 上失败关闭；已有内存 SSE cache 命中和旧运行事件窗口不能绕过检查。非关联任务继续可用。
- 本地事务再次检查撤权标记，原生 revision/CAS 与数据库锁阻止旧 worker 或旧 Pi snapshot 回写；保留已有计费结算边界。
- 原生 `CloudAgentCanvasMutation.BeforeJSON` 是按 `RunID` 关联的撤销快照：撤权使其不可撤销，擦除同时清空正文；按运行/画布读取、mutation chain、新建快照和撤销标记都经过同一屏障。只处理受影响用户/运行的快照，不清空当前 Canvas、用户绘图或不相关运行的撤销记录。

## 验证证据

首次运行 `TestNativeVideoRetentionFencesRestoredReadsAndLateWrites`，execution、session、journal、legacy Task、child Task、stream replay、late session、late delta 共八个子用例全部失败，证明修复前的具体暴露路径。

修复后的专项：

```sh
cd backend
go test ./internal/repository ./internal/app -run 'TestNativeVideoRetention|TestCloudAgentPiSessionSnapshotRevision|TestCachedTextReplayIsolatesUsersCursorsAndCopies|TestCloudAgentRunSurvivesTaskInputCompaction|TestCloudAgentRunDetailFallsBackToLegacyStateEvents|TestCloudAgentPiCarrierCheckpointKeepsTaskHistoryAnchor' -count=1
```

专项覆盖：精确 scope 清理、同用户不同工作区保留、用户文本和显式派生 user-role 上下文区分、Pi JSONL、原生父子运行、旧 Task fallback、权威投影不可用、暖 SSE cache、原生运行详情/未变 revision SSE、Pi 恢复、晚到 session/event/delta、新 root admission、旧内存 journal。`go test ./internal/repository -count=1` 全包通过。

独立跨层 QA 使用真实本地 Loom 和真实宿主 SQLite 旧快照恢复，覆盖 erase 与 revoke→erase；测试在 `backend/internal/flow/video_host_restore_qa_test.go` 与 `video_native_restore_qa_test.go`。覆盖 native canary 清除、用户 canonical 消息和账单事实保留、异用户/异工作区不误删、晚到 session 保存拒绝。

这些是本地代码/fixture/真实本地恢复测试，不代表真实平台凭据、付费模型、业务行业验收、生产部署或远端发布已完成。

## 原生撤销快照补充回归

独立旧宿主备份恢复测试首先发现 `LatestCloudAgentCanvasMutation` 在权威 feed 不可用时仍返回 `BeforeJSON`。补充 repository 测试在修复前同时复现按运行读取、按画布读取、mutation chain、新建快照和撤销标记五条路径绕过屏障，以及撤权/擦除后仍为 applied 的快照。

`TestNativeVideoRetentionUndo*` 覆盖上述路径、擦除正文、撤权失效、投影检查之后发生撤权的写入复检、同画布不相关运行和异用户记录保留；app 的 `TestNativeVideoRetentionRuntimeAndWarmReplayCache` 同时调用真实 `UndoCloudAgentCanvas`，核对受影响撤销拒绝且当前用户绘图完全不变。相邻正常撤销/幂等撤销、snapshot hash、previs 回归继续执行。这里不声称本地清理能删除上游模型供应商缓存。

父任务确认已启动的更广 app 回归于本轮结束，终端日志为 `ok yingce/backend/internal/app 216.840s`。这是该次中间工作树的整包结果，其他功能仍在修改，不能充当最终冻结源码验收。
