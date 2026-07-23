# TOMEET 微信 iLink 部署与配置

生产微信通道直接使用腾讯 `openclaw-weixin` 同源的 iLink HTTP 协议，不需要
Photon Spectrum、桌面微信、VNC、Docker 微信容器或完整 OpenClaw runtime。

用户访问 Web `/wechat` 页面后生成五分钟有效的一次性二维码。用户用微信扫码并
确认授权，API 会创建或复用该微信身份对应的 Supabase profile，同时确保
conversation、user model 和 memory profile 已存在。Railway 上独立的
`wechat-ilink-worker` 随后负责接收微信消息、调用 TOMEET Agent 并把文本回复
发送回微信。

## 微信侧需要做什么

该方案不使用公众号、小程序、微信客服或微信开放平台应用，因此不需要在这些平台
注册企业或提交审核。

每位用户只需要：

1. 打开 `https://<你的 Web 域名>/wechat`。
2. 点击“生成一次性二维码”。
3. 用自己的微信扫码并在手机中确认授权；若微信要求验证码，在 Web 页面输入。
4. 页面显示连接成功后，回到微信向刚连接的 Agent 发送消息。

微信仍可能触发登录保护、验证码、频率限制或上游协议调整。这些行为无法由 TOMEET
绕过，生产环境应先用少量测试账号灰度。

## 1. Supabase

在目标 Supabase 项目按顺序应用 `supabase/migrations`。微信迁移会创建：

- `wechat_connection_sessions`：一次性二维码会话；
- `wechat_ilink_connections`：每个 profile 的加密 iLink 凭证、游标与 lease；
- `wechat_message_receipts`：消息幂等记录，不保存聊天正文。

三张表均启用 RLS，明确撤销 `PUBLIC`、`anon`、`authenticated` 权限，只向
`service_role` 授予所需表和 RPC 权限。应用后运行 Supabase Security Advisor，
并确认 migration test 通过。

数据库只保存二维码轮询 token 的 AES-256-GCM 密文，不保存用于页面展示的二维码
内容；页面展示值仅在创建会话的响应中返回一次。

`SUPABASE_SERVICE_ROLE_KEY` 只能配置在 Railway 服务端，不能放入 Vercel、
`NEXT_PUBLIC_*`、源码或浏览器。

## 2. 生成两个服务端密钥

分别运行两次，得到两个不同的随机值：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

- 第一个保存为 `WECHAT_CREDENTIAL_ENCRYPTION_KEY`；
- 第二个保存为 `TOMEET_INTERNAL_API_TOKEN`。

加密密钥必须在 API 和微信 worker 中完全相同。更换该密钥前必须先迁移现有密文，
否则已绑定账号无法解密。

## 3. Railway API service

在现有 API service 设置：

```dotenv
DEMO_MODE=false
SUPABASE_URL=<Supabase Project URL>
SUPABASE_SERVICE_ROLE_KEY=<server-only secret>
WECHAT_CREDENTIAL_ENCRYPTION_KEY=<步骤 2 的第一个值>
TOMEET_INTERNAL_API_TOKEN=<步骤 2 的第二个值>
FRONTEND_ORIGIN=https://<你的 Vercel 域名>
```

浏览器必须使用 API 的公开 HTTPS 域名。确认 API：

```text
GET https://<api-domain>/health  -> 200, status=ok
GET https://<api-domain>/ready   -> 200, status=ready
```

## 4. Railway intelligence worker

保留现有 intelligence worker，并配置 Supabase、LLM 和联网搜索变量：

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
WECHAT_WORKER_CLAIM_INTERVAL_MS=1000
```

上例假设 Railway API service 名称严格为 `api`；若实际名称不同，变量引用中的
service 名称也必须按大小写替换。service-to-service 流量使用 Railway 私网，
不要让 worker 绕到公开 API 域名。

确认：

```text
GET /health -> 200, {"status":"ok","service":"wechat-ilink-worker"}
GET /ready  -> 200, {"status":"ready"}
```

## 6. Vercel Web

仅需要设置公开 API 地址：

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
