create or replace function public.claim_wechat_outbound_messages(
  p_worker_id text,
  p_limit integer default 20
)
returns setof jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with ranked as materialized (
    select
      delivery.id,
      connection.id as connection_id,
      row_number() over (
        partition by connection.id
        order by delivery.created_at, delivery.id
      ) as connection_ordinal
    from public.channel_message_deliveries delivery
    join public.messages message on message.id = delivery.message_id
    join public.wechat_ilink_connections connection
      on connection.user_id = message.user_id
     and connection.status = 'active'
    where delivery.provider = 'wechat'
      and delivery.direction = 'outbound'
      and (
        delivery.delivery_kind <> 'onboarding_welcome'
        or connection.last_message_at is not null
      )
      and (
        (delivery.status in ('pending', 'retry') and delivery.run_at <= now())
        or (
          delivery.status = 'processing'
          and delivery.locked_at < now() - interval '5 minutes'
        )
      )
      and not exists (
        select 1
        from public.channel_message_deliveries in_flight
        where in_flight.provider = 'wechat'
          and in_flight.direction = 'outbound'
          and in_flight.connection_id = connection.id
          and in_flight.status = 'processing'
          and in_flight.locked_at >= now() - interval '5 minutes'
      )
  ), claimable as (
    select delivery.id, ranked.connection_id
    from ranked
    join public.channel_message_deliveries delivery on delivery.id = ranked.id
    where ranked.connection_ordinal = 1
    order by delivery.created_at
    for update of delivery skip locked
    limit least(greatest(p_limit, 1), 100)
  ), updated as (
    update public.channel_message_deliveries delivery
    set connection_id = claimable.connection_id,
        status = 'processing',
        attempts = delivery.attempts + 1,
        locked_by = p_worker_id,
        locked_at = now(),
        updated_at = now()
    from claimable
    where delivery.id = claimable.id
    returning delivery.*
  )
  select jsonb_build_object(
    'id', updated.id,
    'messageId', updated.message_id,
    'userId', message.user_id,
    'content', coalesce(updated.payload_override, message.content),
    'kind', updated.delivery_kind,
    'claimId', updated.welcome_claim_id,
    'attempts', updated.attempts,
    'connection', to_jsonb(connection)
  )
  from updated
  join public.messages message on message.id = updated.message_id
  join public.wechat_ilink_connections connection on connection.id = updated.connection_id;
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
      perform public.activate_match_offer_window(
        split_part(v_idempotency_key, ':', 3)::uuid,
        split_part(v_idempotency_key, ':', 2)::uuid,
        90
      );
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

revoke all on function public.complete_wechat_outbound_message(uuid, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_wechat_outbound_messages(text, integer)
  to service_role;
grant execute on function public.complete_wechat_outbound_message(uuid, text, text, boolean)
  to service_role;
