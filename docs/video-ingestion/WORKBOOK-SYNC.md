# 开发任务工作簿同步

`WeaveSense_完整开发任务清单_执行版.xlsx` 是原始六表工作簿的执行副本。原始交接包不被覆盖。状态唯一来源为 `PROGRESS.json`，任务和验收用例身份以 `spec/tasks.baseline.json` 为准。

总览中的“完成比例”沿用原模板公式，计算的是**满足原依赖与整项验收的正式任务签收比例，不是代码实现比例**。当前工程实现、范围化实测及直接业务条件见 [V1-CLOSURE.md](V1-CLOSURE.md)；执行副本的端到端用例已同步为 23 条客观技术验收通过、6 条原实际条件待补，P2 仍未开始。仅技术场景通过不会自动把全部关联任务或行业业务验收标为完成。

## 更新

在仓库根目录执行：

```bash
bash scripts/sync-video-workbook.sh
```

默认读取仓库内的 `docs/video-ingestion/spec/tasks.baseline.xlsx`，所以源码包无需依赖原开发目录。该文件是用户原始 XLSX 的逐字节副本，按 `spec/manifest.json` 校验 SHA-256；原始交接包未修改。也可显式指定相同原始文件的另一个副本：

```bash
bash scripts/sync-video-workbook.sh --baseline /path/to/WeaveSense_完整开发任务清单_v1.xlsx
```

需要 Codex primary runtime 的 `CODEX_PRIMARY_RUNTIME_NODE`、`CODEX_PRIMARY_RUNTIME_NODE_MODULES` 和 `CODEX_PRIMARY_RUNTIME_PYTHON`。脚本在独立临时目录解析 `@oai/artifact-tool`，不安装或改写项目依赖。Python 仅以 ZIP/XML 进行只读审计，不生成或修改工作簿。

首次检查原模板可用 `--inspect-baseline`。`--qa-dir` 指定核验及预览输出目录，默认 `.local/workbook-qa`。同步命令每次重新读取台账；不得手工将执行副本改成第二个状态源。

## 更新边界

- 按原始任务 ID 更新“开发任务”G/H/P/Q 列：负责人、状态、Issue/PR、执行备注。Q 列的原始要求逐字保留，另起“【执行记录】”段落，不以运行记录替换要求。
- 按原始 AC ID 更新“端到端用例”H/I/J/K 列：状态、验收人、证据、缺陷。台账没有证据时保持空白，不把代码存在或夹具通过写成真实验收。
- 保留六个工作表、全部原始 ID、要求、公式、估算、P2 范围、单元格样式、条件格式、校验和冻结设置。仅增加新增备注所在行的高度，避免截断；不改变其他行高或列宽。
- 用台账校验器阻止删除任务、跨范围推进 P2、无证据“完成”等不合法状态。同步期间台账发生变化则中止，需重新执行。

## 核验

每次导出前，临时改变一个任务和一个 AC 状态，验证总览计数和下游依赖会重新计算，再恢复输入。最终重新计算并扫描公式错误。

`workbook-validation.json` 保存本次输入、台账和输出哈希及核验结果。只读审计逐单元格比较值、公式和有效样式，比较全部工作表原生功能，独立核对任务推进状态、阶段/模块/里程碑汇总。任何越界变化都会阻止替换正式执行副本。完整预览、变更清单和计算探针结果保存在 QA 目录。

运行时导入的条件格式填充模式在直接导出时会丢失。同步器读取原模板的四条规则，通过同一 Artifact Tool API 显式重建原规则的纯色填充，不新增业务规则。审计解析关系目标、实际差异样式及相对优先顺序，不把导出时重新生成的内部编号当成内容变化。导出保留的未使用样式记录在验证报告中单独计数。

预览使用 Artifact Tool。没有以 Microsoft Excel 或 LibreOffice 实际打开文件，因此不声称完成了原生应用交互式下拉框或原生引擎计算验收。
