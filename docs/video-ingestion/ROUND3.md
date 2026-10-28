# 第三轮：清洁 TEST 整栈与逐条验收证据

## 当前结论：用例已实现，整栈结果仍待核验

本轮目标是从空数据库和独立临时卷启动**真实应用整栈**，验证浏览器、Go 身份/授权、Loom 编排、Python worker、PostgreSQL 与 MinIO 的内部调用，而不是继续用 HTTP 模拟响应替代宿主。当前已编写 harness 并推送到 [独立测试分支](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/tree/feat/knowhow-fullstack-acceptance)；本页尚未记录一条成功整栈运行，**不能据此宣布 Compose 部署或业务验收通过**。

映射编写时的阶段提交为 [`f0347739`](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/commit/f0347739bac701ff3733559f4a44c0f2cc5542ca)，它不是“最终已验证 head”。[Actions 运行列表](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions?query=branch%3Afeat%2Fknowhow-fullstack-acceptance)的结果必须与具体 checkout SHA、原始产物对应。Draft PR 尚未创建，等待明确授权；分支推送不是合并或生产部署授权。

| 项目 | 本页记录的状态 | 不能推导出的结论 |
| --- | --- | --- |
| 局部脚本检查 | 46 项本地脚本测试通过，包括 4 项模型 fixture 契约/HTTP 测试、3 项配置安全测试及Nginx动态上游配置回归；Shell/Python/Node 语法与 diff 检查通过 | 不代表容器、浏览器或业务用例已执行 |
| 浏览器 harness | live suite 发现 1 个场景，initial / restart 分两次调用；旧模拟边界 suite 保持独立 | 不代表页面选择器、服务交互或重启已通过 |
| 第一次 Actions 验证 | `20fce7b` 的 [整栈运行 40614778081](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40614778081)因 job 环境中使用不可用的 `runner.temp` 上下文而未启动 job；`f0347739` 将其移到 step 环境 | 工作流解析修正不是运行成功 |
| 首次实际构建/启动 | `f0347739` 的 [运行 40614875677](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40614875677)已构建5个应用/fixture镜像，PG/Redis/MinIO及Go/Web启动；Web仅接internal网络没有发布端口，宿主bootstrap连接被拒绝 | 不是整栈成功；未执行浏览器闭环。已按产物修正仅Nginx双网络入口，后台保持内部网络 |
| 第二次真实整栈启动 | `11ce4538` 的 [运行40615728450](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40615728450)已空环境启动8个服务并通过真实注册/工作区引导；平台重建后Nginx缓存旧IP，登录会话返回502，真实UI正确显示认证恢复错误 | 不是浏览器闭环成功。已修正生产Nginx动态DNS上游并固定1.27.5，保留Web不重建断言，待重跑确认 |
| 代理恢复与真实登录 | `9a2e16ed` 的 [运行40616976301](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40616976301)确认后端容器已重建、Web容器未重建、匿名会话代理恢复200；真实页面登录与知识域创建通过 | 浏览器误点AntD虚拟下拉的离屏辅助选项而超时，尚未创建来源或触达worker；修正为真实键盘选取后重跑。8个真实应用/数据服务之外另有1个模型fixture |
| 整栈及最终 head CI | 待实际结果与产物核验 | 不沿用第二轮或中间提交的成功结果 |
| 正式 V1 台账 | 本轮映射不修改 [PROGRESS.json](PROGRESS.json)；29 项全局 AC 均未由本页认定完成 | 测试数量不是业务验收百分比 |

## 本轮真实与合成边界

预期执行链为：

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

源码与检查：[docker-compose.video.yml](../../docker-compose.video.yml)、[test_video_deployment.py](../../scripts/test_video_deployment.py)。静态检查只证明配置合同；运行时环境与闭环仍须由实际 TEST 产物建立。

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
- 退出时只清理这次拥有的 TEST 项目卷和新建独立日志，删除生成的环境文件与密码状态文件。清理记录与成功结果不同；不得把本脚本的 `down --volumes` 用作生产升级/回退操作。
- 剩余非秘密 TEST 状态不会自动被当作下一次空环境；再次运行应使用新的专用 checkout，而不是盲目删除任意部署目录。

