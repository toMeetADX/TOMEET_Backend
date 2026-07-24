# TOMEET Web 前端接入 API 规范

> 适用范围：Vercel Web 前端接入 Railway `@tomeet/api`。`@tomeet/intelligence-worker` 由后端内部消费异步任务，浏览器不直接调用 Worker。

## 1. 接入参数

Vercel 前端配置：

```dotenv
NEXT_PUBLIC_API_BASE_URL=https://<Railway API 公网域名>
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<Supabase anon 或 publishable key>
```

约定：

- API 当前没有 `/v1` 前缀。
- `NEXT_PUBLIC_API_BASE_URL` 结尾不要带 `/`。
- JSON 请求使用 `Content-Type: application/json`。
- 时间字段均为 ISO 8601 UTC 字符串。
- UUID 使用标准 UUID 字符串。
- 常规业务接口需要 Supabase Bearer access token；健康检查和微信扫码建连接口除外。
- 微信扫码建连由服务端签发一次性 `x-wechat-session-token`，不使用 Supabase 登录态。
- 当前没有 SSE、WebSocket 或聊天流式接口；异步操作使用 `GET /jobs/:id` 轮询。

## 2. 身份认证

### 2.1 Supabase 客户端

```ts
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);
```

前端可以使用已有的 Supabase 登录方式。尚未建立账号体系时，可以在 Supabase Dashboard 启用 Anonymous Sign-Ins：

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

### 2.2 请求头

所有受保护接口携带：

```http
Authorization: Bearer <supabase_access_token>
```

请求体或路径里的 `userId` 必须等于 access token 对应的 `session.user.id`：

- token 缺失或失效：`401 UNAUTHENTICATED`
- 操作其他用户：`403 FORBIDDEN`
- 访问不属于当前用户的任务、匹配请求或房间：通常返回 `404 NOT_FOUND`

推荐统一封装：

```ts
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL!;

export interface ApiErrorBody {
  error: string;
  message: string;
  requestId?: string;
  details?: unknown;
}

export class TomeetApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody
  ) {
    super(body.message || `TOMEET API 请求失败：${status}`);
  }
}

export async function tomeetApi<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
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

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new TomeetApiError(response.status, body as ApiErrorBody);
  }
  return body as T;
}
```

## 3. 公共数据结构

```ts
export type JobStatus =
  | "pending"
  | "processing"
  | "retry"
  | "completed"
  | "failed";

export interface LlmJob {
  id: string;
  type:
    | "agent_reply"
    | "multimodal_understanding"
    | "matchmaking"
    | "feedback_update"
    | "memory_extract"
    | "memory_consolidate";
  status: JobStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  partitionKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface MatchRequest {
  requestId: string;
  userId: string;
  intentSnapshot: Record<string, unknown>;
  status: "matching" | "matched" | "cancelled";
  roomId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OfflineGame {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  intentTags: string[];
  traits: string[];
  requirements: string[];
  instructions: string[];
}

export interface RoomMember {
  userId: string;
  displayName: string;
  confirmed: boolean;
}

export interface MatchRoom {
  roomId: string;
  members: RoomMember[];
  offlineGame: OfflineGame;
  matchSummary: string;
  status: "confirming" | "confirmed" | "completed";
  createdAt: string;
  completedAt: string | null;
}
```

## 4. 接口总表

