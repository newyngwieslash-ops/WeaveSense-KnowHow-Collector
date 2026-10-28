# 视频 V1 实际接口与数据契约

本文件描述本分支真实实现，不代表双平台生产验收。业务数据库仍是 Loom `flow_intel`；Go 继续提供身份、工作区、模型计费、MCP 和宿主界面。Python SQLite 仅保存可重建执行收据，不写 Loom 表、不生成 evidence_id。

## 受信入口

Go `/api/intelligence/video/*` 映射 Loom `/v1/video/*`，知识入口映射 `/v1/knowledge/*`。沿用 `{code,data,msg,reason}` 信封。JWT 由宿主签发，audience=`loom-engine`，有效期最多 300 秒；workspace、tenant、actor 和 scopes 不接受业务请求自报。写请求使用 `X-Idempotency-Key`。相同命名空间、scope、key 不同规范参数返回 409。首次 start 响应丢失时可以不提供未知的 job ID，按原 key 恢复。

| Loom 路径 | 方法 | scope / 语义 |
| --- | --- | --- |
| `/v1/video/profiles` | GET / POST | `intel.video.read` / `intel.profiles.write`；不可变版本 |
| `/v1/video/discover` | POST | `intel.video.read`；只发现，不下载；返回 operation/discovery handle |
| `/v1/video/discover/:operation_id` | GET | `intel.video.read`；cursor/limit 分页结果 |
| `/v1/video/sources/:id/backfill` | POST | `intel.video.process`；from/to/limit，最长 90 天、最多 200 项窗口 |
| `/v1/video/jobs` | POST / GET | `intel.video.process` / `intel.video.read`；统一任务、state/cursor/limit |
| `/v1/video/jobs/:id` | GET | `intel.video.read`；实际阶段与失败类别，无假百分比 |
| `/v1/video/jobs/reconcile` | POST | `intel.video.process`；`{video_job_id? ,idempotency_key?}` |
| `/v1/video/jobs/:id/cancel`、`retry`、`reconcile` | POST | `intel.video.process`；取消先落库并 fencing，结果不明不能盲重提 |
| `/v1/video/jobs/:id/artifacts` 或 `result` | GET | `intel.video.read`；短分页、完整性及正文读取引用 |
| `/v1/video/jobs/:id/import` | POST | `intel.video.import` 且 service_principal、JWT job_id 匹配 |
| `/v1/video/jobs/:id/model-authorization` | GET | `intel.video.model` 且 job_id；处理阶段租约/attempt/fence/当前授权校验 |
| `/v1/video/jobs/:id/artifacts/raw` | GET | 同上；只读受控同 job 对象，图像暂存读取不赋予知识就绪 |
| `/v1/video/jobs/:id/input` | PUT | 原始 user grant + `intel.video.process` + JWT job_id；流式合法输入，不接受对象键或外链 |
| `/v1/video/jobs/:id/media/:object_id` | GET | `intel.video.read`；32hex 不透明对象ID，真实授权、范围读取、到期/撤销重检 |
| `/v1/video/jobs/:id/repair` | POST | `intel.video.process` + 幂等 key；显式受控重取，绝不由 GET 触发 |
| `/v1/video/metrics` | GET | `intel.video.read`；from/to/profile_id，默认7天、最长90天的有界真实统计 |

Source 继续用 `/v1/sources`，新增 kind=`bilibili|douyin`。配置包括 `source_type:video|account`、`native_id|author_id`（字符串）、`part_id`（字符串）、`profile_id/profile_version`、`usage_basis`、`allowed_uses:['knowledge']`、可选 `credential_ref/authorization_expires_at/processing_mode`。不保存 Cookie。PATCH source 的 `expected_revision` 和 `status:active|paused` 复用宿主，停止订阅不撤销历史文本。手工运行复用 `/v1/collection-runs`；interval/cron、时区、misfire 和唯一调度锁复用 `/v1/schedules`。

`PATCH /v1/schedules/:id {enabled,expected_revision}` 仅切换既有调度，CAS 冲突 409；monitor 所属调度必须使用原 monitor API。GET schedules 附加 `monitor_id`。cron 窗口长度使用该时区前一次真实触发点，不能把 interval_seconds 的 null 随意改成固定秒数。

## Profile 与 start

