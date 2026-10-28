# V1 闭环矩阵：原条款、工程证据与业务验收

> 本轮已确认工程缺陷与独立可执行验证已收口，最终应用代码四类CI/真实整栈通过；**原业务定义、真实平台/质量/持续试点尚未全部验收，不能标“完整V1已交付”**。以下按自身技术条件、直接外部条件、原依赖分别计数，不改基线。

## 范围与证据口径

- 不可变原基线：`c14b24aec7a9e0def26b5b1c05c67d9ea161dd31`；100个P0/P1任务、29个AC；7个P2及AC30不纳入。
- 原任务 SHA-256：`0def0d9514aeaac544034dbd6994c76041d35f0c2968011ee02770c86ae2e046`；原PRD SHA-256：`28f1881f6561cb515bcc6f720f3d9a22fc15dc9bc0c32456a906922d75d7c5a8`。
- 本轮最终代码/测试提交：`ff03a18f34d80b1b894b3d89a58df06b594346df`。本页及JSON是后续文档收据，不把文档提交的SHA伪装为此前测试SHA，也不要求递归修改自己的SHA。
- [完整机器矩阵](evidence/v1-closure-matrix.json)逐项保留原文、依赖、规范化hash、实现路径和实际命名测试/产物映射。本审计只写这两个文件；原spec未改。负责人已同步PROGRESS/执行账本，本矩阵只读核对当前任务状态与23个通过、6个阻塞的AC状态。
- PROGRESS的原依赖签收状态不是代码完成比例；尤其旧“2/88/10”不能替代下列自身工程与直接外部条件分解。逐项建议仅保留COL-001/IF-001既有完成，FND-004取消工程blocked，K-020授权阈值校准明确为直接条件。
- “有工程实现及执行证据”只覆盖明示断言；不把文件映射、单个测试ID或整套绿灯自动换算成整项/业务接受。真实内部组件与合成外部provider/model分列；不声称平台成功率、行业精度或试点时长。

## 分解计数（不是完成百分比）

97项具有工程实现和相应范围的实际执行记录，其中90项无自身直接外部输入条件、7项同时含原真实环境/样本/试点条件；另3项是尚未确认的原业务定义。90项中88项仍通过原依赖链关联未签收条件，这不把它们重新变成“代码未实现”。测试文件匹配仅是证据索引，逐项事实/限制优先，不据此自动认证整项。

| 维度 | 数量 | 含义 |
|---|---:|---|
| 原P0/P1任务 | 100 | 原文/依赖完整，不减需求 |
| 有工程实现及相应执行证据的任务 | 97 | 包含混合任务的技术子项；不是整项原验收已签收 |
| 原业务定义待确认 | 3 | FND-001、FND-003、K-027；不以通用profile/合成金标冒充 |
| 技术证据与直接外部验收混合 | 7 | FND-005、COL-028、K-020、QA-001、COL-031、IF-028、QA-003 |
| 仅原依赖尚未签收的技术任务 | 88 | JSON保留最短依赖链，不把依赖未签收写成代码未实现 |
| 已确认仍可自主执行的动作 | 0 | 逐项如下；未执行不得改写为等待用户 |

29个AC：23个原客观工程条件已在明示范围内通过；6个虽有工程子项证据，仍缺原真实平台、质量或持续试点条件。当前PROGRESS逐例一致；不等于完整V1业务签收。

## 精确提交与运行历史

| 提交 | 实际结果 | 不能据此推断 |
|---|---|---|
| `1baf5366209ee12ad7694404ac6d3ad98da50ed6` | 容器与integration成功；Flow265/265零skip；真实native Canvas停admitted120s导致fullstack失败。 | 当时native/lifecycle后段未完成；生产guardedDB组合后续修复。 |
| `eac6b257cf707755f8403fc9305bf7f47c569dfb` | native实际执行成功；candidate虚拟Select定位失败；Flow267/268因PG FORCE-drop关闭中socket失败。 | 不是整轮绿，未到restart/observer。 |
| `50c9de25bdd52a4cc4d3efc937bd136b50139b7b` | quality5/integration6/container成功；Flow272/272零skip；candidate UI60任务/导出通过；longinput profile400。 | 未到restart/observer；随后修profile请求、缺失正文路由及provider身份/CAS缺陷。 |
| `ff03a18f34d80b1b894b3d89a58df06b594346df` | 最终ff03四工作流/13 jobs成功：Flow281/281、fail0/skip0；Go1965顶层pass、5条件skip、0fail，VIDEO_REQUIRED全run+pass；Web2531/333files、worker56/56、ASR7pass/1skip、ledger scripts82+8通过；真实fullstack/outcome0，长输入/重启/撤回/observer/清理通过。 | 外部平台/模型主要为fixture；实际中文ASR是单独本地精确字节执行。不是业务/行业签收或生产部署。 |

## 本轮证据索引

