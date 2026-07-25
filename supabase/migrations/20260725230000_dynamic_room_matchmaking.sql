alter table public.match_requests
  drop constraint if exists match_requests_status_check;
alter table public.match_requests
  add constraint match_requests_status_check
  check (status in ('matching', 'invited', 'matched', 'cancelled', 'expired'));

drop index if exists public.match_requests_one_active_per_user;
create unique index match_requests_one_active_per_user
  on public.match_requests (user_id)
  where status in ('matching', 'invited');

alter table public.match_rooms
  add column if not exists capacity smallint,
  add column if not exists matching_status text;

update public.match_rooms mr
set capacity = least(coalesce(mr.target_players, og.max_players), og.max_players),
    matching_status = case
      when mr.recruitment_status = 'full' then 'full'
      when mr.recruitment_status = 'open' then 'active'
      else 'stopped'
    end
from public.offline_games og
where og.id = mr.offline_game_id
  and (mr.capacity is null or mr.matching_status is null);

alter table public.match_rooms
  alter column capacity set default 10,
  alter column capacity set not null,
  alter column matching_status set default 'active',
  alter column matching_status set not null;
alter table public.match_rooms
  drop constraint if exists match_rooms_capacity_check;
alter table public.match_rooms
  add constraint match_rooms_capacity_check check (capacity between 2 and 10);
alter table public.match_rooms
  drop constraint if exists match_rooms_matching_status_check;
alter table public.match_rooms
  add constraint match_rooms_matching_status_check
  check (matching_status in ('active', 'stopped', 'full'));

create or replace function public.sync_match_room_matching_state()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_game_max smallint;
begin
  select max_players into v_game_max from offline_games where id = new.offline_game_id;
  new.capacity := least(coalesce(new.target_players, v_game_max), v_game_max);
  if tg_op = 'UPDATE'
     and old.matching_status = 'stopped'
     and new.matching_status = old.matching_status then
    new.recruitment_status := 'closed';
    new.matching_status := 'stopped';
  else
    new.matching_status := case
      when new.recruitment_status = 'full' then 'full'
      when new.recruitment_status = 'open' then 'active'
      else 'stopped'
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_match_room_matching_state on public.match_rooms;
create trigger sync_match_room_matching_state
before insert or update of offline_game_id, target_players, recruitment_status
on public.match_rooms
for each row execute function public.sync_match_room_matching_state();

create table if not exists public.match_invites (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('initial_pair', 'room_join')),
  room_id uuid references public.match_rooms(id) on delete cascade,
  inviter_user_id uuid references public.users(id) on delete cascade,
  inviter_request_id uuid references public.match_requests(id) on delete cascade,
  invitee_user_id uuid not null references public.users(id) on delete cascade,
  invitee_request_id uuid not null references public.match_requests(id) on delete cascade,
  inviter_accepted boolean not null default false,
  invitee_accepted boolean not null default false,
  offline_game_id text not null references public.offline_games(id),
  match_summary text not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  source_job_id uuid unique references public.llm_jobs(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint match_invites_shape_check check (
    (
      kind = 'initial_pair'
      and inviter_user_id is not null
      and inviter_request_id is not null
      and inviter_user_id <> invitee_user_id
      and inviter_request_id <> invitee_request_id
    )
    or (
      kind = 'room_join'
      and room_id is not null
      and inviter_user_id is null
      and inviter_request_id is null
      and inviter_accepted
    )
  )
);

create unique index if not exists match_invites_pending_invitee_request
  on public.match_invites (invitee_request_id)
  where status = 'pending';
create unique index if not exists match_invites_pending_inviter_request
  on public.match_invites (inviter_request_id)
  where status = 'pending' and inviter_request_id is not null;
create unique index if not exists match_invites_one_pending_per_room
  on public.match_invites (room_id)
  where status = 'pending' and kind = 'room_join';
create index if not exists match_invites_user_created_idx
  on public.match_invites (invitee_user_id, created_at desc);
create index if not exists match_invites_inviter_created_idx
  on public.match_invites (inviter_user_id, created_at desc)
  where inviter_user_id is not null;

alter table public.match_requests
  add column if not exists invite_id uuid;
alter table public.match_requests
  drop constraint if exists match_requests_invite_id_fkey;
alter table public.match_requests
  add constraint match_requests_invite_id_fkey
  foreign key (invite_id) references public.match_invites(id) on delete set null;

alter table public.match_invites enable row level security;
revoke all on table public.match_invites from public, anon, authenticated;
grant all on table public.match_invites to service_role;

