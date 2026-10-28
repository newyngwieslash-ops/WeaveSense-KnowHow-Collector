# AC08：普通话无字幕视频实际 ASR 验证

## 结论和边界

本地独立工程验真通过：许可明确的普通话音频封装成 **10.38 秒无字幕 MP4**，经真实 Python HTTP/SQLite 执行器、FFmpeg 抽音、生产 ASR HTTP、离线 faster-whisper tiny，再由真实 Loom HTTP/PGlite 导入文档与证据。保留 **3 个原始 ASR segments**；逐段验证毫秒映射、字符范围、引用 hash 和 `documents/read` 的 `read_ref` 精确回读。

- 原音频：Google FLEURS `cmn_hans_cn/test`，`test/10026684690566417990.wav`，664,378 字节；SHA-256 `a72c0b59fdba80850552af7991de07f9f4940846d2d70f0890eeb153c40f164b`。
- 数据集固定 revision：`70bb2e84b976b7e960aa89f1c648e09c59f894dd`。归属 **Conneau et al. (2022), FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech**；[论文](https://arxiv.org/abs/2205.12446)、[固定数据卡](https://huggingface.co/datasets/google/fleurs/blob/70bb2e84b976b7e960aa89f1c648e09c59f894dd/README.md)、[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)。变更为 AAC 重编码并加入自行生成的纯色画面，未添加字幕或改写识别输出。
- 模型：`Systran/faster-whisper-tiny@d90ca5fe260221311c53c58e660288d3deb8d356`；5 个文件全部匹配仓库 `workers/asr/model-lock.tiny.json`。model card 声明 MIT；CPU/int8、`faster-whisper==1.1.1`、生产默认 `vad_filter=True`，未调整模型逻辑。
- 原文含“篇章”，实际 MP4 识别为“偏胶”。原始结果未纠字；AC08 要求原始 segments/时间/引用保存，不另设识别准确率门槛，也**不声称中文识别准确率或行业质量达标**。
- 三段原始时间为 `1.58–3.58`、`3.58–5.58`、`5.58–7.58` 秒；证据对应 `1580–3580`、`3580–5580`、`5580–7580` 毫秒。

这是**本地实际模型验真，不是默认 CI 本轮执行的模型测试**。本脚本独立放在 `validation/`，不向普通 Flow 套件添加 skip；显式执行时缺模型、音频或确认变量会失败。数据库为 PGlite、对象存储为本地文件系统，不声称真实平台采集、Go Cookie/浏览器、PostgreSQL/MinIO 或生产部署已由本例验证。原始验收账本不因此自动标记业务接受。

## 复现

仓库根目录执行；所有下载/安装只进入 `.local`，不修改生产依赖锁，不使用付费 API 或真实账号：

```bash
python3 -m venv .local/mandarin-smoke/venv
.local/mandarin-smoke/venv/bin/pip install \
  --cache-dir .local/cache/pip-mandarin \
  -r services/loom-engine/workers/asr/requirements-model.txt \
  -r services/loom-engine/workers/asr/requirements.txt
.local/mandarin-smoke/venv/bin/python scripts/prepare-mandarin-asr.py \
  --output .local/mandarin-smoke --ack LICENSED_PUBLIC_FIXTURE_ONLY

ROOT=$PWD
OUT=$(mktemp -d "$ROOT/.local/mandarin-smoke/run-XXXXXX")
cd services/loom-engine
VIDEO_MANDARIN_ASR_TEST=1 \
VIDEO_MANDARIN_PYTHON="$ROOT/.local/mandarin-smoke/venv/bin/python" \
VIDEO_MANDARIN_AUDIO="$ROOT/.local/mandarin-smoke/fleurs-mandarin.wav" \
VIDEO_MANDARIN_OUTPUT="$OUT" \
VIDEO_MANDARIN_SOURCE_SHA="$(git rev-parse HEAD)" \
ASR_MODEL=tiny \
ASR_MODEL_DIR="$ROOT/.local/mandarin-smoke/models/tiny" \
ASR_MODEL_MANIFEST="$ROOT/.local/mandarin-smoke/models/tiny/model-lock.json" \
HF_HUB_OFFLINE=1 \
node --test validation/video-knowledge/mandarin-asr-qa.ts
```

需要已有 FFmpeg/ffprobe、Node 24 和 Loom 开发依赖。下载脚本仅获取官方固定 revision 的一个许可音频成员与固定模型，校验长度/hash，不解压不受信路径，不把模型隐式下载放入生产 ASR。Python 直接依赖沿用现有固定版本；本地实际完整安装包版本及 RECORD hash 记录在报告中，不能把一次安装当成全部平台的可复现镜像证明。

输出目录保留 `licensed-source.wav`、`mandarin-no-subtitles.mp4`、`fixture.json`、`asr-receipts.json`、原始 content-addressed ASR parts、SQLite 和 `acceptance.json`。报告记录 base commit 与实际工作树源码 SHA-256，避免把未提交 harness 冒称为该 commit 内已有代码。`local-process-diagnostics.json` 仅留本地，不上传主机诊断信息。

## 原失败路径与独立复核

先前试用官方 eSpeak NG `cmn` 自写普通话合成音频，生产 tiny/VAD 返回空 segments；该实验**失败，不计通过**，也未关闭 VAD 来求通过。最终改用上述明确许可的人声样本。eSpeak 不是最终复现所需依赖，未加入生产镜像或锁。

首轮实际链路 1/1 通过，独立 reviewer 在另一个输出目录实际复跑亦 1/1 通过；最终专用脚本再次验证。执行器出现非致命 UCX VFS socket 权限警告，未扩大权限或重试被拒绝的 IPC；实际模型与全部引用断言仍通过。公开证据仅保留警告类别和计数，原始诊断留本地。

机器可读结果：[`evidence/mandarin-asr-acceptance.json`](evidence/mandarin-asr-acceptance.json)。
