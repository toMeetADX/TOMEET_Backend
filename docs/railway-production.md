# Railway 生产上线手册

本项目在同一个 Railway Project 中部署三个 Service：`tomeet-api`、`tomeet-intelligence-worker` 和 `tomeet-wechat-ilink-worker`。数据库与私有文件存储使用 Supabase，前端继续部署在 Vercel。

## 上线前置条件

1. 生产 Supabase Project 已创建。
2. Supabase Auth 已启用前端要使用的登录方式；没有账号体系时可先启用 Anonymous Sign-Ins。
3. 已准备生产 LLM API Key；需要实时联网能力时再提供 Tavily Key。
4. 已确定 Vercel 正式域名，例如 `https://app.example.com`。
5. Railway 使用 Node.js 22；仓库根目录 `.nvmrc` 和 `packageManager` 已锁定版本。

## 1. 推送数据库迁移

先对生产 Supabase 执行全部迁移：

```bash
supabase login
supabase link --project-ref <production-project-ref>
supabase db push
```

不要在生产项目执行 `supabase/seed.sql`，其中包含仅用于本地单人流程的自动确认测试成员。

## 2. 创建 Railway Services

在 Railway 的 production environment 中创建三个 Service，均连接仓库根目录。

### API Service

- Service 名：`tomeet-api`
- Config file path：`/railway.api.toml`
- Generate Domain：开启
- Healthcheck：配置文件已设置为 `/health`

环境变量：

```text
NODE_ENV=production
DEMO_MODE=false
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<secret>
FRONTEND_ORIGIN=https://<vercel-production-domain>
WECHAT_WEB_REGISTRATION_URL=https://tomeet.chat/register
WECHAT_WEB_CLAIM_TTL_SECONDS=900
RATE_LIMIT_MAX=120
ADVENTUREX_MATCHING_V1=true
ADVENTUREX_TEST_POOL_ENABLED=false
ADVENTUREX_TEST_POOL_EMAIL=andy4fe0119@gmail.com
```

`RATE_LIMIT_MAX` 是每个客户端 IP 每分钟允许的请求数；Railway 代理地址通过 Fastify `trustProxy` 正确还原。

`WECHAT_WEB_REGISTRATION_URL` 是首次微信开场白中的个性化注册链接。API 会先创建
同一 UUID 的 Supabase 匿名账号，再生成默认 15 分钟有效的一次性 claim。生产 Supabase
必须开启 Anonymous Sign-Ins；前端接入见 [`wechat-web-registration.md`](wechat-web-registration.md)。

预览域名或多个正式域名使用英文逗号分隔：

```text
FRONTEND_ORIGIN=https://app.example.com,https://www.example.com
```

每一项必须是纯 Origin，不能带路径。线上 Origin 使用 HTTPS。`SUPABASE_SERVICE_ROLE_KEY` 只能存在于 Railway API/Worker，绝不能放入 Vercel 的 `NEXT_PUBLIC_*` 变量。

### Intelligence Worker Service

- Service 名：`tomeet-intelligence-worker`
- Config file path：`/railway.worker.toml`
- 不需要生成公网域名

环境变量：

```text
NODE_ENV=production
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<secret>
LLM_API_KEY=<secret>
LLM_API_BASE_URL=https://api.siliconflow.cn/v1
LLM_TEXT_MODEL=Qwen/Qwen3-Omni-30B-A3B-Instruct
LLM_VISION_MODEL=Qwen/Qwen3-Omni-30B-A3B-Instruct
LLM_AUDIO_MODEL=FunAudioLLM/SenseVoiceSmall
TAVILY_API_KEY=<optional-secret>
TAVILY_API_BASE_URL=https://api.tavily.com
WORKER_CONCURRENCY=8
WORKER_POLL_INTERVAL_MS=200
LLM_SIMPLE_REPLY_FAST_PATH=true
LLM_SINGLE_PASS_EVIDENCE_FINALIZER=true
ADVENTUREX_MATCHING_V1=true
```

`WORKER_CONCURRENCY` 允许 1–32；`WORKER_POLL_INTERVAL_MS` 允许 100–60000。变量非法时 Worker 会直接退出，让 Railway 明确标记部署失败，而不是启动一个不消费任务的空进程。

交互式 `agent_reply` 只执行一次 Job 尝试，避免重复生成互相冲突的回复。微信客户端最多等待
5 分钟，并通过进度气泡告知用户仍在处理。Agent 阶段截止时间分别为 plan 120 秒、grounding
90 秒、verification 60 秒、action correction 45 秒，结构修复单次 30 秒。
`LLM_SIMPLE_REPLY_FAST_PATH=true` 会在首轮结构合法、本地动作校验通过、没有联网事实、未验证
链接或虚假成功声明时直接发布；普通陈述、提问和反问不会单独触发第二次模型调用。
`LLM_SINGLE_PASS_EVIDENCE_FINALIZER=true` 把记忆/联网证据的 grounding 与发布校验合并成一次调用。

`ADVENTUREX_MATCHING_V1` 必须在 API 与 Worker 使用相同值。`true` 启用轮次、候选、多选、开放局与原子结算；紧急回滚时两处同时改为 `false`，旧即时匹配路径仍保留。

### WeChat iLink Worker Service

- Service 名：`tomeet-wechat-ilink-worker`
- Config file path：`/railway.wechat.toml`
- 不需要生成公网域名

