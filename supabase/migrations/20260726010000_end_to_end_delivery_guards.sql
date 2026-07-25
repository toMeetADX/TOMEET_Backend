alter table public.users
  add column if not exists adventurex_welcome_delivered_at timestamptz;

alter table public.llm_jobs drop constraint if exists llm_jobs_job_type_check;
alter table public.llm_jobs add constraint llm_jobs_job_type_check check (job_type in (
  'agent_reply','agent_event_reply','multimodal_understanding','matchmaking','match_round_generate',
  'match_round_settle','match_status_notify','room_change_notify','feedback_update',
  'memory_extract','memory_consolidate'
));

create or replace view public.adventurex_onboarding_states as
select
  id as user_id,
  adventurex_stage as stage,
  adventurex_image_declined as image_declined,
  adventurex_welcome_sent_at as welcome_sent_at,
  adventurex_state_created_at as created_at,
  adventurex_state_updated_at as updated_at,
  adventurex_preferred_language as preferred_language,
  adventurex_boundary_prompted_at as boundary_prompted_at,
  adventurex_welcome_delivered_at as welcome_delivered_at
from public.users;

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
    'welcome_delivered_at', adventurex_welcome_delivered_at,
    'created_at', adventurex_state_created_at,
    'updated_at', adventurex_state_updated_at
  )
  from users where id = p_user_id
$$;

