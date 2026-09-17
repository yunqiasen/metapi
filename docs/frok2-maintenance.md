# Frok2 维护手册

## 唯一入口

| 项目 | 位置 / 规则 |
| --- | --- |
| 源码 | `/home/div/1_Project_dir/Project/metapi`，日常使用 `Frok2` |
| `main` | 纯上游；本次保留 `41767a6`，没有顺带升级 |
| 原样保护点 | `frok2-baseline-20260917` → `f463dc7`，保存 9 月 16 日正在运行的完整修复 |
| 旧 Fork | 删除工作分支；历史提交只由 `archive/Metapi-fork-20260917` 标签保留 |
| 正式服务 | `metapi-main`；Compose project `metapi-main-deploy`；端口 `4010` |
| 页面 | <http://100.126.43.55:4010/accounts> |
| 运行配置 | `/home/div/.config/metapi`，独立于代码分支 |
| 正式数据 | `/home/div/1_Project_dir/Project/metapi-main-deploy-data`，沿用原库 |
| 备份 | `/home/div/1_Project_dir/Project/metapi-backups` |

`metapi-main-deploy-data` 只是数据库目录，不是另一份项目。`main` 与 `Frok2` 的差异由 Git 管理，不再复制多份源码。

## 看版本

```bash
/home/div/.local/bin/metapictl status
git -C /home/div/1_Project_dir/Project/metapi status --short --branch
```

`status` 分开显示源码分支/提交、实际镜像、已发布提交、健康状态和数据路径。`sourceMatchesRelease=false` 表示当前检出的源码与正式版本不同，**不代表运行服务已经切换**。生产镜像按不可变 image ID 启动。

## 修改和发布

1. 切到 `Frok2`，先确认工作区已有修改属于本轮；不要直接清空差异。
2. 小步修改，测试通过后更新对应文档，再按用户要求提交。配置、Cookie、数据库与密钥留在 Git 之外。
3. 校验已提交版本并构建：

```bash
cd /home/div/1_Project_dir/Project/metapi
DOTENV_CONFIG_PATH=/dev/null npx vitest run --root . --maxWorkers 2 --minWorkers 1 --exclude 'data/**' --exclude 'dist.rollback-*/**'
DOTENV_CONFIG_PATH=/dev/null npm run typecheck
npm run repo:drift-check
npm run docs:build
/home/div/1_Project_dir/Project/metapi/scripts/deploy/build-main-repairs.sh
```

锁文件发生变化时，先在该目录执行 `npm ci`。构建要求干净的 Git 提交，使用临时 `git archive`，逐文件核对提交来源，退出时清理临时目录；不再生成整份 dist 备份。镜像使用真实 commit 和源码指纹命名，运行前检查产物哈希及无浏览器依赖。

4. 检查新镜像及 manifest，推送已验证提交；仅在确实准备发布时执行：

```bash
/home/div/.local/bin/metapictl deploy "$(cat /home/div/1_Project_dir/Project/metapi/.main-repairs-image)"
/home/div/.local/bin/metapictl status
```

发布先核对当前容器与记录、验证目标镜像，再在线备份最新 SQLite 和配置，随后短暂重建同一个服务。健康检查失败时恢复上一镜像，保留最新数据库。数据库代码/schema 指纹有变化时先做单独迁移方案，避免把不兼容版本直接切到现用库。

5. 检查本机及 Tailscale 页面、账号/令牌数量、凭证和代理配置；验证后打固定发布标签。切换目录不是签到测试，不为验收目录迁移而触发第三方重登录。

不要用仓库根目录的上游 compose、旧备份 compose、浮动 `latest` 标签替代正式入口。切换分支本身也不是部署操作。

## 回滚代码

```bash
/home/div/.local/bin/metapictl rollback
/home/div/.local/bin/metapictl status
```

这只切换到记录中的上一可用镜像，并在操作前再次备份；**不会拿旧库覆盖现用库**。若需回到更早标签：在工作区干净后检出该标签，按该版本的构建流程重新构建并显式发布；先确认数据库兼容性。历史基线标签保留当时的构建脚本，应只用于追溯或在复核构建方法后使用，不直接运行历史目录里的部署命令。

## 更新上游

本次迁移不更新上游，避免把版本整理和业务升级混在一起。以后单独维护：

```bash
cd /home/div/1_Project_dir/Project/metapi
git status --short
git fetch upstream
git switch main
git merge --ff-only upstream/main
git push origin main
git switch Frok2
# 审阅差异，再按当次批准方案合并并完整验收。
```

只更新源码不会重启正式容器。不要 force-push `main`，不要将旧 Fork 合并进 `Frok2`，不要用 `reset --hard` 处理尚未保存的工作。

## 备份、导出和保留量

```bash
/home/div/.local/bin/metapictl backup daily
/home/div/.local/bin/metapictl export /绝对路径/备份.metapi /一个尚未存在的目录
```

- SQLite 使用在线 backup API，再做完整性校验；同包保存 `app.env`、compose 和发布记录。
- 备份使用 AES-256-GCM 认证加密；导出到新目录，校验数据库，不直接写回生产。
- 每天 04:15 的 user systemd timer `metapi-backup.timer` 备份一次；保留最近 **7 份日备份**。
- 发布前备份保留最近 **2 份**；只有新备份校验成功后才淘汰旧份。
- 镜像只保留当前和上一可回滚版本；清理时逐个检查引用，不做全局 Docker prune。
- 本次迁移的 Git bundle、未提交差异、旧配置与历史证据汇成 **1 份加密迁移归档**，不参与日常轮转。
- 解密密钥是 `/home/div/.config/metapi/backup.key`，单独保管离机副本；密钥丢失会导致备份不可恢复。它与备份都只在本机不等于具备异地灾备。
- `.metapi` 由 `metapictl export` 导出。迁移归档的 `.tar.gz.aesgcm` 使用同一脚本的 `unseal()` 解密为压缩包，再在空目录检查；全过程保留原加密文件。

检查定时备份：

```bash
systemctl --user list-timers metapi-backup.timer
journalctl --user -u metapi-backup.service -n 20 --no-pager
```

## 配置与工具维护

`/home/div/.config/metapi` 中：

- `app.env`：现用环境变量和加密密钥。保持权限 600，原值保留。
- `config.json`：绝对源码、数据、备份路径。
- `compose.yml`：固定端口、容器和数据挂载模板。
- `release.json`：当前及上一镜像的不可变 ID、commit、源码/schema 指纹。
- `metapictl.mjs`：从已验证的 `Frok2` 安装的运维工具；分支切换不替换它。
- `backup.key`：32 字节备份加密密钥，权限 600，升级工具时保留。

运维工具更新属于单独维护操作：测试对应 `/home/div/1_Project_dir/Project/metapi/scripts/deploy` 的改动后，再同步脚本/compose 模板到上述配置目录。不要覆盖 `app.env`、`backup.key`、`config.json` 或 `release.json`。发生进程中断时，先查看 `release.pending.json`、实际容器和 `operation.lock` 里的 PID，再决定恢复操作，避免盲目重复发布。