环境变量：

```text
NODE_ENV=production
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<secret>
TOMEET_API_URL=https://<api-domain>
TOMEET_INTERNAL_API_TOKEN=<shared-server-secret>
WECHAT_CREDENTIAL_ENCRYPTION_KEY=<shared-encryption-key>
WECHAT_WORKER_CONCURRENCY=8
WECHAT_OUTBOUND_CONCURRENCY=20
WECHAT_WORKER_CLAIM_INTERVAL_MS=1000
WECHAT_BUBBLE_DELAY_MS=200
WECHAT_TURN_BATCH_WINDOW_MS=400
WECHAT_TURN_PROGRESS_DELAY_MS=30000
WECHAT_TURN_PROGRESS_INTERVAL_MS=30000
```

`WECHAT_BUBBLE_DELAY_MS` 控制一句话气泡之间的渐进发送间隔，允许 `0–5000` 毫秒，生产建议约 `180–220` 毫秒，测试使用 `0`。组局邀请和成局确认函字符卡片不会被拆分。

`WECHAT_TURN_PROGRESS_DELAY_MS` 控制首条“Agent 正在工作”提示出现前的等待时间，
`WECHAT_TURN_PROGRESS_INTERVAL_MS` 控制后续阶段提示间隔；默认首条等待 30 秒，之后每隔
30 秒逐条提示，最终回复或新输入到达后会停止提示。

冷启动测试时可仅在 API 设置 `ADVENTUREX_TEST_POOL_ENABLED=true`。受保护开关只允许 `ADVENTUREX_TEST_POOL_EMAIL` 对应账号使用；正式真实用户池验收前应保持关闭。微信主动消息 Worker 使用 `WECHAT_OUTBOUND_CONCURRENCY` 并发发送候选、成局、超时和房间变化等异步通知。

如需按本次 AdventureX 冷启动验收要求清空已有聊天派生数据并重建所有者虚拟测试用户，先暂停 Intelligence Worker 和微信 Worker，再在可信本机使用生产 Supabase 服务端变量执行：

```bash
pnpm adventurex:reset-chat-data -- --owner-email=andy4fe0119@gmail.com --desired-users=5
pnpm adventurex:reset-chat-data -- --owner-email=andy4fe0119@gmail.com --desired-users=5 --execute
```

第一条只输出删除前计数；第二条才真正执行。脚本不会删除真实用户、既有房间、已完成匹配或微信连接，但会结束仍在进行的旧匹配请求，并重置对话摘要、消息来源记忆、社交钩子和首次欢迎状态。

## 3. 部署顺序

1. 确认 Supabase migrations 已完成。
2. 先部署 Worker，日志中应出现 `"event":"worker_started"`。
3. 再部署 API，Railway `/health` 检查应通过。
4. 打开 `https://<api-domain>/ready`，应返回 `{ "status": "ready" }`。
5. 将 API 域名写入 Vercel：

```text
NEXT_PUBLIC_API_BASE_URL=https://<api-domain>
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable-anon-key>
```

6. 重新部署 Vercel 前端。

## 4. 生产冒烟检查

健康检查无需登录：

```bash
curl -fsS https://<api-domain>/health
curl -fsS https://<api-domain>/ready
```

在前端登录后取得 Supabase access token 和用户 ID，再执行：

```bash
curl -fsS https://<api-domain>/offline-games \
  -H "Authorization: Bearer <access-token>"
```

发送一条消息：

```bash
curl -fsS https://<api-domain>/agent/messages \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "userId":"<supabase-user-id>",
    "displayName":"生产冒烟用户",
    "content":"你好，这是一次生产连通性检查",
    "idempotencyKey":"<uuid>"
  }'
```

响应通常为 `202`。使用返回的 `job.id` 轮询：

```bash
curl -fsS https://<api-domain>/jobs/<job-id> \
  -H "Authorization: Bearer <access-token>"
```

确认任务最终进入 `completed`，随后读取 `/agent/messages/<supabase-user-id>` 验证 assistant 消息。

## 5. 上线验收清单

- API `/health` 为 200，`/ready` 为 200。
- 不带 token 请求 `/offline-games` 返回 401。
- token A 读取用户 B 的路径或资源失败。
- Vercel 域名无 CORS 报错，未登记 Origin 被拒绝。
- Worker 日志有 `job_completed`，无持续重复的 `worker_loop_error`。
- 延迟诊断时联合查看 `agent_job_enqueued`、`llm_request`、`job_completed` 和
  `wechat_turn_batch_completed`；它们分别提供持久化/入队、模型阶段、队列/处理、微信批处理/投递耗时。
- Agent 文本任务、图片签名直传和任务轮询各通过一次。
- Railway API 和 Worker 都至少保留一个可回滚的成功 Deployment。
- Supabase service role key 未出现在浏览器网络请求、Vercel `NEXT_PUBLIC_*` 或 Git 历史中。

## 6. 回滚

应用故障时，在 Railway 分别对 API 和 Worker 选择上一成功 Deployment 执行 Redeploy。数据库迁移默认按向前兼容设计；如果故障涉及数据库，不要直接删除生产表，先停止新部署并根据具体迁移编写补偿 migration。

接口与前端对接细节见 [`docs/api.md`](api.md)，机器可读定义见 [`docs/openapi.yaml`](openapi.yaml)。
