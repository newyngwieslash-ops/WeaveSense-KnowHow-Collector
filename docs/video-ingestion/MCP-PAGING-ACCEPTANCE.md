# AC18 / AC05 跨语言分页与重放工程验收

`backend/internal/flow/video_mcp_paging_qa_test.go` 在 `FLOW_VIDEO_CROSSLAYER_TEST=1` 时启动独立 Loom harness，走实际 Go MCP Gateway、go-sdk HTTP transport、薄 MCP handler、签名 EngineClient、Loom HTTP、scheduler、后台 video worker 与 canonical indexing；不是伪造 Loom 回包。现有 `video-knowledge` CI backend job 自动执行此测试。

- `video_process_start` 返回后台 operation/job handle，而不是等待处理结束。
- 同一 scope/config/video 经 MCP、手动 HTTP 与真实 scheduler 提交，只产生一个 job、一次 input、一次 process 和一个 `video.knowledge_ready` 事件。
- 81 个自编 Unicode 字幕段形成超过单次 MCP 输出边界的实际宿主资料；按 cursor 读取 21 页，检查无重复/缺失 evidence、固定 snippet hash 与时间定位。
- 超过 1200 UTF-16 单位的 quote 明确标记不完整，以固定 revision 的 `read_ref` 完整回读；再以小页重建 19395 UTF-16 单位的整份文档，检查 emoji、偏移与末尾没有截断或重复。
- 测试专用 `/__fixture/receipts` 只观察实际 provider 提交和持久表计数，不能写入、推进或完成生产状态。

外部 provider 为合成 fixture，不使用真实平台账号、视频或付费模型。因此本测试证明有界异步工具和后台持久链路，不替代真实平台长视频、行业内容质量或试点验收，也不自动关闭原任务账本。

执行命令：

```bash
FLOW_VIDEO_CROSSLAYER_TEST=1 go -C backend test ./internal/flow \
  -run '^TestVideoQAMCPPagingAndCrossEntryReplay$' -count=1 -v
```

前提：Go 版本符合 `backend/go.mod`，Node 与 Loom 锁定依赖已安装；端口随机绑定 `127.0.0.1`，数据库与删除日志在专属临时目录，测试结束关闭并清理。
