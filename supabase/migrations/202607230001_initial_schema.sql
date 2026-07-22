create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key,
  display_name text not null default '新朋友',
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  rolling_summary text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 20000),
  idempotency_key text,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create table if not exists public.user_models (
  user_id uuid primary key references public.users(id) on delete cascade,
  long_term_profile jsonb not null default '{"interests":[],"interactionStyle":"待了解"}'::jsonb,
  current_intent jsonb not null default '{}'::jsonb,
  social_history jsonb not null default '[]'::jsonb,
  feedback_memory jsonb not null default '[]'::jsonb,
  multimodal_understanding jsonb not null default '{}'::jsonb,
  version integer not null default 0 check (version >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.multimodal_inputs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  input_type text not null check (input_type in ('image', 'audio')),
  storage_path text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 20971520),
  user_hint text,
  understanding jsonb,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists public.offline_games (
  id text primary key,
  name text not null,
  description text not null,
  min_players smallint not null check (min_players >= 3),
  max_players smallint not null check (max_players <= 10 and max_players >= min_players),
  intent_tags text[] not null default '{}',
  traits text[] not null default '{}',
  requirements text[] not null default '{}',
  instructions text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.match_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  intent_snapshot jsonb not null,
  status text not null default 'matching' check (status in ('matching', 'matched', 'cancelled')),
  room_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists match_requests_one_active_per_user
  on public.match_requests (user_id) where status = 'matching';

create table if not exists public.match_rooms (
  id uuid primary key default gen_random_uuid(),
  source_job_id uuid unique,
  offline_game_id text not null references public.offline_games(id),
  match_summary text not null,
  status text not null default 'confirming' check (status in ('confirming', 'confirmed', 'completed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.match_requests
  drop constraint if exists match_requests_room_id_fkey;
alter table public.match_requests
  add constraint match_requests_room_id_fkey foreign key (room_id) references public.match_rooms(id);

create table if not exists public.room_members (
  room_id uuid not null references public.match_rooms(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  confirmed boolean not null default false,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.post_event_feedback (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.match_rooms(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  people_feedback text not null,
  game_feedback text not null,
  connection_user_ids uuid[] not null default '{}',
  next_intent text not null,
  created_at timestamptz not null default now(),
  unique (room_id, user_id)
);

create table if not exists public.llm_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null check (job_type in ('agent_reply', 'multimodal_understanding', 'matchmaking', 'feedback_update')),
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'retry', 'failed')),
  idempotency_key text not null unique,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists messages_user_created_idx on public.messages (user_id, created_at desc);
create index if not exists match_requests_waiting_idx on public.match_requests (created_at) where status = 'matching';
create index if not exists room_members_user_idx on public.room_members (user_id, room_id);
create index if not exists feedback_user_created_idx on public.post_event_feedback (user_id, created_at desc);
create index if not exists llm_jobs_claim_idx on public.llm_jobs (run_at, created_at) where status in ('pending', 'retry');
create index if not exists llm_jobs_stale_idx on public.llm_jobs (locked_at) where status = 'processing';

insert into public.offline_games (
  id, name, description, min_players, max_players, intent_tags, traits, requirements, instructions
) values
  (
    'game-city-clues', '城市线索漫游', '小组沿路线完成观察、交换故事和轻量协作任务，适合第一次见面。', 4, 8,
    array['轻松认识','城市探索','自然交流'], array['低压力','有移动','话题自然产生'],
    array['可步行约 60 分钟','天气适宜'], array['抽取第一条城市线索','两两寻找答案后交换搭档','终点共同完成城市故事卡']
  ),
  (
    'game-story-table', '故事交换桌', '用图片卡和小问题逐步交换真实经历，适合偏安静或重视深度交流的人。', 3, 6,
    array['深度交流','安静','建立连接'], array['室内','节奏稳定','表达友好'],
    array['安静桌面空间','约 75 分钟'], array['每人选择一张近况卡','轮流讲述并由下一位追问','共同完成连接地图']
  ),
  (
    'game-coop-kitchen', '不看菜谱合作厨房', '成员分工完成一道简单料理，通过协作快速熟悉彼此。', 5, 10,
    array['活跃','团队协作','快速破冰'], array['高互动','有共同成果','适合多人'],
    array['可用厨房','提前确认过敏信息'], array['领取角色和食材线索','通过交流拼出步骤','完成后一起用餐复盘']
  )
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  min_players = excluded.min_players,
  max_players = excluded.max_players,
  intent_tags = excluded.intent_tags,
  traits = excluded.traits,
  requirements = excluded.requirements,
  instructions = excluded.instructions,
  updated_at = now();

create or replace function public.ensure_tomeet_user(p_user_id uuid, p_display_name text default '新朋友')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into users (id, display_name) values (p_user_id, coalesce(nullif(p_display_name, ''), '新朋友'))
  on conflict (id) do update set
    display_name = case when excluded.display_name <> '新朋友' then excluded.display_name else users.display_name end,
    updated_at = now();
  insert into conversations (user_id) values (p_user_id) on conflict (user_id) do nothing;
  insert into user_models (user_id) values (p_user_id) on conflict (user_id) do nothing;
end;
$$;

create or replace function public.append_agent_message(
  p_user_id uuid,
  p_role text,
  p_content text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation_id uuid;
  v_row messages%rowtype;
begin
  if p_role not in ('user', 'assistant') then raise exception '无效的消息角色' using errcode = 'P0001'; end if;
  if char_length(p_content) < 1 or char_length(p_content) > 20000 then raise exception '消息长度无效' using errcode = 'P0001'; end if;
  perform ensure_tomeet_user(p_user_id, '新朋友');
  select id into v_conversation_id from conversations where user_id = p_user_id;
  insert into messages (conversation_id, user_id, role, content, idempotency_key)
  values (v_conversation_id, p_user_id, p_role, p_content, p_idempotency_key)
  on conflict (user_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.create_match_request(p_user_id uuid, p_intent_snapshot jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row match_requests%rowtype;
begin
  if p_intent_snapshot is null or p_intent_snapshot = '{}'::jsonb then
    raise exception '必须先确认本次社交意图' using errcode = 'P0001';
  end if;
  perform ensure_tomeet_user(p_user_id, '新朋友');
  insert into match_requests (user_id, intent_snapshot)
  values (p_user_id, p_intent_snapshot)
  on conflict (user_id) where status = 'matching' do nothing
  returning * into v_row;
  if v_row.id is null then
    select * into v_row from match_requests where user_id = p_user_id and status = 'matching';
  end if;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.cancel_match_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row match_requests%rowtype;
begin
  select * into v_row from match_requests where id = p_request_id for update;
  if not found then raise exception '匹配请求不存在' using errcode = 'P0002'; end if;
  if v_row.status = 'matched' then raise exception '已匹配的请求不能取消' using errcode = 'P0001'; end if;
  update match_requests set status = 'cancelled', updated_at = now() where id = p_request_id returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.list_match_candidates(p_limit integer default 50)
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('request', to_jsonb(mr), 'user_model', to_jsonb(um))
  from match_requests mr
  join user_models um on um.user_id = mr.user_id
  where mr.status = 'matching'
  order by mr.created_at
  limit least(greatest(p_limit, 1), 100);
$$;

create or replace function public.create_match_room(p_decision jsonb, p_source_job_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member_ids uuid[];
  v_request_ids uuid[];
  v_game_id text;
  v_summary text;
  v_count integer;
  v_room_id uuid;
  v_min smallint;
  v_max smallint;
  v_required_request_id uuid;
begin
  if p_source_job_id is not null then
    select id into v_room_id from match_rooms where source_job_id = p_source_job_id;
    if found then return v_room_id; end if;
  end if;
  select array_agg(value::uuid order by ordinality) into v_member_ids
  from jsonb_array_elements_text(p_decision->'memberIds') with ordinality;
  select array_agg(value::uuid order by ordinality) into v_request_ids
  from jsonb_array_elements_text(p_decision->'requestIds') with ordinality;
  v_game_id := p_decision->>'offlineGameId';
  v_summary := nullif(p_decision->>'summary', '');
  v_count := coalesce(array_length(v_member_ids, 1), 0);

  if p_source_job_id is not null then
    select nullif(payload->>'requestId', '')::uuid into v_required_request_id
    from llm_jobs where id = p_source_job_id;
    if v_required_request_id is not null and not (v_required_request_id = any(v_request_ids)) then
      raise exception '匹配结果必须包含触发本次任务的用户' using errcode = 'P0001';
    end if;
  end if;

  if v_count < 3 or v_count > 10 or array_length(v_request_ids, 1) <> v_count then
    raise exception '匹配人数或请求数量无效' using errcode = 'P0001';
  end if;
  if (select count(distinct x) from unnest(v_member_ids) x) <> v_count
     or (select count(distinct x) from unnest(v_request_ids) x) <> v_count then
    raise exception '成员或匹配请求存在重复' using errcode = 'P0001';
  end if;

  perform 1 from match_requests where id = any(v_request_ids) order by id for update;
  if (select count(*) from match_requests where id = any(v_request_ids) and status = 'matching') <> v_count then
    raise exception '部分匹配请求已不在等待中' using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from unnest(v_request_ids, v_member_ids) as pair(request_id, member_id)
    left join match_requests mr on mr.id = pair.request_id
    where mr.user_id is distinct from pair.member_id
  ) then
    raise exception '成员和匹配请求不对应' using errcode = 'P0001';
  end if;

  select min_players, max_players into v_min, v_max from offline_games where id = v_game_id and active for share;
  if not found then raise exception '线下游戏不存在或已停用' using errcode = 'P0001'; end if;
  if v_count < v_min or v_count > v_max then raise exception '线下游戏不支持当前人数' using errcode = 'P0001'; end if;

  insert into match_rooms (source_job_id, offline_game_id, match_summary)
  values (p_source_job_id, v_game_id, coalesce(v_summary, '已根据本次社交意图完成匹配')) returning id into v_room_id;
  insert into room_members (room_id, user_id, confirmed, confirmed_at)
  select v_room_id, member_id, u.is_demo, case when u.is_demo then now() else null end
  from unnest(v_member_ids) member_id join users u on u.id = member_id;
  update match_requests set status = 'matched', room_id = v_room_id, updated_at = now()
  where id = any(v_request_ids);
  return v_room_id;
end;
$$;

create or replace function public.get_match_room(p_room_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'roomId', mr.id,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', rm.user_id,
        'displayName', u.display_name,
        'confirmed', rm.confirmed
      ) order by rm.created_at)
      from room_members rm join users u on u.id = rm.user_id where rm.room_id = mr.id
    ), '[]'::jsonb),
    'offlineGame', jsonb_build_object(
      'id', og.id, 'name', og.name, 'description', og.description,
      'minPlayers', og.min_players, 'maxPlayers', og.max_players,
      'intentTags', to_jsonb(og.intent_tags), 'traits', to_jsonb(og.traits),
      'requirements', to_jsonb(og.requirements), 'instructions', to_jsonb(og.instructions)
    ),
    'matchSummary', mr.match_summary,
    'status', mr.status,
    'createdAt', mr.created_at,
    'completedAt', mr.completed_at
  )
  from match_rooms mr join offline_games og on og.id = mr.offline_game_id
  where mr.id = p_room_id;
$$;

create or replace function public.confirm_room_member(p_room_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_status text;
begin
  select status into v_status from match_rooms where id = p_room_id for update;
  if not found then raise exception '房间不存在' using errcode = 'P0002'; end if;
  if v_status = 'completed' then raise exception '活动已完成' using errcode = 'P0001'; end if;
  update room_members set confirmed = true, confirmed_at = coalesce(confirmed_at, now())
  where room_id = p_room_id and user_id = p_user_id;
  if not found then raise exception '用户不在房间中' using errcode = 'P0001'; end if;
  if not exists (select 1 from room_members where room_id = p_room_id and not confirmed) then
    update match_rooms set status = 'confirmed' where id = p_room_id;
  end if;
  return get_match_room(p_room_id);
end;
$$;

create or replace function public.complete_match_room(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_status text;
begin
  select status into v_status from match_rooms where id = p_room_id for update;
  if not found then raise exception '房间不存在' using errcode = 'P0002'; end if;
  if exists (select 1 from room_members where room_id = p_room_id and not confirmed) then
    raise exception '所有成员确认后才能完成活动' using errcode = 'P0001';
  end if;
  update match_rooms set status = 'completed', completed_at = coalesce(completed_at, now()) where id = p_room_id;
  return get_match_room(p_room_id);
end;
$$;

create or replace function public.save_post_event_feedback(p_feedback jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid := (p_feedback->>'roomId')::uuid;
  v_user_id uuid := (p_feedback->>'userId')::uuid;
  v_id uuid;
  v_connections uuid[];
begin
  perform 1 from match_rooms where id = v_room_id and status = 'completed';
  if not found then raise exception '活动完成后才能提交反馈' using errcode = 'P0001'; end if;
  perform 1 from room_members where room_id = v_room_id and user_id = v_user_id;
  if not found then raise exception '用户不在房间中' using errcode = 'P0001'; end if;
  select coalesce(array_agg(value::uuid), '{}') into v_connections
  from jsonb_array_elements_text(coalesce(p_feedback->'connectionUserIds', '[]'::jsonb));
  insert into post_event_feedback (
    room_id, user_id, people_feedback, game_feedback, connection_user_ids, next_intent
  ) values (
    v_room_id, v_user_id, p_feedback->>'peopleFeedback', p_feedback->>'gameFeedback', v_connections, p_feedback->>'nextIntent'
  ) on conflict (room_id, user_id) do update set
    people_feedback = excluded.people_feedback,
    game_feedback = excluded.game_feedback,
    connection_user_ids = excluded.connection_user_ids,
    next_intent = excluded.next_intent
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.enqueue_llm_job(
  p_job_type text,
  p_payload jsonb,
  p_idempotency_key text,
  p_max_attempts integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row llm_jobs%rowtype;
begin
  insert into llm_jobs (job_type, payload, idempotency_key, max_attempts)
  values (p_job_type, p_payload, p_idempotency_key, least(greatest(p_max_attempts, 1), 10))
  on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.claim_llm_job(p_worker_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row llm_jobs%rowtype;
begin
  update llm_jobs
  set status = 'retry', locked_at = null, locked_by = null, error = coalesce(error, '任务锁超时'), updated_at = now()
  where status = 'processing' and locked_at < now() - interval '5 minutes';

  with candidate as (
    select id from llm_jobs
    where status in ('pending', 'retry') and run_at <= now()
    order by run_at, created_at
    for update skip locked
    limit 1
  )
  update llm_jobs j
  set status = 'processing', attempts = attempts + 1, locked_at = now(), locked_by = p_worker_id, updated_at = now()
  from candidate c where j.id = c.id
  returning j.* into v_row;
  if v_row.id is null then return null; end if;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.complete_llm_job(p_job_id uuid, p_result jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update llm_jobs set status = 'completed', result = p_result, error = null, locked_at = null, locked_by = null, updated_at = now()
  where id = p_job_id and status = 'processing';
  if not found then raise exception '任务不存在或状态已变化' using errcode = 'P0001'; end if;
end;
$$;

create or replace function public.fail_llm_job(p_job_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update llm_jobs set
    status = case when attempts >= max_attempts then 'failed' else 'retry' end,
    run_at = case when attempts >= max_attempts then run_at else now() + make_interval(secs => least(60, power(2, attempts)::integer)) end,
    error = left(p_error, 4000), locked_at = null, locked_by = null, updated_at = now()
  where id = p_job_id and status = 'processing';
  if not found then raise exception '任务不存在或状态已变化' using errcode = 'P0001'; end if;
end;
$$;

alter table public.users enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.user_models enable row level security;
alter table public.multimodal_inputs enable row level security;
alter table public.offline_games enable row level security;
alter table public.match_requests enable row level security;
alter table public.match_rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.post_event_feedback enable row level security;
alter table public.llm_jobs enable row level security;

revoke all on function public.ensure_tomeet_user(uuid, text) from public, anon, authenticated;
revoke all on function public.append_agent_message(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.create_match_request(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.cancel_match_request(uuid) from public, anon, authenticated;
revoke all on function public.list_match_candidates(integer) from public, anon, authenticated;
revoke all on function public.create_match_room(jsonb, uuid) from public, anon, authenticated;
revoke all on function public.get_match_room(uuid) from public, anon, authenticated;
revoke all on function public.confirm_room_member(uuid, uuid) from public, anon, authenticated;
revoke all on function public.complete_match_room(uuid) from public, anon, authenticated;
revoke all on function public.save_post_event_feedback(jsonb) from public, anon, authenticated;
revoke all on function public.enqueue_llm_job(text, jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.claim_llm_job(text) from public, anon, authenticated;
revoke all on function public.complete_llm_job(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fail_llm_job(uuid, text) from public, anon, authenticated;
grant execute on function public.ensure_tomeet_user(uuid, text) to service_role;
grant execute on function public.append_agent_message(uuid, text, text, text) to service_role;
grant execute on function public.create_match_request(uuid, jsonb) to service_role;
grant execute on function public.cancel_match_request(uuid) to service_role;
grant execute on function public.list_match_candidates(integer) to service_role;
grant execute on function public.create_match_room(jsonb, uuid) to service_role;
grant execute on function public.get_match_room(uuid) to service_role;
grant execute on function public.confirm_room_member(uuid, uuid) to service_role;
grant execute on function public.complete_match_room(uuid) to service_role;
grant execute on function public.save_post_event_feedback(jsonb) to service_role;
grant execute on function public.enqueue_llm_job(text, jsonb, text, integer) to service_role;
grant execute on function public.claim_llm_job(text) to service_role;
grant execute on function public.complete_llm_job(uuid, jsonb) to service_role;
grant execute on function public.fail_llm_job(uuid, text) to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tomeet-multimodal', 'tomeet-multimodal', false, 20971520, array['image/jpeg','image/png','image/webp','audio/mpeg','audio/mp4','audio/webm'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
