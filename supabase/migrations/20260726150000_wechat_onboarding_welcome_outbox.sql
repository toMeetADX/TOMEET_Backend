alter table public.channel_message_deliveries
  add column if not exists delivery_kind text not null default 'message',
  add column if not exists welcome_claim_id uuid
    references public.wechat_web_claims(id) on delete set null;

alter table public.channel_message_deliveries
  drop constraint if exists channel_message_deliveries_delivery_kind_check,
  add constraint channel_message_deliveries_delivery_kind_check
    check (delivery_kind in ('message', 'onboarding_welcome'));

alter table public.channel_message_deliveries
  drop constraint if exists channel_message_deliveries_attempts_check,
  add constraint channel_message_deliveries_attempts_check check (attempts >= 0);

drop view if exists public.wechat_outbound_messages;

create view public.wechat_outbound_messages as
select
  d.id,
  m.user_id,
  d.message_id,
  coalesce(d.payload_override, m.content) as content,
  d.delivery_kind,
  d.welcome_claim_id,
  d.status,
  d.attempts,
  d.run_at,
  d.locked_by,
  d.locked_at,
  d.completed_at as sent_at,
  d.last_error,
  d.created_at,
  d.updated_at
from public.channel_message_deliveries d
join public.messages m on m.id = d.message_id
where d.provider = 'wechat' and d.direction = 'outbound';

revoke all on table public.wechat_outbound_messages from public, anon, authenticated;
grant select on table public.wechat_outbound_messages to service_role;

create or replace function public.enqueue_wechat_onboarding_welcome(
  p_user_id uuid,
  p_message_id uuid,
  p_payload_ciphertext text,
  p_claim_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message public.messages%rowtype;
begin
  select * into v_message
  from public.messages
  where id = p_message_id and user_id = p_user_id;

  if not found
    or v_message.role <> 'assistant'
    or v_message.idempotency_key not like 'adventurex-welcome:%' then
    raise exception '微信开场白消息不存在或类型错误' using errcode = 'P0001';
  end if;

  if p_payload_ciphertext is null
    or char_length(p_payload_ciphertext) not between 32 and 20000 then
    raise exception '微信开场白加密载荷无效' using errcode = 'P0001';
  end if;

  if p_claim_id is not null and not exists (
    select 1 from public.wechat_web_claims claim
    where claim.id = p_claim_id and claim.user_id = p_user_id
  ) then
    raise exception '微信注册链接不属于当前用户' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.wechat_ilink_connections connection
    where connection.user_id = p_user_id and connection.status = 'active'
  ) then
    insert into public.channel_message_deliveries (
      provider,
      direction,
      message_id,
      payload_override,
      delivery_kind,
      welcome_claim_id,
      status
    ) values (
      'wechat',
      'outbound',
      p_message_id,
      p_payload_ciphertext,
      'onboarding_welcome',
      p_claim_id,
      'pending'
    )
    on conflict (provider, message_id) where direction = 'outbound'
    do nothing;
  end if;
end;
$$;

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
  with claimable as (
    select delivery.id, connection.id as connection_id
    from public.channel_message_deliveries delivery
    join public.messages message on message.id = delivery.message_id
    join public.wechat_ilink_connections connection
      on connection.user_id = message.user_id and connection.status = 'active'
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
    order by delivery.created_at
    for update of delivery skip locked
    limit least(greatest(p_limit, 1), 100)
  ), updated as (
    update public.channel_message_deliveries delivery set
      connection_id = claimable.connection_id,
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
  p_error text default null
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
          when delivery_kind = 'onboarding_welcome' then 'retry'
          when attempts >= 8 then 'failed'
          else 'retry'
        end,
        run_at = case
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
  end if;
end;
$$;

revoke all on function public.enqueue_wechat_onboarding_welcome(uuid, uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function public.claim_wechat_outbound_messages(text, integer)
  from public, anon, authenticated;
revoke all on function public.complete_wechat_outbound_message(uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.enqueue_wechat_onboarding_welcome(uuid, uuid, text, uuid)
  to service_role;
grant execute on function public.claim_wechat_outbound_messages(text, integer)
  to service_role;
grant execute on function public.complete_wechat_outbound_message(uuid, text, text)
  to service_role;

comment on column public.channel_message_deliveries.delivery_kind is
  'Business purpose of an outbound delivery. Onboarding welcome tasks are retried until finalized.';
comment on column public.channel_message_deliveries.welcome_claim_id is
  'Registration claim bound to the immutable encrypted onboarding payload, if any.';
