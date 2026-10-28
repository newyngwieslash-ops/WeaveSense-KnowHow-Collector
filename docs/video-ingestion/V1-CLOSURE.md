# V1 闭环矩阵：实现、工程证据与业务验收分开记录

> 当前为实施中的审计快照，**最终同源码 SHA 的 CI/整栈结果仍待核对，不宣称完整 V1 已完成**。矩阵不是停止推进的里程碑，也不自动修改 PROGRESS、原 PRD 或任务状态。

## 范围与读取方法

- 原基线提交：`c14b24aec7a9e0def26b5b1c05c67d9ea161dd31`；分支 `feat/knowhow-fullstack-acceptance`。
- 原 **100 个 P0/P1 任务、29 个 AC** 全量保留，7 个 P2 排除；不以完成百分比替代条款。
- [原任务基线](spec/tasks.baseline.json) SHA-256：`0def0d9514aeaac544034dbd6994c76041d35f0c2968011ee02770c86ae2e046`。
- [原 PRD](spec/PRD.baseline.txt) SHA-256：`28f1881f6561cb515bcc6f720f3d9a22fc15dc9bc0c32456a906922d75d7c5a8`。
- [机器可读完整矩阵](evidence/v1-closure-matrix.json) 含每项原文、原依赖、原记录及规范化单项 hash、源码/测试路径、当前证据与具体下一动作。`current_assessment` 和 `evidence_catalog` 优先于为追溯保留的历史检查单。
- **实现证据**表示源码/契约存在；**工程已验证**只表示指定执行边界通过；**业务接受**须满足对应原样本、授权、模型、人审与持续试点条款。三者不能相互代替。
- 合成外部 provider/model 可验证真实内部调度、计费、权限、故障与生命周期；不能证明真实 B站/抖音下载、真实模型准确率、独立人工金标或已经经过试点时长。
- 本次只写本页和 JSON。原文本/依赖未改；旧浏览器环境拒绝不是当前通用 blocker（ROUND2/ROUND3 已有实际 CI 浏览器证据）。不强制把每项数据库/故障测试重新做成浏览器测试。

## 本轮实际结果与执行边界

