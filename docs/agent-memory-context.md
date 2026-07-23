# Agent Memory / Context V2

本设计只改变 Agent Layer、Worker 和后端数据适配，不改变前端协议、Next.js/Fastify/Supabase/Railway 技术选型或部署路径。

## 设计来源

实现借鉴 OpenAI Codex 的两类边界，而不是复制它的文件系统实现：

- 记忆写入分为“从单次记录提取证据”和“对有界证据做全局整合”两个阶段；没有耐久信息时允许 no-op。
- 默认上下文只注入短摘要，详细记忆按当前问题延迟检索。
- 长对话按 token 压力生成可替换 checkpoint，不按消息数量无限追加摘要。
- 记忆带来源、状态、确认次数、使用次数、过期时间和遗忘状态。

参考实现：

- [Codex memories README](https://github.com/openai/codex/blob/4462b9deef211723b781b426f5e5d36a5777115f/codex-rs/memories/README.md)
- [Codex memory read path](https://github.com/openai/codex/blob/4462b9deef211723b781b426f5e5d36a5777115f/codex-rs/ext/memories/templates/memories/read_path.md)
- [Codex compaction](https://github.com/openai/codex/blob/4462b9deef211723b781b426f5e5d36a5777115f/codex-rs/core/src/compact.rs)
- [Codex context history](https://github.com/openai/codex/blob/4462b9deef211723b781b426f5e5d36a5777115f/codex-rs/core/src/context_manager/history.rs)

## 运行链路

```text
agent_reply
  ├─ ContextAssembler：profile 摘要 + checkpoint + 最近消息
  ├─ Reply Planner：冻结 replyDraft / intent / actions
  ├─ memory lookup 与 web search
  ├─ Reply Finalizer：只能改写回复，不能修改 actions
  └─ enqueue memory_extract

memory_extract
  ├─ 只从本轮来源提取明确、低敏感证据
  ├─ 代码层敏感信息过滤、TTL、去重、纠正与遗忘校验
  └─ enqueue memory_consolidate（仅发生变化时）

memory_consolidate
  ├─ 最多读取 128 条 active memory
  ├─ 生成 profileNarrative 与 matchingNarrative
  └─ 乐观锁保存并解除 stale
```

同一个用户的任务使用 `partition_key=user:{userId}` 严格 FIFO；不同用户仍由 `FOR UPDATE SKIP LOCKED` 并行处理。

## 存储

`user_memories` 是证据层。每条记忆保存：

- `memory_kind`、稳定身份 `stable_key` 和自然语言 `content`。
- `source_type` / `source_id` 与明确性。
- `active`、`superseded`、`forgotten`、`expired` 状态。
- 确认次数、使用次数、最近确认/使用时间和过期时间。

`user_memory_profiles` 是可重建摘要层：

- `profile_narrative`：对日常对话有帮助的低敏感自然语言摘要。
- `matching_narrative`：只包含社交节奏、互动偏好、边界和真实反馈。
- `source_memory_ids`、水位、版本和 `stale`。

这两张表启用 RLS，且 `anon` / `authenticated` 没有表权限或内部 RPC 执行权限。它们不会由 `GET /users/:userId/model` 返回。

## 隐私与保留

允许持久化的默认范围：

- 偏好称呼、大致城市/地区、职业领域。
- 用户明确表达的兴趣、日常习惯、互动偏好和社交边界。
- 用户亲历活动后的真实反馈。

禁止持久化：

- 联系方式、精确地址、证件、账号、密钥。
- 财务、医疗、法律记录。
- 宗教、政治、性取向、生物识别及相关推断。
- 第三方个人信息和模型自行推断的敏感属性。

保留策略：

| 类型 | 默认保留 |
| --- | --- |
| 稳定事实、偏好、互动偏好、边界 | 不自动过期，可被纠正或遗忘 |
| 临时状态 | 14 天 |
| 多模态近期印象 | 30 天 |
| 活动后的社交学习 | 180 天 |

用户可以直接在对话中要求纠正、忘记某项记忆或清除全部个人记忆。遗忘会立即把 profile 标记为 `stale`，从而停止注入旧摘要；随后整合任务重建画像。遗忘记忆不等同于删除原始聊天、媒体或活动反馈记录。

## Context 预算

默认历史上下文预算为 12,000 estimated tokens：

| 区段 | 上限 |
| --- | ---: |
| 最近完整消息（最多 16 条） | 4,000 |
| 对话 checkpoint | 1,000 |
| profileNarrative | 1,200 |
| 相关详细记忆（最多 6 条） | 1,500 |
| 当前意图 / 匹配 / 房间运行态 | 1,000 |

当前用户消息单独传入，并通过 `userMessageId` 从历史消息中排除，避免重复。旧的 `longTermProfile`、`vibeNarrative`、完整多模态记录和反馈数组不再进入 Agent prompt。

## 匹配边界

匹配模型只读取：

- 用户本次明确社交意图的原话。
- 经过治理的 `matchingNarrative`。
- 人工策划游戏的自然语言说明和人数约束。

它不读取原始 profile、详细记忆、多模态原文、兴趣标签、`intentTags`、`traits`、人口属性、关键词计数或分数。`CurrentIntent` 永远优先于长期摘要。

## 当前安全边界

生产 API 已校验 Supabase Bearer access token，并要求请求中的 `userId` 与 token 用户一致；匹配请求、任务和房间读取也会执行所有权或成员校验。新表在数据库层继续对公共角色不可见，详细记忆与隐藏 profile 只允许 service role 后端流程读取。