| 编号 | 事实与范围 | 主要来源 | 限制 |
|---|---|---|---|
| E01 `scoped_retry_cancel_fix_final_ci_verified` | 基线 retry 在 budgetStatus 等待期间可把 cancelled 改回 queued；独立隔离复现成功。当前最终事务锁/CAS 返回 RETRY_STATE_CHANGED，取消保持且不可再 claim；永久 budget/provider 双竞争回归已补。 | `services/loom-engine/flow/video.ts`、`services/loom-engine/flow/video.test.ts` | 最初是独立隔离PGlite复现，原provider.poll窗口已有STALE_FENCE；budgetStatus窗口修复及永久竞争测试由最终适用CI复验，不把局部复现冒充全栈。 |
| E02 `extraction_evaluation_retry_final_ci_verified` | 提炼/评测在已确认终态后使用新 generation，保留历史任务、已完成批次和冻结父预算；unknown 保留原 task/key 对账。retry_wait 与子模型 cancelled 的恢复分支已修，不再沿用旧审计警告。 | `services/loom-engine/flow/video-knowledge-extractor.ts`、`services/loom-engine/flow/video-knowledge-evaluator.ts` | 最终适用提炼/评测恢复回归已执行；成功结果无效时按各模块显式策略处理，不把模型子任务取消当用户取消，也不把固定model结果当语义质量。 |
| E03 `actual_native_application_execution_verified` | 实际Agent工具桥/真实CloudAgent批准/managed Canvas已在ff03整栈完成；正确version/hash/snapshot/host证据，重启与当前撤回检查通过。首轮admitted失败及修复保留于E24/E27。 | `.github/browser/fullstack-native.mjs`、`.github/browser/video-fullstack.spec.mjs` | 自编输入/严格确定性外部model；不证明真实B站/抖音采集、模型语义质量、Pi自主选工具、候选容器部署或生产上线。long-input报告browser_verified=false；精确文本HTTP/组件高亮证据与实际浏览器短证据各自保留。observer不审Go ledger。 |
| E04 `actual_dual_compiled_lifecycle_final_host_ci_verified` | 真实持久 Loom evaluator → Go Gateway/ModelTasks/Billing，2 版本 × 20 cases × 3 variants = 120 个任务，合成计量 3600 micro；真实批准/导出/CLI，先 v1-only 编译宿主再 v2 新 binary 复用持久库，部署/安装/升级/回滚 CAS、旧 pin/hash/snapshot 与当前撤权均通过（52.29s）。 首checkpoint同测试CI又通过55.93s，原始JSONL/hash见E26。 | `backend/internal/flow/video_release_loom_qa_test.go`、`services/loom-engine/validation/video-knowledge/release-loom-qa.ts` | 两次真实Go测试宿主源码编译、持久库与真实registry/路由/批准/安装/回滚；最终host CI再次通过。外部模型/材料合成，不等于浏览器候选容器部署或行业质量。 |
| E05 `actual_candidate_ui_and_sixty_managed_receipts_verified` | 实际主应用candidate UI20×3评测、批准/导出且安装禁用通过；PG60tasks→Go idem hash→60synthetic receipts一一匹配，重启后不重调，撤回候选retired。 | `.github/browser/fullstack-skill-lifecycle.mjs`、`.github/browser/video-fullstack.spec.mjs` | 此UI链只到源包导出，不假装已部署；双binary部署/安装/回滚由E04/E36证明。 |
| E06 `long_unicode_worker_and_final_go_pg_minio_verified` | 真实 Python HTTP/SQLite/Processor → Loom/PGlite：2101 段、459242 UTF-16 单元、7 分片、23 页，完整正文/hash/时间逐条对齐；修重叠时间包络、Unicode 预览、视觉帧引用顺序与来源收据。 | `services/loom-engine/flow/video-longinput-qa.test.ts`、`services/loom-engine/flow/video-temporal-projection.test.ts` | 本地2101段完整性证据保留，最终Go/PG/MinIO大输入由E37确认；后者是HTTP不是长文本实际浏览器高亮演示。视觉模型语义质量仍未宣称。 |
| E07 `scoped_execution_retained_and_final_applicable_ci_verified` | 两条生产 Executor/SQLite/真实 FFmpeg/Processor 同时到 OCR 边界；取消 A 仅清其临时目录，B 仍在运行且帧 hash 不变，随后完成并核验跨 workspace 对象。Python 49 测试通过。 | `services/video-knowledge/test_video.py`、`docs/video-ingestion/LONG-INPUT-VISUAL.md` | OCR 为 fixture；临时目录清理不是远端/保留对象全部擦除，未声称模型语义正确。 当前适用最终执行见E36/E37/E38；历史局部run边界和计数不变，不累计成任务完成数。 |
| E08 `scoped_execution_retained_and_final_applicable_ci_verified` | 实际 Go SDK → MCP → 签名 Loom HTTP → 后台 input/process → ready，21 页/81 evidence/19395 UTF-16；read_ref 恢复超 1200 引用。manual/scheduler/MCP 同 scope 仅 1 job、1 input、1 process、1 ready，异步入口约 36ms。 首checkpoint实际Go CI同测试又通过6.24s（E26）。 | `backend/internal/flow/video_mcp_paging_qa_test.go`、`services/loom-engine/validation/video-knowledge/gateway-paging-loom-harness.ts` | 仅外部 provider 合成；不是原生浏览器点击的四入口逐一重放，也不是实平台长视频。不得由此宣称每个 IF-013 子条款全验收。 当前适用最终执行见E36/E37/E38；历史局部run边界和计数不变，不累计成任务完成数。 |
| E09 `scoped_execution_retained_and_final_applicable_ci_verified` | 真实 scheduler + 迁移后磁盘 PGlite 关闭重开：两平台类型各两个窗口、6 唯一 jobs；页 2 故障/429、Retry-After、中间/末页 COMMIT 回包丢失与回滚、缓冲页/重复/乱序、累计 item/page 上限共 8 项通过。原子写入与重试计数实际修复。 | `services/loom-engine/flow/video-discovery-atomic.test.ts`、`services/loom-engine/flow/video-discovery-recovery.test.ts` | 两窗口按受控时钟，不是实际平台运行周期；本测试只到 jobs，实际下游候选另见 E17。 当前适用最终执行见E36/E37/E38；历史局部run边界和计数不变，不累计成任务完成数。 |
| E10 `actual_pg_migration_rollback_restore_final_ci_verified` | 0031实际SQL事务注入失败→schema/ledger回滚、历史revision/evidence不变、重迁移幂等并claim原未完成任务；PGlite及首checkpoint真实PG均通过。实际pg_dump/pg_restore+独立删除日志与已领取pending跨恢复提升fence并完成亦在本次PG通过，详E25。 | `services/loom-engine/flow/video-migration-recovery.test.ts`、`services/loom-engine/flow/video-qa.test.ts` | 真实PG失败迁移/dump-restore/pending续跑最终再次通过；不要求把数据库故障搬进浏览器，也不证明任意旧程序降级兼容。 |
| E11 `scoped_execution_retained_and_final_applicable_ci_verified` | video on/off 各走真实非视频 HTTP/Engine，RSS 200/304/历史 revision、Telegram fixture、ASR/OCR、检索/monitor/调度与输出深等，1 项本地通过。 | `services/loom-engine/flow/video-legacy-compatibility.test.ts`、`services/loom-engine/flow/t21.test.ts` | 外部 RSS/Telegram/ASR/OCR 为 fixture。剩余 WeChat/周期 Canvas 实际双态已由 E22 补齐；两种已执行边界不互相冒充。 当前适用最终执行见E36/E37/E38；历史局部run边界和计数不变，不累计成任务完成数。 |
| E12 `actual_second_tenant_zero_budget_and_long_input_verified` | 真实第二tenant同bytes material隔离、零知识预算拒绝以及最终大Unicode输入真实链均通过，见E37。 | `.github/browser/fullstack-bootstrap.mjs`、`.github/browser/video-fullstack.spec.mjs` | scope/预算/完整性工程验证，不是两真实平台成功率或行业质量。 |
| E13 `final_dependency_notice_image_evidence_verified_release_decision_separate` | worker原NOTICE、backup Loom LICENSE和Node/MC原binary通知已打包；10包Python wheel SHA256传递闭包与实际版本/镜像/source-input/附件hash可追溯。五个精确npm版本官方采证、固定mc源码commit完整LICENSE已补；最终ff03新镜像回读核对通过，详E38。 | `docs/video-ingestion/SUPPLY_CHAIN.md`、`docs/video-ingestion/evidence/selected-license-sources.json` | E38最终镜像/通知/锁与选定源输入闭包通过；NOASSERTION/未知splinetool/特殊许可不等于可商用授权。无原PRD额外全应用ZIP/可复现构建门禁。 |
| E14 `budget_unknown_intent_generation_and_pg_final_ci_verified` | 0033 close intent、generation CAS、取消+未知reserve在后续授权拒绝后仍安全对账、只读lookup已修；独立6/6恢复回归、真实host lookup和最后PG cancel/ready/聚合均通过。 | `services/loom-engine/flow/migrations/0033_video_budget_close_intent.sql`、`services/loom-engine/flow/video-budget-recovery.test.ts` | 不把未知费用视为零或重开预算；真实host账本与受控预算stub分别标注，最后执行见E36。 |
| E15 `protocol_prompt_injection_and_later_real_approval_verified` | 实际恶意字幕经 Loom 后台索引/evidence → Go 原生 Skill/ModelTasks；外部合成模型返回攻击 tool_calls，断言未调度工具/未外传/未变 registry 或 pin。本地跨语言测试通过（5.04s）。 首checkpoint实际Go CI同测试又通过5.67s（E26），仍不冒充E21实际审批组合。 | `backend/internal/flow/video_prompt_injection_qa_test.go`、`services/loom-engine/validation/video-knowledge/gateway-paging-loom-harness.ts` | 此协议测试使用testDB/PGlite与仅授固定Skill/model的test authority；实际CloudAgent审批另由E37证明，不将任何合成model回归扩大成真实LLM鲁棒性结论。 |
| E16 `scoped_execution_retained_and_final_applicable_ci_verified` | 真实 Go SDK/受信委托的 5 类 HTTP 重定向、Node HTTPVideoProvider/platformKnowledgeRuntime 的 10 条 redirect、Python InternalClient 的 5 类 redirect 均保证目标 0 请求；Node/Python 401/429/Retry-After 分类通过。既有私网/IP/固定 endpoint 负例同跑通过。 | `backend/internal/flow/video_transport_security_qa_test.go`、`backend/internal/flow/p5_test.go` | 实际 HTTP 401 语义与既有签名 exp 测试不是真实平台凭据过期/轮换；最终同 SHA CI 与秘密不泄露组合仍分别核对。 当前适用最终执行见E36/E37/E38；历史局部run边界和计数不变，不累计成任务完成数。 |
| E17 `scoped_execution_retained_and_final_applicable_ci_verified` | 真实 scheduler/coordinator/extractor 两个无前端增量窗口和两次磁盘重启；实际流水线形成 4 ready jobs 与 4 个未审批候选，第二窗口恰新增 2 候选，不 seed ready/extraction/candidate。 | `services/loom-engine/flow/video-discovery-candidates.test.ts`、`docs/video-ingestion/DISCOVERY_RECOVERY.md` | 外部 feed/media/model receipt 为合成；不证明真实双平台账号/质量或已经经过现实窗口时长。 当前适用最终执行见E36/E37/E38；历史局部run边界和计数不变，不累计成任务完成数。 |
| E18 `scoped_execution_retained_and_final_applicable_ci_verified` | 真实 Executor/SQLite checkpoint/HTTP DTK adapter/scoped token-file 重载/ffprobe：下载接受后 401，旋转 token 并重建 Tasks/routes，429 保留 Retry-After=9，再恢复相同 task/external download ID，只有 1 submit/1 object，分P=3/fence=4/3 quanta 与既有 checkpoint 保留；跨 scope 403，两个 token 均不写 execution SQLite。 最新回归让 401/429 body 主动回显两代 key，公开 Tasks.read/error projection、worker stdout/stderr、SQLite/WAL 均无 key/上游私有详情。 | `services/video-knowledge/test_credential_rotation_qa.py`、`services/video-knowledge/dtk.py` | 外部 DTK 和内存 objectstore 明确为 fixture；重建 Python 对象/SQLite 连接，不声称 OS 进程重启；检查 Retry-After 数值但没有等待 9 秒。不是真实账号或实际 UI 渲染；宿主工具/prompt/API 独立脱敏证据见 E20。 当前适用最终执行见E36/E37/E38；历史局部run边界和计数不变，不累计成任务完成数。 |
| E19 `historical_first_container_checkpoint_verified` | 首发布 1baf536（tree 与本地 3d29f61 相同）的 container CI 成功；负责人实际下载 ZIP 校对 GitHub digest，解包核对 19 附件/477 选定源文件及两个 amd64 镜像的 revision。 | `.github/workflows/video-container-validation.yml`、`scripts/video-build-provenance.py` | 首checkpoint真实结果；最终同SHA增量镜像/通知由E38独立核对，不继承旧绿灯。 |
| E20 `scoped_execution_retained_and_final_applicable_ci_verified` | 既有宿主 MCP secret 回归重跑通过：server-side 注入凭据，tool output 已脱敏；工具定义/prompt、API view、持久 tool calls 无 token；tenant secret 加密/跨 scope 拒绝和轮换使用新值。结合 E18 视频 worker key-echo 拒绝，而非要求每个负例重做浏览器。 | `backend/internal/flow/mcp_test.go`、`backend/internal/flow/mcp_secrets_test.go` | 分层工程证据，不是同一个真实平台凭据贯穿浏览器的演示。实际 UI 授权/重试时间显示沿用真实组件和最终同 SHA 回归，不新增付费/平台账号要求。 当前适用最终执行见E36/E37/E38；历史局部run边界和计数不变，不累计成任务完成数。 |
| E21 `actual_hostile_cloudagent_approval_fullstack_verified` | 主整栈自写字幕加入 hostile marker；实际 Agent 拒绝未知网络/安装工具、方法重写和伪造 approval，随后实际 CloudAgent decision→managed Canvas。合成外部模型故意给 2 个恶意 tool_calls，实际内部 trap 观察器要求 0 外传请求、registry/install/pin/snapshot 不变。 | `.github/browser/video-fullstack.spec.mjs`、`.github/browser/fullstack-native.mjs` | 自编输入/严格确定性外部model；不证明真实B站/抖音采集、模型语义质量、Pi自主选工具、候选容器部署或生产上线。long-input报告browser_verified=false；精确文本HTTP/组件高亮证据与实际浏览器短证据各自保留。observer不审Go ledger。 |
| E22 `scoped_execution_retained_and_final_applicable_ci_verified` | AC24 补齐真实开关传播：Node harness 在实际 Loom video.enabled=false/true 运行真实 WeChat connector/parser/scheduler，产生各 3 个 collection.completed；Go 消费这些真实事件进入 dispatcher/审批校验/managed Canvas，均 2 次成功、第三次额度耗尽、重放不重复。Go 父项+双子项 3/3、6.826s；独立 WeChat HTTP/历史 revision/FTS 双态对照 1/1、约4.7s。 | `backend/internal/app/cloud_agent_video_legacy_compatibility_test.go`、`services/loom-engine/validation/video-knowledge/legacy-cycle-harness.ts` | WeChat gateway/model/已批准持久计划为明确 fixture，不是实际 CloudAgent decision路由。最初仅 Setenv+重复旧 Go 测试的空双态方案已撤换，不作为通过证据。 当前适用最终执行见E36/E37/E38；历史局部run边界和计数不变，不累计成任务完成数。 |
| E23 `scoped_execution_retained_and_final_applicable_ci_verified` | 真实签名 worker HTTP→SQLite队列→FFmpeg/Processor→fsync局部对象，6×6秒/320×180/10fps/无模型，依次1/2/4workers校准，实测峰值claim分别1/2/4。实际磁盘水位拒绝不发布，恢复后同task重试完成且保留usage；发现并修复早期磁盘压力已写usage后resume缺ocr/asr/frame计数导致PROCESSOR_FAILED。 最新完整 Python worker 55/55 通过（13.225s），含新增真实32MiB子进程计量与压力恢复回归。 | `services/video-knowledge/capacity.py`、`services/video-knowledge/test_capacity.py` | 真实局部媒体基线，不是30次控制QPS；OCR固定fixture，无DTK/ASR/VLM质量、无MinIO/Go/Loom knowledge-ready。20ms进程树sum-RSS非cgroup精确峰值、可能漏短峰/重计共享页；安全提高水位不证明OOM安全或生产内存上限，不冻结生产SLO/推荐并发。 当前适用最终执行见E36/E37/E38；历史局部run边界和计数不变，不累计成任务完成数。 |
| E24 `historical_first_fullstack_failure_preserved` | 首 checkpoint 整栈实际执行失败：审批前 run=403，真实批准后 run=202，但 managed Canvas 留在 admitted 120s 未执行，不能称 AC25 或完整整栈通过。失败前原始 browser-last-observation 明确记录真实登录/导入/复核发布、实际第二 tenant 同bytes隔离、zero-curation-budget拒绝成功；这些子结果保留，不扩成后续链路成功。 | `.github/browser/fullstack-native.mjs`、`.github/browser/video-fullstack.spec.mjs` | 此历史run exit1，不反写成功；后续生产DB组合修复及最终ff03全栈由E27/E37证明。 |
| E25 `historical_first_pg_checkpoint_verified` | 首 checkpoint integration 六 jobs 全成功；真实 PG Flow suite 265/265、fail0、skip0。具体日志：12:37:44 ok117 cancel-waits-ready行锁竞争；12:39:51 ok168 AC28 failed additive migration；12:40:27 ok187 R25/K025真实dump/restore（含已领取pending换更高fence并完成）。 | `services/loom-engine/flow/video-cancel-ready-pg.test.ts`、`services/loom-engine/flow/video-migration-recovery.test.ts` | 首checkpoint265/265零skip保持原结果；最后增量PG/Flow数据以E36为准。 |
| E26 `historical_first_host_checkpoint_verified` | 首checkpoint实际Go host CI原始JSONL确认：120 ModelTasks/3600 micro/双parent关闭、双binary TEST安装升级回滚/历史pin/撤回通过（55.93s）；真MCP长分页6.24s、跨语言Gateway3.41s、恶意字幕受控协议5.67s通过。 | `backend/internal/flow/video_release_loom_qa_test.go`、`backend/internal/flow/video_mcp_paging_qa_test.go` | 保留原host5条件skip与实际父测试运行child证据；最终host结果见E36，不混加顶层和subtests。 |
| E27 `production_guarded_db_composition_fixed_and_actual_fullstack_verified` | 定位首checkpoint admitted故障：service.New安装projection guard后repo.DB()是新GORM session，main却把原句柄交给Tools/ModelTasks/runner，严格identity返回ErrInvalid。newRuntimeService让后续生产组件共用guarded句柄，保留guard/RLS/严格identity。生产同factory回归先证明旧组合ErrInvalid，修后真实CloudAgent批准→periodic-brief原生Skill→ModelTasks→一次模型调用→Canvas revision2、父子预算settled。 | `backend/cmd/server/main.go`、`backend/cmd/server/runtime_service.go` | 局部真实factory/ledger正负回归及最后真实video-core/Loom/PG/浏览器均通过；不要把外部synthetic model解释为语义质量。 |
| E28 `safe_diagnostics_and_required_execution_gate_final_ci_verified` | wakeCanvasWorkflow不再静默丢弃runner错误：只记录服务端run_id、固定reason/status，不记录错误正文、secret或材料。17类安全分类加既有T17/T22回归通过1.848s。CI --require-video新门禁要求真跨语言/MCP/协议注入/双编译/实际周期Canvas与生产factory命名测试实际run+pass，skip也失败；门禁3测试通过。 | `backend/internal/app/cloud_agent_workflow.go`、`backend/internal/app/cloud_agent_workflow_logging_test.go` | 诊断不放宽授权、不改变持久恢复状态；最终VIDEO_REQUIRED全部实际run+pass，保留旧运行与其他条件skip，不能反写历史跳过。 |
| E29 `operations_document_original_scope_reviewed` | IF-030接入顺序、兼容矩阵、失败发布/恢复与六类诊断已按当前真实接口补齐；原QA-002发布包是Skill源包，不是额外全应用archive。 | `docs/video-ingestion/OPERATIONS_COMPATIBILITY.md`、`docs/video-ingestion/RUNBOOK.md` | 文档不自动证明部署执行；与本轮clean TEST、真实MCP、双binary和PG恢复证据分别对应。无生产部署/全应用ZIP新门禁。 |
| E30 `historical_eac6_partial_success_not_all_green` | eac6真实native Canvas succeeded/rev2、hostile能力拒绝与host120任务生命周期通过；后续candidate虚拟Select定位失败。Flow267/268、0skip，唯一失败为PG FORCE-drop清理关闭中socket；业务409诊断已完成。 | `.github/browser/fullstack-native.mjs`、`.github/browser/fullstack-skill-lifecycle.mjs` | 当时未执行候选、restart/observer后段；后续修复不反写历史结果。 |
| E31 `historical_50c9_aggregate_success_fullstack_partial` | 50c9 integration6/quality5/container成功，Flow272/272零skip；实际candidate UI完成20×3=60任务、批准导出且not_deployed。整栈后续long-input profile请求400，restart/observer尚未执行。 | `scripts/fullstack/long-input.mjs`、`.github/browser/fullstack-skill-lifecycle.mjs` | 不是整栈全绿；错误profile配置/幂等键与正文路由缺口在后续修复。 |
| E32 `provider_namespace_identity_and_first_attach_cas_verified` | 真实复现Loom切provider后把旧task发给另一instance、known task响应错ID仍置terminal/触发close，以及unknown并发reconcile覆盖首次确认。修后持久instance/已知taskID与first-attach CAS共同校验；captured transport阻止await中换句柄，原instance恢复同task不重提，迟到冲突409。8个真实签名HTTP/PGlite场景最终CI通过。 | `services/loom-engine/flow/video.ts`、`services/loom-engine/flow/video-provider-instance.test.ts` | 双HTTP worker/provider为受控夹具，不是实际DTK部署。原task漂移复现的parent close是预算stub调用计数，不冒充真实ledger扣费。未声称pre-submit输入上传有新增持久provider绑定。 |
| E33 `authenticated_bounded_document_read_bridge_verified` | 原Web的POST documents/read没有Go路由；已补严格scoped只读桥。固定4字段、1MiB请求上限、10秒、当前read scope/成员/租户/来源撤权校验；Go→Loom真实20页回读与负例通过。最终Cookie/PG/MinIO长输入也已通过。 | `backend/internal/flow/routes_contract.go`、`backend/internal/flow/video_document_read_http_test.go` | 专项Go测试使用认证seam/PGlite；真实session+PG/worker链由E37独立证明。long-input是HTTP验真，不称长文本实际浏览器高亮演示。 |
| E34 `provider_contract_upgrade_rollback_recovery_verified` | 实际Executor/HTTP/SQLite重开/ffprobe：原锁定HTTP契约已接受download→不识别新状态fail closed且零objects→恢复锁定契约，同task/route/外部ID完成，1次submit、3 execution quanta，既有usage保留。独立复跑及最终worker组通过。 | `services/video-knowledge/test_provider_upgrade_rollback_qa.py`、`services/video-knowledge/runtime.py` | 升级对象是合成HTTP契约，不是实际DTK二进制部署；真实测试实例/授权样本/灰度仍属于COL-031原实际环境条件，不把本测试扩成生产回滚。 |
| E35 `mandarin_actual_offline_asr_and_exact_evidence_locally_verified` | CC-BY4固定FLEURS普通话单条→10.38秒无字幕MP4→真实Python签名HTTP/SQLite/FFmpeg→生产ASR HTTP、锁定tiny离线CPU/int8默认VAD→Loom HTTP/PGlite：3原始segments及3宿主证据逐段时间/hash/read_ref通过；最终13文件hash与发布runtime字节一致，独立复跑通过。 | `docs/video-ingestion/AC08-ASR.md`、`docs/video-ingestion/evidence/mandarin-asr-acceptance.json` | 保留“篇章→偏胶”误识别与之前eSpeak空结果FAIL；不新增准确率门槛，不冒称行业质量。专用本地脚本不是默认CI模型执行；PGlite/本地对象非Go浏览器/PG/MinIO。 |
| E36 `final_exact_code_aggregate_ci_verified` | 最终ff03四工作流/13 jobs成功：Flow281/281、fail0/skip0；Go1965顶层pass、5条件skip、0fail，VIDEO_REQUIRED全run+pass；Web2531/333files、worker56/56、ASR7pass/1skip、ledger scripts82+8通过。 | `.github/workflows/video-knowledge.yml`、`.github/workflows/quality.yml` | 整套结果不是100任务全部业务签收。Go条件skip与ASR image-level skip明确保留；AC08实模型另有E35，不把skip改写为pass。ledger结算来自实际host ModelTasks/factory/双binary测试，不来自PG/MinIO observer。 |
| E37 `final_real_application_fullstack_verified` | 实际Chromium登录→Go→Loom→Python→PG/MinIO通过，原生Agent+真实CloudAgent批准/managed Canvas版本/hash/证据/rev2正确；1真实model请求、2 hostile tool_calls、4越权请求拒绝、0外传；candidate60次评测与60gateway收据一一匹配。长输入1432343bytes/459242UTF16/2101段/7parts/23页/526artifact页完整。实际重启身份/对象稳定，撤回后旧pin/cache/同call重读拒绝且候选retired；清理零遗留。 | `scripts/fullstack/run.sh`、`scripts/fullstack/observe.mjs` | 自编输入/严格确定性外部model；不证明真实B站/抖音采集、模型语义质量、Pi自主选工具、候选容器部署或生产上线。long-input报告browser_verified=false；精确文本HTTP/组件高亮证据与实际浏览器短证据各自保留。observer不审Go ledger。 |
| E38 `final_container_notices_and_local_media_capacity_ci_verified` | 最终ff03同SHA容器CI：21附件/490选定源文件SHA/blob/bytes、2个amd64镜像revision与4个binary通知核对。实际worker容量1/2/4并发各6任务、66次fsync对象写；三组低盘拒绝→同task恢复/原usage保留通过。 | `docs/video-ingestion/SUPPLY_CHAIN.md`、`docs/video-ingestion/MEDIA-CAPACITY.md` | 选定源码输入不是全应用发行archive，原PRD也不要求另造archive。容量无模型、局部filesystem非MinIO/host-ready；不冻结生产SLO。未知/特殊许可未被SBOM清算，正式分发责任独立。 |