| 证据 | 当前结果 | 主要源码 / 复跑入口 | 限制 |
|---|---|---|---|
| E01 `narrow_fix_verified` | 基线 retry 在 budgetStatus 等待期间可把 cancelled 改回 queued；独立隔离复现成功。当前最终事务锁/CAS 返回 RETRY_STATE_CHANGED，取消保持且不可再 claim；永久 budget/provider 双竞争回归已补。 | `services/loom-engine/flow/video.ts`、`services/loom-engine/flow/video.test.ts` | 不是整栈/最终提交 CI；原 provider.poll 窗口已有 STALE_FENCE，缺陷精确位于 budgetStatus 窗口。 |
| E02 `local_targeted_verified` | 提炼/评测在已确认终态后使用新 generation，保留历史任务、已完成批次和冻结父预算；unknown 保留原 task/key 对账。retry_wait 与子模型 cancelled 的恢复分支已修，不再沿用旧审计警告。 | `services/loom-engine/flow/video-knowledge-extractor.ts`、`services/loom-engine/flow/video-knowledge-evaluator.ts` | 未重新执行完整最终源码；成功结果无效时是否重试按各模块显式策略，不把模型子任务取消当用户取消。 |
| E03 `checkpoint_execution_failed_canvas_admitted_fix_in_progress` | 实际登录后从 /api/agent/conversations 的真实 Intelligence 工具桥加载 Skill/pin/evidence；真实 Canvas 操作、CloudAgent 审批、managed runner、ModelTasks 与引用写回；重启/同调用重放/撤回检查已接主整栈。另修 pin 写失败无限递归、conversation 请求 DB/RLS 绑定和缓存调用重验。 | `.github/browser/fullstack-native.mjs`、`.github/browser/video-fullstack.spec.mjs` | 原 AC25 不要求 Pi/LLM 自主选择工具，不能新增该门禁。外部模型确定性，不能宣称真实模型/行业质量。 原因及已通过本地生产factory正负回归见E27；下一真实整栈尚未通过，不能跳过。 首次实际整栈已在 native Canvas admitted 120s 失败（E24），不能继续仅写尚未执行。 |
| E04 `local_and_checkpoint_host_ci_verified` | 真实持久 Loom evaluator → Go Gateway/ModelTasks/Billing，2 版本 × 20 cases × 3 variants = 120 个任务，合成计量 3600 micro；真实批准/导出/CLI，先 v1-only 编译宿主再 v2 新 binary 复用持久库，部署/安装/升级/回滚 CAS、旧 pin/hash/snapshot 与当前撤权均通过（52.29s）。 首checkpoint同测试CI又通过55.93s，原始JSONL/hash见E26。 | `backend/internal/flow/video_release_loom_qa_test.go`、`services/loom-engine/validation/video-knowledge/release-loom-qa.ts` | 实际编译 Go 测试宿主的真实路由/registry，不是 cmd/server 容器生产部署；合成模型/资料/复核人，不是行业质量签收。 |
| E05 `implemented_execution_pending` | 主应用浏览器 Skill candidate UI 的 20 × 3 评测、批准、导出与安装禁用已接主 spec；PG evaluator task → Go idem hash → 60 个外部合成 receipt 一一核对。观察器 3 测试/14 破坏场景通过。 | `.github/browser/fullstack-skill-lifecycle.mjs`、`.github/browser/video-fullstack.spec.mjs` | 浏览器出口不声称完成源码构建；双编译安装生命周期由 E04 独立证明。 |
| E06 `local_targeted_verified` | 真实 Python HTTP/SQLite/Processor → Loom/PGlite：2101 段、459242 UTF-16 单元、7 分片、23 页，完整正文/hash/时间逐条对齐；修重叠时间包络、Unicode 预览、视觉帧引用顺序与来源收据。 | `services/loom-engine/flow/video-longinput-qa.test.ts`、`services/loom-engine/flow/video-temporal-projection.test.ts` | 自写字幕和合成模型边界；Go/PG/MinIO 整栈 long-input.json 尚待最终 CI，PGlite 不能替代它。 |
| E07 `local_targeted_verified` | 两条生产 Executor/SQLite/真实 FFmpeg/Processor 同时到 OCR 边界；取消 A 仅清其临时目录，B 仍在运行且帧 hash 不变，随后完成并核验跨 workspace 对象。Python 49 测试通过。 | `services/video-knowledge/test_video.py`、`docs/video-ingestion/LONG-INPUT-VISUAL.md` | OCR 为 fixture；临时目录清理不是远端/保留对象全部擦除，未声称模型语义正确。 |
| E08 `local_and_checkpoint_host_ci_verified` | 实际 Go SDK → MCP → 签名 Loom HTTP → 后台 input/process → ready，21 页/81 evidence/19395 UTF-16；read_ref 恢复超 1200 引用。manual/scheduler/MCP 同 scope 仅 1 job、1 input、1 process、1 ready，异步入口约 36ms。 首checkpoint实际Go CI同测试又通过6.24s（E26）。 | `backend/internal/flow/video_mcp_paging_qa_test.go`、`services/loom-engine/validation/video-knowledge/gateway-paging-loom-harness.ts` | 仅外部 provider 合成；不是原生浏览器点击的四入口逐一重放，也不是实平台长视频。不得由此宣称每个 IF-013 子条款全验收。 |
| E09 `local_targeted_verified` | 真实 scheduler + 迁移后磁盘 PGlite 关闭重开：两平台类型各两个窗口、6 唯一 jobs；页 2 故障/429、Retry-After、中间/末页 COMMIT 回包丢失与回滚、缓冲页/重复/乱序、累计 item/page 上限共 8 项通过。原子写入与重试计数实际修复。 | `services/loom-engine/flow/video-discovery-atomic.test.ts`、`services/loom-engine/flow/video-discovery-recovery.test.ts` | 两窗口按受控时钟，不是实际平台运行周期；本测试只到 jobs，实际下游候选另见 E17。 |
| E10 `checkpoint_pg_migration_restore_verified` | 0031实际SQL事务注入失败→schema/ledger回滚、历史revision/evidence不变、重迁移幂等并claim原未完成任务；PGlite及首checkpoint真实PG均通过。实际pg_dump/pg_restore+独立删除日志与已领取pending跨恢复提升fence并完成亦在本次PG通过，详E25。 | `services/loom-engine/flow/video-migration-recovery.test.ts`、`services/loom-engine/flow/video-qa.test.ts` | 旧数据seed用于迁移保真而非导入能力；实际PG证据已存在，不要求重做浏览器恢复。仅最终增量提交回归仍待。 |
| E11 `local_targeted_verified` | video on/off 各走真实非视频 HTTP/Engine，RSS 200/304/历史 revision、Telegram fixture、ASR/OCR、检索/monitor/调度与输出深等，1 项本地通过。 | `services/loom-engine/flow/video-legacy-compatibility.test.ts`、`services/loom-engine/flow/t21.test.ts` | 外部 RSS/Telegram/ASR/OCR 为 fixture。剩余 WeChat/周期 Canvas 实际双态已由 E22 补齐；两种已执行边界不互相冒充。 |
| E12 `checkpoint_second_tenant_zero_budget_verified_remaining_fullstack_pending` | 首checkpoint失败前原始browser-last-observation确证实际第二tenant同bytes material隔离、zero-curation-budget拒绝；长Unicode、native完成和candidate lifecycle后续步骤不因此通过，见E24。 | `.github/browser/fullstack-bootstrap.mjs`、`.github/browser/video-fullstack.spec.mjs` | browser interception 或数据库 seed 不可替代这些路径；当前不是通过声明。 |
| E13 `local_targeted_verified_final_images_pending` | worker 原 NOTICE 与 backup Loom LICENSE 已纳入镜像；固定 10 包 Python wheel SHA-256 传递闭包，离线 hash 安装/pip check/48 测试通过。实际安装版本、选定源输入、镜像标签/ID、NOTICE 与附件 hash 闭包门禁已补；五个精确 npm 版本已采官方证据。 后续已从固定 Node/MC OCI manifest/layers 验 hash 读取原二进制通知，backup Docker/CI 加同源复制与逐文件回读核对。 实际CI mc --version给出上游commit ee72571936f15b0e65dc8b4a231a4dd445e5ccb6，据此补得固定官方LICENSE 34523字节/git blob be3f7b28e564e7dd05eaf59d64adba1a4065ac0e；新打包仍待CI。 | `docs/video-ingestion/SUPPLY_CHAIN.md`、`docs/video-ingestion/evidence/selected-license-sources.json` | 最终增量同SHA镜像/OS待CI；selected inputs不是全应用发行manifest；NOASSERTION、未知splinetool/特殊许可不是清算。原MC tag API403/GNU503保留历史；后来实际binary给出精确commit，已由新证据取得完整LICENSE，未重试原拒绝路径。对应源码分发/兼容性/商业决定仍开放。 |
| E14 `independent_local_and_checkpoint_pg_verified_final_increment_pending` | 0033 close intent、generation CAS、取消+未知 reserve 在后续授权拒绝后仍安全对账、只读 lookup 已修。独立 reviewer 在当前分文件版执行 6/6 budget recovery 通过（12.446s）；host lookup 终态日志已过。真实 PG cancel/ready 与最终聚合仍待 CI。 首checkpoint真实PG cancel/ready已通过，见E25；不再列为未执行。 | `services/loom-engine/flow/migrations/0033_video_budget_close_intent.sql`、`services/loom-engine/flow/video-budget-recovery.test.ts` | 不是错误地把未知费用视为零或重新开放预算；最终回归/PG 行锁竞争结果待执行。 |
| E15 `local_and_checkpoint_host_ci_protocol_verified` | 实际恶意字幕经 Loom 后台索引/evidence → Go 原生 Skill/ModelTasks；外部合成模型返回攻击 tool_calls，断言未调度工具/未外传/未变 registry 或 pin。本地跨语言测试通过（5.04s）。 首checkpoint实际Go CI同测试又通过5.67s（E26），仍不冒充E21实际审批组合。 | `backend/internal/flow/video_prompt_injection_qa_test.go`、`services/loom-engine/validation/video-knowledge/gateway-paging-loom-harness.ts` | testDB/PGlite/test authority 仅授固定 Skill+model；不是实际模型鲁棒性或完整 UI 审批（后者 E03 待 CI）。 |
| E16 `local_targeted_verified` | 真实 Go SDK/受信委托的 5 类 HTTP 重定向、Node HTTPVideoProvider/platformKnowledgeRuntime 的 10 条 redirect、Python InternalClient 的 5 类 redirect 均保证目标 0 请求；Node/Python 401/429/Retry-After 分类通过。既有私网/IP/固定 endpoint 负例同跑通过。 | `backend/internal/flow/video_transport_security_qa_test.go`、`backend/internal/flow/p5_test.go` | 实际 HTTP 401 语义与既有签名 exp 测试不是真实平台凭据过期/轮换；最终同 SHA CI 与秘密不泄露组合仍分别核对。 |
| E17 `local_targeted_verified` | 真实 scheduler/coordinator/extractor 两个无前端增量窗口和两次磁盘重启；实际流水线形成 4 ready jobs 与 4 个未审批候选，第二窗口恰新增 2 候选，不 seed ready/extraction/candidate。 | `services/loom-engine/flow/video-discovery-candidates.test.ts`、`docs/video-ingestion/DISCOVERY_RECOVERY.md` | 外部 feed/media/model receipt 为合成；不证明真实双平台账号/质量或已经经过现实窗口时长。 |
| E18 `independently_targeted_verified` | 真实 Executor/SQLite checkpoint/HTTP DTK adapter/scoped token-file 重载/ffprobe：下载接受后 401，旋转 token 并重建 Tasks/routes，429 保留 Retry-After=9，再恢复相同 task/external download ID，只有 1 submit/1 object，分P=3/fence=4/3 quanta 与既有 checkpoint 保留；跨 scope 403，两个 token 均不写 execution SQLite。 最新回归让 401/429 body 主动回显两代 key，公开 Tasks.read/error projection、worker stdout/stderr、SQLite/WAL 均无 key/上游私有详情。 | `services/video-knowledge/test_credential_rotation_qa.py`、`services/video-knowledge/dtk.py` | 外部 DTK 和内存 objectstore 明确为 fixture；重建 Python 对象/SQLite 连接，不声称 OS 进程重启；检查 Retry-After 数值但没有等待 9 秒。不是真实账号或实际 UI 渲染；宿主工具/prompt/API 独立脱敏证据见 E20。 |
| E19 `checkpoint_ci_artifact_verified_final_increment_pending` | 首发布 1baf536（tree 与本地 3d29f61 相同）的 container CI 成功；负责人实际下载 ZIP 校对 GitHub digest，解包核对 19 附件/477 选定源文件及两个 amd64 镜像的 revision。 | `.github/workflows/video-container-validation.yml`、`scripts/video-build-provenance.py` | 这是首个 checkpoint 的真实成功，不是后来 Node/MC 通知、npm 采证等未提交增量的最终容器结果；477 文件为该构建选择的源码输入，不是全应用发行证明。 |
| E20 `local_targeted_verified` | 既有宿主 MCP secret 回归重跑通过：server-side 注入凭据，tool output 已脱敏；工具定义/prompt、API view、持久 tool calls 无 token；tenant secret 加密/跨 scope 拒绝和轮换使用新值。结合 E18 视频 worker key-echo 拒绝，而非要求每个负例重做浏览器。 | `backend/internal/flow/mcp_test.go`、`backend/internal/flow/mcp_secrets_test.go` | 分层工程证据，不是同一个真实平台凭据贯穿浏览器的演示。实际 UI 授权/重试时间显示沿用真实组件和最终同 SHA 回归，不新增付费/平台账号要求。 |
| E21 `implemented_actual_approval_execution_pending` | 主整栈自写字幕加入 hostile marker；实际 Agent 拒绝未知网络/安装工具、方法重写和伪造 approval，随后实际 CloudAgent decision→managed Canvas。合成外部模型故意给 2 个恶意 tool_calls，实际内部 trap 观察器要求 0 外传请求、registry/install/pin/snapshot 不变。 | `.github/browser/video-fullstack.spec.mjs`、`.github/browser/fullstack-native.mjs` | 此项才补真实审批组合；不能用 E15 的 test authority 协议回归宣称它已经跑过。外部模型确定性，非真实 LLM 语义鲁棒性。 |
| E22 `local_targeted_verified` | AC24 补齐真实开关传播：Node harness 在实际 Loom video.enabled=false/true 运行真实 WeChat connector/parser/scheduler，产生各 3 个 collection.completed；Go 消费这些真实事件进入 dispatcher/审批校验/managed Canvas，均 2 次成功、第三次额度耗尽、重放不重复。Go 父项+双子项 3/3、6.826s；独立 WeChat HTTP/历史 revision/FTS 双态对照 1/1、约4.7s。 | `backend/internal/app/cloud_agent_video_legacy_compatibility_test.go`、`services/loom-engine/validation/video-knowledge/legacy-cycle-harness.ts` | WeChat gateway/model/已批准持久计划为明确 fixture，不是实际 CloudAgent decision路由。最初仅 Setenv+重复旧 Go 测试的空双态方案已撤换，不作为通过证据。 |
| E23 `local_measured_capacity_and_recovery_verified` | 真实签名 worker HTTP→SQLite队列→FFmpeg/Processor→fsync局部对象，6×6秒/320×180/10fps/无模型，依次1/2/4workers校准，实测峰值claim分别1/2/4。实际磁盘水位拒绝不发布，恢复后同task重试完成且保留usage；发现并修复早期磁盘压力已写usage后resume缺ocr/asr/frame计数导致PROCESSOR_FAILED。 最新完整 Python worker 55/55 通过（13.225s），含新增真实32MiB子进程计量与压力恢复回归。 | `services/video-knowledge/capacity.py`、`services/video-knowledge/test_capacity.py` | 真实局部媒体基线，不是30次控制QPS；OCR固定fixture，无DTK/ASR/VLM质量、无MinIO/Go/Loom knowledge-ready。20ms进程树sum-RSS非cgroup精确峰值、可能漏短峰/重计共享页；安全提高水位不证明OOM安全或生产内存上限，不冻结生产SLO/推荐并发。 |
| E24 `checkpoint_fullstack_failed_with_observed_partial_checks` | 首 checkpoint 整栈实际执行失败：审批前 run=403，真实批准后 run=202，但 managed Canvas 留在 admitted 120s 未执行，不能称 AC25 或完整整栈通过。失败前原始 browser-last-observation 明确记录真实登录/导入/复核发布、实际第二 tenant 同bytes隔离、zero-curation-budget拒绝成功；这些子结果保留，不扩成后续链路成功。 | `.github/browser/fullstack-native.mjs`、`.github/browser/video-fullstack.spec.mjs` | 运行以 exit1 结束；long-input、candidate UI、restart/withdraw、后来新增 hostile real-approval组合不能由前置 checks 推定通过。故障诊断/修复继续，不归咎业务输入。 |
| E25 `checkpoint_postgresql_ci_verified_final_increment_pending` | 首 checkpoint integration 六 jobs 全成功；真实 PG Flow suite 265/265、fail0、skip0。具体日志：12:37:44 ok117 cancel-waits-ready行锁竞争；12:39:51 ok168 AC28 failed additive migration；12:40:27 ok187 R25/K025真实dump/restore（含已领取pending换更高fence并完成）。 | `services/loom-engine/flow/video-cancel-ready-pg.test.ts`、`services/loom-engine/flow/video-migration-recovery.test.ts` | 这是精确1baf536已执行的PG/集成证据；后续媒体/兼容/notice/hostile/调度修复增量仍需最终CI。265测试不等于265原PRD任务或业务验收。 |
| E26 `checkpoint_host_ci_verified_with_explicit_skips` | 首checkpoint实际Go host CI原始JSONL确认：120 ModelTasks/3600 micro/双parent关闭、双binary TEST安装升级回滚/历史pin/撤回通过（55.93s）；真MCP长分页6.24s、跨语言Gateway3.41s、恶意字幕受控协议5.67s通过。 | `backend/internal/flow/video_release_loom_qa_test.go`、`backend/internal/flow/video_mcp_paging_qa_test.go` | host日志有5个命名test skip：两个compiled-child入口由父测试在真实子binary单独执行，另为既有live DDCat/browser identity/payment binary条件；不得写Go全零skip。它不替代失败的实际浏览器nativeCanvas。 |
| E27 `production_composition_fix_locally_verified_fullstack_retest_pending` | 定位首checkpoint admitted故障：service.New安装projection guard后repo.DB()是新GORM session，main却把原句柄交给Tools/ModelTasks/runner，严格identity返回ErrInvalid。newRuntimeService让后续生产组件共用guarded句柄，保留guard/RLS/严格identity。生产同factory回归先证明旧组合ErrInvalid，修后真实CloudAgent批准→periodic-brief原生Skill→ModelTasks→一次模型调用→Canvas revision2、父子预算settled。 | `backend/cmd/server/main.go`、`backend/cmd/server/runtime_service.go` | 模型和evidence-resolution HTTP为明确fixture，原生registry/真实approval/计费/Canvas写回真实；不是video-knowledge-core+真实Loom/PG/完整浏览器路径。实际fullstack必须在下一精确SHA重跑。 |
| E28 `safe_diagnostics_and_required_execution_gate_locally_verified` | wakeCanvasWorkflow不再静默丢弃runner错误：只记录服务端run_id、固定reason/status，不记录错误正文、secret或材料。17类安全分类加既有T17/T22回归通过1.848s。CI --require-video新门禁要求真跨语言/MCP/协议注入/双编译/实际周期Canvas与生产factory命名测试实际run+pass，skip也失败；门禁3测试通过。 | `backend/internal/app/cloud_agent_workflow.go`、`backend/internal/app/cloud_agent_workflow_logging_test.go` | 诊断不放宽授权、不篡改持久恢复状态；新CI门禁本身待下一源码提交执行，不能把已跳过的旧测试反写成通过。 |

