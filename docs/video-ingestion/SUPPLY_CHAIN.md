# V1 供应链工程门禁：当前状态与证据边界

本页接续历史 [DEPENDENCIES.md](DEPENDENCIES.md) 与 G18，不改写其采集快照，也不把 FND-004 自动标为完成。三张 backup 基础镜像已在 [video-image-lock.json](../../deploy/flow/backup/video-image-lock.json) 固定 registry manifest digest；[video-build-manifest.json](../../deploy/flow/backup/video-build-manifest.json) 已指向实际 CI 构建。旧文档的“三个 digest 仍为空、尚无构建工作流”不再描述当前代码。最终镜像运行结果仍必须逐次按同一源码 commit 核对，不能继承历史成功。

## 本次补齐的实际缺口

1. **Python 传递依赖此前浮动。** `requirements.txt` 只固定 minio 与 Pillow，`pip install -r` 会重新解析其传递版本。现 [requirements.lock](../../services/video-knowledge/requirements.lock) 固定全部 10 个应用包和允许的 wheel SHA-256，Docker 使用 `--only-binary=:all: --require-hashes` 并执行 `pip check`。哈希/版本不符或没有匹配 wheel 时构建失败，不回退源码编译或关闭校验。
2. **实际镜像遗漏原有通知。** video-worker 原 Dockerfile 没有复制本仓 BiliNote/DTK `NOTICE`；backup 未复制 Loom `LICENSE`。现明确复制并由构建产物回读 SHA-256，与当前源码输入比对。该修复不把根许可证扩展到第三方依赖。
3. **原 npm 采证读取的是锁中版本，不是已安装版本。** 新观察器读取实际 `package.json`，与锁逐项比对，并保留 metadata、可用 LICENSE/NOTICE 文件的哈希和许可声明；不导入依赖代码。Python 观察器读取实际 dist-info 和通知，已安装集合必须匹配 worker 锁，仅允许基础镜像自带的 pip/setuptools/wheel 作为额外工具包。
4. **构建附件缺少绑定与闭包。** CI 现在先拒绝未提交/字节偏离的选定源码输入，保存 commit、Git tree、逐文件 SHA-256；构建镜像标记相同 commit，SPDX 生成器核对真实 `linux/amd64` 镜像 config ID、标签、已安装包记录。最后校验通知/锁字节和 SPDX 摘要后，为全部附件产生 `build-evidence-manifest.json`。缺失、损坏、来源不一致或通知遗漏不能产生成功闭包。

`requirements-lock-provenance.json` 记录官方 PyPI 对应版本元数据 URL、wheel 哈希、声明的依赖与许可。当前 Linux/amd64、CPython 3.12 的 10 个 wheel 已实际下载并重算 SHA-256；其他平台的允许 wheel 哈希来自 registry 元数据，**不代表已在那些平台运行**。这是首次固定原先未锁定的传递闭包，不是沿用不存在的旧锁。未做漏洞扫描或签名证明。

## 执行与验收

本地已执行：全新隔离 venv 从已核验 wheel 离线安装（`--no-index --require-hashes`）、`pip check`、实际 minio/Pillow 导入，以及此环境下 video-worker 全部 48 个测试，零失败/跳过。测试包含真实 FFmpeg 的分段恢复、场景/尾帧和隔离目录；仍不等于真实平台、真实模型或行业质量验收。供应链专项、现有脚本回归使用项目的 `test_video*.py` 集合。

最终容器验证由 [.github/workflows/video-container-validation.yml](../../.github/workflows/video-container-validation.yml) 执行，仍只在隔离 TEST 构建、不推镜像。需读取本次 `video-container-evidence` 原始产物：

| 产物 | 证明与限制 |
| --- | --- |
| `source-commit.txt`、`source-inputs.json` | 本次 backup/video-worker 跟踪源码输入与实际字节；不是全应用发行 ZIP manifest |
| `images.json`、`backup-runtime.txt` | 本地实际 image config ID、架构、来源标签、复制的 Node/mc 二进制及 runtime 信息；不是已发布 registry digest |
| `backup-npm.json`、`worker-pip.json`、`worker-lock.json` | 实际包版本、锁、metadata/通知哈希；包自述许可不是法律结论 |
| `*-dpkg.tsv`、`*.spdx.json` | 实际 OS/应用包清单；SPDX 许可证结论保留 `NOASSERTION`，不是完整文件级 SBOM |
| `*-notice.sha256` | 镜像中原有项目许可证/通知及 worker hash 锁与当前源码字节相同 |
| `build-evidence-manifest.json` | 上述附件的字节哈希闭包；不是签名 attestation，也不是可复现构建证明 |

新脚本/新 Dockerfile 尚未运行的候选不得写为“镜像验证通过”；以负责人核对的最终 commit CI 与产物为准。失败运行可保留部分附件用于诊断，但没有完整有效闭包。

## 仍需明确的外部决定与非声称

- 对历史未知项补做了 [五个精确 npm 版本的官方只读核验](evidence/selected-license-sources.json)：重算已发布 tarball integrity 并与宿主锁比对，保留固定 `gitHead` 的源码许可证。`@giscus/react@3.1.0` 取得对应源码 MIT 文本；tldraw/editor/driver 5.2.5 取得同一固定源码 commit 的完整 tldraw 条款，而非其指向可变 main 的短链接。`@splinetool/runtime@1.12.98` 的发布包仍无许可声明/通知，固定源码许可证请求也未取得，保持未知。publisher 的 gitHead 关联不是已证明 tarball 与源码逐字一致，更不是用途授权；剩余许可决定不能被这次补证代替。
- 特殊/未知许可、Live2D/字体/预编译插件、复制的 Node/mc 及其捆绑材料的最终商业分发范围、通知和源码义务需由发布/许可负责人确认。此处不替代法律审查，不宣称“100% license-audited”。
- DTK/BiliNote 没有作为完整服务或 UI/RAG/export 链路打入本项目；固定上游 commit、复用边界和原通知保留。要正式部署独立 DTK，需运营者选定确切发行镜像/实例和授权材料；不能为缺失的外部部署编造 digest。
- apt 仓库、基础镜像自带工具及原宿主其他组件的依赖闭包并未因此变成全字节可复现；当前证据记录实际版本/来源而不承诺重建逐字节一致。
- 本地无 Docker，本页只记录上述本地已执行项目；最终 Linux 镜像/OS 与整个宿主发行物必须由实际 CI/打包证据确认。正式 FND-004 还保留原依赖关系及许可负责人验收，不以若干脚本通过替代原条款。
