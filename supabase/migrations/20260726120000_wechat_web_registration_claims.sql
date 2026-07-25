create table if not exists public.wechat_web_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token_hash text not null unique
    check (token_hash ~ '^[a-f0-9]{64}$'),
  access_token_ciphertext text not null
    check (char_length(access_token_ciphertext) between 32 and 16384),
  refresh_token_ciphertext text not null
    check (char_length(refresh_token_ciphertext) between 32 and 16384),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (consumed_at is null or consumed_at >= created_at)
);

create index if not exists wechat_web_claims_user_created_idx
  on public.wechat_web_claims (user_id, created_at desc);

create index if not exists wechat_web_claims_active_expiry_idx
  on public.wechat_web_claims (expires_at)
  where consumed_at is null;

alter table public.wechat_web_claims enable row level security;

revoke all on table public.wechat_web_claims from public, anon, authenticated;
grant select, insert, update, delete on table public.wechat_web_claims to service_role;

comment on table public.wechat_web_claims is
  'One-time encrypted Supabase sessions used to upgrade a WeChat-created anonymous account on the Web.';
