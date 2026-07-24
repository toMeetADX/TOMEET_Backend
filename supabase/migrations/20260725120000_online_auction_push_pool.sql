alter table public.match_requests
  add column if not exists proactive_push_enabled boolean not null default false;

alter table public.match_requests drop constraint if exists match_requests_phase_check;
alter table public.match_requests add constraint match_requests_phase_check
  check (phase in ('waiting','offered','selected','settling','push_consent','watching'));

create index if not exists match_requests_watching_idx
  on public.match_requests (created_at)
  where status = 'matching' and phase = 'watching' and proactive_push_enabled;

create table if not exists public.adventurex_test_pool_configs (
  owner_user_id uuid primary key references public.users(id) on delete cascade,
  enabled boolean not null default false,
  desired_user_count smallint not null default 5 check (desired_user_count between 3 and 12),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.adventurex_test_pool_users (
  owner_user_id uuid not null references public.users(id) on delete cascade,
  user_id uuid not null unique references public.users(id) on delete cascade,
  persona_index smallint not null check (persona_index between 1 and 12),
  created_at timestamptz not null default now(),
  primary key (owner_user_id, persona_index)
);

create table if not exists public.wechat_outbound_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  message_id uuid not null unique references public.messages(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 20000),
  status text not null default 'pending' check (status in ('pending','processing','retry','sent','failed')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  run_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists wechat_outbound_claim_idx
  on public.wechat_outbound_messages (status, run_at, created_at)
  where status in ('pending','retry','processing');

create or replace function public.set_match_request_interest(
  p_request_id uuid,
  p_phase text,
  p_proactive_push_enabled boolean,
  p_clear_round boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_request match_requests%rowtype;
begin
  if p_phase not in ('waiting','push_consent','watching') then
    raise exception '无效的匹配意愿状态' using errcode = 'P0001';
  end if;
  select * into v_request from match_requests where id = p_request_id and status = 'matching' for update;
  if not found then raise exception '匹配请求不存在或已结束' using errcode = 'P0002'; end if;
  if p_clear_round then
    update match_option_offers set status = 'expired'
    where request_id = p_request_id and status = 'offered';
  end if;
  update match_requests set
    phase = p_phase,
    proactive_push_enabled = p_proactive_push_enabled,
    active_round_id = case when p_clear_round then null else active_round_id end,
    options_expires_at = case when p_clear_round then null else options_expires_at end,
    updated_at = now()
  where id = p_request_id returning * into v_request;
  return to_jsonb(v_request);
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
  if v_row.status <> 'matching' then raise exception '只能取消仍在匹配中的请求' using errcode = 'P0001'; end if;
  update match_option_offers set status = 'expired' where request_id = p_request_id and status <> 'expired';
  update match_requests set status = 'cancelled', phase = 'waiting', proactive_push_enabled = false,
    active_round_id = null, options_expires_at = null, updated_at = now()
  where id = p_request_id returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.list_match_round_candidates(p_round_id uuid)
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  with target_round as (
    select id, bucket_key from match_rounds where id = p_round_id
  ), eligible as (
    select mr.*, 0 as interest_priority
    from match_round_requests mrr
    join match_requests mr on mr.id = mrr.request_id
    where mrr.round_id = p_round_id
      and mr.status = 'matching' and mr.phase = 'waiting' and mr.active_round_id = p_round_id
    union all
    select mr.*, 1 as interest_priority
    from match_requests mr cross join target_round r
    where r.bucket_key not like 'adventurex-test:%'
      and mr.status = 'matching' and mr.phase = 'watching' and mr.proactive_push_enabled
      and coalesce((mr.intent_snapshot->>'virtualTestUser')::boolean, false) = false
  )
  select jsonb_build_object(
    'request', to_jsonb(e) - 'interest_priority',
    'user_model', to_jsonb(um),
    'matching_narrative', case
      when ump.stale and ump.version = 0 then um.vibe_narrative
      when ump.stale then ''
      else coalesce(nullif(ump.matching_narrative,''), um.vibe_narrative)
    end,
    'social_hooks', coalesce((select jsonb_agg(hook) from list_active_social_hooks(e.user_id, 12) hook), '[]'::jsonb)
  )
  from eligible e
  join user_models um on um.user_id = e.user_id
  left join user_memory_profiles ump on ump.user_id = e.user_id
  order by e.interest_priority, e.created_at
  limit 24;
$$;

create or replace function public.get_adventurex_test_pool_status(p_owner_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'ownerUserId', p_owner_user_id,
    'enabled', coalesce(c.enabled, false),
    'desiredUserCount', coalesce(c.desired_user_count, 5),
    'provisionedUserCount', (select count(*) from adventurex_test_pool_users u where u.owner_user_id = p_owner_user_id),
    'availableRequestCount', (
      select count(*) from adventurex_test_pool_users u
      join match_requests mr on mr.user_id = u.user_id and mr.status = 'matching'
      where u.owner_user_id = p_owner_user_id
    ),
    'updatedAt', coalesce(c.updated_at, to_timestamp(0))
  )
  from (select 1) seed
  left join adventurex_test_pool_configs c on c.owner_user_id = p_owner_user_id;
$$;

create or replace function public.configure_adventurex_test_pool(
  p_owner_user_id uuid,
  p_enabled boolean,
  p_desired_user_count integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_index integer;
  v_user_id uuid;
  v_message jsonb;
  v_hook_id uuid;
  v_fact text;
  v_facts text[] := array[
    '独立完成过一款小游戏','组织过一次十人线下活动','参加过两次现场黑客松',
    '和朋友做过一场小型展览','在乐队里负责过贝斯','连续记录过一百天城市照片',
    '带队完成过一次户外挑战','做过一套现场互动卡牌','主持过多次陌生人圆桌',
    '和团队共同完成过短片','独立策划过一次城市漫游','参与搭建过一个互动装置'
  ];
begin
  if p_desired_user_count not between 3 and 12 then
    raise exception '虚拟测试用户数量必须在 3–12 之间' using errcode = 'P0001';
  end if;
  perform ensure_tomeet_user(p_owner_user_id, '新朋友');
  insert into adventurex_test_pool_configs (owner_user_id, enabled, desired_user_count)
  values (p_owner_user_id, p_enabled, p_desired_user_count)
  on conflict (owner_user_id) do update set
    enabled = excluded.enabled,
    desired_user_count = excluded.desired_user_count,
    updated_at = now();

  if not p_enabled then
    update match_requests set status = 'cancelled', phase = 'waiting', proactive_push_enabled = false,
      active_round_id = null, options_expires_at = null, updated_at = now()
    where status = 'matching' and user_id in (
      select user_id from adventurex_test_pool_users where owner_user_id = p_owner_user_id
    );
    return get_adventurex_test_pool_status(p_owner_user_id);
  end if;

  for v_index in 1..p_desired_user_count loop
    select user_id into v_user_id from adventurex_test_pool_users
    where owner_user_id = p_owner_user_id and persona_index = v_index;
    if not found then
      v_user_id := gen_random_uuid();
      perform ensure_tomeet_user(v_user_id, '虚拟测试用户' || v_index::text);
      update users set is_demo = true where id = v_user_id;
      update user_models set
        vibe_narrative = '测试人物 ' || v_index::text || '：愿意通过具体活动逐步进入交流，表达有自己的节奏。',
        current_intent = jsonb_build_object('rawText','愿意参加现场活动并认识新的人'),
        updated_at = now()
      where user_id = v_user_id;
      insert into adventurex_test_pool_users (owner_user_id, user_id, persona_index)
      values (p_owner_user_id, v_user_id, v_index);
      v_fact := v_facts[v_index];
      v_message := append_agent_message(
        v_user_id,
        'user',
        '我' || v_fact,
        'test-pool-source:' || p_owner_user_id::text || ':' || v_index::text
      );
      insert into user_social_hooks (user_id, hook_text, status)
      values (v_user_id, v_fact, 'active')
      on conflict (user_id, hook_text) do update set status = 'active', updated_at = now()
      returning id into v_hook_id;
      insert into user_social_hook_sources (hook_id, message_id)
      values (v_hook_id, (v_message->>'id')::uuid) on conflict do nothing;
    end if;
  end loop;
  return get_adventurex_test_pool_status(p_owner_user_id);
end;
$$;

create or replace function public.prepare_adventurex_test_pool(p_owner_user_id uuid)
returns setof jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_config adventurex_test_pool_configs%rowtype; v_user_id uuid; v_request match_requests%rowtype;
begin
  select * into v_config from adventurex_test_pool_configs
  where owner_user_id = p_owner_user_id and enabled for update;
  if not found then return; end if;
  for v_user_id in
    select user_id from adventurex_test_pool_users
    where owner_user_id = p_owner_user_id and persona_index <= v_config.desired_user_count
    order by persona_index
  loop
    select * into v_request from match_requests
    where user_id = v_user_id and status = 'matching' order by created_at desc limit 1;
    if not found then
      insert into match_requests (user_id, intent_snapshot, status, phase, proactive_push_enabled)
      values (
        v_user_id,
        jsonb_build_object(
          'rawText','愿意参加现场活动并认识新的人',
          'virtualTestUser',true,
          'testPoolOwnerUserId',p_owner_user_id
        ),
        'matching','waiting',false
      ) returning * into v_request;
    end if;
    return next to_jsonb(v_request);
  end loop;
end;
$$;

create or replace function public.enqueue_wechat_outbound_message(
  p_user_id uuid,
  p_message_id uuid,
  p_content text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from wechat_ilink_connections where user_id = p_user_id and status = 'active'
  ) then
    insert into wechat_outbound_messages (user_id, message_id, content)
    values (p_user_id, p_message_id, p_content)
    on conflict (message_id) do nothing;
  end if;
end;
$$;

create or replace function public.claim_wechat_outbound_messages(
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
    select o.id
    from wechat_outbound_messages o
    join wechat_ilink_connections c on c.user_id = o.user_id and c.status = 'active'
    where (
      o.status in ('pending','retry') and o.run_at <= now()
    ) or (
      o.status = 'processing' and o.locked_at < now() - interval '5 minutes'
    )
    order by o.created_at
    for update of o skip locked
    limit least(greatest(p_limit,1),100)
  ), updated as (
    update wechat_outbound_messages o set
      status = 'processing',
      attempts = attempts + 1,
      locked_by = p_worker_id,
      locked_at = now(),
      updated_at = now()
    from claimable q where o.id = q.id
    returning o.*
  )
  select jsonb_build_object(
    'id', u.id,
    'messageId', u.message_id,
    'userId', u.user_id,
    'content', u.content,
    'attempts', u.attempts,
    'connection', to_jsonb(c)
  )
  from updated u join wechat_ilink_connections c on c.user_id = u.user_id and c.status = 'active';
end;
$$;

create or replace function public.complete_wechat_outbound_message(
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
    update wechat_outbound_messages set
      status = 'sent', sent_at = now(), locked_by = null, locked_at = null,
      last_error = null, updated_at = now()
    where id = p_outbound_id and locked_by = p_worker_id;
  else
    update wechat_outbound_messages set
      status = case when attempts >= 5 then 'failed' else 'retry' end,
      run_at = now() + make_interval(secs => least(300, 5 * power(2, greatest(attempts - 1, 0))::integer)),
      locked_by = null, locked_at = null, last_error = left(p_error,1000), updated_at = now()
    where id = p_outbound_id and locked_by = p_worker_id;
  end if;
end;
$$;

create or replace function public.settle_match_round(p_round_id uuid, p_decisions jsonb)
returns setof uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round match_rounds%rowtype; v_decision jsonb; v_draft match_drafts%rowtype; v_game offline_games%rowtype;
  v_member_ids uuid[]; v_request_ids uuid[]; v_room_id uuid; v_count integer; v_index integer;
begin
  select * into v_round from match_rounds where id = p_round_id for update;
  if not found then raise exception '匹配轮次不存在' using errcode = 'P0002'; end if;
  if v_round.status = 'completed' then
    return query select r.id from match_rooms r join match_drafts d on d.id = r.source_draft_id where d.round_id = p_round_id;
    return;
  end if;
  update match_rounds set status = 'settling', updated_at = now() where id = p_round_id;
  for v_decision in select value from jsonb_array_elements(coalesce(p_decisions,'[]'::jsonb)) loop
    select array_agg(value::uuid order by ordinality) into v_member_ids from jsonb_array_elements_text(v_decision->'memberIds') with ordinality;
    select array_agg(value::uuid order by ordinality) into v_request_ids from jsonb_array_elements_text(v_decision->'requestIds') with ordinality;
    v_count := coalesce(cardinality(v_member_ids),0);
    select * into v_draft from match_drafts where id = (v_decision->>'draftId')::uuid and round_id = p_round_id for update;
    if not found or v_draft.status <> 'collecting' then
      select id into v_room_id from match_rooms where source_draft_id = (v_decision->>'draftId')::uuid;
      if found then return next v_room_id; continue; end if;
      raise exception '候选局已不可结算' using errcode = 'P0001';
    end if;
    select * into v_game from offline_games where id = v_draft.offline_game_id and active for share;
    if v_count < v_game.min_players or v_count > v_game.max_players or cardinality(v_request_ids) <> v_count then
      raise exception '活动人数不合法' using errcode = 'P0001';
    end if;
    perform 1 from match_requests where id = any(v_request_ids) order by id for update;
    if (select count(*) from match_requests where id = any(v_request_ids) and status = 'matching') <> v_count then
      raise exception '部分匹配请求已失效' using errcode = 'P0001';
    end if;
    for v_index in 1..v_count loop
      if not exists (select 1 from match_requests mr where mr.id = v_request_ids[v_index] and mr.user_id = v_member_ids[v_index]) then
        raise exception '成员与请求不对应' using errcode = 'P0001';
      end if;
      if not exists (select 1 from match_choices c where c.request_id = v_request_ids[v_index] and c.draft_id = v_draft.id) then
        raise exception '不能把用户放进未接受的候选局' using errcode = 'P0001';
      end if;
      if exists (
        select 1 from match_choices c join match_choice_required_hooks h on h.choice_id = c.id
        where c.request_id = v_request_ids[v_index] and c.draft_id = v_draft.id
          and not (h.source_user_id = any(v_member_ids))
      ) then raise exception '用户关注的人物未进入最终局' using errcode = 'P0001'; end if;
    end loop;
    insert into match_rooms (
      source_draft_id, offline_game_id, match_summary, status, target_players,
      recruitment_status, version, meeting_point
    ) values (
      v_draft.id, v_draft.offline_game_id, coalesce(v_decision->>'summary',v_draft.rationale), 'confirmed',
      (v_decision->>'targetPlayers')::smallint,
      case when v_count < least((v_decision->>'targetPlayers')::integer, v_game.max_players) then 'open' else 'full' end,
      0, 'TOMEET 集合点'
    ) returning id into v_room_id;
    insert into room_members (room_id, user_id, confirmed, confirmed_at, participation_status)
    select v_room_id, value, true, now(), 'confirmed' from unnest(v_member_ids) value;
    update match_requests set status = 'matched', phase = 'settling', room_id = v_room_id, updated_at = now()
    where id = any(v_request_ids);
    update match_drafts set status = 'formed', version = version + 1, updated_at = now() where id = v_draft.id;
    return next v_room_id;
  end loop;
  update match_requests set
    status = case when proactive_push_enabled then 'matching' else 'expired' end,
    phase = case when proactive_push_enabled then 'watching' else 'waiting' end,
    active_round_id = null,
    options_expires_at = null,
    updated_at = now()
  where id in (select request_id from match_round_requests where round_id = p_round_id)
    and status = 'matching' and active_round_id = p_round_id;
  update match_option_offers set status = 'expired' where round_id = p_round_id and status <> 'accepted';
  update match_rounds set status = 'completed', updated_at = now() where id = p_round_id;
end;
$$;

alter table public.adventurex_test_pool_configs enable row level security;
alter table public.adventurex_test_pool_users enable row level security;
alter table public.wechat_outbound_messages enable row level security;

revoke all on table public.adventurex_test_pool_configs, public.adventurex_test_pool_users,
  public.wechat_outbound_messages from public, anon, authenticated;
grant select, insert, update, delete on table public.adventurex_test_pool_configs,
  public.adventurex_test_pool_users, public.wechat_outbound_messages to service_role;

revoke all on function public.set_match_request_interest(uuid,text,boolean,boolean) from public,anon,authenticated;
revoke all on function public.get_adventurex_test_pool_status(uuid) from public,anon,authenticated;
revoke all on function public.configure_adventurex_test_pool(uuid,boolean,integer) from public,anon,authenticated;
revoke all on function public.prepare_adventurex_test_pool(uuid) from public,anon,authenticated;
revoke all on function public.enqueue_wechat_outbound_message(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.claim_wechat_outbound_messages(text,integer) from public,anon,authenticated;
revoke all on function public.complete_wechat_outbound_message(uuid,text,text) from public,anon,authenticated;

grant execute on function public.set_match_request_interest(uuid,text,boolean,boolean) to service_role;
grant execute on function public.get_adventurex_test_pool_status(uuid) to service_role;
grant execute on function public.configure_adventurex_test_pool(uuid,boolean,integer) to service_role;
grant execute on function public.prepare_adventurex_test_pool(uuid) to service_role;
grant execute on function public.enqueue_wechat_outbound_message(uuid,uuid,text) to service_role;
grant execute on function public.claim_wechat_outbound_messages(text,integer) to service_role;
grant execute on function public.complete_wechat_outbound_message(uuid,text,text) to service_role;
