alter table public.room_members
  add column if not exists role text not null default 'member';
alter table public.room_members
  add constraint room_members_role_check check (role in ('founder', 'member'));

with ranked as (
  select room_id, user_id,
         row_number() over (partition by room_id order by created_at, user_id) as position
  from public.room_members
)
update public.room_members member
set role = case when ranked.position <= 2 then 'founder' else 'member' end
from ranked
where member.room_id = ranked.room_id and member.user_id = ranked.user_id;

alter table public.match_invites
  add column if not exists event_plan_seed jsonb;

create table if not exists public.room_event_plans (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.match_rooms(id) on delete cascade,
  version integer not null check (version > 0),
  status text not null check (status in ('draft', 'published', 'superseded')),
  starts_at timestamptz,
  ends_at timestamptz,
  time_zone text not null default 'Asia/Shanghai'
    check (char_length(time_zone) between 1 and 64),
  time_note text not null check (char_length(time_note) between 1 and 500),
  location_name text,
  location_address text,
  location_url text,
  location_note text not null check (char_length(location_note) between 1 and 500),
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (room_id, version),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check (location_url is null or location_url ~ '^https?://')
);

create unique index if not exists room_event_plans_one_draft_idx
  on public.room_event_plans (room_id) where status = 'draft';
create unique index if not exists room_event_plans_one_published_idx
  on public.room_event_plans (room_id) where status = 'published';
create index if not exists room_event_plans_room_version_idx
  on public.room_event_plans (room_id, version desc);

create table if not exists public.room_event_plan_games (
  plan_id uuid not null references public.room_event_plans(id) on delete cascade,
  game_id text not null references public.offline_games(id),
  position smallint not null check (position between 0 and 4),
  is_primary boolean not null default false,
  primary key (plan_id, game_id),
  unique (plan_id, position)
);
create unique index if not exists room_event_plan_games_one_primary_idx
  on public.room_event_plan_games (plan_id) where is_primary;