create or replace function public.mark_adventurex_welcome_delivered(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform ensure_tomeet_user(p_user_id, '新朋友');
  update users set
    adventurex_welcome_delivered_at = coalesce(adventurex_welcome_delivered_at, now()),
    adventurex_welcome_sent_at = coalesce(adventurex_welcome_sent_at, now()),
    adventurex_stage = case when adventurex_stage = 'new' then 'awaiting_image_or_text' else adventurex_stage end,
    adventurex_state_updated_at = now()
  where id = p_user_id;
  return adventurex_onboarding_state(p_user_id);
end;
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
  v_ordinal integer; v_draft_expires_at timestamptz;
begin
  perform 1 from match_rounds where id = p_round_id and status not in ('completed','expired') for update;
  if not found then raise exception '匹配轮次不可保存' using errcode = 'P0001'; end if;
  v_draft_expires_at := coalesce(p_offer_expires_at, now() + interval '10 minutes');
  for v_draft in select value from jsonb_array_elements(coalesce(p_proposal->'drafts','[]'::jsonb)) loop
    insert into match_drafts (
      round_id, temp_draft_id, offline_game_id, target_players, rationale, expires_at
    ) values (
      p_round_id, v_draft->>'tempDraftId', v_draft->>'offlineGameId',
      (v_draft->>'targetPlayers')::smallint, v_draft->>'rationale', v_draft_expires_at
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

create or replace function public.activate_match_offer_window(
  p_request_id uuid,
  p_round_id uuid,
  p_window_seconds integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_request match_requests%rowtype; v_expires_at timestamptz;
begin
  if p_window_seconds not between 10 and 600 then
    raise exception '候选选择窗口必须在 10-600 秒之间' using errcode = 'P0001';
  end if;
  select * into v_request from match_requests where id=p_request_id for update;
  if not found or v_request.status <> 'matching' or v_request.phase <> 'offered'
    or v_request.active_round_id is distinct from p_round_id then
    raise exception '候选当前不能开始选择计时' using errcode = 'P0001';
  end if;
  v_expires_at := now() + make_interval(secs => p_window_seconds);
  update match_requests set options_expires_at=v_expires_at,updated_at=now() where id=p_request_id
  returning * into v_request;
  update match_rounds set
    offer_expires_at=greatest(coalesce(offer_expires_at,v_expires_at),v_expires_at),updated_at=now()
  where id=p_round_id;
  update match_drafts set expires_at=greatest(expires_at,v_expires_at),updated_at=now()
  where round_id=p_round_id and status='collecting';
  perform enqueue_llm_job(
    'match_round_settle',
    jsonb_build_object('roundId',p_round_id),
    'match-round-settle:' || p_round_id::text || ':' || floor(extract(epoch from v_expires_at))::bigint::text,
    3,
    'match-round:' || p_round_id::text,
    v_expires_at
  );
  return to_jsonb(v_request);
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
    and mr.options_expires_at is not null and mr.options_expires_at > now()
  order by mr.created_at desc limit 1
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
  v_previous_draft_ids uuid[]; v_draft_version integer; v_event_id uuid;
begin
  select * into v_request from match_requests where id=p_request_id for update;
  if not found or v_request.status<>'matching' or v_request.active_round_id is null then
    raise exception '匹配请求当前不能选择' using errcode='P0001';
  end if;
  if v_request.options_expires_at is null or v_request.options_expires_at<=now() then
    raise exception '候选尚未送达或已过期' using errcode='P0001';
  end if;
  if cardinality(coalesce(p_accepted_option_numbers,'{}')) not between 1 and 3 then
    raise exception '至少选择一个候选' using errcode='P0001';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_required_hook_ids,'{}')) hook_id
    where not exists (
      select 1 from match_option_offers o join match_option_offer_hooks oh on oh.offer_id=o.id
      where o.request_id=p_request_id and o.round_id=v_request.active_round_id
        and o.option_number=any(p_accepted_option_numbers) and oh.hook_id=hook_id
    )
  ) then raise exception 'required hook 必须来自已接受候选' using errcode='P0001'; end if;
  select coalesce(array_agg(draft_id) filter (where draft_id is not null),'{}'::uuid[])
  into v_previous_draft_ids from match_choices
  where request_id=p_request_id and round_id=v_request.active_round_id;
  delete from match_choices where request_id=p_request_id and round_id=v_request.active_round_id;
  foreach v_number in array p_accepted_option_numbers loop
    v_index := v_index+1;
    select * into v_offer from match_option_offers
    where request_id=p_request_id and round_id=v_request.active_round_id
      and option_number=v_number and status<>'expired' for update;
    if not found then raise exception '选择包含不存在的候选编号' using errcode='P0001'; end if;
    v_rank := case when p_preferred_option_number is null or v_number=p_preferred_option_number then 1 else least(3,v_index+1) end;
    insert into match_choices (request_id,round_id,source_type,draft_id,room_id,preference_rank,raw_user_text)
    values (p_request_id,v_request.active_round_id,v_offer.source_type,v_offer.draft_id,v_offer.room_id,v_rank,p_raw_user_text)
    returning id into v_choice_id;
    for v_hook_id in select unnest(coalesce(p_required_hook_ids,'{}')) loop
      insert into match_choice_required_hooks (choice_id,hook_id,source_user_id)
      select v_choice_id,oh.hook_id,oh.source_user_id from match_option_offer_hooks oh
      where oh.offer_id=v_offer.id and oh.hook_id=v_hook_id on conflict do nothing;
    end loop;
    if v_offer.source_type='draft' and not (v_offer.draft_id=any(v_previous_draft_ids)) then
      update match_drafts set version=version+1,updated_at=now()
      where id=v_offer.draft_id and status='collecting' returning version into v_draft_version;
      if found then
        insert into match_draft_change_events (draft_id,draft_version,change_type,payload)
        values (v_offer.draft_id,v_draft_version,'confirmed_member_joined',
          jsonb_build_object('joinedUserId',v_request.user_id)) returning id into v_event_id;
        insert into match_draft_change_notifications (event_id,user_id,idempotency_key)
        select distinct v_event_id,mr.user_id,
          'draft-change:'||v_event_id::text||':'||mr.user_id::text
        from match_choices c join match_requests mr on mr.id=c.request_id
        where c.draft_id=v_offer.draft_id and mr.user_id<>v_request.user_id
        on conflict do nothing;
      end if;
    end if;
    return next to_jsonb(v_offer)||jsonb_build_object(
      'id',v_choice_id,'preference_rank',v_rank,'raw_user_text',p_raw_user_text,
      'created_at',now(),'required_hook_ids',coalesce((
        select jsonb_agg(hook_id) from match_choice_required_hooks where choice_id=v_choice_id
      ),'[]'::jsonb)
    );
  end loop;
  update match_option_offers set
    status=case when option_number=any(p_accepted_option_numbers) then 'accepted' else 'rejected' end,
    responded_at=now()
  where request_id=p_request_id and round_id=v_request.active_round_id and status<>'expired';
  update match_requests set phase='selected',updated_at=now() where id=p_request_id;
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
declare v_delivery channel_message_deliveries%rowtype; v_idempotency_key text;
begin
  select * into v_delivery from channel_message_deliveries d
  where d.id=p_outbound_id and d.provider='wechat' and d.direction='outbound' and d.locked_by=p_worker_id
  for update;
  if not found then return; end if;
  select idempotency_key into v_idempotency_key from messages where id=v_delivery.message_id;
  if p_error is null then
    update channel_message_deliveries set
      status='sent',completed_at=now(),locked_by=null,locked_at=null,last_error=null,updated_at=now()
    where id=p_outbound_id;
    if v_idempotency_key like 'match-options:%' then
      perform activate_match_offer_window(
        split_part(v_idempotency_key,':',3)::uuid,
        split_part(v_idempotency_key,':',2)::uuid,
        90
      );
    end if;
  else
    update channel_message_deliveries set
      status=case when attempts>=5 then 'failed' else 'retry' end,
      run_at=now()+make_interval(secs=>least(300,5*power(2,greatest(attempts-1,0))::integer)),
      locked_by=null,locked_at=null,last_error=left(p_error,1000),updated_at=now()
    where id=p_outbound_id;
  end if;
