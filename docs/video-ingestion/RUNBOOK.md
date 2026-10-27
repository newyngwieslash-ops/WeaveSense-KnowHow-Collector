# WeaveSense-KnowHow-Collector：本地开发与受控上线手册

## 1. 先明确交付边界

本项目扩展固定版本的 WeaveSense-Math 宿主，不是独立 IKC 服务的复制品。Go 平台继续负责身份、权限、Agent、模型网关和账本；Loom 主 Flow Engine 是视频来源、任务、证据、知识、方法版本的唯一业务权威；Python 仅负责媒体执行及执行恢复。

当前为开发分支。`PROGRESS.json` 是执行记录，`spec/tasks.baseline.json` 是不可改写的原始需求。完整 V1 为 **81 项 P0 + 19 项 P1、29 个验收用例**；7 项 P2 保留未开始。代码、合成夹具、真实宿主接口验证、真实平台验证、人工质量评审、部署和持续试点分开记录，不能互相替代。

运行 `python scripts/video-task-ledger.py gate` 检查正式发布门槛。非零退出表示尚未正式验收，不能通过删除任务、修改基线或把待验证条目改成已完成来绕过。

## 2. 开发环境

Windows WSL2 / Linux 的第二轮只读预检和隔离镜像构建步骤见 [LOCAL_QUICKSTART.md](LOCAL_QUICKSTART.md)，实际执行结果与提交绑定见 [ROUND2.md](ROUND2.md)。预检不创建凭据、不初始化日志、不启用视频功能；通过预检也不等于生产就绪。

首轮本地验证环境使用 Go 1.25.14、Node 24.22.1、Bun 1.4.4、PostgreSQL 17.11/pgvector 0.8.0；第二轮 CI 的具体环境以各工作流和运行日志为准，不沿用历史版本作为当前测量值。现有宿主依赖保持其锁文件；Python 依赖见各服务的 requirements 与锁定说明。视频执行还需要 FFmpeg、Tesseract；本地 ASR 是独立依赖环境及只读模型目录，不与视频 API 的轻量依赖混装。

在仓库根目录安装开发依赖：

```sh
go -C backend mod download
npm --prefix backend/agent-runtime/pi ci --ignore-scripts
npm --prefix services/loom-engine ci --ignore-scripts
cd web && bun install --frozen-lockfile --ignore-scripts
```

视频执行器建议独立虚拟环境：

```sh
python -m venv .local/video-venv
.local/video-venv/bin/python -m pip install -r services/video-knowledge/requirements.txt
.local/video-venv/bin/python -m unittest discover -s services/video-knowledge -p 'test_*.py' -v
```

Windows 原生虚拟环境的 Python 路径为 `.local/video-venv/Scripts/python.exe`。宿主 shell 脚本与容器流程建议在 WSL2 或 Linux 执行；本轮没有完成 Windows 原生端到端验收，不承诺所有脚本可直接在 PowerShell 运行。

## 3. 配置与首次启动

1. 先按宿主 `.env.flow.example` 配置现有平台、数据库、对象存储及模型网关。把 `deploy/flow/video.env.example` 中需要的设置合并到私有 `.env.flow`，不得覆盖已有值或提交密钥。
2. `FLOW_VIDEO_ENABLED` 默认 false。试点必须设置真实 `FLOW_VIDEO_WORKSPACES`；空列表加 true 表示全局启用，不用于首次试点。
3. 视频 worker 没有对公网发布端口。Go → Loom → worker 的服务身份、签名委派、scope 与 fence 都必须配置，不使用平台 Cookie 代替服务密钥。
4. `FLOW_TRUSTED_VIDEO_MCP_SERVICES` 仅是固定服务传输绑定：需要准确 endpoint、service_identity、audience、固定地址。它不会代替工作区成员权限、MCP schema 审批或来源授权。
5. DTK 单独受控部署，参考 `upstream-media-lock.json` 与 `MEDIA-PROVIDER-REPORT.md`。当前源代码合同不是双平台生产成功率证明。DTK 服务 API key 使用实际要求的 `X-API-Key`，不要把平台登录凭据放进开发日志或任务参数。
6. ASR 使用审核过的离线模型清单及逐文件哈希，挂载只读模型目录；不允许启动时自动拉取漂移的模型名称。`VIDEO_ASR_MODEL_HOST_DIR` 目录应包含 `model-lock.json`。无法验证模型文件时应拒绝服务，不得输出空文本冒充成功。
7. 若 profile 要求 embedding，必须配置宿主 embedding 模型、维度和正数计费单价。默认空模型/零单价不是免费执行授权。VLM/摘要同样走宿主账本及父任务预算。

