# 第三轮：清洁 TEST 整栈与逐条验收证据

## 已确认：真实 TEST 整栈通过，业务验收仍未完成

[候选提交 `21410a7e0582f03afca8bb955e1349e777db033c`](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/commit/21410a7e0582f03afca8bb955e1349e777db033c) 的四项工作流、13 个 job 全部终态成功。清洁 TEST 环境实际运行了构建后的宿主 UI、真实 Go 登录/授权、Loom、Python worker、PostgreSQL、Redis 与 MinIO，完成合法字幕输入、知识候选、复核发布、检索证据、服务重启和撤回。**仅外部模型为确定性 fixture，输入为自编字幕；这不是双平台、行业质量、原生 Skill 或生产验收。**

本页和 [机器可读映射](evidence/round3-acceptance-map.json) 绑定上述**已执行应用候选**，不是后续文档提交的预先通过证明。补充证据后的 final head CI 另行核验；不为写入自身 SHA 无限产生提交。正式 [PROGRESS.json](PROGRESS.json) 不变，29 项全局 AC 未因此自动关闭。

工作位于[独立测试分支](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/tree/feat/knowhow-fullstack-acceptance)。**Draft PR 未创建：创建操作被权限审查拒绝，需明确用户授权；没有重试或以其他入口代建。** 未合并 main、未发布镜像或部署生产。

### 固定提交的执行结果

| 工作流 / 检查 | 实际结果 | 证据与边界 |
| --- | --- | --- |
| 整栈 TEST | 1 job 成功；初始浏览器场景 39.384 秒，真实服务重启后场景 8.121 秒；均 0 跳过、0 不稳定重试、0 pageerror | [40623742787](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40623742787)；14 项累计浏览器检查均真，非模拟内部 API |
| 视频集成 | 6 job 成功；Flow 205 通过 / 0 跳过；Go 1,952 顶层通过 / 5 跳过；旧 HTTP 模拟边界浏览器 6 通过；Python 视频 46 通过；宿主 ASR 7 通过 / 1 跳过 | [40623742806](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40623742806)；不重复累计 Go 子测试；旧浏览器 suite 不冒充新整栈 |
| 通用质量 | 5 job 成功；Go 1,942 顶层通过 / 15 跳过；Flow 202 通过 / 3 跳过；Web 2,530 通过，Previs 65 断言通过 | [40623742734](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40623742734)；通用配置没有开启的集成项见下文 |
| 容器检查 | 1 job 成功，构建和实际运行检查，不发布镜像 | [40623742746](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40623742746) |
| 本地辅助检查 | 候选的46项脚本测试通过；补充清理判定回归后为47项通过，语法和diff检查通过 | 只是辅助证据，不代替上述实际运行 |

初始和重启后的只读观察器均 **14/14 检查通过**：30 项源码迁移已应用；Loom 数据库角色非超级用户、无 BYPASSRLS，所检查表 FORCE RLS；恰有 1 个成功任务和 1 个故意无效输入任务、1 个 revision、1 条时轴证据、1 次 ready、1 次知识整理；2 个 MinIO 对象的 **152 / 215 字节与 SHA-256** 均重新读取核对。发布的知识是 v2，编辑后的旧批准发布返回 409；重启后仍为同一发布，随后变为 withdrawn，release 标为 revoked，默认检索排除。

前后稳定身份摘要均为 `93468eb89f11068285916a1211b374dbac66b89af01734f03e1fd1bebb560f73`。外部模型记录只有 1 次真实 HTTP 调用、150 个**合成计量 token**；这不证明真实模型质量或预算耗尽/跨入口账单去重。空字幕被拒绝422且无文档/ready，但其错误原因分类仍有已披露缺陷。

### 原始产物与保留范围

[整栈 artifact 12788677246](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40623742787/artifacts/12788677246) 已下载并核对 ZIP SHA-256：