| 方法 | 路径 | 认证 | 成功码 | 用途 |
| --- | --- | --- | --- | --- |
| `GET` | `/health` | 无 | 200 | API 存活检查 |
| `GET` | `/ready` | 无 | 200/503 | Supabase 就绪检查 |
| `POST` | `/agent/messages` | Bearer | 200/202 | 发送消息并创建 Agent 回复任务 |
| `GET` | `/agent/messages/:userId` | Bearer | 200 | 获取最近 100 条消息 |
| `POST` | `/uploads/sign` | Bearer | 200 | 获取 Supabase 一次性上传凭据 |
| `POST` | `/uploads` | Bearer | 200 | Base64 图片上传兼容接口 |
| `POST` | `/agent/multimodal-inputs` | Bearer | 200/202 | 登记图片或录音并创建理解任务 |
| `GET` | `/users/:userId/model` | Bearer | 200 | 获取公开用户模型 |
| `GET` | `/offline-games` | Bearer | 200 | 获取线下游戏目录 |
| `POST` | `/match-requests` | Bearer | 201/202 | 创建匹配请求 |
| `GET` | `/match-requests/:id` | Bearer | 200 | 查询匹配状态 |
| `POST` | `/match-requests/:id/cancel` | Bearer | 200 | 取消等待中的匹配 |
| `GET` | `/jobs/:id` | Bearer | 200 | 查询异步任务 |
| `GET` | `/rooms/:id` | Bearer | 200 | 查询房间 |
| `POST` | `/rooms/:id/confirm` | Bearer | 200 | 确认参加 |
| `POST` | `/rooms/:id/complete` | Bearer | 200 | 标记活动完成 |
| `POST` | `/rooms/:id/feedback` | Bearer | 200/202 | 提交活动反馈 |
| `POST` | `/wechat/connect/sessions` | 无 | 201 | 创建微信扫码会话 |
| `GET` | `/wechat/connect/sessions/:sessionId/events` | 微信会话 token | 200 SSE | 实时推送扫码状态 |
| `GET` | `/wechat/connect/sessions/:sessionId` | 微信会话 token | 200 | 查询扫码状态（SSE 降级） |
| `POST` | `/wechat/connect/sessions/:sessionId/verify` | 微信会话 token | 200 | 提交微信验证码 |

## 5. Agent 聊天

### 5.1 发送消息

`POST /agent/messages`

```json
{
  "userId": "4f5c00e2-a9c8-4e78-8d86-f4e8451bf609",
  "displayName": "安然",
  "content": "我想认识一些喜欢摄影的人，轻松自然一点",
  "idempotencyKey": "1b28aa75-6411-4d62-a3da-7eca18fb9f39"
}
```

字段限制：

- `displayName`：1–80 字符
- `content`：1–20000 字符
- `idempotencyKey`：8–128 字符；推荐使用 `crypto.randomUUID()`
- 同一次发送因网络错误重试时必须复用同一个 `idempotencyKey`

响应：

```ts
interface AgentMessageResponse {
  userMessage: Message;
  job: LlmJob;
}
```

生产环境通常返回 `202`。前端先将 `userMessage` 加入聊天列表，再轮询 `job.id`。

### 5.2 获取消息

`GET /agent/messages/:userId`

```ts
interface MessagesResponse {
  messages: Message[];
}
```

返回最近 100 条，按时间正序。当前没有游标分页接口。

### 5.3 异步任务轮询

`GET /jobs/:id`

```ts
interface JobResponse {
  job: LlmJob;
}
```

前端行为：

| 状态 | 行为 |
| --- | --- |
| `pending` / `processing` / `retry` | 1–2 秒后继续轮询 |
| `completed` | 停止轮询，并刷新消息、匹配或房间资源 |
| `failed` | 停止轮询，展示 `job.error` 或统一重试提示 |

```ts
export async function waitForJob(
  jobId: string,
  timeoutMs = 60_000
): Promise<LlmJob> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { job } = await tomeetApi<{ job: LlmJob }>(`/jobs/${jobId}`);
    if (job.status === "completed") return job;
    if (job.status === "failed") {
      throw new Error(job.error || "任务处理失败");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  throw new Error("任务仍在处理中，请稍后刷新");
}
```

轮询超时不代表后端任务失败。

## 6. 图片和录音

推荐流程：签名 → Supabase 直传 → 登记多模态输入。

### 6.1 获取上传凭据

`POST /uploads/sign`

```json
{
  "userId": "UUID",
  "fileName": "moment.webp",
  "mimeType": "image/webp",
  "sizeBytes": 102400
}
```

允许的 MIME：

```text
image/jpeg
image/png
image/webp
audio/mpeg
audio/mp4
audio/webm
```

最大文件大小为 20MB。

响应：

```ts
interface SignUploadResponse {
  path: string;
  token: string;
}
```

### 6.2 直传 Supabase

