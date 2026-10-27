# 第二轮工程收尾与发布证据索引

## 范围与判定规则

本轮仅闭合不依赖真实行业数据的工程事项：交付文档、固定提交 CI、浏览器/Redis 验证、干净构建和配置预检。工作在独立工程分支进行；不合并 `main`、不部署生产、不调用付费模型、不扩展 P2。

**配置存在、测试已提交、工作流已触发、工作流成功、业务验收完成是五种不同状态。** 执行结果必须绑定实际提交和完整命令/运行记录；未执行或受阻不得标通过。构建镜像不代表已经部署，也不代表全部第三方授权已审查。

## 已完成的源码发布事实

| 证据 | 已核验值 / 边界 |
| --- | --- |
| 首次完整源码提交 | [`cf2aad9c5926500bfaae7bb39e48316ccd192269`](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/commit/cf2aad9c5926500bfaae7bb39e48316ccd192269) |
| 分支 | [`feat/video-knowledge-v1`](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/tree/feat/video-knowledge-v1) |
| Git tree | `22ee4bc77520e36832028d6c2ca51b7d92ab3df8` |
| 文件一致性 | 5,738 个文件的路径、权限模式、Git blob 哈希匹配；5,697 个归档源码文件和 41 个保留生成物另经 SHA-256 核验 |
| 导入校验 | [运行 40468402790](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/actions/runs/40468402790)成功；只证明导入/产物一致性，不是应用 CI |
| 临时工作流清理 | [提交 e387b717](https://github.com/newyngwieslash-ops/WeaveSense-KnowHow-Collector/commit/e387b717c29c934248bfe619c1e85af61589d18d)已移除一次性工作流；保留历史记录 |
| `main` | 导入完成时仍是初始化提交 `c4bd9672f7dba23e3e596b3203d977e9d2037e6b`，未合并源码分支 |

先前源代码精简包的重建边界见 [SOURCE_ONLY.md](SOURCE_ONLY.md) 和 [source-only-rebuild.json](source-only-rebuild.json)。它们与上述远端文件一致性一起补充源码交付证据，不替代镜像、运行环境和业务验收。

## 本轮执行记录

本节由执行负责人在实际运行后补充提交、运行链接、通过/失败/跳过数及原因。当前不能将首轮本地测试数量搬作第二轮结果。

| 检查 | 当前可作出的结论 | 完成证据要求 |
| --- | --- | --- |
| 发布文档一致性 | 已修正 GitHub 同步仍待授权的旧描述；历史报告加边界说明 | 文档差异、链接与事实核对 |
| 固定提交应用 CI | 尚无本轮终态结果 | 实际 head SHA、运行链接、各 job 结果；不得用导入校验替代 |
| Chromium / Redis | 首轮环境受阻的历史结果保留；本轮待执行 | 实际浏览器交互、Redis 必选测试不跳过；失败/跳过原因公开 |
| 干净构建 / 配置预检 | 本轮待实现并执行验证 | 固定基础镜像、构建日志/摘要、预检正反例；区分静态检查与运行检查 |
| 最终 OS / 应用依赖 | 现有来源清单不等于最终镜像 SBOM | 绑定实际构建的系统包、应用依赖和产物清单 |

## 供应链与许可待补证清单

本节整理 [DEPENDENCIES.md](DEPENDENCIES.md) 的已知证据，不给出法律适用性结论；不要使用根目录 MIT 推断全部分发物均为 MIT。原依赖快照保留，不改写成新的构建实测记录。

| 范围 | 已知证据 | 仍需补齐 |
| --- | --- | --- |
| `@ffmpeg/core` / FFmpeg WASM | 版本元数据声明 `GPL-2.0-or-later` | 实际分发构建、对应源码/通知与适用义务审查 |
| tldraw 家族 | 部分元数据为 `SEE LICENSE IN LICENSE.md`，条款与组件不同 | 与实际版本及使用方式对应的官方完整条款，逐包记录 |
| Live2D runtime / 模型 | 项目 NOTICE 明确不受根 MIT 覆盖 | 运行库、SDK、模型素材分别授权与通知 |
| 字体与静态资源 | 部分 Fontsource 包声明 `OFL-1.1` | 保留许可和归属；其他图标、品牌、素材单独核对 |
| 缺少许可元数据的组件 | `@giscus/react`、`@splinetool/runtime` 等仍有未知证据；部分其他包有许可文本但缺 SPDX 字段 | 取得版本对应官方证据，不猜测许可表达式 |
| Python / native 依赖 | 已有部分 wheel 哈希与声明；精选 requirements 不是所有传递依赖的完整哈希锁 | 按目标运行环境生成依赖闭包，保留捆绑库材料与未知项 |
| 服务镜像 | 基础镜像 digest 与最终服务镜像是不同对象 | 实际构建结果、最终 image 摘要、OS/应用 SBOM；不能把标签锁定当成完整可复现构建 |

已修复的 Pi lock integrity 缺项不再列为未修复问题；任何依赖更改仍须重新校验。真实 DTK 镜像、外部服务部署与账号可用性不由本项目源码发布保证。

## 不因本轮工程结果自动关闭的条件

- 正式台账仍为 **2 项完成、88 项待验收、10 项阻塞、7 项 P2 未开始**；以 [PROGRESS.json](PROGRESS.json) 为唯一任务状态来源。
- V1 的 29 个全局验收用例仍需按原始前置条件逐条闭合；测试数量不是验收百分比。
- 首发行业、5–10 个业务问题、合法样本/使用期限、人工金标、复核人与发布人，以及模型预算和真实平台条件仍需业务输入。
- DTK cancel 不证明外部存储/备份物理擦除；继续披露 `separate_retention_required`，不能宣称全链物理删除完成。
- 真实双平台闭环、行业质量、持续试点、生产上线决定与 P2 扩展保持独立，不能用模拟输入或加速测试替代。

历史工程验证入口：[QA-INDEPENDENT.md](QA-INDEPENDENT.md)、[GAP-CLOSURE.md](GAP-CLOSURE.md)、[validation-results.json](evidence/validation/validation-results.json)。