```text
82046c914927ff1190a24c6fc8571ef8b354be295d45370622273b42a674c3c5
```

工作流原始 artifact 保留 **14 天**。[仓库保留摘要](evidence/round3-fullstack-summary.json)保存选定的脱敏结果及原始文件 hash，**不是完整日志、截图或原始 ZIP 的替代品**。映射中的 `observed_artifact` 指向该 ZIP 中准确文件与 SHA-256。发布截图恰逢浮层关闭动画，不能单靠它证明版面或流程；发布结果依据 HTTP / DOM 断言和数据库记录，撤回截图较清晰。后续截图稳定性修正仍需对应 final head 检查。

### 如实披露的条件跳过

- 集成 Go 的 5 个顶层 skip：`TestDDCatLiveImageRoundTrip`（无付费模型 key）；`TestGeneratedAssetBrowserIdentity`（未设置独立 `CANVAS_TEST_GENERATION_BROWSER_RUNNER`）；`TestVideoReleaseCompiledChild`、`TestVideoQALoomReleaseCompiledChild`（只由隔离归档父测试执行，父测试通过，顶层仍记 skip）；`TestRPCProviderRejectsIncompatibleFallbackBinary`（Linux 条件路径，另有适用测试）。
- 通用质量 Go 另有 10 个 opt-in 跨层/隔离发布测试未启用；同名测试在本候选的集成 host 中全部实际通过：`TestVideoEmbeddingRealLoomStageGatewayAndReadyBarrier`、`TestVideoKnowledgeSnapshotUsesRealLoomAndNativeRegistry`、`TestVideoQACrossLanguageGateway`、`TestVideoQAHostOnlySQLiteRestoreReconcilesAuthoritativeRevocation`、`TestVideoQAHostOnlySQLiteRestoreReconcilesAuthoritativeTombstones`、`TestVideoQALoomExportBuildAndRunningRegistry`、`TestVideoQASourceAuthorizationExpiryFencesRestoredHostCaches`、`TestVideoQATypedRetentionExpiryFencesRestoredHostCaches`、`TestVideoReadyActualLoomEventCreatesOnlyOneCanvasCommand`、`TestVideoReleaseIsolatedBuildAndRunningRegistry`。
- 通用质量 Flow 的 3 项真实 PG / embedding / 撤权前备份恢复测试因未设专用数据库或 restore opt-in 跳过；同候选的集成 Flow 全部实际执行，205 项零跳过。
- ASR 的 image-level `test_real_whisper_when_installed` 因未安装 faster-whisper 跳过，保留 7 通过 / 1 跳过。没有把字幕处理冒充 ASR 推理。
- 通用付款插件 job 的条件式 QEMU / 跨平台构建步骤未执行，canonical package 检查通过；不声称付款交易或所有条件步骤执行。**不存在“全仓零跳过”的结论。**

### 中间失败保留，不覆盖为通过

下列失败解释修复来源，不能拿其部分产物代替成功候选。它们与最终成功结果分别绑定源码：

