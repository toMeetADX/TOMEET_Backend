# TOMEET AdventureX 现场组局技术实施规格

> 2026-07-25 冷启动修订：匹配采用在线贪心竞价，不再以固定用户总数 benchmark 决定是否启动。`waiting` 为实时高意愿，`watching` 为已授权主动推送的次优先状态，`push_consent` 为等待用户授权。30 秒仅是后台清算 tick；只有实际发送 1–3 个通过 `good | excellent` 门槛的候选后才开始 90 秒窗口。没有合格候选时本轮立即结束并如实说明池小或契合度不足，不刷新旧候选；用户同意后可在新用户或开放局出现时通过微信主动推送。虚拟用户池按所有者隔离并仅对白名单账号开放。本文后续旧段落中与本修订冲突的“三个固定候选 / 无候选也进入超时 / 固定池人数门槛”描述均以本修订为准。
>
> 2026-07-25 双向确认修订：用户已经选择但候选最终未成局时，系统必须确认其选择已收到，并以中性事实说明本次安排未完成成局；不得暴露或暗示具体是谁拒绝、未回复，也不得归因为该用户不够合适。当前尝试在窗口结束时明确结束，不自动刷新。未授权用户进入 `push_consent`，已授权用户回到 `watching`；其后续优先级高于普通 `watching`、低于实时 `waiting`，且仍须通过活动最低人数及 `good | excellent` 质量门槛。
>
> 2026-07-25 字符卡片修订：候选邀请和正式成局确认使用无右边框左框字符卡片。卡片保留顶部、底部、左侧竖线与必要分隔线；禁止右侧竖线、右上角、右下角和 Markdown 代码围栏。标题分别为 `TOMEET 组局邀请` 与 `TOMEET 成局确认函`。整张卡片最多使用 2 个克制、功能性的 emoji，例如人数或集合信息提示，不得逐行装饰。外框属于固定呈现协议，正文继续由 Hosted Agent 根据结构化事实和个人上下文生成。
>
> 2026-07-25 成局退出修订：正式成局确认函发出后，用户退出必须在当前消息中给出任意非空理由；只说“退出”或“不去了”时不得执行，只追问一个简单理由。理由不做严格语义审查，仅私下保存，不向其他成员披露。退出后不得询问或自动启动重新匹配：已授权主动推送的原请求变为 `matching/watching`，未授权请求变为 `cancelled`。退出用户不得再次获得同一个开放局。本文后续与“确认函后退出可无理由、退出后询问/自动重新匹配”冲突的旧描述均以本修订为准。

> 状态：待实现  
> 适用范围：AdventureX 活动现场多人组局 V1  
> 目标读者：负责直接实现功能的编码 Agent / 工程师  
> 非目标：1v1 匹配、通用城市社交、时间地点协调、人口属性匹配

## 1. 文档目的

本规格将 AdventureX 现场组局产品方案转换为可以直接编码的技术任务。

实现完成后，系统应支持：

1. 微信新用户进入后，Agent 默认用四个中文短气泡说明可分享文字、社交媒体帖子截图或近期照片；
2. 用户可以直接使用文字，也可以分享图片或录音，图片不是门槛；
3. Agent 围绕用户主动提供的具体内容进行容易回答的追问，并在初步了解结束前宽松问一次雷点或明确边界；
4. Agent 只从用户明确表达的内容中提取可用于匿名局介绍的具体事实；
5. 事实存在具体歧义时，Agent 在自然对话中追问确认，不保存不确定事实；
6. 当信息足够，或用户主动要求立即匹配时，进入 AdventureX 现场组局；
7. 匹配同时考虑人与人、人与活动、整组人与活动；
8. 用户通过文字收到 1–3 个真实合格活动候选；
9. 候选阶段对已确认参与者使用“这里有……”，对尚未确认的潜在参与者使用“你可能遇见……”；
10. 用户通过自然语言选择一个或多个可接受活动；
11. 系统汇总所有人的选择并原子确定最终成员；
12. 成局后重新基于已确认成员生成介绍，使用“这里有人……”；
13. 如果用户明确因为某个人物钩子选择活动，而该人物最终未参加，系统不得静默替换；
14. 匹配窗口超时后本次尝试结束，只有用户明确要求才重新匹配；正式成局后退出则不主动询问重新匹配；
15. 已有确认成员但仍有空位的局，在与用户明显合适时应优先直接展示；
16. 用户确认参加后，活动、成员、集合信息或其关注的人物发生任何用户可见变化时，必须主动通知；
17. 所有对用户的选择、确认、等待、失败和反馈交互都通过 Agent 文字完成。

## 2. 已确认的产品原则

### 2.1 场景边界

- 当前所有用户都处于 AdventureX 活动现场；
- 多人组局不使用时间、地点、距离、年龄、性别等用户硬约束；
- 1v1 匹配未来单独设计，不复用本规格中的无硬约束策略；
- 活动最小/最大人数、成员不能重复等属于系统有效性校验，不属于用户匹配硬约束。

### 2.2 Agent 交互人格

Agent 应像一个天然对用户有好感、认为用户值得认识、愿意认真继续听的人。

这种人格通过以下行为体现：

- 注意具体细节；
- 记得用户前文；
- 对意外细节给出简短真实反应；
- 一次只问一个具体问题；
- 不像面试官一样收集字段；
- 不使用没有事实依据的泛化夸奖。

禁止：

- “你是什么样的人？”
- “你是什么性格？”
- “你喜欢和什么类型的人交朋友？”
- “请说一件最特别的经历。”
- “你好特别”“你好有创造力”等无依据赞美。

推荐：

- “你刚才说只排练了三次就上台了？那场演出最后怎么样？”
- “这个设备是你从零做的，还是在现成方案上改的？”
- “你说‘我们组过乐队’，你也是成员吗？当时负责什么？”

### 2.3 图片与文字的关系

- Agent 的回复和全部业务操作仍通过文字完成；
- 用户首次输入可以是文字、社交媒体帖子截图、近期照片或支持的录音；
- 图片不是门槛，用户可以明确拒绝或完全不发送；
- 图片只用于发现可追问的观察点；
- 图片内容不能直接成为稳定事实或社交钩子；
- 图片中观察到的事实必须经过用户文字确认后才能使用。

### 2.4 社交钩子

社交钩子是用户主动表达、具体、可匿名用于陌生人开场的话题事实，例如：

- 组过乐队并正式演出过；
- 独立做过一款游戏；
- 办过小型展览；
- 连续参加过三场黑客松；
- 带过完全由陌生人组成的团队。

规则：

- 只保存用户明确说过的事实；
- 有歧义时先具体追问；
- 没有确认就不保存；
- 每条钩子必须绑定来源用户消息；
- 不需要 confidence、salience 或永久兴趣分数；
- 不得使用敏感经历、纯情绪倾诉、第三方秘密或模型推断；
- 局文案可以轻量改写，但不能增加原事实中不存在的结果、次数、身份或因果。

### 2.5 匹配基本单位

匹配基本单位为：

~~~text
一个候选局 = 一个活动 + 一组潜在成员
一个最终局 = 一个活动 + 一组明确接受且最终锁定的成员
一个开放局 = 已有明确参加成员、尚有空位、仍可接纳新成员的最终局
~~~

活动不是组人完成后的装饰。算法必须判断人在具体活动中的互动可能性。

## 3. 用户端完整流程

~~~mermaid
stateDiagram-v2
    [*] --> New
    New --> AwaitingImageOrText: Agent 发送开场白
    AwaitingImageOrText --> Exploring: 用户发图或文字
    Exploring --> Exploring: Agent 具体追问
    Exploring --> Waiting: 信息足够
    Exploring --> Waiting: 用户要求直接匹配
    Waiting --> Offered: 收到三个候选活动
    Offered --> Selected: 用户表达接受范围
    Offered --> Waiting: 用户要求换一批
    Offered --> Cancelled: 用户退出
    Offered --> Expired: 候选窗口超时
    Cancelled --> Waiting: 用户同意重新匹配
    Expired --> Waiting: 用户明确要求重新匹配
    Selected --> Formed: 最终成局
    Selected --> Expired: 本轮未成局
    Formed --> Formed: 局发生变化并通知成员
    Formed --> Watching: 用户说明理由退出，且此前已授权主动推送
    Formed --> Cancelled: 用户说明理由退出，且未授权主动推送
    Formed --> Completed: 活动完成
    Completed --> [*]