## 仍可自主推进的动作

本轮已确认的实现缺陷、测试缺口和精确提交复验均已按各自证据范围处理；目前没有已定位但未解决的自主工程动作。这不证明任意潜在缺陷不存在，也不替代原真实平台/质量/试点验收。

## 29个原验收场景

| AC / 原标题 | 当前工程证据 | 原剩余条件 / 下一动作 |
|---|---|---|
| AC01 B站单视频闭环 | 真实宿主内部导入/复核发布/Agent及Canvas证据链完成；平台URL不是实际下载。 | 待合法B站实际获取与已冻结领域配置的原业务验收。 |
| AC02 抖音单视频闭环 | 双平台share-link归一/DTK适配/输入合同已测，内部实际处理可运行。 | 待可用抖音分享短链/授权连接的真实获取；不把fixture当平台成功。 |
| AC03 关闭聊天后的持续执行 | 无前端依赖的两个受控窗口、磁盘重启、4个新job与4个新候选已实际执行。 | 原两个平台真实账号与实际窗口/重新登录验收仍需对应来源；不以加速时钟替代。 |
| AC04 发现分页失败 | 页2失败/429、未知COMMIT、文件库重启、稳定游标/覆盖/累计上限通过。 | 无新自主动作；外部feed合成，不新增浏览器分页故障门禁。 |
| AC05 同一提交重放 | 真实MCP/HTTP/manual/scheduler同scope仅1job/input/process/ready；真实UI重放409亦过。 | 无新自主动作；保留各入口的实际执行范围。 |
| AC06 任务租约与外部结果不明 | PG kill/fence及未知提交/预算恢复通过；新provider namespace/known-ID/first-attach CAS实测阻止错关联。 | 无新自主动作；unknown不盲重投，外部受控provider边界明确。 |
| AC07 取消与晚到回调 | 真实并发FFmpeg取消隔离、PG cancel-ready行锁竞争、晚到/usage与远端cancel状态分离通过。 | 无新自主动作；cancel确认不是供应商物理擦除承诺。 |
| AC08 无字幕视频 | 许可普通话无字幕10.38秒样本、实际离线tiny生产VAD、3原segments/毫秒/hash/read_ref本地重复及独立执行通过。 | 原时间/证据工程条件已证；无新增行业准确率门槛。不是默认CI模型执行、Go浏览器或平台下载。 |
| AC09 长视频与大量segments | 真实worker→Loom和最终Go/PG/MinIO：2101段、459242UTF16、7parts/23正文页完整；失效分段恢复/required缺口门禁有独立证据。 | 无新自主动作；长输入HTTP验真不是实际浏览器长文演示。 |
| AC10 静音画面与并发抽帧 | 真实FFmpeg短片/尾组/两并发取消不混帧、必需视觉失败不能ready均通过。 | 无新自主动作；视觉/OCR/VLM语义质量未从固定响应推导。 |
| AC11 元信息更新 | metadata-only/媒体真正变化的revision/派生正文/旧证据对照回归通过。 | 无新自主动作；不把普通重启等同源刷新。 |
| AC12 中文emoji引用 | 中文emoji/组合字符/重叠段UTF16、quote/hash/time、surrogate拒绝和完整正文回读通过，UI组件高亮有执行证据。 | 无新自主动作；大输入链报告browser_verified=false，保留分层边界。 |
| AC13 就绪屏障与事件重投 | required索引失败不切换ready/旧版本可读、恢复后唯一事件及实际observer ready一致通过。 | 无新自主动作；不将worker完成误作知识发布。 |
| AC14 无依据的事实 | 引用/版本/quote及无依据数值/参数硬门禁、模型不能自授发布已验证；受控缺材料评测管线实际执行。 | 真实所选模型对缺参材料的语义拒答/推断标记及人工判定仍未由确定性fixture证明；与AC27质量输入合并，不说缺实现。 |
| AC15 转载与冲突 | 两转载不计独立佐证、冲突保留两侧版本条件/证据及人工归组拆分受控回归通过。 | 本例可用自编合法材料验证，不新增真实平台前置；K-020授权样本阈值校准仍独立开放。 |
| AC16 复核批准发布与撤回 | 真实UI旧批准失效/冲突、重新批准发布、撤回/刷新默认查询不返回通过。 | 无新自主动作；技术审批/CAS不等待真实行业负责人，正式业务签收不代填。 |
| AC17 跨工作区越权 | 真实第二tenant同bytes不同materialID、selector/读写拒绝，以及对象/fence/scope负例通过。 | 无新自主动作；不从一次fixture推导所有环境安全。 |
| AC18 MCP超时和输出边界 | 实际SDK→MCP→签名Loom短调用后台运行，21页81证据/19395UTF16、read_ref完整回读通过。 | 无新自主动作；不新增另一transport或要求所有负例重跑浏览器。 |
| AC19 内网目标与重定向 | Go/Node/Python实际HTTP redirect目标零请求与固定endpoint/私网/metadata拒绝通过。 | 无新自主动作；不需要真实平台账号验证这些网络边界。 |
| AC20 字幕提示注入 | 恶意字幕实际Agent/真实CloudAgent审批/managed Canvas完成；4权限扩张请求拒绝、2攻击tool_calls无dispatch/外传、registry/install/pin不变。 | 无新自主动作；严格合成model不等于真实LLM鲁棒性/自主选工具证明。 |
| AC21 凭据与限流 | 实际401→token旋转/SQLite重开→429 Retry-After→同download完成；公开投影/日志/存储无key，host工具/prompt/API脱敏与UI状态分层验证。 | 无新自主动作；未实际等待9秒、不冒称真实平台过期账号或同一浏览器内全部secret负例。 |
| AC22 预算耗尽 | 预算关闭/unknown保留/CAS竞态，实际第二tenant零整理预算不发模型任务，真实host父子账本结算及低盘拒绝/恢复通过。 | 无新自主动作；fullstack observer不查询Go ledger，账本证据来自host/factory/双binary测试。 |
| AC23 来源停用到期与撤权 | 停用/正常到期/404/撤权分别处理、独立删除日志、当前旧pin/cache/引用阻断与重放不复活通过。 | 无新自主动作；供应商原始副本/备份的实际保留擦除责任另列，不额外要求删除平台原视频。 |
| AC24 现有功能兼容 | 实际video开关的RSS/Telegram/WeChat、ASR/OCR/检索对照及Loom周期事件→Go managed Canvas均执行。 | 无新自主动作；外部连接/模型与周期测试审批projection为明确fixture。 |
| AC25 实际宿主Agent使用 | 实际intelligence Agent工具桥与真实CloudAgent批准后Canvas原生执行，正确version/hash/snapshot及宿主evidence；重启/撤回后重读验证。 | 无新自主动作；原条款未要求Pi自主工具选择，不新增该门槛。 |
| AC26 Skill评测批准部署安装 | 两次真实源码编译/持久宿主/部署receipt/安装升级回滚及旧pin/当前撤权通过；实际UI60任务批准导出但禁止假安装。 | 无新自主动作；TEST足以验证工程生命周期，UI候选并未声称容器部署，不要求生产发布。 |
| AC27 Skill负向与回归测试 | 同模型/同输入三变体120实际host任务与UI60任务、负向/缺料/回归类别及人工批准门禁运行通过。 | 真实行业固定集/独立人工金标与所选模型结果比较未验收；exact_expected_output_v1不是模型质量结论。 |
| AC28 迁移失败与恢复 | 真实PG第二ALTER失败全事务/ledger回滚、历史revision/evidence保留、dump/restore后pending更高fence继续完成及独立journal重放通过。 | 无新自主动作；兼容发布/版本保留有独立双binary证据，不要求浏览器重演所有DB故障。 |
| AC29 试点持续运行 | 运行/费用/覆盖导出、容量、回滚与故障工程基础已执行；当前不是持续试点记录。 | 待M0真实来源/样本/配置/预算及冻结时长连续运行和结果核对；默认建议7天，不压缩/虚构，TEST不默认要求生产授权。 |

