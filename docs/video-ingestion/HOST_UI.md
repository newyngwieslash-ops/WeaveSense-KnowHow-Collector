# 宿主视频知识界面

## 实际接入点

本功能扩展现有 `web/src/pages/intelligence/index.tsx` 的导航，沿用
`RequireAuth`、`UserLayout`、工作区选择、Ant Design 主题和三层语义 token。
没有新建登录、独立前端、笔记应用或另一套任务/知识缓存。

| 宿主路由 | 内容 | 实现 |
| --- | --- | --- |
| `/intelligence/sources` | 原 RSS/Telegram/WeChat 保留；B站/抖音单视频或账号，授权依据、领域版本、发现、调度、暂停/恢复、立即运行、有界补采；保留/撤权影响和受控批次 | `video-source-editor.tsx`、`video-retention-controls.tsx`，由现有 `sources-panel.tsx` 嵌入 |
| `/intelligence/domains` | 不可变领域版本、问题/术语/边界、人工复核策略、真实预算/资源上限、必需能力 | `video-domain-profiles.tsx` |
| `/intelligence/video-jobs` | 持久批次与视频/分P、真实阶段、覆盖、重试/取消/核对、无 job ID 的恢复键入口、分页产物、ready 后独立整理运行及人工转写校正；有界质量/运行/治理指标 | `video-ingestion-jobs.tsx`、`video-transcript-correction.tsx`、`video-insights.tsx` |
| `/intelligence/video-knowledge` | 默认仅有效 published 检索；显式复核队列；编辑/提交/批准/发布/撤回 | `video-knowledge-review.tsx` |
| 同上证据侧栏及任务详情 | 固定修订原文、UTF-16 高亮、已知/未知时间、受权媒体播放、懒加载帧/OCR/模型派生/冲突双方时间线 | `video-evidence.tsx`、`video-evidence-timeline.tsx`、`video-conflict-review.tsx`、`video-media-preview.tsx` |
| 显式知识复核队列 | 有界近重复来源候选、固定双方修订、人工同源/独立裁定 | `video-origin-review.tsx` |
| `/intelligence/video-skills` | 冻结方法候选、基础版本比较、真实评测、批准、源控包、部署 receipt、原生安装/pin/回滚 | `video-skill-candidates.tsx` |
| `/intelligence/mcp` | 现有 MCP 连接批准、schema 漂移、凭据失效及精确网络策略诊断 | `video-connection-health.tsx`，由现有 `mcp.tsx` 嵌入 |

上表页面文件均位于 `web/src/pages/intelligence/`。
业务接口独占使用 `web/src/services/api/request.ts` 的 `http`，协议位于
`video-knowledge.ts`、`video-knowledge-review.ts`、`video-media.ts`、
`video-origin-review.ts`、`video-insights.ts` 和 `video-retention.ts` API 模块。
`X-Workspace-Id` 仅选择宿主工作区，权限仍由 Go 验证并委托；浏览器不传
tenant、actor、grant、scopes、平台 key 或伪造部署/评测回执。宿主登录 Cookie
由同源浏览器自动发送，绝不写入请求体、播放 URL 或前端持久存储。

## 状态、恢复和版本规则

