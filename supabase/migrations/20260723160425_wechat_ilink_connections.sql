create table public.wechat_ilink_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  ilink_bot_id text not null unique check (char_length(ilink_bot_id) between 1 and 255),
  owner_ilink_user_id text not null unique
    check (char_length(owner_ilink_user_id) between 1 and 255),
  bot_token_ciphertext text not null
    check (char_length(bot_token_ciphertext) between 32 and 16384),
  base_url text not null
    check (base_url ~ '^https://[^[:space:]]+$'),
  sync_cursor text not null default ''
    check (char_length(sync_cursor) <= 1048576),
  status text not null default 'active'
    check (status in ('active', 'reauth_required', 'disconnected', 'revoked', 'error')),
  lease_owner text check (
    lease_owner is null or char_length(lease_owner) between 1 and 255
  ),
  lease_expires_at timestamptz,
  last_message_at timestamptz,
  last_error text check (
    last_error is null or char_length(last_error) <= 1000
  ),
  failure_count integer not null default 0 check (failure_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index wechat_ilink_connections_claim_idx
  on public.wechat_ilink_connections (status, lease_expires_at, updated_at)
  where status = 'active';

create table public.wechat_connection_sessions (
  id uuid primary key,
  session_token_hash text not null unique
    check (session_token_hash ~ '^[a-f0-9]{64}$'),
  qr_token_ciphertext text not null
    check (char_length(qr_token_ciphertext) between 32 and 16384),
  status text not null default 'pending'
    check (status in (
      'pending',
      'scanned',
      'verification_required',
      'active',
      'expired',
      'failed'
    )),
  poll_base_url text not null default 'https://ilinkai.weixin.qq.com'
    check (poll_base_url ~ '^https://[^[:space:]]+$'),
  requested_user_id uuid references public.users(id) on delete set null,
  connection_id uuid references public.wechat_ilink_connections(id) on delete set null,
  user_id uuid references public.users(id) on delete set null,
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  error_code text check (
    error_code is null or char_length(error_code) between 1 and 100
  ),
  error_message text check (
    error_message is null or char_length(error_message) <= 1000
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index wechat_connection_sessions_expiry_idx
  on public.wechat_connection_sessions (expires_at)
  where status in ('pending', 'scanned', 'verification_required');

create table public.wechat_message_receipts (
  connection_id uuid not null
    references public.wechat_ilink_connections(id) on delete cascade,
  message_id text not null check (char_length(message_id) between 1 and 255),
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),
  error text check (error is null or char_length(error) <= 1000),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (connection_id, message_id)
);

create index wechat_message_receipts_created_idx
  on public.wechat_message_receipts (created_at);

create or replace function public.activate_wechat_ilink_session(
  p_session_id uuid,
  p_new_user_id uuid,
  p_owner_ilink_user_id text,
  p_ilink_bot_id text,
  p_bot_token_ciphertext text,
  p_base_url text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_session public.wechat_connection_sessions%rowtype;
  v_connection public.wechat_ilink_connections%rowtype;
  v_user_id uuid;
begin
  select * into v_session
  from public.wechat_connection_sessions
  where id = p_session_id
  for update;

  if v_session.id is null then
    raise exception '微信扫码会话不存在' using errcode = 'P0002';
  end if;

  if v_session.status = 'active' and v_session.connection_id is not null then
    select * into v_connection
    from public.wechat_ilink_connections
    where id = v_session.connection_id;
    return jsonb_build_object(
      'session', to_jsonb(v_session),
      'connection', to_jsonb(v_connection)
    );
  end if;

  if v_session.expires_at <= now() then
    update public.wechat_connection_sessions
    set status = 'expired',
        error_code = 'qr_expired',
        error_message = '微信二维码已过期',
        updated_at = now()
    where id = p_session_id;
    raise exception '微信二维码已过期' using errcode = 'P0001';
  end if;

  if v_session.status in ('expired', 'failed') then
    raise exception '微信扫码会话已经结束' using errcode = 'P0001';
  end if;

  select user_id into v_user_id
  from public.channel_identities
  where provider = 'wechat'
    and external_user_id = p_owner_ilink_user_id
  for update;

  if v_user_id is not null
     and v_session.requested_user_id is not null
     and v_user_id <> v_session.requested_user_id then
    raise exception '该微信已关联其他 TOMEET profile' using errcode = 'P0001';
  end if;

  if v_user_id is null then
    v_user_id := coalesce(v_session.requested_user_id, p_new_user_id);
    perform public.ensure_tomeet_user(v_user_id, '微信用户');
    insert into public.channel_identities (
      provider,
      external_user_id,
      user_id,
      display_name,
      metadata
    )
    values (
      'wechat',
      p_owner_ilink_user_id,
      v_user_id,
      '微信用户',
      jsonb_build_object('transport', 'ilink')
    )
    on conflict (provider, external_user_id) do nothing;

    select user_id into v_user_id
    from public.channel_identities
    where provider = 'wechat'
      and external_user_id = p_owner_ilink_user_id;
  else
    perform public.ensure_tomeet_user(v_user_id, '微信用户');
  end if;

  if v_user_id is null then
    raise exception '无法创建或关联微信用户' using errcode = 'P0001';
  end if;

  insert into public.wechat_ilink_connections (
    user_id,
    ilink_bot_id,
    owner_ilink_user_id,
    bot_token_ciphertext,
    base_url,
    sync_cursor,
    status
  )
  values (
    v_user_id,
    p_ilink_bot_id,
    p_owner_ilink_user_id,
    p_bot_token_ciphertext,
    p_base_url,
    '',
    'active'
  )
  on conflict (user_id) do update set
    ilink_bot_id = excluded.ilink_bot_id,
    owner_ilink_user_id = excluded.owner_ilink_user_id,
    bot_token_ciphertext = excluded.bot_token_ciphertext,
    base_url = excluded.base_url,
    sync_cursor = '',
    status = 'active',
    lease_owner = null,
    lease_expires_at = null,
    last_error = null,
    failure_count = 0,
    updated_at = now()
  returning * into v_connection;

  update public.wechat_connection_sessions
  set status = 'active',
      connection_id = v_connection.id,
      user_id = v_user_id,
      confirmed_at = now(),
      error_code = null,
      error_message = null,
      updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return jsonb_build_object(
    'session', to_jsonb(v_session),
    'connection', to_jsonb(v_connection)
  );
end;
$$;

create or replace function public.claim_wechat_ilink_connections(
  p_worker_id text,
  p_limit integer default 4,
  p_lease_seconds integer default 90
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if char_length(coalesce(p_worker_id, '')) not between 1 and 255 then
    raise exception '无效的微信 worker ID' using errcode = 'P0001';
  end if;

  with candidates as (
    select id
    from public.wechat_ilink_connections
    where status = 'active'
      and (lease_expires_at is null or lease_expires_at <= now())
    order by updated_at, id
    for update skip locked
    limit least(greatest(p_limit, 1), 32)
  ),
  claimed as (
    update public.wechat_ilink_connections connection
    set lease_owner = p_worker_id,
        lease_expires_at = now()
          + make_interval(secs => least(greatest(p_lease_seconds, 45), 300)),
        updated_at = now()
    from candidates
    where connection.id = candidates.id
    returning connection.*
  )
  select coalesce(jsonb_agg(to_jsonb(claimed)), '[]'::jsonb)
  into v_result
  from claimed;

  return v_result;
end;
$$;

create or replace function public.fail_wechat_ilink_connection(
  p_connection_id uuid,
  p_worker_id text,
  p_error text,
  p_reauth_required boolean default false
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.wechat_ilink_connections
  set failure_count = failure_count + 1,
      last_error = left(coalesce(p_error, '未知微信连接错误'), 1000),
      status = case
        when p_reauth_required then 'reauth_required'
        else 'active'
      end,
      lease_owner = null,
      lease_expires_at = case
        when p_reauth_required then null
        else now() + make_interval(
          secs => least(60, (power(2, least(failure_count, 6)))::integer)
        )
      end,
      updated_at = now()
  where id = p_connection_id
    and lease_owner = p_worker_id;
end;
$$;

create or replace function public.begin_wechat_message(
  p_connection_id uuid,
  p_message_id text
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_affected integer := 0;
begin
  insert into public.wechat_message_receipts (
    connection_id,
    message_id,
    status
  )
  values (
    p_connection_id,
    p_message_id,
    'processing'
  )
  on conflict (connection_id, message_id) do update
  set status = 'processing',
      error = null,
      updated_at = now()
  where wechat_message_receipts.status = 'failed'
     or (
       wechat_message_receipts.status = 'processing'
       and wechat_message_receipts.updated_at < now() - interval '5 minutes'
     );

  get diagnostics v_affected = row_count;
  return v_affected > 0;
end;
$$;

alter table public.wechat_ilink_connections enable row level security;
alter table public.wechat_connection_sessions enable row level security;
alter table public.wechat_message_receipts enable row level security;

revoke all on table public.wechat_ilink_connections
  from public, anon, authenticated;
revoke all on table public.wechat_connection_sessions
  from public, anon, authenticated;
revoke all on table public.wechat_message_receipts
  from public, anon, authenticated;

grant select, insert, update, delete on table public.wechat_ilink_connections
  to service_role;
grant select, insert, update, delete on table public.wechat_connection_sessions
  to service_role;
grant select, insert, update, delete on table public.wechat_message_receipts
  to service_role;

revoke all on function public.activate_wechat_ilink_session(
  uuid, uuid, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.claim_wechat_ilink_connections(
  text, integer, integer
) from public, anon, authenticated;
revoke all on function public.fail_wechat_ilink_connection(
  uuid, text, text, boolean
) from public, anon, authenticated;
revoke all on function public.begin_wechat_message(
  uuid, text
) from public, anon, authenticated;

grant execute on function public.activate_wechat_ilink_session(
  uuid, uuid, text, text, text, text
) to service_role;
grant execute on function public.claim_wechat_ilink_connections(
  text, integer, integer
) to service_role;
grant execute on function public.fail_wechat_ilink_connection(
  uuid, text, text, boolean
) to service_role;
grant execute on function public.begin_wechat_message(
  uuid, text
) to service_role;

comment on table public.wechat_connection_sessions is
  'One-time server-managed WeChat iLink QR onboarding sessions.';
comment on table public.wechat_ilink_connections is
  'Encrypted per-user WeChat iLink bot credentials and worker cursor state.';
comment on table public.wechat_message_receipts is
  'Inbound WeChat idempotency ledger; no message content is stored here.';