## 100个任务：自身条件与原依赖分开

本表是当前证据范围索引。每条原实施/验收子句、依赖、命名执行记录及具体外部条件都在JSON；表内不将原依赖门禁删除，也不把泛化的“已映射”当整项验收。

| 任务 | 原标题 | 本任务工程范围 | 直接原外部条件 |
|---|---|---|---|
| COL-001 | 锁定宿主与DTK版本、建立真实能力基线 | 已核对的技术范围：基线文档每个现有能力有文件/符号/固定提交引用。 | 无直接输入；原依赖链见JSON |
| COL-002 | 定义视频来源、分页覆盖与媒体manifest契约 | 已核对的技术范围：同一视频链接不同写法归一到同平台ID与part；不同P不合并。 | 无直接输入；原依赖链见JSON |
| FND-001 | 冻结首发行业与业务问题 | 领域配置能力/开发示例存在，但实际行业与责任定义未代填。 | 选定实际行业、5–10个问题、来源使用/保留规则和复核/发布负责人。 |
| FND-002 | 评审跨组件契约和实施责任 | 已核对的技术范围：无互相等待的实现依赖；当前能力、拟新增和验证状态区分；Schema及兼容策略可供各语言生成或验证。 | 无直接输入；原依赖链见JSON |
| FND-003 | 建立授权样本与人工标注基线 | 风险夹具/评测管线和单条许可ASR样本存在，不冒充授权双平台人工金标集。 | 冻结覆盖原风险类别的授权双平台样本、人工标签/答案/评分及负向问题；默认建议规模可由M0校准。 |
| FND-004 | 锁定依赖和开源通知 | 固定依赖/原通知/实际镜像和逐项源输入hash已核；未知许可与分发决定分开。 | 无直接输入；原依赖链见JSON |
| FND-005 | 完成双平台和宿主接口可行性验证 | 受控双adapter、真实宿主/MCP/媒体/本地ASR及资源基线有实跑；平台真实能力分列。 | 实际双平台少量发现/下载/处理能力与目标环境耗时资源测量；受控adapter/宿主执行证据不冒充平台实测。 |
| IF-001 | 冻结宿主接入边界与现有能力基线 | 已核对的技术范围：PRD每项能力标为现有/复用修改/拟新增；不以仓库名或上游README推断已实现。 | 无直接输入；原依赖链见JSON |
| K-001 | 冻结知识处理复用边界与processing profiles | 已核对的技术范围：所有需求可映射到复用或新增模块；不新增BiliNote主RAG/账号系统 | 无直接输入；原依赖链见JSON |
| CFG-001 | 实现工作区领域配置与版本API | 已核对的技术范围：同workspace多领域独立；并发保存冲突可见；配置修改不改变历史run；跨workspace profile引用被拒绝。 | 无直接输入；原依赖链见JSON |
| COL-003 | 增加视频来源和持久作业迁移 | 已核对的技术范围：旧rss/telegram/wechat数据迁移后可读可跑。 | 无直接输入；原依赖链见JSON |
| COL-004 | 接入现有来源创建/修改校验 | 已核对的技术范围：同scope重复创建归一URL按产品约定返回原源或明确冲突。 | 无直接输入；原依赖链见JSON |
| COL-005 | 配置平台凭据和内部服务密钥 | 已核对的技术范围：配置、接口、事件、日志和MCP输出不包含明文secret。 | 无直接输入；原依赖链见JSON |
| COL-006 | 实现受信DTK内部REST适配器 | 已核对的技术范围：DTK健康实例能完成fixture契约调用；schema不匹配返回provider_contract_changed。 | 无直接输入；原依赖链见JSON |
| COL-007 | 归一化B站与抖音元数据 | 已核对的技术范围：B站BV/av/短链与抖音分享文案fixture归一结果稳定。 | 无直接输入；原依赖链见JSON |
| COL-008 | 完成单视频发现与显式导入 | 已核对的技术范围：同一视频重复提交不重复排队；换part产生独立job。 | 无直接输入；原依赖链见JSON |
| COL-009 | 实现作者增量发现与有界分页 | 已核对的技术范围：多页期间插入新视频、置顶旧视频、页面重叠时不漏已有测试窗口。 | 无直接输入；原依赖链见JSON |
| COL-010 | 实现发现结果、任务与游标原子提交 | 已核对的技术范围：在写任务前/后、COMMIT前/后故障注入，恢复后无漏视频且不重复有效job。 | 无直接输入；原依赖链见JSON |
| COL-011 | 复用Loom唯一调度与授予检查 | 已核对的技术范围：coalesce/skip/catch_up测试符合宿主既有语义。 | 无直接输入；原依赖链见JSON |
| COL-012 | 实现video job阶段状态与外部映射 | 持久provider namespace+task identity、合法状态/错误投影、首次确认CAS及恢复已验。 | 无直接输入；原依赖链见JSON |
| COL-013 | 实现下载提交幂等与结果不明处理 | 已核对的技术范围：请求发出后断连再恢复只关联同一有效下载或进入人工可解释reconcile。 | 无直接输入；原依赖链见JSON |
| COL-014 | 实现外部任务轮询与短调用返回 | 已核对的技术范围：数十分钟模拟provider job不占用单次MCP连接。 | 无直接输入；原依赖链见JSON |
| COL-015 | 将下载媒体流式导入现有对象存储 | 已核对的技术范围：大于进程内存预算的测试对象不会被整块Buffer加载。 | 无直接输入；原依赖链见JSON |
| COL-016 | 推广scope媒体对象键并保留访问防护 | 已核对的技术范围：旧Telegram媒体回归可读可转写。 | 无直接输入；原依赖链见JSON |
| COL-017 | 为长阶段作业实现claim/heartbeat/fencing | 已核对的技术范围：杀死worker后另一个worker可恢复；旧worker恢复不能覆盖新结果。 | 无直接输入；原依赖链见JSON |
| COL-018 | 统一provider错误、退避和熔断 | 已核对的技术范围：429、503、DNS超时、认证失效、schema变化分别得到预期状态与下次时间。 | 无直接输入；原依赖链见JSON |
| COL-019 | 取消、恢复和不确定结果对账 | 取消/晚到/unknown意图/同task恢复与provider切换并发负例已验。 | 无直接输入；原依赖链见JSON |
| COL-020 | 接入现有预算与资源准入 | 已核对的技术范围：超预算/超大小/低磁盘水位拒绝或暂停有明确reason。 | 无直接输入；原依赖链见JSON |
| K-002 | 建立raw/source版本与derived证据快照模型 | 已核对的技术范围：原始metadata、媒体hash、derived profile/model版本可独立追踪 | 无直接输入；原依赖链见JSON |
| K-003 | 定义并校验不可变artifact manifest | 已核对的技术范围：MCP摘要不携带无限转录/图片；完整对象可按manifest读取 | 无直接输入；原依赖链见JSON |
| K-027 | 配置首个行业知识profile与术语词表 | 通用研究profile明确零费用/非已冻结行业；模型字段兼容及缺失/冲突示例已验。 | 确认实际首发行业并复核对应profile/词表/边界样例；通用开发profile不是实际行业冻结。 |
| IF-002 | 定义接口责任与作业标识映射 | 已核对的技术范围：批量scan与单视频/分P任务标识明确，provider ID仅内部诊断。 | 无直接输入；原依赖链见JSON |
| IF-003 | 冻结MCP、受信import与ready事件契约 | 已核对的技术范围：Go/TypeScript/Python均能校验同一合法样本，拒绝未知高危字段与错误版本。 | 无直接输入；原依赖链见JSON |
| IF-004 | 建立可信租户上下文与服务调用授权 | 已核对的技术范围：同样source_id从另一workspace或撤权后的grant调用失败，不泄露对象存在性。 | 无直接输入；原依赖链见JSON |
| IF-005 | 验证现有Gateway与视频MCP传输兼容 | 已核对的技术范围：在当前go-sdk客户端上完成initialize、tools/list、tools/call。 | 无直接输入；原依赖链见JSON |
| IF-006 | 实现薄MCP视频入口与宿主域服务适配 | 已核对的技术范围：提交短返回operation_id/video_job_id；建议≤2秒，慢provider操作留在队列。 | 无直接输入；原依赖链见JSON |
| IF-007 | 接通网关幂等键与结果不明对账 | 已核对的技术范围：同workspace、同key、同请求重放返回原job；同key异请求返回409/结构化冲突。 | 无直接输入；原依赖链见JSON |
| IF-008 | 增加精确可信内部MCP网络策略 | 已核对的技术范围：默认私网/loopback/metadata仍拒绝；未列入allowlist的内部域名拒绝。 | 无直接输入；原依赖链见JSON |
| IF-009 | 实现有界结果、分页与错误映射 | 已核对的技术范围：常规响应目标≤8000字符，包含总量/next_cursor/截断标志，不依赖网关rune截断维持JSON完整。 | 无直接输入；原依赖链见JSON |
| IF-010 | 实现受信artifact提交路由与导入receipt | 已核对的技术范围：过期attempt、错误profile/input hash、跨scope对象、伪造manifest和不允许对象地址被拒绝。 | 无直接输入；原依赖链见JSON |
| IF-017 | 嵌入视频来源配置与发现预览UI | 已核对的技术范围：可创建B站/抖音单视频和授权作者来源，预览前若干发现项并显示分页覆盖。 | 无直接输入；原依赖链见JSON |
| COL-025 | Compose和运行角色集成 | 已核对的技术范围：启动不需要重新注册一套业务账号或新建商业平台。 | 无直接输入；原依赖链见JSON |
| COL-029 | 留存、清理与备份恢复 | 已核对的技术范围：恢复后pending job能继续核对外部任务，已ready文档仍可溯源。 | 无直接输入；原依赖链见JSON |
| COL-021 | 可靠交接字幕或媒体输入产物 | 已核对的技术范围：下载worker不需要提前生成转写/视觉manifest。 | 无直接输入；原依赖链见JSON |
| COL-022 | 接收宿主ready回执并映射视频任务完成状态 | 已核对的技术范围：media或字幕输入就绪不等于knowledge_ready。 | 无直接输入；原依赖链见JSON |
| COL-023 | 在ready后驱动现有Monitor/Canvas | 已核对的技术范围：关键词只出现在视频ASR时也可命中；仅简介命中但正文未准备好时不提早提炼。 | 无直接输入；原依赖链见JSON |
| COL-024 | 接入宿主任务可观测性与人工操作 | 已核对的技术范围：一次任务能从来源→host job→provider映射→文档revision追踪。 | 无直接输入；原依赖链见JSON |
| K-004 | 实现字幕来源选择与标准化 | 已核对的技术范围：人工有效字幕优先；自动字幕与ASR来源不会混淆 | 无直接输入；原依赖链见JSON |
| K-005 | 无字幕场景复用宿主ASR并区分失败类型 | 实际无字幕普通话→原ASR segments/时间/hash/引用完成；误识别如实保留，非准确率验收。 | 无直接输入；原依赖链见JSON |
| K-006 | 保留完整ASR segments并移除静默截断 | 已核对的技术范围：2100 segments和400001字符样例不丢尾部，或按明确支持范围拒绝 | 无直接输入；原依赖链见JSON |
| K-007 | 长视频分段拼接与可恢复产物处理 | 已核对的技术范围：中途失败重启后仅处理失效段且不会重复计入已确认产物 | 无直接输入；原依赖链见JSON |
| K-008 | 实现UTF-16原文区间到视频时间轴的映射 | 已核对的技术范围：中文、emoji、组合字符样例通过host精确quote验证 | 无直接输入；原依赖链见JSON |
| K-009 | 转录校对生成新版本并维护证据关系 | 已核对的技术范围：纠正不原地修改被引用版本，旧evidence仍匹配旧quote | 无直接输入；原依赖链见JSON |
| K-016 | 修正定时刷新对derived正文的覆盖语义 | 已核对的技术范围：已ASR视频再次返回同一简介，不导致current正文退回简介 | 无直接输入；原依赖链见JSON |
| K-017 | 实现宿主knowledge_ready原子屏障 | 已核对的技术范围：worker成功但索引失败时不ready、不被普通查询见到 | 无直接输入；原依赖链见JSON |
| K-018 | 复用宿主切块和检索并返回视频证据定位 | 已核对的技术范围：intel_search_documents/read_document可找到已ready视频正文并读取正确revision | 无直接输入；原依赖链见JSON |
| K-019 | 产物幂等与精确去重缓存 | 已核对的技术范围：同视频相同配置重复提交不重复转写/索引/发布 | 无直接输入；原依赖链见JSON |
| K-021 | 定义行业知识单元与候选版本schema | 已核对的技术范围：每条非推断知识至少有固定revision证据；必需字段可验证 | 无直接输入；原依赖链见JSON |
| K-022 | 经宿主网关提炼带证据的知识候选 | 已核对的技术范围：无证据事实、未知evidence_id、错revision、错quote拒绝或标needs_review | 无直接输入；原依赖链见JSON |
| K-023 | 实现候选复核后端状态与并发控制 | 已核对的技术范围：仅有权限reviewer可批准指定候选版本 | 无直接输入；原依赖链见JSON |
| K-024 | 发布知识快照并供宿主Agent安全查询 | 已核对的技术范围：批准但未发布的内容不会被普通Agent知识工具当正式知识返回 | 无直接输入；原依赖链见JSON |
| K-025 | 来源删除与撤销的知识血缘传播 | 已核对的技术范围：擦除后检索/媒体定位/已发布知识不再可访问；缓存与向量同步失效 | 无直接输入；原依赖链见JSON |
| IF-015 | 注册与安装固定原生行业整理Skill | 已核对的技术范围：Skill在原生情报目录可发现并按版本安装，intel_load_skill可读取。 | 无直接输入；原依赖链见JSON |
| K-026 | 稳定方法Skill固定知识快照与引用约束 | 已核对的技术范围：新run固定方法version/hash与知识snapshot；运行中更新不悄悄改变输入 | 无直接输入；原依赖链见JSON |
| IF-011 | 接通ready通知与接口状态投影 | 已核对的技术范围：ready payload含真实document revision/evidence snapshot/profile/hash/coverage，worker不能直接写该事件。 | 无直接输入；原依赖链见JSON |
| IF-012 | 接入Flow工具准入与运行能力快照 | 已核对的技术范围：未批准、被撤销、工具schema漂移的连接不能被Agent调用。 | 无直接输入；原依赖链见JSON |
| IF-013 | 验证手动、Agent、API与定时入口同链路 | 已核对的技术范围：同时通过UI、MCP和定时提交相同请求不会重复provider下载/媒体入库。 | 无直接输入；原依赖链见JSON |
| IF-014 | 把视频引用接入现有intel证据读取 | 已核对的技术范围：Agent检索发布知识可返回稳定host evidence/document revision及起止时间。 | 无直接输入；原依赖链见JSON |
| IF-018 | 嵌入采集批次与视频任务详情UI | 已核对的技术范围：批次统计可展开到单视频/分P，不用provider task ID作为用户主标识。 | 无直接输入；原依赖链见JSON |
| IF-019 | 补齐MCP配置、授权与网络诊断UI | 已核对的技术范围：连接创建/批准/撤销沿用现有workspace admin/platform operator职责，不自建管理员系统。 | 无直接输入；原依赖链见JSON |
| IF-020 | 实现知识候选复核UI | 已核对的技术范围：候选显示原文/时轴证据并可跳转；编辑需要保留修订和审计。 | 无直接输入；原依赖链见JSON |
| IF-021 | 实现转写证据时轴与版本定位UI | 严格scoped正文分页桥、UTF16/emoji边界与固定revision、超长完整回读/组件高亮已验。 | 无直接输入；原依赖链见JSON |
| IF-022 | 统一覆盖、降级与状态文案 | 已核对的技术范围：音频型profile明确“依据语音/字幕”，不能描述为完整视觉理解。 | 无直接输入；原依赖链见JSON |
| IF-023 | 实现任务通知与恢复操作的权限交互 | 已核对的技术范围：收到重复ready通知不重复弹出可执行发布或新建候选。 | 无直接输入；原依赖链见JSON |
| IF-027 | 实现撤回、失效与来源删除影响UI | 已核对的技术范围：撤销后新检索/播放/发布阻断，旧报告显示证据失效而非伪装仍可验证。 | 无直接输入；原依赖链见JSON |
| COL-026 | 本组单元与契约测试 | 已核对的技术范围：契约测试可离线稳定运行并覆盖实际风险分支。 | 无直接输入；原依赖链见JSON |
| COL-027 | 跨服务故障注入与恢复验收 | 已核对的技术范围：无未记录漏视频、无跨scope资产泄露、无过早ready、无重复有效Canvas运行。 | 无直接输入；原依赖链见JSON |
| COL-028 | 授权样本试点、灰度与回滚 | feature-off旧链兼容、PG恢复、持久job/fence和受控回退有证据；真实样本灰度另验。 | 原授权测试workspace双平台样本、实际调度周期和小范围灰度结果；关闭开关/恢复的工程子项单独已证。 |
| IF-029 | 完成租户隔离、注入与权限回归 | 已核对的技术范围：跨workspace任务查询/取消/manifest提交/媒体读取均被阻断且不泄露数据。 | 无直接输入；原依赖链见JSON |
| K-030 | 知识闭环定向验收与故障恢复样本集 | 已核对的技术范围：覆盖KA-01至KA-10：无字幕、鉴权失败、2100段、Unicode、恢复、刷新覆盖、索引失败、旧批准、删除 | 无直接输入；原依赖链见JSON |
| QA-001 | 验收基础闭环的真实宿主路径 | 真实宿主Agent/Canvas、MCP/手动/定时受控链与故障已执行；真实双平台业务覆盖另列。 | 原真实双平台手工/MCP/账号定时完整样本验收；原生宿主Agent/Canvas不能再列未实现。 |
| K-010 | 隔离BiliNote抽帧处理工作目录 | 已核对的技术范围：并发处理两个视频帧、网格和OCR不混淆 | 无直接输入；原依赖链见JSON |
| K-011 | 抽帧策略、尾组保留与视觉覆盖披露 | 已核对的技术范围：短视频与不足一组尾帧有可追溯输出，不因网格不足静默跳过 | 无直接输入；原依赖链见JSON |
| K-012 | 复用宿主OCR并保存帧级文字证据 | 已核对的技术范围：OCR文字绑定frame_id/time/media hash；错误帧可单独重跑 | 无直接输入；原依赖链见JSON |
| K-013 | VLM视觉观察与推断分类型输出 | 已核对的技术范围：每项观察引用实际输入frame_id，幻造帧引用拒绝 | 无直接输入；原依赖链见JSON |
| K-014 | 抽取BiliNote分段总结能力并接宿主网关 | 已核对的技术范围：每个required输入segment/frame在消费清单可见，遗漏会阻断完整成功 | 无直接输入；原依赖链见JSON |
| K-015 | 对齐语音、OCR与视觉证据并处理冲突 | 已核对的技术范围：无足够定位关系时返回unaligned而非猜测同一事实 | 无直接输入；原依赖链见JSON |
| K-020 | 近重复视频与来源独立性治理 | 转载归组不自动成为独立佐证、人工merge/split/CAS/审计与两侧冲突已验；授权阈值校准另列。 | 原验收中的授权正负样本匹配阈值校准；转载不计独立佐证、人工拆分和审计的工程门禁单独已证。 |
| K-029 | 多源冲突与知识更新审阅 | 已核对的技术范围：冲突不按新旧或票数自动覆盖正式知识 | 无直接输入；原依赖链见JSON |
| IF-025 | 实现候选Skill版本与评测审阅UI | 已核对的技术范围：draft/evaluation_running/passed/approved_for_release状态清楚；评测失败或证据撤回不能批准。 | 无直接输入；原依赖链见JSON |
| IF-026 | 实现源控发布包与安装状态追踪 | 已核对的技术范围：approved_for_release、release_package_exported、deployed、workspace_installed各自有真实receipt和状态。 | 无直接输入；原依赖链见JSON |
| K-028 | Skill候选版本、评测与源控发布包 | 已核对的技术范围：候选、approved_for_release、deployed、installed状态分开 | 无直接输入；原依赖链见JSON |
| IF-024 | 扩展帧、OCR与视觉观察证据时轴 | 已核对的技术范围：文字、帧、OCR和观察能按时间联动，不把无证据推断显示为帧原文。 | 无直接输入；原依赖链见JSON |
| COL-030 | 持续覆盖核对与源修订处理 | 已核对的技术范围：模拟旧视频更新与多日分页断层能识别并生成有界补采。 | 无直接输入；原依赖链见JSON |
| QA-002 | 接通Skill源控发布和历史版本保留 | 已核对的技术范围：批准不自动上线；部署后旧run仍能加载原版本，新run可pin新版；撤权的知识不能因回滚复活。 | 无直接输入；原依赖链见JSON |
| COL-031 | 完整V1容量基线与上游升级门禁 | 1/2/4实际worker容量/水位恢复、HTTP契约漂移回退及Loom实例/ID/CAS保持已验；不冒充目标SLO或DTK二进制部署。 | 目标CPU/RAM/磁盘/模型和真实视频分布容量、授权上游测试实例/小范围样本灰度；不得把本地worker基线泛化SLO，完整V1仍取决于原全部验收。 |
| IF-030 | 交付宿主接入运维、升级与兼容文档 | 按现有Compose/API提供接入、兼容/回退和六类诊断；与真实TEST/MCP/恢复/双binary证据对应。 | 无直接输入；原依赖链见JSON |
| K-031 | 知识质量、覆盖与处理成本可观测性 | 已核对的技术范围：任务成功率不替代内容完整率；音频、画面和知识审核覆盖分别显示 | 无直接输入；原依赖链见JSON |
| IF-028 | 完成跨入口端到端与Canvas集成验收 | 实际原生Canvas/当前审批、ready一次性、引用/version/hash/restart/撤回已验；双平台授权样本矩阵另列。 | B站/抖音各字幕、无字幕、长视频及视觉必需授权样本的原覆盖；内部跨入口/真实Canvas/hash/replay工程证据独立保留。 |
| QA-003 | 完成完整首版试点和发布验收 | 原P0/P1工程证据与残余条件归档；不虚构实际持续试点和项目方签收。 | 按M0冻结实际时长持续试点、三基线质量比较、偏差与项目方签收；默认建议7天，不能压缩/虚构，TEST不默认需要生产授权。 |

