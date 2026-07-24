# Agent Layer 双渠道同步与零中断发布

本仓库把 `main` 作为 Agent Layer 的唯一来源，并把 Agent 依赖闭包自动同步到
`feat/wechat-channel`。同步 PR 合并本身不应触发 Production 部署；Production
只能由 `Agent Layer Release` workflow 发布。

## 1. 本地命令

```bash
# 比较两个远端分支的 Agent tree
pnpm agent:sync:check -- --source origin/main --target origin/feat/wechat-channel

# 仅允许在 automation/agent-sync-main-to-wechat 分支执行
pnpm agent:sync:apply -- --source origin/main

# 校验同步状态文件、Agent tree 和 migration hash
pnpm agent:release:verify -- --source origin/main --target origin/feat/wechat-channel

# 检查所有已登记 migration；新 migration 只能做向前兼容扩展
pnpm agent:migrations:check -- --all
```

`agent:sync:apply` 会同步新增、修改和删除，生成
`.agent-sync/agent-sync-state.json`，但不会提交或推送。工作区不干净或当前分支
不正确时会直接失败。

## 2. GitHub Environments

创建 `staging` 和 `production` 两个 GitHub Environment。两个环境使用相同的变量
名称，但值必须指向完全隔离的资源。

### Variables

| 名称 | 含义 |
| --- | --- |
| `RAILWAY_PROJECT_ID` | 对应环境的 Railway Project ID |
| `RAILWAY_ENVIRONMENT_ID` | Railway Environment ID |
| `RAILWAY_INTELLIGENCE_SERVICE` | Intelligence worker service 名称或 ID |
| `RAILWAY_WEB_API_SERVICE` | Web API service 名称或 ID |
| `RAILWAY_WECHAT_API_SERVICE` | WeChat API service 名称或 ID |
| `RAILWAY_WECHAT_WORKER_SERVICE` | WeChat iLink worker service 名称或 ID |
| `WEB_API_URL` | Web API base URL |
| `WECHAT_API_URL` | WeChat API base URL |
| `WEB_API_READY_URL` | Web API 完整 `/ready` URL |
| `WECHAT_API_READY_URL` | WeChat API 完整 `/ready` URL |
| `SUPABASE_URL` | 对应环境 Supabase URL |

Production 还必须设置：

| 名称 | 要求 |
| --- | --- |
| `PRODUCTION_AUTODEPLOY_DISABLED` | 完成第 4 节配置后设为 `true` |
| `PRODUCTION_ZERO_DOWNTIME_CONFIGURED` | 完成 overlap/draining 配置后设为 `true` |
| `PRODUCTION_BACKUP_OR_PITR_ENABLED` | Supabase 已有可恢复备份或 PITR 时设为 `true` |

### Secrets

| 名称 | 含义 |
| --- | --- |
| `RAILWAY_TOKEN` | 对应 Project/Environment 的 Railway token |
| `SUPABASE_DB_URL` | percent-encoded Postgres 连接 URL |
| `SUPABASE_PUBLISHABLE_KEY` | 仅用于创建 smoke Auth 用户 |
| `SUPABASE_SERVICE_ROLE_KEY` | 仅由 workflow 和服务端持有，用于清理 smoke 用户 |
| `TOMEET_INTERNAL_API_TOKEN` | Web API 与 WeChat API 必须使用同一个内部 token |

Staging 和 Production 的 Supabase URL、key、数据库密码不得交叉使用。两个环境需启用
匿名 Auth 登录，smoke 会创建两个独立临时用户并在结束时删除。

### Repository secret

`Agent Layer Sync` 创建同步 PR 时必须使用仓库级 Actions secret
`AGENT_SYNC_PR_TOKEN`。不要把它放进 `staging` 或 `production` Environment，
因为同步 workflow 不应获得任何部署凭据。

推荐创建只授权 `toMeetADX/TOMEET_Backend` 的 fine-grained personal access token：

