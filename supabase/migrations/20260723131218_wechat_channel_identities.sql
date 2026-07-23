create table if not exists public.channel_identities (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('wechat')),
  external_user_id text not null check (
    char_length(external_user_id) between 1 and 255
  ),
  user_id uuid not null references public.users(id) on delete cascade,
  display_name text check (
    display_name is null or char_length(display_name) between 1 and 80
  ),
  metadata jsonb not null default '{}'::jsonb,
  linked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (provider, external_user_id),
  unique (provider, user_id)
);

create index if not exists channel_identities_user_id_idx
  on public.channel_identities (user_id);

alter table public.channel_identities enable row level security;

revoke all on table public.channel_identities from anon, authenticated;
grant select, insert, update, delete on table public.channel_identities to service_role;

comment on table public.channel_identities is
  'Server-managed mapping from external channel identities to TOMEET users.';
