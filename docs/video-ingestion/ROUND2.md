# 第二轮工程收尾与发布证据索引

## 范围与判定规则

本轮仅闭合不依赖真实行业数据的工程事项：交付文档、固定提交 CI、浏览器/Redis 验证、干净构建和配置预检。工作在独立工程分支进行；不合并 `main`、不部署生产、不调用付费模型、不扩展 P2。

**配置存在、测试已提交、工作流已触发、工作流成功、业务验收完成是五种不同状态。** 执行结果必须绑定实际提交和完整命令/运行记录；未执行或受阻不得标通过。构建镜像不代表已经部署，也不代表全部第三方授权已审查。

## 已完成的源码发布事实

| 证据 | 已核验值 / 边界 |
| --- | --- |
| 首次完整源码提交 | [`cf2aad9c5926500bfaae7bb39e48316ccd192269`](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/commit/cf2aad9c5926500bfaae7bb39e48316ccd192269) |
| 分支 | [`feat/video-knowledge-v1`](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/tree/feat/video-knowledge-v1) |
| Git tree | `22ee4bc77520e36832028d6c2ca51b7d92ab3df8` |
| 文件一致性 | 5,738 个文件的路径、权限模式、Git blob 哈希匹配；5,697 个归档源码文件和 41 个保留生成物另经 SHA-256 核验 |
| 导入校验 | [运行 40468402790](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40468402790)成功；只证明导入/产物一致性，不是应用 CI |
| 临时工作流清理 | [提交 e387b717](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/commit/e387b717c29c934248bfe619c1e85af61589d18d)已移除一次性工作流；保留历史记录 |
| `main` | 导入完成时仍是初始化提交 `c4bd9672f7dba23e3e596b3203d977e9d2037e6b`，未合并源码分支 |

先前源代码精简包的重建边界见 [SOURCE_ONLY.md](SOURCE_ONLY.md) 和 [source-only-rebuild.json](source-only-rebuild.json)。它们与上述远端文件一致性一起补充源码交付证据，不替代镜像、运行环境和业务验收。

## 本轮执行记录：已验证工程候选