## 原门槛纠正与责任边界

- IF-030只要求接入/runbook/兼容/六类诊断；QA-002发布包是Skill源包。删除旧ENG-06额外全应用ZIP/离线image/可复现生产构建门禁，仍核真实锁/镜像/原通知/源输入。
- FND-002是技术契约与职责评审，不直接等待行业选择；COL-006/007等明确fixture验收的工程任务不被真实平台输入一概阻塞。未满足原依赖的影响单列。
- AC16审批/CAS/撤回可在TEST真实流程验证；AC15转载/冲突可用合法受控材料验证。行业审核/阈值校准留在原FND/K-020/AC27，不新增到每个技术用例。
- AC08原文是普通话无字幕的segments/时间/引用，不要求任意准确率门槛；已独立取得许可样本并实际运行，不再用缺行业金标或付费API当该工程阻塞。
- AC20实际审批权限隔离不要求真实LLM自主选工具；AC25原文没有Pi自主工具选择门禁；AC26可用真实TEST双binary生命周期，均不新增生产授权要求。
- AC29/COL-028/QA-003的真实试点可在获准TEST进行；只有确需生产/分发行动时另要授权。不得把约定实际时长、真实来源和人工质量用短smoke替代。
- 供应商保留/物理擦除及特殊许可属于明确的部署/分发责任，不把cancel或SBOM当回执/许可清算，也不新增“删除平台原视频”或用户代做工程采证的要求。

