# 依赖来源、许可证据与源码交付边界

## 结论与范围

本项完成的是 **FND004 的可追溯依赖/源码清单**，不是“全部依赖已完成许可证审计”、法律意见、商业兼容性承诺或生产镜像验收。根 `LICENSE` 的 MIT **不能**代替第三方组件各自的许可。

机器可读证据：[dependency-inventory.json](evidence/dependency-inventory.json)。它记录源清单/锁文件 SHA-256、每个已观察依赖的版本/来源、安装元数据及许可证文件哈希、模型/轮子复核、Docker 声明和 Git 基线源码树。未知项保留为 `null` 或显式状态，不补猜许可证。

基线为宿主提交 `514c70f666cb04e3e72cbfb967fac74d9f350747`。采集器先验证这个固定 commit 对象存在，再从该对象读取源码树，**不使用可变 `HEAD`**；本地实施提交不会将清单本身混入基线。清单中的 `source_release.tracked_files` 是该提交的 **5,533 个跟踪文件、502,890,681 字节**，含 Git blob ID；它不是包含本次全部未提交修改的最终交付清单。构建产物/通知文件的 SHA-256 则明确标注为这些基线路径上的当前工作区字节。最终打包者仍须对选入文件生成独立 SHA-256 manifest。

采集器仅使用 Python 标准库读取已有文件/缓存，不执行依赖代码，不安装、解析远程依赖或访问网络，不读取 `.env`、凭据或令牌文件内容。源码树清单读取的是 Git 元数据；只有明确列出的构建产物、依赖清单和许可文件读取字节计算 SHA-256。官方 npm 完整性补证若执行，单列在证据中，不改变离线采集器的边界。

## 1. 清单、锁与本地环境不是同一层证据

| 范围 | 已有版本来源 | 观察结果 | 不能据此声称 |
| --- | --- | --- | --- |
| 宿主 Go | `backend/go.mod` + `go.sum` | 19 个 direct、59 个 indirect 声明；78 条均有本地许可文本证据 | 已执行完整模块图、所有缓存字节已验签、已重建生产二进制 |
| Go 本地替换 | `backend/third_party/go-sms-sender/go.mod` | 9 direct + 15 indirect；无自己的 `go.sum`；替换目录 22 个 `.go`/`go.mod` 文件另有 SHA-256 | 名义 `v0.25.0` 就等于下载的上游包；嵌套声明版本等于宿主 MVS 最终选择 |
| Agent worker Go | `services/loom-engine/workers/agent/go.mod` + `go.sum` | 4 direct + 34 indirect；只有 6 条有本地许可文本，32 条未知 | 该 worker 所有依赖已在本环境下载/构建/审查 |
| Pi npm | `backend/agent-runtime/pi/package-lock.json` v3 | 4 个直接请求，230 个锁记录；五条补证后 230 条均有 integrity，锁定安装 230 个包通过 | 安装成功就等于完整应用测试/镜像验收，或全目录内容已独立重算 |
| Loom npm | `services/loom-engine/package-lock.json` v3 | 52 个运行时 + 19 个开发请求，482 个锁记录；本地 433 个包元数据 | 未观察的跨平台 optional 包都已安装 |
| Web Bun | `web/bun.lock` v1 | 63 个运行时 + 14 个开发请求，1,970 个锁记录；本地 1,908 个包元数据 | 根 MIT 覆盖 Web 全部包；缺少具体 URL 时已确定远程下载源 |
| Python requirements | 6 个文件，37 条固定版本声明 | 见下表；不是统一跨平台、全传递依赖的哈希锁 | `==` 已使 wheel/系统库/镜像完全可复现 |
| ASR fixture | 已有 `local-model-dependencies.json` + `local-model-smoke.json` | 25 个记录中的 wheel 哈希全部与本地字节一致；26 个 dist-info 元数据记录 | 这是干净虚拟环境、完整容器安装或真实平台/行业验收 |

Go 三个 manifest 共 **140 条声明记录**，不是 140 个去重后的最终模块；其中 37 条没有本地许可文本。Go 中的 `license_text_family_hints` 只识别文本家族，不能替代条款、版本和覆盖范围审查。`go.sum` 的 `h1` 校验记录不是已安装目录的重新验签结果。