测试归属：E01 的基线/补丁窄复现与 E18 凭据轮换由独立审计实际执行；其余新测试由实现负责人执行，审计检查源码、可得终态日志或明确归属的报告。E04/E07/E09/E13/E18 的本地日志 hash 在 JSON 中；本地忽略日志不是已经上传的 CI 产物。负责人报告 Web 2531 项通过、typecheck/build 通过，Flow 先前 237 pass / 7 skip、scripts 75 pass；其后仍有源码变动，**这些不是最终提交整套通过结论**。

## 尚可自主推进的工程闭环

1. **ENG-01（composition_fix_locally_verified_final_fullstack_required）**：E27已修真实nativeCanvas production DB组合并局部验证；发布最终增量后执行同SHA聚合/整栈/镜像，核实际receipt/hash/截图。 首checkpoint容器/integration成功、fullstack失败；不能把factory局部PASS冒充下一完整视频core/Loom/PG路径PASS，新增hostile/兼容/容量/通知同样需最终CI。
1. **ENG-02（checkpoint_pg_and_local_recovery_verified_final_increment_pending）**：E14本地预算恢复6/6及E25真实PG cancel-ready/失败迁移/pending restore均已过；只保留最终增量适用回归，不重开已证实缺口。 保留精确1baf536成功与后续最终源区别，不将旧绿灯覆盖新修复。
1. **ENG-03（local_protocol_verified_actual_hostile_approval_in_progress）**：E17 AC03 新候选、E15 AC20 协议攻击、E16 HTTP 边界本地已过；另将恶意资料/恶意 tool_calls 接真实 CloudAgent 审批整栈并执行最终 CI。 E15 的测试 authority 不能冒充真实审批决策层；不重开其已通过协议边界。
2. **ENG-04（layered_engineering_verified_final_regression_pending）**：E18 worker 凭据轮换/公开投影/日志/SQLite key不泄露和 E20 宿主 tool/prompt/API 独立边界已过；仅保留最终组件/集成回归，不重开该工程缺口。 分层证据如实保留，不要求所有 fault 再跑浏览器；不声称实际平台账号或完整 UI 同场景演示。
2. **ENG-05（local_engineering_verified_final_regression_pending）**：E22 实际开关传播的 WeChat/周期 Canvas 对照、E23 局部媒体1/2/4并发容量和低盘失败恢复已执行；将新源码/报告纳最终回归与交付。 这些具体原工程缺口不再列未实现；无模型/局部文件系统基线不泛化生产SLO或替代原授权样本/全流程验收。
2. **ENG-06（final_artifact_pending）**：同 SHA 镜像/已安装依赖/NOTICE/选定源输入附件闭包与完整发行包证据；保留许可未知项，不把 SBOM 当清算。 工程采证独立可做；最终商用分发授权/义务确认是另外的业务决定。

