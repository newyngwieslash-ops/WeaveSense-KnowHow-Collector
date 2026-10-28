# V1 接入、兼容矩阵与故障诊断（IF-030）

本页补齐 [RUNBOOK](RUNBOOK.md) 的操作索引与兼容边界，不增加原 PRD 没有要求的发布形式。下面是现有代码的部署/恢复流程；实际通过记录应绑定 [V1 闭环矩阵](V1-CLOSURE.md) 中的源码提交和原始 CI 产物。文档存在、预检通过、容器健康和正式业务验收是四件不同的事。

## 交付物与原条款的对应

| 原条款 | 本仓交付路径与验证 | 不额外要求 / 不冒充 |
| --- | --- | --- |
| IF-030：新环境服务部署、连接批准、授权来源、试采集和 Skill 安装 | 下述接入顺序；真实应用 Compose TEST；MCP 真实协议集成；原生 Skill 两次编译、运行实例收据和安装生命周期 | 不要求未经授权的生产部署，不用几个容器 health 替代实际业务路径 |
| QA-002 / AC26：Skill 源控发布包、旧版本保留 | `video-skill-release` CLI 输出不可变 pack JSON + lineage manifest，宿主编译嵌入全部历史版本；实际二进制 hash、部署 receipt、CAS 安装/回滚 | 此处“发布包”是 Skill 包，不是全应用离线 ZIP、镜像 tar 或新的动态 registry |
| IF-030 / AC28：迁移失败与恢复、历史引用和未完成任务 | 原有增量迁移、备份/恢复脚本、最新独立删除日志；真实 PG 故障迁移及 dump/restore 后 pending 续跑测试 | 不把重启当备份恢复，不承诺任意旧程序可读取新 schema |
| FND-004 / R26：实际依赖与通知可追溯 | 固定上游、依赖锁、实际 image config ID、安装包清单、原通知和选定源码/附件 hash 闭包，见 [SUPPLY_CHAIN](SUPPLY_CHAIN.md) | 选定构建输入不是全应用发行清单；原条款也未强制另造一个全应用 archive、签名发布或逐字节可复现构建 |

`publish-images.yml` 会写 registry，当前仅手动触发；不能因为开发 CI 通过就触发它。本 V1 工程验证使用不推镜像的 TEST 工作流。现有镜像发布能力不等于已经获准或完成正式分发。

## 新环境最短接入顺序

1. **技术/运维负责人**固定同一个源提交，阅读私有配置模板、[只读预检](LOCAL_QUICKSTART.md) 与 [独立删除日志](DELETION_JOURNAL.md)。先确认数据库、对象存储、日志卷与既有业务环境的归属；不覆盖已有 `.env.flow`，不把私有状态放入 artifact。
2. 用 RUNBOOK 第 3 节的 Compose 组合配置并启动。Go 承担身份/网关/计费，Loom 承担业务状态，worker 仅承担媒体执行。分别核查登录、受信服务身份和 ready 状态，不把 worker 健康检查当入库成功。
3. **工作区管理员**在 `/intelligence/mcp` 创建连接；`FLOW_TRUSTED_VIDEO_MCP_SERVICES` 只绑定运维固定的服务 endpoint/身份，不代替批准。读取该连接的工具目录后，**平台 operator**显式批准所需工具。对应真实接口是 `/api/intelligence/mcp/connections`、`/:id/tools`、`/:id/approve`；普通 workspace admin 没有平台 operator 的批准权限。schema 漂移后重新检查/批准，不能忽略 hash 或允许任意内网 URL。
4. **来源维护人**先建领域 profile，再在来源页登记平台/账号、冻结 profile 版本、合法使用依据、范围/期限及不含秘密的 credential reference。先只发现并查看分页，再有界试采集；人工、调度和 MCP 必须在同一 scope 使用统一任务入口。没有真实账号授权时只能选自编合法输入/明确 fixture，不能以此计算平台成功率。
5. 在任务详情核查 input → process → 必需索引 → ready；资料 ready 后独立查看整理任务与候选。**知识复核人**核查原证据再审核/发布；模型输出不自动成为已发布知识。
6. 按 [NATIVE_RELEASE](NATIVE_RELEASE.md) 完成候选评测、人工批准、导出、CLI 源控归档、构建、运行实例确认，最后由有权用户显式安装/pin。只生成 JSON 或批准候选时，安装应保持不可用。升级/回滚提供当前安装 hash，遇 409 重新读取并确认，不自动覆盖。