- 界面不使用估算百分比，也不把外部任务完成、输入就绪、资料就绪、知识发布、Skill 部署和安装混为一谈。
- 来源暂停只停止未来采集，不等同撤权或擦除。补采有显式起止时间、90 天窗口及最多 200 条限制；后端再次校验。
- 独立调度通过 `PATCH /schedules/:id` 的 `enabled` / `expected_revision` 启停，不顺带改变频率、预算或授权；监控拥有的调度仍由既有监控编辑器管理。
- 发现先返回持久 handle，随后通过 GET 分页刷新结果，不重复 POST 发现，更不隐式下载。
- video start 保留提交恢复键；响应丢失可仅凭该键核对，不要求未知的 video job ID。结果不明禁止盲目重提。
- 宿主取消与远端 requested/confirmed/unsupported/unknown 独立显示；已发生 usage 不清零。
- 每阶段显示白名单提交意图、是否已确认外部任务身份、最后已确认外部状态及历史观测时间；不暴露远端 ID/URL/原始响应。旧响应缺字段、unknown 或无有效观测时间一律显示尚无确认响应；本地取消/完成不能补造远端停止，历史 pending 保留且明确不是当前状态保证（COL-024 I1）。
- 审核、发布、撤回和编辑绑定读取到的 `expected_version` / `expected_hash`，并发冲突只报错和重新加载，不覆盖他人修改。
- 普通知识列表始终调用 published-only search（包括空查询），不通过 research 或候选列表补答案。复核详情显式使用 `mode=review`。
- UTF-16 坐标严格以 `${title}\n\n${body}` 为基础。偏移不合法、切断 surrogate pair 或引文不匹配时拒绝伪造高亮。无可靠时间轴显示“时间未知”。
- 人工转写校正从宿主读取真实 revision、content hash 和片段证据，条件提交后创建新修订，绝不覆盖旧引文或伪造新的逐字时间。
- 开启必需 embedding 的校正可能返回 queued/embedding、revision:null；界面显示等待索引，不将 proposed_revision 宣称为已经提交。领域配置显式支持必需/可选 embedding、模型与父预算内的限额。
- 五类 retention_policy（媒体、音频、帧、转写、证据）由后端标准化 access/maximum 秒数；表单可编辑完整 JSON。工程默认值不是行业合规建议，文本与原始媒体期限有独立语义。
- ready 后整理运行独立展示候选 ID、冻结领域/文档版本和模型/预算阻断。领域表单提供 `knowledge_model_id`、`knowledge_budget_micro`、`knowledge_max_tokens`，未配置不伪装为已经提炼。
- 没有受权宿主播放地址时，只显示源链接和时间范围，不拼装平台精确跳转或本地播放 URL。
- 媒体只接受服务端登记的 `/api/intelligence/video/jobs/:job/media/:opaque_id` 精确路径。加载前通过 `http.raw` 校验 1-byte Range；原生 video/audio/img URL 只附工作区选择器，当前 Cookie/成员资格由每次 Range 的宿主入口重验。无自动播放、无任意外部 URL、无直接对象存储 key/token。
- 时间线按需展开；来源片段、视觉记录、媒体分别有界分页，长文本以固定记录/UTF-16 offset 续读。OCR 与模型观察/推断分别标注；时间重叠不等于语义一致。冲突候选同时保留语音和画面固定文本、hash、时间，并分别分页，不自动选择真相。
- 403 撤权、404 缺失、410 到期有独立错误；活动媒体定时重验，失去授权/页面隐藏时卸载。仅明确 object_missing 或实际 404 展示修复按钮；修复是带原幂等键的新工作，可能计费，queued 不等于 restored，GET 从不自动修复。
- 方法候选评测请求持久化，分数只从可信评测服务读取；批准不部署。源控包只生成/保存 JSON；CI 和部署 receipt 只读。
- 方法候选必须由人明确填写 `rule_evidence`，将 method 和每一步映射至所选已发布版本的真实证据；界面只展示可用 ID / 修订 / hash，不自动编造规则支持关系。
- 候选安装使用宿主专用 install 路由，绑定候选、原生 hash 及实际已安装的 `expected_install_hash`；切换或回滚遭遇 409 刷新后重新确认，不自动覆盖，不变更历史 run pin。
- 历史候选支持有界分页；`video-method` 不回退普通安装接口。评测只有服务端明确记录阻断原因时才展示恢复入口，不模拟分数或重新创建候选。
- 页面轮询和请求取消仅更新投影；真实后台工作不依赖浏览器。切换工作区/账号清除页面数据，失败不伪装成空列表或成功；不持久化原文、密钥或整个任务对象。
- 知识或方法依赖不可用时只展示审计墓碑；候选 `proposal:null` 不触发解引用错误，原文、编辑稿、方法发布包和待操作快照会清除，不能从旧缓存恢复撤权内容。
- 近重复候选只在显式复核模式读取；两侧固定修订读成功后才可作人工裁定。0.82 等建议阈值显示未校准，不作为概率、自动合并或独立来源证明。
- 洞察默认 7 天、最大 90 天、最近 500 个可见任务样本；截断会告警。成本未结算、人工准确率未标注均保持未知。全窗口审计运行指标与样本分离：阶段墙钟/排队、限流/授权状态转移、发现/去重、知识就绪延迟、证据关联、人工复核/版本、同源裁定及故障恢复均使用真实计数，不把完成率当准确率。