已完成的窄缺口不重开：真实双并发取消隔离（E07）、受控分页故障/磁盘重启（E09）、真实 MCP 长分页/同域重放（E08）、双版本真实编译生命周期（E04）已有本地执行结果。后续要求是受影响代码回归与最终提交结果，不是把它们重写为“未实现”。

## 29 个原验收场景

| AC / 原标题 | 已有具体实现/执行证据 | 当前剩余动作与边界 | 外部条件 |
|---|---|---|---|
| AC01 B站单视频闭环 | 宿主内部导入/复核/发布已有 ROUND3；真实 Agent 引用入口 E03 已补。 | 运行 E03 的最终整栈；合法 B站实际获取与领域人工验收仍须独立记录。 | B-DOMAIN, B-SAMPLES, B-LIVE-PLATFORM |
| AC02 抖音单视频闭环 | 双平台 adapter 与输入路径存在；ROUND3 平台 URL 仅标识而非下载。 | 受控 DTK share-link 路由回归可自主完成；真实抖音短链/授权连接和媒体样本仍未验收。 | B-SAMPLES, B-LIVE-PLATFORM |
| AC03 关闭聊天后的持续执行 | E09 无前端双窗口/故障重启新 jobs，E17 真实下游 4 个新候选/两次磁盘重启均本地通过。 | 最终同 SHA 回归；受控时钟与合成 feed 不替代真实双账号窗口/重新登录业务验收。 | B-LIVE-PLATFORM |
| AC04 发现分页失败 | E09 八项真实持久发现故障/重启/COMMIT 不确定恢复通过。 | 纳入最终同 SHA 聚合；不重新发明一套浏览器分页故障测试。 | 受控工程不需用户输入 |
| AC05 同一提交重放 | E08 真 MCP/HTTP/manual/scheduler 同域仅一次 job/input/process/ready。 | 执行最终同 SHA 跨语言回归；结合既有 UI 重复提交证据，不把语义重放扩成四种全新流程。 | 受控工程不需用户输入 |
| AC06 任务租约与外部结果不明 | 既有 PG 双连接/SIGKILL/fence 加 E01 修复；预算不确定恢复 E14 正在最终校验。 | 实际 PG 竞争与预算新代码回归待跑；未知外部结果保持 reconcile，不能盲重投。 | 受控工程不需用户输入 |
| AC07 取消与晚到回调 | E01取消不复活、E07真实并发worker取消隔离已过；E25首checkpoint实际PG cancel-waits-ready行锁竞争已过。 | 仅最终增量回归；不再把PG竞争列为未执行，不把cancel当外部擦除。 | 受控工程不需用户输入 |
| AC08 无字幕视频 | 无字幕分段/ASR adapter 与受控故障路径有测试。 | 许可允许的实际 ASR/中文无字幕样本与人工准确性另验；不能以缺样本否定已实现的 adapter。 | B-SAMPLES, B-MODEL-QUALITY |
| AC09 长视频与大量segments | E06 真 worker→Loom 长输入通过；E08 长引用 MCP 分页通过。 | 执行 E12 的 Go/PG/MinIO 最终 long-input.json；现有长输入实现不再标未实现。 | 受控工程不需用户输入 |
| AC10 静音画面与并发抽帧 | E07 真实并发 FFmpeg 取消隔离及短片/尾组已有通过；视觉缺失/派生材料门禁已补。 | 最终 worker/视觉聚合；实际 OCR/模型语义须另据授权模型样本，不重做已经通过的并发测试。 | 受控工程不需用户输入 |
| AC11 元信息更新 | 现有 video.test K016/COL030 覆盖 metadata-only 与历史重查、固定 revision；当前代码未发现新缺失模块。 | 保留精确更改媒体/仅元信息对照断言并跑最终回归，不拿普通 restart 冒充刷新。 | 受控工程不需用户输入 |
| AC12 中文emoji引用 | E06/E08 已覆盖中文/emoji/重叠段、UTF-16/hash、全量回读；修 split-surrogate 预览。 | 执行 E12 真实界面与整栈断言；低层通过不是浏览器高亮通过。 | 受控工程不需用户输入 |
| AC13 就绪屏障与事件重投 | 既有 ready/indexing 原子测试；E06 必需分支/错误范围拒绝，PG cancel-ready 新竞争已写。 | 最终 PG 原子/事件回放结果；保留旧 ready 在新索引失败期间可读及 exactly-once 下游断言。 | 受控工程不需用户输入 |
| AC14 无依据的事实 | 真实验证器拒绝虚构 evidence/hash/revision/无依据数值和单位。 | 最终提炼/原生 Skill 对照运行；真实模型拒答与人工行业判断不能由固定 fixture 替代。 | B-MODEL-QUALITY |
| AC15 转载与冲突 | 来源独立性、转载 merge/split 与冲突版本/证据治理存在。 | 最终合成多源冲突回归；合法原件、转载关系和人工独立性标签另验。 | B-SAMPLES |
| AC16 复核批准发布与撤回 | ROUND3 实际 UI 审批/编辑/失效发布/重发/撤回；后端并发 CAS 门禁已有。 | 最终整栈保留重放/撤回；正式审核责任人业务签收未提供，不等同缺工程代码。 | B-DOMAIN |
| AC17 跨工作区越权 | E24首checkpoint原始browser-last-observation确认实际第二tenant同bytes材料ID读写/selector隔离通过。 | 保留最终增量回归；整个fullstack仍因后续nativeCanvas失败，不能由单项通过宣称整体通过。 | 受控工程不需用户输入 |
| AC18 MCP超时和输出边界 | E08 实际 SDK/HTTP/MCP/签名 Loom 的异步入口与全 cursor 回读本地通过。 | 最终同 SHA 跨语言 CI；无须为同一短调用/有界输出另造 transport。 | 受控工程不需用户输入 |
| AC19 内网目标与重定向 | E16 三语言实际 HTTP 重定向负例、Go 私网/metadata/固定内部 endpoint 限制本地通过。 | 最终同 SHA 安全聚合；该具体独立工程缺口不再列待实现，不需真实平台账户。 | 受控工程不需用户输入 |
| AC20 字幕提示注入 | E15 恶意字幕→真实 Loom evidence→Go Skill/ModelTasks 返回攻击 tool_calls，未授权 dispatch/外传/registry/pin 变更均拒绝。 | 真实 CloudAgent 审批的 hostile 扩权组合正在加整栈，待最终 CI；E15 test authority 不证明此层，固定模型不证明真实 LLM 鲁棒性。 | 受控工程不需用户输入 |
| AC21 凭据与限流 | E09 持久 429/Retry-After、E16 HTTP401/429、E18 worker token 旋转/同下载恢复及 key回显不泄露、E20 宿主 tool/prompt/API 脱敏均通过。 | 对应独立工程缺口按这些分层边界闭合，最终组件/集成回归仍待同 SHA CI；不虚构真实平台凭据或实际9秒等待。 | 受控工程不需用户输入 |
| AC22 预算耗尽 | E14预算恢复独立6/6及E25 PG通过；E24原始浏览器报告确认zero-curation-budget拒绝且无外部task。 | 最终增量费用/资源账本回归；这些子项已过，不再列全部预算未验证。 | 受控工程不需用户输入 |
| AC23 来源停用到期与撤权 | 停用/媒体过期/撤权/删除日志与历史快照阻断已有工程证据。 | 最终现有保留策略回归；provider 物理文件/备份擦除仍需独立回执，继续真实显示 separate_retention_required。 | B-PROVIDER-ERASURE |
| AC24 现有功能兼容 | E11 RSS/Telegram/ASR/OCR/检索/monitor 双态已过；E22 实际 Loom 开关传播的 WeChat 周期事件→Go managed Canvas 与独立 WeChat revision/FTS 对比已过。 | 既有独立工程缺口已补齐，执行最终同SHA适用回归；外部网关/模型/批准计划fixture如实保留，不冒充真实decision。 | 受控工程不需用户输入 |
| AC25 实际宿主Agent使用 | 首checkpoint实际nativeCanvas admitted120s失败已定位为main guardedDB句柄不一致；E27生产同factory真实批准→原生执行/结算/写回正负回归通过。 | 下一精确SHA重跑video core+真实Loom/PG完整整栈；局部factory修复不自动关闭AC25，不放宽identity/guard或增加超时规避。 | 受控工程不需用户输入 |
| AC26 Skill评测批准部署安装 | E04 双版本真实编译生命周期通过；E05 主应用 candidate UI 实际路由已接。 | 最终 E04 回归及 E05 浏览器结果；隔离 TEST 足以验证工程条款，不要求未经授权的生产部署。 | TEST 工程无需生产授权；真实行业质量另见 AC27 |
| AC27 Skill负向与回归测试 | E04 120 个实际 ModelTasks/三变体；E02 failed/cancelled/unknown 等恢复与负例回归。 | 最终固定评测/审批 UI 回归；精确字符串评分不是行业人工质量验收，需独立金标。 | B-DOMAIN, B-SAMPLES, B-MODEL-QUALITY |
| AC28 迁移失败与恢复 | E25首checkpoint实际PG failed additive migration与真实dump/restore（pending提升fence并完成）均通过；独立删除日志证明保留。 | 最终增量回归；不再列为缺少真实PG恢复证据，不要求同一浏览器重新覆盖全部故障。 | 受控工程不需用户输入 |
| AC29 试点持续运行 | 工程 metrics/export/feature-off/restore 与合成 TEST 基础已实现；E13 分发门禁增强。 | 工程项继续至最终 CI；真实行业/授权双平台/模型费用/负责人/保留期/实际约定持续试点独立开放，不能用加速 smoke 填满。 | B-DOMAIN, B-SAMPLES, B-LIVE-PLATFORM, B-MODEL-QUALITY, B-PILOT, B-PRODUCTION-RELEASE |

