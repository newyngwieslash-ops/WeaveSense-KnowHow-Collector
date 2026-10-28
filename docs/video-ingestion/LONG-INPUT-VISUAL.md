# 长输入、Unicode 与视觉证据工程验证

本页说明可重复执行的工程门禁，不替代原始 PRD 的授权行业样本、实际模型质量或业务验收。任务基线与正式状态不据此自动改为完成。

## 本轮修复

- **字幕分片时间范围**：真实 Python worker 记录分片全部片段的 `min(start_ms)` / `max(end_ms)`。宿主原先错误地把最后一段的结束时间当作范围末尾，拒绝合法的重叠字幕。现在独立复算完整范围，错误范围仍拒绝，不用放宽校验掩盖不一致。
- **UTF-16 预览**：字幕证据的 1,200 字符预览与冲突两侧的 250 字符预览不得切开 surrogate pair。完整引用继续通过固定 revision 的正文分页读取；预览不冒充完整证据。
- **视觉引用**：模型可按非时间顺序引用实际帧；worker 按模型引用顺序生成对应 `frame_refs`，同时拒绝重复、未知或错误类型的帧 ID。起止时间仍来自真实引用帧的包络。
- **模型来源收据**：Python Gateway 与 Loom 视觉验证器均核对任务 ID、`model_task:<task_id>` usage 引用和冻结的 64 位模型配置 SHA-256。空对象、错任务、缺失或非哈希路由名不再算可追溯来源。仍不把这些收据等同于模型结论正确。
- **派生内容隔离**：`model_observation` / `model_inference` 只进入独立的派生视觉记录。`observation` 或显式 `derived=true` 不能进入 canonical source transcript；旧 `visual_observation` 证据也不能作为下一次知识生成的源材料。OCR 原文仍按实际帧、时间和媒体 hash 保存。
- **受控拒绝**：视觉 JSON 的 `null` 容器、空嵌套对齐/冲突对象以及空 transcript segment 返回验证失败，不以运行时 TypeError 代替协议错误。

## 已执行的本地工程验证

| 验证 | 实际边界 | 结果与限制 |
|---|---|---|
| `flow/video-longinput-qa.test.ts` | 真实签名 Python HTTP、SQLite 任务、Processor 分片 → 真实 Loom、迁移后的 PGlite、HTTP 上传/读取/证据分页 | 2,101 段、459,242 UTF-16 单元、7 个真实 worker 分片、23 页完整正文逐字/哈希一致。重叠字幕毫秒时间和全部 2,101 条证据的 UTF-16 区间逐条核对。错误范围与必需能力缺失不写文档、不发 ready。输入为自写字幕，不声称真实平台、Go 浏览器链或行业模型。 |
| `test_video.py::test_real_ffmpeg_concurrent_jobs_cancel_one_preserves_other_live_frames` | 两条生产 Executor/SQLite/FFmpeg/Processor 路径同时运行，分别使用两个 workspace 和真实临时目录 | 两者均到达 OCR 边界时取消 A；生产清理逻辑只删除 A 临时目录，B 仍在运行且全部帧 hash 不变，之后 B 完成并校验其对象。OCR 返回是明确标记的 fixture；取消不宣称远程或留存对象已删除。 |
| 既有跨语言视觉回归 | 真实 Python HTTP/SQLite/FFmpeg → Loom HTTP 视觉分页、Range、访问撤销、精确修复 | 定向回归通过。平台下载和 ASR/OCR/VLM 边界是 fixture，不声称真实模型或平台成功率。 |
| `video-temporal-projection.test.ts` / `video-visual-qa.test.ts` | 真实格式、类型、引用与 UTF-16 验证器 | 覆盖合法/损坏时间、emoji 预览、派生材料拒绝、帧错配、伪造 provenance、空 JSON 与冲突来源。 |
| `test_gateway.py` / `test_video.py` | Python 全部 49 项测试 | 通过，包括真实短片、场景切换、分段失败恢复、并发取消与上述来源合同。 |
| Flow production TypeScript | `npx tsc --noEmit -p tsconfig.flow.json` | 通过。 |

精确命令：

```bash
cd services/video-knowledge
python -m unittest discover -v
cd ../loom-engine
node --test flow/video-longinput-qa.test.ts
node --test flow/video-temporal-projection.test.ts flow/video-visual-qa.test.ts
node --test --test-name-pattern='cross-language media|K013 visual|AC09/12/13' flow/video-qa.test.ts flow/video.test.ts
node --test --test-name-pattern='K021/022' flow/video-knowledge.test.ts
npx tsc --noEmit -p tsconfig.flow.json
```

## 整栈采证入口

`scripts/fullstack/long-input.mjs` 在原有一次性 TEST 编排中，通过支持的密码登录访问第二个真实租户，建立独立 profile/source/job。该脚本只上传上述自写长字幕；知识整理预算为零，不配置或调用模型。

随后直接走 Go HTTP → Loom → Python → PostgreSQL / MinIO，核对完整正文、全部证据、重叠时间、分片计数与安全 Unicode 预览。正常成功报告只含 source commit、ID、hash、计数和检查结果，不含 Cookie、密码或全文；失败只输出受控 `failed_phase`。

```bash
# 仅在 scripts/fullstack/run.sh 建立的全新 TEST 栈、私有账号状态与环境下调用。
node scripts/fullstack/long-input.mjs > "$VIDEO_FULLSTACK_EVIDENCE/long-input.json"
node --test scripts/fullstack/long-input.test.mjs
```

此整栈入口的运行结论必须取自**最终源码提交**对应的 CI 原始 `long-input.json`；脚本和两项自检已落地不等于本机已执行 Docker。最终交付应分别标明该报告是否执行/通过，不能把上述 PGlite 结果替代实际 PostgreSQL/MinIO 或浏览器验收。

相关基线：K-003、K-006、K-007、K-008、K-010、K-011、K-012、K-013、K-015、IF-009、IF-024；AC09/AC10/AC12 等工程条款。真实授权视频、人工标注、领域指标、真实模型效果仍按原条款独立验收。
