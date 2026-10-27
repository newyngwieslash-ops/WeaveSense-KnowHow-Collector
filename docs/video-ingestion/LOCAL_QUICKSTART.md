# 本地第二轮工程验证：WSL2 / Linux

这不是免配置安装器，也不是业务验收证明。推荐 **Linux x86-64 或 Windows 的 WSL2 x86-64**；尚未验证 Windows 原生或 ARM 主机全链路。原 PRD 的合法样本、行业金标、模型预算、人工审核与持续试点仍不可省略。

## 1. 准备与边界

- 在 WSL2 的 Linux 文件系统中保留源码，例如 `~/src/WeaveSense-KnowHow-Collector`，避免把大量 Node 依赖放在 Windows 挂载盘上。
- 先自行安装并验证 Docker Engine / Docker Desktop 的 WSL 集成、Git、Python 3.12、Go 1.25.14、Node 24.22.1、项目锁定的 Bun。不要把密钥发到聊天或提交仓库。
- 按 [RUNBOOK](RUNBOOK.md) 安装锁定依赖。当前源码位于开发分支，不要误用只有初始化 README 的 `main`。
- `.env.flow` 必须是私有配置；已有文件不得被示例覆盖。阅读 `.env.flow.example` 与 `deploy/flow/video.env.example` 后，逐项合并所需设置。
- 本轮备份输入镜像锁只覆盖 `linux/amd64`，见 `deploy/flow/backup/video-image-lock.json`。索引与子 manifest 的真实 registry 响应 SHA256 均已核对；这不等于漏洞、许可证或整个部署栈已通过审核。Bitnami legacy mc 是现有备选，不是新的维护承诺。

## 2. 只读预检

把 `deploy/flow/backup/video-images.env` 中的三个公开镜像引用复制到自己的 `.env.flow` 对应设置。预检不联网、不创建密钥、不启用功能、不初始化日志，也不创建或修改 Docker 卷：

```sh
# 只查构建镜像引用，不需要服务密钥。
python3 scripts/video-doctor.py --mode build --env-file deploy/flow/backup/video-images.env

# 启用试点前的配置检查；必须显式填写工作区列表。
python3 scripts/video-doctor.py --mode pilot --env-file .env.flow

# 在实际部署主机额外验证离线 ASR 文件，并只读查询 Docker/外部日志卷。
python3 scripts/video-doctor.py --mode pilot --env-file .env.flow --check-local-files --check-docker
```

退出码 `1` 表示有阻断项；`0` 仅表示这些静态/只读检查通过，输出中的 `production_ready` 永远是 `false`。它不会证明服务可达、授权合法、模型准确或恢复成功。配置值与子命令原始输出不打印到报告。

`--env-file` 只接受字面量 `KEY=value` / 单双引号值和注释，拒绝重复键、变量替换及命令替换；不会执行 shell。文件中的值覆盖同名进程环境值。使用支持复杂插值的配置管理器时，请先在受控本地生成最终字面量配置，不能为了通过预检把真实秘密写入仓库。

重点阻断：空试点白名单（防止全局开启）、过短/占位服务密钥、缺失独立删除日志身份、未固定备份镜像、零 embedding 价格/维度、错误 DTK scope、未验证 ASR 模型文件。ASR 必须包含锁定的模型、配置、分词器与词表；额外 preprocessing 文件也必须在锁中。

独立日志的内容完整性不由“卷存在”替代。继续使用现有 `video-journal-cli.ts verify` 流程；只有首次获授权的空卷可初始化，旧日志丢失时绝不能重新 init 解锁。见 [DELETION_JOURNAL](DELETION_JOURNAL.md)。

## 3. 可复核镜像构建，不发布

下面只加载仓库中的公开 digest 文件，不加载私有 `.env` 为 shell 代码：

```sh
set -a
. deploy/flow/backup/video-images.env
set +a
docker build --platform linux/amd64 \
  --build-arg NODE_IMAGE="$VIDEO_BACKUP_NODE_IMAGE" \
  --build-arg POSTGRES_IMAGE="$VIDEO_BACKUP_POSTGRES_IMAGE" \
  --build-arg MC_IMAGE="$VIDEO_BACKUP_MC_IMAGE" \
  --target video-backup -f deploy/flow/backup/Dockerfile.video \
  -t weavesense-video-backup:local .
docker build --platform linux/amd64 -t weavesense-video-worker:local services/video-knowledge
```

仓库 CI `Video container validation` 在隔离 runner 构建这两个镜像、以 `--network none` 执行实际运行时 smoke，再保存 image config ID、源码 commit、系统与应用包清单及部分 SPDX 清单。它不上传镜像，不连接真实业务服务，也不启动生产栈。应读取对应提交的实际 Actions 结果，不能把工作流文件存在当作构建成功。

SPDX 文件是已安装包的部分清单，许可均使用 `NOASSERTION`：不代表完整文件级 SBOM、漏洞扫描或商用许可已批准。备份复制的 Node/mc 二进制版本与哈希保存在运行时证据中；apt 包仓库仍会随时间变化，因此固定基础镜像并不保证输出字节可重复。尚需按真实发布制度完成仓库快照、漏洞/许可证审查与所有部署镜像的依赖闭包。

## 4. 启动和回归

在预检、独立日志验证及授权配置完成后，使用 RUNBOOK 的 `docker compose ... config --quiet`，先审阅再按选定 profiles 启动测试环境。当前清单只构建 backup/worker 两个镜像，不能称整个 Go/Web/Loom/PG/对象存储栈已完成容器部署验收。

检查真实登录、来源列表、任务恢复、引用时轴、候选审核与撤回。无业务凭据时只使用明确标记的合成夹具，不能输出平台成功率、行业精度或七天稳定性成绩。不得通过 `docker compose down --volumes` 回滚，独立删除日志必须保留。
