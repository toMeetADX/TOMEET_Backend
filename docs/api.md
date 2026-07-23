# TOMEET 前后端 API 规范

机器可读规范见 [`docs/openapi.yaml`](openapi.yaml)。当前接口没有 `/v1` 前缀；前端必须统一通过 `NEXT_PUBLIC_API_BASE_URL` 拼接路径，不要把 Railway 域名散落在业务代码中。

## 1. 基础约定

- 生产 Base URL：`https://<railway-api-domain>`，结尾不要带 `/`。
- 请求和响应：`application/json; charset=utf-8`。
- 用户 ID：Supabase Auth 的 `session.user.id`，格式为 UUID。
- 时间：ISO 8601 UTC 字符串。
- 请求追踪：前端可选传 `X-Request-Id`；错误响应总会返回 `requestId`。
- 除 `GET /health`、`GET /ready` 外，所有接口都必须登录。
- CORS 只允许 Railway 环境变量 `FRONTEND_ORIGIN` 中列出的 Origin。

## 2. 身份认证

生产 API 使用 Supabase access token：

```http
Authorization: Bearer <supabase_access_token>
```

首次使用可在前端调用 Supabase Anonymous Sign-In，也可以换成手机号、邮箱或 OAuth。必须先在 Supabase Dashboard 启用对应登录方式。

```ts
const { data: sessionData } = await supabase.auth.getSession();
let session = sessionData.session;

if (!session) {
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  session = data.session;
}

const userId = session!.user.id;
const accessToken = session!.access_token;
```

现有请求体和路径中的 `userId` 必须等于 token 对应的 `session.user.id`。不一致返回 `403 FORBIDDEN`；访问不属于当前用户的匹配请求、任务或房间统一返回 `404`，避免泄露资源是否存在。

推荐封装统一请求函数：

```ts
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL!;

export async function tomeetApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("请先登录");

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      ...init.headers
    }
  });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.message), { status: response.status, body });
  return body as T;
}
```

## 3. 异步任务

需要 LLM 的接口在生产环境通常返回 `202` 和一个 `job`。状态含义：

| 状态 | 前端行为 |
| --- | --- |
| `pending` / `processing` / `retry` | 每 1–2 秒轮询 `GET /jobs/:id` |
| `completed` | 读取 `job.result`，或刷新消息/匹配/房间资源 |
| `failed` | 停止轮询，展示可重试提示 |

建议前台轮询最多 60 秒；超时不代表任务失败，允许用户稍后刷新。`idempotencyKey` 使用 `crypto.randomUUID()`，同一次用户操作重试时复用原值。

## 4. 接口总表

| 方法 | 路径 | 用途 | 主要成功码 |
| --- | --- | --- | --- |
| GET | `/health` | Railway 存活检查，无需认证 | 200 |
| GET | `/ready` | Supabase 就绪检查，无需认证 | 200 / 503 |
| POST | `/agent/messages` | 发送用户消息并创建 Agent 回复任务 | 200 / 202 |
| GET | `/agent/messages/:userId` | 最近 100 条对话 | 200 |
| POST | `/uploads/sign` | 获取 Supabase 私有 Bucket 一次性上传凭据 | 200 |
| POST | `/uploads` | Base64 图片上传兼容接口 | 200 |
| POST | `/agent/multimodal-inputs` | 登记已上传的图片/录音并创建理解任务 | 200 / 202 |
| GET | `/users/:userId/model` | 获取可公开给用户的模型状态 | 200 |
| GET | `/offline-games` | 获取启用的线下游戏 | 200 |
| POST | `/match-requests` | 创建匹配请求 | 201 / 202 |
| GET | `/match-requests/:id` | 查询匹配请求 | 200 |
| POST | `/match-requests/:id/cancel` | 取消等待中的匹配 | 200 |
| GET | `/jobs/:id` | 查询异步任务 | 200 |
| GET | `/rooms/:id` | 查询当前用户所在房间 | 200 |
| POST | `/rooms/:id/confirm` | 当前用户确认参加 | 200 |
| POST | `/rooms/:id/complete` | 房间成员标记活动完成 | 200 |
| POST | `/rooms/:id/feedback` | 当前用户提交活动反馈 | 200 / 202 |

## 5. Agent 与消息

### `POST /agent/messages`

```json
{
  "userId": "4f5c00e2-a9c8-4e78-8d86-f4e8451bf609",
  "displayName": "安然",
  "content": "我想认识一些喜欢摄影的人，轻松自然一点",
  "idempotencyKey": "1b28aa75-6411-4d62-a3da-7eca18fb9f39"
}
```

响应：

```json
{
  "userMessage": {
    "id": "UUID",
    "userId": "UUID",
    "role": "user",
    "content": "我想认识一些喜欢摄影的人，轻松自然一点",
    "createdAt": "2026-07-23T12:00:00.000Z"
  },
  "job": {
    "id": "UUID",
    "type": "agent_reply",
    "status": "pending",
    "payload": {},
    "result": null,
    "error": null,
    "attempts": 0,
    "maxAttempts": 3,
    "partitionKey": "user:UUID",
    "createdAt": "2026-07-23T12:00:00.000Z",
    "updatedAt": "2026-07-23T12:00:00.000Z"
  }
}
```

