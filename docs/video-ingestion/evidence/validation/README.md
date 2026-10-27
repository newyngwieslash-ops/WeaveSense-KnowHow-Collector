# 验证证据包

`validation-results.json` 是机器可读索引；`sanitized-logs.tar.gz` 只包含脱敏日志，不包含原始凭据或测试数据库。

## 重建

在仓库根目录运行：

```sh
python3 -m unittest discover -s docs/video-ingestion/evidence/validation -p 'test_*.py' -v
python3 docs/video-ingestion/evidence/validation/build_evidence.py \
  --qa-root '<原始 QA 输出根目录>' \
  --generated-at '<固定 UTC 时间>'
```

只有负责最终测试的执行者确认两个进程都已正常终止后，才能添加
`--terminal-confirmed-by '<确认者及 UTC 时间>'`。脚本还会检查最终成功标记、
前后源码清单一致性及预期清单哈希；未满足时拒绝写入最终通过状态。
未提供确认时仅生成待确认快照，日志可能仍在增长，不视为最终通过。

原始文件保留在 QA 目录，不写入仓库。索引逐文件记录原始和脱敏后的 SHA-256、
字节数，以及各规则实际替换次数。只有字节完全一致才标记为原样复制。
脱敏按规则顺序进行，因此替换次数不是独立凭据总数；仅显式的 `synthetic`
字面值可作为凭据形状的合成测试标记保留。JWT、认证头、Cookie、密码、
密钥/环境秘密赋值、URL 凭据及签名、私钥和工作区特有路径会脱敏。
模式识别不能证明覆盖所有未知秘密格式，必须结合合成数据来源与人工复核。
可用 `--prior-local-model-log '<先前媒体执行者的本地模型日志>'` 额外打包先前的
实际 CPU tiny/Tesseract 烟测。该日志与本次系统 Python ASR 的 7 通过、1 跳过
分别记录；保留 dog→log 识别误差和 UCX IPC 警告，不表示模型质量通过。

## 解释边界

- Go 仅统计行首 `--- PASS/SKIP/FAIL`，不重复统计缩进的子进程输出或子测试。
- 先前组合测试虽有通过结果，但发生源码漂移，仅作中间证据，不是最终冻结验收。
- 主机验证是实际 Cookie/session、Vite 代理及 API 验证，不冒称浏览器 UI 验证。
- 未验证真实平台获取、真实模型质量、行业人员批准、七天试点或部署；七项 P2 未启动。
- 本包不是 100/100 正式验收，不替代尚缺授权或环境条件的验证。