| 阶段 | 当时实际结果 | 当时边界 / 后续修复 |
| --- | --- | --- |
| 第一次 Actions 验证 | `20fce7b` 的 [整栈运行 40614778081](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40614778081)因 job 环境中使用不可用的 `runner.temp` 上下文而未启动 job；`f0347739` 将其移到 step 环境 | 工作流解析修正不是运行成功 |
| 首次实际构建/启动 | `f0347739` 的 [运行 40614875677](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40614875677)已构建5个应用/fixture镜像，PG/Redis/MinIO及Go/Web启动；Web仅接internal网络没有发布端口，宿主bootstrap连接被拒绝 | 不是整栈成功；未执行浏览器闭环。已按产物修正仅Nginx双网络入口，后台保持内部网络 |
| 第二次真实整栈启动 | `11ce4538` 的 [运行40615728450](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40615728450)已空环境启动8个服务并通过真实注册/工作区引导；平台重建后Nginx缓存旧IP，登录会话返回502，真实UI正确显示认证恢复错误 | 不是浏览器闭环成功。已修正生产Nginx动态DNS上游并固定1.27.5，保留Web不重建断言，后续成功候选已验证 |
| 代理恢复与真实登录 | `9a2e16ed` 的 [运行40616976301](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40616976301)确认后端容器已重建、Web容器未重建、匿名会话代理恢复200；真实页面登录与知识域创建通过 | 浏览器误点AntD虚拟下拉的离屏辅助选项而超时，尚未创建来源或触达worker；修正为真实键盘选取后重跑。8个真实应用/数据服务之外另有1个模型fixture |
| 下拉选取和宿主并发回归 | `c8eda3f0` 的 [运行40619479679](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40619479679)已实际选中知识域，但通用文本断言同时匹配了选中项和aria-live播报而严格失败；同提交宿主集成job已通过 | 仍未触达视频处理。依据实际DOM缩小到选中显示项的title，并新增现有真实页面的局部回归；本地Chromium因sandbox的socket权限被拒而未启动页面，交由已获准的CI执行，不使用旁路参数。这类模拟HTTP边界UI诊断不算整栈验收 |
| 已到达真实知识发布 | `3ae32c88` 的 [运行40621061982](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40621061982)完成实际worker处理、文档/revision、知识整理、无效输入拒绝、旧批准失效409、重批及发布；10项检查通过、pageerror为0，记录实际job/document/knowledge/release ID | 随后测试错误使用textbox角色定位实际searchbox而失败；尚未执行对象只读观察器、重启及撤回，不能称整栈全部通过。该运行模型仍为合成fixture |

## 本轮真实与合成边界

本次实际执行链为：

```text
真实 Chromium / 构建后的宿主 UI
  → 同源 Go 登录 Cookie、workspace 权限和业务 API
  → 真实 Loom API / durable coordinator / Outbox
  → 真实 Python video-worker / execution SQLite
  → 真实 PostgreSQL 文档、revision、evidence、知识状态
  → 真实 MinIO 对象，逐对象读取并校验 bytes / SHA-256

Loom 知识整理 → 真实 Go Model Gateway / 预算入口
  → 唯一合成外部边界：确定性 TEST 模型 HTTP fixture
```

- **材料：**自编英文定时字幕 JSON。来源 UI 中的 B站形式 URL 是测试标识，运行不访问 B站，不声称对该平台视频取得内容或授权。
- **上传入口：**真实浏览器中带登录态调用宿主受支持的合法输入 API；现有 UI 没有合法字幕上传控件，因此不是“上传表单已验收”。知识域、来源、复核、批准、编辑、发布、检索、证据和撤回使用真实产品 UI。
- **模型：**`fullstack-synthetic` 只是本地确定性 HTTP 服务。它只接受带 `Synthetic fixture:` 标记的材料，复制实际冻结 evidence ID / revision / snippet hash，不产生审批记录；要求真实 Go 会计请求头并返回非零 usage。它不是 LLM、行业推理质量或实际费用结算去重证明。
- **未声称：**双平台真实采集、ASR 精度、视觉/OCR/VLM、音视频 Range 播放、行业质量、原生 Agent/Canvas Skill 调用、Skill 部署安装/回滚、持续试点或生产上线。字幕输入必须显示 `not_acquired`，不能凭空生成播放器。
- 不 mock `/api`，不替换 Go↔Loom↔worker 的内部调用，不直接向数据库塞入视频任务、文档、知识卡、ready 或审批事件。初始化账号走真实首次注册与个人工作区创建路径；随后退出并通过真实登录页面重新登录。

## 已修复的部署配置缺陷

