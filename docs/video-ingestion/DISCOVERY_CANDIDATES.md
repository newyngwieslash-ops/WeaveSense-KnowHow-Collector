# AC03 两个后台窗口产生新候选

`flow/video-discovery-candidates.test.ts` 补充 [发现/游标恢复检查](DISCOVERY_RECOVERY.md) 没有覆盖的下游候选链路。该测试不启动浏览器或聊天进程，不直接向 SQL 插入 ready job、抽取任务或候选。

实际执行链路：迁移后的磁盘 PGlite → 两个平台类型账号的真实 Loom scheduler → collection worker → video coordinator 的 `workOnce` → manifest 字节/哈希、证据和引用校验 → 自动入队真实 `VideoKnowledgeExtractor` → 研究查询可见的候选。两个 10 分钟窗口使用注入时钟加速，每个窗口两个账号各新增一个视频；第二窗口还重见旧条目。窗口结束后均关闭数据库并从原路径重新打开、恢复 journal，然后查询候选。

本地专项已通过，结果为：

- 4 个唯一 ready video jobs，4 个成功 collection runs。
- 8 次唯一 input/process 执行、4 次唯一模型适配器调用，旧视频不重复处理。
- 4 个候选与 4 条 `video.knowledge_curated` 事件；第二窗口恰好新增两个候选，重启后全部保留。
- 候选没有 approval 或 release；普通已发布知识查询仍为空，模型完成不等于审批或发布。

```bash
cd services/loom-engine
node --experimental-strip-types --test flow/video-discovery-candidates.test.ts
```

外部账号分页、自编中文字幕字节、模型输出/用量 receipt 和基础方法解析均为明确标记的 fixture；真实校验与持久化代码并未替换。不声称真实 B 站/抖音账号、外部真实模型、付费账单、原生 Agent/Canvas 整栈、浏览器关闭动作或真实行业质量已经验收。真实方法执行与整栈证据另见各自专项；原始 AC03 业务验收仍需授权的实平台账号与新增窗口。