## IF-027 受控影响预览与批次

现有来源页的“保留 / 撤权影响与受控批次”调用：

- `POST /api/intelligence/video/retention/preview`：`action` 与 `source_id` / `asset_id` 二选一；只读返回实际来源、资产、任务、注册对象、文档、证据、知识、Skill、报告和研究 ID/状态。每类最多 500；超限拒绝并要求缩小目标，不静默截断。
- `POST /api/intelligence/video/retention/batch`：最多 20 个不同目标，每个带 `expected_impact_hash`、固定 `idempotency_key`、原因；撤权/清除另需明确 confirmation。UI 必须全部目标成功预览、人工核对并输入动作名称后才能执行。
- 服务器沿用 `VideoKnowledgeService.retention()`、人工 `intel.sources.write` 和外部权威删除日志，不另建删除引擎。确认事务短暂锁定依赖写入，重算完整预览 hash（含真实时间戳），匹配后才允许追加权威日志；依赖扩展/版本或期限变化返回 409，不能悄悄扩大范围。
- 批次逐目标返回结果；同一目标重放同键核对原命令。部分失败不显示整体成功。网络/5xx 响应不明不等于未写入，禁止换新键盲目重复。
- 页面分别列出当前可见性、执行后访问/内容范围、保留的审计 ID/hash/财务事件和物理清理 pending/deleted。历史 run pin 不重写，无关 Canvas、用户消息与财务不变。撤权不是物理清理完成。

## Canvas 复用审计

既有 `components/canvas/nodes/data-source-node.tsx` 已有 `intel_query`、topic、monitor
和获批准的 `mcp_tool` 绑定，并冻结工具版本与 schema hash。本次未复制 Canvas
或将 MCP 响应自动当知识。本次在已发布知识详情复用现有
`CanvasHandoffModal`，携带固定 document/revision/evidence/UTF-16 引用，由宿主
已有 handoff 和受管执行路径决定落点。

## 任务映射及证据边界

