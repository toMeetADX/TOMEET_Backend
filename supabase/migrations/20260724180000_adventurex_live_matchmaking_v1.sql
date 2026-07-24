create table if not exists public.adventurex_onboarding_states (
  user_id uuid primary key references public.users(id) on delete cascade,
  stage text not null default 'new'
    check (stage in ('new','awaiting_image_or_text','exploring','ready','matching')),
  image_declined boolean not null default false,
  welcome_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_social_hooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  hook_text text not null check (char_length(hook_text) between 1 and 240),
  status text not null default 'active' check (status in ('active','forgotten')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, hook_text)
);

create table if not exists public.user_social_hook_sources (
  hook_id uuid not null references public.user_social_hooks(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  primary key (hook_id, message_id)
);

create index if not exists user_social_hooks_active_idx
  on public.user_social_hooks (user_id, created_at desc) where status = 'active';

alter table public.match_requests
  add column if not exists phase text not null default 'waiting'
    check (phase in ('waiting','offered','selected','settling')),
  add column if not exists active_round_id uuid,
  add column if not exists options_expires_at timestamptz;

alter table public.match_requests drop constraint if exists match_requests_status_check;
alter table public.match_requests add constraint match_requests_status_check
  check (status in ('matching','matched','cancelled','expired'));

create table if not exists public.match_rounds (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'scheduled'
    check (status in ('scheduled','generating','collecting','settling','completed','expired')),
  bucket_key text not null unique,
  scheduled_at timestamptz not null default now(),
  offer_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.match_requests
  drop constraint if exists match_requests_active_round_fkey;
alter table public.match_requests
  add constraint match_requests_active_round_fkey
  foreign key (active_round_id) references public.match_rounds(id);

create table if not exists public.match_round_requests (
  round_id uuid not null references public.match_rounds(id) on delete cascade,
  request_id uuid not null references public.match_requests(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (round_id, request_id)
);

create table if not exists public.match_drafts (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.match_rounds(id) on delete cascade,
  temp_draft_id text not null,
  offline_game_id text not null references public.offline_games(id),
  status text not null default 'collecting' check (status in ('collecting','formed','expired')),
  version integer not null default 0 check (version >= 0),
  target_players smallint not null check (target_players between 3 and 10),
  rationale text not null check (char_length(rationale) between 1 and 1000),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (round_id, temp_draft_id)
);

create table if not exists public.match_draft_candidates (
  draft_id uuid not null references public.match_drafts(id) on delete cascade,
  request_id uuid not null references public.match_requests(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (draft_id, request_id),
  unique (draft_id, user_id)
);

alter table public.match_rooms
  add column if not exists source_draft_id uuid unique references public.match_drafts(id),
  add column if not exists target_players smallint check (target_players between 3 and 10),
  add column if not exists recruitment_status text not null default 'closed'
    check (recruitment_status in ('open','full','closed')),
  add column if not exists version integer not null default 0 check (version >= 0),
  add column if not exists meeting_point text;

alter table public.room_members
  add column if not exists participation_status text not null default 'confirmed'
    check (participation_status in ('invited','confirmed','withdrawn')),
  add column if not exists withdrawn_at timestamptz;

update public.room_members
set participation_status = case when confirmed then 'confirmed' else 'invited' end
where participation_status = 'confirmed' and not confirmed;

create table if not exists public.match_option_offers (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.match_requests(id) on delete cascade,
  round_id uuid not null references public.match_rounds(id) on delete cascade,
  source_type text not null check (source_type in ('draft','open_room')),
  draft_id uuid references public.match_drafts(id) on delete cascade,
  room_id uuid references public.match_rooms(id) on delete cascade,
  source_version integer not null check (source_version >= 0),
  option_number smallint not null check (option_number between 1 and 3),
  offline_game_id text not null references public.offline_games(id),
  preview_text text not null check (char_length(preview_text) between 1 and 2000),
  status text not null default 'offered' check (status in ('offered','accepted','rejected','expired')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (request_id, round_id, option_number),
  check (
    (source_type = 'draft' and draft_id is not null and room_id is null)
    or (source_type = 'open_room' and room_id is not null and draft_id is null)
  )
);

create table if not exists public.match_option_offer_hooks (
  offer_id uuid not null references public.match_option_offers(id) on delete cascade,
  hook_id uuid not null references public.user_social_hooks(id),
  source_user_id uuid not null references public.users(id),
  certainty text not null check (certainty in ('confirmed','possible')),
  ordinal smallint not null check (ordinal between 1 and 6),
  primary key (offer_id, hook_id),
  unique (offer_id, ordinal)
);

create table if not exists public.match_choices (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.match_requests(id) on delete cascade,
  round_id uuid not null references public.match_rounds(id) on delete cascade,
  source_type text not null check (source_type in ('draft','open_room')),
  draft_id uuid references public.match_drafts(id) on delete cascade,
  room_id uuid references public.match_rooms(id) on delete cascade,
  preference_rank smallint not null check (preference_rank between 1 and 3),
  raw_user_text text not null check (char_length(raw_user_text) between 1 and 2000),
  created_at timestamptz not null default now(),
  unique (request_id, round_id, source_type, draft_id, room_id),
  check (
    (source_type = 'draft' and draft_id is not null and room_id is null)
    or (source_type = 'open_room' and room_id is not null and draft_id is null)
  )
);

create table if not exists public.match_choice_required_hooks (
  choice_id uuid not null references public.match_choices(id) on delete cascade,
  hook_id uuid not null references public.user_social_hooks(id),
  source_user_id uuid not null references public.users(id),
  primary key (choice_id, hook_id)
);

create table if not exists public.room_member_intros (
  room_id uuid not null references public.match_rooms(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  intro_text text not null check (char_length(intro_text) between 1 and 2000),
  created_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.room_member_intro_hooks (
  room_id uuid not null,
  user_id uuid not null,
  hook_id uuid not null references public.user_social_hooks(id),
  source_user_id uuid not null references public.users(id),
  ordinal smallint not null check (ordinal between 1 and 3),
  primary key (room_id, user_id, hook_id),
  foreign key (room_id, user_id) references public.room_member_intros(room_id, user_id) on delete cascade
);

create table if not exists public.room_change_events (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.match_rooms(id) on delete cascade,
  room_version integer not null check (room_version >= 0),
  change_type text not null check (change_type in (
    'member_joined','member_withdrawn','meeting_changed','room_cancelled','recruitment_closed'
  )),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (room_id, room_version)
);

create table if not exists public.room_change_notifications (
  event_id uuid not null references public.room_change_events(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  idempotency_key text not null unique,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create table if not exists public.match_draft_change_events (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.match_drafts(id) on delete cascade,
  draft_version integer not null check (draft_version > 0),
  change_type text not null check (change_type in (
    'confirmed_member_joined','confirmed_member_withdrawn','highlighted_possible_member_changed','draft_expired'
  )),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (draft_id, draft_version)
);

create table if not exists public.match_draft_change_notifications (
  event_id uuid not null references public.match_draft_change_events(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  idempotency_key text not null unique,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

alter table public.llm_jobs drop constraint if exists llm_jobs_job_type_check;
alter table public.llm_jobs add constraint llm_jobs_job_type_check check (job_type in (
  'agent_reply','agent_event_reply','multimodal_understanding','matchmaking','match_round_generate',
  'match_round_settle','room_change_notify','feedback_update','memory_extract','memory_consolidate'
));

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
    display_name = case when excluded.display_name <> '新朋友' then excluded.display_name else users.display_name end,
    updated_at = now();
  insert into conversations (user_id) values (p_user_id) on conflict (user_id) do nothing;
  insert into user_models (user_id) values (p_user_id) on conflict (user_id) do nothing;
  insert into user_memory_profiles (user_id) values (p_user_id) on conflict (user_id) do nothing;
  insert into adventurex_onboarding_states (user_id) values (p_user_id) on conflict (user_id) do nothing;
end;
$$;

insert into public.adventurex_onboarding_states (user_id)
select id from public.users on conflict (user_id) do nothing;

create or replace function public.start_adventurex_onboarding(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message messages%rowtype;
  v_state adventurex_onboarding_states%rowtype;
begin
  perform ensure_tomeet_user(p_user_id, '新朋友');
  select * into v_state from adventurex_onboarding_states where user_id = p_user_id for update;
  select * into v_message from messages
  where user_id = p_user_id and idempotency_key = 'adventurex-welcome:' || p_user_id::text;
  if found then return jsonb_build_object('message', to_jsonb(v_message), 'state', to_jsonb(v_state)); end if;
  select * into v_message from messages where user_id = p_user_id order by created_at desc, id desc limit 1;
  if found then return jsonb_build_object('message', to_jsonb(v_message), 'state', to_jsonb(v_state)); end if;
  select * into v_message from jsonb_populate_record(null::messages, append_agent_message(
    p_user_id,
    'assistant',
    E'欢迎来到 AdventureX。我想先认识一下你。\n\n先丢给我一张图片吧——可以是你本人、最近在做的东西、去过的地方，或者手机里一张你愿意拿出来聊聊的照片。不一定露脸，也不用专门拍。\n\n如果你不想发图，直接告诉我，我们就从文字开始。',
    'adventurex-welcome:' || p_user_id::text
  ));
  update adventurex_onboarding_states
  set stage = 'awaiting_image_or_text', welcome_sent_at = now(), updated_at = now()
  where user_id = p_user_id returning * into v_state;
  return jsonb_build_object('message', to_jsonb(v_message), 'state', to_jsonb(v_state));
end;
$$;

create or replace function public.update_adventurex_onboarding_state(
  p_user_id uuid,
  p_stage text default null,
  p_image_declined boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_state adventurex_onboarding_states%rowtype;
begin
  perform ensure_tomeet_user(p_user_id, '新朋友');
  if p_stage is not null and p_stage not in ('new','awaiting_image_or_text','exploring','ready','matching') then
    raise exception '无效的引导阶段' using errcode = 'P0001';
  end if;
  update adventurex_onboarding_states set
    stage = coalesce(p_stage, stage),
    image_declined = coalesce(p_image_declined, image_declined),
    updated_at = now()
  where user_id = p_user_id returning * into v_state;
  return to_jsonb(v_state);
end;
$$;

create or replace function public.list_active_social_hooks(p_user_id uuid, p_limit integer default 32)
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(h) || jsonb_build_object(
    'source_message_ids', coalesce((select jsonb_agg(s.message_id order by s.message_id) from user_social_hook_sources s where s.hook_id = h.id), '[]'::jsonb)
  )
  from user_social_hooks h
  where h.user_id = p_user_id and h.status = 'active'
  order by h.created_at desc
  limit least(greatest(p_limit, 1), 128);
$$;

create or replace function public.save_social_hooks(p_user_id uuid, p_hooks jsonb)
returns setof jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_hook jsonb; v_row user_social_hooks%rowtype; v_message_id uuid;
begin
  if jsonb_array_length(coalesce(p_hooks, '[]'::jsonb)) > 8 then
    raise exception '社交钩子数量超限' using errcode = 'P0001';
  end if;
  for v_hook in select value from jsonb_array_elements(coalesce(p_hooks, '[]'::jsonb)) loop
    if char_length(coalesce(v_hook->>'hookText','')) not between 1 and 240 then
      raise exception '社交钩子文本无效' using errcode = 'P0001';
    end if;
    if jsonb_array_length(coalesce(v_hook->'evidenceMessageIds','[]'::jsonb)) not between 1 and 8 then
      raise exception '社交钩子必须有文字来源' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from jsonb_array_elements_text(v_hook->'evidenceMessageIds') source(id)
      where not exists (
        select 1 from messages m where m.id = source.id::uuid and m.user_id = p_user_id and m.role = 'user'
      )
    ) then raise exception '社交钩子只能引用当前用户的文字消息' using errcode = 'P0001'; end if;
    insert into user_social_hooks (user_id, hook_text, status)
    values (p_user_id, v_hook->>'hookText', 'active')
    on conflict (user_id, hook_text) do update set status = 'active', updated_at = now()
    returning * into v_row;
    for v_message_id in select value::uuid from jsonb_array_elements_text(v_hook->'evidenceMessageIds') loop
      insert into user_social_hook_sources (hook_id, message_id) values (v_row.id, v_message_id) on conflict do nothing;
    end loop;
    return query select * from list_active_social_hooks(p_user_id, 128) x
      where (x->>'id')::uuid = v_row.id;
  end loop;
end;
$$;

create or replace function public.forget_social_hook(p_user_id uuid, p_hook_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update user_social_hooks set status = 'forgotten', updated_at = now()
  where id = p_hook_id and user_id = p_user_id;
  if not found then raise exception '社交钩子不存在' using errcode = 'P0002'; end if;
end;
$$;

create or replace function public.create_or_get_match_round(p_bucket_key text, p_scheduled_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_round match_rounds%rowtype;
begin
  insert into match_rounds (bucket_key, scheduled_at) values (p_bucket_key, p_scheduled_at)
  on conflict (bucket_key) do update set bucket_key = excluded.bucket_key
  returning * into v_round;
  return to_jsonb(v_round);
end;
$$;

create or replace function public.add_request_to_match_round(p_round_id uuid, p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from match_rounds where id = p_round_id for update;
  if not found then raise exception '匹配轮次不存在' using errcode = 'P0002'; end if;
  perform 1 from match_requests where id = p_request_id and status = 'matching' for update;
  if not found then raise exception '匹配请求已不活跃' using errcode = 'P0001'; end if;
  insert into match_round_requests (round_id, request_id) values (p_round_id, p_request_id) on conflict do nothing;
  update match_requests set phase = 'waiting', active_round_id = p_round_id, options_expires_at = null, updated_at = now()
  where id = p_request_id;
end;
$$;

create or replace function public.list_match_round_candidates(p_round_id uuid)
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'request', to_jsonb(mr),
    'user_model', to_jsonb(um),
    'matching_narrative', case
      when ump.stale and ump.version = 0 then um.vibe_narrative
      when ump.stale then ''
      else coalesce(nullif(ump.matching_narrative,''), um.vibe_narrative)
    end,
    'social_hooks', coalesce((select jsonb_agg(hook) from list_active_social_hooks(mr.user_id, 12) hook), '[]'::jsonb)
  )
  from match_round_requests mrr
  join match_requests mr on mr.id = mrr.request_id
  join user_models um on um.user_id = mr.user_id
  left join user_memory_profiles ump on ump.user_id = mr.user_id
  where mrr.round_id = p_round_id and mr.status = 'matching' and mr.phase = 'waiting' and mr.active_round_id = p_round_id
  order by mr.created_at
  limit 24;
$$;

create or replace function public.offer_with_hooks(p_offer_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(o) || jsonb_build_object('hooks', coalesce((
    select jsonb_agg(jsonb_build_object(
      'hookId', oh.hook_id,
      'hookText', h.hook_text,
      'sourceUserId', oh.source_user_id,
      'certainty', oh.certainty
    ) order by oh.ordinal)
    from match_option_offer_hooks oh join user_social_hooks h on h.id = oh.hook_id
    where oh.offer_id = o.id
  ), '[]'::jsonb))
  from match_option_offers o where o.id = p_offer_id;
$$;

create or replace function public.save_match_round_proposals(
  p_round_id uuid,
  p_proposal jsonb,
  p_offers jsonb,
  p_offer_expires_at timestamptz
)
returns setof jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft jsonb; v_offer jsonb; v_hook jsonb;
  v_draft_id uuid; v_offer_id uuid; v_request_id uuid; v_source_type text;
  v_ordinal integer;
begin
  perform 1 from match_rounds where id = p_round_id and status not in ('completed','expired') for update;
  if not found then raise exception '匹配轮次不可保存' using errcode = 'P0001'; end if;
  for v_draft in select value from jsonb_array_elements(coalesce(p_proposal->'drafts','[]'::jsonb)) loop
    insert into match_drafts (
      round_id, temp_draft_id, offline_game_id, target_players, rationale, expires_at
    ) values (
      p_round_id, v_draft->>'tempDraftId', v_draft->>'offlineGameId',
      (v_draft->>'targetPlayers')::smallint, v_draft->>'rationale', p_offer_expires_at
    ) on conflict (round_id, temp_draft_id) do update set updated_at = now()
    returning id into v_draft_id;
    insert into match_draft_candidates (draft_id, request_id, user_id)
    select v_draft_id, source.value::uuid, mr.user_id
    from jsonb_array_elements_text(v_draft->'candidateRequestIds') source
    join match_requests mr on mr.id = source.value::uuid and mr.status = 'matching'
    on conflict do nothing;
  end loop;
  for v_offer in select value from jsonb_array_elements(coalesce(p_offers,'[]'::jsonb)) loop
    v_request_id := (v_offer->>'requestId')::uuid;
    v_source_type := v_offer->>'sourceType';
    v_draft_id := null;
    if v_source_type = 'draft' then
      select id into v_draft_id from match_drafts
      where round_id = p_round_id and temp_draft_id = v_offer->>'tempDraftId';
      if not found then raise exception '候选局映射不存在' using errcode = 'P0001'; end if;
    end if;
    insert into match_option_offers (
      request_id, round_id, source_type, draft_id, room_id, source_version,
      option_number, offline_game_id, preview_text
    ) values (
      v_request_id, p_round_id, v_source_type, v_draft_id,
      case when v_source_type = 'open_room' then (v_offer->>'roomId')::uuid else null end,
      (v_offer->>'sourceVersion')::integer, (v_offer->>'optionNumber')::smallint,
      v_offer->>'offlineGameId', v_offer->>'previewText'
    ) on conflict (request_id, round_id, option_number) do update set preview_text = excluded.preview_text
    returning id into v_offer_id;
    v_ordinal := 0;
    for v_hook in select value from jsonb_array_elements(coalesce(v_offer->'hooks','[]'::jsonb)) loop
      v_ordinal := v_ordinal + 1;
      perform 1 from user_social_hooks h
      where h.id = (v_hook->>'hookId')::uuid and h.user_id = (v_hook->>'sourceUserId')::uuid and h.status = 'active';
      if not found then raise exception '候选引用了无效社交钩子' using errcode = 'P0001'; end if;
      insert into match_option_offer_hooks (offer_id, hook_id, source_user_id, certainty, ordinal)
      values (v_offer_id, (v_hook->>'hookId')::uuid, (v_hook->>'sourceUserId')::uuid, v_hook->>'certainty', v_ordinal)
      on conflict do nothing;
    end loop;
    update match_requests set phase = 'offered', options_expires_at = p_offer_expires_at, updated_at = now()
    where id = v_request_id and status = 'matching' and active_round_id = p_round_id;
    return next offer_with_hooks(v_offer_id);
  end loop;
  update match_rounds set status = 'collecting', offer_expires_at = p_offer_expires_at, updated_at = now()
  where id = p_round_id;
end;
$$;

create or replace function public.list_current_match_options(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'request_id', mr.id,
    'round_id', mr.active_round_id,
    'expires_at', mr.options_expires_at,
    'options', coalesce((
      select jsonb_agg(offer_with_hooks(o.id) || jsonb_build_object(
        'activity_name', g.name,
        'activity_description', g.description
      ) order by o.option_number)
      from match_option_offers o join offline_games g on g.id = o.offline_game_id
      where o.request_id = mr.id and o.round_id = mr.active_round_id and o.status <> 'expired'
    ), '[]'::jsonb)
  )
  from match_requests mr
  where mr.user_id = p_user_id and mr.status = 'matching' and mr.phase in ('offered','selected')
  order by mr.created_at desc limit 1;
$$;

create or replace function public.save_match_choices(
  p_request_id uuid,
  p_preferred_option_number smallint,
  p_accepted_option_numbers smallint[],
  p_required_hook_ids uuid[] default '{}',
  p_raw_user_text text default '结构化选择'
)
returns setof jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request match_requests%rowtype; v_offer match_option_offers%rowtype; v_choice_id uuid;
  v_number smallint; v_index integer := 0; v_rank smallint; v_hook_id uuid;
begin
  select * into v_request from match_requests where id = p_request_id for update;
  if not found or v_request.status <> 'matching' or v_request.active_round_id is null then
    raise exception '匹配请求当前不能选择' using errcode = 'P0001';
  end if;
  if v_request.options_expires_at <= now() then raise exception '候选已过期' using errcode = 'P0001'; end if;
  if cardinality(coalesce(p_accepted_option_numbers,'{}')) not between 1 and 3 then
    raise exception '至少选择一个候选' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_required_hook_ids,'{}')) hook_id
    where not exists (
      select 1 from match_option_offers o join match_option_offer_hooks oh on oh.offer_id = o.id
      where o.request_id = p_request_id and o.round_id = v_request.active_round_id
        and o.option_number = any(p_accepted_option_numbers) and oh.hook_id = hook_id
    )
  ) then raise exception 'required hook 必须来自已接受候选' using errcode = 'P0001'; end if;
  delete from match_choices where request_id = p_request_id and round_id = v_request.active_round_id;
  foreach v_number in array p_accepted_option_numbers loop
    v_index := v_index + 1;
    select * into v_offer from match_option_offers
    where request_id = p_request_id and round_id = v_request.active_round_id
      and option_number = v_number and status <> 'expired' for update;
    if not found then raise exception '选择包含不存在的候选编号' using errcode = 'P0001'; end if;
    v_rank := case when p_preferred_option_number is null or v_number = p_preferred_option_number then 1 else least(3, v_index + 1) end;
    insert into match_choices (request_id, round_id, source_type, draft_id, room_id, preference_rank, raw_user_text)
    values (p_request_id, v_request.active_round_id, v_offer.source_type, v_offer.draft_id, v_offer.room_id, v_rank, p_raw_user_text)
    returning id into v_choice_id;
    for v_hook_id in select unnest(coalesce(p_required_hook_ids,'{}')) loop
      insert into match_choice_required_hooks (choice_id, hook_id, source_user_id)
      select v_choice_id, oh.hook_id, oh.source_user_id
      from match_option_offer_hooks oh where oh.offer_id = v_offer.id and oh.hook_id = v_hook_id
      on conflict do nothing;
    end loop;
    return next to_jsonb(v_offer) || jsonb_build_object(
      'id', v_choice_id,
      'preference_rank', v_rank,
      'raw_user_text', p_raw_user_text,
      'created_at', now(),
      'required_hook_ids', coalesce((select jsonb_agg(hook_id) from match_choice_required_hooks where choice_id = v_choice_id), '[]'::jsonb)
    );
  end loop;
  update match_option_offers set
    status = case when option_number = any(p_accepted_option_numbers) then 'accepted' else 'rejected' end,
    responded_at = now()
  where request_id = p_request_id and round_id = v_request.active_round_id and status <> 'expired';
  update match_requests set phase = 'selected', updated_at = now() where id = p_request_id;
end;
$$;

create or replace function public.expire_match_options(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from match_requests where id = p_request_id for update;
  if not found then raise exception '匹配请求不存在' using errcode = 'P0002'; end if;
  update match_option_offers set status = 'expired' where request_id = p_request_id and status <> 'expired';
  delete from match_choices where request_id = p_request_id;
  update match_requests set phase = 'waiting', active_round_id = null, options_expires_at = null, updated_at = now()
  where id = p_request_id and status = 'matching';
end;
$$;

create or replace function public.restart_match_request(p_cancelled_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_previous match_requests%rowtype; v_new match_requests%rowtype;
begin
  select * into v_previous from match_requests where id = p_cancelled_request_id for update;
  if not found then raise exception '匹配请求不存在' using errcode = 'P0002'; end if;
  if v_previous.status not in ('cancelled','expired') then
    raise exception '只能从已取消或已超时请求重新匹配' using errcode = 'P0001';
  end if;
  insert into match_requests (user_id, intent_snapshot) values (v_previous.user_id, v_previous.intent_snapshot)
  returning * into v_new;
  return to_jsonb(v_new);
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
  if exists (
    select 1 from room_members rm join match_rooms mr on mr.id = rm.room_id
    where rm.user_id = p_user_id and rm.participation_status <> 'withdrawn' and mr.status <> 'completed'
  ) then raise exception '你还有一个未结束的匹配房间' using errcode = 'P0001'; end if;
  insert into match_requests (user_id, intent_snapshot, phase)
  values (p_user_id, p_intent_snapshot, 'waiting')
  on conflict (user_id) where status = 'matching' do nothing
  returning * into v_row;
  if v_row.id is null then select * into v_row from match_requests where user_id = p_user_id and status = 'matching'; end if;
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
  if v_row.status <> 'matching' then raise exception '只能取消仍在匹配中的请求' using errcode = 'P0001'; end if;
  update match_option_offers set status = 'expired' where request_id = p_request_id and status <> 'expired';
  update match_requests set status = 'cancelled', phase = 'waiting', active_round_id = null,
    options_expires_at = null, updated_at = now()
  where id = p_request_id returning * into v_row;
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
  select jsonb_build_object(
    'request', to_jsonb(mr), 'user_model', to_jsonb(um),
    'matching_narrative', case
      when ump.stale and ump.version = 0 then um.vibe_narrative
      when ump.stale then ''
      else coalesce(nullif(ump.matching_narrative,''), um.vibe_narrative)
    end,
    'social_hooks', coalesce((select jsonb_agg(hook) from list_active_social_hooks(mr.user_id,12) hook),'[]'::jsonb)
  )
  from match_requests mr join user_models um on um.user_id = mr.user_id
  left join user_memory_profiles ump on ump.user_id = mr.user_id
  where mr.status = 'matching' order by mr.created_at
  limit least(greatest(p_limit,1),100);
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
  update room_members set confirmed = true, confirmed_at = coalesce(confirmed_at,now()),
    participation_status = 'confirmed', withdrawn_at = null
  where room_id = p_room_id and user_id = p_user_id and participation_status <> 'withdrawn';
  if not found then raise exception '用户不在房间中' using errcode = 'P0001'; end if;
  if not exists (select 1 from room_members where room_id = p_room_id and participation_status <> 'withdrawn' and not confirmed) then
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
  if v_status = 'completed' then return get_match_room(p_room_id); end if;
  if exists (select 1 from room_members where room_id = p_room_id and participation_status <> 'withdrawn' and not confirmed) then
    raise exception '所有成员确认后才能完成活动' using errcode = 'P0001';
  end if;
  update match_rooms set status = 'completed', completed_at = coalesce(completed_at,now()), recruitment_status = 'closed'
  where id = p_room_id;
  update user_models set current_intent = '{}'::jsonb, version = version + 1, updated_at = now()
  where user_id in (select user_id from room_members where room_id = p_room_id and participation_status <> 'withdrawn')
    and current_intent <> '{}'::jsonb;
  return get_match_room(p_room_id);
end;
$$;

create or replace function public.get_match_round_settlement_state(p_round_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'round', to_jsonb(r),
    'drafts', coalesce((select jsonb_agg(to_jsonb(d) || jsonb_build_object(
      'candidate_request_ids', coalesce((select jsonb_agg(dc.request_id) from match_draft_candidates dc where dc.draft_id = d.id), '[]'::jsonb)
    )) from match_drafts d where d.round_id = r.id), '[]'::jsonb),
    'choices', coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object(
      'required_hook_ids', coalesce((select jsonb_agg(ch.hook_id) from match_choice_required_hooks ch where ch.choice_id = c.id), '[]'::jsonb)
    )) from match_choices c where c.round_id = r.id), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(to_jsonb(mr)) from match_round_requests rr join match_requests mr on mr.id = rr.request_id where rr.round_id = r.id), '[]'::jsonb),
    'hooks', coalesce((select jsonb_agg(hook) from match_round_requests rr join match_requests mr on mr.id = rr.request_id cross join lateral list_active_social_hooks(mr.user_id, 32) hook where rr.round_id = r.id), '[]'::jsonb)
  )
  from match_rounds r where r.id = p_round_id;
$$;

create or replace function public.save_room_member_intro(
  p_room_id uuid,
  p_user_id uuid,
  p_intro_text text,
  p_hook_ids uuid[] default '{}'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_hook_id uuid; v_source_user_id uuid; v_ordinal integer := 0;
begin
  if char_length(coalesce(p_intro_text,'')) not between 1 and 2000 then
    raise exception '房间介绍文本无效' using errcode = 'P0001';
  end if;
  if cardinality(coalesce(p_hook_ids,'{}')) > 3 then
    raise exception '房间介绍人物事实过多' using errcode = 'P0001';
  end if;
  perform 1 from room_members
  where room_id = p_room_id and user_id = p_user_id and participation_status = 'confirmed';
  if not found then raise exception '房间成员不存在' using errcode = 'P0002'; end if;
  insert into room_member_intros (room_id, user_id, intro_text)
  values (p_room_id, p_user_id, p_intro_text)
  on conflict (room_id, user_id) do update set intro_text = excluded.intro_text, created_at = now();
  delete from room_member_intro_hooks where room_id = p_room_id and user_id = p_user_id;
  for v_hook_id in select unnest(coalesce(p_hook_ids,'{}')) loop
    select h.user_id into v_source_user_id
    from user_social_hooks h
    join room_members rm on rm.user_id = h.user_id
      and rm.room_id = p_room_id and rm.participation_status = 'confirmed'
    where h.id = v_hook_id and h.status = 'active' and h.user_id <> p_user_id;
    if not found then raise exception '房间介绍引用了无效人物事实' using errcode = 'P0001'; end if;
    v_ordinal := v_ordinal + 1;
    insert into room_member_intro_hooks (room_id, user_id, hook_id, source_user_id, ordinal)
    values (p_room_id, p_user_id, v_hook_id, v_source_user_id, v_ordinal);
  end loop;
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
      if not exists (
        select 1 from match_requests mr where mr.id = v_request_ids[v_index] and mr.user_id = v_member_ids[v_index]
      ) then raise exception '成员与请求不对应' using errcode = 'P0001'; end if;
      if not exists (
        select 1 from match_choices c where c.request_id = v_request_ids[v_index] and c.draft_id = v_draft.id
      ) then raise exception '不能把用户放进未接受的候选局' using errcode = 'P0001'; end if;
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
  update match_requests set status = 'expired', active_round_id = null,
    options_expires_at = null, updated_at = now()
  where id in (select request_id from match_round_requests where round_id = p_round_id)
    and status = 'matching' and active_round_id = p_round_id;
  update match_option_offers set status = 'expired' where round_id = p_round_id and status <> 'accepted';
  update match_rounds set status = 'completed', updated_at = now() where id = p_round_id;
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
    'members', coalesce((select jsonb_agg(jsonb_build_object(
      'userId', rm.user_id, 'displayName', u.display_name, 'confirmed', rm.confirmed,
      'participationStatus', rm.participation_status
    ) order by rm.created_at) from room_members rm join users u on u.id = rm.user_id where rm.room_id = mr.id), '[]'::jsonb),
    'offlineGame', jsonb_build_object(
      'id', og.id, 'name', og.name, 'description', og.description,
      'minPlayers', og.min_players, 'maxPlayers', og.max_players,
      'intentTags', to_jsonb(og.intent_tags), 'traits', to_jsonb(og.traits),
      'requirements', to_jsonb(og.requirements), 'instructions', to_jsonb(og.instructions)
    ),
    'matchSummary', mr.match_summary, 'status', mr.status,
    'sourceDraftId', mr.source_draft_id, 'targetPlayers', mr.target_players,
    'recruitmentStatus', mr.recruitment_status, 'version', mr.version,
    'meetingPoint', mr.meeting_point, 'createdAt', mr.created_at, 'completedAt', mr.completed_at
  )
  from match_rooms mr join offline_games og on og.id = mr.offline_game_id where mr.id = p_room_id;
$$;

create or replace function public.list_suitable_open_rooms(p_user_id uuid, p_limit integer default 3)
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select get_match_room(r.id) from match_rooms r join offline_games g on g.id = r.offline_game_id
  where r.status <> 'completed' and r.recruitment_status = 'open'
    and not exists (select 1 from room_members rm where rm.room_id = r.id and rm.user_id = p_user_id and rm.participation_status <> 'withdrawn')
    and (select count(*) from room_members rm where rm.room_id = r.id and rm.participation_status = 'confirmed')
      < least(coalesce(r.target_players,g.max_players),g.max_players)
  order by r.created_at
  limit least(greatest(p_limit,1),10);
$$;

create or replace function public.record_room_change_event(
  p_room_id uuid, p_change_type text, p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_event_id uuid; v_version integer;
begin
  select version into v_version from match_rooms where id = p_room_id;
  insert into room_change_events (room_id, room_version, change_type, payload)
  values (p_room_id, v_version, p_change_type, coalesce(p_payload,'{}'::jsonb)) returning id into v_event_id;
  insert into room_change_notifications (event_id, user_id, idempotency_key)
  select v_event_id, rm.user_id, 'room-change:' || v_event_id::text || ':' || rm.user_id::text
  from room_members rm where rm.room_id = p_room_id and rm.participation_status = 'confirmed'
    and not (p_change_type = 'member_joined' and rm.user_id = nullif(p_payload->>'joinedUserId','')::uuid);
  return v_event_id;
end;
$$;

create or replace function public.join_open_match_room(
  p_request_id uuid, p_offer_id uuid, p_source_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_request match_requests%rowtype; v_offer match_option_offers%rowtype; v_room match_rooms%rowtype; v_game offline_games%rowtype; v_count integer; v_capacity integer;
begin
  select * into v_request from match_requests where id = p_request_id for update;
  if not found or v_request.status <> 'matching' then raise exception '匹配请求已失效' using errcode = 'P0001'; end if;
  select * into v_offer from match_option_offers where id = p_offer_id and request_id = p_request_id and source_type = 'open_room' and status = 'accepted';
  if not found then raise exception '用户没有接受这个开放局候选' using errcode = 'P0001'; end if;
  select * into v_room from match_rooms where id = v_offer.room_id for update;
  select * into v_game from offline_games where id = v_room.offline_game_id;
  if v_room.version <> p_source_version or v_offer.source_version <> p_source_version then raise exception '开放局已经发生变化，请查看最新候选' using errcode = 'P0001'; end if;
  if v_room.recruitment_status <> 'open' then raise exception '开放局已经满员或关闭' using errcode = 'P0001'; end if;
  select count(*) into v_count from room_members where room_id = v_room.id and participation_status = 'confirmed';
  v_capacity := least(coalesce(v_room.target_players,v_game.max_players),v_game.max_players);
  if v_count >= v_capacity then raise exception '开放局已经满员' using errcode = 'P0001'; end if;
  insert into room_members (room_id,user_id,confirmed,confirmed_at,participation_status,withdrawn_at)
  values (v_room.id,v_request.user_id,true,now(),'confirmed',null)
  on conflict (room_id,user_id) do update set confirmed=true, confirmed_at=now(), participation_status='confirmed', withdrawn_at=null;
  update match_requests set status='matched',phase='settling',room_id=v_room.id,updated_at=now() where id=p_request_id;
  update match_rooms set version=version+1,
    status=case when v_count+1 >= v_game.min_players then 'confirmed' else 'confirming' end,
    recruitment_status=case when v_count+1 >= v_capacity then 'full' else 'open' end
  where id=v_room.id returning * into v_room;
  perform record_room_change_event(v_room.id,'member_joined',jsonb_build_object('joinedUserId',v_request.user_id,'memberCount',v_count+1));
  return get_match_room(v_room.id);
end;
$$;

create or replace function public.withdraw_room_member(p_room_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_room match_rooms%rowtype; v_game offline_games%rowtype; v_remaining integer;
begin
  select * into v_room from match_rooms where id=p_room_id for update;
  if not found then raise exception '房间不存在' using errcode='P0002'; end if;
  if v_room.status='completed' then raise exception '活动已完成' using errcode='P0001'; end if;
  select * into v_game from offline_games where id=v_room.offline_game_id;
  update room_members set confirmed=false,participation_status='withdrawn',withdrawn_at=now()
  where room_id=p_room_id and user_id=p_user_id and participation_status<>'withdrawn';
  if not found then raise exception '用户不在当前房间中' using errcode='P0001'; end if;
  select count(*) into v_remaining from room_members where room_id=p_room_id and participation_status='confirmed';
  update match_rooms set
    version=version+1,
    status=case when v_remaining >= v_game.min_players then 'confirmed' else 'confirming' end,
    recruitment_status='open'
  where id=p_room_id returning * into v_room;
  update match_requests set status='cancelled',room_id=null,active_round_id=null,options_expires_at=null,updated_at=now()
  where room_id=p_room_id and user_id=p_user_id;
  perform record_room_change_event(p_room_id,'member_withdrawn',jsonb_build_object('withdrawnUserId',p_user_id,'memberCount',v_remaining));
  return get_match_room(p_room_id);
end;
$$;

create or replace function public.list_pending_room_change_notifications(p_limit integer default 100)
returns setof jsonb
language sql
stable
security definer
set search_path=public
as $$
  select jsonb_build_object(
    'event_id',n.event_id,'room_id',e.room_id,'user_id',n.user_id,'change_type',e.change_type,
    'payload',e.payload,
    'idempotency_key',n.idempotency_key
  ) from room_change_notifications n join room_change_events e on e.id=n.event_id
  where n.delivered_at is null order by n.created_at limit least(greatest(p_limit,1),500);
$$;

create or replace function public.mark_room_change_notification_delivered(p_event_id uuid,p_user_id uuid)
returns void language sql security definer set search_path=public as $$
  update room_change_notifications set delivered_at=coalesce(delivered_at,now()) where event_id=p_event_id and user_id=p_user_id;
$$;

create or replace function public.list_pending_draft_change_notifications(p_limit integer default 100)
returns setof jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object('event_id',n.event_id,'draft_id',e.draft_id,'user_id',n.user_id,'change_type',e.change_type,'payload',e.payload,'idempotency_key',n.idempotency_key)
  from match_draft_change_notifications n join match_draft_change_events e on e.id=n.event_id
  where n.delivered_at is null order by n.created_at limit least(greatest(p_limit,1),500);
$$;

create or replace function public.mark_draft_change_notification_delivered(p_event_id uuid,p_user_id uuid)
returns void language sql security definer set search_path=public as $$
  update match_draft_change_notifications set delivered_at=coalesce(delivered_at,now()) where event_id=p_event_id and user_id=p_user_id;
$$;

drop function if exists public.enqueue_llm_job(text,jsonb,text,integer,text);
create function public.enqueue_llm_job(
  p_job_type text,
  p_payload jsonb,
  p_idempotency_key text,
  p_max_attempts integer default 3,
  p_partition_key text default null,
  p_run_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare v_row llm_jobs%rowtype;
begin
  insert into llm_jobs(job_type,payload,idempotency_key,max_attempts,partition_key,run_at)
  values(p_job_type,p_payload,p_idempotency_key,least(greatest(p_max_attempts,1),10),nullif(p_partition_key,''),coalesce(p_run_at,now()))
  on conflict(idempotency_key) do update set idempotency_key=excluded.idempotency_key
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

alter table public.adventurex_onboarding_states enable row level security;
alter table public.user_social_hooks enable row level security;
alter table public.user_social_hook_sources enable row level security;
alter table public.match_rounds enable row level security;
alter table public.match_round_requests enable row level security;
alter table public.match_drafts enable row level security;
alter table public.match_draft_candidates enable row level security;
alter table public.match_option_offers enable row level security;
alter table public.match_option_offer_hooks enable row level security;
alter table public.match_choices enable row level security;
alter table public.match_choice_required_hooks enable row level security;
alter table public.room_member_intros enable row level security;
alter table public.room_member_intro_hooks enable row level security;
alter table public.room_change_events enable row level security;
alter table public.room_change_notifications enable row level security;
alter table public.match_draft_change_events enable row level security;
alter table public.match_draft_change_notifications enable row level security;

revoke all on table public.adventurex_onboarding_states,user_social_hooks,user_social_hook_sources,
  match_rounds,match_round_requests,match_drafts,match_draft_candidates,match_option_offers,
  match_option_offer_hooks,match_choices,match_choice_required_hooks,room_member_intros,
  room_member_intro_hooks,room_change_events,room_change_notifications,
  match_draft_change_events,match_draft_change_notifications from public,anon,authenticated;
grant select,insert,update,delete on table public.adventurex_onboarding_states,user_social_hooks,user_social_hook_sources,
  match_rounds,match_round_requests,match_drafts,match_draft_candidates,match_option_offers,
  match_option_offer_hooks,match_choices,match_choice_required_hooks,room_member_intros,
  room_member_intro_hooks,room_change_events,room_change_notifications,
  match_draft_change_events,match_draft_change_notifications to service_role;

revoke all on function public.start_adventurex_onboarding(uuid) from public,anon,authenticated;
revoke all on function public.update_adventurex_onboarding_state(uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.list_active_social_hooks(uuid,integer) from public,anon,authenticated;
revoke all on function public.save_social_hooks(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.forget_social_hook(uuid,uuid) from public,anon,authenticated;
revoke all on function public.create_or_get_match_round(text,timestamptz) from public,anon,authenticated;
revoke all on function public.add_request_to_match_round(uuid,uuid) from public,anon,authenticated;
revoke all on function public.list_match_round_candidates(uuid) from public,anon,authenticated;
revoke all on function public.save_match_round_proposals(uuid,jsonb,jsonb,timestamptz) from public,anon,authenticated;
revoke all on function public.list_current_match_options(uuid) from public,anon,authenticated;
revoke all on function public.save_match_choices(uuid,smallint,smallint[],uuid[],text) from public,anon,authenticated;
revoke all on function public.expire_match_options(uuid) from public,anon,authenticated;
revoke all on function public.restart_match_request(uuid) from public,anon,authenticated;
revoke all on function public.get_match_round_settlement_state(uuid) from public,anon,authenticated;
revoke all on function public.settle_match_round(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.save_room_member_intro(uuid,uuid,text,uuid[]) from public,anon,authenticated;
revoke all on function public.list_suitable_open_rooms(uuid,integer) from public,anon,authenticated;
revoke all on function public.join_open_match_room(uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.withdraw_room_member(uuid,uuid) from public,anon,authenticated;
revoke all on function public.list_pending_room_change_notifications(integer) from public,anon,authenticated;
revoke all on function public.mark_room_change_notification_delivered(uuid,uuid) from public,anon,authenticated;
revoke all on function public.list_pending_draft_change_notifications(integer) from public,anon,authenticated;
revoke all on function public.mark_draft_change_notification_delivered(uuid,uuid) from public,anon,authenticated;
revoke all on function public.enqueue_llm_job(text,jsonb,text,integer,text,timestamptz) from public,anon,authenticated;

grant execute on function public.start_adventurex_onboarding(uuid) to service_role;
grant execute on function public.update_adventurex_onboarding_state(uuid,text,boolean) to service_role;
grant execute on function public.list_active_social_hooks(uuid,integer) to service_role;
grant execute on function public.save_social_hooks(uuid,jsonb) to service_role;
grant execute on function public.forget_social_hook(uuid,uuid) to service_role;
grant execute on function public.create_or_get_match_round(text,timestamptz) to service_role;
grant execute on function public.add_request_to_match_round(uuid,uuid) to service_role;
grant execute on function public.list_match_round_candidates(uuid) to service_role;
grant execute on function public.save_match_round_proposals(uuid,jsonb,jsonb,timestamptz) to service_role;
grant execute on function public.list_current_match_options(uuid) to service_role;
grant execute on function public.save_match_choices(uuid,smallint,smallint[],uuid[],text) to service_role;
grant execute on function public.expire_match_options(uuid) to service_role;
grant execute on function public.restart_match_request(uuid) to service_role;
grant execute on function public.get_match_round_settlement_state(uuid) to service_role;
grant execute on function public.settle_match_round(uuid,jsonb) to service_role;
grant execute on function public.save_room_member_intro(uuid,uuid,text,uuid[]) to service_role;
grant execute on function public.list_suitable_open_rooms(uuid,integer) to service_role;
grant execute on function public.join_open_match_room(uuid,uuid,integer) to service_role;
grant execute on function public.withdraw_room_member(uuid,uuid) to service_role;
grant execute on function public.list_pending_room_change_notifications(integer) to service_role;
grant execute on function public.mark_room_change_notification_delivered(uuid,uuid) to service_role;
grant execute on function public.list_pending_draft_change_notifications(integer) to service_role;
grant execute on function public.mark_draft_change_notification_delivered(uuid,uuid) to service_role;
grant execute on function public.enqueue_llm_job(text,jsonb,text,integer,text,timestamptz) to service_role;
