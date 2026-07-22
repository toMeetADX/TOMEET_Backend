alter table public.conversations
  add column if not exists summarized_message_count integer not null default 0
  check (summarized_message_count >= 0);

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
    select 1
    from room_members rm
    join match_rooms mr on mr.id = rm.room_id
    where rm.user_id = p_user_id and mr.status <> 'completed'
  ) then
    raise exception '你还有一个未结束的匹配房间' using errcode = 'P0001';
  end if;
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
  if v_row.status <> 'matching' then raise exception '只能取消仍在匹配中的请求' using errcode = 'P0001'; end if;
  update match_requests set status = 'cancelled', updated_at = now()
  where id = p_request_id returning * into v_row;
  return to_jsonb(v_row);
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
  if exists (select 1 from room_members where room_id = p_room_id and not confirmed) then
    raise exception '所有成员确认后才能完成活动' using errcode = 'P0001';
  end if;
  update match_rooms
  set status = 'completed', completed_at = coalesce(completed_at, now())
  where id = p_room_id;
  update user_models
  set current_intent = '{}'::jsonb, version = version + 1, updated_at = now()
  where user_id in (select user_id from room_members where room_id = p_room_id)
    and current_intent <> '{}'::jsonb;
  return get_match_room(p_room_id);
end;
$$;

create or replace function public.track_match_social_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'matched' and new.room_id is not null
     and (old.status is distinct from new.status or old.room_id is distinct from new.room_id) then
    update user_models
    set social_history = case
          when social_history ? new.room_id::text then social_history
          else (social_history || to_jsonb(new.room_id::text))
        end,
        version = version + 1,
        updated_at = now()
    where user_id = new.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists match_requests_track_social_history on public.match_requests;
create trigger match_requests_track_social_history
after update of status, room_id on public.match_requests
for each row execute function public.track_match_social_history();

update user_models um
set social_history = history.room_ids,
    version = um.version + 1,
    updated_at = now()
from (
  select mr.user_id, jsonb_agg(distinct mr.room_id::text) as room_ids
  from match_requests mr
  where mr.status = 'matched' and mr.room_id is not null
  group by mr.user_id
) history
where um.user_id = history.user_id
  and not um.social_history @> history.room_ids;

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
  if v_user_id = any(v_connections) then
    raise exception '连接用户不能包含自己' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from unnest(v_connections) connection_id
    where not exists (
      select 1 from room_members
      where room_id = v_room_id and user_id = connection_id
    )
  ) then
    raise exception '连接用户必须是本次房间成员' using errcode = 'P0001';
  end if;
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

revoke all on function public.cancel_match_request(uuid) from public, anon, authenticated;
revoke all on function public.create_match_request(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.complete_match_room(uuid) from public, anon, authenticated;
revoke all on function public.save_post_event_feedback(jsonb) from public, anon, authenticated;
revoke all on function public.track_match_social_history() from public, anon, authenticated;
grant execute on function public.cancel_match_request(uuid) to service_role;
grant execute on function public.create_match_request(uuid, jsonb) to service_role;
grant execute on function public.complete_match_room(uuid) to service_role;
grant execute on function public.save_post_event_feedback(jsonb) to service_role;
