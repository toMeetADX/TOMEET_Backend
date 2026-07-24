-- Consolidate only records that represent the same business fact.
-- conversations/messages and the two memory layers intentionally remain separate.

alter table public.messages
  add column if not exists source_channel text not null default 'legacy'
    check (source_channel in ('web','wechat','system','legacy')),
  add column if not exists reply_to_message_id uuid
    references public.messages(id) on delete set null;

create index if not exists messages_user_channel_created_idx
  on public.messages (user_id, source_channel, created_at desc);

alter table public.users
  add column if not exists vibe_narrative text not null default ''
    check (char_length(vibe_narrative) <= 12000),
  add column if not exists long_term_profile jsonb not null
    default '{"interests":[],"interactionStyle":"待了解"}'::jsonb,
  add column if not exists current_intent jsonb not null default '{}'::jsonb,
  add column if not exists social_history jsonb not null default '[]'::jsonb,
  add column if not exists feedback_memory jsonb not null default '[]'::jsonb,
  add column if not exists multimodal_understanding jsonb not null default '{}'::jsonb,
  add column if not exists user_model_version integer not null default 0
    check (user_model_version >= 0),
  add column if not exists user_model_updated_at timestamptz not null default now(),
  add column if not exists adventurex_stage text not null default 'new'
    check (adventurex_stage in ('new','awaiting_image_or_text','exploring','ready','matching')),
  add column if not exists adventurex_image_declined boolean not null default false,
  add column if not exists adventurex_preferred_language text not null default 'zh'
    check (adventurex_preferred_language in ('zh','en')),
  add column if not exists adventurex_boundary_prompted_at timestamptz,
  add column if not exists adventurex_welcome_sent_at timestamptz,
  add column if not exists adventurex_state_created_at timestamptz not null default now(),
  add column if not exists adventurex_state_updated_at timestamptz not null default now();

update public.users u
set vibe_narrative = m.vibe_narrative,
    long_term_profile = m.long_term_profile,
    current_intent = m.current_intent,
    social_history = m.social_history,
    feedback_memory = m.feedback_memory,
    multimodal_understanding = m.multimodal_understanding,
    user_model_version = m.version,
    user_model_updated_at = m.updated_at
from public.user_models m
where m.user_id = u.id;

update public.users u
set adventurex_stage = s.stage,
    adventurex_image_declined = s.image_declined,
    adventurex_preferred_language = s.preferred_language,
    adventurex_boundary_prompted_at = s.boundary_prompted_at,
    adventurex_welcome_sent_at = s.welcome_sent_at,
    adventurex_state_created_at = s.created_at,
    adventurex_state_updated_at = s.updated_at
from public.adventurex_onboarding_states s
where s.user_id = u.id;

-- Existing iLink connections created before identity linking are repaired so Web and
-- WeChat resolve to the same users row and therefore share state and memory.
insert into public.channel_identities (
  provider, external_user_id, user_id, display_name, metadata
)
select
  'wechat', c.owner_ilink_user_id, c.user_id, u.display_name,
  jsonb_build_object('transport','ilink','backfilled',true)
from public.wechat_ilink_connections c
join public.users u on u.id = c.user_id
on conflict do nothing;

do $$
begin
  if exists (
    select 1
    from public.wechat_ilink_connections c
    left join public.channel_identities i
      on i.provider = 'wechat'
     and i.external_user_id = c.owner_ilink_user_id
     and i.user_id = c.user_id
    where i.id is null
  ) then
    raise exception '微信连接与渠道身份存在冲突，停止共享数据迁移';
  end if;
end;
$$;

update public.messages
set source_channel = 'wechat'
where role = 'user'
  and idempotency_key like 'wechat:%';

update public.messages m
set source_channel = 'system'
where exists (
  select 1 from public.wechat_outbound_messages o where o.message_id = m.id
);

create table public.channel_message_deliveries (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('wechat')),
  direction text not null check (direction in ('inbound','outbound')),
  connection_id uuid references public.wechat_ilink_connections(id) on delete cascade,
  external_message_id text check (
    external_message_id is null or char_length(external_message_id) between 1 and 255
  ),
  message_id uuid references public.messages(id) on delete cascade,
  payload_override text check (
    payload_override is null or char_length(payload_override) between 1 and 20000
  ),
  status text not null check (status in (
    'pending','processing','retry','completed','sent','failed'
  )),
  attempts integer not null default 0 check (attempts between 0 and 10),
  run_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  completed_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (direction = 'inbound' and connection_id is not null and external_message_id is not null and message_id is null)
    or (direction = 'outbound' and external_message_id is null and message_id is not null)
  )
);