## 100 个任务的当前动作索引

逐字原实施/验收条款、依赖及完整源码路径见 JSON 的 `tasks[].original_task`。下表只是当前动作摘要，不能覆盖原条款。证据编号只证明该编号所述子场景；“既有映射”表示原源码/测试路径已核实存在，但审计未重新执行整项，也不据此新增缺失实现结论。

| 任务 | 原标题 | 证据 | 当前具体动作 |
|---|---|---|---|
| COL-001 | 锁定宿主与DTK版本、建立真实能力基线 | 既有映射 | 保留固定宿主/DTK 能力边界，不写未测平台成功率。 |
| COL-002 | 定义视频来源、分页覆盖与媒体manifest契约 | 既有映射 | 最终三语言合同/平台身份与拒绝变体回归。 |
| FND-001 | 冻结首发行业与业务问题 | 既有映射 | 等待真实行业、5–10 问题、规则和审核/发布负责人；开发 profile 不冒充冻结。 |
| FND-002 | 评审跨组件契约和实施责任 | 既有映射 | 技术契约评审有据；业务 profile 前置确认独立保留。 |
| FND-003 | 建立授权样本与人工标注基线 | 既有映射 | 合成风险集可继续维护；授权样本与人工金标尚待提供。 |
| FND-004 | 锁定依赖和开源通知 | E13, E19 | 最终同 SHA 镜像/源输入/通知闭包；特殊未知许可由负责人确认。 |
| FND-005 | 完成双平台和宿主接口可行性验证 | 既有映射 | 继续受控双 adapter 可行性；真实平台/模型与资源估算另据实际输入。 |
| IF-001 | 冻结宿主接入边界与现有能力基线 | E27 | 保留唯一 Loom 调度/人工发布边界，不新增工作流引擎。 |
| K-001 | 冻结知识处理复用边界与processing profiles | 既有映射 | 验证 required/optional/limit 合同；业务专属 profile 另冻结。 |
| CFG-001 | 实现工作区领域配置与版本API | 既有映射 | 最终多 profile/stale-save/跨 scope/历史配置不可变回归。 |
| COL-003 | 增加视频来源和持久作业迁移 | E10, E11, E22, E25 | E10/E25实际PG失败迁移和E11/E22旧链双态已过；最终增量回归。 |
| COL-004 | 接入现有来源创建/修改校验 | 既有映射 | 真实来源创建/编辑去重和权限、无第二 cron 副作用。 |
| COL-005 | 配置平台凭据和内部服务密钥 | E16, E18, E20 | E18 worker 凭据轮换/key回显脱敏、E20 宿主 tool/prompt/API 独立脱敏已过；最终组件/集成回归。 |
| COL-006 | 实现受信DTK内部REST适配器 | E16 | 固定 DTK HTTP 合同/漂移拒绝；真实账号能力另验。 |
| COL-007 | 归一化B站与抖音元数据 | 既有映射 | BV/av/短链/分享文本及缺字段归一化回归，不造 ID/时间。 |
| COL-008 | 完成单视频发现与显式导入 | 既有映射 | 实际提交同视频/分P与断线后同 job 对账。 |
| COL-009 | 实现作者增量发现与有界分页 | E09 | E09 故障/缓冲/累计界限已过，纳入最终聚合。 |
| COL-010 | 实现发现结果、任务与游标原子提交 | E09 | E09 页事务与 COMMIT 不确定恢复已过，最终串行/并发回归。 |
| COL-011 | 复用Loom唯一调度与授予检查 | E09, E17 | E09 无前端双窗口、E17 实际新候选/两次磁盘重启均通过；最终 CI。 |
| COL-012 | 实现video job阶段状态与外部映射 | 既有映射 | 最终状态边/CAS/provider-instance 映射与 UI 投影。 |
| COL-013 | 实现下载提交幂等与结果不明处理 | E18 | E18 同 task/externalID 不重提已验；保留 accepted-response-loss 的原 intent 对账。 |
| COL-014 | 实现外部任务轮询与短调用返回 | E08 | E08 真异步短调用已过；最终 pending/poll/restart 回归。 |
| COL-015 | 将下载媒体流式导入现有对象存储 | E16 | 流式对象 hash/大小/中断恢复与 SSRF 组合证据核对。 |
| COL-016 | 推广scope媒体对象键并保留访问防护 | 既有映射 | 非视频 scoped-media 兼容及编码/跨 scope 负例回归。 |
| COL-017 | 为长阶段作业实现claim/heartbeat/fencing | 既有映射 | 保留真实 PG SIGKILL/fence，执行新 PG cancel/ready 竞争。 |
| COL-018 | 统一provider错误、退避和熔断 | E09, E16, E18, E20 | E09 持久 Retry-After、E16 真实 HTTP401/429、E18 旋转凭据恢复已过；最终 circuit/宿主状态回归。 |
| COL-019 | 取消、恢复和不确定结果对账 | E01, E14, E18, E23, E25 | E01 已修已窄验；E14 close/lookup 与 PG late-result 结果待定。 |
| COL-020 | 接入现有预算与资源准入 | E12, E14, E24 | E14 新预算回归及 E12 zero-budget；费用/资源账本分别核对。 |
| K-002 | 建立raw/source版本与derived证据快照模型 | 既有映射 | 最终旧 DB raw/derived/revision/hash 与跨 scope FK 回归。 |
| K-003 | 定义并校验不可变artifact manifest | E06 | 合同 tamper/覆盖/帧 provenance 及 E06 长输入最终回归。 |
| K-027 | 配置首个行业知识profile与术语词表 | 既有映射 | 开发通用例可用；首发行业术语/缺失/冲突金标待业务输入。 |
| IF-002 | 定义接口责任与作业标识映射 | 既有映射 | 核对 source/profile/revision/operation/job/provider 唯一写者与责任。 |
| IF-003 | 冻结MCP、受信import与ready事件契约 | 既有映射 | 最终 Go/TS/Python 同合同与 fence/version/ready 负例。 |
| IF-004 | 建立可信租户上下文与服务调用授权 | E12, E24 | E24首checkpoint实际第二tenant同内容隔离已观察通过，最终增量回归。 |
| IF-005 | 验证现有Gateway与视频MCP传输兼容 | E08, E26 | E08 真 SDK initialize/tools/call/分页已过，最终 CI。 |
| IF-006 | 实现薄MCP视频入口与宿主域服务适配 | E08, E26 | E08 真 MCP 异步后台同 job 已过，保留 scoped cancel 回归。 |
| IF-007 | 接通网关幂等键与结果不明对账 | E08, E20 | E08 跨入口 replay 已过；预算响应丢失新路径待最终回归。 |
| IF-008 | 增加精确可信内部MCP网络策略 | E16 | E16 三语言真实 HTTP redirect 与固定服务边界通过，最终 CI。 |
| IF-009 | 实现有界结果、分页与错误映射 | E08, E26 | E08 21 页/read_ref/Unicode 已过，最终输出 cap 回归。 |
| IF-010 | 实现受信artifact提交路由与导入receipt | 既有映射 | 最终可信 import receipt、旧 fence/hash/scope/parent 负例。 |
| IF-017 | 嵌入视频来源配置与发现预览UI | 既有映射 | 最终来源/作者预览、授权撤回、Cancel/Back/reload UI。 |
| COL-025 | Compose和运行角色集成 | E11, E22 | E11 与 E22 legacy真实video on/off对比已过；最终精确提交兼容回归。 |
| COL-029 | 留存、清理与备份恢复 | E10, E25 | E25实际PG pending restore换fence/完成与迁移失败已过；外部擦除单独回执。 |
| COL-021 | 可靠交接字幕或媒体输入产物 | 既有映射 | 最终合法输入上传/中断/取消/hash 与 input_ready 非 ready 门禁。 |
| COL-022 | 接收宿主ready回执并映射视频任务完成状态 | 既有映射 | 最终 ready/revoke 重投不复活、不重计费、不重触发。 |
| COL-023 | 在ready后驱动现有Monitor/Canvas | E17, E22 | E17 scheduler→candidate 已过，保留 ready→Monitor/Canvas 一次性回归。 |
| COL-024 | 接入宿主任务可观测性与人工操作 | E17, E28 | E28 runner安全固定分类warn已验；真实operation/job/stage/revision/费用coverage与最终UI回归。 |
| K-004 | 实现字幕来源选择与标准化 | 既有映射 | 最终字幕优先级/语言/空输入/时轴与 provenance 回归。 |
| K-005 | 无字幕场景复用宿主ASR并区分失败类型 | 既有映射 | ASR adapter 工程可独立验；真实中文无字幕精度需授权样本/模型。 |
| K-006 | 保留完整ASR segments并移除静默截断 | E06, E12 | E06 2101 段完整分片已过，E12 实际 PG/MinIO long-input 待 CI。 |
| K-007 | 长视频分段拼接与可恢复产物处理 | E06, E23 | E23修复早期低盘失败后缺计数的真实resume缺陷；最终worker/分片/usage回归。 |
| K-008 | 实现UTF-16原文区间到视频时间轴的映射 | E06, E12 | E06/E08 Unicode 已过，E12 界面精确引用/高亮待 CI。 |
| K-009 | 转录校对生成新版本并维护证据关系 | 既有映射 | 最终 UI 转写 CAS/旧证据保留/审批失效与并发编辑。 |
| K-016 | 修正定时刷新对derived正文的覆盖语义 | 既有映射 | 保留 metadata-only 对照和媒体变化新输入/历史证据断言。 |
| K-017 | 实现宿主knowledge_ready原子屏障 | 既有映射 | 最终 required indexing 失败/旧 ready 可读/事件 exactly-once。 |
| K-018 | 复用宿主切块和检索并返回视频证据定位 | E08 | E08 全量回读已过；真实搜索尾部与当前撤回拒绝回归。 |
| K-019 | 产物幂等与精确去重缓存 | 既有映射 | 最终相同/变化 input-profile-model 精确缓存与跨 tenant 不泄露。 |
| K-021 | 定义行业知识单元与候选版本schema | 既有映射 | 已有 evidence/types/missing/conflict 验证；最终负例回归。 |
| K-022 | 经宿主网关提炼带证据的知识候选 | E02, E17 | E02 终态重试已修；真实提炼错误引用/无依据数值回归。 |
| K-023 | 实现候选复核后端状态与并发控制 | 既有映射 | 已有人工审批/版本 CAS；最终多复核者冲突回归。 |
| K-024 | 发布知识快照并供宿主Agent安全查询 | E03 | E03 Agent published-only snapshot/撤回路径待整栈。 |
| K-025 | 来源删除与撤销的知识血缘传播 | 既有映射 | 停用/过期/404/撤权区分；独立日志恢复与外部擦除边界。 |
| IF-015 | 注册与安装固定原生行业整理Skill | E03, E15, E21, E24, E27 | E27生产guardedDB组合已修并通过真实factory批准/原生执行；下一精确SHA视频core整栈待重跑。 |
| K-026 | 稳定方法Skill固定知识快照与引用约束 | E03, E04, E15, E21, E27 | E04 旧新 pin/撤权已过；E03 实际入口待整栈。 |
| IF-011 | 接通ready通知与接口状态投影 | 既有映射 | 最终 ready outbox 重启/乱序/撤回投影回归。 |
| IF-012 | 接入Flow工具准入与运行能力快照 | 既有映射 | 实际 Agent 能力 snapshot、未批准/撤回/schema 改变拒绝。 |
| IF-013 | 验证手动、Agent、API与定时入口同链路 | E08 | E08 manual/API/MCP/scheduler 同链已过；保留 Agent 宿主入口断言。 |
| IF-014 | 把视频引用接入现有intel证据读取 | E03 | E03 实际 Agent 读取冻结 revision/hash/time 与撤回待整栈。 |
| IF-018 | 嵌入采集批次与视频任务详情UI | 既有映射 | 最终批次/分P pending/auth/reconcile/cancel/reload 真 UI。 |
| IF-019 | 补齐MCP配置、授权与网络诊断UI | E20 | 现有 MCP 配置授权诊断实际 UI；错误无秘密/无全局 SSRF bypass。 |
| IF-020 | 实现知识候选复核UI | 既有映射 | ROUND3 真 UI 已有；最终并发/撤回/missing-evidence 回归。 |
| IF-021 | 实现转写证据时轴与版本定位UI | E06, E12 | E06/E08 长 Unicode 已过；E12 浏览器与文本/媒体授权区分。 |
| IF-022 | 统一覆盖、降级与状态文案 | 既有映射 | 最终 coverage/degraded/auth/retry 文案与实际状态一致。 |
| IF-023 | 实现任务通知与恢复操作的权限交互 | E01, E02, E14, E18, E20, E25, E28 | E01/E02 恢复修复已落地；E14 新预算/恢复 UI 最终验证。 |
| IF-027 | 实现撤回、失效与来源删除影响UI | 既有映射 | 最终删除依赖预览/CAS/部分失败/旧报告失效 UI。 |
| COL-026 | 本组单元与契约测试 | E16, E28 | 最终同 SHA 合同/core/legacy 聚合，失败不得继承旧 pass。 |
| COL-027 | 跨服务故障注入与恢复验收 | E01, E07, E09, E14, E18, E23, E25 | E01/E07/E09 新 fault 已过，E10/E14 PG 恢复/竞争待 CI。 |
| COL-028 | 授权样本试点、灰度与回滚 | 既有映射 | feature-off 回滚工程继续；授权真实试点/时长/角色单独开放。 |
| IF-029 | 完成租户隔离、注入与权限回归 | E01, E12, E14, E15, E16, E20, E21, E24, E26, E28 | E15 恶意字幕/host Skill、E16 transport 已过；E12 实际两租户待整栈。 |
| K-030 | 知识闭环定向验收与故障恢复样本集 | E02 | 最终 KA01–KA10/引用/hash/time/重试负例，不能只看 HTTP200。 |
| QA-001 | 验收基础闭环的真实宿主路径 | E03, E15, E17, E21, E24, E27, E28 | E03/E12 真宿主整栈待 CI；平台/行业/模型质量另验。 |
| K-010 | 隔离BiliNote抽帧处理工作目录 | E07, E23 | E07 真实双并发取消隔离通过，最终 worker 聚合。 |
| K-011 | 抽帧策略、尾组保留与视觉覆盖披露 | E06, E07 | 真实 FFmpeg 尾组/短片/采样上限通过，最终 manifest 回归。 |
| K-012 | 复用宿主OCR并保存帧级文字证据 | E06 | OCR 帧 provenance/单帧恢复/限制工程回归，真实语义质量另验。 |
| K-013 | VLM视觉观察与推断分类型输出 | E06 | E06 帧引用/模型 provenance 修复已验，实际模型质量另验。 |
| K-014 | 抽取BiliNote分段总结能力并接宿主网关 | 既有映射 | 最终 gateway 分层摘要全 input consumption 与限制回归。 |
| K-015 | 对齐语音、OCR与视觉证据并处理冲突 | E06 | 实际 audio/OCR 双侧冲突与未对齐显示，不把数值检测当语义真值。 |
| K-020 | 近重复视频与来源独立性治理 | 既有映射 | 合成转载 merge/split/CAS 已有；阈值/独立性人工校准待样本。 |
| K-029 | 多源冲突与知识更新审阅 | 既有映射 | 最终多源冲突/发布版本/批次部分失败回归。 |
| IF-025 | 实现候选Skill版本与评测审阅UI | E02, E04, E05, E26 | E04 模型评测已过，E05 主 UI 待 CI；失败恢复 E02。 |
| IF-026 | 实现源控发布包与安装状态追踪 | E04, E05, E26 | E04 双编译安装/升级/回滚通过，E05 状态 UI 待 CI；不要求生产发布。 |
| K-028 | Skill候选版本、评测与源控发布包 | E02, E04, E05, E26 | E02/E04 固定评测/终态恢复已过；人工行业质量不能用字符串评分替代。 |
| IF-024 | 扩展帧、OCR与视觉观察证据时轴 | E06 | E06 视觉合同已验，最终帧/OCR/观察分页及 required branch UI。 |
| COL-030 | 持续覆盖核对与源修订处理 | 既有映射 | 保留历史重查/临时不可达/真正变化版本回归；真实覆盖另验。 |
| QA-002 | 接通Skill源控发布和历史版本保留 | E04, E05, E10, E25, E26 | E04 双编译历史 pin/撤权通过，E10 PG 恢复与最终 CI。 |
| COL-031 | 完整V1容量基线与上游升级门禁 | E11, E22, E23 | E23 真实局部FFmpeg/HTTP/SQLite/fsync容量1/2/4并发与压力恢复已测；最终CI及原授权样本/全流程条件另验，不泛化生产SLO。 |
| IF-030 | 交付宿主接入运维、升级与兼容文档 | E10, E11, E13, E19, E22, E28 | 最终新栈 runbook/restore/兼容与发行证据；生产授权不等同工程阻塞。 |
| K-031 | 知识质量、覆盖与处理成本可观测性 | 既有映射 | 真实 usage/coverage/cache 指标已实现；人工金标语义精度另校准。 |
| IF-028 | 完成跨入口端到端与Canvas集成验收 | E03, E15, E21, E24, E27 | E27已定位并修生产composition，局部真实批准/native结算写回已过；E21 hostile+Loom/PG完整整栈待CI。 |
| QA-003 | 完成完整首版试点和发布验收 | 既有映射 | 工程继续到最终 CI；约定真实持续试点与业务签收未闭合。 |

