# 实施决策

## ADR-001：新仓库是宿主扩展的隔离开发位置

用户指定空仓库 WeaveSense-KnowHow-Collector，提示词要求扩展现有 WeaveSense-Math。采用当前宿主提交为代码基线，在新仓库隔离开发并保留来源/许可证；不修改原宿主，不重新建设登录、计费、Loom 或知识数据库。现有目录中的历史 Grok 预览环境假设不代表本次 dot 环境，不能因此重建应用或放宽鉴权。

## ADR-002：完整 V1 门禁覆盖全部 100 项任务

原依赖图无环，但 QA-003 的祖先集合没有覆盖 COL-020 与 K-014。保留原图，发布门禁直接检查全部 P0/P1 任务及 29 个 V1 用例，不以单个 QA-003 完成代替完整 V1。P2 7 项保留，不抢先建设。

R01 没有全局 AC 显式关联，K-027 的 tests 列为空；不删需求、不重编号 AC。新增补充工程场景验证领域双版本、运行冻结、并发冲突和隔离，仍按 R01/CFG-001/K-027 的原任务验收判断。

## ADR-003：未知 job ID 也必须能恢复提交结果

最新提示词对 IF-003/IF-007/COL-013/COL-019 明确补全：start 响应丢失时通过可信 scope 与宿主幂等键查询已持久化 operation/job 映射，不能要求调用者先提供未收到的 job ID。外部是否接单无法判断时保持 reconciliation_required，不盲目重新提交。

## ADR-004：字幕输入不伪造媒体

input_ready 允许 platform_subtitles 且 media_sha256=null、availability=not_acquired；input_hash 必须对应真实接受的输入。processing_complete 用 parent_manifest_sha256 绑定输入并使用独立阶段 attempt/fencing；Loom K-017 完成映射、索引与可见版本切换后才产生 ready，worker success 不越权宣布就绪。

## ADR-005：单一执行台账与分层证据

规范基线只读；PROGRESS.json 是唯一实时状态来源，合并导出 tasks.execution.json 和 PROGRESS.md，禁止分别手改。代码/自动化/真实宿主/真实平台/试点/部署分开记录。依赖外部输入的验收维持阻塞；通用组件的开发样例实现可以继续，但不据此关闭依赖业务冻结的任务。

## ADR-006：不随代码推送自动发布镜像

继承的镜像发布工作流原先在 main/tag 自动推送容器。新仓库改为 workflow_dispatch，普通代码集成仅构建和测试；未经授权不触发生产发布、Skill 生产安装或扩大工具权限。
