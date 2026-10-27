# 视频知识工作流实施基线

## 仓库与隔离

- 实施仓库：`newyngwieslash-ops/WeaveSense-KnowHow-Collector`，接手时为空的公开仓库。
- 宿主代码：`newyngwieslash-ops/WeaveSense-Math`，实际接手提交 `514c70f666cb04e3e72cbfb967fac74d9f350747`，与规格中的历史提交一致。
- 实施分支：`feat/video-knowledge-v1`。`upstream` 指向宿主，`origin` 指向新仓库；不向原宿主推送。
- 本项目是宿主扩展，不继承此前独立 IKC 的登录、数据库、界面或调度实现。
- 原 MIT LICENSE、NOTICE、第三方声明保留。原自动镜像发布改为显式手工触发，代码推送不等于生产部署授权。

## 不可变输入与实时执行口径

`spec/` 保存用户提交的 PRD 文本、107 项任务 JSON 与最新提示词；哈希见 `spec/manifest.json`。Office 原件由实施方完整只读解析，未把原件中的初始“未开始”误当成当前执行结论。

107 项任务中 P0=81、P1=19、P2=7；V1=100 项，关联 29 个 V1 端到端用例。完整任务定义有 196 条实施要求、335 条任务验收、363 条硬依赖。原任务 ID、范围、依赖和说明不因当前代码缺失而删除。

`PROGRESS.json` 是唯一实时状态台账；`tasks.execution.json` 和 `PROGRESS.md` 是由不可变任务定义与台账合并的只读视图，不分别维护。原 JSON 的 `notes` 是规格说明，不用于覆盖实时阻塞备注。每项任务分别保存代码、自动化、真实宿主、真实平台、试点与部署证据。

## 实际代码核查

| 范围 | 基线代码位置 | 已核实与证据边界 |
|---|---|---|
| 主采集链 | `services/loom-engine/flow/engine.ts`、`flow/migrations/` | 主来源约束尚未包含视频；不能用 legacy collector 的 Bilibili 能力代替主链路接入。 |
| 任务与数据库 | `flow/db.ts`、`flow/main.ts`、`flow/server.ts` | 既有 PostgreSQL/PGlite、受信执行上下文、worker/scheduler/outbox 可复用；不另建自治调度库。 |
| MCP | `backend/internal/flow/mcp.go`、`mcp_idem.go`、`egress.go` | 宿主调用超时约束及 schema 批准存在；结构化结果不能与文本整包重复拼接；普通公网传输隔离须保留。 |
| ASR | `flow/enrichment.ts`、`workers/asr/server.py` | worker 与上层存在文本/segments 截断，需分段产物与覆盖协议，不是提高常量。 |
| 原生 Skill | `backend/internal/flow/skills.go`、`skillpacks/` | 原生 JSON pack、构建内嵌与安装 pin 是实际执行机制；普通 SKILL.md 不等价。 |
| 宿主界面 | `web/src/pages/intelligence/` | 复用 intelligence 导航与 API，不新建笔记前端或登录系统。 |

初始实际验证：`flow/engine.test.ts` 11 项通过。这个结果只说明原核心回归，不证明新增视频业务或平台下载成功。后续证据按任务记录，禁止将旧日志当作新代码验收。

## 外部输入待提供

首个行业、5–10 个业务问题、可使用的 B站/抖音账号与视频样本、行业复核人、发布负责人、模型/部署配置、预算与保留期限尚未冻结。开发样例明确标识，不把数学或储能自动认定为业务行业，不用样例代替真实平台、人工金标或七日试点。

这些条件只阻塞相应真实验收，不阻止不依赖它们的实现和工程验证。没有配置实际 Cookie、第三方密钥或生产发布。

## 工具链

本轮使用官方 Go 1.25.14 Linux/amd64、Bun 1.4.4、Node 24.22.1。Go 归档 SHA256 与 Bun npm 分发 SHA512 已按官方元数据校验；工具安装在独立工作目录，不覆盖系统程序。Go 模块沿用 go.mod/go.sum，Web 使用冻结 bun.lock，Loom 使用现有 package-lock.json。依赖安装通过不代表应用构建或业务验收完成。