create table if not exists public.room_event_plan_confirmations (
  plan_id uuid not null references public.room_event_plans(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  confirmed_at timestamptz not null default now(),
  primary key (plan_id, user_id)
);

alter table public.room_event_plans enable row level security;
alter table public.room_event_plan_games enable row level security;
alter table public.room_event_plan_confirmations enable row level security;

revoke all on table public.room_event_plans from public, anon, authenticated;
revoke all on table public.room_event_plan_games from public, anon, authenticated;
revoke all on table public.room_event_plan_confirmations from public, anon, authenticated;
grant select, insert, update, delete on table public.room_event_plans to service_role;
grant select, insert, update, delete on table public.room_event_plan_games to service_role;
grant select, insert, update, delete on table public.room_event_plan_confirmations to service_role;

do $$
declare
  v_room record;
  v_plan_id uuid;
begin
  for v_room in
    select id, offline_game_id, status, created_at, completed_at
    from public.match_rooms
    where not exists (
      select 1 from public.room_event_plans plan where plan.room_id = match_rooms.id
    )
  loop
    insert into public.room_event_plans (
      room_id, version, status, time_note, location_note, created_at, published_at
    ) values (
      v_room.id,
      1,
      case when v_room.status = 'completed' then 'published' else 'draft' end,
      case when v_room.status = 'completed' then '历史房间未记录时间' else '待商定' end,
      case when v_room.status = 'completed' then '历史房间未记录地点' else '待商定' end,
      v_room.created_at,
      case when v_room.status = 'completed' then coalesce(v_room.completed_at, v_room.created_at) else null end
    )
    returning id into v_plan_id;

    insert into public.room_event_plan_games (plan_id, game_id, position, is_primary)
    values (v_plan_id, v_room.offline_game_id, 0, true);
  end loop;
end;
$$;

update public.match_rooms room
set recruitment_status = 'closed',
    matching_status = 'stopped'
where exists (
  select 1
  from public.room_event_plans plan
  where plan.room_id = room.id and plan.status = 'draft'
);

create or replace function public.initialize_room_event_plan_on_member()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_room public.match_rooms%rowtype;
  v_plan_id uuid;
begin
  with ranked as (
    select room_id,
           user_id,
           row_number() over (
             partition by room_id
             order by created_at, user_id
           ) as position
    from public.room_members
    where room_id = new.room_id
  )
  update public.room_members member
  set role = case when ranked.position <= 2 then 'founder' else 'member' end
  from ranked
  where member.room_id = ranked.room_id
    and member.user_id = ranked.user_id;

  select * into v_room
  from public.match_rooms
  where id = new.room_id;

  if v_room.source_draft_id is not null
     and not exists (
       select 1
       from public.room_event_plans plan
       where plan.room_id = new.room_id
     ) then
    insert into public.room_event_plans (
      room_id,
      version,
      status,
      time_note,
      location_note,
      created_at
    ) values (
      new.room_id,
      1,
      'draft',
      '待商定',
      '待商定',
      v_room.created_at
    )
    returning id into v_plan_id;

    insert into public.room_event_plan_games (
      plan_id, game_id, position, is_primary
    ) values (
      v_plan_id, v_room.offline_game_id, 0, true
    );

    update public.match_rooms
    set recruitment_status = 'closed',
        matching_status = 'stopped'
    where id = new.room_id;
  end if;

  return new;
end;
$$;

create trigger initialize_room_event_plan_after_member
after insert on public.room_members
for each row execute function public.initialize_room_event_plan_on_member();

create or replace function public.get_room_event_plan(p_plan_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'planId', plan.id,
    'roomId', plan.room_id,
    'version', plan.version,
    'status', plan.status,
    'time', jsonb_build_object(
      'startsAt', plan.starts_at,
      'endsAt', plan.ends_at,
      'timeZone', plan.time_zone,
      'note', plan.time_note
    ),
    'location', jsonb_build_object(
      'name', plan.location_name,
      'address', plan.location_address,
      'url', plan.location_url,
      'note', plan.location_note
    ),
    'games', coalesce((
      select jsonb_agg(jsonb_build_object(
        'game', jsonb_build_object(
          'id', game.id,
          'name', game.name,
          'description', game.description,
          'minPlayers', game.min_players,
          'maxPlayers', game.max_players,
          'intentTags', to_jsonb(game.intent_tags),
          'traits', to_jsonb(game.traits),
          'requirements', to_jsonb(game.requirements),
          'instructions', to_jsonb(game.instructions)
        ),
        'primary', plan_game.is_primary,
        'position', plan_game.position
      ) order by plan_game.position)
      from public.room_event_plan_games plan_game
      join public.offline_games game on game.id = plan_game.game_id
      where plan_game.plan_id = plan.id
    ), '[]'::jsonb),
    'confirmations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', confirmation.user_id,
        'displayName', app_user.display_name,
        'confirmedAt', confirmation.confirmed_at
      ) order by confirmation.confirmed_at)
      from public.room_event_plan_confirmations confirmation
      join public.users app_user on app_user.id = confirmation.user_id
      where confirmation.plan_id = plan.id
    ), '[]'::jsonb),
    'createdBy', plan.created_by,
    'createdAt', plan.created_at,
    'publishedAt', plan.published_at
  )
  from public.room_event_plans plan
  where plan.id = p_plan_id;
$$;

create or replace function public.get_match_room(p_room_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'roomId', room.id,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', member.user_id,
        'displayName', app_user.display_name,
        'confirmed', member.confirmed,
        'participationStatus', member.participation_status,
        'role', member.role
      ) order by member.created_at)
      from public.room_members member
      join public.users app_user on app_user.id = member.user_id
      where member.room_id = room.id
    ), '[]'::jsonb),
    'offlineGame', jsonb_build_object(
      'id', game.id,
      'name', game.name,
      'description', game.description,
      'minPlayers', game.min_players,
      'maxPlayers', game.max_players,
      'intentTags', to_jsonb(game.intent_tags),
      'traits', to_jsonb(game.traits),
      'requirements', to_jsonb(game.requirements),
      'instructions', to_jsonb(game.instructions)
    ),
    'matchSummary', room.match_summary,
    'status', room.status,
    'sourceDraftId', room.source_draft_id,
    'targetPlayers', room.target_players,
    'recruitmentStatus', room.recruitment_status,
    'version', room.version,
    'meetingPoint', room.meeting_point,
    'matchingStatus', room.matching_status,
    'capacity', room.capacity,
    'eventPlans', jsonb_build_object(
      'draft', (
        select public.get_room_event_plan(plan.id)
        from public.room_event_plans plan
        where plan.room_id = room.id and plan.status = 'draft'
        limit 1
      ),
      'published', (
        select public.get_room_event_plan(plan.id)
        from public.room_event_plans plan
        where plan.room_id = room.id and plan.status = 'published'
        limit 1
      )
    ),
    'createdAt', room.created_at,
    'completedAt', room.completed_at
  )
  from public.match_rooms room
  join public.offline_games game on game.id = room.offline_game_id
  where room.id = p_room_id;