end;
$$;

create or replace function public.withdraw_room_member_with_reason(
  p_room_id uuid,
  p_user_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room match_rooms%rowtype; v_game offline_games%rowtype; v_member room_members%rowtype;
  v_reason text; v_remaining integer;
begin
  select * into v_room from match_rooms where id=p_room_id for update;
  if not found then raise exception '房间不存在' using errcode='P0002'; end if;
  if v_room.status='completed' then raise exception '活动已完成' using errcode='P0001'; end if;
  select * into v_member from room_members
  where room_id=p_room_id and user_id=p_user_id and participation_status<>'withdrawn' for update;
  if not found then raise exception '用户不在当前房间中' using errcode='P0001'; end if;
  v_reason := nullif(btrim(coalesce(p_reason,'')),'');
  if (v_room.status='confirmed' or v_member.confirmed) and v_reason is null then
    raise exception '正式成局后退出需要说明一个理由' using errcode='P0001';
  end if;
  if v_reason is not null and char_length(v_reason)>500 then
    raise exception '退出理由不能超过 500 字' using errcode='P0001';
  end if;
  select * into v_game from offline_games where id=v_room.offline_game_id;
  update room_members set confirmed=false,participation_status='withdrawn',withdrawn_at=now(),withdrawal_reason=v_reason
  where room_id=p_room_id and user_id=p_user_id;
  select count(*) into v_remaining from room_members
  where room_id=p_room_id and participation_status='confirmed';
  update match_rooms set version=version+1,
    status=case when v_remaining>=v_game.min_players then 'confirmed' else 'confirming' end,
    recruitment_status='open'
  where id=p_room_id returning * into v_room;
  update match_requests set status='cancelled',phase='waiting',proactive_push_enabled=false,room_id=null,
    active_round_id=null,options_expires_at=null,updated_at=now()
  where room_id=p_room_id and user_id=p_user_id;
  perform record_room_change_event(
    p_room_id,'member_withdrawn',jsonb_build_object('withdrawnUserId',p_user_id,'memberCount',v_remaining)
  );
  return get_match_room(p_room_id);
end;
$$;

revoke all on function public.mark_adventurex_welcome_delivered(uuid) from public,anon,authenticated;
revoke all on function public.activate_match_offer_window(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.mark_adventurex_welcome_delivered(uuid) to service_role;
grant execute on function public.activate_match_offer_window(uuid,uuid,integer) to service_role;
