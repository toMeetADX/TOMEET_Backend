-- Multi-user QR guards:
-- 1) When one session activates, expire other open QR sessions so the kiosk must
--    mint a fresh code whose local_token_list includes the newly active bot.
-- 2) Completing outbound match-options must not roll back "sent" when the offer
--    window can no longer start (stale round / phase).

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

  -- Stale QR codes carry a local_token_list snapshot from create time. After a
  -- new bot activates, those codes must not remain scannable or they can kick
  -- the newly active long-poll (-14). Force the kiosk onto a fresh QR.
  update public.wechat_connection_sessions
  set status = 'expired',
      error_code = 'superseded_by_activation',
      error_message = '已有新用户接入，请扫描当前最新二维码',
      updated_at = now()
  where id <> p_session_id
    and status in ('pending', 'scanned', 'verification_required');

  return jsonb_build_object(
    'session', to_jsonb(v_session),
    'connection', to_jsonb(v_connection)
  );
end;
$$;

create or replace function public.complete_wechat_outbound_message(
  p_outbound_id uuid,
  p_worker_id text,
  p_error text,
  p_reauth_required boolean
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_delivery public.channel_message_deliveries%rowtype;
  v_idempotency_key text;
begin
  select * into v_delivery
  from public.channel_message_deliveries delivery
  where delivery.id = p_outbound_id
    and delivery.provider = 'wechat'
    and delivery.direction = 'outbound'
    and delivery.locked_by = p_worker_id
  for update;
  if not found then return; end if;

  if p_error is null then
    update public.channel_message_deliveries
    set status = 'sent',
        completed_at = now(),
        locked_by = null,
        locked_at = null,
        last_error = null,
        updated_at = now()
    where id = p_outbound_id;

    select idempotency_key into v_idempotency_key
    from public.messages
    where id = v_delivery.message_id;
    if v_idempotency_key like 'match-options:%' then
      begin
        perform public.activate_match_offer_window(
          split_part(v_idempotency_key, ':', 3)::uuid,
          split_part(v_idempotency_key, ':', 2)::uuid,
          90
        );
      exception
        when others then
          -- Delivery already succeeded; a stale/offered mismatch must not
          -- roll back sent status or force WeChat redelivery loops.
          null;
      end;
    end if;
  else
    update public.channel_message_deliveries
    set status = case
          when p_reauth_required then 'retry'
          when delivery_kind = 'onboarding_welcome' then 'retry'
          when attempts >= 8 then 'failed'
          else 'retry'
        end,
        attempts = case when p_reauth_required then 0 else attempts end,
        run_at = case
          when p_reauth_required then now()
          when delivery_kind <> 'onboarding_welcome' and attempts >= 8 then run_at
          else now() + least(
            interval '15 minutes',
            interval '5 seconds' * power(2, greatest(attempts - 1, 0))
          )
        end,
        locked_by = null,
        locked_at = null,
        last_error = left(p_error, 1000),
        updated_at = now()
    where id = p_outbound_id;

    if p_reauth_required and v_delivery.connection_id is not null then
      update public.wechat_ilink_connections
      set status = 'reauth_required',
          failure_count = failure_count + 1,
          last_error = left(p_error, 1000),
          lease_owner = null,
          lease_expires_at = null,
          updated_at = now()
      where id = v_delivery.connection_id
        and status = 'active';
    end if;
  end if;
end;
$$;

revoke all on function public.activate_wechat_ilink_session(
  uuid, uuid, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.complete_wechat_outbound_message(uuid, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.activate_wechat_ilink_session(
  uuid, uuid, text, text, text, text
) to service_role;
grant execute on function public.complete_wechat_outbound_message(uuid, text, text, boolean)
  to service_role;