可独立复跑的清洁 TEST 入口是 `scripts/fullstack/run.sh`，前置依赖见 `.github/workflows/video-fullstack.yml`。它要求 `VIDEO_FULLSTACK_TEST_ACK=DISPOSABLE_TEST_ONLY`、独立证据目录、无已有 `.env.flow` 和私有 TEST 状态；创建并只清理本次拥有的容器/卷。不要在已有业务 checkout/卷上强行绕过这些拒绝。外部模型为确定性 fixture，仍需核对整个运行终态，不能把失败前的子检查扩为全通过。

## 明确的兼容矩阵

以下为当前源码定义/验证范围，不是跨所有旧版本的兼容保证；runtime tag 的实际小版本以对应构建日志为准。

| 边界 | 当前兼容组合 | 升级/回退规则 |
| --- | --- | --- |
| 宿主 ↔ Loom API | 同源提交的 Go 路由 + Loom `/v1` 契约；既有信封、scope、幂等键和 schema 批准 | 不混用未验证的任意宿主/Loom 版本；契约改变需联合测试并重新批准受影响 MCP schema |
| Loom ↔ video-worker | `VideoManifest.schema_version=1`；输入/处理父 manifest hash、attempt/fence、对象 hash/字节严格校验；visual schema 为 1 | 未知 schema、缺失必需字段/能力拒绝导入，不通过手改 manifest 或跳过 hash 兼容旧 worker |
| 进行中任务 ↔ provider 实例 | 提交 intent 冻结 `provider_instance`、外部 task 与原 key；worker 到 DTK 另有固定 route/契约边界 | `PROVIDER_INSTANCE_CHANGED` 时恢复原锁定实例再对账；本地取消不代表远端已取消。不把旧 task ID 发给新实例，不重绑意图或释放未知费用；受控 schema-drift/rollback 测试不是实际上游新版 binary 灰度 |
| Loom DB | 本次迁移目录截至 `0033_video_budget_close_intent.sql`；0031/0032 保留模型重试 generation，0033 保留预算未知结果意图 | 新程序按迁移账本运行；没有证明旧 binary 能理解新状态时，不将其直接接回该库。失败迁移回滚/重试与整库恢复按各自证据执行 |
| 删除日志 | journal/checkpoint `version=1`、固定 journal ID/密钥、连续签名链与 DB 绑定 | 数据库可恢复旧快照，独立日志不能跟着回退；先重放最新日志再恢复视频访问。旧日志缺失/不明时隔离，不重新 init |
| 原生 Skill | 基础 `video-knowledge-core@1.0.0`；发布 manifest schema 1；所有归档 `id/version/hash` 精确存在 | 新构建保留历史包，旧 run 仍 pin 原版；新安装不改旧 pin。当前撤权检查对新旧版本均有效，无历史权限豁免 |
| runtime / 构建 | 主 Loom Docker 使用 Node 22；专项 Flow CI 使用 Node 24.22.1；worker Python 3.12；Go 构建 1.25；Web Bun 1.3.9 / Nginx 1.27.5；备份 Node 22 + PG 17 + 固定 mc | 工具链角色不同，不把测试 Node 24 当作 Docker Node 22。backup 输入锁/通知核验当前仅 `linux/amd64`；ARM、原生 Windows 和其他组合不从本矩阵推定通过 |
| 非视频兼容 | video 开/关两态的 RSS/Telegram/WeChat、ASR/OCR、检索、周期 Canvas 专项 | 外部 connector/model 是 fixture；核对最终提交适用回归，不把历史绿灯继承到新提交 |

### 失败发布 / 回滚操作边界