create unique index channel_message_deliveries_inbound_key
  on public.channel_message_deliveries (provider, connection_id, external_message_id)
  where direction = 'inbound';

create unique index channel_message_deliveries_outbound_key
  on public.channel_message_deliveries (provider, message_id)
  where direction = 'outbound';

create index channel_message_deliveries_claim_idx
  on public.channel_message_deliveries (provider, direction, status, run_at, created_at)
  where direction = 'outbound' and status in ('pending','retry','processing');

insert into public.channel_message_deliveries (
  provider, direction, connection_id, external_message_id, status,
  completed_at, last_error, created_at, updated_at
)
select
  'wechat', 'inbound', connection_id, message_id, status,
  completed_at, error, created_at, updated_at
from public.wechat_message_receipts
on conflict do nothing;

insert into public.channel_message_deliveries (
  id, provider, direction, message_id, payload_override, status, attempts,
  run_at, locked_by, locked_at, completed_at, last_error, created_at, updated_at
)
select
  o.id, 'wechat', 'outbound', o.message_id,
  case when o.content is distinct from m.content then o.content else null end,
  o.status, o.attempts, o.run_at, o.locked_by, o.locked_at, o.sent_at,
  o.last_error, o.created_at, o.updated_at
from public.wechat_outbound_messages o
join public.messages m on m.id = o.message_id
on conflict do nothing;

drop function if exists public.start_adventurex_onboarding(uuid,text);
drop function if exists public.start_adventurex_onboarding(uuid);
drop function if exists public.update_adventurex_onboarding_state(uuid,text,boolean,text,boolean);
drop function if exists public.update_adventurex_onboarding_state(uuid,text,boolean);
drop function if exists public.append_agent_message(uuid,text,text,text);
drop function if exists public.begin_wechat_message(uuid,text);
drop function if exists public.enqueue_wechat_outbound_message(uuid,uuid,text);
drop function if exists public.claim_wechat_outbound_messages(text,integer);
drop function if exists public.complete_wechat_outbound_message(uuid,text,text);

drop table public.user_models;
drop table public.adventurex_onboarding_states;
drop table public.wechat_message_receipts;
drop table public.wechat_outbound_messages;

-- Compatibility views keep rolling API/worker deployments functional while the
-- application switches direct reads to users and the consolidated delivery ledger.
create view public.user_models as
select
  id as user_id,
  long_term_profile,
  current_intent,
  social_history,
  feedback_memory,
  multimodal_understanding,
  user_model_version as version,
  user_model_updated_at as updated_at,
  vibe_narrative
from public.users;

create view public.adventurex_onboarding_states as
select
  id as user_id,
  adventurex_stage as stage,
  adventurex_image_declined as image_declined,
  adventurex_welcome_sent_at as welcome_sent_at,
  adventurex_state_created_at as created_at,
  adventurex_state_updated_at as updated_at,
  adventurex_preferred_language as preferred_language,
  adventurex_boundary_prompted_at as boundary_prompted_at
from public.users;

create view public.wechat_message_receipts as
select
  connection_id,
  external_message_id as message_id,
  status,
  last_error as error,
  completed_at,
  created_at,
  updated_at
from public.channel_message_deliveries
where provider = 'wechat' and direction = 'inbound';

create view public.wechat_outbound_messages as
select
  d.id,
  m.user_id,
  d.message_id,
  coalesce(d.payload_override, m.content) as content,
  d.status,
  d.attempts,
  d.run_at,
  d.locked_by,
  d.locked_at,
  d.completed_at as sent_at,
  d.last_error,
  d.created_at,
  d.updated_at
from public.channel_message_deliveries d
join public.messages m on m.id = d.message_id
where d.provider = 'wechat' and d.direction = 'outbound';

