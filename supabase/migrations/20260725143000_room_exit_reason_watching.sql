alter table public.room_members
  add column if not exists withdrawal_reason text;

alter table public.room_members
  drop constraint if exists room_members_withdrawal_reason_check;
alter table public.room_members
  add constraint room_members_withdrawal_reason_check
  check (
    withdrawal_reason is null
    or char_length(btrim(withdrawal_reason)) between 1 and 500
  );

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
  v_room match_rooms%rowtype;
  v_game offline_games%rowtype;
  v_member room_members%rowtype;
  v_reason text;
  v_remaining integer;
begin
  select * into v_room from match_rooms where id = p_room_id for update;
  if not found then
    raise exception '房间不存在' using errcode = 'P0002';
  end if;
  if v_room.status = 'completed' then
    raise exception '活动已完成' using errcode = 'P0001';
  end if;

  select * into v_member
  from room_members
  where room_id = p_room_id
    and user_id = p_user_id
    and participation_status <> 'withdrawn'
  for update;
  if not found then
    raise exception '用户不在当前房间中' using errcode = 'P0001';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if (v_room.status = 'confirmed' or v_member.confirmed) and v_reason is null then
    raise exception '正式成局后退出需要说明一个理由' using errcode = 'P0001';
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception '退出理由不能超过 500 字' using errcode = 'P0001';
  end if;

  select * into v_game from offline_games where id = v_room.offline_game_id;

  update room_members set
    confirmed = false,
    participation_status = 'withdrawn',
    withdrawn_at = now(),
    withdrawal_reason = v_reason
  where room_id = p_room_id and user_id = p_user_id;

  select count(*) into v_remaining
  from room_members
  where room_id = p_room_id and participation_status = 'confirmed';

  update match_rooms set
    version = version + 1,
    status = case when v_remaining >= v_game.min_players then 'confirmed' else 'confirming' end,
    recruitment_status = 'open'
  where id = p_room_id
  returning * into v_room;

  update match_requests set
    status = case when proactive_push_enabled then 'matching' else 'cancelled' end,
    phase = case when proactive_push_enabled then 'watching' else 'waiting' end,
    room_id = null,
    active_round_id = null,
    options_expires_at = null,
    updated_at = now()
  where room_id = p_room_id and user_id = p_user_id;

  perform record_room_change_event(
    p_room_id,
    'member_withdrawn',
    jsonb_build_object('withdrawnUserId', p_user_id, 'memberCount', v_remaining)
  );
  return get_match_room(p_room_id);
end;
$$;

create or replace function public.list_suitable_open_rooms(
  p_user_id uuid,
  p_limit integer default 3
)
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select get_match_room(r.id)
  from match_rooms r
  join offline_games g on g.id = r.offline_game_id
  where r.status <> 'completed'
    and r.recruitment_status = 'open'
    and not exists (
      select 1 from room_members rm
      where rm.room_id = r.id and rm.user_id = p_user_id
    )
    and (
      select count(*) from room_members rm
      where rm.room_id = r.id and rm.participation_status = 'confirmed'
    ) < least(coalesce(r.target_players, g.max_players), g.max_players)
  order by r.created_at
  limit least(greatest(p_limit, 1), 10);
$$;

revoke all on function public.withdraw_room_member(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.withdraw_room_member_with_reason(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.list_suitable_open_rooms(uuid,integer) from public,anon,authenticated;

grant execute on function public.withdraw_room_member_with_reason(uuid,uuid,text) to service_role;
grant execute on function public.list_suitable_open_rooms(uuid,integer) to service_role;
