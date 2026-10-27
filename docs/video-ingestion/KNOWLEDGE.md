# 视频知识治理与方法候选

## 实现边界与证据

对应 K-020—K-029、IF-025/026。实现位于 Loom `flow/video-knowledge*.ts`，增量迁移为 `0024_video_knowledge_governance.sql`；复用 `flow_documents`、不可变 revision、evidence、FTS、Engine 的授权回查及 outbox，不新增独立知识数据库。

自动化测试使用明确标注的开发 fixture。真实行业复核、真实模型评测、生产构建部署、安装验收及持续试点**未因此通过**。测试里的批准、usage、部署回执均只属于测试数据库。

## 知识版本及读取

- `candidate → in_review → approved → published`；另有 `rejected / withdrawn / superseded`。审核和发布要求当前 version/hash、真实用户 actor、独立权限；批准同时记录人工证据支持及关键字段检查。编辑生成新版本、清除批准、撤销旧 release，并失效依赖方法候选。
- 卡片保留类型、领域、结论、适用对象/条件、步骤、参数及单位、边界/反例、缺失项、事实/观察/推断类别、有效期与证据。不存在的信息为空或 missing，不填造行业事实。
- 证据固定 scope、revision、snippet hash、精确 UTF-16 quote，拒绝拆分 surrogate、错版本、未知/撤权证据和模型摘要充当源证据。数值和单位做保守字面门禁；语义支持仍由人工审核，不能把字面匹配声称为事实正确率。
- `POST /v1/knowledge/search` 只返回当前有效 published；空结果不会退回材料。`POST /v1/knowledge/research` 独立 research 权限，只返回 ready 材料，明确 `unreviewed_material`。预览正文超过 4000 UTF-16 单元时明确 truncated；完整正文走宿主固定 revision 读取，不冒称完整。
- `GET /v1/knowledge/:id` 默认正式知识；审核界面须显式 `?mode=review`，需要 research scope。
- 原生运行通过受信 `POST /v1/knowledge/snapshots` 按 workspace/run/method 首次固定当前 release 集合；后续 search/read 注入 snapshot_id，运行中新发布内容不会替换输入。快照本身不免除当前撤权、过期和证据检查。
- `POST /v1/knowledge/origins` 由人工复核人合并/拆分 origin_cluster，携带各资产 expected_origin_cluster。转载或相同 media hash 不增加独立佐证；关系变化使失去独立性的既有批准失效。潜在冲突保持双方版本，不以票数或新旧覆盖。
- `video-origin-candidates.ts` / `0027` 持久化 ready 后的 Unicode 5-gram bottom-128 近重复指纹队列；最多 30 万字符和 500 个匹配比较，超限明确 gap。0.82 是**尚未用真实样本校准的建议基线**，不是准确率承诺。`GET /v1/knowledge/origin-candidates` 和 `POST /:id/review` 要求人工判断 same_origin/independent、原因及 content_hash CAS；不自动合并，不把疑似转载算作独立佐证。

## ready 后提炼

K-017 提交 ready 后，在同一事务创建独立的 `flow_video_knowledge_runs`，按 document/revision/profile 业务键去重。资料 ready 不等待提炼。

`VideoKnowledgeExtractor` 持久化租约、fencing、宿主模型 task ID 和批次游标。每批最多 100 个固定 evidence；大视频通过批次游标覆盖全部引用，不静默取前 100 个。过大的单批输入明确失败，不能假称完整提炼。

宿主 `/api/internal/flow/video/model-tasks` 承担真实模型网关、预算及 usage。固定幂等键找回响应丢失的任务；pending 只轮询已知 task。模型结果经过 schema、来源范围、hash 与 critical numeric 门禁后，同事务建立 candidate 并推进游标。失败不会自动批准或发布。

领域 profile 的 `knowledge_model_id`、`knowledge_budget_micro`（全部批次的总预算）、可选 `knowledge_max_tokens` 冻结于运行；未配置时显示 `blocked_budget`。开发模板默认预算 0，不会自行购买或执行真实模型调用。

提炼和候选评测各自获得独立、固定总额的宿主 parent reservation；不是每批重新取得全额根预算。首个实际请求先持久化再发送，丢失响应时复用原始字节内容。接受结果要求 task/reservation/usage/input hash/model 配置 hash/实际费用回执；同一运行不能悄悄切换模型配置。完成或取消后持久化重试预算关闭；未知或仍活动的子任务由宿主拒绝结算，不把未决费用记成 0。

