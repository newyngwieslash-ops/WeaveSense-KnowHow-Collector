# 源码精简包：重建验证与使用说明

## 结论与边界

基线提交：`cbc76b6c21f3098e7f7c311eef5973d7e9e1c0e5`。

从 Git 跟踪的 5,736 个文件中，**仅移除 41 个可重建二进制文件**：旧 `backend/server`、5 个官方支付插件包、35 个支付插件可执行载荷。精简包保留 5,695 个原文件，共 146,595,846 字节（压缩前）；所有实际源码、构建脚本、清单、许可证、资源、其他 97 个插件包及 `services/loom-engine/public/zhishi-loom-source.zip` 均保留。41 个精确路径及重建文件 SHA-256 见同目录 `source-only-rebuild.json`。仅复制 Git 跟踪文件，不复制 `.git`、运行环境缓存、依赖安装目录或未跟踪的运行用 `.env`，也未加入任何真实凭据；仓库内示例/模板环境文件保留。本次路径检查不替代全仓库凭据审计。

**这是开发源码分发，不是免安装运行包，也不是完整 V1 验收通过。** 依赖、Go/Node 工具链、模型、数据库运行数据不随源码包附送。不要用旧预编译服务替代重建。

支付插件不是 Go 主程序的内嵌二进制资源。主程序从 `plugin-packages`（或显式 `CANVAS_OFFICIAL_PLUGIN_DIR`）读取 `.yingce-plugin`，再按主机平台提取 RPC 程序。主程序的 `go:embed` 仍需要保留内置技能、提示词、协议文档、OpenAPI 等实际资源。只成功编译主程序不足以证明支付插件可用。

## 已实际验证

- 官方 Go **1.25.14 linux/amd64**，Node **24.22.1**，POSIX shell、zip/unzip；主程序使用 C 编译器，`CGO_ENABLED=1`。
- 既有模块缓存执行 `go mod verify`：**all modules verified**。最终重建使用 `GOPROXY=off`（不下载）和正常 `GOSUMDB=sum.golang.org`。未接触外部支付、模型、供应商服务，未使用真实凭据，未部署或推送。
- 默认六平台重建成功：Linux/macOS/Windows × amd64/arm64，生成 **30 个平台载荷 + 5 个 canonical Linux/amd64 副本 + 5 个插件包**。主程序重建另生成 1 个 Linux/amd64 ELF，共恢复 41 个被省略文件。
- `verify-payment-packages.sh --all linux amd64` 通过：目录文件与 ZIP 内载荷逐字节一致、各平台格式检查通过；5 个本机支付程序的非法输入烟测通过。
- 强制非缓存执行的专项测试：支付 RPC **9 通过 / 1 跳过**；协议包/目录/平台合同 **9 通过**；主程序插件注册、缺失时拒绝启用、运行时缓存/中断恢复 **13 通过**。共 **31 个顶层测试通过、1 个预期跳过、0 失败**。跳过的是 Linux 已由另一测试覆盖的非 Linux fallback 用例。
- 完整后端 `./cmd/server` 编译通过（Linux/amd64、CGO=1）。SHA-256：`31e1de9732a6e8a18e987b05c319b2a2e04b36417d51d764789d7a19a9aeed9f`。这是动态链接的 Linux 构建，不是 Windows 服务或可跨 Linux 发行版保证运行的发布二进制。
- 重建前后保留的 **5,695 个源文件全部字节相同**；原主仓库保持干净、提交未变。验证在独立副本中进行，未改生产源码或先前冻结的测试证据。

首次在无 `.git` 的归档副本里构建时，Go 尝试读取父目录 VCS 信息而失败。解决方法为显式设置 `GOFLAGS=-buildvcs=false`，不需要改源码。早期尝试曾设 `GOSUMDB=off`；这不是完整性验证措施，也不是用户推荐配置。最终重建在模块校验完成后恢复正常 sumdb，并重跑全部上述专项验证。

## Linux / WSL2 x86-64 重建命令

以下命令从**解压后的项目根目录**运行。先安装可信 Go 1.25.14、Node 24、C 编译器、zip/unzip；确保 `go`/`node` 位于 `PATH`。归档不含依赖缓存：首次 `go mod download` 会按现有 `go.mod`/`go.sum` 取得依赖，需要正常网络与校验服务；不要为绕过失败关闭校验。已有完整已校验缓存的离线环境可用 `export GOPROXY=off` 并省略下载步骤。