Profile POST：`{id?,expected_version?,name,config}`。首次 expected_version=0，后续必须等于当前版本；每次产生新版本。config 包括 required/optional_capabilities、max_video_bytes、max_duration_ms、max_discovery_pages、budget_micro、语言、领域问题/术语/复核规则。预算、上限、配置版本在后端冻结。知识整理可配置 `knowledge_model_id`、正数 `knowledge_budget_micro`、`knowledge_max_tokens`；缺少模型/预算不能伪造提炼成功。

`processing_mode` 规范值为 `subtitles_first|audio|full_video|visual_required`；来源显式覆盖优先，否则冻结 profile 模式，默认 subtitles_first。audio 与必需视觉能力冲突即拒绝；visual_required 必须要求 vision。实际平台若没有字幕/独立音频接口，worker 必须披露不支持和媒体 fallback，不能伪称已走字幕接口。B站未指定分P按字符串 `1` 归一化；URL p 与显式 part_id 不一致拒绝。

账号首次默认 since 为创建时间前7天（可显式覆盖），max_items 默认200且上限200；后续稳定水位有一天重叠。无可靠时间戳项不用于推断边界。超出一次限定的页内项目持久缓冲到 checkpoint，不能截掉游标。profile max_daily_jobs 默认1000、上限10000；同 scope 新任务准入在业务锁内按UTC日期限额，重放不重复占额。

Start：`{source_id,native_id?,part_id?,canonical_url?,content_version?,profile_id?,profile_version?,required_capabilities?,processor_version?,model_config?}`。缺 native_id 仅允许从单视频来源配置取值；账号来源须先发现。身份和业务指纹只包含 tenant/workspace、asset、content/profile/processor/model/modality，不包含 JWT jti/iat 或调用入口。元信息变化不覆盖旧转写；来源和资产多对多。

返回：`video_job_id,operation_id,source_id,asset_id,profile_id,profile_version,state,stage,completion_level,coverage,available_capabilities,document_id,revision,remote_cancel_status`。GET 另附 stages/next_poll_after。

`GET /v1/video/jobs/:id` 的每个 stage 还返回有界外部执行摘要：`submission_intent_state` 为 none/prepared/submitted/accepted/resume_requested/terminal/unknown；`external_task_known` 只表示已持久确认外部任务身份，不返回该身份；`external_observed_state` 为 unknown/pending/completed/failed/reconciliation_required；`external_observed_at` 是真实响应被观察的时间，未观察时为 null。迁移0030之前的记录不根据本地终态或 updated_at 补造远端状态。submit/poll/reconcile 仅保存白名单规范状态，写入锁定并验证当前 stage attempt/fence 与已确认任务身份。宿主取消不会把最后一次 pending 改成 completed/已停止；远端取消结果仍独立显示。接口不返回 provider URL、token、原始响应或外部任务ID。

状态：queued、running、retry_wait、blocked_auth、blocked_budget、reconciliation_required、cancel_requested、cancelled、failed、completed、completed_with_gaps。完成级别：pending → input_ready → knowledge_ready。媒体输入完成不等于知识发布。

## 持久执行与发现

迁移 `0023_video_core.sql` 创建 profiles/assets/memberships/jobs/stages/requests/submission_intents/manifests/objects/discovery checkpoints/pages/operation-job 关联。每表 scope 复合外键及 tenant RLS；旧 source/revision 表增量扩展。

每页身份、成员关系、待处理任务和 checkpoint 同事务；只有明确 complete/reached_boundary 才推进 stable_watermark。页数/截止/额度上限保留 partial。只发现和历史补采使用隔离 checkpoint，不能污染订阅水位。原调度窗口冻结来源 config、原始 grant_actor 和 policy_version。

发现结果的 next_cursor 只翻阅已保存项目。要继续尚未完成的远端扫描，POST discover 带原 `discovery_handle` 和新幂等 key，创建从已保存 checkpoint 延续的有界操作，保留原模式/窗口/config。GET 仅投影 checkpoint 代数/partial，不泄露原始 provider 游标或缓冲整页。MCP status/result 可用 discovery_handle 查询，不需要重复提交发现。

Stage 原子 claim、90 秒 lease、15 秒 heartbeat；普通 pending 轮询保留当前 owner/attempt/fence，不再次 submit。进程消失才可到期接管并递增 fence。外部 submit 前先持久 intent；丢响应进入 reconciliation_required。Python 的已验证 intent 查询只恢复其执行收据，不能将 DTK 的未知接单误判为未接单。

