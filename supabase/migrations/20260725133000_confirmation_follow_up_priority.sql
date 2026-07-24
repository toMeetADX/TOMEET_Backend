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
    select mr.*, 0 as interest_priority, 0 as follow_up_priority
    from match_round_requests mrr
    join match_requests mr on mr.id = mrr.request_id
    where mrr.round_id = p_round_id
      and mr.status = 'matching' and mr.phase = 'waiting' and mr.active_round_id = p_round_id
    union all
    select mr.*, 1 as interest_priority,
      case when exists (select 1 from match_choices c where c.request_id = mr.id) then 0 else 1 end as follow_up_priority
    from match_requests mr cross join target_round r
    where r.bucket_key not like 'adventurex-test:%'
      and mr.status = 'matching' and mr.phase = 'watching' and mr.proactive_push_enabled
      and coalesce((mr.intent_snapshot->>'virtualTestUser')::boolean, false) = false
  )
  select jsonb_build_object(
    'request', to_jsonb(e) - 'interest_priority' - 'follow_up_priority',
    'user_model', to_jsonb(um),
    'matching_narrative', case
      when ump.stale and ump.version = 0 then um.vibe_narrative
      when ump.stale then ''
      else coalesce(nullif(ump.matching_narrative,''), um.vibe_narrative)
    end,
    'social_hooks', coalesce((select jsonb_agg(hook) from list_active_social_hooks(e.user_id, 12) hook), '[]'::jsonb),
    'matching_priority', case
      when e.interest_priority = 0 then 'active_waiting'
      when e.follow_up_priority = 0 then 'confirmation_follow_up'
      else 'watching'
    end
  )
  from eligible e
  join user_models um on um.user_id = e.user_id
  left join user_memory_profiles ump on ump.user_id = e.user_id
  order by e.interest_priority, e.follow_up_priority, e.created_at
  limit 24;
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
  update match_requests mr set
    status = case
      when mr.proactive_push_enabled then 'matching'
      when exists (select 1 from match_choices c where c.request_id = mr.id and c.round_id = p_round_id) then 'matching'
      else 'expired'
    end,
    phase = case
      when mr.proactive_push_enabled then 'watching'
      when exists (select 1 from match_choices c where c.request_id = mr.id and c.round_id = p_round_id) then 'push_consent'
      else 'waiting'
    end,
    active_round_id = null,
    options_expires_at = null,
    updated_at = now()
  where mr.id in (select request_id from match_round_requests where round_id = p_round_id)
    and mr.status = 'matching' and mr.active_round_id = p_round_id;
  update match_option_offers set status = 'expired' where round_id = p_round_id and status <> 'accepted';
  update match_rounds set status = 'completed', updated_at = now() where id = p_round_id;
end;
$$;

revoke all on function public.list_match_round_candidates(uuid) from public,anon,authenticated;
revoke all on function public.settle_match_round(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.list_match_round_candidates(uuid) to service_role;
grant execute on function public.settle_match_round(uuid,jsonb) to service_role;