| 原任务 ID | 前端交付 | 当前验收边界 |
| --- | --- | --- |
| CFG-001（UI 配套） | 领域持久版本表单、预期版本、实际预算/必需能力配置 | API 与后端测试独立归属；未把 UI 存储当领域权威 |
| IF-017 | 双平台来源、只读发现分页、来源修订保护、实际调度/运行/补采入口 | 自动化已覆盖接口与保留旧来源面板；真实平台/浏览器验收待环境 |
| IF-018 | 批次展开、真实阶段、取消/重试/核对、恢复键、覆盖与产物 | 自动化状态与恢复契约通过；真实浏览器故障交互待环境 |
| IF-019 | 现有 MCP 页面诊断、管理员入口、scope 切换保护 | 不绕过网络策略；真实内部连接依赖后端联合验收 |
| IF-020 | 复核、发布/撤回、固定版本证据及 Canvas handoff | 自动化 UTF-16/错误/版本测试通过；人工行业复核与真实浏览器待验收 |
| IF-021 / IF-024 | 当前受权原始媒体 Range 播放入口、未知/到期/撤权/缺失区分、缺失对象显式修复 | 实际媒体 API 由后端验证；组件/协议测试不等同浏览器播放或编码兼容验收 |
| K-013 / K-015（UI 配套） | 懒加载视觉帧、OCR/模型派生区分、固定语音/画面冲突双方与长文续读 | 不用时间重叠替代语义证实，不伪造画面观察或模型结论 |
| K-020（UI 配套） | 有界近重复候选和固定双来源人工裁定 | 建议阈值未校准；无自动合并/独立性结论 |
| IF-027 | 权限内依赖影响预览、hash 绑定、受控批次、审计保留/物理清理区分 | 实际 PGlite+删除日志测试通过；浏览器批量确认/部分失败交互待环境 |
| K-031 / COL-024（UI 配套） | 样本口径、运行/治理/成本/覆盖指标，未知准确率明确保留 | 统计计数不替代人工行业质量基线或生产试点 |
| K-009（UI 配套） | 人工来源转写校正、固定 content hash、新修订回执 | 后端保持历史证据；实际浏览器校正操作仍待验收 |
| IF-025 | 候选冻结、基线比较、真实评测请求/结果和审阅 | 未虚构模型评测；评测服务未产生真实结果时保持等待 |
| IF-026 | 源控包、部署/安装 receipt、原生版本 pin/回滚 | 不执行生产 CI/部署；真实发布验收需获授权的构建与运行环境 |

以上是代码与验证映射，不把任务标为完整验收完成；统一状态仍维护在原 107 项
`PROGRESS.json`，P2 保留未开始。

## 可复现验证

在 `web/` 使用仓库 Bun 工具链和锁文件：

```bash
bun run typecheck
bun test test/video-knowledge-ui.test.tsx test/video-media-ui.test.tsx \
  test/video-retention-ui.test.tsx test/intelligence-panels.test.tsx \
  test/intelligence-gaps9.test.ts test/intelligence-empty-reason.test.ts \
  test/intelligence-member-api.test.ts
bun run lint
bun run build
# Existing host regression suite (not just the video module)
bun test
```

专项测试验证真实 React 组件服务端渲染、宿主 `http` 协议、全状态映射、未知时间、
中文/emoji/跨段偏移、无静默回退、并发版本和真实错误传播。这些不是浏览器验收、
平台下载、模型质量或试点的替代。浏览器截图与真实点击结果未执行时必须单独保留
“未执行/阻塞”，不能用 SSR 或独立 HTML 宣称通过。

2026-10-26 最新本地执行：专项 68 / 68（7 文件、463 断言）、完整宿主前端
2530 / 2530（333 文件、19439 断言，19.89 秒），TypeScript、ESLint 和生产构建
（7.04 秒）均通过。构建仍有既有大分块提示。日志为忽略的
`.local/validation/video-ui/{focused-col024-final.log,web-all-tests-col024-final.log,build-col024-final.log}`。
新增 5 项外部状态摘要测试覆盖旧响应、pending、unknown、缺少/无效观测时间，以及本地取消保留历史外部状态。
IF-027 后端 `node --experimental-strip-types --test flow/video-retention-impact.test.ts`
7 / 7 通过（PGlite + 实际外部删除日志），覆盖角色/跨范围、预览变化先于日志拒绝、
时间戳和新增依赖、部分批次、同键重放、保留审计/历史访问失效、异步清理、暂停不撤权和超限拒绝。
Loom flow TypeScript 与实际 Node strip-types 导入通过。上述数据均是隔离合成测试，不含用户凭据。

本执行环境 Chromium 在启动前被系统 socket/IPC 权限拒绝；一次批准重试又被
运行时隔离层的受保护目录策略阻断，因此没有继续尝试绕过或声明截图/浏览器通过。
独立验证任务已完成真实 Go + Vite 代理 + Loom、隔离开发账号 Cookie 的 HTTP 验证，
该证据依然只属于 API/SPA 文档服务层，不等于浏览器点击或真实平台验收。