create or replace function public.get_match_invite(p_invite_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'inviteId', mi.id,
    'kind', mi.kind,
    'roomId', mi.room_id,
    'participants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', participant.user_id,
        'requestId', participant.request_id,
        'displayName', u.display_name,
        'accepted', participant.accepted
      ) order by participant.position)
      from (
        select mi.inviter_user_id as user_id,
               mi.inviter_request_id as request_id,
               mi.inviter_accepted as accepted,
               1 as position
        where mi.inviter_user_id is not null
        union all
        select mi.invitee_user_id, mi.invitee_request_id, mi.invitee_accepted, 2
      ) participant
      join users u on u.id = participant.user_id
    ), '[]'::jsonb),
    'offlineGameId', mi.offline_game_id,
    'matchSummary', mi.match_summary,
    'status', mi.status,
    'createdAt', mi.created_at,
    'resolvedAt', mi.resolved_at
  )
  from match_invites mi
  where mi.id = p_invite_id;
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
        'confirmed', rm.confirmed,
        'participationStatus', rm.participation_status
      ) order by rm.created_at)
      from room_members rm
      join users u on u.id = rm.user_id
      where rm.room_id = mr.id
    ), '[]'::jsonb),
    'offlineGame', jsonb_build_object(
      'id', og.id,
      'name', og.name,
      'description', og.description,
      'minPlayers', og.min_players,
      'maxPlayers', og.max_players,
      'intentTags', to_jsonb(og.intent_tags),
      'traits', to_jsonb(og.traits),
      'requirements', to_jsonb(og.requirements),
      'instructions', to_jsonb(og.instructions)
    ),
    'matchSummary', mr.match_summary,
    'status', mr.status,
    'sourceDraftId', mr.source_draft_id,
    'targetPlayers', mr.target_players,
    'recruitmentStatus', mr.recruitment_status,
    'version', mr.version,
    'meetingPoint', mr.meeting_point,
    'matchingStatus', mr.matching_status,
    'capacity', mr.capacity,
    'createdAt', mr.created_at,
    'completedAt', mr.completed_at
  )
  from match_rooms mr
  join offline_games og on og.id = mr.offline_game_id
  where mr.id = p_room_id;
$$;

