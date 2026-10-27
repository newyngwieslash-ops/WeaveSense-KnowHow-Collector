# 视频删除日志与恢复屏障（R25 / K025）

## 安全合同

PostgreSQL tombstone、Outbox 与数据库快照一起回退，不能单独防止备份之后的撤权/删除复活。`flow/video-journal.ts` 使用**独立保留、不能随数据库或媒体快照恢复的 POSIX 文件系统卷**作为删除意图权威，不新增 SaaS、数据库或内容副本。

- 配置为 `VIDEO_DELETION_JOURNAL_DIR`、`VIDEO_DELETION_JOURNAL_ID`、`VIDEO_DELETION_JOURNAL_KEY`。密钥至少 32 字节，由获授权的运维从秘密存储注入；不得提交仓库、备份清单或打印到日志。
- 目录及文件不得为符号链接，不允许组/其他用户写入。初始化目录 `0700`、文件 `0600`。所有 Loom 角色需要相同卷、身份与密钥，运行 UID 必须能访问；媒体处理器不能挂载此卷。
- `identity.json` 含随机 `generation_id`；每次初始化产生全新世代。同名 ID、同密钥重新初始化也不能复制旧身份。数据库 singleton 与备份 checkpoint 固定世代的 genesis hash。
- `events/000000000001.json` 起连续编号，只追加，不覆盖/清理历史。事件字段仅有版本、事件 ID、tenant/workspace、`revoked|erased`、单一 source/asset ID、请求/操作者 SHA-256 及时间。禁止原文、原因、链接、凭据和任意附加字段。
- 每条记录含前条 hash、规范化 payload hash 与 HMAC；`head.json` 也是 HMAC 认证的高水位。读取验证整个连续链、身份及 HEAD，任何缺失、截断、乱序、篡改、孤立记录或不确定临时 HEAD 均拒绝视频访问。
- 每次追加取得跨进程目录锁，依次 fsync 记录、events 目录、临时 HEAD，再原子替换 HEAD 并 fsync 根目录，完成后才返回成功。同一事件 ID 的相同语义重试返回原记录；改变范围、目标、行为或请求 hash 则冲突。重试时间不同不创建第二条事件。
- 正常撤权先做权限及目标归属检查，再持久化外部意图，最后在同一个数据库事务完成业务变更和 receipt。事务回滚或响应丢失不撤销外部意图：屏障会安全补做删除，不把未知结果当未执行。
- 正常变更与重放在锁定业务行之前取得同一数据库 singleton 事务锁。重放验证外部链，释放文件锁，再进入数据库事务，避免文件锁/数据库锁反转。receipt 与业务变更原子提交；多进程重放不重复生效。
- 启动全局重放先绑定空数据库。未绑定且已有视频数据的旧库、请求范围内偷偷初始化、数据库 receipt 超过外部水位或身份冲突均 fail closed。不能通过 feature flag 关闭或重新创建空日志绕过。
- 每次读屏障重新检查外部链与数据库 receipt，不依赖进程内“启动已成功”的缓存。请求只重放认证上下文的 tenant/workspace；启动系统上下文重放全部范围。本地文档/索引/知识/Skill 依赖先不可访问，再恢复后台清理。

## 运维命令与顺序

维护入口是 `node --experimental-strip-types services/loom-engine/flow/video-journal-cli.ts`。运行环境需 Node 22+；`replay` 还需 Loom 的现有 `pg` 依赖与数据库连接。

1. **仅首次空卷配置**：把独立卷挂到 `/var/lib/flow-deletion-journal` 等父目录，设置 `VIDEO_DELETION_JOURNAL_DIR=/var/lib/flow-deletion-journal/journal` 为尚不存在的子目录，再设置密钥并执行 `... init`；不能把 DIR 设成 Docker 已创建的挂载根目录。命令生成新的不可预测 journal ID，输出 ID（不输出密钥）；运维把 ID 固定到配置，再启动视频功能。应用启动绝不执行 init。
2. `... checkpoint FILE` 输出认证高水位；`... verify FILE` 要求当前独立日志至少包含该 checkpoint 的完整链。checkpoint 只含非内容元数据，不是日志备份。
3. `backup.sh` 在发现视频来源/资产或绑定身份时自动要求日志；对象备份需要明确 `BACKUP_VIDEO_JOURNAL_REQUIRED=true`，视频 Compose 应传入此配置。数据库/对象快照各保存 `*.video-journal.json`，备份完成再次获取最新水位，日志卷本身不复制。
4. **恢复前停所有视频服务、worker、日志客户端**，确认目标数据库为空，设置 `VIDEO_JOURNAL_OFFLINE_ACK=ALL_JOURNAL_CLIENTS_STOPPED`。执行 `video-restore.sh DUMP DATABASE_URL OBJECT_SNAPSHOT MC_ALIAS`：验证两个 checkpoint → 恢复对象 → 恢复数据库 → 迁移及重放最新独立日志。禁止先完成删除清理，再覆盖旧对象快照。
5. 单独 `restore.sh` 或 `objects-restore.sh` 仅恢复快照，明确输出视频仍隔离，不表示恢复屏障完成。旧视频快照缺少 checkpoint 必须隔离，不能初始化新日志后放行。
6. `... replay CHECKPOINT` 仅报告本地访问屏障已重放；仍需启动受控 cleanup / Outbox 派发并核验对象删除、执行层擦除、宿主副本/缓存/Skill 失效收据。脚本明确 `complete_erasure:false`，不伪报物理或跨服务删除已完成。