全部 **2,571 个本地 JavaScript 包记录**的 name/version 均能在对应锁中找到；这只是版本对照，不是全目录字节校验。`installed_packages` 保存 package.json 哈希、声明的许可、包自带 LICENSE/NOTICE 的哈希；`locked_packages` 保留逐项来源 URL / integrity / direct-versus-transitive 分类。

工具链区分安装与执行：`web/package.json` 声明 `bun@1.3.9`，已有锁定依赖安装由 Bun **1.4.4** 完成。父任务随后从官方 npm 获取声明版本 **1.3.9**，tarball SHA-512 与 npm integrity 一致，实际 `--version` 为 1.3.9。本采集任务另行复核 archive 哈希、解包后二进制与 archive 成员的 SHA-256 一致，并检查执行日志。**Bun 1.3.9 和 1.4.4 都已通过完整前端测试与生产构建**，不再是“声明运行时未测试”；但是没有使用 1.3.9 重新安装依赖。详见 [声明版 Bun 验证](evidence/bun-declared-validation.json)：

| 执行 runtime | 完整测试 | 生产构建 | 安装边界 |
| --- | --- | --- | --- |
| Bun 1.3.9 | 2,530 pass、0 fail；333 files、19,439 assertions；20.46s | `tsc --noEmit && vite build` 通过，6.30s | 复用已有 lock-matched 依赖树，未做 fresh install |
| Bun 1.4.4 | 2,530 pass、0 fail；333 files、19,439 assertions；19.89s | 同命令通过，7.04s | 既有锁定安装 runtime |

1.3.9 tarball SHA-256 为 `13d7d1a65a92e221912821f0342acc2c6077909a84fcb262cf9262dc9ac7b7b9`；两个 build 的大 chunk 警告仍保留，不伪装成零警告。缓存 Go VERSION 为 **go1.25.14**，采集器 Python 为 **3.12.14**。`toolchains` 保留两套 Bun 记录、版本/字节哈希及父任务运行回执；采集器自身不执行下载的 runtime，不把 hash matching 说成发行签名验证、许可证清算、Docker 构建或生产验收。

### npm/Bun 来源与完整性细节

- Pi 的 230 条 `resolved` 均指向 `registry.npmjs.org`；五条嵌套 `@earendil-works/{chord,pi-agent-core,pi-ai,pi-telemetry,pi-tui}@0.87.1` 原锁没有 `integrity`，也未标记 `inBundle`。已对五个精确版本执行官方 registry 只读查询，下载 tarball **只计算哈希、未解包/安装/执行**，5/5 SHA-512 和 registry SHA-1 匹配；见 [补证、RFC6902 提案和应用回执](evidence/pi-lock-integrity-verification.json)。随后父任务应用仅补五个 integrity 字段的补丁，并通过 `npm ci --ignore-scripts --cache <existing-workspace-runtime>/npm-cache`（230 个包，10 秒）。本采集任务独立对照基线确认只有上述五字段变化，版本、resolved 和包集合不变。新锁 SHA-256 为 `c401f46ddc69ffe1a0efcefde4cce5e12c4a710aa1aa00da4f71fb67f2dc62cb`。该具体缺口已修复；签名/attestation 仍未验签，不扩大成供应链/许可证全面通过。
- Loom 有 476 条官方 registry URL；另外 6 条为 `@tailwindcss/oxide-wasm32-wasi` 的 optional、`inBundle: true` 子项，无独立 URL/integrity。不能将其误称为六次未知远程下载；父包及其打包内容仍须在最终构建验证。
- Bun 有 1,825 条显式 `registry.npmmirror.com` URL、145 条空来源字段；1,970 条均有 integrity。空字段保持未知/隐式，不擅自改写成官方 registry。除上述 Pi integrity-only 修复外，本项没有修改其他锁文件。
- npm 包里的 repository 字段只是发布者声明；没有因此证明 tarball 与某个 Git 提交逐字一致。

### Python 声明层