```sh
set -eu
export GOTOOLCHAIN=local
export GOFLAGS=-buildvcs=false
go version
node --version
(cd backend && go mod download && go mod verify)

# 不设置目标覆盖，才能恢复默认六平台合同。
unset PAYMENT_PLUGIN_GOOS PAYMENT_PLUGIN_GOARCH PAYMENT_PLUGIN_CGO_ENABLED GOOS GOARCH
sh plugin-packages/build-packages.sh --payments-only
PAYMENT_PLUGIN_SMOKE_TEST=1 sh plugin-packages/verify-payment-packages.sh --all linux amd64

(cd backend && CGO_ENABLED=1 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags='-s -w' -o server ./cmd/server)
```

测试精确命令（仍从项目根目录）：

```sh
cd backend
CGO_ENABLED=1 go test -count=1 ./internal/payment
CGO_ENABLED=1 go test -count=1 ./internal/protocol -run '^Test(OfficialPaymentArtifactsAreCanonicalLinuxAMD64|OfficialProtocolPackagesAreSelfContainedDeclarativePlugins|PaymentRPCBackendCandidatesPreferPlatformTaggedFiles|HasAnyPaymentRPCBackendAcceptsTaggedArtifacts|ParsePluginPackage.*|InspectPluginPackageValidatesStructureWithoutContents)$'
CGO_ENABLED=1 go test -count=1 ./internal/app -run '^Test(BundledPaymentPlugins.*|SystemPaymentPluginsRegisterRPCProviders|PaymentRegistryFailsClosedWhenOfficialPackagesAreMissing|XunHuPayOfficialPackageIsPaymentPlugin|ZhiFuFMOfficialPackageIsPaymentPlugin|EpayOfficialPackageIsPaymentPlugin|PaymentRuntime.*|BuiltInPaymentPackageUpgradeSelectsNewRuntimeDigest)$'
```

这组命令只重建/验证后端及支付资源，不安装前端或 Agent 的 Node 依赖，不启动服务；完整开发启动按项目现有说明执行。

## Windows 与其他 CPU 的区别

- Windows 用户可在 **WSL2 x86-64 Linux** 中运行上面的完整验证流程；得到的是 Linux 主服务，同时支付包包含 Windows amd64/arm64 PE 载荷。这里不是 Windows 原生运行验收。
- 默认构建已经交叉编译了全部 Windows 支付载荷，并验证 Go 构建信息中的 GOOS/GOARCH/CGO 设置；**未在 Windows/macOS/arm64 主机实际运行**这些程序。
- 若只需 Windows 支付包，可在另一个副本中用 POSIX shell 执行下面的目标构建。它会清理其余平台载荷，canonical `provider` 也会变成 Windows PE；不要随后使用 `--all linux amd64` 或 Linux canonical 专项测试，也不要在 Linux 下把 Windows PE 烟测当作已通过。

```sh
PAYMENT_PLUGIN_GOOS=windows PAYMENT_PLUGIN_GOARCH=amd64 PAYMENT_PLUGIN_CGO_ENABLED=0 \
  sh plugin-packages/build-packages.sh --payments-only
sh plugin-packages/verify-payment-packages.sh windows amd64
```

- 以上 `.sh` 不是原生 PowerShell 命令。Windows 主服务的原生构建/运行未验收；默认 SQLite 驱动需要 CGO。`CGO_ENABLED=0 GOOS=windows` 即使编译成功也会得到不可用的 SQLite stub，不能当作可运行发布包。原生 Windows/交叉编译需要匹配的 C 工具链与单独运行验证。
- `--all` 当前要求 canonical `linux/amd64`。Linux arm64 上不要执行上面的 canonical 烟测命令；应使用本机 tagged 载荷验证，或另建单平台包。六平台静态校验不能替代各平台原生运行验收。

## 证据范围

`source-only-rebuild.json` 包含精确排除清单、工具链信息、最终生成物大小/哈希、测试结果和证据日志哈希。主仓库已有的全量产品测试、前端、真实模型、ASR、浏览器及正式发布门禁不在本次重新验收范围内；本次通过不改变原正式发布结论。
