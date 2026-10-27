# 视频执行组件

本组件只保存可重建的执行任务/checkpoint 和宿主受控对象。来源、调度、授权、
video job、文档 revision、evidence 和 knowledge_ready 仍由 Loom 管理。
不启动 DTK watchlist/BiliNote scheduler，不跨库写 Loom，不生成 evidence_id。

## 启动与验证

```sh
cd services/video-knowledge
python -m pip install -r requirements.txt
python -m unittest -v test_video.py
# 使用 secret manager 注入 env.example 中实际配置后：
python server.py
```

服务默认关闭 DTK、ASR、OCR 和模型调用。`/healthz` 只说明执行服务入口可用，
不是平台下载或知识就绪验收。需要 FFmpeg/FFprobe；Pillow 用于尾组保留的帧网格。
生产应限制 CPU/RAM/临时磁盘、仅内网暴露、持久挂载 `/data`，使用宿主 MinIO。
Docker 基础镜像 digest 已从官方 registry 核对；镜像构建及干净环境部署尚未执行。
系统 FFmpeg 包和全部传递依赖需要发布环境生成 SBOM/镜像 digest 后冻结。

## 内部协议

所有业务请求必须同时包含 `Authorization: Bearer VIDEO_SERVICE_TOKEN` 与宿主
`X-Flow-Execution-Context` HS256 JWT；audience 为 `video-knowledge`，issuer/actor
固定 `loom-engine`，有效期不超过 300 秒。工作区和 job 必须匹配签名上下文。
提交及更新执行 envelope 时，attempt/fencing 必须与签名字段一致。

- `POST /v1/discover`：有界 DTK 发现。异步 provider task 写入 next_cursor；后续只 poll。
- `POST /v1/jobs`：短提交，持久化幂等 execution；相同 intent 异参 409。
- `GET /v1/jobs/:id`：状态，更新短期授权；只延长 operational lease 不代替宿主授权。
- `GET /v1/jobs/reconcile?intent_key=...&video_job_id=...`：找回丢失的 start 响应。
- `POST /v1/jobs/:id/cancel`：先 fenced/cancel 本地，再尽力取消远端；不能宣称远端已停。
- `POST /v1/jobs/:id/retry`：显式恢复已知失败，保留 chunk checkpoint；unknown 不允许重提。
- `GET /v1/objects?key=...`：同 job 的对象，先校验 hash 再流式输出，拒绝任意 URL。
- `POST /v1/objects/delete`：video.delete scope，精确 key/hash、无活动执行引用、幂等删除。
- `GET /v1/jobs/:id/artifacts?cursor=...`：每页最多 100 个中间产物 receipt，失败/取消也可登记清理。
- `POST /v1/jobs/erase`：删除对象后擦除本服务的执行正文、checkpoint 和结果；保留幂等 tombstone，等待 SQLite WAL checkpoint 成功再返回 receipt。备份和 DTK 自有存储需独立保留策略。

仅接受 `tenants/{tenant}/workspaces/{workspace}/video/{job}/{sha256}/{name}`。
input_ready 的字幕路径始终 media_sha256=null/availability=not_acquired。
processing_complete 绑定规范化父 manifest hash（排序 JSON、attempt/fence 置零），
携带每个文本 part 的 hash/count/时轴、处理范围、未知/语音区间和模型 usage 引用。
这是“处理产物完成”，绝不等于知识已审核或已发布。

ASR 使用宿主 worker 新增 manifest+parts 协议；旧 inline 超限明确 413，不再切片。
音频按受控片段提取、绝对时间恢复、重叠去重，已确认 chunk 经 hash 核验可复用。
检测不到语音只记录 no_speech_detected；未识别区间不伪称静音。
场景帧加时间网格只声明抽样理解，短视频/尾组保留；必需视觉失败阻断，只有可选分支可降级。

## Provider 与模型边界

