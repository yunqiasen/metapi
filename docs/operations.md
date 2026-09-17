# 🔧 运维手册

[返回文档中心](./README.md)

---

## 数据备份

### 方式一：目录备份（SQLite / Desktop，推荐）

如果当前运行的是 SQLite，最简单的备份方式是直接备份数据目录：

- Docker / 本地开发：仓库内的 `data/`
- Desktop：应用用户数据目录下的 `data/` 子目录

```bash
# 手动备份
cp -r data/ data-backup-$(date +%Y%m%d)/

# 自动备份（crontab）
0 2 * * * cp -r /path/to/metapi/data/ /path/to/backups/metapi-$(date +\%Y\%m\%d)/
```

建议：
- 每日自动备份一次
- 保留最近 7~30 天
- Desktop 备份前先退出应用
- 如果当前运行库已切到 MySQL / Postgres，不能只备份 `data/`
- 备份文件不要提交到 Git

### 方式二：数据库原生备份（MySQL / PostgreSQL）

如果当前运行库已经切到 MySQL / Postgres，请使用数据库自己的备份工具或云快照。

**MySQL 备份示例：**

```bash
# 全量导出（替换为你的实际连接信息）
mysqldump -h <HOST> -u <USER> -p<PASSWORD> metapi > metapi-backup-$(date +%Y%m%d).sql

# 自动备份（crontab，每天凌晨 3 点）
0 3 * * * mysqldump -h <HOST> -u <USER> -p<PASSWORD> metapi | gzip > /path/to/backups/metapi-$(date +\%Y\%m\%d).sql.gz
```

**PostgreSQL 备份示例：**

```bash
# 全量导出
pg_dump -h <HOST> -U <USER> -d metapi -F c -f metapi-backup-$(date +%Y%m%d).dump

# 自动备份（crontab，每天凌晨 3 点，使用 .pgpass 免交互密码）
0 3 * * * pg_dump -h <HOST> -U <USER> -d metapi -F c -f /path/to/backups/metapi-$(date +\%Y\%m\%d).dump
```

**云托管数据库：** RDS、PlanetScale、Neon 等可直接使用平台的自动快照功能。

建议：
- 升级、迁移、执行「重新初始化系统」前先做一次库级备份
- 备份对象是当前 metapi 正在使用的运行库，而不只是本地 `data/`
- 恢复后重启 Metapi 一次，确认它重新连接到了正确的运行库
- 建议保留最近 7~30 天的备份，定期清理过期文件

### 方式三：应用内导出

在管理后台 → 「导入/导出」页面：

- **全量导出**：站点、账号、Token、路由、设置
- **仅账号**：站点和账号信息
- **仅偏好**：设置和通知配置

导出为 JSON 文件，可用于跨实例迁移。

## 数据恢复

### 目录恢复（SQLite / Desktop）

服务端 SQLite 可按下面流程恢复；Desktop 则先退出应用，再替换应用用户数据目录下的 `data/` 后重新启动。

```bash
# 1. 停止容器
docker compose down

# 2. 替换数据目录
rm -rf data/
cp -r data-backup-20260228/ data/

# 3. 重新启动
docker compose up -d
```

### 应用内导入

在管理后台 → 「导入/导出」页面上传之前导出的 JSON 文件。系统会自动校验数据完整性。

### 数据库恢复（MySQL / PostgreSQL）

如果当前运行库是 MySQL / Postgres，请先用数据库自己的恢复流程把备份恢复到目标库，再重启 Metapi。若实例保存过运行库配置，重启后仍会优先连接该外部库，而不是自动回退到本地 SQLite。

## 日志排查

### Docker 环境

```bash
# 查看实时日志
docker compose logs -f

# 查看最近 100 行
docker compose logs --tail 100

# 只看错误
docker compose logs -f 2>&1 | grep -i error
```

### 本地开发

```bash
npm run dev
# 日志直接输出到终端
```

### Desktop

- 优先使用托盘菜单的 `Open Logs Folder`
- Desktop 内置后端的数据目录和日志目录都位于应用用户数据目录下

### 重点关注的日志