Provider/account 熔断状态按 scope 持久化：连续5次不确定网络/服务失败或显式429打开有界冷却，成功控制响应重置；不把宿主 embedding 失败误归到 Python/DTK。显式 retry 先读取外部状态，只有证明失败才持久 `resume_requested`；由下一个当前租约执行恢复，已完成产物仅重新导入，未知结果不重做。

## Worker 受信 HTTP

部署固定 `VIDEO_WORKER_URL`，禁止跟随重定向传递凭据。Authorization 使用独立 `VIDEO_SERVICE_TOKEN`，`X-Flow-Execution-Context` 使用同宿主 HS256、aud=`video-knowledge`、actor=`service_principal:loom-engine`，权限为 video.discover/execute/read/cancel；涉及 job 的请求必须匹配 job_id。submit/poll/retry 的 stage_attempt/fencing_token 同时签入 JWT。

POST `/v1/discover`；POST `/v1/jobs`；GET `/v1/jobs/:id`；GET `/v1/jobs/reconcile?intent_key=...&video_job_id=...`；POST cancel/retry；GET `/v1/objects?key=...&video_job_id=...`。任务 POST 传 scope、video_job_id、stage、stage_attempt、fencing_token、intent_key、profile、asset、可选 input_manifest/input_manifest_sha256。结果 pending/completed/failed/reconciliation_required；正文不放控制响应。

## 两阶段产物

对象键：`tenants/{tenant}/workspaces/{workspace}/video/{job}/{sha256}/{name}`。拒绝路径遍历、跨 scope、未登记对象和任意 URL 代理。媒体流式核验；JSON 分段对象最多 10MB，不能把长视频整个放入内存。引用只使用真实对象摘要。

Manifest 固定 `schema_version:1`、video_job_id、stage_attempt/fencing_token、objects（object_key/sha256/bytes/content_type）、processors、coverage。

- `artifact_stage:input_ready`、`input_kind:platform_subtitles|media`，input_hash 必须等于实际输入对象；只有字幕则 media_sha256=null、availability=not_acquired，不能承诺本地播放。
- `artifact_stage:processing_complete`，parent_manifest_sha256 对应被接受输入；input_kind/hash/media/availability 必须与父一致。transcript.parts 包含对象摘要、segment_count/start_ms/end_ms。对象 JSON 为 `{segments:[{text,start_ms,end_ms,kind?,frame_ref?,alignment_method?}]}`。
- Manifest 内容摘要是递归排序 JSON，并把 stage_attempt/fencing_token 归零后 SHA256；租约信封更换不改变内容身份。宿主将显式 input_manifest_sha256 传给 worker，双方核对。

K-017 唯一协调器在一个事务里完成固定 revision、`${title}\n\n${body}` UTF-16 spans、真实 FTS chunks、evidence、可见 current_revision、job ready 与 outbox。缺必需产物不允许 completed_with_gaps；失败不影响上一 ready revision。旧 evidence 固定 revision/hash；材料不是模型摘要。

Embedding 不由 worker 自报。`embedding_model_id/embedding_budget_micro/embedding_dimensions?` 随 profile 冻结；处理产物之后进入持久 embedding stage，按同一个 Engine.chunkText 切块，每批≤32块，经宿主有预算模型任务保存 intent/收据/配置hash/精确向量。K-017 同事务写现有 flow_document_embeddings，再允许可见。必需失败保持不可见；可选已证明不可用则显式 gap；结果未知不能当作可选失败跳过。校对也遵守该屏障，可返回 queued/embedding、revision=null、proposed_revision；最后仍重检父 revision/hash CAS。

媒体 parent `budget_micro` 是累计上限，不是每次retry重置额度。ASR/OCR 每个量子先经宿主现有价格簿分配 child reservation，完成后以真实量结算；模型任务同样消费 parent。Loom 查询宿主权威 budget 回执，不重复计费 ASR/OCR outbox；open/unknown child 保留占用。关闭 parent 的 actual_micro=0，因为 child 实际费用已汇总。已关闭 parent 重试只为剩余累计额度建立新 generation。知识整理使用独立冻结 knowledge_budget_micro parent，符合 ready 后独立 Flow。纯同步 ASR/OCR 调用超时且没有输出收据时，不能凭账务状态证明未处理：保持 USAGE_OUTCOME_UNKNOWN，禁止盲重跑和虚假物理清除成功。