$$;

create or replace function public.get_match_invite(p_invite_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'inviteId', invite.id,
    'kind', invite.kind,
    'roomId', invite.room_id,
    'participants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', participant.user_id,
        'requestId', participant.request_id,
        'displayName', app_user.display_name,
        'accepted', participant.accepted
      ) order by participant.position)
      from (
        select invite.inviter_user_id as user_id,
               invite.inviter_request_id as request_id,
               invite.inviter_accepted as accepted,
               1 as position
        where invite.inviter_user_id is not null
        union all
        select invite.invitee_user_id, invite.invitee_request_id, invite.invitee_accepted, 2
      ) participant
      join public.users app_user on app_user.id = participant.user_id
    ), '[]'::jsonb),
    'offlineGameId', invite.offline_game_id,
    'matchSummary', invite.match_summary,
    'eventPlan', case when invite.kind = 'room_join' then (
      select public.get_room_event_plan(plan.id)
      from public.room_event_plans plan
      where plan.room_id = invite.room_id and plan.status = 'published'
      limit 1
    ) else null end,
    'status', invite.status,
    'createdAt', invite.created_at,
    'resolvedAt', invite.resolved_at
  )
  from public.match_invites invite
  where invite.id = p_invite_id;
$$;

create or replace function public.create_initial_match_invite(
  p_decision jsonb,
  p_source_job_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_member_ids uuid[];
  v_request_ids uuid[];
  v_game_id text := p_decision->>'offlineGameId';
  v_summary text := nullif(p_decision->>'summary', '');
  v_event_plan_seed jsonb := coalesce(
    p_decision->'eventPlanSeed',
    jsonb_build_object(
      'time', jsonb_build_object(
        'startsAt', null, 'endsAt', null, 'timeZone', 'Asia/Shanghai', 'note', '待商定'
      ),
      'location', jsonb_build_object(
        'name', null, 'address', null, 'url', null, 'note', '待商定'
      ),
      'gameIds', jsonb_build_array(p_decision->>'offlineGameId')
    )
  );
  v_invite_id uuid;
  v_required_request_id uuid;
  v_inviter_demo boolean;
  v_invitee_demo boolean;
begin
  if p_source_job_id is not null then
    select id into v_invite_id from public.match_invites where source_job_id = p_source_job_id;
    if found then return public.get_match_invite(v_invite_id); end if;
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
  if v_event_plan_seed#>>'{gameIds,0}' is distinct from v_game_id then
    raise exception '活动清单主游戏必须与匹配结果一致' using errcode = 'P0001';
  end if;

  if p_source_job_id is not null then
    select nullif(payload->>'requestId', '')::uuid
    into v_required_request_id
    from public.llm_jobs
    where id = p_source_job_id;
    if v_required_request_id is not null
       and not (v_required_request_id = any(v_request_ids)) then
      raise exception '匹配结果必须包含触发本次任务的用户' using errcode = 'P0001';
    end if;
  end if;

  perform 1
  from public.match_requests
  where id = any(v_request_ids)
  order by id
  for update;
  if (
    select count(*) from public.match_requests
    where id = any(v_request_ids) and status = 'matching'
  ) <> 2 then
    raise exception '部分匹配请求已不在等待中' using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from unnest(v_request_ids, v_member_ids) as pair(request_id, member_id)
    left join public.match_requests request on request.id = pair.request_id
    where request.user_id is distinct from pair.member_id
  ) then
    raise exception '成员和匹配请求不对应' using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from jsonb_array_elements_text(v_event_plan_seed->'gameIds') game_id
    left join public.offline_games game on game.id = game_id and game.active
    where game.id is null
  ) then
    raise exception '活动清单包含不存在或已停用的游戏' using errcode = 'P0001';
  end if;

  select is_demo into v_inviter_demo from public.users where id = v_member_ids[1];
  select is_demo into v_invitee_demo from public.users where id = v_member_ids[2];
  insert into public.match_invites (
    kind, inviter_user_id, inviter_request_id, invitee_user_id, invitee_request_id,
    inviter_accepted, invitee_accepted, offline_game_id, match_summary,
    event_plan_seed, source_job_id
  ) values (
    'initial_pair', v_member_ids[1], v_request_ids[1], v_member_ids[2], v_request_ids[2],
    coalesce(v_inviter_demo, false), coalesce(v_invitee_demo, false), v_game_id,
    coalesce(v_summary, '已找到当前最合适的初始匹配对象'),
    v_event_plan_seed, p_source_job_id
  )
  returning id into v_invite_id;

  update public.match_requests
  set status = 'invited', invite_id = v_invite_id, updated_at = now()
  where id = any(v_request_ids);
  return public.get_match_invite(v_invite_id);