| 关键词 | 含义 | 处理方式 |
|--------|------|----------|
| `auth failed` | 上游站点鉴权失败 | 检查账号凭证是否过期，系统会自动尝试重登录 |
| `no available channel` | 路由无可用通道 | 检查 Token 是否同步、通道是否被冷却；可在路由页查看冷却状态 |
| `channel cooling` | 通道进入冷却期 | 通道在请求失败后自动冷却 10 分钟，期间不会被路由选中；无需干预，会自动恢复 |
| `upstream 429` | 上游限流 | 该上游站点触发了速率限制；路由引擎会自动切换其他通道，冷却期后重试 |
| `upstream 5xx` | 上游服务器错误 | 上游站点临时不可用，路由引擎会自动故障转移到其他通道 |
| `notify failed` | 通知发送失败 | 检查 [通知渠道配置](./configuration.md#通知渠道) |
| `checkin failed` | 签到失败 | 检查账号状态和站点连通性 |
| `balance refresh failed` | 余额刷新失败 | 检查账号凭证，可能需要重新登录 |
| `proxy timeout` | 代理请求超时 | 上游响应过慢；检查网络延迟或考虑切换其他通道 |
| `token expired` | Token 过期 | 系统会自动尝试续签；若反复出现，手动刷新 Token |
| `登录接口返回非 JSON 响应` | 站点返回了 HTML/403 等非业务 JSON | 先按实际 HTTP 状态检查站点入口、代理和上游防护；只有明确识别到挑战页时才会显示 shieldBlocked |
| `Token verification timed out` | Session 验证链路或代理出口耗尽验证时限 | Session 模式会跳过 API Key 的 `/v1/models` 探测；先检查站点专用代理出口，再核对平台用户 ID |
| `AgentRouter 已执行签到校验，额度无新增` | AgentRouter 登录态有效，但本次未观察到余额增长 | 结果记为 skipped，不再显示签到成功；检查 AgentRouter 专用代理线路，必要时重新取得 Session |
| `github/linuxdo 登录态已失效，请重新在浏览器登录后更新 Cookie` | AgentRouter 签到重登录所用的第三方 Cookie 已过期 | 在浏览器重新登录对应第三方站点，F12 复制整段 Cookie，到账号编辑弹窗更新「签到重登录」配置 |

### AgentRouter 签到（重登录触发）

AgentRouter 没有独立的签到接口，签到奖励只在**真实重新登录**时由服务端随新 Session 下发。
在账号编辑弹窗配置「签到重登录方式」（GitHub 或 LinuxDO）并粘贴对应第三方站点的 Cookie 后：

1. 签到时系统自动完成一次 OAuth 重新登录（`/api/oauth/state` → 第三方 authorize → `/api/oauth/{provider}` 回调）。
2. 回调拿到新 Session 后校验账号身份（`platformUserId` 必须一致，不一致直接丢弃新凭证）。
3. 只有签到前后额度真实增加才记为成功并显示奖励（如 `25`）；额度未变记为 skipped。
4. 新 Session 会自动替换旧凭证并刷新 API Token，无需手动重绑。

未配置第三方 Cookie 时，签到退化为用户信息探活，不会触发真实签到奖励。

## 健康检查

### 手动检查

```bash
# 检查服务是否响应
curl -sS http://localhost:4000/v1/models \
  -H "Authorization: Bearer <PROXY_TOKEN>" | head -5

# 检查特定模型可用性
curl -sS http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer <PROXY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'
```

以上示例默认服务端部署监听 `localhost:4000`。Desktop 内置后端默认监听 `0.0.0.0:4000`；本机排查通常可直接使用 `127.0.0.1:4000`，如果显式设置了 `METAPI_DESKTOP_SERVER_PORT`，则按日志里的实际端口访问；局域网排查改用当前机器的实际 IP。

### 自动化监控建议

- 定时请求 `/v1/models`，检查返回状态码和模型数量
- 定时抽样请求 `/v1/chat/completions`，检查端到端可用性
- SQLite / Desktop：监控磁盘空间（SQLite WAL 日志可能增长）
- MySQL / Postgres：监控外部数据库空间、连接数和慢查询
- 监控 Docker 容器状态

## 常见运维操作

### 清理代理日志

代理日志会持续增长。如果磁盘空间紧张，可在管理后台 → 代理日志页面清理历史记录。

### 重置账号状态

如果账号状态异常（`unhealthy`），可以在账号管理页面：

1. 点击「刷新」重新检测账号健康状态
2. 如凭证过期，系统会尝试自动重登录
3. 手动禁用/启用账号

### 强制刷新模型

在管理后台手动触发：

- 余额刷新：立即更新所有账号余额
- 模型刷新：重新发现所有上游模型
- 签到：立即执行一次签到

### 系统代理

在管理后台「设置 → 系统代理」中保存全局代理地址后，只有启用了「使用系统代理」的站点才会走这条出站代理。

- 单个站点可在站点页直接开关
- 站点页支持批量开启 / 关闭系统代理
- 修改系统代理地址后，Metapi 会自动失效站点代理缓存，通常无需手工重启

### 清理缓存并重建路由

当模型列表（`GET /v1/models`）、路由列表或选择概率明显滞后时，使用以下操作：

| 操作 | 位置 | 适用场景 |
|------|------|----------|
| **清除缓存并重建路由** | 设置 → 清除缓存并重建路由 | 全局刷新：清空模型发现缓存、自动路由和自动通道，后台触发模型刷新与路由重建 |
| **重建路由** | TokenRoutes → 重建路由 | 局部刷新：调整账号、Token、路由规则后手动重新生成自动路由 |

优先使用「重建路由」做局部刷新，问题持续时再用全局清除。

### 批量操作

管理后台支持以下批量运维动作：

- 站点：批量启用、禁用、删除、开启系统代理、关闭系统代理
- 账号：批量刷新余额、启用、禁用、删除
- Token：批量启用、禁用、删除

批量操作完成后，界面会返回成功/失败数量；删除站点或账号后，路由相关缓存会自动失效。

### 重新初始化系统

这是高风险操作，位于「设置 → 危险操作」。

- 会清空当前 metapi 正在使用的全部业务数据
- 如果当前运行在外部 MySQL / Postgres，会先清空该外部库中的 metapi 数据，再切回默认 SQLite
- 管理员 Token 会重置为 `change-me-admin-token`
- 当前登录会话会立即退出，页面刷新后回到首装状态

执行前建议先做一次导出或数据库备份。

## 下一步

- [常见问题](./faq.md) — 常见报错与修复
- [配置说明](./configuration.md) — 环境变量详解
- [上游接入](./upstream-integration.md) — 平台特定的连接与排障
- [客户端接入](./client-integration.md) — 下游客户端对接

## main 修订版恢复与部署来源

4010 当前操作见 [Frok2 维护手册](./frok2-maintenance.md)。源码只有 `/home/div/1_Project_dir/Project/metapi` 一个目录；配置与数据独立于 Git 分支。

以下为按日期保留的历史验收记录，旧目录、镜像及临时线路不是当前操作入口；旧备份材料集中保存在迁移加密归档。恢复经过见 [历史恢复记录](./main-repairs-restoration.md)。


### Any 协议签到回归（2026-09-09）

- 正式来源仍为 `metapi-main-deploy` 的 main 修订版；旧 Fork、浏览器依赖和共享代理自动切换不参与部署。
- 修复普通签到接口回退、导入旧防护 Cookie 覆盖、缺少权威额度落库的问题。专用流程及限制见 [特殊站点说明](./site-auth-special-sites.md#anyrouter-anyroutertop)。
- 实站读取曾出现阿里云 ESA `Denied by http_ratelimit`；冷却期间停止重试，先检查对应线路状态，不批量重绑凭证、不把全部 403 归为 CF。
- 回归测试 `anyrouter.checkin.test.ts` 覆盖 Session 保留、线路预热、真实总额度、零增长、重复签到、用户身份、限流、HTML 错误及单次 POST。`checkinService.confirmedQuota.test.ts` 验证界面读取所需的额度落库。
- 本次上线前备份：`/home/div/1_Project_dir/Project/metapi-any-repair-backup-20260909-121312`；其中正式数据库及部署元数据含私密信息，仅保留本地。

- 出口对照：同账号经 `172.17.0.1:41001` 返回 ESA 限流，经既有 `172.17.0.1:7890` 正常；仅 Any 站点（ID 9）使用后者，其他站点和共享代理节点保持原值。该出口由既有 `proxy-forward.service` 转发至 Windows 7890，依赖对应 Windows 代理可用。
- 正式 UI 首轮验收：账号 113、114 各实际新增 25，113 页面余额 850 → 875、显示 +25，数据库读取确认为 875；111、115、119、120、121、122 完成协议请求但额度零增长，记录 skipped/+0，未冒充新增奖励。
- 首轮另发现账号 109 缺用户 ID（原 Session 对应 200029，站点返回同名用户）；补充结构化 Session ID 恢复与显式 ID 冲突保护回归。账号 123 的原配置 208036 与同一 Session 经站点验证的 ID 208037 不符，保留身份匹配校验，不自动切换账号。

- 最终验收（同日）：补丁镜像 `metapi:main-repairs-41767a6-20260909-134009-06b8112655ef`。账号 109 未填写 ID，靠原 Session 的结构化 ID 恢复并通过正式 UI 签到，总额度 1675 → 1700，实际 +25。
- 账号 123：先以原 Session 核实 `/api/user/self` 的实际 ID 为 208037，再单独将错误配置 208036 更正；账号别名和全部凭证保持。通过正式 UI 签到，请求完成、总额度 1350 无新增，记 skipped/+0。
- 10 个 Any 账号逐个 UI 操作的最终最新记录为 3 success / 7 skipped / 0 failed；本次真实新增合计 75。7 个零增长账号只证明协议请求完成，不宣称本次新发奖或据此推断站点签到日期。页面重载后账号 113 保持余额 875 / +25，数据库额度与 UI 响应一致。
- 全量 467 测试文件通过、1 跳过；2654 项通过、8 跳过；typecheck、build、docs:build 和来源/产物 guard 通过，drift 0 新违规（5 条既有债务）。正式进程仅 init + Node。
- 最终证据：备份目录内 `any-acceptance-final.json`、`ui-checkin-results-initial.json`、`ui-checkin-results-final.json`、`any-113-ui-result.png`、`any-final-ui.png`；最终切换前数据库为 `production-before-final.sqlite`，保留此前修复版本用于回滚镜像，但不得用旧库覆盖最新数据。


### Any / Agent 重复签到稳定性补修（2026-09-09）

- 之前单轮验收不代表后续稳定：14:02 的正式日志再次出现 Any 单账号 25 秒超时、另一账号 502；复测又能约 0.5–1.1 秒返回零增长。重复操作还出现 ESA 限流，继续遵循冷却，不切共享节点。
- Agent 原“GitHub 登录态失效”经实站对照证实是误判：GitHub 返回 302 `/oauth/github`，旧逻辑只识别 `/api/oauth/github`，把前端回调当成登录页；同时漏传 OAuth state 会话 Cookie。补修精确回调映射、state 和身份验证、Cookie 域名隔离。
- 修复内容：Any 分阶段请求期限、只读有限重试、写入后结果补查；Agent 缩减为严格用户信息快照，去除同步 API Key 探测，保留已有凭证与别名；同账号进行中任务去重。缺重登录配置立即返回提示，不借查余额冒充签到。
- 本轮备份路径见 `/tmp/metapi-stability-backup-path`；红测、UI 耗时和数据库快照保留其中，凭证不写入诊断输出。

- 补充实站发现：旧 Agent 原始凭证为裸 Session；前快照漏包 `session=` 导致首次重登录后奖励待确认。已复用凭证导入的 Cookie 规范化并添加红绿回归；首次重登录已成功刷新本站 Session，不把未取得前快照的增长记为本次奖励。
- 上游正常 SPA 页面包含 `<script>`，旧检测也误标为挑战页；已移除通用 script 标签判断，只保留防护特征，补普通页面回归。
- 14:39–14:47 线路对照：Any 的 Windows 转发 7890 持续返回 ESA 限流；原独立 `clash_1` 的 41001 能读取同一账号真实额度。仅 Any 站点的显式代理恢复为 `http://172.17.0.1:41001`，未修改 Mihomo 节点、其他站点或第三方 Cookie。此处取代上文 13 点验收时的 7890 临时配置，不保证外站永不出现限流。

- 最终 Agent 路由定位：`clash_1` 有独立 `🎯AgentRouter` selector，原固定美国01。该出口 `/api/user/self` 间歇返回含 `aliyun_waf_aa` / `aliyunCaptcha` 的 HTTP 200 滑块页；7890 对照也超时。只将 `🎯AgentRouter` 选择固定到已验证的美国03，全局/AI/Any 等其他手动 selector 未改；URLTest 自动测速组仍会自行择优变化。已有 `profile.store-selected: true`，选择由 Mihomo 持久化；未改其他项目源码或代理配置文件。选择前后证据为备份目录的 `proxy-selections-before.json` / `proxy-selections-after.json`。
- 最终镜像：`metapi:main-repairs-41767a6-20260909-145750-a9443a4c5e1d`。全量 467 文件通过 / 1 跳过，2668 项通过 / 8 跳过；typecheck、build、docs、drift 和正式容器来源校验通过。
- 最终 UI 验收：Any 10 个账号逐个点击均正常返回无新增/+0，1.3–3.9 秒；另外 8 次重复点击正常。Agent G2 在专用出口修正后连续两次 OAuth 重登录正常，5.9 秒与 5.0 秒，零增长/+0，新 Session 保存，账号别名和 API Key 保持。G3 未配置对应第三方 Cookie，16 毫秒返回配置提示；没有声称它已签到。
- 最新 12 条目标账号记录无 failed（G3 是缺配置 skipped，并非签到完成）。保留所有用户凭证；仅 G2 的本站 Session 因真实重新登录更新。15 站点 / 25 账号 / 27 令牌 / 15 路由 / 150 通道 / 2 设置保持。UI 响应与耗时在 `ui-final.json`，最终 DB 摘要在 `final-account-results.json`。验收代表这些实际请求的结果，不承诺外站永不限流或免验证。

### 2026-09-13 签到修复验收

正式源码仍为 `metapi-main-deploy` 的 main-repairs 分支，保留全部既有修改，无浏览器运行组件。

- 回归：468 文件通过、1 跳过；2674 项通过、8 跳过；typecheck 通过；drift 0 新违规、5 既有债务。
- 新增真实 HTTP 回归覆盖 NewAPI 三条签到路径的 quota_awarded 转换，以及 Session 导入保存真实上游 ID。
- Agent 回归覆盖 HTTP 200 阿里云滑块 HTML：保留旧凭证、零虚构奖励、明确待确认。
- 备份：`/home/div/1_Project_dir/Project/metapi-checkin-repair-backup-20260913-201509`，包含在线数据库备份与修改前差异。禁止以备份覆盖后续正式数据。
- 网络错误和签到历史独立：早间成功不抹掉晚间真实请求错误，修复线路后通过当前请求刷新运行健康。

部署后实测（北京时间 2026-09-13 20:36–20:42）：

- 镜像：`metapi:main-repairs-41767a6-20260913-203357-88ac12ad9e7a`；运行产物 guard 通过，4010 本机及 Tailscale health 均正常。
- 哈基米 UI 所调用的签到接口：7 个账号全部返回“今日已签到”，约 2.5–3.5 秒，无新奖励重复入账。账号概览接口逐个返回真实奖励，总计 70.130472，当前健康为 healthy。
- Agent 117：正式签到接口 3.5 秒完成重登录，`credentialsRefreshed=true`、`status=skipped`、`reward=0`，身份与额度验证通过；124 仍缺第三方 Cookie，立即 skipped。
- “刷新运行健康”还会检查模型发现；既有模型发现超时/空列表与此次签到、余额结果不同，不代表推理可用性已完成验收。
- 后续 Any 线路复测确认 41001 仍 fetch failed、7890 正常；因此也将 Any 站点代理调整到 7890。未修改 Any 签到算法、Mihomo 选择器或浏览器环境。
- 本轮未执行浏览器页面渲染验收；已核对正式 UI 调用的 API 和账号概览数据。
