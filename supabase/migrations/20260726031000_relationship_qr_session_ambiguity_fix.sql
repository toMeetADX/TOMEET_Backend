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

  update public.relationship_qr_sessions as qr
  set expires_at = now()
  where qr.owner_id = v_user_id
    and qr.consumed_at is null
    and qr.expires_at > now();

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into public.relationship_qr_sessions (owner_id, token_hash, expires_at)
  values (v_user_id, encode(digest(v_token, 'sha256'), 'hex'), v_expires_at);

  return query select v_token, v_expires_at, v_show;
end;
$$;

revoke all on function public.create_relationship_qr_session(text,text) from public, anon, authenticated;
grant execute on function public.create_relationship_qr_session(text,text) to authenticated;
