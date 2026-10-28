# 本地媒体容量校准与旧链路兼容

## 结论边界

`services/video-knowledge/capacity.py` 测量真实媒体 worker 路径，不再用控制接口 QPS 代替视频处理容量：签名 HTTP 提交 → SQLite 队列/claim → FFprobe/FFmpeg 解码、抽帧与网格 → 不可变对象实际文件写入、fsync 与哈希核验 → worker 产物完成。

**这里的 ready 是 worker objects-ready，不是宿主 `video.knowledge_ready`、知识整理或 Canvas 完成。** 对象存储为明确标注的本地文件适配器，不是 MinIO；源视频由 FFmpeg `testsrc2` 自写，OCR 仅为外部边界固定响应，未运行 ASR/VLM/模型或真实平台。输入生成、初始对象准备不计入处理墙钟。有限突发全部排队后启动 worker，队列等待包含这一明确的负载形状。

报告给出硬件可见信息、源码 commit/文件 hash、提交 P95、排队 P95、每视频分钟墙钟、处理 P95、产物完成 P95、CPU 时间、对象写入量和临时文件/进程树内存采样峰值。20ms 的 sum-RSS 采样可能漏过短峰值、重复计算共享页，**不是 OOM 安全证明**；若 cgroup 限额不可读，明确输出 null，主机 RAM 不冒充容器配额。外部模型调用和收费为零，计算与存储价格未估算。

## 可复跑命令

```bash
python -m unittest discover -s services/video-knowledge -p 'test_capacity.py' -v
for n in 1 2 4; do
  python services/video-knowledge/capacity.py --concurrency "$n" > "media-capacity-c${n}.json"
done
```

默认每组 6 个 6 秒、320×180、10fps、MPEG-4 输入，共 0.6 视频分钟；参数限制总视频时长不超过 120 秒、最多 4 worker，防止误发起无界负载。测试还用实际分配 32MiB 的存活子进程证明内存统计包含子进程，而不是只统计 Python 父进程。记录中的 `observed_peak_claimed` 保留实值，超过配置 worker 数直接失败，不裁剪指标。

### 本地实测记录

在同一 Linux x86_64 执行环境顺序运行三组；可见 9 逻辑 CPU，主机内存 10,451,439,616 字节，磁盘总量 5,225,717,760 字节，cgroup CPU/RAM 限额不可读。每组均全部完成，输出 66 次对象写入、1,734,816 字节；实际峰值 claim 分别为 1、2、4。

| worker 数 | 总墙钟秒 | 提交 P95 ms | 排队 P95 ms | 处理 P95 ms | objects-ready P95 ms | 进程树 sum-RSS 采样峰值字节 | 临时文件采样峰值字节 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 5.175 | 4.59 | 4314.54 | 930.07 | 5163.73 | 68,526,080 | 513,247 |
| 2 | 2.823 | 6.00 | 1916.94 | 1026.17 | 2810.28 | 92,897,280 | 948,899 |
| 4 | 2.081 | 5.66 | 1143.35 | 1153.57 | 2066.95 | 166,416,384 | 1,820,203 |

这组小样本中，提高 worker 数缩短了突发总完成时间，但单任务处理 P95 和内存峰值增加。不能据此冻结部署并发或 SLO；模型、真实视频长度分布、MinIO 网络、宿主导入/知识处理和目标部署资源都未纳入。原始本地报告为 `.local/validation/video-media-capacity-c{1,2,4}.json`；基于 `1baf5366209ee12ad7694404ac6d3ad98da50ed6` 加本轮改动，报告明确 `tracked_worker_sources_dirty=true`，实际五个 worker 源文件 hash 一并记录。最终分支提交应以对应 CI 的新报告为准，不把这里的工作树实测说成最终 SHA 已通过。

## 水位恢复的真实缺陷与回归

演练不填满磁盘、不制造 OOM、不替换 `disk_guard`：将配置保留水位提高到实际磁盘总量之上，真实处理被 `STORAGE_PRESSURE` 拒绝且不发布 result，再恢复原水位，对**同 task/job**执行显式 retry。

首次演练暴露实际问题：早期磁盘压力失败已由 Executor 写入 execution usage，但 Processor 仅对整个 usage 对象 `setdefault`，恢复时缺少 `ocr_requests` 等计数器，引起 `KeyError`，外部表现为 `PROCESSOR_FAILED`。修复只补不存在的 processor 计数键，保留已有执行时间、计费/模型计量。回归要求恢复后真实 FFmpeg/OCR 边界完成、task 身份不变、原执行时间不减少且执行 quantum 增加一次。

每组校准都单独执行此水位演练，演练工作不混入上表处理指标。它证明配置水位拒绝与恢复重试，不能代替目标机器的真实资源饱和测试。

## AC24 剩余旧路径

- `flow/video-wechat-compatibility.test.ts`：同一 WeChat gateway/Atom fixture 经真实 connector、签名 HTTP、Engine 定时采集、修订和 FTS，在实际 `engine.video.enabled` 两态逐字段一致；两态均没有 video journal。
- `validation/video-knowledge/legacy-cycle-harness.ts` 与 Go `TestVideoAC24PeriodicCanvasFeatureToggleParity`：Node 实际读取开关、创建真实 WeChat source/schedule，运行三个周期后输出真实 `collection.completed`；Go 使用这些事件执行原生 consumer、dispatcher、当前审批校验、预算准入及 managed Canvas runner。两态各两个周期成功、重复投递不增 run、第三周期额度耗尽终止，结果一致。
- 周期测试的持久审批投影与外部模型/monitor 查询沿用 `t22Setup` 明确 fixture，不宣称它覆盖真实 CloudAgent decision 路由或真实 WeChat 账号。不是仅在 Go 中设置无人读取的环境变量后重跑同一测试。

这些是可复现工程证据；不修改原始任务基线或自动标记 COL-031/AC24 业务验收完成。目标环境容量/MinIO/真实授权样本、升级灰度与试点 SLO 仍需对应环境和授权后验证。