| 文件（相对 `services/`） | 条目 | 固定版本内容/范围 |
| --- | ---: | --- |
| `loom-engine/workers/ocr/requirements.txt` | 1 | `minio==7.2.20` |
| `loom-engine/workers/telethon/requirements.txt` | 22 | 文件声明为测试环境依赖闭包；包含 `Telethon==1.45.0`、`aiohttp==3.14.3`、`minio==7.2.20`；没有 wheel 哈希 |
| `loom-engine/workers/subtitle/requirements.txt` | 2 | `yt-dlp==2026.08.19`、`yt-dlp-ejs==0.8.0` |
| `loom-engine/workers/asr/requirements.txt` | 1 | `minio==7.2.15` |
| `loom-engine/workers/asr/requirements-model.txt` | 9 | faster-whisper 1.1.1、ctranslate2 4.8.4、huggingface-hub 0.28.1、tokenizers 0.21.0、onnxruntime 1.20.1、av 14.1.0、numpy 2.2.2、tqdm 4.67.1、PyYAML 6.0.2 |
| `video-knowledge/requirements.txt` | 2 | `minio==7.2.15`、`Pillow==12.3.0` |

这六个文件中除 Telethon 的已声明环境闭包外，其余属于精选/直接 requirements，不是完整传递闭包；全部没有 `--hash`。记录的 25 个 ASR wheel 字节可追溯，但它们不是所有 worker 的锁，也没有改写安装命令为 `pip --require-hashes`。

本地 ASR 目录同时残留 ctranslate2 **4.5.0 和 4.8.4** 的 dist-info。已有 smoke 记录说明 4.5.0 因 executable-stack 策略被拒绝，实际执行的是 4.8.4，不能把两个元数据记录解释成两个版本均通过执行验收。采集器不导入两者。

另外读取的宿主 Python 元数据显示 Pillow 12.3.0 / `MIT-CMU`、aiohttp 3.14.4 / `Apache-2.0 AND MIT`；后者不等于 Telethon requirements 的 3.14.3。本次隔离采集 Python 未观察到 minio、Telethon、yt-dlp、yt-dlp-ejs。这些是**采集器宿主环境信息**，不能当成 worker 容器的安装失败或部署状态。

## 2. 必须保留的许可边界与未知项

以下为本地文件中的声明/文本证据，不是许可适用性意见：

| 组件/材料 | 观察到的证据 | 剩余门槛 |
| --- | --- | --- |
| `@ffmpeg/core` 0.12.10 | package.json 明确 `GPL-2.0-or-later` | 单独核对实际分发 WASM/FFmpeg 构建、对应源码/通知及适用义务；不能标 MIT |
| `tldraw`、`@tldraw/editor` 5.2.5 | `SEE LICENSE IN LICENSE.md`；两个本地 LICENSE 只链接上游条款 | 取得与实际版本/用途对应的完整条款证据。不得因 intelligence 不调用某功能就假定整个交付不含该组件 |
| 其他 tldraw 家族包 | driver 没有本地许可证文件；utils/validate 有各自文件 | 逐包保留证据；不能把一个包的条款推广到全家族 |
| Live2D Cubism Core | `web/public/live2d/NOTICE.txt` 明确不受项目 MIT 覆盖，指向 Live2D 专有协议 | 核对运行库、SDK 和模型素材各自授权；不要把 `pixi-live2d-display` 的 MIT 套给 Cubism Core |
| Inter、JetBrains Mono variable font 包 | 两个 `@fontsource-variable/*` 5.3.0 声明 `OFL-1.1` | 保留字体许可/归属；图标、品牌、模型素材另行核对 |
| `@giscus/react` 3.1.0、`@splinetool/runtime` 1.12.98 | 本地 package.json 无 license，且无本地根 LICENSE/NOTICE | **未知**；补版本对应官方证据，不猜 MIT |
| `khroma` 2.1.0、`webgl-constants` 1.1.1 | package.json 无 license，但存在 MIT-style 本地许可文本，已哈希 | 记录文本证据与元数据缺失；不是完全未知，也不冒充发布者 SPDX 声明 |
| Python wheel 内代码 | certifi 声明 MPL-2.0，tqdm 声明 MPL-2.0 AND MIT；numpy 有长许可文本及自带库材料 | 不只看顶层 metadata；numpy 长文本保留文件/字段哈希，未压缩成单一“BSD 全覆盖”结论 |
| tokenizers 0.21.0 | 无 License/License-Expression 字段；Classifier 声明 Apache Software License | 保留 classifier-only 状态，未猜定完整表达式/捆绑 Rust 依赖范围 |

基线内另外有 **18 个许可证/NOTICE 类文件**，逐文件哈希见 `source_release.tracked_license_notice_files`。这不表示已经逐字审核内嵌知识卡片、图片/音视频、品牌图标、字体、第三方 WASM、预编译付款插件的完整分发权利。保留原有 LICENSE/NOTICE/THIRD-PARTY-LICENSES，不用本报告替换它们。