### 独立删除日志是启用前置条件

详见 [DELETION_JOURNAL.md](DELETION_JOURNAL.md)。运维单独创建 `VIDEO_DELETION_JOURNAL_VOLUME` 指定的外部卷；所有 Loom 角色使用同一卷和运行身份，worker 不得挂载该卷。目录必须支持原子 rename、排他 mkdir 与 fsync。

首次空卷才可以使用 `video-journal-cli.ts init`。挂载根是 `/var/lib/flow-deletion-journal`，DIR 是尚不存在的子目录 `/var/lib/flow-deletion-journal/journal`。设置获授权的至少 32 字节密钥，初始化生成随机 ID，再把 ID 固定到秘密配置。应用不会自动初始化。旧部署日志失踪、损坏或回退时，必须隔离视频并恢复最新独立日志，不能重新 init 解锁。

基础启动模板（先完成以上配置和初始化，再执行）：

```sh
docker compose --env-file .env.flow -f docker-compose.flow.yml -f docker-compose.video.yml --profile core --profile video config --quiet
docker compose --env-file .env.flow -f docker-compose.flow.yml -f docker-compose.video.yml --profile core --profile video up -d --build
```

按实际 profile 加 `extract`、`asr`、`research`；拆分角色时遵循宿主 `LOOM_SPLIT_ROLES` 配置，不能启动第二套独立调度。检查实际服务日志及健康状态后再对指定工作区开启视频。以上是整栈启动操作模板，不是部署成功记录。第二轮已在隔离 CI 构建 backup/worker 两个 Linux amd64 镜像并完成无网络 smoke，具体提交见 [ROUND2.md](ROUND2.md)；不能推导整栈 Compose up、真实服务或生产部署已通过。

## 4. 本地验证顺序

```sh
python scripts/video-task-ledger.py check
python -m pip install PyYAML==6.0.3
python -m unittest discover -s scripts -p 'test_video*.py' -v
go -C backend test ./cmd/video-skill-release ./internal/repository ./internal/flow
cd services/loom-engine && node --experimental-strip-types --test --test-concurrency=1 flow/*.test.ts
cd ../../web && bun run typecheck && bun run lint && bun test && bun run build
```

真实 PostgreSQL 验证使用 `services/loom-engine/validation/video-knowledge/postgres-qa.sh`。它仅创建临时集群，不接受生产数据库；设置可信 `PG_BIN`、可选 `PG_LIB_PATH`、`GO_BIN_DIR`、可写 `VIDEO_QA_OUTPUT` 后运行 `all`。脚本记录运行前后源码 hash，发生源代码漂移只能视为中间验证，不能称为冻结版本通过。

Go ↔ Loom 实际跨层用例需 `FLOW_VIDEO_CROSSLAYER_TEST=1` 与 Loom npm 依赖。完整宿主还需 Pi runtime 依赖及实际 PostgreSQL/Redis。部分测试缺依赖会跳过，必须阅读测试输出，不以退出码零推断所有路径执行。

首轮本地环境中 Chromium 和 Redis Unix socket 被沙箱拒绝，历史报告保留该结果，不回写为通过。第二轮候选 `5ac12630` 的 CI 已通过必选 Redis/PG、5 项真实 Chromium 交互和严格 Flow 零跳过门禁，结果与跳过名单见 [ROUND2.md](ROUND2.md)。Chromium 使用明确合成 HTTP 边界，不代替真实平台/Go 登录/视频行业闭环；其他 UI 的 Chrome 检查也不能代替视频闭环验收。本轮独立 ASR profile 仍有 1 项 image-level Whisper 条件跳过，不把历史推理结果冒充当前执行。合成视频与推理烟测均不能证明真实行业内容质量。