DTK 只连接部署固定 origin、禁止重定向转发密钥、响应有上限；绑定
`DTK_TENANT_ID/DTK_WORKSPACE_ID`，其他工作区拒绝。credential_ref 可使用下述
精确 scope 的实例/API-key secret-file 路由；不冒充 DTK 身份池中的平台身份选择。
当前源代码可验证双平台作者列表和视频下载，但没有独立字幕/纯音轨契约。
外部下载 intent 在 HTTP 前落盘，接单结果不明保持 EXTERNAL_OUTCOME_UNKNOWN，
不盲目重发。DTK 源码存在不等于真实授权样本已验收。
已知下载明确终止失败后，只有宿主显式 retry 才允许持久化新 intent、重新确认终态并
按冻结 platform/native/part 重新提交；不使用该锁定版本会丢 part 的 /downloads/retry。
重试创建响应丢失仍转 unknown，不再二次提交；进行中的旧下载只会继续 poll。

VLM/层级摘要仅走宿主 `/api/internal/flow/video/model-tasks`；宿主复检来源/grant/
stage fence，既有 Billing/ModelTasks 负责预算和 usage。文本被明确视为不受信材料，
观察和推断分别标为 unreviewed；摘要是 derived，不成为自己的原始依据。
工作区未配置模型/预算/图像能力时明确阻断，不调用外部付费模型。

DTK 锁定版本的程序认证是 `X-API-Key: DTK_SERVICE_TOKEN`，不是 Bearer；所选
端点需要对应平台 read、media:read/media:write 权限。宿主 worker/ASR/OCR 仍使用
自己的 Bearer 服务密钥，互不混用。没有真实授权账号/实例调用验收。

生产 ASR/OCR 每个量子必须先经过宿主 `usage-admission`，数量为重叠音频片段向上
取整秒数或唯一 OCR 帧数，价格由宿主冻结。已保存输出后才能 `usage-settle`；丢失
settlement 响应仅重试同 receipt，不重复算力。计算接单结果不明保留 hold 并阻断重跑。
启用 ASR/OCR 因而也必须配置 FLOW_PLATFORM_URL、共享签名密钥和正数 profile 预算，
即使 VIDEO_MODEL_ENABLED=false。只有明确标注的离线合成测试才注入不计费适配器。

audio 模式不调用视觉分支；visual_required 必须有 media 和 required vision。
subtitles_first 在 DTK 不支持字幕时明示整媒体回退，不冒充已取得平台字幕/独立音轨。
最终 manifest 超过 1.5 MiB 明确 OUTPUT_LIMIT_EXCEEDED，已完成 chunk 可保留，不能
切掉尾部后宣称 ready。控制响应的 usage IDs 最多 100 条，附 count/complete 标记，
费用完整性由宿主权威 admission 账本核对，而不是信任 worker 摘要。
本地量子 processing/unknown 时也拒绝最终物理擦除 receipt：同步 worker 可能晚到写
parts，逻辑撤权不等于已证明物理清除；必须先取得结束/未处理证据并核对 scoped orphan。

真实本地模型烟测可运行 `local_model_smoke.py --model-dir ... --out ...`；仅使用预先
校验的模型权重和 FFmpeg 生成素材，不下载任何平台内容，不衡量行业准确率。

### 有界复查、合法上传与清理协议

宿主冻结 `asset.reacquire=true` 才触发复查：先持久化 `refresh=true` 的 DTK 元数据
任务并等待已知结果，再用 `skip_existing=false` 下载；进行中的下载继续复用同一
任务。元数据版本包含标题和描述，实际媒体 SHA 仍是换片判断依据。任何首次提交
响应丢失保留 unknown，不重复创建。解析得到的 native/platform 必须与冻结身份一致。
`processors.processing_identity` 目前仅在无远程模型的字幕路径按真实源码/Python/
冻结配置生成；媒体路径的 FFmpeg 动态库和远程模型身份未完全证明时返回 null，
不凭固定版本字符串跳过 ASR。