**[应用候选提交 5ac12630778d054b90742a5fed3fc9163c400a57](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/commit/5ac12630778d054b90742a5fed3fc9163c400a57) 的三项工作流、12 个 job 全部成功。** 本页及机器可读 [round2-ci.json](evidence/round2-ci.json) 是其仅文档后续提交：记录绑定已执行的应用提交，不把后续提交的 SHA 冒充该次运行源码。交付时另检查 [Draft PR #1 的当前 head / Checks](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/pull/1/checks)，不递归创建只为写入自身 SHA 的提交。

| 工作流 | 实际结果 | 运行 |
| --- | --- | --- |
| Quality checks | backend、Loom、Web、对象恢复、付款插件共 5 job 成功 | [40526996302](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40526996302) |
| Video knowledge integration | ledger、flow、host、media、web、browser 共 6 job 成功 | [40526996341](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40526996341) |
| Video container validation | build-and-inspect 成功，不发布镜像 | [40526996199](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40526996199) |

| 检查 | 实际结果 | 边界 |
| --- | --- | --- |
| Flow + 真实 PostgreSQL | **203 通过、0 失败、0 跳过**；TAP 门禁再次本地复核通过 | 一次性 CI 数据库、非超级用户 FORCE RLS，含并发/进程终止、required embedding、备份恢复和独立日志屏障 |
| Go 宿主全量 | **1,951 顶层通过、0 失败、5 跳过**；33 测试包通过，另 19 包无测试文件 | 不重复累计子测试；必选 PostgreSQL/Redis 8 项均实际运行并通过；跳过名单见下文 |
| Chromium 视频 UI | **5/5 通过**，33.4 秒 | 真实 Vite/React 路由与浏览器；明确合成 HTTP 边界，不是实际 Go 登录或真实平台 E2E |
| Web | 类型检查、规则检查、构建及 **2,530 测试通过、0 失败** | 333 文件；另有 Previs P0 Chrome **65/65 断言通过**，不累计成业务验收数 |
| Python 视频执行 | **46 测试通过** | 合成 provider / model 与实际 HTTP、SQLite、FFmpeg 边界分别保留 |
| 独立宿主 ASR profile | **7 通过、1 跳过** | 未安装 faster-whisper 的 image-level 模型测试跳过；本轮不声称真实 Whisper 推理通过 |
| 台账 / 配置 / 门禁 | 37 项 `test_video*.py`、6 项 Flow 门禁测试、2 项 Go 门禁测试通过；build 预检通过 | 预检不联网、不生成秘密、不初始化日志，`production_ready=false` |
| 其他既有门禁 | MinIO 备份恢复、保留期/告警检查、付款插件 amd64/arm64 smoke 通过 | 付款包构建不是付费交易；无业务账号或真实付费模型调用 |

### 如实披露的跳过

Go 顶层 5 项跳过：

- `TestDDCatLiveImageRoundTrip`：未提供明确启用付费验证的 API key；本轮不调用付费服务。
- `TestGeneratedAssetBrowserIdentity`：未配置其独立外部 Node runner；新的 5 项 Chromium 测试不冒充这个不同用例。
- `TestVideoReleaseCompiledChild`、`TestVideoQALoomReleaseCompiledChild`：只在隔离构建归档内执行。父测试 `TestVideoReleaseIsolatedBuildAndRunningRegistry` 与 `TestVideoQALoomExportBuildAndRunningRegistry` 均通过，日志明确记录两个 child 在对应子进程 `PASS`；顶层计数仍保留 skip，不重复累计。
- `TestRPCProviderRejectsIncompatibleFallbackBinary`：Linux 使用同包另一个可执行启动失败分类测试覆盖该分支，保留原条件跳过。

另有 Python `test_real_whisper_when_installed` 条件跳过，原因见上表。没有把被跳过或未运行的测试改名为通过，也没有被跳过的 CI job。

### 原始产物与哈希

以下 ZIP 均由对应工作流生成，已下载并按 Actions digest 复核；host/Flow 原始结果重新通过门禁，Chromium JSON 报告确认为 5 通过、0 跳过/失败/不稳定重试。保留期限由 GitHub artifact 策略决定。

| 产物 | Artifact ID | ZIP SHA-256 |
| --- | --- | --- |
| [Host JSONL](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40526996341/artifacts/12743669159) | `12743669159` | `62cf8e3a049ec96937dc977753cf49c28d1becd62bc0e1f54e3443a196c7848d` |
| [Flow TAP](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40526996341/artifacts/12743953864) | `12743953864` | `289d000704a17697cc359444b4afb3a481767cd9d7ac2fb67379ede926b51f21` |
| [Chromium report](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40526996341/artifacts/12745091774) | `12745091774` | `417684463d67abc39b810730e285fac880c68c010e25b5f6ab397a4c90826d4c` |
| [容器构建 / smoke / 包清单](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40526996199/artifacts/12743762711) | `12743762711` | `ab79bd2ffba167b64c2bfa899ea32d02ede2924af9569ea7412684c61f3e4a68` |

### 容器证据的精确边界

- 构建及 smoke 针对上述 `5ac12630` 的 Linux amd64，在隔离 runner 执行；smoke 使用 `--network none`，未上传镜像或部署服务。只覆盖 backup/worker，不是整栈 Compose 部署。
- backup image config ID：`sha256:ce8532f7753ed75be6eb17fb83bfa496491e9a4df2e3454dd05eb10b5df94cf1`；438 个已安装包条目。
- worker image config ID：`sha256:2c5e5c982acff37308c40b7a67027cbe32dd02116b1afed9da19339711b00771`；303 个已安装包条目。
- 上述 ID 是本地镜像配置摘要，不是已发布 registry manifest digest。部分 SPDX 清单的许可字段为 `NOASSERTION`，不是完整文件级 SBOM、漏洞扫描或许可清算。实际 mc 二进制报告 GNU AGPLv3，不能以项目 MIT 代替其授权审查。
- 固定输入见 [video-image-lock.json](../../deploy/flow/backup/video-image-lock.json) 与 [video-images.env](../../deploy/flow/backup/video-images.env)。输入 pin 不等于 apt/npm/Python 的完整可重复构建闭包。

### 已闭合的中间失败

16 个 Go 文件仅格式修正；格式门禁使用实际 checkout head 而非未取回的合成 merge SHA。浏览器 fixture 只拦截 pathname `/api/` 前缀，避免误拦截 `/src/services/api/` 模块，并显式提供存储用量 fixture；未知 API 与 pageerror 仍失败。视频 PostgreSQL/恢复 opt-in 已接入一次性 CI 数据库，没有放宽零跳过门禁。预检与 Compose 一致采用进程环境优先（包括空值），拒绝空白/带首尾空格的秘密及无效独立日志标识。旧失败运行保留，最终通过只引用上述实际候选提交。

## 供应链与许可待补证清单

本节整理 [DEPENDENCIES.md](DEPENDENCIES.md) 的已知证据，不给出法律适用性结论；不要使用根目录 MIT 推断全部分发物均为 MIT。原依赖快照保留，不改写成新的构建实测记录。

| 范围 | 已知证据 | 仍需补齐 |
| --- | --- | --- |
| `@ffmpeg/core` / FFmpeg WASM | 版本元数据声明 `GPL-2.0-or-later` | 实际分发构建、对应源码/通知与适用义务审查 |
| tldraw 家族 | 部分元数据为 `SEE LICENSE IN LICENSE.md`，条款与组件不同 | 与实际版本及使用方式对应的官方完整条款，逐包记录 |
| Live2D runtime / 模型 | 项目 NOTICE 明确不受根 MIT 覆盖 | 运行库、SDK、模型素材分别授权与通知 |
| 字体与静态资源 | 部分 Fontsource 包声明 `OFL-1.1` | 保留许可和归属；其他图标、品牌、素材单独核对 |
| 缺少许可元数据的组件 | `@giscus/react`、`@splinetool/runtime` 等仍有未知证据；部分其他包有许可文本但缺 SPDX 字段 | 取得版本对应官方证据，不猜测许可表达式 |
| Python / native 依赖 | 已有部分 wheel 哈希与声明；精选 requirements 不是所有传递依赖的完整哈希锁 | 按目标运行环境生成依赖闭包，保留捆绑库材料与未知项 |
| 服务镜像 | 基础镜像 digest 与最终服务镜像是不同对象 | 实际构建结果、最终 image 摘要、OS/应用 SBOM；不能把标签锁定当成完整可复现构建 |

已修复的 Pi lock integrity 缺项不再列为未修复问题；任何依赖更改仍须重新校验。真实 DTK 镜像、外部服务部署与账号可用性不由本项目源码发布保证。

## 不因本轮工程结果自动关闭的条件

- 正式台账仍为 **2 项完成、88 项待验收、10 项阻塞、7 项 P2 未开始**；以 [PROGRESS.json](PROGRESS.json) 为唯一任务状态来源。
- V1 的 29 个全局验收用例仍需按原始前置条件逐条闭合；测试数量不是验收百分比。
- 首发行业、5–10 个业务问题、合法样本/使用期限、人工金标、复核人与发布人，以及模型预算和真实平台条件仍需业务输入。
- DTK cancel 不证明外部存储/备份物理擦除；继续披露 `separate_retention_required`，不能宣称全链物理删除完成。
- 真实双平台闭环、行业质量、持续试点、生产上线决定与 P2 扩展保持独立，不能用模拟输入或加速测试替代。

历史工程验证入口：[QA-INDEPENDENT.md](QA-INDEPENDENT.md)、[GAP-CLOSURE.md](GAP-CLOSURE.md)、[validation-results.json](evidence/validation/validation-results.json)。