create or replace function public.create_match_request(
  p_user_id uuid,
  p_intent_snapshot jsonb
)
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
    where rm.user_id = p_user_id
      and rm.participation_status <> 'withdrawn'
      and mr.status <> 'completed'
  ) then
    raise exception '你还有一个未结束的匹配房间' using errcode = 'P0001';
  end if;

  select *
  into v_row
  from match_requests
  where user_id = p_user_id and status in ('matching', 'invited')
  order by created_at desc
  limit 1;
  if found then return to_jsonb(v_row); end if;

  begin
    insert into match_requests (user_id, intent_snapshot)
    values (p_user_id, p_intent_snapshot)
    returning * into v_row;
  exception when unique_violation then
    select *
    into v_row
    from match_requests
    where user_id = p_user_id and status in ('matching', 'invited')
    order by created_at desc
    limit 1;
  end;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.create_initial_match_invite(
  p_decision jsonb,
  p_source_job_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member_ids uuid[];
  v_request_ids uuid[];
  v_game_id text := p_decision->>'offlineGameId';
  v_summary text := nullif(p_decision->>'summary', '');
  v_invite_id uuid;
  v_required_request_id uuid;
  v_inviter_demo boolean;
  v_invitee_demo boolean;
begin
  if p_source_job_id is not null then
    select id into v_invite_id from match_invites where source_job_id = p_source_job_id;
    if found then return get_match_invite(v_invite_id); end if;
  end if;

  select array_agg(value::uuid order by ordinality)
  into v_member_ids
  from jsonb_array_elements_text(p_decision->'memberIds') with ordinality;
  select array_agg(value::uuid order by ordinality)
  into v_request_ids
  from jsonb_array_elements_text(p_decision->'requestIds') with ordinality;
  if coalesce(array_length(v_member_ids, 1), 0) <> 2
     or coalesce(array_length(v_request_ids, 1), 0) <> 2 then
    raise exception '初始匹配必须且只能包含两位用户' using errcode = 'P0001';
  end if;
  if v_member_ids[1] = v_member_ids[2] or v_request_ids[1] = v_request_ids[2] then
    raise exception '初始匹配成员或请求不能重复' using errcode = 'P0001';
  end if;

  if p_source_job_id is not null then
    select nullif(payload->>'requestId', '')::uuid
    into v_required_request_id
    from llm_jobs
    where id = p_source_job_id;
    if v_required_request_id is not null
       and not (v_required_request_id = any(v_request_ids)) then
      raise exception '匹配结果必须包含触发本次任务的用户' using errcode = 'P0001';
    end if;
  end if;

  perform 1
  from match_requests
  where id = any(v_request_ids)
  order by id
  for update;
  if (
    select count(*)
    from match_requests
    where id = any(v_request_ids) and status = 'matching'
  ) <> 2 then
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
  perform 1 from offline_games where id = v_game_id and active and max_players >= 2;
  if not found then
    raise exception '线下游戏不存在、已停用或房间上限无效' using errcode = 'P0001';
  end if;

  select is_demo into v_inviter_demo from users where id = v_member_ids[1];
  select is_demo into v_invitee_demo from users where id = v_member_ids[2];
  insert into match_invites (
    kind,
    inviter_user_id,
    inviter_request_id,
    invitee_user_id,
    invitee_request_id,
    inviter_accepted,
    invitee_accepted,
    offline_game_id,
    match_summary,
    source_job_id
  ) values (
    'initial_pair',
    v_member_ids[1],
    v_request_ids[1],
    v_member_ids[2],
    v_request_ids[2],
    coalesce(v_inviter_demo, false),
    coalesce(v_invitee_demo, false),
    v_game_id,
    coalesce(v_summary, '已找到当前最合适的初始匹配对象'),
    p_source_job_id
  )
  returning id into v_invite_id;

  update match_requests
  set status = 'invited', invite_id = v_invite_id, updated_at = now()
  where id = any(v_request_ids);
  return get_match_invite(v_invite_id);
end;
$$;

create or replace function public.create_room_join_invite(
  p_decision jsonb,
  p_source_job_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid := (p_decision->>'roomId')::uuid;
  v_user_id uuid := (p_decision->>'userId')::uuid;
  v_request_id uuid := (p_decision->>'requestId')::uuid;
  v_summary text := nullif(p_decision->>'summary', '');
  v_game_id text;
  v_matching_status text;
  v_capacity smallint;
  v_member_count integer;
  v_invite_id uuid;
  v_is_demo boolean;
begin
  if p_source_job_id is not null then
    select id into v_invite_id from match_invites where source_job_id = p_source_job_id;
    if found then return get_match_invite(v_invite_id); end if;
  end if;

  select offline_game_id, matching_status, capacity
  into v_game_id, v_matching_status, v_capacity
  from match_rooms
  where id = v_room_id and status <> 'completed'
  for update;
  if not found then raise exception '目标房间不存在或已经结束' using errcode = 'P0002'; end if;
  if v_matching_status <> 'active' then
    raise exception '目标房间已停止匹配' using errcode = 'P0001';
  end if;
  select count(*) into v_member_count
  from room_members
  where room_id = v_room_id and participation_status <> 'withdrawn';
  if v_member_count >= v_capacity then
    update match_rooms set matching_status = 'full' where id = v_room_id;
    raise exception '目标房间已满' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from match_invites
    where room_id = v_room_id and kind = 'room_join' and status = 'pending'
  ) then
    raise exception '目标房间已有待处理邀请' using errcode = 'P0001';
  end if;

  perform 1
  from match_requests
  where id = v_request_id and user_id = v_user_id and status = 'matching'
  for update;
  if not found then raise exception '入房候选请求已不在等待中' using errcode = 'P0001'; end if;
  if exists (
    select 1
    from room_members
    where room_id = v_room_id
      and user_id = v_user_id
      and participation_status <> 'withdrawn'
  ) then
    raise exception '候选用户已经在目标房间中' using errcode = 'P0001';
  end if;

  select is_demo into v_is_demo from users where id = v_user_id;
  insert into match_invites (
    kind,
    room_id,
    invitee_user_id,
    invitee_request_id,
    inviter_accepted,
    invitee_accepted,
    offline_game_id,
    match_summary,
    source_job_id
  ) values (
    'room_join',
    v_room_id,
    v_user_id,
    v_request_id,
    true,
    coalesce(v_is_demo, false),
    v_game_id,
    coalesce(v_summary, '邀请当前最适合房间氛围的下一位用户加入'),
    p_source_job_id
  )
  returning id into v_invite_id;

  update match_requests
  set status = 'invited', invite_id = v_invite_id, updated_at = now()
  where id = v_request_id;

  if coalesce(v_is_demo, false) then
    insert into room_members (
      room_id,
      user_id,
      confirmed,
      confirmed_at,
      participation_status,
      withdrawn_at
    )
    values (v_room_id, v_user_id, true, now(), 'confirmed', null)
    on conflict (room_id, user_id) do update
    set confirmed = true,
        confirmed_at = now(),
        participation_status = 'confirmed',
        withdrawn_at = null;
    update match_requests
    set status = 'matched',
        phase = 'settling',
        room_id = v_room_id,
        updated_at = now()
    where id = v_request_id;
    update match_rooms
    set version = version + 1,
        recruitment_status = case when v_member_count + 1 >= v_capacity then 'full' else 'open' end
    where id = v_room_id;
    perform record_room_change_event(
      v_room_id,
      'member_joined',
      jsonb_build_object('joinedUserId', v_user_id, 'memberCount', v_member_count + 1)
    );
    update match_invites
    set status = 'accepted', resolved_at = now()
    where id = v_invite_id;
    if v_member_count + 1 >= v_capacity then
      update match_rooms set matching_status = 'full' where id = v_room_id;
    end if;
  end if;

  return get_match_invite(v_invite_id);
end;
$$;

create or replace function public.accept_match_invite(
  p_invite_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite match_invites%rowtype;
  v_room_id uuid;
  v_capacity smallint;
  v_member_count integer;
  v_game_max smallint;
begin
  select * into v_invite from match_invites where id = p_invite_id for update;
  if not found then raise exception '匹配邀请不存在' using errcode = 'P0002'; end if;
  if p_user_id is distinct from v_invite.inviter_user_id
     and p_user_id is distinct from v_invite.invitee_user_id then
    raise exception '用户不在该匹配邀请中' using errcode = 'P0001';
  end if;
  if v_invite.status = 'accepted' then
    return jsonb_build_object(
      'invite', get_match_invite(p_invite_id),
      'room', get_match_room(v_invite.room_id),
      'requeuedRequestIds', '[]'::jsonb
    );
  end if;
  if v_invite.status <> 'pending' then
    raise exception '该匹配邀请已失效' using errcode = 'P0001';
  end if;

  if p_user_id = v_invite.inviter_user_id then
    update match_invites set inviter_accepted = true where id = p_invite_id;
  else
    update match_invites set invitee_accepted = true where id = p_invite_id;
  end if;
  select * into v_invite from match_invites where id = p_invite_id;
  if not (v_invite.inviter_accepted and v_invite.invitee_accepted) then
    return jsonb_build_object(
      'invite', get_match_invite(p_invite_id),
      'room', null,
      'requeuedRequestIds', '[]'::jsonb
    );
  end if;

  if v_invite.kind = 'initial_pair' then
    select max_players into v_game_max
    from offline_games
    where id = v_invite.offline_game_id and active
    for share;
    if not found then raise exception '线下游戏不存在或已停用' using errcode = 'P0001'; end if;

    insert into match_rooms (
      offline_game_id,
      match_summary,
      status,
      target_players,
      recruitment_status,
      matching_status,
      capacity
    ) values (
      v_invite.offline_game_id,
      v_invite.match_summary,
      'confirmed',
      case when v_game_max >= 3 then v_game_max else null end,
      case when v_game_max <= 2 then 'full' else 'open' end,
      case when v_game_max <= 2 then 'full' else 'active' end,
      v_game_max
    )
    returning id into v_room_id;
    insert into room_members (
      room_id,
      user_id,
      confirmed,
      confirmed_at,
      participation_status
    )
    values
      (v_room_id, v_invite.inviter_user_id, true, now(), 'confirmed'),
      (v_room_id, v_invite.invitee_user_id, true, now(), 'confirmed');
    update match_requests
    set status = 'matched',
        phase = 'settling',
        room_id = v_room_id,
        updated_at = now()
    where id in (v_invite.inviter_request_id, v_invite.invitee_request_id);
  else
    v_room_id := v_invite.room_id;
    select capacity into v_capacity
    from match_rooms
    where id = v_room_id and status <> 'completed' and matching_status = 'active'
    for update;
    if not found then raise exception '目标房间已停止匹配' using errcode = 'P0001'; end if;
    select count(*) into v_member_count
    from room_members
    where room_id = v_room_id and participation_status <> 'withdrawn';
    if v_member_count >= v_capacity then
      update match_rooms set matching_status = 'full' where id = v_room_id;
      raise exception '目标房间已满' using errcode = 'P0001';
    end if;
    insert into room_members (
      room_id,
      user_id,
      confirmed,
      confirmed_at,
      participation_status,
      withdrawn_at
    )
    values (v_room_id, v_invite.invitee_user_id, true, now(), 'confirmed', null)
    on conflict (room_id, user_id) do update
    set confirmed = true,
        confirmed_at = now(),
        participation_status = 'confirmed',
        withdrawn_at = null;
    update match_requests
    set status = 'matched',
        phase = 'settling',
        room_id = v_room_id,
        updated_at = now()
    where id = v_invite.invitee_request_id;
    update match_rooms
    set version = version + 1,
        recruitment_status = case when v_member_count + 1 >= v_capacity then 'full' else 'open' end
    where id = v_room_id;
    perform record_room_change_event(
      v_room_id,
      'member_joined',
      jsonb_build_object(
        'joinedUserId',
        v_invite.invitee_user_id,
        'memberCount',
        v_member_count + 1
      )
    );
    if v_member_count + 1 >= v_capacity then
      update match_rooms set matching_status = 'full' where id = v_room_id;
    end if;
  end if;

  update match_invites
  set room_id = v_room_id, status = 'accepted', resolved_at = now()
  where id = p_invite_id;
  return jsonb_build_object(
    'invite', get_match_invite(p_invite_id),
    'room', get_match_room(v_room_id),
    'requeuedRequestIds', '[]'::jsonb
  );
end;
$$;

create or replace function public.decline_match_invite(
  p_invite_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite match_invites%rowtype;
  v_declined_request_id uuid;
  v_requeued_request_id uuid;
begin
  select * into v_invite from match_invites where id = p_invite_id for update;
  if not found then raise exception '匹配邀请不存在' using errcode = 'P0002'; end if;
  if v_invite.status = 'declined' then
    return jsonb_build_object(
      'invite', get_match_invite(p_invite_id),
      'room', get_match_room(v_invite.room_id),
      'requeuedRequestIds', '[]'::jsonb
    );
  end if;
  if v_invite.status <> 'pending' then
    raise exception '该匹配邀请已失效' using errcode = 'P0001';
  end if;
  if p_user_id = v_invite.inviter_user_id then
    v_declined_request_id := v_invite.inviter_request_id;
    v_requeued_request_id := v_invite.invitee_request_id;
  elsif p_user_id = v_invite.invitee_user_id then
    v_declined_request_id := v_invite.invitee_request_id;
    v_requeued_request_id := case
      when v_invite.kind = 'initial_pair' then v_invite.inviter_request_id
      else null
    end;
  else
    raise exception '用户不在该匹配邀请中' using errcode = 'P0001';
  end if;

  update match_invites
  set status = 'declined', resolved_at = now()
  where id = p_invite_id;
  update match_requests
  set status = 'cancelled',
      phase = 'waiting',
      active_round_id = null,
      options_expires_at = null,
      invite_id = null,
      updated_at = now()
  where id = v_declined_request_id and status = 'invited';
  if v_requeued_request_id is not null then
    update match_requests
    set status = 'matching',
        phase = 'waiting',
        active_round_id = null,
        options_expires_at = null,
        invite_id = null,
        updated_at = now()
    where id = v_requeued_request_id and status = 'invited';
  end if;

  return jsonb_build_object(
    'invite', get_match_invite(p_invite_id),
    'room', get_match_room(v_invite.room_id),
    'requeuedRequestIds', case
      when v_requeued_request_id is null then '[]'::jsonb
      else jsonb_build_array(v_requeued_request_id)
    end
  );
end;
$$;

create or replace function public.stop_room_matching(
  p_room_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requeued_request_ids uuid[];
begin
  perform 1
  from match_rooms
  where id = p_room_id and status <> 'completed'
  for update;
  if not found then raise exception '房间不存在或已经结束' using errcode = 'P0002'; end if;
  perform 1
  from room_members
  where room_id = p_room_id
    and user_id = p_user_id
    and participation_status <> 'withdrawn';
  if not found then raise exception '用户不在房间中' using errcode = 'P0001'; end if;

  update match_rooms
  set matching_status = case when matching_status = 'active' then 'stopped' else matching_status end,
      recruitment_status = case when recruitment_status = 'open' then 'closed' else recruitment_status end
  where id = p_room_id;

  select coalesce(array_agg(invitee_request_id), '{}')
  into v_requeued_request_ids
  from match_invites
  where room_id = p_room_id and kind = 'room_join' and status = 'pending';
  update match_invites
  set status = 'cancelled', resolved_at = now()
  where room_id = p_room_id and kind = 'room_join' and status = 'pending';
  update match_requests
  set status = 'matching',
      phase = 'waiting',
      active_round_id = null,
      options_expires_at = null,
      invite_id = null,
      updated_at = now()
  where id = any(v_requeued_request_ids) and status = 'invited';

  return jsonb_build_object(
    'room', get_match_room(p_room_id),
    'requeuedRequestIds', to_jsonb(v_requeued_request_ids)
  );
end;
$$;

create or replace function public.list_open_match_rooms(p_limit integer default 20)
returns setof jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'room', get_match_room(mr.id),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'request', to_jsonb(member_request),
        'user_model', to_jsonb(um),
        'matching_narrative', case
          when ump.stale and ump.version = 0 then um.vibe_narrative
          when ump.stale then ''
          when ump.version is null or ump.version = 0
            then coalesce(nullif(ump.matching_narrative, ''), um.vibe_narrative)
          else ump.matching_narrative
        end
      ) order by rm.created_at)
      from room_members rm
      join user_models um on um.user_id = rm.user_id
      left join user_memory_profiles ump on ump.user_id = rm.user_id
      join lateral (
        select match_request.*
        from match_requests match_request
        where match_request.user_id = rm.user_id
          and match_request.room_id = mr.id
        order by match_request.created_at desc
        limit 1
      ) member_request on true
      where rm.room_id = mr.id
        and rm.participation_status <> 'withdrawn'
    ), '[]'::jsonb)
  )
  from match_rooms mr
  where mr.status <> 'completed'
    and mr.matching_status = 'active'
    and (
      select count(*)
      from room_members rm
      where rm.room_id = mr.id and rm.participation_status <> 'withdrawn'
    ) < mr.capacity
    and not exists (
      select 1
      from match_invites mi
      where mi.room_id = mr.id and mi.kind = 'room_join' and mi.status = 'pending'
    )
  order by mr.created_at
  limit least(greatest(p_limit, 1), 100);
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
  if exists (
    select 1
    from room_members
    where room_id = p_room_id
      and participation_status <> 'withdrawn'
      and not confirmed
  ) then
    raise exception '所有成员确认后才能完成活动' using errcode = 'P0001';
  end if;
  update match_rooms
  set status = 'completed',
      matching_status = case when matching_status = 'full' then 'full' else 'stopped' end,
      recruitment_status = case when matching_status = 'full' then 'full' else 'closed' end,
      completed_at = coalesce(completed_at, now())
  where id = p_room_id;
  update user_models
  set current_intent = '{}'::jsonb, version = version + 1, updated_at = now()
  where user_id in (
    select user_id
    from room_members
    where room_id = p_room_id and participation_status <> 'withdrawn'
  )
    and current_intent <> '{}'::jsonb;
  return get_match_room(p_room_id);
