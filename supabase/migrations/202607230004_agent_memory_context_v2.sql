alter table public.llm_jobs
  drop constraint if exists llm_jobs_job_type_check;

alter table public.llm_jobs
  add constraint llm_jobs_job_type_check
  check (job_type in (
    'agent_reply',
    'multimodal_understanding',
    'matchmaking',
    'feedback_update',
    'memory_extract',
    'memory_consolidate'
  ));

alter table public.llm_jobs
  add column if not exists partition_key text
  check (partition_key is null or char_length(partition_key) between 1 and 200);

create index if not exists llm_jobs_partition_fifo_idx
  on public.llm_jobs (partition_key, created_at)
  where status in ('pending', 'retry', 'processing') and partition_key is not null;

create table if not exists public.user_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  memory_kind text not null check (memory_kind in (
    'stable_fact',
    'preference',
    'interaction_preference',
    'social_learning',
    'boundary',
    'temporary_state',
    'multimodal_impression'
  )),
  stable_key text not null check (char_length(stable_key) between 1 and 200),
  content text not null check (char_length(content) between 1 and 1000),
  source_type text not null check (source_type in ('message', 'multimodal', 'feedback')),
  source_id text not null check (char_length(source_id) between 1 and 128),
  explicitness text not null check (explicitness in ('explicit', 'experienced', 'observed')),
  status text not null default 'active' check (status in ('active', 'superseded', 'forgotten', 'expired')),
  superseded_by uuid references public.user_memories(id) on delete set null,
  confirmation_count integer not null default 1 check (confirmation_count > 0),
  usage_count integer not null default 0 check (usage_count >= 0),
  last_confirmed_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists user_memories_active_identity_idx
  on public.user_memories (user_id, memory_kind, stable_key)
  where status = 'active';

create index if not exists user_memories_active_retrieval_idx
  on public.user_memories (user_id, last_confirmed_at desc)
  where status = 'active';

create index if not exists user_memories_expiration_idx
  on public.user_memories (expires_at)
  where status = 'active' and expires_at is not null;

