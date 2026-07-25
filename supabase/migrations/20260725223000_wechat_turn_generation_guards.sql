create table if not exists public.channel_response_generations (
  provider text not null check (provider in ('wechat')),
  connection_id uuid not null references public.wechat_ilink_connections(id) on delete cascade,
  generation_token text not null check (char_length(generation_token) between 8 and 128),
  updated_at timestamptz not null default now(),
  primary key (provider, connection_id)
);

alter table public.wechat_connection_sessions
  add column if not exists activation_callback_claimed_at timestamptz;

create or replace function public.claim_wechat_activation_callback(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed integer := 0;
begin
  update wechat_connection_sessions
  set activation_callback_claimed_at = now(), updated_at = now()
  where id = p_session_id
    and status = 'active'
    and activation_callback_claimed_at is null;
  get diagnostics v_claimed = row_count;
  return v_claimed > 0;
end;
$$;

create or replace function public.set_wechat_response_generation(
  p_connection_id uuid,
  p_generation_token text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if char_length(coalesce(p_generation_token, '')) not between 8 and 128 then
    raise exception '无效的微信回复代次' using errcode = 'P0001';
  end if;
  if not exists (select 1 from wechat_ilink_connections where id = p_connection_id) then
    raise exception '微信连接不存在' using errcode = 'P0002';
  end if;
  insert into channel_response_generations (provider, connection_id, generation_token)
  values ('wechat', p_connection_id, p_generation_token)
  on conflict (provider, connection_id) do update set
    generation_token = excluded.generation_token,
    updated_at = now();
end;
$$;

create or replace function public.is_wechat_response_generation_current(
  p_connection_id uuid,
  p_generation_token text
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from channel_response_generations
    where provider = 'wechat'
      and connection_id = p_connection_id
      and generation_token = p_generation_token
  )
$$;

create or replace function public.append_agent_message_if_wechat_generation_current(
  p_connection_id uuid,
  p_generation_token text,
  p_user_id uuid,
  p_role text,
  p_content text,
  p_idempotency_key text default null,
  p_source_channel text default 'wechat',
  p_reply_to_message_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_token text;
begin
  select generation_token into v_current_token
  from channel_response_generations
  where provider = 'wechat' and connection_id = p_connection_id
  for update;
  if v_current_token is distinct from p_generation_token then
    return null;
  end if;
  return append_agent_message(
    p_user_id,
    p_role,
    p_content,
    p_idempotency_key,
    p_source_channel,
    p_reply_to_message_id
  );
end;
$$;

alter table public.channel_response_generations enable row level security;
revoke all on table public.channel_response_generations from public, anon, authenticated;
grant select, insert, update, delete on table public.channel_response_generations to service_role;

revoke all on function public.set_wechat_response_generation(uuid,text) from public,anon,authenticated;
revoke all on function public.claim_wechat_activation_callback(uuid) from public,anon,authenticated;
revoke all on function public.is_wechat_response_generation_current(uuid,text) from public,anon,authenticated;
revoke all on function public.append_agent_message_if_wechat_generation_current(uuid,text,uuid,text,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.set_wechat_response_generation(uuid,text) to service_role;
grant execute on function public.claim_wechat_activation_callback(uuid) to service_role;
grant execute on function public.is_wechat_response_generation_current(uuid,text) to service_role;
grant execute on function public.append_agent_message_if_wechat_generation_current(uuid,text,uuid,text,text,text,text,uuid) to service_role;

comment on table public.channel_response_generations is
  'Tracks the latest inbound WeChat turn so replies generated for superseded turns are not persisted.';