1. **Loom 宿主钩子配置遗漏。** `flow/main.ts` 从 `FLOW_PLATFORM_INTERNAL_URL` 安装授权、预算状态和知识整理运行时；原视频 overlay 仅给相关角色设置了 Python 使用的 `FLOW_PLATFORM_URL`。现在为 API、scheduler、enrich 角色显式配置正确变量，覆盖实际 core+video 默认路径，而非只在测试 overlay 绕过。
2. **媒体执行器秘密过度暴露。** video-worker 原本继承整份 `.env.flow`，因此显式配置了低权限对象账号仍不能防止数据库、MinIO root、独立删除日志和模型秘密进入解码器环境。现在移除该服务的广义 `env_file`，只枚举所需变量。静态回归检查禁止整份继承及上述无关秘密。
3. **后端重建后代理地址失效。** Nginx原静态上游会继续连接已经释放的容器IP。现在固定支持动态解析的`nginx:1.27.5-alpine`，使用共享上游zone和Docker DNS resolver，保留原有五条代理的URI、SSE配置和内部接口404隔离。`9a2e16ed`运行已实际验证后端重建而Web不重启时的代理恢复；这不是只靠配置文本推定成功。
4. **并发幂等请求的SQLite快照竞争。** 同提交的宿主集成测试暴露`EnsureCloudAgent`在WAL过期读快照上升级写事务时返回锁错误。修复仅对已回滚、纯数据库事务中的类型化`SQLITE_BUSY`做有界重试；每次重新检查撤权屏障，不重试整个请求、模型调用或扣费。测试保持生产8连接池和4个同时提交，要求全部返回同一ID且任务/执行/账单/账本各一条；确定性旧快照和重试间撤权用例同时保留。
5. **真实PostgreSQL证据时间类型错误。** `3ae32c88`产物中的0–4000毫秒被驱动输出为字符串，前端的数字校验因而判为未知时间。现在只在已知证据时间的响应投影中转换规范十进制为安全非负整数，保留双null未知时间，拒绝不安全/倒序/损坏值；不改全局PG解析器、原始manifest、不可变快照或内容hash。回归同时要求损坏的旧快照不能阻止授权撤回。

源码与检查：[docker-compose.video.yml](../../docker-compose.video.yml)、[test_video_deployment.py](../../scripts/test_video_deployment.py)、[SQLite事务回归](../../backend/internal/repository/cloud_agent_admission_test.go)、[时间投影回归](../../services/loom-engine/flow/video-temporal-projection.test.ts)。静态检查只证明配置合同；上述运行时结论由候选提交的实际 TEST 产物补齐，不扩展到未执行场景。

已知但不阻塞本轮失败关闭检查的诊断缺陷：宿主`HTTPVideoProvider.uploadInput`把worker的所有422映射为`INPUT_HASH_MISMATCH`，包括空字幕的`NO_SUBTITLES`。因此负向用例只断言422、无文档、无ready，不宣称失败原因分类已正确；后续应单独补充错误分类合同与回归。

## 可重复运行：仅新建、可销毁的 TEST checkout

要求 Docker daemon、支持 `!override` 和 `--wait` 的 Compose、Node/Python，以及足够的构建资源。CI 使用 Ubuntu 24.04、Node 24.22.1、Python 3.12；实际镜像身份以该次运行记录为准。不要在已有部署目录执行。

```sh
npm --prefix .github/browser ci --ignore-scripts
(cd .github/browser && npx playwright install --with-deps chromium)

VIDEO_FULLSTACK_TEST_ACK=DISPOSABLE_TEST_ONLY \
VIDEO_FULLSTACK_EVIDENCE="$PWD/.local/fullstack-evidence" \
bash scripts/fullstack/run.sh
```

唯一编排入口是 [run.sh](../../scripts/fullstack/run.sh)，叠加真实 [Flow Compose](../../docker-compose.flow.yml)、[视频 overlay](../../docker-compose.video.yml) 和 [TEST overlay](../../scripts/fullstack/compose.test.yml)。[工作流](../../.github/workflows/video-fullstack.yml)使用同一个入口，不发布镜像。