完整机器 schema 在 `contracts/video-artifact-v1.schema.json`；结构约束不能代替实际对象内容/hash、父关系、覆盖范围和当前 fence 校验。人工校对 `POST /v1/video/jobs/:id/corrections` 需要真实 user + intel.knowledge.review、幂等 key，body 为 `{expected_revision,expected_content_hash,reason,patches:[{evidence_id,text,start_ms?,end_ms?}]}`。已知媒体时长内才可更新时间。校对产生新不可变 artifact/revision 和 evidence，不改旧文本；同一 ready 事务失败回滚，旧批准知识进入重审。旧通用 ASR/OCR revision 接口不能绕过此屏障修改视频文档。

Worker pending/failed/completed 可带 `artifacts`（每页100对象）和 `next_artifact_cursor`；Loom 逐页实际流式验hash，登记为清理库存，不代表证据有效。取消/撤销后迟到库存进入 delete_pending。物理删除逐对象取得相同hash收据后才标记 deleted；全部清理且外部执行已终止后 `/v1/jobs/erase` 清除 worker 活跃 SQLite 内容，只保留幂等墓碑。备份及外部平台存储仍有独立留存要求，不能把本地收据当作所有副本已删除。

生产入口固定 issuer=`FLOW_INTERNAL_JWT_ISSUER`（默认 flow-platform）；签名正确但 issuer 不符仍拒绝。模型原始帧读取同时检验当前 job/source/asset 和 attempt/fence，暂存图像只供模型服务，不形成发布材料。

删除/撤销另有数据库备份之外的签名 fsync journal：`VIDEO_DELETION_JOURNAL_DIR/ID/KEY`，显式离线初始化，不在启动时自动创建。正常操作先持久 intent，再在同一 DB 事务更新撤销/擦除状态与应用收据。启动和每次受信读取验证链与数据库绑定，恢复旧库后先重放新删除记录。不可验证时仅隔离视频：新视频/知识 API 503，旧文档/搜索/报告过滤视频；无关 RSS 继续工作。后台视频、模型和调度不得绕过隔离。日志卷不能与数据库一同回滚；本地重放成功也不代表平台缓存/物理对象/所有备份已清理完成。

## ready、整理、知识与 Skill

`collection.completed` 的 video_discovery=true/knowledge_ready=false 不能触发最终 Canvas。单文档 `video.knowledge_ready` 仅证明材料就绪。原周期所有发现和必需材料就绪后，Loom 以真实文本重评关键词，按 monitor/document/revision 去重，再发带原 grant/window/cycle_complete 的聚合 ready；Go 继续重检授权和预算。

ready 后另建 `flow_video_knowledge_runs`，幂等冻结 profile/证据/原生方法；不阻塞媒体完成，不循环下载。知识 /review → /publish 是不同命令，预期 version/hash、有效证据与当前权限必需。普通 search 只返回 published；research 明示未审核材料。Skill candidate /evaluate、/review、/export、/receipts 独立状态，批准不等于部署或安装；原生包由宿主构建/安装验证，动态 registry 不在 V1。

## 验证边界

### 本轮补齐的运行约束

- `max_daily_download_bytes` 默认10GB、`max_daily_media_ms` 默认24小时；输入外部调用前按冻结的文件/时长上限在同一 UTC 工作区日账本保守占用。重复请求不重复占用；验证实际输入后结算真实字节/媒体时长；响应未知继续持有，不能记零。该表只计资源，费用仍以宿主 Billing 为准。
- `FLOW_VIDEO_PROVIDER_CONCURRENCY` 默认8，`FLOW_VIDEO_SOURCE_CONCURRENCY` 默认1，工作区仍为4。跨副本 count+claim 在同一事务锁内，忙来源不会占住其他来源的可用槽位。
- `reconcile_after_seconds` 默认7天、`max_reconcile_items` 默认3。既有订阅资产按有界轮转核对，不受新增水位过滤；显式刷新 DTK 元数据并强制重新取得当前媒体，而非复用平台下载缓存。仅真实字节/hash与可信处理器身份相同才复用当前 ready 文本；无法证明远端处理器身份则安全重处理。媒体消失不等于撤销合法历史文字。撤销墓碑禁止重新发现回填其元数据。
- 分享文本最多4096字符，只允许恰好一个平台白名单 HTTPS 链接。保存规范 URL 和原始分享文本摘要，不保存原始分享文本。短链接必须经实际 provider parse 取得 native/part，再从发现结果创建业务资产；不虚构临时 native_id。