## K-017 embedding 屏障

`flow/video-embedding.ts` 和迁移 `0025_video_embedding_staging.sql` 在 ready 前保存规范正文、manifest/profile hash 和固定分批请求。分块直接复用 `Engine.chunkText`，每批最多 32 块、128 KiB，每块不超过 8 KiB；宿主 `video_embedding` 模型任务承担预算与实际调用，不从 Loom 绕过网关直连模型。

配置为 `embedding_model_id`、`embedding_budget_micro`（媒体 parent 下的 embedding 子额度）、可选 `embedding_dimensions`。按固定 required/optional capability 决定严格屏障或明确降级。验证每块 ID、UTF-8 SHA256、模型及配置、维数、有限 float32 向量和 usage 后，只有 ready 事务才能把 staging 向量写入既有 `flow_document_embeddings`。required 缺失、配置漂移、未知结果或旧 fencing 不能发布 ready；optional 已知不可用才记录 gap。

租约交接用相同 key 和输入重新绑定当前 fence，不创建重复付费任务。只有受信任务明确 failed/cancelled 才允许人工重试产生新批次 generation，保留历史回执；未知接受状态禁止新 key。撤权/擦除取消并清理这些 staging 内容。

向量 provider 使用 `host:<model>:<config_hash>`，避免被旧版直连 OpenAI 查询 embedder 自动混用。默认 FTS 检索不变；本阶段不声称已验证独立的宿主计费语义查询 embedding 路径。

## 原生方法候选及评测

候选冻结实际 native registry 基础版本/hash/工具集合、知识 release、支持/反对证据、pack 和 eval_spec。`rule_evidence` 必须为 method 和每个 step:N 显式绑定冻结 evidence_ids；该映射并不自动证明语义支持，仍需人工审阅。基础版本来自宿主受信查询，不信任浏览器自报工具范围。新包 kind 为 `video-method`；不能增加基础工具权限或隐式批准 MCP。

状态为 `draft / evaluation_running / passed / approved_for_release / release_package_exported / deployed / workspace_installed / rejected / retired`。批准、导出、部署和工作区安装不互相等同。每个原生 Skill version 的内容不可改写。导出 `pack_json` 是规范化的源控 JSON 字节；`native_skill_hash` 复现 Go `skillHash`，`candidate_hash` 另外覆盖全部冻结提案。

`VideoKnowledgeEvaluator` 对每个冻结用例实际提交三次独立宿主模型调用：基础版本、无 Skill、候选版本。必含正向、负向、边界、缺材料及回归五类。调用和输出逐项持久化，故障后复用已确认 task。

当前可执行评分器为 **`exact_expected_output_v1`**：返回的 output 与冻结 expected 文本精确相同且无关键不支持事实/权限违例才得 1，否则 0；不得在执行中降低标准。它是保守的确定性回归门禁，不是自然语言语义质量评分或行业人工准确率。真实业务用例需由行业负责人准备适合精确比较的预期输出，另做人类证据质量验收。候选不得低于两个基线，全部必须通过；模型不能返回自授 passing score。人工批准仍是后续独立动作。

导出不部署；仅 `video-skill-deployer` 的受信构建回执可记录 deployed。工作区安装由现有 Go native 安装器确认运行二进制确实内嵌同一 version/hash，写 pin 与安装 outbox；`video-skill-installer` 回执才写 workspace_installed。每次读取运行 pin 都检查当前知识依赖。回滚重新 pin 历史已部署精确版本，不覆盖旧 pack。

导出 manifest 固定 tenant/workspace，避免工作区私有方法编入二进制后变成跨工作区公开包。内部 deployment-check 在部署前重新核验审批、完整 release_package hash 和当前依赖；部署回执还必须携带实际可执行文件 SHA256。这些字段不能由浏览器的 approved/deployed 布尔值替代。

## COL029 分类保留期限