## 原业务输入清单（不重复发起请求）

沿用 [RUNBOOK 第 7 节已有真实验收输入请求](RUNBOOK.md#7-仍需要的真实验收输入) 与 [交付边界](DELIVERY.md#尚需闭合的工程与业务条件)：

- 首发行业、5–10 个业务问题、术语、复核人/发布负责人及可签收 profile。
- 有使用权的 B站/抖音视频与账号连接、范围/期限、独立人工金标；秘密走受支持私有配置，不进聊天/仓库。
- 可用模型/部署位置/硬件、真实单价、资源和费用上限；本次不擅自调用付费 API。
- 试点目标环境/角色/保留期与实际约定持续时长，及需要时明确生产/发布授权；隔离 TEST 不等待该授权。
- 外部供应商文件与备份保留/擦除责任或回执；cancel 不代替物理擦除。
- 确切发行范围与特殊/未知许可、通知/源码义务的发布负责人确认；不是要求用户代做工程依赖采证。

这些输入只阻塞相应原业务条款，**不阻塞上述可独立实施/执行的工程工作**。生产部署、合并 main、发布镜像和付费 API 没有由本矩阵获得新授权。许可材料只是原始证据，不是法律结论。

## 最终交付核对

1. 将最终源 commit 与 CI run、每个必需 job、实际 raw artifact/receipt/hash 对齐；pending/失败/跳过分别记录，不继承旧 commit 的绿灯。
2. 只按可复核结果更新 JSON 的当前证据及本页；不因工程 smoke 修改原 100/29 基线或替业务签收。
3. PG 恢复/事务、真实宿主原生 Skill、浏览器整栈、镜像供应链分别保留各自边界，不要求单一测试覆盖全部，也不把缺少组合证据藏进“等待用户”。
4. 本页/JSON 已作结构校验：100/29 原对象、实施/验收原文、依赖和基线 hash 相等，引用路径存在；这是文档完整性校验，不是代码执行结果。
