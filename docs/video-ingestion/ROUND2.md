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

## 本轮执行记录

下面只记录已经观察到的结果。提交 `7166e466` 的 CI 已完成，但 browser、Flow 严格不跳过门禁和质量工作流的 SHA 比较失败，正在修正，**本轮尚不能标记整体通过**；后续改动必须重新检查对应 head SHA，不能将首轮本地测试数量或较早提交的成功搬作最终结果。

| 检查 | 当前可作出的结论 | 完成证据要求 |
| --- | --- | --- |
| 发布文档一致性 | 已修正 GitHub 同步仍待授权的旧描述；历史报告加边界说明 | 文档差异、链接与事实核对 |
| 固定提交应用 CI | `7166e466` 的 host、media、Web 类型/规则/测试/构建及 ledger 通过；Flow 为 200 通过、3 跳过，严格门禁正确阻断 | [集成运行 40523705384](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40523705384)；补齐隔离视频 PostgreSQL/恢复 opt-in 后须重跑 |
| Chromium / Redis | `7166e466` 的必选 PostgreSQL/Redis 后端门禁通过；新增视频 Chromium 5 项因 HTTP fixture 误拦截 Vite 源码模块失败，尚未通过 | [质量运行 40523704785](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40523704785)；质量 Web 失败另因合成 merge SHA 与 head checkout 不符 |
| Linux amd64 backup / worker 构建 | 提交 `7166e466` 的容器 job 成功；两个镜像实际构建并执行无网络运行时 smoke | [运行 40523705285](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40523705285)；只覆盖两个镜像，不是整栈部署 |
| 只读配置预检 | 已加入 build/pilot 模式与拒绝测试；上述容器 job 执行构建输入预检 | [LOCAL_QUICKSTART.md](LOCAL_QUICKSTART.md)、`scripts/video-doctor.py`；静态/只读通过不证明服务可用 |
| 镜像系统/应用包清单 | 已采集 backup 438、worker 303 个包条目的部分 SPDX 清单 | 许可 `NOASSERTION`；不是完整文件级 SBOM、漏洞扫描或许可清算 |

待验证修正：浏览器只拦截 pathname 以 `/api/` 开始的 HTTP 请求；格式检查显式比较 checkout 的 head；视频 PG 测试使用一次性 CI 数据库、非超级用户 CREATEDB role 与恢复 opt-in，不放宽跳过门禁。预检与 Compose 一致采用进程环境优先（包括空值），拒绝空白/带首尾空格的秘密及无效独立日志标识。本地 37 项 `test_video*.py`、6 项 Flow 门禁测试已通过；这些结果不能替代修正提交的远端 CI。

### 容器证据的精确边界

- 源码：[7166e4665e408fd548aa75ae4e99975f8d5fbbbd](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/commit/7166e4665e408fd548aa75ae4e99975f8d5fbbbd)。镜像构建及 smoke 针对 Linux amd64，在隔离 runner 执行，smoke 使用 `--network none`，未上传镜像或部署服务。
- backup image config ID：`sha256:475d9420b7f93abb2c56a9bb7ce164eade50d69fdd4684b74954ab18489105a5`。
- worker image config ID：`sha256:1ab32d263dc58c18530469275ad52c930ca2f313a7da483d58000deae670e822`。
- 上述 ID 是实际本地镜像配置摘要，不是已发布 registry manifest digest。保留构建日志、运行时版本、包清单与 source commit 的 artifact ID 为 `12742304350`，artifact digest 为 `sha256:76396f315e2b624493b79b6961baca848680374c5ece406c772f774a92c374bd`；从对应 Actions 运行下载，其保留期限受 GitHub artifact 策略限制。
- 固定输入见 [video-image-lock.json](../../deploy/flow/backup/video-image-lock.json) 与 [video-images.env](../../deploy/flow/backup/video-images.env)。这些输入 pin 不等于 apt/npm/Python 的完整可重复构建闭包。
- 中间提交 `32447d1` 的对象恢复、付款插件双架构与 Web Previs Chrome 检查有通过记录，但质量门禁发现 16 个 Go 文件格式问题；`7166e466` 已修正格式。较早成功与修正不自动构成整个第二轮验收通过。

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