## 3. 上游、模型与镜像

- 宿主合并来源：`third_party/upstreams.lock.json` 记录 Canvas `e70fe1b9c93d6af3b807a87ed15bb621af78095c`、Loom `cdcb787f925e584da0302f7968431335b8f8122e`；此处保留其 MIT 声明，不扩大至依赖。
- BiliNote：`90940fde4d224d0f69ad99674f4af0a1ea52d3c4`；DTK：`3d540dbf3783449e638403b65d81c882c4a99575`。详见 [upstream-media-lock.json](upstream-media-lock.json)。它们是参考/协议来源，`vendored: false`；DTK 是可选独立服务，本项目未重分发该服务，也没有已验证 DTK 镜像 digest/真实平台账号验收。
- DTK `credential_ref` → operator 配置实例/API-key 文件的映射支持已经有源码/fixture 证据；这不是已配置凭据、可用 provider 或用户平台身份池的证据。本次没有读任何实际密钥文件。
- 模型 `Systran/faster-whisper-tiny` 固定 revision `d90ca5fe260221311c53c58e660288d3deb8d356`；5 个文件（含 model.bin）本地 SHA-256 全匹配。model.bin 为 `dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1`。固定 model card 声明 `license: mit`，不是对训练数据、使用权或行业效果的独立审计。
- processor 的 Python 基础镜像已有 registry 验证 digest 证据，**built_image_digest 仍为空、未构建**；不要把基础镜像 digest 当作最终服务镜像。
- `deploy/flow/backup/Dockerfile.video` 强制运营者提供 `NODE_IMAGE`、`POSTGRES_IMAGE`、`MC_IMAGE` 三个验证过的 digest，默认未填写。`video-build-manifest.json` 当前明确 `resolved_image_digests: null`、没有 Docker build/生产部署。
- 其他 Dockerfile/Compose 的镜像声明和文件哈希见 `containers.files`。本次不拉镜像、不构建、不审计其 OS 软件包。即使基础镜像有 digest，后续 `apt-get` / `apk` 包仓库内容、native 库、安装脚本和完整构建闭包也不能自动视为可复现；应在授权构建后记录最终 image digest 与 OS/应用 SBOM。

## 4. 源码 ZIP：只提议，不删除、不自动排除

基线没有跟踪的 `node_modules`、`dist`、`__pycache__`、`.cache`、`.pyc` 或 `.tsbuildinfo` 路径。当前工作区的 node_modules、`web/dist`、`.local` 和仓库外 runtime/cache/model/wheel 是本地生成/验证材料，不应因递归打包而进入源码交付。没有删除这些目录。

42 个已识别生成产物共 369,898,935 字节，逐个 SHA-256、大小、magic bytes 和构建依据见 `source_release.generated_artifact_candidates`：

| 精确范围 | 数量/字节 | 提议与运行时风险 |
| --- | --- | --- |
| `backend/server` | 1 / 65,718,338 | ELF 构建产物，SHA-256 `1d4246ef8a1068eb2c60aa12f2a6b8dd75e58a731968034667445a7bcbcf9184`。**明确标注的 source-only 包**可排除；`backend/Dockerfile` 有源码构建入口。完整宿主交付默认保留，不声称本次已重建 |
| `plugin-packages/official-payment-*.yingce-plugin`（具体五个路径列于 JSON） | 5 / 88,697,625 | 约 84.59 MiB，是运行时插件包而非无用缓存；完整交付保留 |
| 同五个付款插件的 `backend/provider*` | 35 / 212,279,106 | 多 OS/架构可执行 payload；`build-packages.sh` 可重建，Dockerfile 复制、重建并校验。只有建立明确的 source-only 重建/验收合同后才考虑不带；不得 blanket 删除 `plugin-packages` |
| `services/loom-engine/public/zhishi-loom-source.zip` | 1 / 3,203,866 | `scripts/pack-source.mjs` 明确生成并供页面下载。source-only 包可考虑去重，但会影响该下载链接，应说明/重建；默认不改 |

第三方 WASM、Live2D runtime、字体、图片、品牌图标不是仅凭扩展名就能证明可删除的缓存。**本清单未应用任何排除规则，采集器不修改生产源码、锁或工作流；父任务仅实施上述经过核验的 Pi 锁补丁。** 发布源码 ZIP 时，保留全部相应源码、构建脚本和许可证通知；记录最终文件清单、排除表、压缩包 SHA-256，并区分“源码审阅包”与“开箱运行发行物”。