```ts
const signed = await tomeetApi<SignUploadResponse>("/uploads/sign", {
  method: "POST",
  body: JSON.stringify({
    userId,
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size
  })
});

const { error } = await supabase.storage
  .from("tomeet-multimodal")
  .uploadToSignedUrl(signed.path, signed.token, file, {
    contentType: file.type
  });

if (error) throw error;
```

### 6.3 登记输入

`POST /agent/multimodal-inputs`

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

- `kind` 为 `image | audio`
- `kind` 必须和 MIME 类型一致
- `storagePath` 必须以当前用户的 `UUID/` 开头
- `hint` 可选，最大 2000 字符

响应：

```ts
interface MultimodalResponse {
  inputId: string;
  job: LlmJob;
}
```

### 6.4 Base64 兼容上传

`POST /uploads`

只支持 JPG、PNG、WebP，解码后最大 10MB。生产前端应优先使用签名直传。

```json
{
  "userId": "UUID",
  "fileName": "moment.jpg",
  "mimeType": "image/jpeg",
  "dataUrl": "data:image/jpeg;base64,..."
}
```

响应：

```json
{
  "storagePath": "UUID/file.jpg",
  "mimeType": "image/jpeg",
  "sizeBytes": 1024
}
```

## 7. 用户模型和游戏目录

### `GET /users/:userId/model`

```ts
interface UserModel {
  userId: string;
  vibeNarrative: string;
  longTermProfile: Record<string, unknown>;
  currentIntent: Record<string, unknown>;
  socialHistory: string[];
  feedbackMemory: string[];
  multimodalUnderstanding: Record<string, unknown>;
  version: number;
  updatedAt: string;
}

interface UserModelResponse {
  userModel: UserModel;
}
```

### `GET /offline-games`

响应：

```ts
interface OfflineGamesResponse {
  games: OfflineGame[];
}
```

游戏目录由后端管理，匹配请求不能指定任意游戏代替后端决策。

## 8. 匹配流程

### 8.1 创建匹配请求

`POST /match-requests`

推荐让 Agent 先通过对话确认用户的社交意图，再发送：

```json
{
  "userId": "UUID"
}
```

也可以显式传入：

```json
{
  "userId": "UUID",
  "intent": {
    "goal": "认识喜欢摄影的人",
    "preferredGroupSize": 4
  },
  "idempotencyKey": "UUID"
}
```

`idempotencyKey` 当前为保留字段，后端尚未用它对匹配请求去重。

响应：

```ts
interface CreateMatchRequestResponse {
  matchRequest: MatchRequest | null;
  job: LlmJob;
}
```

- `201`：本次请求内已经匹配成功
- `202`：已进入异步匹配
- `409`：社交意图未确认，或用户仍有未结束房间

### 8.2 查询匹配

`GET /match-requests/:id`

```ts
interface MatchRequestResponse {
  matchRequest: MatchRequest;
}
```

当 `status === "matched"` 时，读取 `roomId` 并调用房间接口。

### 8.3 取消匹配

`POST /match-requests/:id/cancel`

无请求体，只能取消 `matching` 状态。

## 9. 房间和反馈

### 9.1 获取房间

`GET /rooms/:id`

只有房间成员可以读取：

```ts
interface RoomResponse {
  room: MatchRoom;
}
```

当前没有“我的房间列表”接口。前端需要从 `MatchRequest.roomId`、Agent 消息或任务结果获得房间 ID。

### 9.2 确认参加

`POST /rooms/:id/confirm`

```json
{
  "userId": "UUID"
}
```

所有成员确认后，房间状态变为 `confirmed`。

### 9.3 标记完成

`POST /rooms/:id/complete`

无请求体。当前用户必须是房间成员，且房间状态允许完成。重复调用按后端业务状态处理。

### 9.4 提交反馈

`POST /rooms/:id/feedback`

```json
{
  "userId": "UUID",
  "peopleFeedback": "大家相处自然",
  "gameFeedback": "共同任务让开场不尴尬",
  "connectionUserIds": [],
  "nextIntent": "下次希望人数更少、交流更深"
}
```

- 房间必须已经完成
- `connectionUserIds` 只能包含同房间的其他成员
- 文本字段不能为空