完成后的 `job.result` 可能包含 `message`、`userModel`、`socialIntentDetected`、`webSearch`、`actions`、`matchRequest` 和 `room`。产品主流程可以只发送自然语言：Agent 会根据对话执行发起匹配、确认房间、完成活动和提交反馈等结构化动作。

### `GET /agent/messages/:userId`

返回：`{ "messages": Message[] }`，按时间正序，最多 100 条。匹配成功后 Worker 会向所有成员写入一条 assistant 消息，前端刷新此接口即可看到通知。

## 6. 图片与录音

推荐使用签名直传，避免文件经过 Railway API。

### `POST /uploads/sign`

```json
{
  "userId": "UUID",
  "fileName": "moment.webp",
  "mimeType": "image/webp",
  "sizeBytes": 102400
}
```

允许的 MIME：`image/jpeg`、`image/png`、`image/webp`、`audio/mpeg`、`audio/mp4`、`audio/webm`；最大 20MB。

响应：`{ "path": "UUID/file.webp", "token": "一次性上传 token" }`。前端随后调用：

```ts
await supabase.storage
  .from("tomeet-multimodal")
  .uploadToSignedUrl(path, token, file, { contentType: file.type });
```

### `POST /agent/multimodal-inputs`

上传成功后登记输入：

```json
{
  "userId": "UUID",
  "kind": "image",
  "storagePath": "UUID/file.webp",
  "mimeType": "image/webp",
  "sizeBytes": 102400,
  "hint": "这是我最近参加的活动"
}
```

`kind` 必须和 MIME 对应。响应为 `{ "inputId": "UUID", "job": LlmJob }`。

### `POST /uploads`

仅用于兼容 Base64 图片上传，支持 JPG/PNG/WebP，解码后最大 10MB：

```json
{
  "userId": "UUID",
  "fileName": "moment.jpg",
  "mimeType": "image/jpeg",
  "dataUrl": "data:image/jpeg;base64,..."
}
```

响应为 `{ "storagePath": "UUID/file.jpg", "mimeType": "image/jpeg", "sizeBytes": 1024 }`。生产前端优先使用 `/uploads/sign`。

## 7. 用户模型与游戏

### `GET /users/:userId/model`

返回 `{ "userModel": UserModel }`。只暴露兼容业务字段；Agent Memory V2 的详细记忆和隐藏 profile 不通过此接口返回。

### `GET /offline-games`

返回 `{ "games": OfflineGame[] }`。游戏只由后端目录提供，前端不能传入任意游戏替代匹配结果。

## 8. 匹配

### `POST /match-requests`

默认使用已由对话确认的 `currentIntent`：

```json
{
  "userId": "UUID",
  "idempotencyKey": "可选，当前版本保留字段"
}
```

也可显式传入 `intent` 对象。没有明确社交意图、存在未结束房间时返回 `409`。响应为 `{ "matchRequest": MatchRequest, "job": LlmJob }`；已在本次请求内完成匹配时为 `201`，否则为 `202`。

### `GET /match-requests/:id`

返回 `{ "matchRequest": MatchRequest }`。`status` 为 `matching | matched | cancelled`；匹配成功时 `roomId` 非空。

### `POST /match-requests/:id/cancel`

无请求体。只能取消 `matching` 状态，响应为 `{ "matchRequest": MatchRequest }`。

## 9. 房间与反馈

### `GET /rooms/:id`

只有房间成员可读取。返回 `{ "room": MatchRoom }`。

### `POST /rooms/:id/confirm`

```json
{ "userId": "UUID" }
```

当前登录用户确认参加；所有成员确认后房间变为 `confirmed`。

### `POST /rooms/:id/complete`

无请求体。当前登录用户必须是房间成员，且所有成员已确认。重复调用是幂等的。

### `POST /rooms/:id/feedback`

```json
{
  "userId": "UUID",
  "peopleFeedback": "大家相处自然",
  "gameFeedback": "共同任务让开场不尴尬",
  "connectionUserIds": [],
  "nextIntent": "下次希望人数更少、交流更深"
}
```

房间必须已完成；`connectionUserIds` 只能包含同房间的其他成员。响应为 `{ "feedbackId": "UUID", "job": LlmJob }`。

## 10. 错误规范

```json
{
  "error": "VALIDATION_ERROR",
  "message": "请求参数不正确",
  "details": {},
  "requestId": "请求追踪 ID"
}
```

| HTTP | `error` | 含义 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` / `HTTP_ERROR` | 参数、JSON 或请求格式错误 |
| 401 | `UNAUTHENTICATED` | token 缺失、无效或过期 |
| 403 | `FORBIDDEN` | body/path 的用户与 token 用户不一致 |
| 404 | `NOT_FOUND` | 接口或当前用户可见范围内的资源不存在 |
| 409 | `CONFLICT` | 当前业务状态不允许操作 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超过服务限制 |
| 429 | `RATE_LIMITED` | 单客户端 IP 请求过于频繁 |
| 500 | `INTERNAL_ERROR` | 服务内部错误，不向生产客户端暴露内部细节 |

前端可以展示 `message`，并将 `requestId` 写入错误日志，便于在 Railway 日志中追踪。
