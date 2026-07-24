create or replace function public.sync_tomeet_user_from_auth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.ensure_tomeet_user(
    new.id,
    coalesce(
      nullif(btrim(new.raw_user_meta_data->>'display_name'), ''),
      nullif(btrim(new.raw_user_meta_data->>'full_name'), ''),
      nullif(btrim(new.raw_user_meta_data->>'name'), ''),
      '新朋友'
    )
  );
  return new;
end;
$$;

create or replace function public.delete_tomeet_user_from_auth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.users where id = old.id;
  return old;
end;
$$;

revoke all on function public.sync_tomeet_user_from_auth() from public, anon, authenticated;
revoke all on function public.delete_tomeet_user_from_auth() from public, anon, authenticated;

drop trigger if exists auth_user_sync_to_tomeet on auth.users;
create trigger auth_user_sync_to_tomeet
after insert or update of raw_user_meta_data on auth.users
for each row execute function public.sync_tomeet_user_from_auth();

drop trigger if exists auth_user_delete_from_tomeet on auth.users;
create trigger auth_user_delete_from_tomeet
after delete on auth.users
for each row execute function public.delete_tomeet_user_from_auth();

do $$
declare
  v_user record;
begin
  for v_user in
    select id, raw_user_meta_data from auth.users
  loop
    perform public.ensure_tomeet_user(
      v_user.id,
      coalesce(
        nullif(btrim(v_user.raw_user_meta_data->>'display_name'), ''),
        nullif(btrim(v_user.raw_user_meta_data->>'full_name'), ''),
        nullif(btrim(v_user.raw_user_meta_data->>'name'), ''),
        '新朋友'
      )
    );
  end loop;
end;
$$;
