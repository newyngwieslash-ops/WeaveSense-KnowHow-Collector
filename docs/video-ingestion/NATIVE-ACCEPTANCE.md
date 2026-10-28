# AC25 原生 Skill 工程验收

本页区分真实宿主运行路径与外部模型/业务验收。完整 V1 任务状态仍以原任务账本为准，不因本页或 CI 通过自动修改原验收状态。

## 可重复的隔离 TEST 路径

[`fullstack-native.mjs`](../../.github/browser/fullstack-native.mjs) 接入现有整栈测试，在真实密码登录、合法字幕上传、worker 处理、知识人工复核/发布之后运行。它不写数据库、不替换宿主服务或审批 authority：

1. 从真实 `/api/intelligence/skills` 注册表读取 `video-knowledge-core`，按版本安装。
2. 经 `/api/agent/conversations` 和真实 `IntelRunChain` 的工具入口加载方法；核对 version/hash、服务端生成的 run 知识 snapshot 和已发布资料的宿主 evidence/document revision。
3. 使用现有画布操作 API 新建 `data-source → skill` 图，不新增工作流引擎或轮询节点。
4. 通过实际 `canvas-workflows` 审批申请验证未批准不能执行，再调用真实 CloudAgent 决策路径。持久 admission、预算、能力快照、managed runner 和 ModelTasks 执行原生 Skill。
5. 核对结果中的 Skill version/hash、任务 ID、prompt/request hash 与宿主证据引用；同审批重放必须返回同一 workflow run，结果写回真实 Canvas。
6. 实际服务重启后再次读取同一 pin、snapshot、任务和输出；知识撤回后重放原 Agent 查询 call ID，旧快照不得返回已撤回知识。

原始整栈 artifact 中的 `browser-initial.json`、`browser-after-restart.json` 保存 `native` 身份/哈希与对应 `checks`。是否实际通过，以所交付源码 SHA 对应的实际运行产物为准；仅检查脚本语法不算此链路通过。

## 明确边界

- 字幕是自编、可合法使用的测试资料，不是 B 站或抖音采集成功证据。
- 外部模型仍是严格的确定性 HTTP fixture。新增支持的是生产 Canvas 原生模板请求封装，要求真实路径附带方法标识、version/hash、run 知识 snapshot；没有替换 Go/Loom/worker/审批/计费实现。
- intelligence 经实际 Agent 工具桥调用，Canvas 经实际 CloudAgent 审批与运行链路；**不声称验证了 Pi/LLM 自主选择工具、真实模型质量或真实行业效果**。
- 正式的行业基线、授权平台样本、人工质量标注与持续试点仍需对应业务输入，且保留原任务依赖关系。

## 此路径发现的失败关闭修复

- `LoadSkillForRun` 原先忽略首次 pin 的数据库写错误并递归重试；写故障或跨 scope 的同键冲突可能无限递归。现在返回实际写/读错误并只读回一次持久 pin，不能将未落库方法当作已冻结版本。
- Agent conversation 的加载闭包原先使用根 DB 而不是当前请求 DB。现在保留 `TenantMiddleware` 的请求事务/RLS 上下文，不仅依赖显式 ownership 条件。
- 同一个 `intel_load_skill` call ID 的重放现在重新验证当前持久 pin、部署/依赖与工具边界；旧成功回执不是永久授权。
- 专项回归见 `skill_pin_failure_test.go` 与 `agent_routes_scope_test.go`；真实运行路径仍由上述整栈测试独立验证。
