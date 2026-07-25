-- Canonical social relationship schema. The same migration is deployed from
-- the TOMEET backend repository; this copy keeps the web repository self-contained.
create extension if not exists pgcrypto;

create table if not exists public.social_profiles (
  user_id uuid primary key references public.users(id) on delete cascade,
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2048),
  show_on_foodies boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.relationship_qr_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.users(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.relationship_requests (
  id uuid primary key default gen_random_uuid(),
  initiator_id uuid not null references public.users(id) on delete cascade,
  target_id uuid not null references public.users(id) on delete cascade,
  qr_session_id uuid not null unique references public.relationship_qr_sessions(id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending','confirmed','rejected','expired','cancelled')),
  expires_at timestamptz not null,
  responded_at timestamptz,
  credential_id uuid unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (initiator_id <> target_id)
);

create unique index if not exists relationship_requests_one_pending_pair
  on public.relationship_requests (
    least(initiator_id::text, target_id::text),
    greatest(initiator_id::text, target_id::text)
  ) where status = 'pending';

create table if not exists public.relationship_credentials (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references public.users(id) on delete cascade,
  user_b uuid not null references public.users(id) on delete cascade,
  status text not null default 'chain_pending'
    check (status in ('chain_pending','chain_confirmed','chain_failed','revoke_pending','revoked')),
  confirmed_at timestamptz not null,
  relationship_hash text not null unique check (relationship_hash ~ '^[0-9a-f]{64}$'),
  party_a_commitment text not null check (party_a_commitment ~ '^[0-9a-f]{64}$'),
  party_b_commitment text not null check (party_b_commitment ~ '^[0-9a-f]{64}$'),
  chain_id bigint,
  contract_address text check (contract_address is null or contract_address ~ '^0x[0-9a-fA-F]{40}$'),
  chain_tx_hash text check (chain_tx_hash is null or chain_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  block_number bigint check (block_number is null or block_number >= 0),
  onchain_at timestamptz,
  revoked_at timestamptz,
  last_chain_error text check (last_chain_error is null or char_length(last_chain_error) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_a::text < user_b::text)
);

create unique index if not exists relationship_credentials_one_active_pair
  on public.relationship_credentials (user_a, user_b)
  where status <> 'revoked';

alter table public.relationship_requests
  drop constraint if exists relationship_requests_credential_id_fkey;
alter table public.relationship_requests
  add constraint relationship_requests_credential_id_fkey
  foreign key (credential_id) references public.relationship_credentials(id) on delete set null;

create table if not exists public.relationship_onchain_jobs (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid not null references public.relationship_credentials(id) on delete cascade,
  action text not null check (action in ('anchor','revoke')),
  status text not null default 'pending'
    check (status in ('pending','processing','retry','completed','failed')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  max_attempts integer not null default 8 check (max_attempts between 1 and 10),
  run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  tx_hash text,
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (credential_id, action)
);

create index if not exists relationship_qr_owner_active_idx
  on public.relationship_qr_sessions (owner_id, expires_at desc)
  where consumed_at is null;
create index if not exists relationship_requests_target_pending_idx
  on public.relationship_requests (target_id, created_at desc)
  where status = 'pending';
create index if not exists relationship_credentials_a_idx
  on public.relationship_credentials (user_a, confirmed_at desc);
create index if not exists relationship_credentials_b_idx
  on public.relationship_credentials (user_b, confirmed_at desc);
create index if not exists relationship_onchain_jobs_claim_idx
  on public.relationship_onchain_jobs (run_at, created_at)
  where status in ('pending','retry');

create table if not exists public.relationship_leaderboard_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now()
);

create or replace function public.touch_social_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists social_profiles_touch_updated_at on public.social_profiles;
create trigger social_profiles_touch_updated_at
before update on public.social_profiles
for each row execute function public.touch_social_updated_at();

drop trigger if exists relationship_requests_touch_updated_at on public.relationship_requests;
create trigger relationship_requests_touch_updated_at
before update on public.relationship_requests
for each row execute function public.touch_social_updated_at();

drop trigger if exists relationship_credentials_touch_updated_at on public.relationship_credentials;
create trigger relationship_credentials_touch_updated_at
before update on public.relationship_credentials
for each row execute function public.touch_social_updated_at();

drop trigger if exists relationship_jobs_touch_updated_at on public.relationship_onchain_jobs;
create trigger relationship_jobs_touch_updated_at
before update on public.relationship_onchain_jobs
for each row execute function public.touch_social_updated_at();

create or replace function public.create_relationship_qr_session(
  p_display_name text,
  p_avatar_url text default null
)
returns table (token text, expires_at timestamptz, show_on_foodies boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_id uuid := auth.uid();
  v_token text;
  v_expires_at timestamptz := now() + interval '90 seconds';
  v_show boolean;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_display_name is null or char_length(btrim(p_display_name)) not between 1 and 80 then
    raise exception 'Invalid display name' using errcode = '22023';
  end if;
  if p_avatar_url is not null and char_length(p_avatar_url) > 2048 then
    raise exception 'Invalid avatar URL' using errcode = '22023';
  end if;

  insert into public.users (id, display_name)
  values (v_user_id, btrim(p_display_name))
  on conflict (id) do update set display_name = excluded.display_name, updated_at = now();

  insert into public.social_profiles (user_id, avatar_url)
  values (v_user_id, p_avatar_url)
  on conflict (user_id) do update set avatar_url = excluded.avatar_url
  returning social_profiles.show_on_foodies into v_show;

  update public.relationship_qr_sessions
  set expires_at = now()
  where owner_id = v_user_id and consumed_at is null and expires_at > now();

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into public.relationship_qr_sessions (owner_id, token_hash, expires_at)
  values (v_user_id, encode(digest(v_token, 'sha256'), 'hex'), v_expires_at);

  return query select v_token, v_expires_at, v_show;
end;
$$;

create or replace function public.resolve_relationship_qr_session(p_token text)
returns table (
  target_id uuid,
  display_name text,
  avatar_url text,
  expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid QR token' using errcode = '22023';
  end if;

  return query
  select s.owner_id, u.display_name, p.avatar_url, s.expires_at
  from public.relationship_qr_sessions s
  join public.users u on u.id = s.owner_id
  left join public.social_profiles p on p.user_id = s.owner_id
  where s.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and s.expires_at > now()
    and s.consumed_at is null
    and s.owner_id <> auth.uid();
end;
$$;

create or replace function public.create_relationship_request(p_token text)
returns table (
  request_id uuid,
  request_status text,
  target_name text,
  target_avatar_url text,
  request_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_id uuid := auth.uid();
  v_session public.relationship_qr_sessions%rowtype;
  v_request public.relationship_requests%rowtype;
  v_target_name text;
  v_target_avatar text;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid QR token' using errcode = '22023';
  end if;
  if (select count(*) from public.relationship_requests where initiator_id = v_user_id and created_at > now() - interval '1 day') >= 30 then
    raise exception 'Daily relationship request limit reached' using errcode = 'P0001';
  end if;

  update public.relationship_requests
  set status = 'expired', responded_at = now()
  where status = 'pending' and expires_at <= now();

  select * into v_session
  from public.relationship_qr_sessions
  where token_hash = encode(digest(p_token, 'sha256'), 'hex')
  for update;

  if not found or v_session.expires_at <= now() or v_session.consumed_at is not null then
    raise exception 'QR session expired' using errcode = 'P0002';
  end if;
  if v_session.owner_id = v_user_id then
    raise exception 'Cannot add yourself' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.relationship_credentials c
    where c.user_a::text = least(v_user_id::text, v_session.owner_id::text)
      and c.user_b::text = greatest(v_user_id::text, v_session.owner_id::text)
      and c.status <> 'revoked'
  ) then
    raise exception 'Relationship already exists' using errcode = '23505';
  end if;

  select * into v_request
  from public.relationship_requests r
  where least(r.initiator_id::text, r.target_id::text) = least(v_user_id::text, v_session.owner_id::text)
    and greatest(r.initiator_id::text, r.target_id::text) = greatest(v_user_id::text, v_session.owner_id::text)
    and r.status = 'pending'
  limit 1;

  if not found then
    insert into public.relationship_requests (
      initiator_id, target_id, qr_session_id, expires_at
    ) values (
      v_user_id, v_session.owner_id, v_session.id, least(v_session.expires_at, now() + interval '5 minutes')
    ) returning * into v_request;
  end if;

  update public.relationship_qr_sessions
  set consumed_at = now(), consumed_by = v_user_id
  where id = v_session.id;

  select u.display_name, p.avatar_url into v_target_name, v_target_avatar
  from public.users u
  left join public.social_profiles p on p.user_id = u.id
  where u.id = v_session.owner_id;

  return query select v_request.id, v_request.status, v_target_name, v_target_avatar, v_request.expires_at;
end;
$$;

create or replace function public.respond_relationship_request(
  p_request_id uuid,
  p_accept boolean
)
returns table (credential_id uuid, relationship_status text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_id uuid := auth.uid();
  v_request public.relationship_requests%rowtype;
  v_credential_id uuid;
  v_user_a uuid;
  v_user_b uuid;
  v_confirmed_at timestamptz := now();
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode = '28000'; end if;

  select * into v_request from public.relationship_requests
  where id = p_request_id for update;
  if not found or v_request.target_id <> v_user_id then
    raise exception 'Relationship request not found' using errcode = 'P0002';
  end if;
  if v_request.status <> 'pending' then
    return query select v_request.credential_id, v_request.status;
    return;
  end if;
  if v_request.expires_at <= now() then
    update public.relationship_requests
    set status = 'expired', responded_at = now()
    where id = v_request.id;
    return query select null::uuid, 'expired'::text;
    return;
  end if;
  if not p_accept then
    update public.relationship_requests
    set status = 'rejected', responded_at = now()
    where id = v_request.id;
    return query select null::uuid, 'rejected'::text;
    return;
  end if;

  if v_request.initiator_id::text < v_request.target_id::text then
    v_user_a := v_request.initiator_id;
    v_user_b := v_request.target_id;
  else
    v_user_a := v_request.target_id;
    v_user_b := v_request.initiator_id;
  end if;

  select c.id into v_credential_id
  from public.relationship_credentials c
  where c.user_a = v_user_a and c.user_b = v_user_b and c.status <> 'revoked';

  if v_credential_id is null then
    v_credential_id := gen_random_uuid();
    insert into public.relationship_credentials (
      id, user_a, user_b, status, confirmed_at,
      relationship_hash, party_a_commitment, party_b_commitment
    ) values (
      v_credential_id, v_user_a, v_user_b, 'chain_pending', v_confirmed_at,
      encode(digest(
        'tomeet:relationship:v1:' || v_credential_id::text || ':' || v_user_a::text || ':' || v_user_b::text,
        'sha256'
      ), 'hex'),
      encode(gen_random_bytes(32), 'hex'),
      encode(gen_random_bytes(32), 'hex')
    );
    insert into public.relationship_onchain_jobs (credential_id, action)
    values (v_credential_id, 'anchor');
  end if;

  update public.relationship_requests
  set status = 'confirmed', responded_at = now(), credential_id = v_credential_id
  where id = v_request.id;

  return query select v_credential_id, 'chain_pending'::text;
end;
$$;

create or replace function public.get_my_pending_relationship_requests()
returns table (
  request_id uuid,
  direction text,
  other_user_id uuid,
  other_name text,
  other_avatar_url text,
  request_status text,
  expires_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.id,
    case when r.target_id = auth.uid() then 'incoming' else 'outgoing' end,
    other.id,
    other.display_name,
    p.avatar_url,
    r.status,
    r.expires_at,
    r.created_at
  from public.relationship_requests r
  join public.users other
    on other.id = case when r.target_id = auth.uid() then r.initiator_id else r.target_id end
  left join public.social_profiles p on p.user_id = other.id
  where (r.initiator_id = auth.uid() or r.target_id = auth.uid())
    and r.status = 'pending'
    and r.expires_at > now()
  order by r.created_at desc;
$$;

create or replace function public.get_relationship_request_status(p_request_id uuid)
returns table (request_status text, credential_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select r.status, r.credential_id
  from public.relationship_requests r
  where r.id = p_request_id
    and (r.initiator_id = auth.uid() or r.target_id = auth.uid());
$$;

create or replace function public.get_my_relationship_credentials()
returns table (
  id uuid,
  friend_name text,
  friend_avatar_url text,
  confirmed_at timestamptz,
  relationship_status text,
  chain_id bigint,
  contract_address text,
  chain_tx_hash text,
  block_number bigint,
  onchain_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    friend.display_name,
    p.avatar_url,
    c.confirmed_at,
    c.status,
    c.chain_id,
    c.contract_address,
    c.chain_tx_hash,
    c.block_number,
    c.onchain_at
  from public.relationship_credentials c
  join public.users friend
    on friend.id = case when c.user_a = auth.uid() then c.user_b else c.user_a end
  left join public.social_profiles p on p.user_id = friend.id
  where c.user_a = auth.uid() or c.user_b = auth.uid()
  order by c.confirmed_at desc;
$$;

create or replace function public.set_my_foodies_visibility(p_visible boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  insert into public.social_profiles (user_id, show_on_foodies)
  values (auth.uid(), p_visible)
  on conflict (user_id) do update set show_on_foodies = excluded.show_on_foodies;
  insert into public.relationship_leaderboard_events default values;
  return p_visible;
end;
$$;

create or replace function public.get_my_foodies_visibility()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select show_on_foodies from public.social_profiles where user_id = auth.uid()), true);
$$;

create or replace function public.get_foodies_leaderboard()
returns table (
  user_id uuid,
  display_name text,
  avatar_url text,
  connection_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with connections as (
    select user_a as user_id from public.relationship_credentials where status = 'chain_confirmed'
    union all
    select user_b as user_id from public.relationship_credentials where status = 'chain_confirmed'
  )
  select u.id, u.display_name, p.avatar_url, count(c.user_id)
  from public.users u
  join public.social_profiles p on p.user_id = u.id and p.show_on_foodies
  join connections c on c.user_id = u.id
  group by u.id, u.display_name, p.avatar_url, u.created_at
  order by count(c.user_id) desc, u.created_at asc
  limit 100;
$$;

create or replace function public.revoke_relationship(p_credential_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_credential public.relationship_credentials%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into v_credential from public.relationship_credentials
  where id = p_credential_id for update;
  if not found or (v_credential.user_a <> auth.uid() and v_credential.user_b <> auth.uid()) then
    raise exception 'Relationship not found' using errcode = 'P0002';
  end if;
  if v_credential.status = 'revoked' then return 'revoked'; end if;
  if v_credential.status <> 'chain_confirmed' then
    raise exception 'Relationship is not anchored' using errcode = 'P0001';
  end if;
  update public.relationship_credentials set status = 'revoke_pending' where id = p_credential_id;
  insert into public.relationship_onchain_jobs (credential_id, action)
  values (p_credential_id, 'revoke') on conflict (credential_id, action) do nothing;
  insert into public.relationship_leaderboard_events default values;
  return 'revoke_pending';
end;
$$;

create or replace function public.claim_relationship_onchain_job(p_worker_id text)
returns table (
  job_id uuid,
  action text,
  credential_id uuid,
  relationship_hash text,
  party_a_commitment text,
  party_b_commitment text,
  confirmed_at timestamptz,
  attempt integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  update public.relationship_onchain_jobs
  set status = 'retry', locked_at = null, locked_by = null, run_at = now()
  where status = 'processing' and locked_at < now() - interval '5 minutes';

  select j.id into v_job_id
  from public.relationship_onchain_jobs j
  where j.status in ('pending','retry') and j.run_at <= now()
  order by j.run_at, j.created_at
  for update skip locked
  limit 1;

  if v_job_id is null then return; end if;

  update public.relationship_onchain_jobs
  set status = 'processing', attempts = attempts + 1, locked_at = now(), locked_by = p_worker_id
  where id = v_job_id;

  return query
  select j.id, j.action, c.id, c.relationship_hash,
    c.party_a_commitment, c.party_b_commitment, c.confirmed_at, j.attempts
  from public.relationship_onchain_jobs j
  join public.relationship_credentials c on c.id = j.credential_id
  where j.id = v_job_id;
end;
$$;

create or replace function public.complete_relationship_onchain_job(
  p_job_id uuid,
  p_worker_id text,
  p_tx_hash text,
  p_block_number bigint,
  p_chain_id bigint,
  p_contract_address text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.relationship_onchain_jobs%rowtype;
begin
  select * into v_job from public.relationship_onchain_jobs
  where id = p_job_id and status = 'processing' and locked_by = p_worker_id
  for update;
  if not found then raise exception 'Job lease lost' using errcode = 'P0001'; end if;

  update public.relationship_onchain_jobs
  set status = 'completed', tx_hash = p_tx_hash, last_error = null, locked_at = null, locked_by = null
  where id = p_job_id;

  if v_job.action = 'anchor' then
    update public.relationship_credentials set
      status = 'chain_confirmed', chain_id = p_chain_id,
      contract_address = p_contract_address, chain_tx_hash = p_tx_hash,
      block_number = p_block_number, onchain_at = now(), last_chain_error = null
    where id = v_job.credential_id;
  else
    update public.relationship_credentials set
      status = 'revoked', chain_id = p_chain_id,
      contract_address = p_contract_address, chain_tx_hash = p_tx_hash,
      block_number = p_block_number, revoked_at = now(), last_chain_error = null
    where id = v_job.credential_id;
  end if;
  insert into public.relationship_leaderboard_events default values;
end;
$$;

create or replace function public.fail_relationship_onchain_job(
  p_job_id uuid,
  p_worker_id text,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.relationship_onchain_jobs%rowtype;
  v_terminal boolean;
begin
  select * into v_job from public.relationship_onchain_jobs
  where id = p_job_id and status = 'processing' and locked_by = p_worker_id
  for update;
  if not found then raise exception 'Job lease lost' using errcode = 'P0001'; end if;
  v_terminal := v_job.attempts >= v_job.max_attempts;

  update public.relationship_onchain_jobs set
    status = case when v_terminal then 'failed' else 'retry' end,
    run_at = case when v_terminal then run_at else now() + make_interval(secs => least(300, power(2, attempts)::integer)) end,
    last_error = left(p_error, 1000), locked_at = null, locked_by = null
  where id = p_job_id;

  update public.relationship_credentials set
    status = case when v_job.action = 'anchor' then 'chain_failed' else status end,
    last_chain_error = left(p_error, 1000)
  where id = v_job.credential_id;
end;
$$;

alter table public.social_profiles enable row level security;
alter table public.relationship_qr_sessions enable row level security;
alter table public.relationship_requests enable row level security;
alter table public.relationship_credentials enable row level security;
alter table public.relationship_onchain_jobs enable row level security;
alter table public.relationship_leaderboard_events enable row level security;
alter table public.relationship_requests replica identity full;
alter table public.relationship_credentials replica identity full;

drop policy if exists social_profiles_owner_select on public.social_profiles;
create policy social_profiles_owner_select on public.social_profiles for select to authenticated
using (user_id = auth.uid());
drop policy if exists relationship_qr_owner_select on public.relationship_qr_sessions;
create policy relationship_qr_owner_select on public.relationship_qr_sessions for select to authenticated
using (owner_id = auth.uid());
drop policy if exists relationship_requests_participant_select on public.relationship_requests;
create policy relationship_requests_participant_select on public.relationship_requests for select to authenticated
using (initiator_id = auth.uid() or target_id = auth.uid());
drop policy if exists relationship_credentials_participant_select on public.relationship_credentials;
create policy relationship_credentials_participant_select on public.relationship_credentials for select to authenticated
using (user_a = auth.uid() or user_b = auth.uid());
drop policy if exists relationship_leaderboard_events_public_select on public.relationship_leaderboard_events;
create policy relationship_leaderboard_events_public_select on public.relationship_leaderboard_events for select
to anon, authenticated using (true);

revoke all on table public.social_profiles, public.relationship_qr_sessions,
  public.relationship_requests, public.relationship_credentials,
  public.relationship_onchain_jobs, public.relationship_leaderboard_events
from public, anon, authenticated;
grant select on public.social_profiles, public.relationship_qr_sessions,
  public.relationship_requests, public.relationship_credentials to authenticated;
grant select on public.relationship_leaderboard_events to anon, authenticated;
grant usage, select on sequence public.relationship_leaderboard_events_id_seq to anon, authenticated;
grant select, insert, update, delete on public.social_profiles, public.relationship_qr_sessions,
  public.relationship_requests, public.relationship_credentials,
  public.relationship_onchain_jobs, public.relationship_leaderboard_events to service_role;

revoke all on function public.touch_social_updated_at() from public, anon, authenticated;
revoke all on function public.create_relationship_qr_session(text,text) from public, anon, authenticated;
revoke all on function public.resolve_relationship_qr_session(text) from public, anon, authenticated;
revoke all on function public.create_relationship_request(text) from public, anon, authenticated;
revoke all on function public.respond_relationship_request(uuid,boolean) from public, anon, authenticated;
revoke all on function public.get_my_pending_relationship_requests() from public, anon, authenticated;
revoke all on function public.get_relationship_request_status(uuid) from public, anon, authenticated;
revoke all on function public.get_my_relationship_credentials() from public, anon, authenticated;
revoke all on function public.set_my_foodies_visibility(boolean) from public, anon, authenticated;
revoke all on function public.get_my_foodies_visibility() from public, anon, authenticated;
revoke all on function public.get_foodies_leaderboard() from public, anon, authenticated;
revoke all on function public.revoke_relationship(uuid) from public, anon, authenticated;
revoke all on function public.claim_relationship_onchain_job(text) from public, anon, authenticated;
revoke all on function public.complete_relationship_onchain_job(uuid,text,text,bigint,bigint,text) from public, anon, authenticated;
revoke all on function public.fail_relationship_onchain_job(uuid,text,text) from public, anon, authenticated;

grant execute on function public.create_relationship_qr_session(text,text) to authenticated;
grant execute on function public.resolve_relationship_qr_session(text) to authenticated;
grant execute on function public.create_relationship_request(text) to authenticated;
grant execute on function public.respond_relationship_request(uuid,boolean) to authenticated;
grant execute on function public.get_my_pending_relationship_requests() to authenticated;
grant execute on function public.get_relationship_request_status(uuid) to authenticated;
grant execute on function public.get_my_relationship_credentials() to authenticated;
grant execute on function public.set_my_foodies_visibility(boolean) to authenticated;
grant execute on function public.get_my_foodies_visibility() to authenticated;
grant execute on function public.get_foodies_leaderboard() to anon, authenticated;
grant execute on function public.revoke_relationship(uuid) to authenticated;
grant execute on function public.claim_relationship_onchain_job(text) to service_role;
grant execute on function public.complete_relationship_onchain_job(uuid,text,text,bigint,bigint,text) to service_role;
grant execute on function public.fail_relationship_onchain_job(uuid,text,text) to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'relationship_requests'
    ) then alter publication supabase_realtime add table public.relationship_requests; end if;
    if not exists (
      select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'relationship_credentials'
    ) then alter publication supabase_realtime add table public.relationship_credentials; end if;
    if not exists (
      select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'relationship_leaderboard_events'
    ) then alter publication supabase_realtime add table public.relationship_leaderboard_events; end if;
  end if;
end;
$$;
