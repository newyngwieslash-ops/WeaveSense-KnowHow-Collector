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
```

第二条在临时源码副本中执行真实 CLI，产生两版归档，真正编译并启动新 Go 测试可执行文件，验证实际嵌入版本、可执行文件 hash 回执、安装/升级/回滚 CAS、旧运行 pin 与当前撤销拒绝。其 Loom 发布授权响应为明确的本地合成夹具，不冒充完整真实候选评测或生产部署。真实 Loom 发布域有独立测试；完整双方真实发布链、生产发布审批、真实行业数据质量及生产撤权演练仍按验收台账记录。