- Repository permission `Pull requests`: `Read and write`
- Repository permission `Contents`: `Read-only`
- 设置合理的过期时间，并在到期前轮换仓库 secret

同步分支仍由受限的 `GITHUB_TOKEN` 推送；专用 token 只用于查询、创建或更新
`automation/agent-sync-main-to-wechat -> feat/wechat-channel` PR。若 secret 缺失、
失效或无权创建 PR，workflow 会在修改自动化分支前失败关闭，并输出明确错误。

## 3. Railway 服务配置

三个配置文件已使用 `/ready` 作为部署健康检查，超时为 120 秒。Railway 只有在
新 deployment 的 `/ready` 返回 200 后才会切换流量。

在 Railway 为每个环境设置：

| Service | `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` |
| --- | ---: | ---: |
| Web API | `30` | `90` |
| WeChat API | `30` | `90` |
| WeChat iLink worker | `30` | `90` |
| Intelligence worker | `30` | `300` |

API 和 worker 的 `/health` 只表示进程存活；`/ready` 会实时检查 Supabase。Worker
收到 `SIGTERM` 后会先停止领取新任务，再等待当前任务结束。

## 4. 禁止分支 push 直接部署 Production

在四个 Production Railway service 的 Source 设置中关闭 GitHub Autodeploy。
不要只依赖 `Wait for CI`：发布 workflow 需要按 migration、worker、双 API、channel
worker 的顺序部署，并在中途失败时回滚。

确认所有 Production service 已关闭 Autodeploy 后，才把 GitHub Production
Environment 的 `PRODUCTION_AUTODEPLOY_DISABLED` 设为 `true`。

Staging 也建议关闭 Autodeploy，由 release workflow 使用固定 commit SHA 发布，
防止测试中的代码和最终 Production 代码不一致。

## 5. 初始化回滚基线

首次启用 release workflow 前，从 Railway 当前成功 deployment 中确认 Web/Agent
对应的 `main` SHA，以及 WeChat API/worker 对应的 `feat/wechat-channel` SHA，然后
创建稳定 tag：

```bash
git tag prod-web-stable <当前 Web API/Intelligence Worker 的 main SHA>
git tag prod-wechat-stable <当前 WeChat API/worker 的 WeChat SHA>
git push origin prod-web-stable prod-wechat-stable
```

两个 tag 缺失时 Production job 会失败关闭。每次成功发布后 workflow 会把旧值保存
为 `prod-web-previous`、`prod-wechat-previous`，再更新 stable tag。

## 6. Migration 规则

- 已提交 migration 不得修改，只能新增 migration。
- 新文件必须由 Supabase CLI 创建，格式为 `YYYYMMDDHHMMSS_name.sql`。
- 自动发布禁止删除表、列、约束、函数或数据，禁止 rename、列类型收缩、
  `SET NOT NULL` 和 revoke。
- 新的必填列必须先带 default 或保持 nullable。
- contraction migration 必须在确认所有旧 deployment 已退出后走独立人工流程，
  不进入 Agent 自动同步发布。
- 如果相对 `prod-web-stable` 存在 schema 变化，而
  `PRODUCTION_BACKUP_OR_PITR_ENABLED` 不是 `true`，Production 发布会停止。

## 7. 仓库保护

在 GitHub branch protection 中：

- `main` 和 `feat/wechat-channel` 禁止直接 push；
- 两个分支均要求 `Agent Layer Sync / validate-pr`；
- `feat/wechat-channel` 额外要求 Agent tree parity；
- 同步 PR 仍需人工审核，不启用自动合并；
- Repository Actions secret `AGENT_SYNC_PR_TOKEN` 已按第 2 节配置；
- 默认 `GITHUB_TOKEN` 只保留同步分支所需的 `contents: write`，不用于创建 PR。

`Production Watch` 每五分钟检查四个 Railway service 的最新 deployment 状态及两个
API 的 `/ready`。异常时会复用一个打开状态的 GitHub incident issue，避免重复刷屏。