create or replace function public.ensure_tomeet_user(
  p_user_id uuid,
  p_display_name text default '新朋友'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into users (id, display_name)
  values (p_user_id, coalesce(nullif(p_display_name, ''), '新朋友'))
  on conflict (id) do update set
    display_name = case
      when excluded.display_name <> '新朋友' then excluded.display_name
      else users.display_name
    end,
    updated_at = now();
  insert into conversations (user_id) values (p_user_id) on conflict (user_id) do nothing;
  insert into user_memory_profiles (user_id) values (p_user_id) on conflict (user_id) do nothing;
end;
$$;

create function public.append_agent_message(
  p_user_id uuid,
  p_role text,
  p_content text,
  p_idempotency_key text,
  p_source_channel text,
  p_reply_to_message_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row messages%rowtype;
  v_conversation_id uuid;
begin
  if p_role not in ('user','assistant') then
    raise exception '无效的消息角色' using errcode = 'P0001';
  end if;
  if p_source_channel not in ('web','wechat','system','legacy') then
    raise exception '无效的消息来源渠道' using errcode = 'P0001';
  end if;
  if char_length(p_content) < 1 or char_length(p_content) > 20000 then
    raise exception '消息长度无效' using errcode = 'P0001';
  end if;
  perform ensure_tomeet_user(p_user_id, '新朋友');
  select id into v_conversation_id from conversations where user_id = p_user_id;
  if p_reply_to_message_id is not null and not exists (
    select 1 from messages where id = p_reply_to_message_id and user_id = p_user_id
  ) then
    raise exception '回复引用的消息不属于当前用户' using errcode = 'P0001';
  end if;
  insert into messages (
    conversation_id, user_id, role, content, idempotency_key,
    source_channel, reply_to_message_id
  ) values (
    v_conversation_id, p_user_id, p_role, p_content, p_idempotency_key,
    p_source_channel, p_reply_to_message_id
  )
  on conflict (user_id, idempotency_key) do update
    set idempotency_key = excluded.idempotency_key
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

create function public.append_agent_message(
  p_user_id uuid,
  p_role text,
  p_content text,
  p_idempotency_key text default null
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.append_agent_message(
    p_user_id, p_role, p_content, p_idempotency_key, 'legacy', null::uuid
  )
$$;

create or replace function public.adventurex_onboarding_state(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'user_id', id,
    'stage', adventurex_stage,
    'image_declined', adventurex_image_declined,
    'preferred_language', adventurex_preferred_language,
    'boundary_prompted_at', adventurex_boundary_prompted_at,
    'welcome_sent_at', adventurex_welcome_sent_at,
    'created_at', adventurex_state_created_at,
    'updated_at', adventurex_state_updated_at
  )
  from users where id = p_user_id
$$;

create function public.start_adventurex_onboarding(
  p_user_id uuid,
  p_language text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message messages%rowtype;
  v_idempotency_key text;
  v_content text;
begin
  if p_language is null or p_language not in ('zh','en') then
    raise exception '无效的引导语言' using errcode = 'P0001';
  end if;
  perform ensure_tomeet_user(p_user_id, '新朋友');
  perform 1 from users where id = p_user_id for update;
  v_idempotency_key := 'adventurex-welcome:' || p_language || ':' || p_user_id::text;
  select * into v_message from messages
  where user_id = p_user_id and idempotency_key = v_idempotency_key;
  if found then
    update users set
      adventurex_preferred_language = p_language,
      adventurex_stage = case when adventurex_stage = 'new' then 'awaiting_image_or_text' else adventurex_stage end,
      adventurex_welcome_sent_at = coalesce(adventurex_welcome_sent_at, v_message.created_at),
      adventurex_state_updated_at = now()
    where id = p_user_id;
    return jsonb_build_object('message',to_jsonb(v_message),'state',adventurex_onboarding_state(p_user_id));
  end if;
  perform 1 from messages where user_id = p_user_id limit 1;
  if found then
    update users set
      adventurex_preferred_language = p_language,
      adventurex_stage = case when adventurex_stage in ('new','awaiting_image_or_text') then 'exploring' else adventurex_stage end,
      adventurex_state_updated_at = now()
    where id = p_user_id;
    return jsonb_build_object('message',null,'state',adventurex_onboarding_state(p_user_id));
  end if;
  v_content := case p_language
    when 'en' then E'Hi there 👋\n\nNice to meet you\n\nYou can share anything that feels representative of you or connected to you, such as screenshots of posts from WeChat Moments, Xiaohongshu, or other social media, or interesting photos you''ve taken recently\n\nOnce I get to know you, I can help connect you with interesting people and activities at AdventureX'
    else E'你好呀👋\n\n很高兴认识你\n\n你可以告诉我任何你觉得可以代表你或与你有关的东西，例如朋友圈，小红书等社交媒体帖子的截图，或者最近一段时间记录的有趣的照片\n\n这样我可以在了解你后帮助你连接AdventureX现场有趣的人和活动'
  end;
  select * into v_message from jsonb_populate_record(null::messages, append_agent_message(
    p_user_id, 'assistant', v_content, v_idempotency_key, 'system', null::uuid
  ));
  update users set
    adventurex_stage = 'awaiting_image_or_text',
    adventurex_preferred_language = p_language,
    adventurex_welcome_sent_at = now(),
    adventurex_state_updated_at = now()
  where id = p_user_id;
  return jsonb_build_object('message',to_jsonb(v_message),'state',adventurex_onboarding_state(p_user_id));
end;
$$;

create function public.start_adventurex_onboarding(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$ select public.start_adventurex_onboarding(p_user_id,'zh') $$;

create function public.update_adventurex_onboarding_state(
  p_user_id uuid,
  p_stage text,
  p_image_declined boolean,
  p_preferred_language text,
  p_boundary_prompted boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform ensure_tomeet_user(p_user_id, '新朋友');
  if p_stage is not null and p_stage not in ('new','awaiting_image_or_text','exploring','ready','matching') then
    raise exception '无效的引导阶段' using errcode = 'P0001';
  end if;
  if p_preferred_language is not null and p_preferred_language not in ('zh','en') then
    raise exception '无效的引导语言' using errcode = 'P0001';
  end if;
  update users set
    adventurex_stage = coalesce(p_stage, adventurex_stage),
    adventurex_image_declined = coalesce(p_image_declined, adventurex_image_declined),
    adventurex_preferred_language = coalesce(p_preferred_language, adventurex_preferred_language),
    adventurex_boundary_prompted_at = case
      when coalesce(p_boundary_prompted,false) and adventurex_boundary_prompted_at is null then now()
      else adventurex_boundary_prompted_at
    end,
    adventurex_state_updated_at = now()
  where id = p_user_id;
  return adventurex_onboarding_state(p_user_id);
end;
$$;

create function public.update_adventurex_onboarding_state(
  p_user_id uuid,
  p_stage text default null,
  p_image_declined boolean default null
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.update_adventurex_onboarding_state(
    p_user_id,p_stage,p_image_declined,null::text,false
  )
$$;

create function public.begin_wechat_message(
  p_connection_id uuid,
  p_message_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_affected integer := 0;
begin
  insert into channel_message_deliveries (
    provider,direction,connection_id,external_message_id,status
  ) values ('wechat','inbound',p_connection_id,p_message_id,'processing')
  on conflict (provider,connection_id,external_message_id)
    where direction = 'inbound'
  do update set status='processing',last_error=null,updated_at=now()
  where channel_message_deliveries.status='failed'
     or (channel_message_deliveries.status='processing'
         and channel_message_deliveries.updated_at < now() - interval '5 minutes');
  get diagnostics v_affected = row_count;
  return v_affected > 0;
end;
$$;

create function public.complete_wechat_message(
  p_connection_id uuid,
  p_message_id text,
  p_error text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  update channel_message_deliveries set
    status = case when p_error is null then 'completed' else 'failed' end,
    last_error = case when p_error is null then null else left(p_error,1000) end,
    completed_at = case when p_error is null then now() else null end,
    updated_at = now()
  where provider='wechat' and direction='inbound'
    and connection_id=p_connection_id and external_message_id=p_message_id
$$;

create function public.enqueue_wechat_outbound_message(
  p_user_id uuid,
  p_message_id uuid,
  p_content text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_message messages%rowtype;
begin
  select * into v_message from messages where id=p_message_id and user_id=p_user_id;
  if not found or v_message.role <> 'assistant' then
    raise exception '微信投递消息不存在或不是 Agent 回复' using errcode='P0001';
  end if;
  if v_message.source_channel = 'web' then
    raise exception 'Web 对话消息不能投递到微信' using errcode='P0001';
  end if;
  if exists (select 1 from wechat_ilink_connections where user_id=p_user_id and status='active') then
    insert into channel_message_deliveries (
      provider,direction,message_id,payload_override,status
    ) values (
      'wechat','outbound',p_message_id,
      case when p_content is distinct from v_message.content then p_content else null end,
      'pending'
    )
    on conflict (provider,message_id) where direction='outbound' do nothing;
  end if;
end;
$$;

create function public.claim_wechat_outbound_messages(
  p_worker_id text,
  p_limit integer default 20
)
returns setof jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimable as (
    select d.id,c.id as connection_id
    from channel_message_deliveries d
    join messages m on m.id=d.message_id
    join wechat_ilink_connections c on c.user_id=m.user_id and c.status='active'
    where d.provider='wechat' and d.direction='outbound' and (
      (d.status in ('pending','retry') and d.run_at<=now())
      or (d.status='processing' and d.locked_at<now()-interval '5 minutes')
    )
    order by d.created_at
    for update of d skip locked
    limit least(greatest(p_limit,1),100)
  ), updated as (
    update channel_message_deliveries d set
      connection_id=q.connection_id,status='processing',attempts=d.attempts+1,
      locked_by=p_worker_id,locked_at=now(),updated_at=now()
    from claimable q where d.id=q.id returning d.*
  )
  select jsonb_build_object(
    'id',u.id,'messageId',u.message_id,'userId',m.user_id,
    'content',coalesce(u.payload_override,m.content),'attempts',u.attempts,
    'connection',to_jsonb(c)
  )
  from updated u
  join messages m on m.id=u.message_id
  join wechat_ilink_connections c on c.id=u.connection_id;
end;
$$;

create function public.complete_wechat_outbound_message(
  p_outbound_id uuid,
  p_worker_id text,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_error is null then
    update channel_message_deliveries set
      status='sent',completed_at=now(),locked_by=null,locked_at=null,
      last_error=null,updated_at=now()
    where id=p_outbound_id and provider='wechat' and direction='outbound'
      and locked_by=p_worker_id;
  else
    update channel_message_deliveries set
      status=case when attempts>=5 then 'failed' else 'retry' end,
      run_at=now()+make_interval(secs=>least(300,5*power(2,greatest(attempts-1,0))::integer)),
      locked_by=null,locked_at=null,last_error=left(p_error,1000),updated_at=now()
    where id=p_outbound_id and provider='wechat' and direction='outbound'
      and locked_by=p_worker_id;
  end if;
end;
$$;

alter table public.channel_message_deliveries enable row level security;

revoke all on table public.channel_message_deliveries from public,anon,authenticated;
revoke all on table public.user_models,public.adventurex_onboarding_states,
  public.wechat_message_receipts,public.wechat_outbound_messages
  from public,anon,authenticated;

grant select,insert,update,delete on table public.channel_message_deliveries to service_role;
grant select,update on table public.user_models,public.adventurex_onboarding_states,
  public.wechat_message_receipts to service_role;
grant select on table public.wechat_outbound_messages to service_role;

revoke all on function public.append_agent_message(uuid,text,text,text,text,uuid) from public,anon,authenticated;
revoke all on function public.append_agent_message(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.adventurex_onboarding_state(uuid) from public,anon,authenticated;
revoke all on function public.start_adventurex_onboarding(uuid,text) from public,anon,authenticated;
revoke all on function public.start_adventurex_onboarding(uuid) from public,anon,authenticated;
revoke all on function public.update_adventurex_onboarding_state(uuid,text,boolean,text,boolean) from public,anon,authenticated;
revoke all on function public.update_adventurex_onboarding_state(uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.begin_wechat_message(uuid,text) from public,anon,authenticated;
revoke all on function public.complete_wechat_message(uuid,text,text) from public,anon,authenticated;
revoke all on function public.enqueue_wechat_outbound_message(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.claim_wechat_outbound_messages(text,integer) from public,anon,authenticated;
revoke all on function public.complete_wechat_outbound_message(uuid,text,text) from public,anon,authenticated;

grant execute on function public.append_agent_message(uuid,text,text,text,text,uuid) to service_role;
grant execute on function public.append_agent_message(uuid,text,text,text) to service_role;
grant execute on function public.adventurex_onboarding_state(uuid) to service_role;
grant execute on function public.start_adventurex_onboarding(uuid,text) to service_role;
grant execute on function public.start_adventurex_onboarding(uuid) to service_role;
grant execute on function public.update_adventurex_onboarding_state(uuid,text,boolean,text,boolean) to service_role;
grant execute on function public.update_adventurex_onboarding_state(uuid,text,boolean) to service_role;
grant execute on function public.begin_wechat_message(uuid,text) to service_role;
grant execute on function public.complete_wechat_message(uuid,text,text) to service_role;
grant execute on function public.enqueue_wechat_outbound_message(uuid,uuid,text) to service_role;
grant execute on function public.claim_wechat_outbound_messages(text,integer) to service_role;
grant execute on function public.complete_wechat_outbound_message(uuid,text,text) to service_role;

comment on column public.messages.source_channel is
  'Origin only. All channels share one conversation; Web reads all rows, WeChat sends only correlated replies.';
comment on table public.channel_message_deliveries is
  'Unified inbound idempotency and outbound delivery ledger. Message content remains canonical in messages.';