该入口的边界：

- 拒绝已有 `.env.flow`、`.local/video-fullstack`、同项目容器/卷或同名外部日志卷；不覆盖用户环境，不复用旧 journal 来冒充新环境。
- 新建随机临时凭据；先通过真实首次注册创建账号和工作区，再将视频开关限定为这一个实际 workspace。没有永久测试账号、认证旁路或“所有工作区”启用。
- MinIO video 账号只允许此 tenant/workspace 的 video 前缀；worker 不挂载独立删除日志。日志只对这次新建的外部卷初始化一次。
- Go、Loom、worker、模型 fixture 及数据服务仅接 internal 网络；只有 Nginx Web 同时接 TEST ingress 网络并映射到 `127.0.0.1:4180`。镜像构建阶段下载既定依赖与注册表材料，不据此宣称完全离线或可重复供应链闭包。
- 初始浏览器进程退出后，真实重启 platform、Loom API、scheduler、video-worker，保持卷；重新登录核对同一文档/revision/evidence/知识发布与对象 hash，再执行撤回。
- 退出时只清理这次拥有的 TEST 项目卷和新建独立日志，删除生成的环境文件与密码状态文件；不得把本脚本的 `down --volumes` 用作生产升级/回退操作。
- 剩余非秘密 TEST 状态不会自动被当作下一次空环境；再次运行应使用新的专用 checkout，而不是盲目删除任意部署目录。

## 已核对产物与复现合同

后续采证加固还增加了截图前等待真实浮层关闭，以及`cleanup-verification.json`：记录本项目删除/查询退出码并核查本项目容器、卷和确切独立日志卷均已不存在；错误或残留使TEST失败，不扩大删除范围、不重试不明结果，凭据文件清理仍执行。**这些是后续head的验证项，不回填到`21410a7e`成功候选**；该候选的退出清理是best-effort，未证明资源已全部消失。

下表文件已在上述成功候选的原始 artifact 中核对，也作为后续复现的输出合同。失败运行可能只产生子集；必须独立标明结果。工作流上传 `video-fullstack-evidence`（保留期 14 天），不上传私有密码状态、`.env.flow` 或含登录秘密的 trace/HAR。

| 原始产物文件 | 证明内容与核对要求 |
| --- | --- |
| `source-commit.txt` | 实际 `git rev-parse HEAD`，不使用 PR merge SHA 代替 checkout head |
| `build.log`、`images.json`、`healthy-start.jsonl` | 实际构建、服务镜像/容器与启动状态；镜像 ID 不等同已发布 registry manifest digest |
| `bootstrap.json` | 真实首用户注册和 workspace 创建的非秘密标识；不是业务资料种子 |
| `browser-initial.json` | 任务/operation/profile/document/revision/knowledge/release/evidence 标识、hash、分项断言和脱敏 HTTP 路径/状态 |
| `browser-after-restart.json` | 同提交下重新登录、持久发布与引用、UI 撤回后默认检索排除 |
| `persistence-before-restart.json`、`persistence-after-restart.json` | PostgreSQL 只读事务的迁移/角色/RLS/任务/文档证据/审批发布，以及实际 MinIO 读取校验；观察器不写业务状态 |
| `restart-verification.json` | 重启前后对象 hash、任务 ID 和稳定文档/证据/发布身份一致；不是在途任务恢复或两调度窗口证明 |
| Playwright 阶段 JSON 与显式截图 | 实际页面、零 pageerror 和阶段结果；initial/restart 分目录，防止第二次运行抹掉第一阶段 |
| `service-logs.txt`、`containers.jsonl`、`outcome.json` | 脱敏诊断、终止退出码与 `production_ready=false`；ps 的 Command 也需脱敏，避免 Redis 密码进入产物 |

