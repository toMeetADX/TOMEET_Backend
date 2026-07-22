-- Optional demo candidates. Run only in a development Supabase project.
do $$
declare
  v_ids uuid[] := array[
    '10000000-0000-4000-8000-000000000001'::uuid,
    '10000000-0000-4000-8000-000000000002'::uuid,
    '10000000-0000-4000-8000-000000000003'::uuid,
    '10000000-0000-4000-8000-000000000004'::uuid
  ];
  v_names text[] := array['林知夏','陈屿','乔木','宋然'];
  i integer;
begin
  for i in 1..array_length(v_ids, 1) loop
    perform public.ensure_tomeet_user(v_ids[i], v_names[i]);
    update public.users set is_demo = true where id = v_ids[i];
    update public.user_models
    set long_term_profile = jsonb_build_object('interests', array['摄影','咖啡'], 'interactionStyle', '友好自然'),
        current_intent = jsonb_build_object('desiredAtmosphere', '轻松自然', 'rawText', '想认识新朋友'),
        version = version + 1,
        updated_at = now()
    where user_id = v_ids[i];
    perform public.create_match_request(v_ids[i], jsonb_build_object('desiredAtmosphere', '轻松自然', 'rawText', '想认识新朋友'));
  end loop;
end $$;