`video-retention-policy.ts` / `0028` 使用 profile 的 `retention_policy.version=1`，明确列出 media、audio、frame、transcript、evidence 五类 `access_seconds` 和 `maximum_seconds`。默认是工程基线而非合规建议：媒体/音频可访问 1 天，帧 7 天，转录/证据 30 天；所有最大期限为 30 天。显式配置必须完整、60 秒至 10 年、访问期不超过最大期；原媒体/音频/帧最大期不能短于依赖文本的有效硬上限。

期限从原任务 created_at 冻结，重试、延迟到达的对象和重复注册不能续期。转录与证据取两者中较早的访问/最大期限；同资产旧任务的更早期限不能被新任务覆盖。媒体软到期立即关闭 raw/link 访问，但固定时间证据引用或仍活动的执行会保留物理对象；引用计数与保留原因可审计。正常媒体到期不撤销仍在期限内的授权文本。

文本访问到期以独立 journal 记录 revoked，关闭知识、方法、检索和宿主派生缓存；最大期限到期再记录 erased，擦除正文、修订、quote、派生知识、报告、模型输入和 staging。直接读取还检查冻结时间，不依赖后台循环及时执行。宿主 projection-feed 在生成 checkpoint 前做有界、当前 workspace 的到期扫描；仍有积压或 journal 不可用就返回 503，不返回假干净的缓存许可。

来源授权 `authorization_expires_at` 到期也进入同一 scoped journal 撤权路径：写入前在锁内重新读取当前授权期限，已获合法续期的来源不会被旧扫描结果撤销。不能只让直接资料接口拒绝，而让先前缓存的报告/对话继续被读取。

策略只登记取消/不可读/删除待办。`text_retention_erased_at` 表示业务正文已擦除，**不是**物理 worker 的 `execution_erased_at` 回执。实际对象和临时文件删除仍检查 worker 活动锁、上传租约及未知外部任务；不能靠取消状态声称字节已消失。

## 撤回、删除和恢复

停用订阅只停止将来采集；media_expired、remote_unavailable 不自动撤销仍授权的历史文本。撤权/擦除先标记不可读、撤销 release/批准、退休依赖 Skill、移除检索块/embedding、取消任务并失效 fencing，再进入对象 `delete_pending` 清理。只有实际对象删除回执才能声明物理清理完成。

擦除同时清空正文、quote、候选/发布快照、相关报告及 research 缓存、方法候选和执行缓存里的目标内容，保留无正文 tombstone/hash/ID。

删除确认前必须把签名意图 fsync 至**独立保留、不随数据库或对象备份还原**的 deletion journal；同一数据库事务写删除效果和 applied receipt。恢复入口与视频读取屏障验证 journal 身份、HMAC 链及 checkpoint，重放晚于备份的删除；无法访问或校验 journal 时，视频/知识/native pin 路径隔离，不能靠旧数据库的墓碑表宣称安全。正常 RSS 材料和非视频报告保留可用。Journal 初始化、恢复和部署配置由 `flow/video-journal.ts` 与 `deploy/flow/backup/` 提供；生产独立卷/密钥的配置及备份演练仍需单独验收。

宿主自身数据库恢复时，受信 `video-projection-reader` 使用 `GET /v1/video/retention/projection-feed` 重放**已投递和未投递**的非内容删除事件，补齐缓存/通知/对话投影，而非只看 outbox 的 delivered 标志。分页固定 `journal_id / genesis_hash / head_sequence / head_hash / projection_sequence`；head 或 generation 变化必须重新校验，不能沿旧 watermark 暗中继续。每页最多 100 条且 512 KiB，最后以 cursor=projection_sequence 再确认空页。该路由只给内部 service scope，不向浏览器公开原始材料或任意目标删除能力。

报告/research 的视频来源标记来自实际文档关系；旧完成通知中的被擦除文本改为原 payload hash 与对象 ID，不再发送过时完成通知。已经发送至外部邮件/webhook 的内容不能由此撤回。

## 验证命令

```sh
cd services/loom-engine
node --experimental-strip-types --test flow/video-knowledge.test.ts flow/video-embedding.test.ts flow/video-retention-policy.test.ts flow/t16-reports.test.ts
```

覆盖数据库状态机、跨 workspace、旧批准、证据污染、数字/单位、转载、冲突、保留/擦除、真实运行代码上的 fixture 网关批处理与三基线比较、原生 hash 和部署安装分离。生产授权、模型费用和行业真实样本不在这些 fixture 断言范围。
