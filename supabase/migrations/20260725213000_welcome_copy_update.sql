create or replace function public.start_adventurex_onboarding(
  p_user_id uuid,
  p_language text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message messages%rowtype;
  v_state adventurex_onboarding_states%rowtype;
  v_idempotency_key text;
  v_content text;
begin
  if p_language is null or p_language not in ('zh', 'en') then
    raise exception '无效的引导语言' using errcode = 'P0001';
  end if;

  perform ensure_tomeet_user(p_user_id, '新朋友');
  select * into v_state
  from adventurex_onboarding_states
  where user_id = p_user_id
  for update;

  v_idempotency_key := 'adventurex-welcome:' || p_language || ':' || p_user_id::text;
  select * into v_message
  from messages
  where user_id = p_user_id
    and idempotency_key = v_idempotency_key;

  if found then
    update adventurex_onboarding_states
    set preferred_language = p_language,
        stage = case when stage = 'new' then 'awaiting_image_or_text' else stage end,
        welcome_sent_at = coalesce(welcome_sent_at, v_message.created_at),
        updated_at = now()
    where user_id = p_user_id
    returning * into v_state;
    return jsonb_build_object('message', to_jsonb(v_message), 'state', to_jsonb(v_state));
  end if;

  perform 1 from messages where user_id = p_user_id limit 1;
  if found then
    update adventurex_onboarding_states
    set preferred_language = p_language,
        stage = case when stage in ('new', 'awaiting_image_or_text') then 'exploring' else stage end,
        updated_at = now()
    where user_id = p_user_id
    returning * into v_state;
    return jsonb_build_object('message', null, 'state', to_jsonb(v_state));
  end if;

  v_content := case p_language
    when 'en' then E'Hi there 👋\n\nNice to meet you\n\nYou can share anything that feels representative of you or connected to you, such as screenshots of posts from WeChat Moments, Xiaohongshu, or other social media, or interesting photos you''ve taken recently\n\nOnce I get to know you, I can help connect you with interesting people and activities at AdventureX'
    else E'你好呀👋\n\n很高兴认识你\n\n你可以告诉我任何你觉得可以代表你或与你有关的东西，例如朋友圈，小红书等社交媒体帖子的截图，或者最近一段时间记录的有趣的照片\n\n这样我可以在了解你后帮助你连接AdventureX现场有趣的人和活动'
  end;

  select * into v_message
  from jsonb_populate_record(null::messages, append_agent_message(
    p_user_id,
    'assistant',
    v_content,
    v_idempotency_key
  ));

  update adventurex_onboarding_states
  set stage = 'awaiting_image_or_text',
      preferred_language = p_language,
      welcome_sent_at = now(),
      updated_at = now()
  where user_id = p_user_id
  returning * into v_state;

  return jsonb_build_object('message', to_jsonb(v_message), 'state', to_jsonb(v_state));
end;
$$;
