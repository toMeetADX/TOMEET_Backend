alter table public.relationship_requests
  add column if not exists relationship_label text;

alter table public.relationship_credentials
  add column if not exists relationship_label text;

update public.relationship_requests
set relationship_label = '新朋友'
where relationship_label is null or btrim(relationship_label) = '';

update public.relationship_credentials
set relationship_label = '新朋友'
where relationship_label is null or btrim(relationship_label) = '';

alter table public.relationship_requests
  alter column relationship_label set default '新朋友',
  alter column relationship_label set not null;

alter table public.relationship_credentials
  alter column relationship_label set default '新朋友',
  alter column relationship_label set not null;

alter table public.relationship_requests
  drop constraint if exists relationship_requests_label_check;
alter table public.relationship_requests
  add constraint relationship_requests_label_check
  check (
    relationship_label = btrim(relationship_label)
    and char_length(relationship_label) between 1 and 24
  );

alter table public.relationship_credentials
  drop constraint if exists relationship_credentials_label_check;
alter table public.relationship_credentials
  add constraint relationship_credentials_label_check
  check (
    relationship_label = btrim(relationship_label)
    and char_length(relationship_label) between 1 and 24
  );

drop function if exists public.create_relationship_request(text);
drop function if exists public.create_relationship_request(text,text);

create function public.create_relationship_request(
  p_token text,
  p_relationship_label text
)
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
  v_relationship_label text := btrim(p_relationship_label);
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid QR token' using errcode = '22023';
  end if;
  if v_relationship_label is null or char_length(v_relationship_label) not between 1 and 24 then
    raise exception 'Invalid relationship label' using errcode = '22023';
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
      initiator_id, target_id, qr_session_id, relationship_label, expires_at
    ) values (
      v_user_id, v_session.owner_id, v_session.id, v_relationship_label,
      least(v_session.expires_at, now() + interval '5 minutes')
    ) returning * into v_request;
  elsif v_request.initiator_id = v_user_id then
    update public.relationship_requests
    set relationship_label = v_relationship_label
    where id = v_request.id
    returning * into v_request;
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

drop function if exists public.respond_relationship_request(uuid,boolean);

create function public.respond_relationship_request(
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
      id, user_a, user_b, status, confirmed_at, relationship_label,
      relationship_hash, party_a_commitment, party_b_commitment
    ) values (
      v_credential_id, v_user_a, v_user_b, 'chain_pending', v_confirmed_at,
      v_request.relationship_label,
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

drop function if exists public.get_my_pending_relationship_requests();

create function public.get_my_pending_relationship_requests()
returns table (
  request_id uuid,
  direction text,
  other_user_id uuid,
  other_name text,
  other_avatar_url text,
  relationship_label text,
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
    r.relationship_label,
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

drop function if exists public.get_my_relationship_credentials();

create function public.get_my_relationship_credentials()
returns table (
  id uuid,
  friend_name text,
  friend_avatar_url text,
  relationship_label text,
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
    c.relationship_label,
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

revoke all on function public.create_relationship_request(text,text) from public, anon, authenticated;
revoke all on function public.respond_relationship_request(uuid,boolean) from public, anon, authenticated;
revoke all on function public.get_my_pending_relationship_requests() from public, anon, authenticated;
revoke all on function public.get_my_relationship_credentials() from public, anon, authenticated;

grant execute on function public.create_relationship_request(text,text) to authenticated;
grant execute on function public.respond_relationship_request(uuid,boolean) to authenticated;
grant execute on function public.get_my_pending_relationship_requests() to authenticated;
grant execute on function public.get_my_relationship_credentials() to authenticated;
