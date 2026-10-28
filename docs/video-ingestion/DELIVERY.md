# WeaveSense-KnowHow-Collector 开发版交付说明

## 当前接手入口：V1 工程闭环

请使用 [feat/knowhow-fullstack-acceptance 分支](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/tree/feat/knowhow-fullstack-acceptance)。已验证的应用源码为 [`ff03a18f34d80b1b894b3d89a58df06b594346df`](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/commit/ff03a18f34d80b1b894b3d89a58df06b594346df)，其四项 CI、13 个 job 全部成功：

- [真实整栈 TEST](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40714774787)：实际登录、Go/Loom/Python、PostgreSQL/MinIO、原生 Agent/Canvas、候选评测、长 Unicode 原文、服务重启、撤回和权限失效。60 个评测任务与宿主网关及持久记录逐一绑定，重启无重放；恶意模型夹具返回两次工具调用，外联接收器计数为零。
- [组件集成](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40714775082)：Loom 281/281、零跳过；Go 1,965 个顶层测试通过、5 个明确条件跳过、零失败；必选视频门禁均实际执行。真实双编译 Skill 生命周期专项包含 120 个宿主 ModelTasks、安装/升级/回滚及历史 pin。
- [容器构建及来源核验](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40714774831) 与 [质量检查](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40714774947) 均成功。实际普通话离线 ASR 的独立、非默认 CI 证据见 [AC08-ASR.md](AC08-ASR.md)。

**工程实现、范围化执行证据与业务正式签收分别记录。** 原 29 条 V1 用例中，23 条客观技术验收已在各自明示边界内通过；AC01/02/03/14/27/29 的真实平台、所选模型语义质量或约定试点条件仍待补。原 100 项任务、29 条用例的逐项现状及证据见 [V1-CLOSURE.md](V1-CLOSURE.md) 与 [机器可读矩阵](evidence/v1-closure-matrix.json)。

`PROGRESS.json`、生成视图和执行工作簿已同步当前事实：FND-004 改为待验收，K-020 的授权正负样本阈值校准明确为阻塞。按原依赖图与整项签收规则，任务总数仍是“2 已完成 / 88 待验收 / 10 阻塞”，**这不是代码完成比例**；原依赖未签收不表示相关功能未实现。外部平台及多数模型使用受控夹具；真实行业质量、授权平台样本、独立金标和约定试点尚不能由这些测试代签。没有合并 main、创建新 PR 或执行生产部署。

以下章节保留首次交付及第二轮收尾的历史事实；其中旧分支、待验证工程项与计数只适用于对应历史快照。当前接手分支和工程证据以上述入口及闭环矩阵为准，不再按旧工程清单判断当前实现状态。

## 结论

已在独立工作目录实现宿主扩展、补齐逐条审计发现的应用代码缺口，并完成本轮冻结源码的本地回归。**这是可继续本地测试和二次开发的源码开发版，不是完整 V1 已验收、开箱安装包或生产上线证明。**

完整源码已发布到目标仓库的 [feat/video-knowledge-v1 分支](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/tree/feat/video-knowledge-v1)，首个完整发布提交为 [cf2aad9c5926500bfaae7bb39e48316ccd192269](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/commit/cf2aad9c5926500bfaae7bb39e48316ccd192269)。代码基于固定宿主 `514c70f666cb04e3e72cbfb967fac74d9f350747`；原宿主未被推送修改，目标 `main` 仍保留初始化提交，未合并开发分支。

