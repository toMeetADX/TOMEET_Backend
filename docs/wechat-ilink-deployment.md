# TOMEET 微信 iLink 部署与配置

生产微信通道直接使用腾讯 `openclaw-weixin` 同源的 iLink HTTP 协议，不需要
Photon Spectrum、桌面微信、VNC、Docker 微信容器或完整 OpenClaw runtime。

用户登录 Web 后在 `/wechat` 页面生成五分钟有效的一次性二维码。创建二维码时携带
Supabase Bearer token，API 会把微信身份绑定到当前 `users.id`，从而与 Web 共享
conversation、消息、用户状态和 memory。未登录的匿名扫码仍兼容，但会创建或复用
独立的微信 profile，不能显示当前 Web 用户的历史。Railway 上独立的
`wechat-ilink-worker` 随后负责接收微信消息、调用 TOMEET Agent 并把文本回复
发送回微信。

## Web 与微信双侧部署总览

部署原则是“代码发布隔离、正式业务数据共享”：

```text
Web 用户
  -> Vercel Web (main)
  -> Railway Web API (main)
                              \
                               -> Supabase Production
                              /
微信用户
  -> Vercel /wechat (feat/wechat-channel)
  -> Railway WeChat API (feat/wechat-channel)
  <-> Railway WeChat iLink Worker (feat/wechat-channel)

Supabase Agent jobs
  -> Railway Intelligence Worker
```

| 部署面 | Web 端 | 微信端 |
| --- | --- | --- |
| Git 分支 | `main` | `feat/wechat-channel` |
| Vercel Project | `tomeet-web` | `tomeet-wechat` |
| Vercel Production Branch | `main` | `feat/wechat-channel` |
| Railway API | `web-api`，绑定 `main` | `wechat-api`，绑定微信分支 |
| Railway channel worker | 无 | `wechat-ilink-worker`，绑定微信分支 |
| Agent worker | `intelligence-worker` | 正式环境复用同一个 worker |
| Supabase | `tomeet-production` | 正式环境共享 `tomeet-production` |
| 建议域名 | `app.tomeet.ai`、`api.tomeet.ai` | `wechat.tomeet.ai`、`wechat-api.tomeet.ai` |

一个 Vercel Project 只选择一个 Production Branch，因此 Web 和微信必须创建两个
Vercel Project。Railway 的每个 service 也必须锁定各自的 Source Branch 和
Railway Config File。不得把微信分支部署到现有 Web service，也不得把 PR 合并到
`main` 后再部署。

### Web 生产部署

Web 端继续使用 `main`，现有 Vercel 和 Railway 服务不切换分支：

```dotenv
# Vercel tomeet-web
NEXT_PUBLIC_API_BASE_URL=https://api.tomeet.ai
```

```dotenv
# Railway web-api
DEMO_MODE=false
SUPABASE_URL=<production Supabase URL>
SUPABASE_SERVICE_ROLE_KEY=<production service role>
FRONTEND_ORIGIN=https://app.tomeet.ai
```

`web-api` 使用 `/railway.api.toml`，`intelligence-worker` 使用
`/railway.worker.toml`。Web 用户继续通过 Supabase Auth 登录并访问现有 profile、
conversation、model 和 memory。

### 微信生产部署

微信入口和通道服务始终使用 `feat/wechat-channel`：

- Vercel `tomeet-wechat` 的 Production Branch 设置为微信分支；
- Railway `wechat-api` 使用 `/railway.api.toml`；
- Railway `wechat-ilink-worker` 使用 `/railway.wechat.toml`；
- 两个 Railway service 都绑定微信分支；
- 正式上线后使用与 Web 相同的 Supabase Production；
- 微信页面只连接 `wechat-api`，不得连接 `web-api`。

```dotenv
# Vercel tomeet-wechat
NEXT_PUBLIC_API_BASE_URL=https://wechat-api.tomeet.ai
```

Web 和微信共享正式 Supabase 后会共享 users、profiles、conversation、model、
memory 和 Agent jobs，但各自仍使用独立的前端、API 域名、发布分支和部署历史。

首次微信扫码只按微信外部身份创建或复用 profile，不根据昵称、手机号或其他弱信息
猜测并合并 Web 账号。需要合并时使用受信任的管理员绑定接口。

### Staging 到 Production

上线前先建立完全隔离的微信测试环境：

| 资源 | Staging 配置 |
| --- | --- |
| Supabase | `tomeet-wechat-staging`，不含正式用户数据 |
| Railway Project | `TOMEET-WeChat-Staging` |
| Railway Services | `api`、`intelligence-worker`、`wechat-ilink-worker` |
| Vercel Project | `tomeet-wechat-staging` |
| Git 分支 | 全部使用 `feat/wechat-channel` |

Staging 必须完成真实微信扫码、消息、LLM、联网搜索和回复闭环。验收通过后：

