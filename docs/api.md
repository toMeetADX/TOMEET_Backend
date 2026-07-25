# TOMEET 前后端 API 规范

机器可读规范见 [`docs/openapi.yaml`](openapi.yaml)。当前接口没有 `/v1` 前缀；外部客户端必须通过单一 API Base URL 拼接路径，不要把 Railway 域名散落在业务代码中。当前扫码前端只使用 [`wechat-qr-api.md`](wechat-qr-api.md) 中的 `/wechat/connect/sessions*` 接口。

## 1. 基础约定

- 生产 Base URL：`https://<railway-api-domain>`，结尾不要带 `/`。
- 请求和响应：`application/json; charset=utf-8`。
- 用户 ID：Supabase Auth 的 `session.user.id`，格式为 UUID。
- 时间：ISO 8601 UTC 字符串。
- 请求追踪：前端可选传 `X-Request-Id`；错误响应总会返回 `requestId`。
- 除 `GET /health`、`GET /ready` 外，所有接口都必须登录。
- CORS 只允许 Railway 环境变量 `FRONTEND_ORIGIN` 中列出的 Origin。微信扫码创建可匿名调用，后续状态/SSE/验证码接口使用一次性 `X-WeChat-Session-Token`；其他用户接口仍使用 Supabase Bearer token。

## 2. 身份认证

生产 API 使用 Supabase access token：

```http
Authorization: Bearer <supabase_access_token>
```

## 跨渠道对话规则

Web 与微信必须解析到同一个 `users.id`。该用户的 `messages`、对话摘要、业务状态、
基础数据和结构化记忆完全共享：两端 Agent 都可以把 Web 与微信文本作为上下文，
Web 历史接口也返回两端消息。

消息展示和投递是单向的：微信 worker 只发送当前微信任务直接返回、且与本次微信
用户消息关联的 Agent 回复，不从共享历史中寻找“最后一条回复”，普通 Web 消息及
Web 回复也不能进入微信投递队列。系统主动通知是例外；用户即使在 Web 授权了主动
推送，只要同一 `users.id` 已绑定有效微信连接，之后的候选、成局、超时或房间变化
通知仍可发送到微信。

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
| POST | `/users/:userId/adventurex-onboarding/start` | 按语言幂等发送 AdventureX 四气泡欢迎语 | 200 |
| GET | `/users/:userId/model` | 获取可公开给用户的模型状态 | 200 |
| GET | `/offline-games` | 获取启用的线下游戏 | 200 |
| POST | `/match-requests` | 创建匹配请求 | 201 / 202 |
| GET | `/match-requests/:id` | 查询匹配请求 | 200 |
| GET | `/match-requests/:id/options` | 查询当前 1–3 个候选，不暴露 hook/member ID | 200 |
| POST | `/match-requests/:id/choices` | 提交一个或多个可接受候选 | 200 |
| POST | `/match-requests/:id/options/refresh` | 放弃本批候选并进入下一轮 | 200 |
| POST | `/match-requests/:id/cancel` | 取消等待中的匹配 | 200 |
| POST | `/match-requests/:id/rematch` | 从已取消或已超时请求创建全新匹配请求 | 200 |
| POST | `/match-requests/:id/open-room/:roomId/join` | 使用 offer/version 加入开放局 | 200 |
| GET | `/jobs/:id` | 查询异步任务 | 200 |
| GET | `/rooms/:id` | 查询当前用户所在房间 | 200 |
| POST | `/rooms/:id/confirm` | 当前用户确认参加 | 200 |
| POST | `/rooms/:id/leave` | 退出已确认房间并通知剩余成员 | 200 |
| POST | `/rooms/:id/complete` | 房间成员标记活动完成 | 200 |
| POST | `/rooms/:id/feedback` | 当前用户提交活动反馈 | 200 / 202 |

## 5. Agent 与消息

生产回复由 Hosted Agent 生成。业务代码对候选、成局、超时和状态变化只提供结构化事实，发布前会再次校验事实边界和候选编号；首次 AdventureX 欢迎语是唯一明确保留的固定产品话术。

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

AdventureX V1 中还支持自然语言选择候选、换一批、取消、重新匹配和退出房间。用户看到的正文不包含 `hookId`、候选成员 ID 或 `sourceUserId`。

### `GET /agent/messages/:userId`

返回：`{ "messages": Message[] }`，按时间正序，最多 100 条。匹配成功后 Worker 会向所有成员写入一条 assistant 消息，前端刷新此接口即可看到通知。

## 6. 图片与录音

微信通道会下载并解密 iLink `image_item`，将一次消息或短时间内连续发送的最多 9 张
图片合并成一个多模态任务。若同一轮还包含文字，文字会作为整组图片的补充说明；模型
必须综合全部图片，只回复一次并只问一个问题。连续文字同样会合并，且新输入会使尚未
发送气泡的旧回复失效。

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

### `POST /users/:userId/adventurex-onboarding/start`

请求体可选：`{ "language": "zh" | "en" }`，默认 `zh`。首次调用会返回对应语言的四段欢迎语；微信发送端会按空行拆成四个气泡。相同语言重复调用返回同一条消息。用户已经开始正常对话且此前没有欢迎消息时不会插入历史，`message` 为 `null`、`messages` 为空数组。用户在对话中明确要求切换语言时，Agent 会保存语言偏好并重新播放对应语言欢迎语。响应：

```json
{
  "state": {
    "stage": "awaiting_image_or_text",
    "imageDeclined": false,
    "preferredLanguage": "zh",
    "boundaryPromptedAt": null
  },
  "message": { "role": "assistant", "content": "你好呀👋\n\n很高兴认识你\n\n……" },
  "messages": [{ "role": "assistant", "content": "你好呀👋\n\n很高兴认识你\n\n……" }]
}
```

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