## 5. 方法版本：生成源文件不等于已部署

原生候选必须完成证据绑定、三基线评估与人工审核，导出完整授权 release package。原始导出可能含私有引文/评估输出，应保存于受控私有路径而不是仓库。

```sh
cd backend
go run ./cmd/video-skill-release --input /private/approved-export.json --check
mkdir -p internal/flow/skillpacks/releases
go run ./cmd/video-skill-release --input /private/approved-export.json --archive-root internal/flow/skillpacks/releases
```

CLI 校验冻结 hash、审批、scope、原生 base 与 pack，只输出方法 pack 及不含引文的 lineage manifest。历史版本不得覆盖；相同字节重试幂等。不同内容复用版本号、路径逃逸、符号链接、未知结果写锁均拒绝。中断后必须检查文件和锁，不能盲目删除锁或覆盖旧版本。

随后审阅源文件差异、执行测试、构建并部署新的宿主，由实际运行的宿主验证 embedded registry 及可执行文件 hash，产生部署收据，最后显式 CAS 安装到工作区。回滚也是选定历史版本并提供当前安装 hash 的显式操作，不是覆盖文件或撤销历史。CLI 不调用 GitHub、不发布镜像、不部署、不产生伪收据。

## 6. 备份、恢复与回退

视频 backup overlay 使用 `deploy/flow/backup/Dockerfile.video`，不能沿用没有 Node/维护脚本的 PostgreSQL Alpine 镜像冒充日志验证。构建需核验的 Node22 Bookworm、PostgreSQL17 Bookworm、mc 镜像 digest；第二轮已提供 [Linux amd64 镜像输入锁](../../deploy/flow/backup/video-image-lock.json) 和 [公开构建变量](../../deploy/flow/backup/video-images.env)，按 [LOCAL_QUICKSTART.md](LOCAL_QUICKSTART.md) 审阅并复制到私有配置，不覆盖现有值。其他架构必须另行核验，不得假定此锁适用。镜像不自动上传。

数据库/对象备份容器只读挂载独立日志，设置 `BACKUP_VIDEO_JOURNAL_REQUIRED=true`；checkpoint 验证失败就不能记备份成功。恢复必须先停所有日志客户端，验证快照 checkpoint，恢复对象再恢复数据库，再重放最新独立日志，最后确认跨服务清理收据。日志卷不包含在数据库/对象备份或回退中。

`complete_erasure:false` 是尚未确认全部物理与跨服务清理的真实状态。撤权/删除后默认拒绝访问；不能因旧快照恢复、缓存命中、原生 Agent resume 或晚到事件重新暴露内容。用户原始问题和财务审计记录应保留，不应通过全库清空实现删除。

回退前停止新任务、冻结/暂停受影响来源并等待或隔离在途任务，保存实际 schema 与版本证据。新增迁移不可假设可自动降级；先在隔离恢复环境演练兼容性。单纯关 feature flag 不会取消删除屏障，也不能保证旧程序识别新状态。禁止 `docker compose down --volumes` 作为升级/回退步骤。

## 7. 仍需要的真实验收输入

- 首发行业及 5–10 个具体业务问题，不能从仓库名称推断行业。
- 合法可用的 B站/抖音样本及来源授权，覆盖字幕/无字幕、长视频、静音视觉、噪声、转载和故障；保留授权范围与期限。
- 独立人工标注与审核负责人，不能用生成模型自评分代替金标。
- 允许使用的模型、实际单价、资源/费用上限、保留期限和部署位置。
- 双平台实测记录、真实浏览器流程、安全复核和完整持续试点；合成夹具不预填精度、下载成功率或稳定性承诺。

开发缺口与这些外部输入分别追踪。存在缺口时继续实现代码，不把未实现功能写成“等待凭据”。