原 PostgreSQL Alpine / MinIO client 备份镜像没有 Node。它们**不能假装已验证视频日志**；必须使用包含 Node 与同一维护代码的备份运行环境。缺少运行时或日志访问权限会使视频备份失败，不能记录成功。`VIDEO_JOURNAL_CLI` 可设置维护脚本绝对路径，`VIDEO_JOURNAL_NODE` 可选择 Node 可执行文件；不得以任意成功脚本代替验证。

专用 `deploy/flow/backup/Dockerfile.video` 提供 Node 22、PG17、mc、完整 Loom flow/src/scripts 与 lockfile 固定的生产依赖，支持实际 `video-restore.sh` 的重放路径，不只是 checkpoint。构建必须显式提供已核验 digest 的 `NODE_IMAGE`、`POSTGRES_IMAGE`、`MC_IMAGE`；缺少或未 pin 的参数不接受。`video-build-manifest.json` 记录合同和未执行构建的事实，镜像构建时生成 `/usr/local/share/video-backup/build-evidence.txt`（基础镜像引用、二进制/lockfile hash、工具和系统包版本）。本次未把未运行的 Docker build 写成通过。

备份容器使用只读日志挂载：CLI checkpoint/verify 不创建锁，而要求当前没有写锁、完整链通过验证，且再次读取的认证 HEAD 不变；遇到并发写或不确定状态则失败，不推断成功。离线 replay/recover 必须显式使用同一卷的读写挂载。视频 overlay 使用专用镜像，基线非视频备份镜像不受影响。

## 不确定状态和明确限制

- 锁不会按超时自动抢占。进程崩溃留下锁时，正常请求返回 `video_journal_locked_or_outcome_unknown`。确认所有客户端停止后，运维可执行 `... recover-offline`。它只把完整、认证、连续的孤立记录推进到 HEAD，并删除已验证冗余的临时 HEAD；不会丢弃任何记录。损坏记录/HEAD、缺失历史不可自动“修好”。
- 丢失日志卷、密钥或不能证明日志为**最新**时，保持视频隔离，找回完整独立日志及原密钥。不能用旧日志快照、重新 init、删除 receipt/身份表、改 ID 或跳过验证解锁。没有恢复已确认删除历史的证据，就不能宣称恢复成功。
- 同时控制 HMAC 密钥、日志写权限和数据库/备份元数据的运维是信任边界；这不是防恶意管理员的外部公证系统。文件系统必须保证本地原子 rename、独占 mkdir 与真实 fsync，未验证这些语义的网络文件系统不在合同内。独立持久卷的存储失效保障由部署负责。
- 当前上限 100,000 条非内容事件，每次屏障验证完整链，空间和运行量有硬上界；不会自动截断或 compact。达到上限即拒绝新删除确认，需制定保持完整认证历史的运维迁移方案后扩容。不能删旧记录腾空间。

## 验证范围

`node --experimental-strip-types --test flow/video-journal.test.ts` 覆盖真实多 Node 进程并发追加/幂等、HMAC/范围篡改、失踪/截断/滞后水位、崩溃锁、受限离线恢复、同 ID/密钥空日志重置拒绝、数据库事务回滚及旧快照重放后的读/索引/Skill 失效。测试只用临时合成数据。

`flow/video-qa.test.ts` 的 `FLOW_VIDEO_RESTORE_TEST=1` 用实际 PostgreSQL 的备份/恢复脚本与真实协调器路径检验备份后确认擦除、旧数据确实恢复、日志缺失时 HTTP 503、重放后文档/证据/知识/Skill 不复活及恢复对象的删除收据。生产部署、真实平台内容与长期试点不由这些测试证明。