end;
$$;

revoke all on function public.get_match_invite(uuid) from public, anon, authenticated;
revoke all on function public.get_match_room(uuid) from public, anon, authenticated;
revoke all on function public.create_match_request(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.create_initial_match_invite(jsonb, uuid) from public, anon, authenticated;
revoke all on function public.create_room_join_invite(jsonb, uuid) from public, anon, authenticated;
revoke all on function public.accept_match_invite(uuid, uuid) from public, anon, authenticated;
revoke all on function public.decline_match_invite(uuid, uuid) from public, anon, authenticated;
revoke all on function public.stop_room_matching(uuid, uuid) from public, anon, authenticated;
revoke all on function public.list_open_match_rooms(integer) from public, anon, authenticated;
revoke all on function public.complete_match_room(uuid) from public, anon, authenticated;
revoke all on function public.sync_match_room_matching_state() from public, anon, authenticated;
revoke execute on function public.create_match_room(jsonb, uuid) from service_role;

grant execute on function public.get_match_invite(uuid) to service_role;
grant execute on function public.get_match_room(uuid) to service_role;
grant execute on function public.create_match_request(uuid, jsonb) to service_role;
grant execute on function public.create_initial_match_invite(jsonb, uuid) to service_role;
grant execute on function public.create_room_join_invite(jsonb, uuid) to service_role;
grant execute on function public.accept_match_invite(uuid, uuid) to service_role;
grant execute on function public.decline_match_invite(uuid, uuid) to service_role;
grant execute on function public.stop_room_matching(uuid, uuid) to service_role;
grant execute on function public.list_open_match_rooms(integer) to service_role;
grant execute on function public.complete_match_room(uuid) to service_role;