create table if not exists public.user_memory_profiles (
  user_id uuid primary key references public.users(id) on delete cascade,
  profile_narrative text not null default ''
    check (char_length(profile_narrative) <= 6000),
  matching_narrative text not null default ''
    check (char_length(matching_narrative) <= 4000),
  source_memory_ids uuid[] not null default '{}'
    check (cardinality(source_memory_ids) <= 128),
  source_watermark timestamptz,
  version integer not null default 0 check (version >= 0),
  stale boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.user_memory_profiles (user_id)
select id from public.users
on conflict (user_id) do nothing;

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
  insert into user_models (user_id) values (p_user_id) on conflict (user_id) do nothing;
  insert into user_memory_profiles (user_id) values (p_user_id) on conflict (user_id) do nothing;
end;
$$;

create or replace function public.expire_user_memories(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_expired_count integer;
begin
  update user_memories
  set status = 'expired', updated_at = now()
  where user_id = p_user_id
    and status = 'active'
    and expires_at is not null
    and expires_at <= now();
  get diagnostics v_expired_count = row_count;
  if v_expired_count > 0 then
    update user_memory_profiles
    set stale = true, updated_at = now()
    where user_id = p_user_id;
  end if;
  return v_expired_count;
end;
$$;

create or replace function public.apply_user_memory_changes(
  p_user_id uuid,
  p_source_type text,
  p_source_id text,
  p_explicitness text,
  p_candidates jsonb,
  p_forget_memory_ids uuid[],
  p_forget_all boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate jsonb;
  v_existing user_memories%rowtype;
  v_written user_memories%rowtype;
  v_new_id uuid;
  v_memories jsonb := '[]'::jsonb;
  v_forgotten_count integer := 0;
  v_changed boolean := false;
begin
  if p_source_type not in ('message', 'multimodal', 'feedback') then
    raise exception '无效的记忆来源类型' using errcode = 'P0001';
  end if;
  if p_explicitness not in ('explicit', 'experienced', 'observed') then
    raise exception '无效的记忆明确性' using errcode = 'P0001';
  end if;
  if jsonb_array_length(coalesce(p_candidates, '[]'::jsonb)) > 8
     or cardinality(coalesce(p_forget_memory_ids, '{}')) > 32 then
    raise exception '单次记忆变更数量超限' using errcode = 'P0001';
  end if;

  perform ensure_tomeet_user(p_user_id, '新朋友');

  update user_memories
  set status = 'expired', updated_at = now()
  where user_id = p_user_id
    and status = 'active'
    and expires_at is not null
    and expires_at <= now();
  if found then v_changed := true; end if;

  if p_forget_all then
    update user_memories
    set status = 'forgotten', updated_at = now()
    where user_id = p_user_id and status = 'active';
  else
    update user_memories
    set status = 'forgotten', updated_at = now()
    where user_id = p_user_id
      and status = 'active'
      and id = any(coalesce(p_forget_memory_ids, '{}'));
  end if;
  get diagnostics v_forgotten_count = row_count;
  if v_forgotten_count > 0 then v_changed := true; end if;

  for v_candidate in
    select value from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb))
  loop
    if coalesce(v_candidate->>'kind', '') not in (
      'stable_fact',
      'preference',
      'interaction_preference',
      'social_learning',
      'boundary',
      'temporary_state',
      'multimodal_impression'
    ) then
      raise exception '无效的记忆类型' using errcode = 'P0001';
    end if;
    if p_source_type = 'multimodal'
       and v_candidate->>'kind' <> 'multimodal_impression' then
      raise exception '多模态来源只能写入近期印象' using errcode = 'P0001';
    end if;

    select * into v_existing
    from user_memories
    where user_id = p_user_id
      and memory_kind = v_candidate->>'kind'
      and stable_key = v_candidate->>'stableKey'
      and status = 'active'
    for update;

    if found and v_existing.content = v_candidate->>'content' then
      update user_memories
      set confirmation_count = confirmation_count + 1,
          source_type = p_source_type,
          source_id = p_source_id,
          explicitness = p_explicitness,
          last_confirmed_at = now(),
          expires_at = nullif(v_candidate->>'expiresAt', '')::timestamptz,
          updated_at = now()
      where id = v_existing.id
      returning * into v_written;
    else
      v_new_id := gen_random_uuid();
      if found then
        update user_memories
        set status = 'superseded', updated_at = now()
        where id = v_existing.id;
      end if;
      insert into user_memories (
        id,
        user_id,
        memory_kind,
        stable_key,
        content,
        source_type,
        source_id,
        explicitness,
        expires_at
      ) values (
        v_new_id,
        p_user_id,
        v_candidate->>'kind',
        v_candidate->>'stableKey',
        v_candidate->>'content',
        p_source_type,
        p_source_id,
        p_explicitness,
        nullif(v_candidate->>'expiresAt', '')::timestamptz
      )
      returning * into v_written;
      if v_existing.id is not null then
        update user_memories set superseded_by = v_new_id where id = v_existing.id;
      end if;
    end if;
    v_memories := v_memories || jsonb_build_array(to_jsonb(v_written));
    v_changed := true;
    v_existing := null;
  end loop;

  if v_changed then
    update user_memory_profiles
    set stale = true, updated_at = now()
    where user_id = p_user_id;
  end if;

  return jsonb_build_object(
    'memories', v_memories,
    'forgotten_count', v_forgotten_count
  );
end;
$$;

create or replace function public.record_user_memory_usage(
  p_user_id uuid,
  p_memory_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update user_memories
  set usage_count = usage_count + 1,
      last_used_at = now(),
      updated_at = now()
  where user_id = p_user_id
    and status = 'active'
    and id = any(coalesce(p_memory_ids, '{}'));
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
    'request', to_jsonb(mr),
    'user_model', to_jsonb(um),
    'matching_narrative', case
      when ump.stale and ump.version = 0 then um.vibe_narrative
      when ump.stale then ''
      when ump.version is null or ump.version = 0
        then coalesce(nullif(ump.matching_narrative, ''), um.vibe_narrative)
      else ump.matching_narrative
    end
  )
  from match_requests mr
  join user_models um on um.user_id = mr.user_id
  left join user_memory_profiles ump on ump.user_id = mr.user_id
  where mr.status = 'matching'
  order by mr.created_at
  limit least(greatest(p_limit, 1), 100);
$$;

drop function if exists public.enqueue_llm_job(text, jsonb, text, integer);

create function public.enqueue_llm_job(
  p_job_type text,
  p_payload jsonb,
  p_idempotency_key text,
  p_max_attempts integer default 3,
  p_partition_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row llm_jobs%rowtype;
begin
  insert into llm_jobs (
    job_type,
    payload,
    idempotency_key,
    max_attempts,
    partition_key
  )
  values (
    p_job_type,
    p_payload,
    p_idempotency_key,
    least(greatest(p_max_attempts, 1), 10),
    nullif(p_partition_key, '')
  )
  on conflict (idempotency_key) do update
    set idempotency_key = excluded.idempotency_key
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
  set status = 'retry',
      locked_at = null,
      locked_by = null,
      error = coalesce(error, '任务锁超时'),
      updated_at = now()
  where status = 'processing'
    and locked_at < now() - interval '5 minutes';

  with candidate as (
    select j.id
    from llm_jobs j
    where j.status in ('pending', 'retry')
      and j.run_at <= now()
      and (
        j.partition_key is null
        or not exists (
          select 1
          from llm_jobs earlier
          where earlier.partition_key = j.partition_key
            and earlier.status in ('pending', 'retry', 'processing')
            and (
              earlier.created_at < j.created_at
              or (earlier.created_at = j.created_at and earlier.id < j.id)
            )
        )
      )
      and (
        j.partition_key is null
        or not exists (
          select 1
          from llm_jobs active
          where active.partition_key = j.partition_key
            and active.status = 'processing'
        )
      )
    order by j.run_at, j.created_at
    for update of j skip locked
    limit 1
  )
  update llm_jobs j
  set status = 'processing',
      attempts = attempts + 1,
      locked_at = now(),
      locked_by = p_worker_id,
      updated_at = now()
  from candidate c
  where j.id = c.id
  returning j.* into v_row;

  if v_row.id is null then return null; end if;
  return to_jsonb(v_row);
end;
$$;

alter table public.user_memories enable row level security;
alter table public.user_memory_profiles enable row level security;

revoke all on table public.user_memories from public, anon, authenticated;
revoke all on table public.user_memory_profiles from public, anon, authenticated;
grant select, insert, update, delete on table public.user_memories to service_role;
grant select, insert, update, delete on table public.user_memory_profiles to service_role;

revoke all on function public.apply_user_memory_changes(uuid, text, text, text, jsonb, uuid[], boolean)
  from public, anon, authenticated;
revoke all on function public.record_user_memory_usage(uuid, uuid[])
  from public, anon, authenticated;
revoke all on function public.expire_user_memories(uuid)
  from public, anon, authenticated;
revoke all on function public.enqueue_llm_job(text, jsonb, text, integer, text)
  from public, anon, authenticated;

grant execute on function public.apply_user_memory_changes(uuid, text, text, text, jsonb, uuid[], boolean)
  to service_role;
grant execute on function public.record_user_memory_usage(uuid, uuid[])
  to service_role;
grant execute on function public.expire_user_memories(uuid)
  to service_role;
grant execute on function public.enqueue_llm_job(text, jsonb, text, integer, text)
  to service_role;