第二轮工程收尾发布在 [feat/knowhow-release-hardening](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/tree/feat/knowhow-release-hardening) 与 [Draft PR #1](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/pull/1)。应用候选 `5ac12630` 的三项 CI 工作流、12 个 job 全部成功，含真实 Chromium、必选 Redis/PG 和两个容器的隔离构建；后续文档及测试隔离修正的状态以 PR 当前 head Checks 为准，应用源码不变。接手本轮工程成果应使用此工程分支，逐项结果及明确跳过见 [ROUND2.md](ROUND2.md)。这不改变业务台账，也不是生产上线授权。

发布核验覆盖 5,738 个文件的路径、权限模式和 Git blob 哈希；其中 5,697 个源码文件另经归档 SHA-256 核验，41 个保留生成物经逐项 SHA-256 核验。[导入校验运行](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40468402790)成功，一次性工作流已在 [e387b717](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/commit/e387b717c29c934248bfe619c1e85af61589d18d) 移除。**源码同步完成不等于应用 CI 或完整 V1 验收通过。** 后续工程收尾的当前状态及证据入口见 [ROUND2.md](ROUND2.md)。

## 本轮实现

1. 复用现有 Go 身份、工作区、权限、模型任务和账本；Loom 主 Flow Engine 为唯一业务权威，未复制独立 IKC 的登录/计费/数据库。
2. 视频来源/profile 版本、增量发现与历史复查、持久分页、阶段租约/fence、幂等提交、丢响应对账、预算/资源限额和未知结果保留。
3. 双阶段输入/处理 manifest、合法原件/字幕输入 API、长转写完整分片、时序证据、OCR/视觉观察分类、固定 revision、受控媒体 Range 读取与显式缺失对象修复。
4. 机器提炼候选、版本/hash 绑定人工审核、已发布知识检索、近似来源候选与人工归并/独立判定；不自动把转载当作独立证据。
5. 原生 Skill 候选、三基线评估、源码导出、历史版本内嵌编译、真实运行宿主 attestation、CAS 安装/回滚和旧运行 pin；导出包不是部署收据。
6. 分类保留期限、独立删除日志、旧数据库/对象快照恢复屏障、worker 清理回执、原生 Agent/Pi/历史/SSE/撤销快照的精确关联清理，保留用户画布和财务审计。
7. 原宿主界面中的任务、证据时轴、懒加载播放、冲突两侧、知识审核、方法版本、来源影响预览、显式确认和可见部分失败的批量操作。
8. 处理覆盖、视觉采样、成本、缓存复用、审核修订、引用关联、来源判定、失败恢复、阶段耗时/积压、429/授权问题、发现/去重/ready 延迟指标。未知数据不补成零或准确率。
9. 原始需求、单一执行台账、Excel 同步器、迁移 0023–0030、运行/恢复说明、依赖来源清单及脱敏验证证据。

具体接口、状态机和边界见 [CONTRACTS.md](CONTRACTS.md)、[ARCHITECTURE.md](ARCHITECTURE.md) 与 [GAP-CLOSURE.md](GAP-CLOSURE.md)。

## 首轮冻结源码的实际验证

下表是随首次源码发布保留的历史执行结果，不自动适用于后续改动。第二轮的实际提交、执行范围与结果单独记录在 [ROUND2.md](ROUND2.md)，不回写或覆盖历史测试证据。

| 范围 | 最终结果 | 边界 |
|---|---|---|
| Loom，真实 PostgreSQL 17 | 203 通过，0 跳过 | 含非超级用户 FORCE-RLS、并发/进程终止、required embedding、备份恢复与日志屏障 |
| Go 宿主 | 1,949 顶层测试通过，7 项明确跳过；33 包通过 | 不重复累计子测试；跳过及等价子进程执行说明在证据中 |
| Python 视频执行 | 46 通过 | 合成平台/模型夹具与实际 HTTP/SQLite/FFmpeg 边界分别标记 |
| Web | 2,530 通过；类型检查、ESLint、构建通过 | 333 文件、19,439 断言；不是浏览器点击验收 |
| 声明版 Bun 1.3.9 | 2,530 通过，构建通过 | 复用既有锁匹配依赖树，未以该版本重新安装依赖；Bun 1.4.4 同样通过 |
| 系统 Python ASR 测试 | 7 通过，1 跳过 | 该解释器无 faster-whisper；另有隔离环境实际 tiny/Tesseract 烟测，不能合并成全通过 |
| 原生宿主 API | 通过 | 实际注册/退出/登录 Cookie 会话、Vite 代理、Loom 和权限/旧快照/影响预览；无浏览器运行声明 |

最终 Go 与 Loom 分别运行，前后都保持同一个 1,868 文件源码清单，聚合 SHA-256：
`569d0fe8ebede44def1305b7cc0c9c124fdfa350cf01f0737b7395c5e20b59e1`。

之前发生源码漂移的组合运行只保留为中间证据，没有冒充最终冻结测试。完整命令、版本、清单、逐文件原始/脱敏 hash、跳过名单及日志包见 [validation-results.json](evidence/validation/validation-results.json) 和 [验证证据说明](evidence/validation/README.md)。真实本地模型烟测保留 `dog → log` 识别错误，不据此宣传行业准确率。

## 原任务状态没有被“刷完成”

完整保留 **107 个任务、196 条实施要求、335 条验收、363 条依赖**。V1 为 100 项；7 项 P2 未开始。

- 2 项基线文档任务正式闭合：COL-001、IF-001。
- 88 项待验收：已有对应实现和工程证据，但原任务的全部验收及依赖尚未闭合。
- 10 项阻塞：FND-001/003/004/005、K-027、COL-028/031、QA-001/003、IF-028。
- 7 项 P2 保留未开始。

**这不是“只写了两个功能”，也不是“90% 产品已经验收”。** 代码实现和正式验收分别记录；例如 K-001 虽有技术实现，仍依赖尚未冻结的 FND-001，因此不能越过依赖标完成。29 个正式 V1 端到端用例尚未整体签收，相关工程场景的执行记录不代替原用例全套业务前提。

Excel 已回填 2/88/10/7 状态，原六表、323 个公式、要求、验证和样式保留，678 项独立状态/计算核对通过。原件的逐字节副本也在 `spec/tasks.baseline.xlsx`，不依赖本开发目录。没有声称已用原生 Excel/LibreOffice 操作验收。

## 尚需闭合的工程与业务条件

以下清单不全部依赖业务凭据：镜像构建、CI、浏览器/Redis 验证属于工程收尾；行业、合法样本和业务签收是独立条件。第二轮若完成某项工程验证，以 [ROUND2.md](ROUND2.md) 中绑定实际提交的结果为准，不推导其他条款自动通过。

- 首发行业、5–10 个真实业务问题、行业术语、复核人和发布负责人；不能以仓库名推断。
- 合法 B站/抖音来源、使用范围/期限、独立人工金标和真实双平台采集结果。
- 实际模型配置、费用授权、硬件和质量校准；当前不填写虚构准确率。
- 首轮浏览器环境拒绝启动及原生 Redis Unix IPC 拒绝的历史记录保留；第二轮 CI 的逐项状态见 [ROUND2.md](ROUND2.md)，未将其他 Chrome 检查冒充视频业务闭环。付费 DDCat 等原宿主可选测试也未擅自调用。
- 两个 Linux amd64 backup/worker 镜像已在 `5ac12630` 实际构建并通过无网络 smoke，三个备份基础镜像 pin 已提供；但整栈部署、完整 OS/应用构建闭包、漏洞/许可审查和持续试点仍未完成。当前包级 SPDX 为部分清单，不能冒充完整 SBOM，详见 [ROUND2.md](ROUND2.md)。
- 供应商外部存储物理擦除回执：所选 DTK 的 cancel API 不证明文件/备份删除，未知外部写入/执行仍保留 pending，不能称全部擦除。
- 第三方许可边界：根 MIT 不覆盖所有 Web/WASM/字体/Live2D/预编译组件；逐项已知和未知证据见 [DEPENDENCIES.md](DEPENDENCIES.md)，未作商业许可清算承诺。

## 本地接手

1. 从 [feat/knowhow-release-hardening 工程分支](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/tree/feat/knowhow-release-hardening) 克隆，或在该分支页面选择 `Code → Download ZIP`；不要从仍只有初始化说明的 `main` 下载。先读根 `README.md`、本页和 [RUNBOOK.md](RUNBOOK.md)。先前单独交付的源码包含 `SOURCE-MANIFEST.json`，给出逐文件 SHA-256、基线和排除说明；GitHub 自动生成的 ZIP 不保证含这一归档专用文件。若使用文件名含 `Source-Only` 的精简包，必须先按 [SOURCE_ONLY.md](SOURCE_ONLY.md) 重建省略的付款插件和主程序，再继续启动步骤。
2. 安装文档指定的开发依赖，使用 `.env.flow.example` 与 `deploy/flow/video.env.example` 配置本地环境。按 [LOCAL_QUICKSTART.md](LOCAL_QUICKSTART.md) 运行只读配置预检；视频默认关闭，试点必须显式设置工作区白名单。模型、对象存储、DTK 和授权来源必须由您配置，密钥不要放入聊天或 Git。
3. 先执行本地测试/合成夹具闭环，再接授权的小样本；不要直接对公网开放或把样例当成正式行业 profile。
4. 原生方法采用“审核→源码导出→构建→运行宿主确认→工作区 CAS 安装”；源码变更后重跑适用检查。
5. 改动任务状态只改 `PROGRESS.json`，运行台账导出和 Excel 同步。完整发布门槛仍应阻断，直到原任务和业务验收真正满足。

源码包不是安装程序，不含 `.env`、账号 Cookie、真实密钥、数据库、node_modules、开发缓存或模型权重。首次启动需安装依赖和构建，Windows 建议按 RUNBOOK 使用 WSL2/Linux 流程。

因聊天附件大小限制，分发有两个明确版本：

- **完整源码与宿主资源包**：约 259 MiB，已保存，但聊天拒收该大小。只省略旧的 `backend/server`，全部付款插件二进制保留。
- **Source-Only 轻量源码版**：相同应用源码和静态资源，另省略 5 个付款插件预编译包与 35 个可执行载荷；不省略其源码、manifest、许可证或构建脚本。已在独立副本中从源码恢复全部默认六平台载荷/插件包、编译完整 Linux 主程序，31 项专项测试通过、1 项明确跳过，原 5,695 个保留文件字节不变。必须执行 `SOURCE_ONLY.md` 中的重建步骤；这不是无需付款资源即可直接运行的变体。

归档没有 Git 元数据，重建命令显式使用 `GOFLAGS=-buildvcs=false`。正常模块完整性校验保留；不建议关闭 checksum 验证。源码精简分发的验证只补充分发可重建性，不替代前述真实平台/行业/部署验收。

完整 GitHub 同步已经获得授权并完成。生产部署、合并 `main` 和发布镜像均不属于已完成的源码导入；本轮工程验证不代表获准执行这些操作。