也可显式传入 `intent` 对象。没有明确社交意图、存在未结束房间时返回 `409`。

默认流程先按贪心机制选择当前最匹配的一位用户，创建双边邀请；双方接受后才创建房间。响应为 `{ "matchRequest": MatchRequest, "invite": MatchInvite | null, "job": LlmJob }`，等待或已发出邀请时返回 `202`，已进入房间时返回 `201`。

启用 `ADVENTUREX_MATCHING_V1=true` 后，请求进入下一个 30 秒后台清算 tick；该 tick 不是用户等待倒计时。只有真实候选发送成功后才开始 90 秒选择窗口。

### `GET /match-requests/:id`

返回 `{ "matchRequest": MatchRequest }`。`status` 为 `matching | invited | matched | cancelled | expired`；`invited` 时 `inviteId` 非空，进入房间后 `roomId` 非空。`expired` 表示候选窗口结束后本次请求未成局且没有保留主动推送授权。活跃请求另有 `phase=waiting | offered | selected | settling | push_consent | watching`，并通过 `proactivePushEnabled` 表示是否允许微信主动推送。

### `GET /match-requests/:id/options`

返回当前候选的公开视图：

```json
{
  "requestId": "UUID",
  "roundId": "UUID",
  "expiresAt": "2026-07-24T12:00:00.000Z",
  "options": [{
    "optionNumber": 1,
    "activity": { "id": "game-story-table", "name": "故事交换桌" },
    "previewText": "**1｜故事交换桌**\n你可能遇见……"
  }]
}
```

### `POST /match-requests/:id/choices`

```json
{
  "preferredOptionNumber": 3,
  "acceptedOptionNumbers": [3, 1],
  "requiredHookIds": [],
  "rawText": "3 优先，1 也行"
}
```

`requiredHookIds` 主要供 Agent/结构化测试使用，必须来自当前已接受 offer。普通产品入口应继续通过 `/agent/messages` 发送自然语言。首选为开放局时会立即尝试原子加入；版本变化或满员返回 `409`，不会静默改派。

### 刷新、取消与重新匹配

- `POST /match-requests/:id/options/refresh`：当前 offers 过期，请求进入下一轮。
- `POST /match-requests/:id/cancel`：响应额外包含 `canRematch=true`。
- `POST /match-requests/:id/rematch`：只接受已取消或已超时请求，并创建新的 request ID，不复活旧记录。候选窗口超时后不会自动重新匹配，必须由用户明确发起。
- `POST /match-requests/:id/open-room/:roomId/join`：请求体为 `{ "offerId": "UUID", "sourceVersion": 2 }`。

### AdventureX 虚拟测试池开关

- `GET /adventurex/test-pool`：读取当前登录账号的测试池状态。
- `POST /adventurex/test-pool`：请求体 `{ "enabled": true, "desiredUserCount": 5 }`，数量范围 3–12。

该接口同时要求正常 Supabase Bearer 登录和 `ADVENTUREX_TEST_POOL_EMAIL` 邮箱白名单。未配置 `ADVENTUREX_TEST_POOL_ENABLED=true` 时返回 `503`，非白名单账号返回 `403`。测试用户只会进入所有者的 `adventurex-test:<owner>:<tick>` 隔离轮次。

### `GET /match-invites/:id`

仅邀请参与者可读取，返回 `{ "invite": MatchInvite }`。

### `POST /match-invites/:id/accept`

请求体为 `{ "userId": "UUID" }`。初始邀请需双方接受才会原子建房；入房邀请由候选用户接受后原子加入。返回 `{ "invite": MatchInvite, "room": MatchRoom | null, "requeuedRequestIds": string[] }`。

### `POST /match-invites/:id/decline`

请求体为 `{ "userId": "UUID" }`。初始邀请被拒绝时，拒绝方请求取消，另一方重新进入队列；入房邀请被拒绝时，房间保持持续匹配。

## 9. 房间与反馈

### `GET /rooms/:id`

只有房间成员可读取。返回 `{ "room": MatchRoom }`。

### `POST /rooms/:id/confirm`

```json
{ "userId": "UUID" }
```

当前登录用户确认参加；所有成员确认后房间变为 `confirmed`。

AdventureX 新流程中，用户对候选的选择已构成参加意愿，最终房间创建时成员直接为 `confirmed`；本接口仅为旧流程兼容保留。

### `POST /rooms/:id/leave`

```json
{ "userId": "UUID", "reason": "临时有事" }
```

正式成局确认函发出后，`reason` 必须是去除首尾空白后的非空字符串，最长 500 字；系统只要求用户给出一个简单理由，不判断其充分性。理由仅用于内部记录，不会出现在其他成员收到的变化通知中。

成员行保留并标记为 `withdrawn`，房间 `version` 增加；有空位时重新开放招募。退出用户不会再次收到同一个开放局。剩余确认成员通过 Agent 消息收到一次幂等变化通知。响应包含 `canRematch=false`、最新 `matchRequest` 与 `interestState`：此前已授权主动推送时请求变为 `matching/watching`，否则变为 `cancelled`，且不会自动询问或启动重新匹配。

### `POST /rooms/:id/stop-match`

请求体为 `{ "userId": "UUID" }`。任一在房成员可停止继续加人；房间 `matchingStatus` 变为 `stopped`，待处理的入房邀请被取消，其候选请求重新入队。达到 `capacity` 时房间自动变为 `full`。

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
