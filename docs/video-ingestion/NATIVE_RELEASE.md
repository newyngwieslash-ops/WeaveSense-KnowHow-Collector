# 视频方法原生发布与版本保留

这条路径是源码驱动的宿主原生 Skill 发布，不是动态插件注册表。候选通过评测、人工批准、导出、编译、运行实例确认、工作区安装是不同状态。生成 JSON 或 CI 构建成功不能标记为已部署。

## 源码准备

从有权限的 Loom 导出接口取得完整候选响应，保存到访问受限的临时文件。该文件含冻结证据引用文本、评测输出及审核理由，**不得提交仓库**。

在 `backend` 执行：

```sh
go run ./cmd/video-skill-release --input /secure/path/export.json --check
mkdir -p internal/flow/skillpacks/releases
go run ./cmd/video-skill-release --input /secure/path/export.json \
  --archive-root internal/flow/skillpacks/releases
go test ./internal/flow -run TestIndustryPackExport -update-video-releases
```

工具校验候选、评测、人工批准、原生 base 与包 hash 的冻结关系，输出不可变的 `<pack-id>/<version>.json` 和 `.manifest.json`。清单仅保留 scope、ID、hash、批准人和时间、依赖集合摘要，不复制证据正文、评测输出或自由文本审核理由。相同文件可安全重试；同版本不同字节、符号链接路径及不明写锁拒绝覆盖。历史文件不得删除以“更新”版本。

宿主递归嵌入历史目录；原有根目录包 ID/Skill ID 保留，不允许候选覆盖。归档包固定 `kind=video-method`、一个 Skill、数字三段版本；相同 ID+版本冲突、清单/源码 hash 不符、base 不可用或跨工作区同包冲突均拒绝加载。已有非视频包的默认查找语义不变。归档包的正文仅向清单所属 tenant/workspace 的原有已认证入口开放。

## 当前运行实例确认

审核源码差异、执行测试并按既有发布流程构建和启动宿主后，由受信发布操作者调用：

```text
POST /api/internal/flow/video/skills/:id/attest
Authorization: Bearer <短时内部执行令牌，不得放入 URL 或日志>
{"version":"1.2.0","hash":"<精确原生 Skill hash>"}
```

令牌 issuer/audience 均为配置的宿主 issuer，actor=`service_principal:video-skill-deployer`，scope=`intel.skills.deploy`，tenant/workspace 必须匹配编译清单。浏览器用户没有这个 service scope。

运行实例从实际嵌入注册表读取版本，计算 `os.Executable()` 文件 SHA-256，并向 Loom `deployment-check` 复核当前候选、批准、导出包及证据依赖。随后现有宿主 command outbox 发送含实际 executable hash、release-package hash 的 deployed receipt；未确认回执只返回 pending/failed 状态，不能称为部署成功。返回的 `deployment_target=this_running_host` 不代表生产环境、所有副本或外部 CI 已验收。

## 安装、回滚及旧运行

已有用户接口 `POST /api/intelligence/video/skill-candidates/:id/install` 使用：

```json
{"skill_id":"method-id","version":"1.2.0","hash":"target-native-hash","expected_hash":"candidate-hash","expected_install_hash":"current-installed-native-hash"}
```

首次安装可省略 `expected_install_hash`。更换版本或回滚必须提供当前安装 hash；工作区行锁下 CAS 校验失败返回 409，不自动覆盖。相同幂等键与参数恢复同一安装回执。通用 `/skills/install` 拒绝 `video-method`，不能绕过 Loom 已部署状态及当前依赖检查。

运行第一次载入时冻结版本/hash 和知识发布快照；后续安装或回滚不改旧运行 pin。旧版本必须继续存在于编译归档中，且每次运行仍检查当前撤销/过期状态；历史 pin 不提供撤权豁免。

## 可重复验证与边界

```sh
go test ./internal/flow -run 'TestVideoRelease(Canonical|Frozen|Archive)' -count=1
FLOW_VIDEO_RELEASE_BUILD_TEST=1 go test ./internal/flow -run TestVideoRelease -count=1 -v
FLOW_VIDEO_RELEASE_BUILD_TEST=1 go test ./internal/flow -run TestVideoQALoomExportBuildAndRunningRegistry -count=1 -v
```

