# main 修订版恢复记录（2026-09-08）

> 历史记录：以下目录、分支和镜像描述对应当时现场。2026-09-17 起，唯一源码目录为 `/home/div/1_Project_dir/Project/metapi`，现用分支为 `Frok2`。当前操作统一见 [Frok2 维护手册](./frok2-maintenance.md)，旧命令仅供追溯。

## 恢复边界

- 构建源：`/home/div/1_Project_dir/Project/metapi-main-deploy`。
- 基线：上游 main `41767a65ec8e5470a9a70f4615b47dc24949afff`，保留 8 月底至 9 月 1 日的本地协议修复。
- 工作分支：`codex/restore-main-repairs-20260908`。本次不自动提交或推送。
- 旧 Fork：`/home/div/1_Project_dir/Project/metapi`，保留原样，不作为构建源。
- 正式入口：`http://100.126.43.55:4010/accounts`，容器 `metapi-main`。
- 数据目录：`/home/div/1_Project_dir/Project/metapi-main-deploy-data`，继续使用最新数据库，不恢复旧日期整库。

## 修复来源

| 内容 | 处理 |
| --- | --- |
| Any 登录预热、HTTP 错误分类、防护 Cookie 隔离、减少登录请求 | 保留原版修订源码 |
| AgentRouter HTTP OAuth 重登录、用户 ID 校验、额度核验、UI 配置 | 保留原版修订源码 |
| Session 模式优先验证、显式用户 ID、添加/重绑接口 | 保留原版契约，接入统一输入规范化 |
| 后来误写进 Fork 的 Cookie 输入兼容 | 仅移植输入处理；统一验证、添加、编辑、重绑与第三方 Cookie |
| 后来误写进 Fork 的保存超时修复 | 后台执行同步；补充连续编辑不丢任务及失败状态检查 |
| 浏览器 Profile、Chromium/noVNC、自动更换共享代理节点 | 不进入恢复版本 |

## 构建和防串用

```bash
/home/div/1_Project_dir/Project/metapi-main-deploy/scripts/deploy/build-main-repairs.sh
```

脚本从自身所在工作区构建，与启动命令时的 cwd 无关；旧 dist 移到独立备份，新镜像只打包新构建和生产依赖。`main-repairs-manifest.json` 记录源码快照、基线和每个产物的 SHA256。

`main-repairs-guard.mjs` 在构建与启动迁移之前检查：main 基线、无旧 Fork 祖先、协议模块、完整产物清单/哈希、无浏览器模块与依赖。compose 固定镜像并在启动前执行相同检查，误指定旧镜像时会停止启动。

## 验证

```bash
cd /home/div/1_Project_dir/Project/metapi-main-deploy
DOTENV_CONFIG_PATH=/dev/null npx vitest run --root . --maxWorkers 2 --minWorkers 1 --exclude 'data/**' --exclude 'dist.rollback-*/**'
npm run typecheck
npm run repo:drift-check
npm run docs:build
```

测试禁用本机 `.env`，避免部署凭证和 `/app/data` 路径影响隔离测试。另用最新数据库的副本在无外网的验证容器中迁移和检查 UI/API；正式库只在切换时停机做最终一致性备份。

## 备份与回滚

恢复前备份位于 `/home/div/1_Project_dir/Project/metapi-restoration-backup-20260908-111200`，包含两个源码工作区、原部署配置、镜像信息及 SQLite 在线备份。私密 JSON 和数据库只保留本地。

历史可信原版修订镜像为 `metapi:upstream-main-41767a6-clean-checkin-20260901`。当前错误 Fork 镜像和旧目录保留，恢复时不删除。回滚需先停机备份最新数据库，再选择已验证兼容的原版镜像；不要把旧日期备份覆盖到最新正式库。

## 本次交付结果

- 正式镜像：`metapi:main-repairs-41767a6-20260908-b7c369ddf27f`；源码快照 `b7c369ddf27ff9e9b1bda473a2f60bc483efeb590ef8fb54bf1b5620f49e27a1`。
- 全量测试：464 个文件通过、1 个跳过；2635 项通过、8 项跳过。类型检查、前后端/桌面构建、文档构建通过；架构检查 0 新违规（5 条既有债务）。
- 最新库在切换前后：15 站点、25 账号、27 令牌、15 路由、150 通道、1805 签到记录、2 设置；这 7 张表哈希全部一致，SQLite 完整性为 ok。
- 正式容器健康检查、Tailscale `/accounts`、账号/站点 API 均通过；页面实际显示 25 账号，无测试账号。
- 容器只有 init 和 Node，浏览器可执行文件、浏览器环境变量和旧 Fork 签到模块均不存在。
- 隔离副本页面实测：账号密码登录保存 Session/ID/加密密码，无 Profile；换行 Cookie 导入成功；模型请求延迟 4 秒时，保存 40ms 返回，后续同步完成；第三方 Cookie 和站点 Session 分开持久化；模拟签到页面显示 100→101 和 +1；代理请求返回预期文本。
- 上述签到/模型验证使用本地 fixture，不是 Any/Agent 实站发奖证明。现有过期会话保留原状态，未批量登录或修改正式凭证。
- 对比原备份，旧 Fork diff SHA256 未改变；本次没有 commit 或 push。

验证证据：备份目录里的 `preview-verification.json`、`production-before-switch.json`、`production-after-switch.json`、`production-verification.json` 与页面截图。