`PUT /v1/inputs` 使用 `video.upload` 签名和静态服务令牌，查询字段为
`video_job_id,input_kind,sha256,bytes,content_type`，精确 Content-Length；只接受
规范字幕 JSON（8 MiB）或 MP4/WAV/MPEG，流式验证长度、SHA、魔数和 FFprobe。
用户输入不等同于平台真实性证明，`acquisition_path=authorized_user_upload` 保留
来源声明。目标 key 由服务生成，上传意图先存入 operational inventory；
`GET /v1/inputs?video_job_id&sha256` 可核验丢失的写入回执。未证明落盘的意图不
成为成功输入。已擦除 job 的 tombstone 阻止旧签名重放恢复对象。

`GET /v1/jobs/inventory?video_job_id&cursor` 每页最多 100 个 typed descriptors；
包括 cleanup-only write_pending。retention_class 为 media/audio/frame/transcript/
derived，宿主负责映射策略、引用、TTL 和命令。`POST /v1/jobs/cleanup` 接收
`{video_job_id,temp_before:<Unix秒>}`，只清理注册的该 job 临时目录，并同时检查
真实 flock 和执行 generation/lease，绝不因租约过期就删除仍在写的文件。
对象 DELETE 仍是精确 scope/key/hash；未知远程写入且对象尚不可见时拒绝伪造
删除确认（OBJECT_WRITE_OUTCOME_UNKNOWN）。DTK 自有副本和备份不在本回执范围内。

本地磁盘阈值 VIDEO_MIN_FREE_BYTES/VIDEO_MIN_FREE_RATIO 在传输前、每个流式块、
FFmpeg 运行及帧/音频输出前检查，压力返回可重试 STORAGE_PRESSURE。单执行临时
上限 VIDEO_MAX_TEMP_BYTES；FFmpeg stdout/stderr 临时落盘并受总 8 MiB 限制，
不无界占用内存。它们不冒充 MinIO 远端容量检测或宿主每日配额；每日字节/时长
预留由 Loom 权威执行。usage 报告实际时长、输入字节、缓存命中次数、累计执行
墙钟时间和观察到的临时文件峰值，不生成虚构质量分数。

视觉产物位于 `visual.parts`：每个 JSON `{records:[...]}` 最多 100 条/256 KiB，
保留 frame、ocr、model_observation、model_inference、alignment 类型。OCR 是
未复核观察文本，模型输出永远 derived；仅时间重叠不推断语义一致或冲突。
对外播放必须走宿主的 opaque descriptor。内部 `/v1/objects` 仅允许已注册同 job
对象，先完整 SHA 验证再输出 MIME/ETag，支持单段 bytes Range（206/416），
缺失对象明确 404，不能用任意平台 URL 作为播放器地址。

### 凭据引用与分享链接

`DTK_CREDENTIAL_ROUTES_FILE` 是只读、由部署方管理的 JSON 数组（最多 100 条/64 KiB），
每项严格为 `{tenant_id,workspace_id,credential_ref,origin,token_file}`。
`token_file` 为绝对路径的只读 secret 挂载，文件仅含 DTK API key；禁止把原始 key
放入该配置的 job/source、业务库、日志或响应。精确 scope+alias 匹配后才创建
部署固定地址客户端，不存在/跨 scope 引用明确拒绝，不回退默认凭据。checkpoint
冻结不含秘密的 route hash，换实例不能悄悄拿旧 task_id 到新实例 poll。
这映射的是独立授权的 DTK 实例/API key，不冒充平台 cookie 导入或 DTK identity
pool 中某个人的身份选择。没有真实账号调用验收。

分享文本最多 4096 字符，只接受一个明确的 HTTPS 平台白名单 URL。短链接必须
通过 DTK `/parse` 已接受任务取得真实 native/part/canonical 身份，保存解析任务/
路由/hash provenance；无 native 的短链接先 discover，再使用解析结果 start。
多链接、userinfo、错误平台、HTTP/本机/私网地址均拒绝，worker 自己不跟任意 URL。
时序对齐还可输出精确“标签:数值+单位”不一致候选：只比较相同归一标签和单位，
保留两侧原文/时间/hash，标记 unreviewed/not_asserted；不把普通数字或单位换算差异
自动宣判成矛盾。大段原文/候选数量限制在 conflict_scan 中明示。