第二条在临时源码副本中执行真实 CLI，产生两版归档，真正编译并启动新 Go 测试可执行文件，验证实际嵌入版本、可执行文件 hash 回执、安装/升级/回滚 CAS、旧运行 pin 与当前撤销拒绝。其 Loom 发布授权响应是明确的本地合成夹具。

第三条不伪造评测报告或 Loom 发布响应：持久 Loom 上的真实 `VideoKnowledgeEvaluator` 经 HTTP 调用真实 Go Model Gateway、ModelTasks 与 Billing。两个版本分别执行 20 条合成用例 × 原版本/无 Skill/候选三组，共 120 个模型任务；只有外部模型响应、原始证据及审核用户是合成夹具。每次响应具有真实任务/预算/usage receipt，确定性评分独立于模型自报通过；两次父预算分别消费 1800 micro 的**合成计量**，不是向外部付费服务消费。候选通过真实批准/导出 API 后，CLI 先只把 v1 写入隔离源码副本并编译、运行宿主测试可执行文件；该旧构建完成部署、安装及 run pin，随后将宿主 SQLite 持久化。加入 v2 后重新编译另一个可执行文件，复用旧宿主数据库和原 Loom 持久库，核对两个 binary hash 确实不同而旧 run 的 version/hash/知识快照不变。部署回执分别校验实际运行进程和发布包 hash，继续验证安装、更新、重复请求、CAS 冲突、回滚和当前知识撤回拒绝。批准、导出、成功部署均不自动更改 workspace pin。

这证明隔离 TEST 的跨域工程链路；不是容器 `cmd/server` 生产部署、真实行业评测、外部模型效果或业务审核确认。真实行业冻结用例、发布负责人、生产部署和试点仍按原验收台账保留，不能用这 20 条合成用例替代至少 20 条行业业务用例。

### 实际宿主浏览器阶段

`fullstack-skill-lifecycle.mjs` 在整栈真实登录、视频资料就绪、知识发布和原生方法加载之后，通过实际“方法版本”页面冻结 20 条合成评测用例与现有证据，向真实后台请求 60 个三组对比模型任务，核对独立评分、运行/usage 引用、批准理由、导出状态，以及批准/导出后安装按钮仍不可用。该阶段保留原生目录/当前 pin，不向运行容器偷偷注入候选包；源控构建与两个 binary 的安装/回滚由上面的隔离编译测试独立证明。重启后核对相同候选/hash/评测记录，撤回知识后检查候选已退役、内容不可用、安装入口消失。

浏览器脚本存在或通过语法检查不等于该阶段通过。实际结果只能来自对应源码提交的 `Video full-stack TEST acceptance` 产物，`browser-initial.json` / `browser-after-restart.json` 中 `skill_candidate` 和相应 `checks`；没有运行结果时不得提前关闭 UI 验收。

整栈只读 observer 另从真实 PostgreSQL 读取 60 个评测任务的 ID、case/variant、请求键、评分器和模型配置摘要，按 Go 宿主相同的幂等键摘要规则与外部夹具收到的调用逐一绑定。`skill-evaluation-verification.json` 要求 browser、Loom 持久记录、实际 gateway 调用三者一致，重启及撤回后没有新增模型调用，也没有虚构部署/安装 receipt；上传记录不包含方法、用例输入、证据或模型输出正文。

## 评测失败与安全恢复

`evaluation-request` 仅对确认返回 `failed`/`cancelled` 的模型任务生成新的审计 generation 与幂等键，继续受同一个候选父预算约束；不会额外提高预算。旧 task ID、状态、请求键/摘要及操作人留在最小审计历史中，不复制证据或模型全文。结果不明、丢回复、`reconciliation_required` 及成功结果后的本地校验错误均继续使用原 task/key 对账，不能靠重试再发一次模型调用。Unicode case ID 完整保留在业务输入，传给宿主的有界幂等键只使用其固定摘要。历史 blocked 行若缺少明确终态收据，先观察原任务再允许安全重试。