## 应收集和核对的产物

以下是输出合同，**不是已经存在或已经核验的成功产物**。失败时可能只生成其子集。工作流上传 `video-fullstack-evidence`（保留期 14 天）；证据不包含私有密码状态、`.env.flow`、含登录秘密的 trace/HAR。

| 预期文件 | 证明内容与核对要求 |
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

记录一条成功结果时，必须补齐：准确源码提交、运行 URL、job 终态、artifact ID/digest、两浏览器阶段通过、观察器全部检查通过、真实服务重启和对象/证据身份对照，以及失败/跳过名单。若只有 build、health 或单阶段结果，保留其部分状态。不要为把文档写入自身 SHA 而无限产生新提交；最终交付另核查 final head 的实际 checks。

## AC01–AC29 原条款映射

原文与任务关联完整保留在 [round3-acceptance-map.json](evidence/round3-acceptance-map.json) 的每条 `original`；基线 SHA-256 为 `0def0d9514aeaac544034dbd6994c76041d35f0c2968011ee02770c86ae2e046`。下表均为本轮待验证覆盖，不是通过清单。AC30/P2 保持范围外且未从原始基线删除。

| 原验收项 | 本轮状态 | 已编写或相关的工程覆盖 | 仍需满足的原条件 |
| --- | --- | --- | --- |
| AC01 B站单视频闭环 | 局部用例已编写，待实跑 | 自编英文字幕经真实宿主内部链路形成文档、时轴证据与知识发布；来源界面的 B站 URL 只作标识，不访问平台。 | 合法可用的真实 B站视频及首发行业配置；真实平台获取/转写；实际宿主 Agent 正确引用；本次仅普通知识检索和证据 UI；本轮真实执行成功产物与人工确认 |
| AC02 抖音单视频闭环 | 本轮未覆盖 | 本轮没有抖音短链、连接、下载或转写；B站形式来源标识也不是平台实测。 | 合法抖音视频和可用连接；实际分享短链归一化、下载、转写及证据入库 |
| AC03 关闭聊天后的持续执行 | 仅相关证据，不满足原例 | 浏览器进程退出后重启服务并读取既有已完成资料；不是无人值守新增采集。 | B站与抖音各一个授权账号；实际两个调度窗口及关闭浏览器/聊天期间新增任务与候选记录 |
| AC04 发现分页失败 | 本轮未覆盖 | 本轮不执行账号发现、分页故障或游标恢复。 | 多页账号样本和第二页临时失败；发现期间重启、恢复、不漏任务与游标可解释的执行证据 |
| AC05 同一提交重放 | 局部用例已编写，待实跑 | 浏览器 HTTP 同键同参复用任务、异参409；清洁 scope 预期恰有一个完成任务及一个故意无效输入任务，防止隐藏重复。 | 定时和批准 MCP 路径与手工路径的交叉重放；真实下载及跨入口不重复发布/对象/费用证明；本轮真实执行产物 |
| AC06 任务租约与外部结果不明 | 仅相关证据，不满足原例 | 只重启已完成任务所在服务，核对持久身份；不等于在途 fencing 或未知远端结果恢复。 | 运行中终止 worker、旧阶段结果回送；外部已接受但 task ID 响应丢失；当前 fencing 提交、已确认任务复用及 reconciliation_required 的故障证据 |
| AC07 取消与晚到回调 | 本轮未覆盖 | 本轮不取消运行中媒体任务，不模拟晚回调。 | 运行中媒体任务；远端 cancel 不支持及成功晚回调；宿主阻止发布、隔离清理、真实取消状态和已发生 usage 保留 |
| AC08 无字幕视频 | 本轮未覆盖 | 使用提供的定时字幕，ASR 禁用；字幕时轴不是语音识别结果。 | 普通话无字幕合法样本；实际 ASR 模型及原始 segments/时间映射/引用定位 |
| AC09 长视频与大量segments | 局部用例已编写，待实跑 | 空必需字幕上传应由真实 worker 拒绝422，任务仍 awaiting_input，无文档/ready；只证明小输入拒绝路径。 | 超过2000段且超过旧文本上限的长样本；分段处理和中断恢复；完整清单、无静默截断及真实缺口门禁 |
| AC10 静音画面与并发抽帧 | 本轮未覆盖 | 无媒体、视觉、抽帧、OCR 或 VLM，不用没有播放器推断视觉门禁通过。 | 静音PPT、短片、尾组不足网格及两并发任务；视觉必需处理、取消单任务、帧完整性/目录隔离及必需失败门禁 |
| AC11 元信息更新 | 本轮未覆盖 | 已完成文档在重启后保持 hash 不等于再次采集标题/描述修订。 | 已转写且被引用的视频；仅元信息变化的再次采集；正文保留与 raw/derived 版本关系证据 |
| AC12 中文emoji引用 | 仅相关证据，不满足原例 | 一条英文字幕核对固定引文、时段与内容 hash；UI 出现 UTF-16 标签不是中文/emoji偏移验收。 | 含混合中文和 emoji 的多段标注文本；跨段证据的 UTF-16 精确偏移与时间映射 |
| AC13 就绪屏障与事件重投 | 局部用例已编写，待实跑 | 无效必需输入不能 ready；成功路径检查一次 ready 和知识候选。未注入索引失败或重投。 | 已有 ready 旧版本；worker 成功后索引失败，旧 revision 继续可见；恢复、事件重投后一次切换与一次有效下游执行 |
| AC14 无依据的事实 | 仅相关证据，不满足原例 | 确定性 fixture 仅复制真实冻结证据并明确 real_industry_validation 缺失；不是模型对无依据请求的行为评测。 | 缺少目标参数的真实或受控材料；明确要求缺失参数的负向任务；模型/发布门禁拒绝伪造事实的真实宿主执行及人工判定 |
| AC15 转载与冲突 | 本轮未覆盖 | 本轮只有单一自编来源，不评估独立来源或冲突。 | 两份转载和一份冲突材料；来源归并、非独立佐证处理及冲突条件/证据保留 |
| AC16 复核批准发布与撤回 | 原流程工程用例已编写，待实跑 | 通过真实 UI 提交/批准，编辑产生新版；旧版发布请求应409，重新批准后发布，重启后撤回并从默认检索移除。输入仍为工程合成材料。 | 初始和重启阶段全部成功且绑定同一提交；产物核对真实批准、版本/hash、发布和撤回记录；对应负责人确认原条款；不由脚本数量自动更新任务台账 |
| AC17 跨工作区越权 | 局部用例已编写，待实跑 | 覆盖匿名读取和不存在/无成员 workspace 选择器拒绝；读取实际数据库角色和 FORCE RLS 配置。不存在 scope 不是已存在 workspace B。 | 两个实际 workspace 各自已有视频文档；跨工作区替换 job/document/evidence/object ID 的逐项拒绝；日志无另一工作区信息泄露 |
| AC18 MCP超时和输出边界 | 仅相关证据，不满足原例 | 浏览器普通宿主 HTTP 返回任务句柄并读取产物；没有批准 MCP 连接或长任务分页压力。 | 批准的 MCP 连接与较长视频；实际 MCP start 的短调用及后台执行；完整游标分页且无数据丢失 |
| AC19 内网目标与重定向 | 仅相关证据，不满足原例 | TEST 后台/worker/模型网络无外网，仅 Nginx 双网络提供 loopback Web；固定模型 fixture 主机，不放宽通用私网保护。配置隔离不是恶意请求测试。 | 私网/元数据/配置外目标与跨域重定向负向请求；真实公共入口 SSRF 阻断和受信内部通路固定服务验证 |
| AC20 字幕提示注入 | 本轮未覆盖 | 固定无恶意字幕和确定性模型不构成提示注入抵御测试；本轮不调用原生整理 Skill。 | 含忽略指令/外传要求的字幕；实际原生知识整理 Skill 执行；无未授权调用/外传的行为证据 |
| AC21 凭据与限流 | 仅相关证据，不满足原例 | 临时凭据最小暴露、运行日志和 ps 元数据脱敏；不模拟过期平台凭据、429 或恢复。 | 过期平台凭据和可控429；宿主需授权/重试时间状态及更新凭据后恢复；UI/模型上下文/日志秘密泄漏专项检查 |
| AC22 预算耗尽 | 仅相关证据，不满足原例 | 模型经真实宿主网关并要求实际 accounting headers，返回非零 usage；未耗尽 workspace 额度，不据此宣称结算去重完成。 | 很小 workspace 处理额度；超额连续提交、重任务阻塞、已完成阶段复用；实际账本 usage 不重复结算 |
| AC23 来源停用到期与撤权 | 仅相关证据，不满足原例 | 知识撤回排除默认检索是相关行为，不等同来源停用、媒体到期、平台404或撤权/擦除。 | 仍有文本保留授权的已发布视频知识；分别执行停用订阅、媒体到期、远程404、撤权/擦除；历史保留/不可播放区分及 Skill 依赖撤权传播 |
| AC24 现有功能兼容 | 本轮未覆盖 | 继续运行既有全量质量/集成工作流，最终结果须匹配最终提交；本整栈 harness 不覆盖 RSS/Telegram/WeChat 的开关对照。 | 对应最终提交的既有回归结果和跳过明细；视频启用/关闭两种配置下 RSS/Telegram/WeChat、ASR/OCR、检索和周期 Canvas 对照 |
| AC25 实际宿主Agent使用 | 本轮未覆盖 | 普通知识检索、证据 UI 与模型整理不代表实际 Agent 或 Canvas 原生 Skill 调用。 | 已就绪资料与原生整理 Skill；intelligence 及 Canvas 两个真实入口调用；正确 Skill version/hash 和宿主 evidence ID 返回 |
| AC26 Skill评测批准部署安装 | 本轮未覆盖 | 构建测试服务不是方法版本发布/安装/回滚；本轮未执行候选 Skill 生命周期。 | 候选 Skill、冻结评测集、运行中旧版本；评测/批准/构建/部署/安装/回滚；历史版本可加载、新 run pin、批准与生效分离以及撤权仍阻断旧引用 |
| AC27 Skill负向与回归测试 | 本轮未覆盖 | 确定性模型 fixture 不提供行业 Skill 效果或拒答/补充能力证据。 | 不适用和缺材料任务及固定模型/输入；无 Skill /启用知识/候选 Skill 三基线；关键输出无退化、负向处理及证据有效性的人工评估 |
| AC28 迁移失败与恢复 | 局部用例已编写，待实跑 | 从空库实际迁移、已完成文档/引用/对象重启后保持身份和 hash；没有失败迁移、备份还原或在途续跑。 | 备份及可回滚增量迁移；实际迁移/发布失败与恢复；历史 revision/引用保留及未完成任务继续执行 |
| AC29 试点持续运行 | 本轮未覆盖 | 一次性清洁 TEST 运行及重启不计入持续试点，不压缩或虚构试点窗口。 | M0冻结行业、5至10个问题、授权来源/样本、复核人与发布人、预算/保留期；冻结的真实试点时长（原条款默认建议7天）；持续运行的发现量、阶段成功失败、费用和人工知识质量结果及未结阻塞 |

## 仍未关闭的输入与决定

首发行业、5–10 个实际业务问题、合法双平台来源/样本、标注金标、知识复核人与 Skill 发布负责人、允许模型与预算、保留期限、部署目标和冻结试点时长仍须明确。它们不阻塞上述有限工程测试，却决定真实平台、质量和发布验收。不能把合成 fixture 的结果转换成业务成功率、ASR/视觉精度或持续运行承诺。

[第二轮记录](ROUND2.md)继续保存其自己的提交与结果；[RUNBOOK](RUNBOOK.md)的生产/恢复约束不因临时 TEST 脚本而放宽；正式状态仍以 [PROGRESS.json](PROGRESS.json) 和不可改写的 [原始任务基线](spec/tasks.baseline.json)为准。