end;
$$;

create or replace function public.accept_match_invite(
  p_invite_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_invite public.match_invites%rowtype;
  v_room_id uuid;
  v_plan_id uuid;
  v_seed jsonb;
  v_capacity smallint;
  v_member_count integer;
  v_game_max smallint;
begin
  select * into v_invite from public.match_invites where id = p_invite_id for update;
  if not found then raise exception '匹配邀请不存在' using errcode = 'P0002'; end if;
  if p_user_id is distinct from v_invite.inviter_user_id
     and p_user_id is distinct from v_invite.invitee_user_id then
    raise exception '用户不在该匹配邀请中' using errcode = 'P0001';
  end if;
  if v_invite.status = 'accepted' then
    return jsonb_build_object(
      'invite', public.get_match_invite(p_invite_id),
      'room', public.get_match_room(v_invite.room_id),
      'requeuedRequestIds', '[]'::jsonb
    );
  end if;
  if v_invite.status <> 'pending' then
    raise exception '该匹配邀请已失效' using errcode = 'P0001';
  end if;

  if p_user_id = v_invite.inviter_user_id then
    update public.match_invites set inviter_accepted = true where id = p_invite_id;
  else
    update public.match_invites set invitee_accepted = true where id = p_invite_id;
  end if;
  select * into v_invite from public.match_invites where id = p_invite_id;
  if not (v_invite.inviter_accepted and v_invite.invitee_accepted) then
    return jsonb_build_object(
      'invite', public.get_match_invite(p_invite_id),
      'room', null,
      'requeuedRequestIds', '[]'::jsonb
    );
  end if;

  if v_invite.kind = 'initial_pair' then
    select max_players into v_game_max
    from public.offline_games
    where id = v_invite.offline_game_id and active
    for share;
    if not found then
      raise exception '线下游戏不存在或已停用' using errcode = 'P0001';
    end if;

    insert into public.match_rooms (
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
      'closed',
      'stopped',
      v_game_max
    )
    returning id into v_room_id;

    insert into public.room_members (
      room_id, user_id, confirmed, confirmed_at, participation_status, role
    )
    values
      (v_room_id, v_invite.inviter_user_id, true, now(), 'confirmed', 'founder'),
      (v_room_id, v_invite.invitee_user_id, true, now(), 'confirmed', 'founder');

    v_seed := coalesce(v_invite.event_plan_seed, jsonb_build_object(
      'time', jsonb_build_object(
        'startsAt', null, 'endsAt', null, 'timeZone', 'Asia/Shanghai', 'note', '待商定'
      ),
      'location', jsonb_build_object(
        'name', null, 'address', null, 'url', null, 'note', '待商定'
      ),
      'gameIds', jsonb_build_array(v_invite.offline_game_id)
    ));
    insert into public.room_event_plans (
      room_id, version, status, starts_at, ends_at, time_zone, time_note,
      location_name, location_address, location_url, location_note
    ) values (
      v_room_id,
      1,
      'draft',
      nullif(v_seed#>>'{time,startsAt}', '')::timestamptz,
      nullif(v_seed#>>'{time,endsAt}', '')::timestamptz,
      coalesce(nullif(v_seed#>>'{time,timeZone}', ''), 'Asia/Shanghai'),
      coalesce(nullif(v_seed#>>'{time,note}', ''), '待商定'),
      nullif(v_seed#>>'{location,name}', ''),
      nullif(v_seed#>>'{location,address}', ''),
      nullif(v_seed#>>'{location,url}', ''),
      coalesce(nullif(v_seed#>>'{location,note}', ''), '待商定')
    )
    returning id into v_plan_id;

    insert into public.room_event_plan_games (plan_id, game_id, position, is_primary)
    select v_plan_id, seed_game.value, (seed_game.ordinality - 1)::smallint,
           seed_game.ordinality = 1
    from jsonb_array_elements_text(v_seed->'gameIds') with ordinality as seed_game(value, ordinality)
    join public.offline_games game on game.id = seed_game.value and game.active;

    if (
      select count(*) from public.room_event_plan_games where plan_id = v_plan_id
    ) <> jsonb_array_length(v_seed->'gameIds') then
      raise exception '活动清单只能使用目录中的游戏' using errcode = 'P0001';
    end if;
    if not exists (
      select 1 from public.room_event_plan_games
      where plan_id = v_plan_id and game_id = v_invite.offline_game_id and is_primary
    ) then
      raise exception '活动清单主游戏与匹配结果不一致' using errcode = 'P0001';
    end if;

    update public.match_requests
    set status = 'matched', phase = 'settling', room_id = v_room_id, updated_at = now()
    where id in (v_invite.inviter_request_id, v_invite.invitee_request_id);
  else
    v_room_id := v_invite.room_id;
    select capacity into v_capacity
    from public.match_rooms
    where id = v_room_id and status <> 'completed' and matching_status = 'active'
    for update;
    if not found then raise exception '目标房间已停止匹配' using errcode = 'P0001'; end if;
    if not exists (
      select 1 from public.room_event_plans
      where room_id = v_room_id and status = 'published'
    ) then
      raise exception '房间活动清单尚未确认' using errcode = 'P0001';
    end if;
    select count(*) into v_member_count
    from public.room_members
    where room_id = v_room_id and participation_status <> 'withdrawn';
    if v_member_count >= v_capacity then
      update public.match_rooms set matching_status = 'full' where id = v_room_id;
      raise exception '目标房间已满' using errcode = 'P0001';
    end if;
    insert into public.room_members (
      room_id, user_id, confirmed, confirmed_at, participation_status, withdrawn_at, role
    )
    values (
      v_room_id, v_invite.invitee_user_id, true, now(), 'confirmed', null, 'member'
    )
    on conflict (room_id, user_id) do update
    set confirmed = true,
        confirmed_at = now(),
        participation_status = 'confirmed',
        withdrawn_at = null,
        role = 'member';
    update public.match_requests
    set status = 'matched', phase = 'settling', room_id = v_room_id, updated_at = now()
    where id = v_invite.invitee_request_id;
    update public.match_rooms
    set version = version + 1,
        recruitment_status = case
          when v_member_count + 1 >= v_capacity then 'full'
          else 'open'
        end
    where id = v_room_id;
    perform public.record_room_change_event(
      v_room_id,
      'member_joined',
      jsonb_build_object(
        'joinedUserId', v_invite.invitee_user_id,
        'memberCount', v_member_count + 1
      )
    );
    if v_member_count + 1 >= v_capacity then
      update public.match_rooms set matching_status = 'full' where id = v_room_id;
    end if;
  end if;

  update public.match_invites
  set room_id = v_room_id, status = 'accepted', resolved_at = now()
  where id = p_invite_id;
  return jsonb_build_object(
    'invite', public.get_match_invite(p_invite_id),
    'room', public.get_match_room(v_room_id),
    'requeuedRequestIds', '[]'::jsonb
  );
end;
$$;

create or replace function public.guard_room_join_event_plan()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.kind = 'room_join' and not exists (
    select 1 from public.room_event_plans
    where room_id = new.room_id and status = 'published'
  ) then
    raise exception '房间活动清单尚未确认' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists match_invites_require_published_event_plan on public.match_invites;
create trigger match_invites_require_published_event_plan
before insert on public.match_invites
for each row execute function public.guard_room_join_event_plan();

create or replace function public.create_room_event_plan_revision(
  p_room_id uuid,
  p_user_id uuid,
  p_expected_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_room public.match_rooms%rowtype;
  v_base public.room_event_plans%rowtype;
  v_plan public.room_event_plans%rowtype;
  v_new_version integer;
  v_game_ids text[];
  v_primary_max smallint;
  v_member_count integer;
begin
  select * into v_room from public.match_rooms
  where id = p_room_id and status <> 'completed'
  for update;
  if not found then raise exception '房间不存在或已经结束' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.room_members
    where room_id = p_room_id
      and user_id = p_user_id
      and role = 'founder'
      and participation_status <> 'withdrawn'
  ) then
    raise exception '只有最初匹配的两位成员可以修改活动清单' using errcode = 'P0001';
  end if;

  select * into v_base
  from public.room_event_plans
  where room_id = p_room_id and status in ('draft', 'published')
  order by case when status = 'draft' then 0 else 1 end
  limit 1
  for update;
  if not found then raise exception '当前房间没有活动清单' using errcode = 'P0001'; end if;
  if v_base.version <> p_expected_version then
    raise exception '活动清单已更新，请基于最新版本修改' using errcode = 'P0001';
  end if;

  if p_patch ? 'gameIds' then
    select array_agg(value order by ordinality)
    into v_game_ids
    from jsonb_array_elements_text(p_patch->'gameIds') with ordinality;
  else
    select array_agg(game_id order by position)
    into v_game_ids
    from public.room_event_plan_games
    where plan_id = v_base.id;
  end if;
  if coalesce(array_length(v_game_ids, 1), 0) < 1
     or coalesce(array_length(v_game_ids, 1), 0) > 5
     or (select count(distinct game_id) from unnest(v_game_ids) game_id)
        <> array_length(v_game_ids, 1) then
    raise exception '活动清单必须包含 1 到 5 个不重复游戏' using errcode = 'P0001';
  end if;
  select max_players into v_primary_max
  from public.offline_games
  where id = v_game_ids[1] and active;
  if not found or exists (
    select 1 from unnest(v_game_ids) game_id
    left join public.offline_games game on game.id = game_id and game.active
    where game.id is null
  ) then
    raise exception '活动清单只能使用目录中的游戏' using errcode = 'P0001';
  end if;
  select count(*) into v_member_count
  from public.room_members
  where room_id = p_room_id and participation_status <> 'withdrawn';
  if v_primary_max < v_member_count then
    raise exception '主游戏人数上限不能小于当前房间人数' using errcode = 'P0001';
  end if;

  update public.room_event_plans set status = 'superseded'
  where id = v_base.id and v_base.status = 'draft';
  select coalesce(max(version), 0) + 1 into v_new_version
  from public.room_event_plans where room_id = p_room_id;

  insert into public.room_event_plans (
    room_id, version, status, starts_at, ends_at, time_zone, time_note,
    location_name, location_address, location_url, location_note, created_by
  ) values (
    p_room_id,
    v_new_version,
    'draft',
    case when p_patch#>'{time,startsAt}' is not null
      then nullif(p_patch#>>'{time,startsAt}', '')::timestamptz else v_base.starts_at end,
    case when p_patch#>'{time,endsAt}' is not null
      then nullif(p_patch#>>'{time,endsAt}', '')::timestamptz else v_base.ends_at end,
    coalesce(nullif(p_patch#>>'{time,timeZone}', ''), v_base.time_zone),
    coalesce(nullif(p_patch#>>'{time,note}', ''), v_base.time_note),
    case when p_patch#>'{location,name}' is not null
      then nullif(p_patch#>>'{location,name}', '') else v_base.location_name end,
    case when p_patch#>'{location,address}' is not null
      then nullif(p_patch#>>'{location,address}', '') else v_base.location_address end,
    case when p_patch#>'{location,url}' is not null
      then nullif(p_patch#>>'{location,url}', '') else v_base.location_url end,
    coalesce(nullif(p_patch#>>'{location,note}', ''), v_base.location_note),
    p_user_id
  )
  returning * into v_plan;

  insert into public.room_event_plan_games (plan_id, game_id, position, is_primary)
  select v_plan.id, game_id, (ordinality - 1)::smallint, ordinality = 1
  from unnest(v_game_ids) with ordinality as selected_game(game_id, ordinality);

  return jsonb_build_object(
    'room', public.get_match_room(p_room_id),
    'eventPlan', public.get_room_event_plan(v_plan.id),
    'published', false
  );
end;
$$;

create or replace function public.confirm_room_event_plan(
  p_room_id uuid,
  p_user_id uuid,
  p_version integer
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_plan public.room_event_plans%rowtype;
  v_founder_count integer;
  v_confirmation_count integer;
  v_primary_game text;
  v_primary_max smallint;
  v_member_count integer;
  v_published boolean := false;
begin
  perform 1 from public.match_rooms
  where id = p_room_id and status <> 'completed'
  for update;
  if not found then raise exception '房间不存在或已经结束' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.room_members
    where room_id = p_room_id
      and user_id = p_user_id
      and role = 'founder'
      and participation_status <> 'withdrawn'
  ) then
    raise exception '只有最初匹配的两位成员可以确认活动清单' using errcode = 'P0001';
  end if;
  select * into v_plan
  from public.room_event_plans
  where room_id = p_room_id and version = p_version and status = 'draft'
  for update;
  if not found then raise exception '只能确认当前活动清单草稿' using errcode = 'P0001'; end if;

  insert into public.room_event_plan_confirmations (plan_id, user_id)
  values (v_plan.id, p_user_id)
  on conflict (plan_id, user_id) do nothing;
  select count(*) into v_founder_count
  from public.room_members
  where room_id = p_room_id
    and role = 'founder'
    and participation_status <> 'withdrawn';
  select count(*) into v_confirmation_count
  from public.room_event_plan_confirmations confirmation
  join public.room_members member
    on member.room_id = p_room_id
   and member.user_id = confirmation.user_id
   and member.role = 'founder'
   and member.participation_status <> 'withdrawn'
  where confirmation.plan_id = v_plan.id;

  if v_founder_count = 2 and v_confirmation_count = 2 then
    update public.room_event_plans
    set status = 'superseded'
    where room_id = p_room_id and status = 'published';
    update public.room_event_plans
    set status = 'published', published_at = now()
    where id = v_plan.id;
    select game_id into v_primary_game
    from public.room_event_plan_games
    where plan_id = v_plan.id and is_primary;
    select max_players into v_primary_max
    from public.offline_games where id = v_primary_game and active;
    select count(*) into v_member_count
    from public.room_members
    where room_id = p_room_id and participation_status <> 'withdrawn';
    update public.match_rooms
    set offline_game_id = v_primary_game,
        target_players = case when v_primary_max >= 3 then v_primary_max else null end,
        recruitment_status = case
          when v_member_count >= v_primary_max then 'full'
          else 'open'
        end,
        capacity = v_primary_max,
        matching_status = case
          when v_member_count >= v_primary_max then 'full'
          else 'active'
        end,
        version = version + 1
    where id = p_room_id;
    v_published := true;
  end if;

  return jsonb_build_object(
    'room', public.get_match_room(p_room_id),
    'eventPlan', public.get_room_event_plan(v_plan.id),
    'published', v_published
  );
end;
$$;

create or replace function public.list_open_match_rooms(p_limit integer default 20)
returns setof jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'room', public.get_match_room(room.id),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'request', to_jsonb(member_request),
        'user_model', to_jsonb(model),
        'matching_narrative', case
          when profile.stale and profile.version = 0 then model.vibe_narrative
          when profile.stale then ''
          when profile.version is null or profile.version = 0
            then coalesce(nullif(profile.matching_narrative, ''), model.vibe_narrative)
          else profile.matching_narrative
        end
      ) order by member.created_at)
      from public.room_members member
      join public.user_models model on model.user_id = member.user_id
      left join public.user_memory_profiles profile on profile.user_id = member.user_id
      join lateral (
        select request.*
        from public.match_requests request
        where request.user_id = member.user_id and request.room_id = room.id
        order by request.created_at desc
        limit 1
      ) member_request on true
      where member.room_id = room.id
        and member.participation_status <> 'withdrawn'
    ), '[]'::jsonb)
  )
  from public.match_rooms room
  where room.status <> 'completed'
    and room.matching_status = 'active'
    and exists (
      select 1 from public.room_event_plans plan
      where plan.room_id = room.id and plan.status = 'published'
    )
    and (
      select count(*)
      from public.room_members member
      where member.room_id = room.id
        and member.participation_status <> 'withdrawn'
    ) < room.capacity
    and not exists (
      select 1 from public.match_invites invite
      where invite.room_id = room.id and invite.kind = 'room_join' and invite.status = 'pending'
    )
  order by room.created_at
  limit least(greatest(p_limit, 1), 100);
$$;

create or replace function public.append_proactive_agent_message(
  p_user_id uuid,
  p_content text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_message jsonb;
begin
  v_message := public.append_agent_message(
    p_user_id,
    'assistant',
    p_content,
    p_idempotency_key,
    'system',
    null
  );
  perform public.enqueue_wechat_outbound_message(
    p_user_id,
    (v_message->>'id')::uuid,
    p_content
  );
  return v_message;
end;
$$;

create or replace function public.complete_wechat_outbound_message(
  p_outbound_id uuid,
  p_worker_id text,
  p_error text default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_delivery public.channel_message_deliveries%rowtype;
  v_idempotency_key text;
begin
  select * into v_delivery
  from public.channel_message_deliveries delivery
  where delivery.id = p_outbound_id
    and delivery.provider = 'wechat'
    and delivery.direction = 'outbound'
    and delivery.locked_by = p_worker_id
  for update;
  if not found then return; end if;

  if p_error is null then
    update public.channel_message_deliveries
    set status = 'sent',
        completed_at = now(),
        locked_by = null,
        locked_at = null,
        last_error = null,
        updated_at = now()
    where id = p_outbound_id;

    select idempotency_key into v_idempotency_key
    from public.messages
    where id = v_delivery.message_id;
    if v_idempotency_key like 'match-options:%' then
      perform public.activate_match_offer_window(
        split_part(v_idempotency_key, ':', 3)::uuid,
        split_part(v_idempotency_key, ':', 2)::uuid,
        90
      );
    end if;
  else
    update public.channel_message_deliveries
    set status = case when attempts >= 8 then 'failed' else 'retry' end,
        run_at = case
          when attempts >= 8 then run_at
          else now() + least(
            interval '15 minutes',
            interval '5 seconds' * power(2, greatest(attempts - 1, 0))
          )
        end,
        locked_by = null,
        locked_at = null,
        last_error = left(p_error, 1000),
        updated_at = now()
    where id = p_outbound_id;
  end if;
end;
$$;

revoke all on function public.get_room_event_plan(uuid) from public, anon, authenticated;
revoke all on function public.create_room_event_plan_revision(uuid, uuid, integer, jsonb)
  from public, anon, authenticated;
revoke all on function public.confirm_room_event_plan(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.append_proactive_agent_message(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.complete_wechat_outbound_message(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.initialize_room_event_plan_on_member()
  from public, anon, authenticated;
revoke all on function public.guard_room_join_event_plan() from public, anon, authenticated;

grant execute on function public.get_room_event_plan(uuid) to service_role;
grant execute on function public.create_room_event_plan_revision(uuid, uuid, integer, jsonb)
  to service_role;
grant execute on function public.confirm_room_event_plan(uuid, uuid, integer) to service_role;
grant execute on function public.append_proactive_agent_message(uuid, text, text) to service_role;
grant execute on function public.complete_wechat_outbound_message(uuid, text, text) to service_role;
grant execute on function public.initialize_room_event_plan_on_member() to service_role;

revoke all on function public.get_match_room(uuid) from public, anon, authenticated;
revoke all on function public.get_match_invite(uuid) from public, anon, authenticated;
revoke all on function public.create_initial_match_invite(jsonb, uuid)
  from public, anon, authenticated;
revoke all on function public.accept_match_invite(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.list_open_match_rooms(integer)
  from public, anon, authenticated;
grant execute on function public.get_match_room(uuid) to service_role;
grant execute on function public.get_match_invite(uuid) to service_role;
grant execute on function public.create_initial_match_invite(jsonb, uuid) to service_role;
grant execute on function public.accept_match_invite(uuid, uuid) to service_role;
grant execute on function public.list_open_match_rooms(integer) to service_role;