### 合法原始输入、视觉页与媒体

POST jobs 可带 `lawful_input:{input_kind:'platform_subtitles'|'media',sha256,bytes,content_type}`。任务先 `stage=awaiting_input`，不会下载。原用户通过 PUT input 流式上传冻结字节；字幕为规范 JSON（≤8MiB），媒体≤2GiB且受 profile 更低上限。worker 预登记写入意图、实际 hash/格式核验并返回受控对象收据；丢回复可 reconcile，不必重跑处理。用户上传字幕标记 `authorized_user_upload` / `transcript`，不声称已由平台验证。

上传被 worker 拒绝时保留 HTTP status。422 只透传有界（≤4096字节）JSON `error.code` 的已知输入校验代码：`INPUT_HASH_MISMATCH`、`INCOMPLETE_ARTIFACT`、`NO_SUBTITLES`、`INVALID_SUBTITLES`、`INVALID_SUBTITLE_TIME`、`SUBTITLE_LANGUAGE_MISMATCH`。空字幕不是 hash 错误。未知代码、损坏或超大错误信封回退为 `INPUT_UPLOAD_FAILED`，不返回 worker 消息、正文或任意代码；413 仍为 `LIMIT_EXCEEDED`。拒绝不产生文档或 ready 状态。

processing manifest 可携带 `visual:{schema_version:1,record_count,parts:[{object_key,sha256,bytes,content_type,record_count,start_ms,end_ms}]}`。每部分≤100记录、256KiB。记录类型 frame、ocr、model_observation、model_inference、alignment；每条 record_id 是其余字段规范哈希。模型记录必须 derived=true/unreviewed，并保留实际任务 provenance；frame_ids 与真实 frame_refs 一一对应，时间包络不可编造。alignment 只声明 temporal_overlap/unaligned，semantic_relation=not_assessed，不证明语义一致。

GET result `kind=visual` 返回有界记录页；长文字每次≤500 UTF-16字符，`next_text_offset`/`read_ref` 可继续同 cursor 完整读取；不能把 excerpt 当完整证据。`frame_media`/`frame_media_items` 是服务端关联的受控媒体描述。`kind=media` 只列已登记可访问对象的相对鉴权路径。GET媒体支持单 Range 200/206，固定 ETag 为真实 SHA256；未找到404、到期410、撤销403，发现对象丢失后标记 missing 并去掉后续可用链接。

显式 repair 产生新的预算受限任务。只在新产物与原固定对象的 SHA/bytes/type、资产和原媒体 SHA 完全一致时，旧不透明 ID 可读取新核验副本；旧证据 hash/time 不改。`coverage.repair.status=restored|partial|changed_media` 明示结果；不同字节不会被当作修好旧证据。用户上传输入须由原用户重新提供，不能冒称平台可恢复。

### 分级保留

profile `retention_policy` 对 media/audio/frame/transcript/evidence 分别冻结 access_seconds/maximum_seconds。明确工程默认：媒体/音频访问1天、帧7天、文本30天，全部最大30天（非法律建议）。对象访问到期立即拒绝链接；仍被有效固定证据引用或有真实活跃执行锁的对象不提前物理删。文本访问到期经独立 journal 撤销派生访问，硬上限经同一 journal 擦除；物理删除仍须逐对象及 worker 收据。重试和迟到对象不续期。未完成写入且不能排除迟到提交时保留 unknown，不伪报清除。

metrics 区分实际音频覆盖、视觉采样密度、缓存、已结算费用和知识状态；没有标注样本时人工质量为 unknown/null，不能由 completed 推断准确率。

自动测试使用明确 synthetic fixture，真实数据库和真实 Python/FFmpeg/HTTP 调用可单独验证；平台发现/下载及模型质量不因此标记真实通过。需授权行业样本、平台凭据、预算、行业复核和冻结试点才能验收对应任务。关闭 FLOW_VIDEO_ENABLED 停止新业务，不删历史 revision 或 evidence。