## 仍需项目方确认的原输入（不重复发起请求）

沿用 [RUNBOOK第7节](RUNBOOK.md#7-仍需要的真实验收输入)。这些条件只阻塞对应原条款，不是独立工程的借口：

- 首发行业、5–10个实际问题、可信来源/保留规则、知识复核及发布负责人，确认实际profile。
- 可用且获授权的B站/抖音视频与账号连接、范围/期限，覆盖原风险类别的人工标注/答案/负向集；不把单条公开ASR样本替代全部金标。
- 实际质量评测所选模型、目标资源/单价/预算上限，原转载阈值与内容质量人工判断；本轮不擅自用付费API。
- 试点目标TEST环境、角色、样本分布与冻结的实际持续时长（原建议7天）、上游真实测试实例与授权灰度；生产/正式发布仅在确需时另明确授权。
- 实际分发范围、特殊/未知许可证义务与供应商副本/备份的保留擦除责任；工程采证已完成的部分不交回用户重做。

许可/真实发布责任：现有依赖逐项来源/通知/实际镜像证据已核；未知/特殊许可（例如splinetool未取得许可声明、tldraw特殊条款）、实际分发范围/对应源码义务和供应商副本保留擦除由项目发布/运维负责人作明确决定。没有许可证全面清算或生产上线结论。

原100/29对象、文本、依赖和基线hash已校验不变；新的执行证据保留精确提交、原始产物hash与合成/实际边界。没有合并main、生产部署、镜像发布或付费API的新授权。