复现或新增成功结果时，仍必须补齐：准确源码提交、运行 URL、job 终态、artifact ID/digest、两浏览器阶段通过、观察器全部检查通过、真实服务重启和对象/证据身份对照，以及失败/跳过名单。若只有 build、health 或单阶段结果，保留其部分状态。不要为把文档写入自身 SHA 而无限产生新提交；最终交付另核查 final head 的实际 checks。

## AC01–AC29 原条款映射

原文与任务关联完整保留在 [round3-acceptance-map.json](evidence/round3-acceptance-map.json) 的每条 `original`；基线 SHA-256 为 `0def0d9514aeaac544034dbd6994c76041d35f0c2968011ee02770c86ae2e046`。下表记录候选提交的**工程覆盖**与仍缺失的原条件，**不是正式通过清单**。AC16 的复核生命周期已真实执行，但是否关闭正式任务仍需对应负责人确认；AC30/P2 保持范围外且未从基线删除。

| 原验收项 | 本轮证据状态 | 实际或辅助工程覆盖 | 仍需满足的原条件 |
| --- | --- | --- | --- |
| AC01 B站单视频闭环 | 工程子集已实测，原例未闭合 | 自编英文字幕经真实宿主内部链路形成文档、时轴证据与知识发布；来源界面的 B站 URL 只作标识，不访问平台。 | 合法可用的真实 B站视频及首发行业配置；真实平台获取/转写；实际宿主 Agent 正确引用；本次仅普通知识检索和证据 UI；真实平台与行业结果的人工确认 |
| AC02 抖音单视频闭环 | 原例本轮未覆盖 | 本轮没有抖音短链、连接、下载或转写；B站形式来源标识也不是平台实测。 | 合法抖音视频和可用连接；实际分享短链归一化、下载、转写及证据入库 |
| AC03 关闭聊天后的持续执行 | 相关实测，不满足原例 | 浏览器进程退出后重启服务并读取既有已完成资料；不是无人值守新增采集。 | B站与抖音各一个授权账号；实际两个调度窗口及关闭浏览器/聊天期间新增任务与候选记录 |
| AC04 发现分页失败 | 原例本轮未覆盖 | 本轮不执行账号发现、分页故障或游标恢复。 | 多页账号样本和第二页临时失败；发现期间重启、恢复、不漏任务与游标可解释的执行证据 |
| AC05 同一提交重放 | 工程子集已实测，原例未闭合 | 浏览器 HTTP 同键同参复用任务、异参409；清洁 scope 实测恰有一个完成任务及一个故意无效输入任务，防止隐藏重复。 | 定时和批准 MCP 路径与手工路径的交叉重放；真实下载及跨入口不重复发布/对象/费用证明 |
| AC06 任务租约与外部结果不明 | 相关实测，不满足原例 | 只重启已完成任务所在服务，核对持久身份；不等于在途 fencing 或未知远端结果恢复。 | 运行中终止 worker、旧阶段结果回送；外部已接受但 task ID 响应丢失；当前 fencing 提交、已确认任务复用及 reconciliation_required 的故障证据 |
| AC07 取消与晚到回调 | 原例本轮未覆盖 | 本轮不取消运行中媒体任务，不模拟晚回调。 | 运行中媒体任务；远端 cancel 不支持及成功晚回调；宿主阻止发布、隔离清理、真实取消状态和已发生 usage 保留 |
| AC08 无字幕视频 | 原例本轮未覆盖 | 使用提供的定时字幕，ASR 禁用；字幕时轴不是语音识别结果。 | 普通话无字幕合法样本；实际 ASR 模型及原始 segments/时间映射/引用定位 |
| AC09 长视频与大量segments | 工程子集已实测，原例未闭合 | 空必需字幕上传已被真实 worker 拒绝422，任务仍 awaiting_input，无文档/ready；只证明小输入拒绝路径。 | 超过2000段且超过旧文本上限的长样本；分段处理和中断恢复；完整清单、无静默截断及真实缺口门禁 |
| AC10 静音画面与并发抽帧 | 原例本轮未覆盖 | 无媒体、视觉、抽帧、OCR 或 VLM，不用没有播放器推断视觉门禁通过。 | 静音PPT、短片、尾组不足网格及两并发任务；视觉必需处理、取消单任务、帧完整性/目录隔离及必需失败门禁 |
| AC11 元信息更新 | 原例本轮未覆盖 | 已完成文档在重启后保持 hash 不等于再次采集标题/描述修订。 | 已转写且被引用的视频；仅元信息变化的再次采集；正文保留与 raw/derived 版本关系证据 |
| AC12 中文emoji引用 | 相关实测，不满足原例 | 一条英文字幕核对固定引文、时段与内容 hash；UI 出现 UTF-16 标签不是中文/emoji偏移验收。 | 含混合中文和 emoji 的多段标注文本；跨段证据的 UTF-16 精确偏移与时间映射 |
| AC13 就绪屏障与事件重投 | 工程子集已实测，原例未闭合 | 无效必需输入不能 ready；成功路径检查一次 ready 和知识候选。未注入索引失败或重投。 | 已有 ready 旧版本；worker 成功后索引失败，旧 revision 继续可见；恢复、事件重投后一次切换与一次有效下游执行 |
| AC14 无依据的事实 | 仅辅助相关证据 | 确定性 fixture 仅复制真实冻结证据并明确 real_industry_validation 缺失；不是模型对无依据请求的行为评测。 | 缺少目标参数的真实或受控材料；明确要求缺失参数的负向任务；模型/发布门禁拒绝伪造事实的真实宿主执行及人工判定 |
| AC15 转载与冲突 | 原例本轮未覆盖 | 本轮只有单一自编来源，不评估独立来源或冲突。 | 两份转载和一份冲突材料；来源归并、非独立佐证处理及冲突条件/证据保留 |
| AC16 复核批准发布与撤回 | 工程流程已实测，待正式确认 | 通过真实 UI 提交/批准，编辑产生新版；旧版发布请求已返回409，重新批准后发布，重启后撤回并从默认检索移除。输入仍为工程合成材料。 | 对应负责人确认原条款；本轮实测为合成材料的工程流程，不由脚本数量自动更新任务台账 |
| AC17 跨工作区越权 | 工程子集已实测，原例未闭合 | 实测匿名读取和不存在/无成员 workspace 选择器拒绝；读取实际数据库角色和 FORCE RLS 配置。不存在 scope 不是已存在 workspace B。 | 两个实际 workspace 各自已有视频文档；跨工作区替换 job/document/evidence/object ID 的逐项拒绝；日志无另一工作区信息泄露 |
| AC18 MCP超时和输出边界 | 相关实测，不满足原例 | 浏览器普通宿主 HTTP 返回任务句柄并读取产物；没有批准 MCP 连接或长任务分页压力。 | 批准的 MCP 连接与较长视频；实际 MCP start 的短调用及后台执行；完整游标分页且无数据丢失 |
| AC19 内网目标与重定向 | 仅辅助相关证据 | TEST 后台/worker/模型网络无外网，仅 Nginx 双网络提供 loopback Web；固定模型 fixture 主机，不放宽通用私网保护。配置隔离不是恶意请求测试。 | 私网/元数据/配置外目标与跨域重定向负向请求；真实公共入口 SSRF 阻断和受信内部通路固定服务验证 |
| AC20 字幕提示注入 | 原例本轮未覆盖 | 固定无恶意字幕和确定性模型不构成提示注入抵御测试；本轮不调用原生整理 Skill。 | 含忽略指令/外传要求的字幕；实际原生知识整理 Skill 执行；无未授权调用/外传的行为证据 |
| AC21 凭据与限流 | 仅辅助相关证据 | 临时凭据最小暴露、运行日志和 ps 元数据脱敏；不模拟过期平台凭据、429 或恢复。 | 过期平台凭据和可控429；宿主需授权/重试时间状态及更新凭据后恢复；UI/模型上下文/日志秘密泄漏专项检查 |
| AC22 预算耗尽 | 相关实测，不满足原例 | 模型经真实宿主网关并要求实际 accounting headers，返回非零 usage；未耗尽 workspace 额度，不据此宣称结算去重完成。 | 很小 workspace 处理额度；超额连续提交、重任务阻塞、已完成阶段复用；实际账本 usage 不重复结算 |
| AC23 来源停用到期与撤权 | 相关实测，不满足原例 | 知识撤回排除默认检索是相关行为，不等同来源停用、媒体到期、平台404或撤权/擦除。 | 仍有文本保留授权的已发布视频知识；分别执行停用订阅、媒体到期、远程404、撤权/擦除；历史保留/不可播放区分及 Skill 依赖撤权传播 |
| AC24 现有功能兼容 | 原例本轮未覆盖 | 继续运行既有全量质量/集成工作流，最终结果须匹配最终提交；本整栈 harness 不覆盖 RSS/Telegram/WeChat 的开关对照。 | 视频启用/关闭两种配置下 RSS/Telegram/WeChat、ASR/OCR、检索和周期 Canvas 对照；后续交付 head 的回归结果单独核验，不继承候选提交结论 |
| AC25 实际宿主Agent使用 | 原例本轮未覆盖 | 普通知识检索、证据 UI 与模型整理不代表实际 Agent 或 Canvas 原生 Skill 调用。 | 已就绪资料与原生整理 Skill；intelligence 及 Canvas 两个真实入口调用；正确 Skill version/hash 和宿主 evidence ID 返回 |
| AC26 Skill评测批准部署安装 | 原例本轮未覆盖 | 构建测试服务不是方法版本发布/安装/回滚；本轮未执行候选 Skill 生命周期。 | 候选 Skill、冻结评测集、运行中旧版本；评测/批准/构建/部署/安装/回滚；历史版本可加载、新 run pin、批准与生效分离以及撤权仍阻断旧引用 |
| AC27 Skill负向与回归测试 | 原例本轮未覆盖 | 确定性模型 fixture 不提供行业 Skill 效果或拒答/补充能力证据。 | 不适用和缺材料任务及固定模型/输入；无 Skill /启用知识/候选 Skill 三基线；关键输出无退化、负向处理及证据有效性的人工评估 |
| AC28 迁移失败与恢复 | 工程子集已实测，原例未闭合 | 从空库实际迁移、已完成文档/引用/对象重启后保持身份和 hash；没有失败迁移、备份还原或在途续跑。 | 备份及可回滚增量迁移；实际迁移/发布失败与恢复；历史 revision/引用保留及未完成任务继续执行 |
| AC29 试点持续运行 | 原例本轮未覆盖 | 一次性清洁 TEST 运行及重启不计入持续试点，不压缩或虚构试点窗口。 | M0冻结行业、5至10个问题、授权来源/样本、复核人与发布人、预算/保留期；冻结的真实试点时长（原条款默认建议7天）；持续运行的发现量、阶段成功失败、费用和人工知识质量结果及未结阻塞 |

## 仍未关闭的输入与决定

首发行业、5–10 个实际业务问题、合法双平台来源/样本、标注金标、知识复核人与 Skill 发布负责人、允许模型与预算、保留期限、部署目标和冻结试点时长仍须明确。它们不阻塞上述有限工程测试，却决定真实平台、质量和发布验收。不能把合成 fixture 的结果转换成业务成功率、ASR/视觉精度或持续运行承诺。

[第二轮记录](ROUND2.md)继续保存其自己的提交与结果；[RUNBOOK](RUNBOOK.md)的生产/恢复约束不因临时 TEST 脚本而放宽；正式状态仍以 [PROGRESS.json](PROGRESS.json) 和不可改写的 [原始任务基线](spec/tasks.baseline.json)为准。