~~~

### 3.1 开场白

微信首次进入时默认按以下四个中文气泡发送：

> 你好呀👋
>
> 很高兴认识你
>
> 你可以告诉我任何你觉得可以代表你或与你有关的东西，例如朋友圈，小红书等社交媒体帖子的截图，或者最近一段时间记录的有趣的照片
>
> 这样我可以在了解你后帮助你连接AdventureX现场有趣的人和活动

用户明确要求英文时，按以下四个英文气泡重新播放，并保存英文偏好：

> Hi there 👋
>
> Nice to meet you
>
> You can share anything that feels representative of you or connected to you, such as screenshots of posts from WeChat Moments, Xiaohongshu, or other social media, or interesting photos you've taken recently
>
> Once I get to know you, I can help connect you with interesting people and activities at AdventureX

要求：

- 这条首次欢迎语及其英文翻译是明确的硬编码产品例外，MemoryStore 与 Supabase RPC 必须保持完全一致；
- 每句话是一个气泡，普通气泡结尾不使用中文句号或英文句点；
- 消息按语言使用幂等键；
- 用户明确要求英文时保存 `preferred_language=en` 并用四个英文气泡重新播放欢迎语，明确要求切回中文时同理；
- 用户已开始正常对话时不得再次补发；
- 初步了解结束时宽松地问一次有没有雷点、明确边界或不想遇到的情况，并记录 `boundary_prompted_at` 防止重复追问；
- 普通回复由微信发送端按一句话拆成气泡，内容较多时依次渐进发送；字符卡片始终保留为一个气泡。

### 3.2 图片拒绝

用户说“不想发”“不方便发图片”等时：

> 好，那就不发。最近你把时间花得最多的一件事是什么？

不得询问拒绝原因。

### 3.3 图片理解

多模态模型输出必须区分：

- observableDetails：图片中可以直接观察的低风险细节；
- uncertainty：模型不确定的地方；
- suggestedQuestion：一个具体、容易回答的问题；
- reply：最终发给用户的文字回复。

图片理解不得输出用户性格、职业、关系、健康、民族、政治、宗教、性取向等推断。

建议结构：

~~~ts
export const adventurexImageUnderstandingSchema = z.object({
  observableDetails: z.array(z.string().min(1).max(240)).max(5),
  uncertainty: z.array(z.string().min(1).max(240)).max(3),
  suggestedQuestion: z.string().min(1).max(500),
  reply: z.string().min(1).max(2_000)
});
~~~

### 3.4 信息足够

不实现固定问题数量或必填字段。

Agent 可以进入匹配的软判断：

- 能用一两句话准确描述用户近期真实在做或经历的事；
- 能判断至少一种活动可能帮助用户进入互动；
- 最好已有至少一条具体社交钩子。

第三项不是门槛。用户主动要求匹配时必须立即开始。

当软判断已经满足时，Agent 直接说明现有信息已经可以进入匹配阶段，并询问用户是否现在开始。这个询问本身不创建匹配请求，只有用户明确同意后才执行 `start_match`。尚未问过雷点时，可以把雷点入口自然合并进同一个确认问题，避免再增加一轮采访。

Agent 还要结合连续对话判断回答意愿。单次简短但具体的回答不代表不耐烦；回答逐渐变短且含糊、连续跳过问题，或明确表示不想继续回答、想先到这里，才视为退出了解过程的倾向：

- 信息尚不完整，但已有至少一条具体、非敏感、能作为最低匹配依据的事实时，直接询问是否愿意用当前信息开始匹配；
- 完全没有可用于区分候选人与活动的具体事实时，不提供虚假的匹配入口，只沿着用户已表现出的兴趣或最近经历补问一个最关键、最容易回答的问题；
- 没有退出倾向且信息尚不完整时，信息完备性优先，继续问一个基于用户兴趣落点、容易回答且信息量高的问题；
- Agent 主动提出开始匹配时始终等待用户明确同意，不得自行触发 `start_match`。

## 4. 领域模型

### 4.1 OnboardingState

新增用户 AdventureX 引导状态。

~~~ts
export const adventurexOnboardingStageSchema = z.enum([
  "new",
  "awaiting_image_or_text",
  "exploring",
  "ready",
  "matching"
]);

export const adventurexOnboardingStateSchema = z.object({
  userId: idSchema,
  stage: adventurexOnboardingStageSchema,
  imageDeclined: z.boolean(),
  welcomeSentAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime()
});
~~~

建议单独建表，不写入 user_models.current_intent。

### 4.2 SocialHook