## 5. 复核方式与剩余门槛

在同一 checkout、已有授权本地 runtime/cache 的前提下，从仓库根执行（不安装依赖）：

```bash
python -I scripts/test_video_dependency_inventory.py
python -I scripts/video-dependency-inventory.py --runtime ../runtime
python -I scripts/video-dependency-inventory.py --runtime ../runtime --check
```

`--check` 不写文件；比较当前输入是否与证据完全相同。外部缓存缺失、锁/evidence/所采集工作区文件改变时，应重采而不是伪造旧环境；本地 `HEAD` 推进不改变固定的上游源码树。验证范围：9 个采集器单元测试、JSON 生成、同输入重复采集一致、25/25 wheel 字节哈希、5/5 model 文件哈希、42 个构建产物 SHA-256。测试覆盖固定基线而非 HEAD、拒绝意外 commit 对象、JSONC 字符串/注释安全解析、拒绝执行式输入、URL 凭据/查询去除、许可文件筛选、排除同名 UI/screenshot 误识别、嵌套多版本包保留；这些不是产品端到端测试。

除父任务的 Pi `npm ci --ignore-scripts` 已通过外，本依赖采集项未执行 Go build、pip install、Docker build、平台账号请求、软件供应链签名验证或生产部署。Pi 首次使用默认 cache 的尝试遇到 ENOENT，切换已有工作区 cache 后通过；这不是隐藏的首次通过。最终公开/商业分发前的门槛：

1. 对特殊/未知许可与静态/预编译材料补齐版本对应许可、必要通知与源码分发审查；不要声称“100% license-audited”。
2. 保持已修复 Pi 锁的完整性，依赖变动后重新验证；对所有最终运行时/平台补充应用与 OS 的可追溯构建清单。
3. 确定三个 backup 基础镜像 digest、执行授权 Docker 构建，采集最终 image digest、系统包版本和离线恢复验收；未执行就是未执行。
4. 在最终 QA 冻结后的真实选入文件集合上生成 ZIP manifest；本页的基线 Git 树不能替代最终修改集合。

## 附：关键锁文件 SHA-256

完整清单连同所有 requirements、package.json、Dockerfile 和上游/模型 evidence 的哈希在 JSON 内；下表便于人工对照：

| 文件 | SHA-256 |
| --- | --- |
| `backend/go.mod` | `89a2af0a6112d65c4a8f5d68ddc68a89b65e67b552f5095a57a07ddcd10a8f47` |
| `backend/go.sum` | `ba33d8b510137683085181643571fd2814980ce2feddde5b284c03381cfe7dd4` |
| `backend/third_party/go-sms-sender/go.mod` | `bfb76e4d3b04d239a752eefb3bf305b92da484ccafaef146efb5712bcef8eddc` |
| `services/loom-engine/workers/agent/go.mod` | `a620f9c977e365dceaedc491cd04e45a33f785ebe4f8c07162dda29fe9b692c5` |
| `services/loom-engine/workers/agent/go.sum` | `f00c261f4f4d4c3c2ecfa52c7b856bb27b6ee4a33f9c23456ffb29fc55d48e1b` |
| `backend/agent-runtime/pi/package-lock.json`（补丁前） | `976cc4b3c4edde2eafd3f67d3d6efe7a667a31f103da8f313edded1d4917703b` |
| `backend/agent-runtime/pi/package-lock.json`（补丁后，当前） | `c401f46ddc69ffe1a0efcefde4cce5e12c4a710aa1aa00da4f71fb67f2dc62cb` |
| `services/loom-engine/package-lock.json` | `05b31509cccb7ecb7993ba750d495c84e7c2c95846de36a95de810f9e050ad4c` |
| `web/bun.lock` | `7c4ad853b968ab5321ab2b9e9b00b441f169bfcf3290443c9181431c678272c7` |
| `services/loom-engine/workers/asr/requirements-model.txt` | `f9069ce0b660ce7d59688019c9bb9102bb394d75be022d7efc8aa20ab3ef3433` |
| `services/loom-engine/workers/asr/model-lock.tiny.json` | `aca7e5360cc68c5460bb9a452c9a2cbf9656b75ece9abb11a78643a44c28b5d4` |
