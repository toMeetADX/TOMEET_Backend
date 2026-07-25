create or replace function public.create_relationship_request(p_token text)
returns table (
  request_id uuid,
  request_status text,
  target_name text,
  target_avatar_url text,
  request_expires_at timestamptz
)
language sql
security invoker
set search_path = public
as $$
  select *
  from public.create_relationship_request(p_token, '新朋友'::text);
$$;

grant execute on function public.create_relationship_request(text) to authenticated;
