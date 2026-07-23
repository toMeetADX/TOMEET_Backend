# Railway 生产上线手册

本项目在同一个 Railway Project 中部署两个 Service：`tomeet-api` 和 `tomeet-intelligence-worker`。数据库与私有文件存储使用 Supabase，前端继续部署在 Vercel。

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

在 Railway 的 production environment 中创建两个 Service，均连接仓库根目录。

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
RATE_LIMIT_MAX=120
```

`RATE_LIMIT_MAX` 是每个客户端 IP 每分钟允许的请求数；Railway 代理地址通过 Fastify `trustProxy` 正确还原。

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
WORKER_POLL_INTERVAL_MS=1000
```

`WORKER_CONCURRENCY` 允许 1–32；`WORKER_POLL_INTERVAL_MS` 允许 100–60000。变量非法时 Worker 会直接退出，让 Railway 明确标记部署失败，而不是启动一个不消费任务的空进程。

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
- Agent 文本任务、图片签名直传和任务轮询各通过一次。
- Railway API 和 Worker 都至少保留一个可回滚的成功 Deployment。
- Supabase service role key 未出现在浏览器网络请求、Vercel `NEXT_PUBLIC_*` 或 Git 历史中。

## 6. 回滚

应用故障时，在 Railway 分别对 API 和 Worker 选择上一成功 Deployment 执行 Redeploy。数据库迁移默认按向前兼容设计；如果故障涉及数据库，不要直接删除生产表，先停止新部署并根据具体迁移编写补偿 migration。

接口与前端对接细节见 [`docs/api.md`](api.md)，机器可读定义见 [`docs/openapi.yaml`](openapi.yaml)。