响应：

```ts
interface FeedbackResponse {
  feedbackId: string;
  job: LlmJob;
}
```

## 10. 微信扫码连接

Web 端 `/wechat` 页面使用独立的一次性会话，不要求用户先登录 Supabase。

### 10.1 创建扫码会话

`POST /wechat/connect/sessions`

请求体为 `{}`。响应：

```ts
type WechatConnectStatus =
  | "pending"
  | "scanned"
  | "verification_required"
  | "active"
  | "expired"
  | "failed";

interface WechatConnectSession {
  sessionId: string;
  sessionToken: string;
  qrCodeContent: string;
  status: WechatConnectStatus;
  expiresAt: string;
  confirmedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}
```

前端使用 `qrCodeContent` 生成二维码。`sessionToken` 只在创建响应中返回，不应写入日志或持久化到浏览器存储。

### 10.2 SSE 状态流

`GET /wechat/connect/sessions/:sessionId/events`

请求头：

```http
accept: text/event-stream
x-wechat-session-token: <sessionToken>
```

后端立即发送当前状态，随后通过 `event: session` 推送每次状态变化，并在终态发送 `event: done` 后关闭连接。因为原生 `EventSource` 不能设置自定义请求头，前端应使用 `fetch` 读取 `ReadableStream`，不能把 `sessionToken` 放进 URL。

收到 `scanned` 后，网页应立即遮住旧码、创建并展示下一张二维码，同时继续保留并监听旧会话。旧会话进入 `failed` 或扫码后的 `expired` 时，引导对应用户重新扫描当前新码。

### 10.3 查询状态（降级）

`GET /wechat/connect/sessions/:sessionId`

请求头：

```http
x-wechat-session-token: <sessionToken>
```

仅在 SSE 建连或重连失败时调用；进入 `active`、`expired` 或 `failed` 后停止。状态响应不再包含 `sessionToken` 和 `qrCodeContent`。

### 10.4 提交验证码

`POST /wechat/connect/sessions/:sessionId/verify`

同样携带 `x-wechat-session-token`，请求体：

```json
{
  "code": "123456"
}
```

验证码必须为 4–12 位数字。扫码会话接口有独立限流；创建接口未配置时返回 `503 wechat_connect_disabled`，无效会话凭证返回 `401 wechat_session_unauthorized`。

## 11. 错误规范

一般业务接口错误：

```json
{
  "error": "VALIDATION_ERROR",
  "message": "请求参数不正确",
  "details": {},
  "requestId": "请求追踪ID"
}
```

| HTTP | `error` | 处理建议 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` / `HTTP_ERROR` | 展示字段错误或通用参数提示 |
| 401 | `UNAUTHENTICATED` | 刷新登录状态或重新登录 |
| 403 | `FORBIDDEN` | 禁止操作，不要自动重试 |
| 404 | `NOT_FOUND` | 资源不可见或不存在 |
| 409 | `CONFLICT` | 展示 `message`，刷新业务状态 |
| 413 | `PAYLOAD_TOO_LARGE` | 提示压缩文件 |
| 429 | `RATE_LIMITED` | 延迟后重试 |
| 500 | `INTERNAL_ERROR` | 提示稍后重试并记录 `requestId` |

页面应优先展示 `message`，日志中保留 `requestId`，但不要记录 access token 或用户上传内容。

## 12. 推荐前端接入顺序

1. 配置 API Base URL 和 Supabase 公钥。
2. 完成 Supabase 登录与统一 Bearer 请求封装。
3. 接入 `POST /agent/messages`、`GET /jobs/:id`、消息刷新。
4. 接入图片/录音签名直传。
5. 接入用户模型、匹配请求和房间状态。
6. 接入房间确认、完成和反馈。
7. 如需微信入口，接入一次性扫码会话与状态轮询。

上线前至少验证：

- `/health` 与 `/ready` 返回 200。
- 无 token 调用受保护业务接口返回 401。
- token A 无法读取 token B 的任务、匹配和房间。
- 发送消息后任务从 `pending` 最终进入 `completed`。
- 上传文件不会经过 Railway API 大请求体路径。
