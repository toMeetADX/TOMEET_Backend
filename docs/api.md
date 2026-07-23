# TOMEET API 契约

API 与前端完全分离。正式 Vercel 前端只需要配置 `NEXT_PUBLIC_API_BASE_URL`，不应直接执行匹配、房间状态变更或用户模型更新。

## 异步任务约定

涉及 LLM 的写接口返回 `job`：

- `pending / processing / retry`：HTTP 通常为 `202`，前端轮询 `GET /jobs/:id`。
- `completed`：读取 `job.result`。
- `failed`：展示 `job.error`，允许用户重试原操作；幂等键会避免重复写入。

建议轮询间隔 1–2 秒，前台最多持续 60 秒，超时后允许用户手动刷新。

## Agent

正式交互可以只使用对话接口。模型会返回结构化动作，Worker 自动执行：

- 明确表达想社交 → 创建匹配请求并启动匹配。
- 回复“确认参加” → 确认当前房间。
- 表达活动已经结束 → 完成当前房间。
- 表达对人、游戏和下一次期待 → 保存反馈并更新用户模型。

匹配成功后，Worker 会向每位成员的对话写入一条 assistant 消息。前端持续轮询消息列表即可收到房间和游戏通知，无需展示额外操作面板。

### `POST /agent/messages`

```json
{
  "userId": "UUID",
  "displayName": "安然",
  "content": "我想认识一些喜欢摄影的人",
  "idempotencyKey": "客户端生成的唯一键"
}
```

返回用户消息和 `agent_reply` 任务。完成结果包含：

```json
{
  "message": {},
  "userModel": {},
  "socialIntentDetected": true,
  "webSearch": {
    "status": "not_needed | completed | failed | unavailable",
    "sources": [
      { "title": "来源标题", "url": "https://example.com", "publishedAt": "可选发布时间" }
    ]
  }
}
```

`webSearch` 是兼容旧客户端的可选字段。网页正文和搜索查询不会进入公共任务结果；来源 URL 仅保留在该元数据中，不会拼接到最终消息正文。

### `GET /agent/messages/:userId`

返回最近 100 条对话。

### `POST /uploads/sign`

为 Supabase 私有 Bucket 创建一次性上传令牌：

```json
{
  "userId": "UUID",
  "fileName": "photo.webp",
  "mimeType": "image/webp",
  "sizeBytes": 102400
}
```

前端使用 Supabase SDK 的 `uploadToSignedUrl(path, token, file)` 上传，再调用多模态输入接口。

### `POST /uploads`

仓库内联调前端使用的图片上传接口，支持 JPG、PNG、WebP，最大 10MB：

```json
{
  "userId": "UUID",
  "fileName": "moment.jpg",
  "mimeType": "image/jpeg",
  "dataUrl": "data:image/jpeg;base64,..."
}
```

返回 `storagePath`、`mimeType` 和 `sizeBytes`，随后调用多模态输入接口。

### `POST /agent/multimodal-inputs`

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

### `GET /users/:userId/model`

返回结构化长期用户模型。

该接口保留现有兼容结构。Agent Memory V2 的 `user_memories` 与 `user_memory_profiles` 是仅后端可读的内部数据，不通过本接口返回。匹配只读取当次原话和经过治理的自然语言 `matchingNarrative`，不读取兴趣/性格标签、原始 profile 或详细记忆。

## 匹配

### `POST /match-requests`

```json
{
  "userId": "UUID"
}
```

默认使用用户模型中的 `currentIntent` 快照。没有明确社交意图时返回 `409`。也可显式传入 `intent` 对象。

### `GET /match-requests/:id`

轮询 `status`。匹配成功时 `status=matched` 且 `roomId` 非空。

### `POST /match-requests/:id/cancel`

只能取消仍在 `matching` 的请求。

## 房间与反馈

- `GET /rooms/:id`
- `POST /rooms/:id/confirm`，Body：`{ "userId": "UUID" }`
- `POST /rooms/:id/complete`
- `POST /rooms/:id/feedback`

反馈 Body：

```json
{
  "userId": "UUID",
  "peopleFeedback": "大家相处自然",
  "gameFeedback": "共同任务让开场不尴尬",
  "connectionUserIds": [],
  "nextIntent": "下次希望人数更少、交流更深"
}
```

房间必须全部确认后才能完成，活动完成后才能提交反馈。

## 运维接口

- `GET /health`：进程存活检查，供 Railway 使用。
- `GET /ready`：检查 Supabase 是否可访问。
- `GET /offline-games`：读取当前启用的人工策划游戏。
- `GET /jobs/:id`：读取后台任务状态。

## 错误格式

```json
{
  "error": "VALIDATION_ERROR | NOT_FOUND | CONFLICT | INTERNAL_ERROR",
  "message": "可展示的错误说明",
  "requestId": "请求追踪 ID"
}
```