1. 备份并按顺序向 `tomeet-production` 应用已验证的 migration；
2. 部署正式 `wechat-api` 和 `wechat-ilink-worker`；
3. 将正式微信 Railway 服务切换到 Production Supabase；
4. 部署 `tomeet-wechat`，再配置微信正式域名；
5. 先灰度少量测试微信，确认稳定后再扩大使用。

不要让 Vercel Preview 或微信 Staging Railway 使用 Production
`SUPABASE_SERVICE_ROLE_KEY`。如启用 Supabase Branching，分支实例只用于预览或
Staging；Production migration 仍需审核后发布。

参考：

- [Vercel Git 与 Production Branch](https://vercel.com/docs/git)
- [Railway Services 与 GitHub Source](https://docs.railway.com/services)
- [Supabase Branching](https://supabase.com/docs/guides/deployment/branching)

## 微信侧需要做什么

该方案不使用公众号、小程序、微信客服或微信开放平台应用，因此不需要在这些平台
注册企业或提交审核。

每位用户只需要：

1. 登录后打开 `https://<你的 Web 域名>/wechat`。
2. 点击“生成一次性二维码”。
3. 用自己的微信扫码并在手机中确认授权；若微信要求验证码，在 Web 页面输入。
4. 页面显示连接成功后，回到微信向刚连接的 Agent 发送消息。

微信仍可能触发登录保护、验证码、频率限制或上游协议调整。这些行为无法由 TOMEET
绕过，生产环境应先用少量测试账号灰度。

## 1. Supabase

先在 Staging Supabase 按顺序应用 `supabase/migrations` 并完成验收，再向
Production Supabase 应用相同 migration。微信迁移会创建：

- `wechat_connection_sessions`：一次性二维码会话；
- `wechat_ilink_connections`：每个 profile 的加密 iLink 凭证、游标与 lease；
- `channel_message_deliveries`：统一保存微信入站幂等与主动出站投递状态，不保存
  普通聊天正文；正文仍以 `messages` 为准；
- `room_event_plans`、`room_event_plan_games`、`room_event_plan_confirmations`：
  founder 协商的版本化活动清单。

这些表均启用 RLS，明确撤销 `PUBLIC`、`anon`、`authenticated` 权限，只向
`service_role` 授予所需表和 RPC 权限。应用后运行 Supabase Security Advisor，
并确认 migration test 通过。

数据库只保存二维码轮询 token 的 AES-256-GCM 密文，不保存用于页面展示的二维码
内容；页面展示值仅在创建会话的响应中返回一次。

`SUPABASE_SERVICE_ROLE_KEY` 只能配置在 Railway 服务端，不能放入 Vercel、
`NEXT_PUBLIC_*`、源码或浏览器。

Production 中 Web 和微信使用同一个 Supabase URL；Staging 必须使用独立 URL 和
独立 service role。两个环境的变量不得交叉复制。

## 2. 生成两个服务端密钥

分别运行两次，得到两个不同的随机值：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

- 第一个保存为 `WECHAT_CREDENTIAL_ENCRYPTION_KEY`；
- 第二个保存为 `TOMEET_INTERNAL_API_TOKEN`。

加密密钥必须在 API 和微信 worker 中完全相同。更换该密钥前必须先迁移现有密文，
否则已绑定账号无法解密。

## 3. Railway WeChat API service

为微信分支创建独立 API service，不修改现有 `web-api`。Source Branch 设置为
`feat/wechat-channel`，Railway Config File 使用 `/railway.api.toml`，并设置：

```dotenv
DEMO_MODE=false
SUPABASE_URL=<Supabase Project URL>
SUPABASE_SERVICE_ROLE_KEY=<server-only secret>
WECHAT_CREDENTIAL_ENCRYPTION_KEY=<步骤 2 的第一个值>
TOMEET_INTERNAL_API_TOKEN=<步骤 2 的第二个值>
FRONTEND_ORIGIN=https://<微信 Vercel 域名>
```

浏览器必须使用 API 的公开 HTTPS 域名。确认 API：

```text
GET https://<api-domain>/health  -> 200, status=ok
GET https://<api-domain>/ready   -> 200, status=ready
```

## 4. Railway intelligence worker

Staging 部署独立 intelligence worker；Production 可复用现有 worker，但它必须
与 Web 和微信 API 使用相同的 Production Supabase。配置 Supabase、LLM 和联网
搜索变量：

```dotenv
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
LLM_API_KEY=...
LLM_API_BASE_URL=...
LLM_TEXT_MODEL=...
LLM_VISION_MODEL=...
LLM_AUDIO_MODEL=...
TAVILY_API_KEY=...
TAVILY_API_BASE_URL=https://api.tavily.com
```

微信 worker 只负责通道转发；Agent、LLM 和搜索仍由该 worker 处理。

## 5. Railway WeChat worker service

从同一 GitHub 仓库新建一个 service：

- Source Branch 选择 `feat/wechat-channel`；
- 不设置子目录作为 Root Directory，共享 pnpm workspace 根目录；
- Railway Config File 选择 `/railway.wechat.toml`；
- 初期保持一个 replica；
- 不需要公开业务域名，只需 Railway 健康检查访问容器的 `/health`。

设置：

```dotenv
SUPABASE_URL=<与 API 相同>
SUPABASE_SERVICE_ROLE_KEY=<与 API 相同>
WECHAT_CREDENTIAL_ENCRYPTION_KEY=<与 API 完全相同>
TOMEET_INTERNAL_API_TOKEN=<与 API 完全相同>
TOMEET_API_URL=http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}
WECHAT_WORKER_CONCURRENCY=8
WECHAT_OUTBOUND_CONCURRENCY=20
WECHAT_WORKER_CLAIM_INTERVAL_MS=1000
WECHAT_TURN_BATCH_WINDOW_MS=1200
WECHAT_TURN_PROGRESS_DELAY_MS=1500
WECHAT_TURN_PROGRESS_INTERVAL_MS=5000
WECHAT_ILINK_CDN_BASE_URL=https://novac2c.cdn.weixin.qq.com/c2c
```

`WECHAT_TURN_BATCH_WINDOW_MS` 用于把用户连续发送的文字和图片合并为一个输入轮次。
同一轮里的多张图片会一次性交给视觉模型综合分析，并只生成一组回复。新消息在首个
回复气泡发出前到达时，会使正在生成的旧回复失效并重新计算。图片 CDN 地址通常保持
腾讯默认值，仅在 iLink 上游明确调整时修改。

当 Agent 生成时间超过 `WECHAT_TURN_PROGRESS_DELAY_MS` 时，worker 会直接在微信聊天框
发送“正在思考”进度气泡；仍未完成时按 `WECHAT_TURN_PROGRESS_INTERVAL_MS` 继续发送下一阶段
提示，最多三条。最终回复、失败或新输入抢占旧轮次时会立即停止，短请求不会额外打扰用户。

上例假设 Railway API service 名称严格为 `api`；若实际名称不同，变量引用中的
service 名称也必须按大小写替换。service-to-service 流量使用 Railway 私网，
不要让 worker 绕到公开 API 域名。

`WECHAT_WORKER_CONCURRENCY` 控制入站长轮询连接数，
`WECHAT_OUTBOUND_CONCURRENCY` 控制主动消息 dispatcher 每批并发数。dispatcher
通过 `FOR UPDATE SKIP LOCKED` 领取消息，使用出站 UUID 生成稳定 iLink
`client_id`，失败从 5 秒开始指数退避（最长 15 分钟），最多尝试 8 次。主动消息
不需要最近一条入站消息的 `contextToken` 或 `runId`。

确认：

```text
GET /health -> 200, {"status":"ok","service":"wechat-ilink-worker"}
GET /ready  -> 200, {"status":"ready"}
```

## 6. Vercel 微信入口

新建独立 Vercel Project，不修改现有 Web Project。将 Production Branch 设置为
`feat/wechat-channel`，并设置微信 API 的公开地址：

```dotenv
NEXT_PUBLIC_API_BASE_URL=https://<api-domain>
```

重新部署后访问 `https://<你的域名>/wechat`。浏览器只得到二维码内容和一次性
session token；iLink bot token 始终以 AES-256-GCM 密文保存在 Supabase。

## 7. 本地开发

不再启动 Docker 微信容器。准备完整 `.env` 后分别运行：

```powershell
pnpm dev:all
pnpm dev:wechat
```

本地忽略的 `dev-wechat.cmd` 只启动新的 iLink worker，不会提交到 GitHub。

## 8. 上线验收

1. API 和微信 worker 的 `/health`、`/ready` 均返回 200。
2. `/wechat` 能生成二维码并显示扫码、验证、成功和过期状态。
3. Supabase 出现一个 `channel_identities(provider='wechat')` 及 active
   `wechat_ilink_connections`，凭证字段中不存在明文 token。
4. 新用户同时具备 users、conversation、user model 和 memory profile。
5. 同一微信重新扫码仍复用同一 TOMEET user，并轮换 iLink 凭证。
6. 微信发送唯一测试文本后，worker 记录 `wechat_message_completed`，微信收到
   Agent 回复。
7. 重放相同微信 message ID 不会产生第二个 Agent job。
8. 日志中不出现二维码 token、bot token、API Key、service role 或消息正文。
9. 两位测试用户接受初始匹配后，都在微信收到活动清单草稿；发布前房间不继续扩充。
10. founder 在微信用自然语言修改时间/地点/游戏，另一位主动收到新版本；双确认后
    当前成员收到发布版。
11. 新用户收到 `room_join` 匹配消息时，在接受前即可看到已发布清单；接受后再次收到
    完整清单。
12. 人为制造一次 iLink 发送失败后，日志出现 `wechat_outbound_retry`，恢复后仅发送
    一次并记录 `wechat_outbound_sent`。
