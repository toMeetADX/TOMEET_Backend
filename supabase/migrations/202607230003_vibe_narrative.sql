alter table public.user_models
  add column if not exists vibe_narrative text not null default ''
  check (char_length(vibe_narrative) <= 12000);