~~~ts
export const socialHookSchema = z.object({
  id: idSchema,
  userId: idSchema,
  hookText: z.string().min(1).max(240),
  sourceMessageIds: z.array(idSchema).min(1).max(8),
  status: z.enum(["active", "forgotten"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
~~~

hookText 应保存为适合接在“有人……”之后的第三人称事实短语：

- “组过乐队并正式演出过”
- “独立做过一款像素游戏”

不要保存：

- “用户是一个很有创造力的人”
- “可能组过乐队”
- “喜欢音乐”

### 4.3 MatchRequest

为减少对现有逻辑的破坏，保留现有 status：

- matching
- matched
- cancelled
- expired

新增 phase：

~~~ts
export const matchRequestPhaseSchema = z.enum([
  "waiting",
  "offered",
  "selected",
  "settling",
  "push_consent",
  "watching"
]);
~~~

status=matching 表示请求仍然活跃；phase 描述活跃请求所在阶段。

建议新增字段：

~~~ts
phase: MatchRequestPhase;
proactivePushEnabled: boolean;
activeRoundId: string | null;
optionsExpiresAt: string | null;
~~~

### 4.4 MatchRound

~~~ts
export const matchRoundSchema = z.object({
  roundId: idSchema,
  status: z.enum([
    "scheduled",
    "generating",
    "collecting",
    "settling",
    "completed",
    "expired"
  ]),
  offerExpiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
~~~

一个轮次包含一批现场活跃匹配请求及其候选局。

### 4.5 MatchDraft

MatchDraft 是尚未确定最终成员的候选活动局。

~~~ts
export const matchDraftSchema = z.object({
  draftId: idSchema,
  roundId: idSchema,
  offlineGameId: idSchema,
  status: z.enum(["collecting", "formed", "expired"]),
  version: z.number().int().nonnegative(),
  targetPlayers: z.number().int().min(3).max(10),
  candidateRequestIds: z.array(idSchema).min(3).max(12),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
});
~~~

candidateRequestIds 可以超过活动 maxPlayers，因为它代表潜在成员池，不是最终成员。

### 4.6 MatchOptionOffer

每个用户看到的候选选项必须单独持久化，以保证：

- 用户追问时可以复现；
- 自然语言选择可以映射到稳定 optionNumber；
- 候选钩子可以审计；
- 最终无法偷偷替换用户从未见过的活动。

~~~ts
export const matchOptionOfferSchema = z.object({
  offerId: idSchema,
  requestId: idSchema,
  roundId: idSchema,
  sourceType: z.enum(["draft", "open_room"]),
  draftId: idSchema.nullable(),
  roomId: idSchema.nullable(),
  sourceVersion: z.number().int().nonnegative(),
  optionNumber: z.number().int().min(1).max(3),
  offlineGameId: idSchema,
  previewText: z.string().min(1).max(2_000),
  confirmedHookIds: z.array(idSchema).max(3),
  possibleHookIds: z.array(idSchema).max(3),
  status: z.enum(["offered", "accepted", "rejected", "expired"]),
  createdAt: z.string().datetime(),
  respondedAt: z.string().datetime().nullable()
}).superRefine((value, context) => {
  const validDraft = value.sourceType === "draft" && value.draftId && !value.roomId;
  const validRoom = value.sourceType === "open_room" && value.roomId && !value.draftId;
  if (!validDraft && !validRoom) {
    context.addIssue({ code: "custom", message: "候选来源必须且只能是 draft 或 open_room" });
  }
});
~~~

### 4.7 MatchChoice

一条用户消息可以接受多个选项。

~~~ts
export const matchChoiceSchema = z.object({
  choiceId: idSchema,
  requestId: idSchema,
  roundId: idSchema,
  sourceType: z.enum(["draft", "open_room"]),
  draftId: idSchema.nullable(),
  roomId: idSchema.nullable(),
  preferenceRank: z.number().int().min(1).max(3),
  requiredHookIds: z.array(idSchema).max(3),
  rawUserText: z.string().min(1).max(2_000),
  createdAt: z.string().datetime()
});
~~~

示例：

- “3” => 接受 draft 3，preferenceRank=1；
- “3 优先，1 也行” => draft 3 rank=1，draft 1 rank=2；
- “都可以” => 三个 draft 都接受，按 Agent 推断或相同权重处理；
- “有独立游戏开发者的那个” => 对应 draft rank=1，并写入该 offer 中对应的 hookId。

requiredHookIds 表示：该具体人物事实显著影响用户选择。如果来源成员最终未进入同一局，不得自动完成分配。

open_room offer 表示该局已有确认成员并仍有可加入名额。用户选择后应尝试直接原子加入，而不是等待新一轮 draft 结算。

## 5. 数据库设计

新增一个 migration，例如：

~~~text
supabase/migrations/<timestamp>_adventurex_live_matchmaking_v1.sql
~~~

### 5.1 引导状态

~~~sql
create table public.adventurex_onboarding_states (
  user_id uuid primary key references public.users(id) on delete cascade,
  stage text not null default 'new'
    check (stage in ('new','awaiting_image_or_text','exploring','ready','matching')),
  image_declined boolean not null default false,
  welcome_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
~~~

ensure_tomeet_user 应同时幂等创建该行。

### 5.2 社交钩子

~~~sql
create table public.user_social_hooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  hook_text text not null check (char_length(hook_text) between 1 and 240),
  status text not null default 'active'
    check (status in ('active','forgotten')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, hook_text)
);

create table public.user_social_hook_sources (
  hook_id uuid not null references public.user_social_hooks(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  primary key (hook_id, message_id)
);

create index user_social_hooks_active_idx
  on public.user_social_hooks (user_id, created_at desc)
  where status = 'active';
~~~

### 5.3 扩展匹配请求

~~~sql
alter table public.match_requests
  add column phase text not null default 'waiting'
    check (phase in ('waiting','offered','selected','settling','push_consent','watching')),
  add column proactive_push_enabled boolean not null default false,
  add column active_round_id uuid,
  add column options_expires_at timestamptz;
~~~

active_round_id 外键在 match_rounds 创建后补充。

### 5.4 轮次、候选局和选择

~~~sql
create table public.match_rounds (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'scheduled'
    check (status in ('scheduled','generating','collecting','settling','completed','expired')),
  bucket_key text not null unique,
  offer_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.match_requests
  add constraint match_requests_active_round_fkey
  foreign key (active_round_id) references public.match_rounds(id);

create table public.match_round_requests (
  round_id uuid not null references public.match_rounds(id) on delete cascade,
  request_id uuid not null references public.match_requests(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (round_id, request_id)
);

create table public.match_drafts (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.match_rounds(id) on delete cascade,
  offline_game_id text not null references public.offline_games(id),
  status text not null default 'collecting'
    check (status in ('collecting','formed','expired')),
  version integer not null default 0 check (version >= 0),
  target_players smallint not null check (target_players between 3 and 10),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.match_draft_candidates (
  draft_id uuid not null references public.match_drafts(id) on delete cascade,
  request_id uuid not null references public.match_requests(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (draft_id, request_id),
  unique (draft_id, user_id)
);

create table public.match_option_offers (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.match_requests(id) on delete cascade,
  round_id uuid not null references public.match_rounds(id) on delete cascade,
  source_type text not null check (source_type in ('draft','open_room')),
  draft_id uuid references public.match_drafts(id) on delete cascade,
  room_id uuid references public.match_rooms(id) on delete cascade,
  source_version integer not null check (source_version >= 0),
  option_number smallint not null check (option_number between 1 and 3),
  preview_text text not null check (char_length(preview_text) between 1 and 2000),
  status text not null default 'offered'
    check (status in ('offered','accepted','rejected','expired')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (request_id, round_id, option_number),
  check (
    (source_type = 'draft' and draft_id is not null and room_id is null)
    or
    (source_type = 'open_room' and room_id is not null and draft_id is null)
  )
);

create table public.match_option_offer_hooks (
  offer_id uuid not null references public.match_option_offers(id) on delete cascade,
  hook_id uuid not null references public.user_social_hooks(id),
  source_user_id uuid not null references public.users(id),
  certainty text not null check (certainty in ('confirmed','possible')),
  ordinal smallint not null check (ordinal between 1 and 3),
  primary key (offer_id, hook_id),
  unique (offer_id, ordinal)
);

create table public.match_choices (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.match_requests(id) on delete cascade,
  round_id uuid not null references public.match_rounds(id) on delete cascade,
  source_type text not null check (source_type in ('draft','open_room')),
  draft_id uuid references public.match_drafts(id) on delete cascade,
  room_id uuid references public.match_rooms(id) on delete cascade,
  preference_rank smallint not null check (preference_rank between 1 and 3),
  raw_user_text text not null check (char_length(raw_user_text) between 1 and 2000),
  created_at timestamptz not null default now(),
  check (
    (source_type = 'draft' and draft_id is not null and room_id is null)
    or
    (source_type = 'open_room' and room_id is not null and draft_id is null)
  )
);

create table public.match_choice_required_hooks (
  choice_id uuid not null references public.match_choices(id) on delete cascade,
  hook_id uuid not null references public.user_social_hooks(id),
  source_user_id uuid not null references public.users(id),
  primary key (choice_id, hook_id)
);
~~~

### 5.5 最终房间审计

~~~sql
alter table public.match_rooms
  add column source_draft_id uuid unique references public.match_drafts(id),
  add column target_players smallint check (target_players between 3 and 10),
  add column recruitment_status text not null default 'closed'
    check (recruitment_status in ('open','full','closed')),
  add column version integer not null default 0 check (version >= 0);

alter table public.room_members
  add column participation_status text not null default 'confirmed'
    check (participation_status in ('invited','confirmed','withdrawn')),
  add column withdrawn_at timestamptz;

create table public.room_member_intros (
  room_id uuid not null references public.match_rooms(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  intro_text text not null check (char_length(intro_text) between 1 and 2000),
  created_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table public.room_member_intro_hooks (
  room_id uuid not null,
  user_id uuid not null,
  hook_id uuid not null references public.user_social_hooks(id),
  source_user_id uuid not null references public.users(id),
  ordinal smallint not null check (ordinal between 1 and 3),
  primary key (room_id, user_id, hook_id),
  foreign key (room_id, user_id)
    references public.room_member_intros(room_id, user_id)
    on delete cascade
);

create table public.room_change_events (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.match_rooms(id) on delete cascade,
  room_version integer not null check (room_version > 0),
  change_type text not null check (change_type in (
    'member_joined',
    'member_withdrawn',
    'meeting_changed',
    'room_cancelled',
    'recruitment_closed'
  )),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (room_id, room_version)
);

create table public.room_change_notifications (
  event_id uuid not null references public.room_change_events(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  idempotency_key text not null unique,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create table public.match_draft_change_events (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.match_drafts(id) on delete cascade,
  draft_version integer not null check (draft_version > 0),
  change_type text not null check (change_type in (
    'confirmed_member_joined',
    'confirmed_member_withdrawn',
    'highlighted_possible_member_changed',
    'draft_expired'
  )),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (draft_id, draft_version)
);

create table public.match_draft_change_notifications (
  event_id uuid not null references public.match_draft_change_events(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  idempotency_key text not null unique,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
~~~

最终介绍建议按用户生成，且排除该用户自己的 hook，使“这里有人……”始终指向其他成员。

活动在任意用户确认后视为不可变。若运营必须更换活动，不更新原 room，而是取消原 room、通知全部成员，并创建新的候选要求重新确认。

### 5.6 RPC 与并发要求

必须通过 RPC 或单个数据库事务完成：

1. 锁定待结算 round；
2. 锁定候选 match_requests；
3. 再次校验请求 status=matching；
4. 校验最终成员均接受过对应 draft；
5. 校验 requiredHookIds 的来源成员均在最终组内；
6. 校验成员不重复；
7. 校验活动人数；
8. 创建 match_room；
9. 创建已确认 room_members；
10. 将 match_requests 更新为 matched；
11. 将 draft 更新为 formed；
12. 保存每位成员的最终 intro；
13. 根据实际人数设置 recruitment_status=open/full；
14. 写入 room_change_events 和待发送通知；
15. 返回 roomId。

建议新增：

~~~text
create_or_get_match_round
save_match_round_proposals
save_match_choices
settle_match_round
expire_match_round
join_open_match_room
withdraw_room_member_with_reason
record_room_change
~~~

所有 RPC 只授予 service_role。

settle_match_round 必须使用 source_draft_id 或 source job id 保证幂等。

join_open_match_room 必须：

1. 锁定 room 和用户的 active match_request；
2. 校验 offer.sourceVersion 等于 room.version；
3. 校验 recruitment_status=open；
4. 校验当前确认人数小于 target_players 和活动 maxPlayers；
5. 校验用户明确接受该 open_room offer；
6. 插入 confirmed room_member；
7. 将请求更新为 matched；
8. room.version 加一；
9. 人数达到目标或上限时将 recruitment_status 更新为 full；
10. 重新生成所有成员的个性化 intro；
11. 写入 member_joined change event；
12. 为所有当前确认成员创建通知 outbox。

withdraw_room_member_with_reason 必须保留历史成员行，将 participation_status 改为 withdrawn，并通知所有仍在局内的确认成员。已确认成员必须提供 1–500 字的非空理由，理由保存在 room_members.withdrawal_reason，且不得进入变化事件 payload 或其他成员消息。退出后有空位且活动尚未开始时，可将 recruitment_status 重新设为 open；开放局候选必须排除所有历史成员，包括 withdrawn 成员。

## 6. 契约与 Agent Action

### 6.1 新增 Action

扩展 AgentAction：

~~~ts
export type AgentAction =
  | { type: "start_match"; intent: Record<string, unknown> }
  | {
      type: "select_match_options";
      preferredOptionNumber: 1 | 2 | 3 | null;
      acceptedOptionNumbers: Array<1 | 2 | 3>;
      requiredHookIds: string[];
      rawText: string;
    }
  | { type: "refresh_match_options" }
  | { type: "cancel_match" }
  | { type: "restart_match"; intent: Record<string, unknown> }
  | { type: "leave_room"; reason?: string }
  | { type: "confirm_room" }
  | { type: "complete_room" }
  | {
      type: "submit_feedback";
      peopleFeedback: string;
      gameFeedback: string;
      connectionUserIds: string[];
      nextIntent: string;
    };
~~~

confirm_room 为旧流程兼容保留。AdventureX 新流程中，用户对候选局的选择已经构成参加意愿，最终房间创建时成员直接 confirmed。

### 6.2 Agent Context

上下文新增当前候选：

~~~ts
export interface MatchOptionContext {
  requestId: string;
  roundId: string;
  expiresAt: string;
  options: Array<{
    optionNumber: 1 | 2 | 3;
    offerId: string;
    sourceType: "draft" | "open_room";
    draftId: string | null;
    roomId: string | null;
    sourceVersion: number;
    activityId: string;
    activityName: string;
    previewText: string;
    hooks: Array<{
      hookId: string;
      hookText: string;
      sourceUserId: string;
      certainty: "confirmed" | "possible";
    }>;
  }>;
}
~~~

sourceUserId 和 hookId 只提供给模型做动作映射，不得出现在用户回复正文。

### 6.3 自然语言选择解析

模型必须正确解析：

| 用户文字 | Action |
|---|---|
| “3” | preferred=3, accepted=[3] |
| “3 优先，1 也行” | preferred=3, accepted=[3,1] |
| “都可以” | preferred=null, accepted=[1,2,3]，三项 preferenceRank 均可为 1 |
| “有独立游戏那局” | 选择对应 option，并填 requiredHookIds |
| “第二个再讲点” | 不产生 mutation action，直接补充候选信息 |
| “都没感觉，换一批” | refresh_match_options |
| “不去了” | cancel_match |
| 取消后说“再给我找三个” | restart_match |
| 已成局后只说“我不参加了” | actions=[]，追问一个简单理由 |
| 已成局后说“临时有事，我不参加了” | leave_room，reason="临时有事" |

requiredHookIds 必须来自当前上下文 offer hooks，不能由模型生成任意 ID。

cancel_match 成功后，Agent 可以结合上下文询问：

> 好，我已经帮你退出了。要不要我重新给你找三个新的？

用户回答“要”“重新找”“再来三个”等时输出 restart_match。restart_match 必须创建新的 match_request，不能复活已取消的旧请求，以保留审计历史。

leave_room 成功后不得询问重新匹配。此前已授权主动推送时说明用户回到被动留意状态；未授权时只说明本次组局结束。

## 7. 社交钩子提取

### 7.1 提取时机

每次用户文字消息完成 Agent reply planning 时，同时返回：

~~~ts
export const socialHookDraftSchema = z.object({
  hookText: z.string().min(1).max(240),
  evidenceMessageIds: z.array(idSchema).min(1).max(8)
});
~~~

ConversationInsight 新增：

~~~ts
socialHooks: SocialHookDraft[];
~~~

只保存模型判断为用户明确自述、且不含歧义的事实。

### 7.2 有歧义时

模型不得输出待确认 hook 记录。它应直接在 replyDraft 中提出一个具体问题。

示例：

~~~text
用户：以前我们还组过乐队。
Agent：你也是乐队成员吗？当时负责什么？
~~~

下一轮用户确认后，模型根据两条带 ID 的消息生成 hook，并写入两个 evidenceMessageIds。

### 7.3 Hook Prompt 规则

系统提示必须包含：

- 只能提取用户自己明确做过的事情；
- “我的朋友”“我们团队里有人”不得归属于用户；
- 图片观察不得直接提取；
- 不提取兴趣偏好，例如“喜欢音乐”；
- 不提取抽象人格判断；
- 不提取感情、健康、财务、家庭、政治、宗教等敏感内容；
- 不确定时不要输出 hook，改为在正常回复中具体追问；
- hookText 写成第三人称事实短语。

## 8. LLM 匹配输入与输出

### 8.1 输入

每轮最多读取 24 位等待用户。超过时优先等待最久者。

每位候选仅向匹配模型提供：

~~~ts
{
  requestId: string;
  userId: string;
  currentVibe: string;
  matchingNarrative: string;
  socialHooks: Array<{
    hookId: string;
    hookText: string;
  }>;
  waitingSince: string;
}
~~~

活动输入：

~~~ts
{
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  instructions: string[];
}
~~~

不要向匹配模型提供：

- 人口属性；
- intentTags；
- traits；
- 兴趣标签数组；
- 人格分类；
- 关键词计数；
- 预计算永久兼容分数。

socialHooks 可作为活动和现场互动的辅助信息，但禁止简单按相同名词组人。

### 8.2 Draft Proposal 输出

~~~ts
export const matchRoundProposalSchema = z.object({
  drafts: z.array(z.object({
    tempDraftId: z.string().min(1).max(64),
    offlineGameId: idSchema,
    targetPlayers: z.number().int().min(3).max(10),
    candidateRequestIds: z.array(idSchema).min(3).max(12),
    rationale: z.string().min(1).max(1_000)
  })).min(1).max(30),
  userOptions: z.array(z.object({
    requestId: idSchema,
    tempDraftIds: z.array(z.string()).min(1).max(3)
  }))
});
~~~

要求：

- 每个 tempDraftId 唯一；
- candidateRequestIds 只能来自输入；
- userOptions 中的用户必须属于对应 draft；
- 同一用户最多三个候选；
- 候选足够时，三个 activity 应尽量不同；
- 不足以产生三个真实选项时返回少于三个，不得编造；
- 每个 draft 必须给出人与活动共同作用的 rationale；
- required requester 机制从新流程移除，不再强制每次任务立即包含触发用户并建房。

### 8.3 候选 Hook 选择

候选文案不应让模型自由编造人物经历。

模型只负责从 draft 或 open room 中其他成员的 active socialHooks 选择 hookId，并标记这些成员当前是否已经确认：

~~~ts
export const optionHookSelectionSchema = z.object({
  confirmedHookIds: z.array(idSchema).max(3),
  possibleHookIds: z.array(idSchema).max(3)
});
~~~

程序验证：

- hook 必须 active；
- hook 来源用户属于该 draft；
- hook 来源用户不能是当前查看者；
- 同一来源用户最多选择一条；
- 不得选择用户自己的 hook。
- confirmedHookIds 只能来自已经接受该 draft 的用户，或 open room 中 participation_status=confirmed 的成员；
- possibleHookIds 只能来自尚未确认、但仍属于当前候选池的用户；
- 同一个 hook 不能同时出现在两类中。

previewText 由 Hosted Agent 根据结构化事实和用户上下文生成，并经过独立发布前事实校验。以下仅为事实层级示例，不是生产固定模板：

~~~text
**3｜合作挑战局**
几个人临时分工，共同完成一个现场任务。这里已经有独立做过游戏的人、带过完全由陌生人组成的团队的人确认参加；你还可能遇见做过一款最终用途和最初设想完全不同的产品的人。
~~~

不得让模型脱离结构化 facts 自由增加信息；发布前校验必须删除新增的人物标签、推断和候选状态升级。

可以实现中文列表格式化函数，将 hookText 按确认状态转为：

- 只有确认成员：这里已经有 A 的人、B 的人确认参加。
- 只有潜在成员：你可能遇见 A 的人、B 的人。
- 两者都有：这里已经有 A 的人确认参加；你还可能遇见 B 的人。

“这里有……”只能用于数据库中已经明确接受该 draft 或已在 open room 中确认参加的人。不得仅凭模型判断某人很可能参加就使用确定语气。

## 9. 轮次调度

### 9.1 创建请求

用户 start_match 后：

1. 创建或复用 active match_request；
2. phase=waiting；
3. onboarding stage=matching；
4. 计算下一个 30 秒时间桶；
5. 幂等创建 match_round；
6. 将 request 加入 round；
7. enqueue match_round_generate job，runAt 为时间桶结束时间。

DataStore.EnqueueJobInput 建议新增：

~~~ts
runAt?: string;
~~~

数据库 enqueue_llm_job RPC 同步支持 p_run_at。

### 9.2 生成候选

match_round_generate 使用在线贪心竞价：

1. 锁定 round；
2. 读取本轮 phase=waiting 的实时高意愿请求，并读取全局 phase=watching 且已授权主动推送的次优先请求；
3. 读取 recruitment_status=open 且仍有名额的已有房间；
4. 对每位等待用户先判断是否存在 group activity verdict=good/excellent 的开放局；
5. 合适的开放局直接作为候选选项，且优先于新建空白 draft；
6. 剩余选项调用 draft proposal 模型生成，waiting 优先，watching 只用于补足或形成明显更好的局；
7. 请求少于活动最低人数且没有合适开放局时，不生成虚假候选；
8. 校验 proposal；
9. 对每个 draft 再调用 Group Activity Judge，只保留 good/excellent；
10. 每位用户只保留 1–3 个真实候选，不为凑满三个降低质量；
11. 如无人获得真实候选，本轮立即结束，实时请求进入 push_consent（已授权者回 watching），说明池小或契合度不足，不创建 settle job；
12. 有候选时原子保存 drafts、candidates、offers、offer hooks，并更新请求 phase=offered；
13. 候选消息准备完成后才设置 options_expires_at=发送时刻+90 秒并主动发送；
14. 只有实际保存了 offer 才 enqueue match_round_settle，runAt=offer_expires_at。

开放局候选语义示例（仅说明事实层级，不作为固定模板）：

~~~text
**2｜合作挑战局**
这个局已经有 4 个人确认，还差 1 个位置。这里有组过乐队并正式演出过的人、独立做过游戏的人；你还可能遇见其他正在选择这个活动的人。
~~~

如果开放局当前确认成员已经达到活动可运行人数，用户选择后可以直接尝试加入，不必等待 round 截止时间。

### 9.3 用户选择

用户发普通 Agent 消息：

1. Context 中包含当前 offers；
2. LLM 输出 select_match_options；
3. 程序校验 option number 和 hook IDs；
4. RPC 原子保存 choices；
5. 如果首选为 open_room，立即调用 join_open_match_room；
6. open_room 加入成功则直接返回成局消息；
7. open_room 因满员或版本变化失败时，不静默改派，发送最新状态并重新提供选择；
8. draft 选择则请求 phase=selected；
9. Agent 根据已保存选择和当前对话自然确认已收到；业务代码不得拼固定回复。

如果用户要求换一批：

1. 当前 offers 标记 expired；
2. choices 删除或作废；
3. request phase=waiting；
4. 加入下一 round；
5. 保留原 created_at 作为等待公平依据。

用户主动取消后：

1. 将当前 request 标记 cancelled；
2. 如果已经在确认函后的 room 中，则先取得用户当前消息中的非空退出理由，再执行 leave_room 并产生 room change event；
3. Agent 回复退出结果；
4. room 退出后 Agent 不询问重新匹配；已授权用户回到 watching，未授权用户结束当前请求；
5. 只有用户之后另行明确要求实时匹配时，才按当时状态进入新的或重新激活的匹配流程。

候选窗口到期后：

1. 未授权主动推送的未成局请求标记为 expired；已授权请求回到 watching；两者都清除 active_round_id 和 options_expires_at；
2. 未提交选择时，Agent 必须明确表达候选窗口已经超时且本次匹配结束；
3. 已提交选择但未成局时，Agent 必须明确表达本轮没有成局且本次匹配结束；
4. 不自动 refresh，不自动加入下一 round；
5. Agent 告诉用户如需继续，应明确提出再次匹配；具体措辞由 Agent 结合上下文生成；
6. expired 用户只有明确同意后才创建全新的 match_request；watching 用户保留原请求，等待新候选主动推送。

## 10. 最终组局算法

### 10.1 候选最终组生成

对每个 draft：

1. 找出明确接受该 draft 的用户；
2. 少于 activity.minPlayers：该 draft 本轮不能成局；
3. 在 minPlayers 到 maxPlayers 之间：生成一个候选最终组；
4. 超过 maxPlayers：
   - 优先判断是否可以拆成两个都满足人数的组；
   - 否则使用 beam search 生成若干个 maxPlayers 以内的候选子组；
5. 每个最终组必须只包含接受过该 draft 的用户。

### 10.2 组质量

不保存永久用户兼容分数。

对当前 round 的候选最终组，可以临时计算：

~~~text
GroupUtility =
  GroupActivityQuality
  + PreferenceSatisfaction
  + WaitingFairness
  + MatchedUserCount
  - IsolationRisk
~~~

建议 V1 权重：

- 首选满足：每人 +3；
- 次选满足：每人 +1；
- 等待时间：每等待 30 秒 +0.2，上限 +2；
- 每成功成局一人：+2；
- required hook 缺失：禁止自动选择，不是扣分；
- LLM group activity judge：bad=禁止，acceptable=0，good=2，excellent=4。

权重只用于 V1 初始行为，必须写为配置常量并可调整。

### 10.3 Group Activity Judge

输入为最终候选成员和活动，输出：

~~~ts
export const groupActivityJudgementSchema = z.object({
  verdict: z.enum(["bad", "acceptable", "good", "excellent"]),
  isolationRiskUserIds: z.array(idSchema).max(10),
  reasoning: z.string().min(1).max(1_000)
});
~~~

Judge 只判断：

- 这些人在此活动中是否可能自然参与；
- 活动是否能让成员之间产生互动；
- 是否有人明显缺少进入方式；
- 是否存在单一成员完全主导的风险。

不得输出人格类型、人口属性分析或永久分数。

### 10.4 全局选择

从候选最终组中选择互不重叠的若干组。

V1 可使用：

1. 按 GroupUtility 降序；
2. 贪心加入不冲突组；
3. 对前 100–200 个候选组做有限深度回溯，尝试提升总效用；
4. round 最大 24 人时不需要引入独立优化服务。

必须保证：

- 用户最多进入一个最终局；
- 用户接受过该 draft；
- 活动人数合法；
- required hook 来源用户在同一最终组；
- match_request 仍为 active；
- 最终写入由数据库事务再次校验。

## 11. required hook 处理

当用户说：

> 我要有独立游戏开发者的那个。

Agent 必须将对应 hookId 写入 requiredHookIds。

自动成局条件：

- hook 来源用户也接受同一 draft；
- 来源用户最终被选入同一组。

如果不满足：

- 不得把该用户静默分配到失去此人物的最终局；
- 将用户留在 matching 状态；
- 发送：

> 刚才提到的独立游戏开发者没有确认参加。这个局最后来了另外几个人，我把最终情况发给你，你再决定要不要去。

V1 采用最简单策略：不自动分配该用户，结束本次请求并提示用户可明确要求重新匹配。

后续版本可增加 reconfirmation 状态。

## 12. 最终局介绍

最终房间确定后，为每位用户生成独立介绍：

1. 从同房间其他成员的 active hooks 中选 0–3 条；
2. 不选择用户自己的 hook；
3. 只允许最终成员 hook；
4. 程序确定性拼装；
5. 保存 room_member_intros 和 hook 审计记录；
6. 发送消息。

格式：

~~~text
成局了。

**3｜合作挑战局**
几个人临时分工，共同完成一个现场任务。这里有人独立做过游戏；有人带过完全由陌生人组成的团队；还有人做过一款最后用途和最初设想完全不同的产品。

你们一共 5 个人，去 TOMEET 集合点找「C3」局。
~~~

文案按成员确认状态区分：

| 状态 | 措辞 |
|---|---|
| 候选池中尚未确认的成员 | 你可能遇见…… |
| draft 中已经接受的成员 | 这里已经有……确认参加 |
| open room 中的确认成员 | 这个局已经有……；这里有…… |
| 最终成员已经锁定 | 这里有人…… |

如果没有足够 hook：

- 可以只展示一条；
- 可以只展示活动描述；
- 不得编造补足三条。

### 12.1 已有成员且仍有空位的局

最终局达到活动最低人数后即可成立；如果尚未达到 targetPlayers 或 maxPlayers，可以保持 recruitment_status=open。

新用户进入匹配时，系统必须先检查开放局：

1. 房间活动尚未开始或仍允许加入；
2. recruitment_status=open；
3. 当前确认人数小于 targetPlayers 和活动 maxPlayers；
4. Group Activity Judge 对“现有成员＋新用户＋活动”的判断至少为 good；
5. 用户当前不在其他未完成房间。

满足时直接作为三个候选之一展示：

~~~text
**2｜合作挑战局**
这个局已经有 4 个人确认，还差 1 个位置。这里有组过乐队并正式演出过的人、独立做过游戏的人。
~~~

如果同时还有尚未确认的潜在成员：

~~~text
**2｜合作挑战局**
这个局已经有 3 个人确认。这里有组过乐队并正式演出过的人；你还可能遇见独立做过游戏的人。
~~~

用户接受 open room 后：

- 使用 sourceVersion 做乐观锁；
- 名额仍存在则立即原子加入；
- 加入成功后通知所有原确认成员；
- 名额已满或版本变化时，不自动切换到其他局，先发送最新信息；
- 新成员加入后为所有成员重新生成最终介绍。

### 12.2 用户确认后的变化通知

用户一旦明确接受 draft 或加入 open room，就进入“必须通知变化”的范围。

以下变化必须主动通知全部受影响的已确认用户：

- 新成员确认加入；
- 已确认成员退出；
- 用户曾明确关注的人物退出；
- 房间人数发生变化；
- 集合点、房间编号或其他集合信息变化；
- 局被取消；
- 招募从 open 变为 full 或 closed；
- 已展示为“这里有……”的确认人物发生变化。

活动本身在有人确认后不得直接修改。需要更换活动时，必须取消原局、通知所有成员，并要求用户对新活动重新确认。

一般成员变化通知：

~~~text
合作挑战局有一位新成员确认参加，现在一共 5 个人。这是更新后的局介绍：

**3｜合作挑战局**
几个人临时分工，共同完成一个现场任务。这里有人……
~~~

关注人物退出：

~~~text
你之前在意的“独立做过游戏的人”刚刚退出了这个局。其他成员还在，但这个变化可能影响你当时的选择。你想继续参加，还是让我重新给你找三个？
~~~

通知实现要求：

- 每次用户可见变化必须增加 room.version 或 draft.version；
- 最终房间变化写入 room_change_events；
- 尚在收集意愿的候选局变化写入 match_draft_change_events；
- 为每位受影响用户写入对应 notification outbox；
- 消息使用事件级幂等键，重试不得重复发送；
- 通知中附带更新后的准确介绍；
- 纯内部候选排序变化不通知；
- 尚未确认的潜在成员变化，只有在它改变了用户已经看过的“可能遇见”人物线索时才通知。

## 13. API 设计

用户产品仍只通过 Agent 文字交互。以下 API 用于前端接入、测试和内部可观测性。

### 13.1 开始引导

~~~http
POST /users/:userId/adventurex-onboarding/start
~~~

幂等返回：

~~~json
{
  "state": {
    "stage": "awaiting_image_or_text"
  },
  "message": {
    "content": "欢迎来到 AdventureX……"
  }
}
~~~

### 13.2 获取当前候选

~~~http
GET /match-requests/:requestId/options
~~~

只允许请求所属用户访问。

~~~json
{
  "requestId": "uuid",
  "roundId": "uuid",
  "expiresAt": "2026-07-24T12:00:00.000Z",
  "options": [
    {
      "optionNumber": 1,
      "activity": {
        "id": "game-story-table",
        "name": "故事交换桌"
      },
      "previewText": "**1｜故事交换桌**\n……"
    }
  ]
}
~~~

API 不返回 hookId、sourceUserId 或候选真实成员 ID。

### 13.3 提交结构化选择

主要用于测试或非 Agent 客户端：

~~~http
POST /match-requests/:requestId/choices
~~~

~~~json
{
  "preferredOptionNumber": 3,
  "acceptedOptionNumbers": [3, 1],
  "requiredHookIds": []
}
~~~

当用户说“都可以”时，preferredOptionNumber 为 null。

生产文字入口仍应通过正常 Agent message action 执行。

### 13.4 刷新选项

~~~http
POST /match-requests/:requestId/options/refresh
~~~

### 13.5 取消

复用：

~~~http
POST /match-requests/:requestId/cancel
~~~

取消 waiting、offered、selected、push_consent、watching 阶段均应成功。取消后响应应包含 canRematch=true，Agent 随即询问是否重新匹配，不承诺固定候选数量。

### 13.6 重新匹配

~~~http
POST /match-requests/:requestId/rematch
~~~

行为：

- 只允许原请求所属用户；
- 原请求必须为 cancelled、expired，或用户已通过 leave_room 退出；
- 创建新的 match_request，不复活旧请求；
- 继承当前已知 intentSnapshot，并加入用户最新取消原因；
- 返回新 request 和计划轮次。

### 13.7 退出已确认房间

~~~http
POST /rooms/:roomId/leave
~~~

行为：

- 将 room member 标记为 withdrawn；
- 房间 version 加一；
- 有空位时 recruitment_status 改为 open；
- 通知所有仍确认参加的成员；
- 已确认成员未提供非空 reason 时返回冲突且不退出；
- 理由只写入成员私有审计字段，不进入 room change 通知；
- 给退出用户返回 canRematch=false；
- 已授权主动推送时原请求进入 matching/watching，否则进入 cancelled；
- Agent 不询问重新匹配，且该用户以后不得再次获得同一个 open room。

### 13.8 加入开放局

结构化测试接口：

~~~http
POST /match-requests/:requestId/open-room/:roomId/join
~~~

请求必须携带 offerId 和 sourceVersion。生产文字入口仍由 select_match_options action 调用内部 RPC。

## 14. Job 设计

llmJobTypeSchema 和数据库 check 新增：

~~~text
match_round_generate
match_round_settle
room_change_notify
~~~

可选增加：

~~~text
match_room_intro
~~~

若最终 intro 只进行 hook 选择并由程序拼装，可在 settle job 内完成，不必独立 job。

### 14.1 Job 分区

- 用户对话、图片理解、hook 提取继续 partitionKey=user:<userId>；
- round generate 使用 partitionKey=match-round:<roundId>；
- round settle 使用相同 round partition；
- room change notify 使用 partitionKey=room:<roomId>；
- 多个 round 可并行；
- 同一 round 必须串行。

### 14.2 幂等键

~~~text
match-round-generate:<roundId>
match-round-settle:<roundId>
room-intro:<roomId>:<userId>
adventurex-welcome:<userId>
room-change:<eventId>:<userId>
~~~

## 15. Store 接口改动

DataStore 建议新增：

~~~ts
ensureAdventurexOnboardingState(userId: string): Promise<AdventurexOnboardingState>;
startAdventurexOnboarding(userId: string): Promise<Message>;
updateAdventurexOnboardingState(...): Promise<AdventurexOnboardingState>;

listActiveSocialHooks(userId: string, limit?: number): Promise<SocialHook[]>;
saveSocialHooks(userId: string, hooks: SocialHookDraft[]): Promise<SocialHook[]>;
forgetSocialHook(userId: string, hookId: string): Promise<void>;

createOrGetMatchRound(bucketKey: string, scheduledAt: string): Promise<MatchRound>;
addRequestToRound(roundId: string, requestId: string): Promise<void>;
listRoundCandidates(roundId: string): Promise<MatchCandidate[]>;
saveRoundProposals(...): Promise<MatchOptionOffer[]>;
listCurrentMatchOptions(userId: string): Promise<MatchOptionContext | null>;
saveMatchChoices(...): Promise<void>;
expireMatchOptions(requestId: string): Promise<void>;
settleMatchRound(roundId: string, decisions: FinalRoomDecision[]): Promise<string[]>;
listSuitableOpenRooms(userId: string, limit?: number): Promise<MatchRoom[]>;
joinOpenRoom(requestId: string, offerId: string, sourceVersion: number): Promise<MatchRoom>;
leaveRoom(roomId: string, userId: string): Promise<MatchRoom>;
restartMatch(cancelledRequestId: string): Promise<MatchRequest>;
listPendingRoomChangeNotifications(limit?: number): Promise<RoomChangeNotification[]>;
markRoomChangeNotificationDelivered(eventId: string, userId: string): Promise<void>;
listPendingDraftChangeNotifications(limit?: number): Promise<DraftChangeNotification[]>;
markDraftChangeNotificationDelivered(eventId: string, userId: string): Promise<void>;
getRoomIntro(roomId: string, userId: string): Promise<string | null>;
~~~

EnqueueJobInput 新增 runAt。

MemoryStore 和 SupabaseStore 必须同时实现，保证测试和 DEMO_MODE 可用。

## 16. 包级实施清单

### packages/contracts

- 新增 onboarding schemas；
- 新增 SocialHook；
- 扩展 MatchRequest phase；
- 新增 MatchRound、MatchDraft、MatchOptionOffer、MatchChoice；
- 新增 LLM 输出 schemas；
- 新增 Agent actions；
- 新增 job types。

### packages/data

- 扩展 DataStore；
- 实现 Supabase 映射；
- 实现 MemoryStore 等价行为；
- 新增 round、draft、offer、choice、hook RPC 调用；
- 新增时间戳标准化测试；
- 保证并发和幂等。

### packages/user-model

- 不把 hook 塞进 longTermProfile；
- 提供 hook draft 的轻量校验或辅助函数；
- 继续维护 matchingNarrative；
- 图片观察不得直接成为稳定事实。

### packages/matchmaking

将当前一次性 MatchDecision 流程拆为：

- proposeMatchRound；
- validateMatchRoundProposal；
- generateFinalGroupCandidates；
- selectNonOverlappingGroups；
- validateFinalRoomDecision；
- product-event structured facts；
- Agent-composed candidate preview 与 confirmed intro；

`formatCandidatePreview` 和 `formatConfirmedIntro` 只可保留为测试/示范 harness，不得被生产路径调用。除首次欢迎语外，候选、成局、超时和变化通知均由 Hosted Agent 基于结构化事实生成，并经过选项覆盖与事实边界校验。

保留旧 MockMatchmakingIntelligence 直到新流程测试通过，再删除或标记 legacy。

### packages/game-catalog

- 保留活动名称、description、min/max、instructions；
- 匹配输入不要使用 intentTags 和 traits；
- 确认 AdventureX 实际活动目录；
- 活动 description 必须写清现场真实发生的交互。

### packages/intelligence

- 修改 HostedLlmAgent 的开场与追问人格；
- 扩展多模态图片理解 schema；
- 扩展 ConversationInsight.socialHooks；
- 扩展动作识别；
- 新增 round proposal；
- 新增 group activity judge；
- 新增 hook selection；
- 删除“候选>=3 时必须立即生成一个包含触发用户的最终组”的旧 prompt。

### apps/intelligence-worker

- 处理 match_round_generate；
- 处理 match_round_settle；
- 处理 room_change_notify 和 draft change notification outbox；
- 支持 runAt；
- 对 round job 使用独立 partition；
- 发送候选和最终房间消息；
- 保证重试不会重复发消息。

### apps/api

- onboarding start route；
- options 查询；
- choices 提交；
- refresh；
- rematch；
- open room join；
- confirmed room leave；
- 现有 cancel 扩展；
- 所有资源做用户归属校验；
- OpenAPI 同步更新。

### packages/agent-core

- AgentContext 增加候选 options；
- AgentAction 增加 select/refresh/cancel/restart/leave；
- 对 required hook 做严格 ID 校验；
- Mock 实现覆盖数字、中文序号、人物钩子选择。

### packages/room

- 支持从已明确接受的 choices 直接创建 confirmed room；
- 支持 confirmed room 保持 open 并继续补位；
- 支持成员加入、退出后的 version、intro 重建与通知；
- 支持读取个性化 room intro；
- 保留 complete 和 feedback 流程。

### supabase

- 新 migration；
- RPC；
- 索引；
- service_role grants；
- PGlite migration smoke；
- 并发 settle 测试。

## 17. Prompt 要求

### 17.1 Agent 对话 Prompt

必须明确：

- 你天然对用户有好感和好奇，但不讨好；
- 从用户刚刚提供的具体细节继续；
- 一次最多一个问题；
- 不进行抽象采访；
- 用户要求直接匹配时立即输出 start_match；
- 图片拒绝后不再追问原因；
- 按 `preferredLanguage` 使用中文或英文，用户明确切换语言时输出对应 transition；
- 除字符卡片外，一句话一个段落，普通段落结尾不使用中文句号或英文句点；
- 初步了解结束前宽松问一次雷点或边界，并用 `boundaryPromptedAt` 防止重复；
- 有歧义的具体事实可以顺势确认；
- 不确定事实不能写入 socialHooks。

### 17.2 Match Proposal Prompt

必须明确：

- 当前所有人均在 AdventureX 现场；
- 不考虑时间、地点、人口属性硬约束；
- 同时考虑人与人、人与活动、整组人与活动；
- 活动是互动媒介，不是组人后的附加项；
- 不按兴趣名词重合组人；
- 每个用户最多三个真实候选；
- 不足三个时允许少于三个；
- 输出只能引用输入 ID。

### 17.3 Group Judge Prompt

必须明确：

- 判断人在该活动中是否有进入方式；
- 判断活动能否让成员互相产生互动；
- 关注有人被边缘化的风险；
- 不输出人格类型和人口属性；
- verdict 必须符合 schema。

## 18. 测试要求

### 18.1 单元测试

至少覆盖：

- 图片拒绝后 Agent 转文字且不追问原因；
- 中文与英文欢迎语内容完全一致且按四个气泡发送；
- 普通多句回复逐句发送，结尾句号移除，问号和感叹号保留；
- 字符卡片不拆分，最多接受 2 个克制、功能性的 emoji；
- 雷点问题只在初步了解结束时询问一次；
- 图片观察不直接生成 hook；
- “我们组过乐队”触发澄清而不保存；
- “我是贝斯手，上台演过两次”生成有来源 hook；
- hook 不能引用其他用户消息；
- preview 使用“你可能遇见”；
- final intro 使用“这里有人”；
- preview/final 只使用合法 hook IDs；
- 用户自己的 hook 不出现在自己的 intro；
- “3”解析为只接受 3；
- “3 优先，1 也行”解析为两个 choice；
- “有独立游戏那个”生成 required hook；
- 不存在的 hook ID 被拒绝；
- 同一用户不能进入两个最终组；
- 未接受 draft 的用户不能被建房；
- 人数不符合活动范围时拒绝；
- required hook 来源成员缺失时不自动建房；
- 匹配阶段取消后 Agent 可询问是否重新匹配；确认函后退出必须先取得理由，且退出后不询问重新匹配；
- 同意重新匹配时创建新 request，不复活旧 request；
- 合适的 open room 会优先进入候选；
- open room 文案只对确认成员使用“这里有”；
- 同一候选可同时包含“这里有”和“你还可能遇见”；
- open room sourceVersion 变化时拒绝旧 offer 加入；
- 新成员加入后所有原确认成员收到一次通知；
- 确认成员退出后所有剩余成员收到一次通知；
- 确认成员只说退出但没有理由时不执行；提供任意非空理由后成功退出，且通知不泄露理由；
- 已授权主动推送的退出用户回到 watching，未授权用户变为 cancelled，且不会再次获得同一开放局；
- 用户关注的人物退出时收到明确说明和重新匹配入口；
- 活动在有人确认后不可原地修改；
- 重试不重复发送候选和最终通知。

### 18.2 集成测试

构造至少 12 位用户：

1. 每人创建 request；
2. 创建一个 round；
3. 模型生成多个 drafts；
4. 每人收到 1–3 个 offers；
5. 用户通过自然语言选择；
6. settle 生成至少两个不重叠房间；
7. 所有房间成员均接受对应 draft；
8. request 更新为 matched；
9. 最终 intro 只引用同房间其他成员 hook；
10. 未成局用户标记为 expired，不自动进入下一轮；用户明确要求重新匹配后创建新 request。

### 18.3 并发测试

- 32 个 Worker 同时领取同一 round，只能有一个执行 settle；
- 两个 settle job 重试只能创建一次房间；
- 同一用户出现在多个 draft 时，只能被一个事务锁定；
- 选择提交与 settle 同时发生时，过期边界行为确定；
- refresh 与 settle 并发时不能把用户放进已拒绝候选；
- 旧 match request 和新 round 不得重复占用用户。
- 两人同时抢开放局最后一个名额时只能一人成功；
- open room join 与成员退出并发时 version 校验生效；
- room change notify 重试不会发送重复消息；
- leave_room 与 room settle 并发时不会把已退出用户重新加入。

### 18.4 Prompt 测试

真实模型 smoke 必须验证：

- 图片追问具体且不做敏感推断；
- 模型不使用抽象访谈；
- start_match 可被直接请求触发；
- 三个候选同时考虑活动和人；
- 候选 hook 不被模型改写为更夸张事实；
- 数字、中文序号、人物描述均可映射选择；
- required hook 缺失时模型不会假装人物仍在。

## 19. 可观测性

记录结构化事件，不记录额外敏感推断：

~~~text
adventurex_welcome_sent
adventurex_image_received
adventurex_image_declined
social_hook_saved
match_requested
match_round_generated
match_options_sent
match_option_detail_requested
match_options_refreshed
match_choice_saved
match_round_settled
match_room_formed
required_hook_unavailable
match_rematch_offered
match_restarted
open_room_offered
open_room_joined
room_member_withdrawn
room_change_notified
match_room_completed
~~~

建议指标：

- 图片发送率，但不得以此作为强制优化目标；
- 从进入到 start_match 的中位对话轮数；
- 候选发送后回复率；
- 数字选择、追问、换一批比例；
- round 成局率；
- 选择到成局耗时 P50/P90；
- required hook 选择比例；
- required hook 未兑现比例；
- 取消后重新匹配接受率；
- open room 候选展示率与加入率；
- 用户确认后房间变化次数；
- 房间变化通知成功率和延迟；
- 最终到场率；
- 活动后至少想继续认识一人的比例。

## 20. 回滚与兼容

- 保留现有 immediate matchmaking 代码路径到新流程通过全部测试；
- 使用环境变量切换：

~~~text
ADVENTUREX_MATCHING_V1=true
~~~

- false 时沿用当前单次 LLM 最终建房；
- true 时 start_match 进入 round/offer/choice/settle；
- 新增表不影响旧数据；
- match_requests.status 保持兼容；
- 上线前先对 DEMO_MODE 和开发 Supabase 开启；
- 生产开启后保留快速关闭开关。

## 21. 推荐实施顺序

### 阶段一：数据与契约

- migration；
- contracts；
- Store 接口；
- MemoryStore；
- SupabaseStore；
- RPC 与并发测试。

### 阶段二：图片开场与 Hook

- onboarding；
- 图片理解；
- Agent 人格 prompt；
- social hook 提取与来源；
- 澄清问题测试。

### 阶段三：候选局

- round 调度；
- draft proposal；
- option offers；
- hook selection；
- 确定性候选文案；
- 候选通知。

### 阶段四：文字选择与成局

- Agent action；
- choices；
- required hook；
- final group generation；
- global selection；
- atomic settle；
- 最终介绍。

### 阶段五：反馈、监控与开关

- metrics；
- smoke；
- API/OpenAPI 文档；
- feature flag；
- Railway 环境变量文档。

## 22. 完成定义

功能只有在以下条件全部满足时才算完成：

- 微信新用户默认收到一次四气泡中文欢迎语，明确切换语言时可重新播放对应语言；
- 用户拒绝图片后自然进入文字流程；
- Agent 追问具体、单问题、非问卷化；
- 初步了解结束时只问一次雷点或明确边界；
- 普通回复按一句话一个微信气泡渐进发送，字符卡片保持完整；
- 图片观察不会直接写入社交钩子；
- 所有 hook 均可追溯到用户文字消息；
- 用户可随时要求直接匹配；
- 每个真实候选以活动为标题；
- 候选文案会依据成员确认状态分别使用“这里有”和“你可能遇见”；
- 候选中确认参与者统一使用“这里有”或“这里已经有……确认参加”；
- 候选中未确认参与者统一使用“你可能遇见”或“你还可能遇见”；
- 用户选择通过普通文字完成；
- 用户取消后始终能通过文字重新获得三个候选；
- 合适的已有空缺局能够直接作为候选展示；
- 系统不会将用户放进未接受的活动；
- 最终成员均明确接受对应候选；
- 最终阶段统一使用“这里有人”；
- 最终文案只引用最终成员事实；
- 用户因具体人物选择时，该人物缺失不会被静默替换；
- 用户确认后，成员加入、退出、局取消和集合信息变化都会收到通知；
- 房间变化通知具有幂等和可追溯事件；
- 并发情况下不会重复建房或重复占用用户；
- lint、typecheck、test、build 全部通过；
- docs/api.md、docs/openapi.yaml 和产品流程文档同步更新。

## 23. 明确禁止的实现捷径

- 不得继续让每个 start_match 立即强制生成一个包含触发用户的最终房间；
- 不得只让 LLM 返回最终 memberIds 和 gameId 而跳过用户选择；
- 不得用图片推断的人格、职业或关系生成局简介；
- 不得保存模型不确定的 hook；
- 不得自由改写 hook 产生更戏剧化的事实；
- 不得把三个候选写成三个空泛 vibe 标题；
- 不得把尚未确认的候选成员写成“这里有人”；
- 不得把已确认参加的成员继续写成纯粹的“可能遇见”；
- 不得在最终阶段继续说“你可能遇见”；
- 不得因候选人物退出而静默替换用户明确在意的人；
- 匹配阶段取消可提供重新匹配入口；确认函后退出不得主动提供重新匹配入口；
- 不得忽略已有确认成员且仍有空位的合适房间；
- 不得在用户确认后静默增加、移除或替换成员；
- 不得在有人确认后原地修改活动；
- 不得把用户放进其没有看过或没有接受过的活动；
- 不得以兴趣标签重合代替人、组、活动的联合判断。