1. 停止新调度/暂停受影响来源，保留在途 job、提交意图、fence、对象、预算收据及当前 pin；不要删除任务来消除错误。
2. 记录当前源码/镜像身份、迁移账本、备份 checkpoint 和 journal 最新位置。备份/恢复脚本入口见 RUNBOOK 第 6 节；恢复前停止所有日志客户端，只使用该演练拥有的空目标库/对象位置。
3. 若新构建尚未形成 deployed receipt，旧安装不变；先修复构建或部署，不手工伪造 receipt。Skill 回滚仅显式切换已保留的历史版本并做 CAS，当前依赖被撤回时必须拒绝。
4. 若 schema/发布失败需恢复，验证备份后恢复对象与数据库，再重放最新独立删除日志；确认旧 revision/evidence 不变、待处理任务以新 fence 续跑及旧 pin 仍可解析后，才重新开启调度。实际演练使用 `video-migration-recovery.test.ts`、`video-qa.test.ts` 与双 binary 发布测试；不是任意版本降级承诺。
5. 不能用 `docker compose down --volumes`、删迁移账本、删 journal 锁或改“已完成”状态做回滚。独立日志未知锁按离线恢复流程处理。

## 六类必需诊断

先收集当前 workspace、operation/job、stage、规范化 error code、已确认外部状态时间、profile version、attempt/fence 与同键恢复结果；不要采集 Cookie、API key、签名 URL、原始私有响应或完整内容。界面入口与字段见 [HOST_UI](HOST_UI.md)，后端契约见 [CONTRACTS](CONTRACTS.md)。

| 现象 | 按顺序检查 | 允许恢复与禁止动作 |
| --- | --- | --- |
| 超时 / 回复丢失 | ①区分短 API/MCP 请求和后台任务；②按原幂等键查 operation/job；③查看 submission intent、已确认 task 和 `reconciliation_required`；④确认固定服务可达、租约/重试时间 | 先用任务“核对”或原键恢复；未知结果不换键重发，不延长全局超时代替持久后台任务 |
| 401/403 / `blocked_auth` | ①检查当前登录/workspace、成员与来源期限；②检查 MCP 批准/schema；③运维检查签名 issuer/audience/TTL、服务绑定和 scoped credential reference | 由各自责任人恢复当前授权/轮换私有凭据，再显式重试/对账原任务；禁止把秘密放 UI/模型/日志，禁止改为全局信任 |
| 429 / `retry_wait` | ①看 error、next retry 与 `Retry-After`；②区分外部平台限流和本地 quota/budget；③看 source/provider 冷却、窗口及已提交 checkpoint | 等待有界退避；必要时降低获准频率/并发。失败页不能推进稳定水位；不循环手工重试或提高预算来绕过拒绝 |
| import 失败 | ①读取具体规范化 code；②核对 schema/job/attempt/fence；③核对父 manifest、对象 scope、SHA/bytes、转录时间/覆盖与必需能力；④检查已存在同 hash receipt | `STALE_FENCE` 是拒绝迟到写入，不修改 fence。对已确认完成的原外部产物按原任务对账/重导入；对象缺失使用显式受控 repair，不能填假 hash 或造 ready |
| 外部完成但索引未 ready | ①区分 input_ready / processing_complete / embedding / knowledge_ready；②查 required/optional coverage；③查宿主 embedding 模型、维度、价格、冻结预算与 batch receipt；④区分后续知识整理失败 | 修复明确配置/授权后恢复相同阶段；required embedding 未验证时不触发最终周期 Canvas。媒体 ready 不等于知识发布，整理阻断不应重新下载 |
| 重复事件 / 重复入口 | ①比对同 scope 的业务 fingerprint、幂等键和 operation→job 关联；②检查 outbox event 与消费收据；③区分 at-least-once 传输和重复业务写入；④核查固定 document/revision 与 run pin | 重放同键应返回原结果，不产生第二次费用/发布。参数改变导致 409 时重新确认业务意图；不删除去重/账本记录强行成功 |

## 残余限制与责任

技术负责人负责最终同源码提交的集成/整栈/镜像证据；运维负责受控部署、备份恢复、密钥/日志卷与上游版本更新；平台 operator 负责 MCP 工具批准；来源维护人负责合法授权；知识复核人负责行业证据判断；发布负责人负责方法发布和第三方许可/分发义务。具体人名、首发行业、样本与真实预算由项目方确认，不能由自动化虚构签收。

真实双平台成功率、真实模型质量、独立金标和持续试点只能依据对应授权样本/实际时长记录。隔离 TEST 可证明工程条款，不能推导生产已上线或行业结果已接受。升级 BiliNote/DTK、worker 或模型时固定新版本，逐项核对接口/通知/数据契约并重跑适用回归，不追随未验证的 main。
