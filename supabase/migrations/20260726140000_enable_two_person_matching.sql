alter table public.offline_games
  drop constraint if exists offline_games_min_players_check;

alter table public.offline_games
  add constraint offline_games_min_players_check
  check (min_players >= 2);

alter table public.match_drafts
  drop constraint if exists match_drafts_target_players_check;

alter table public.match_drafts
  add constraint match_drafts_target_players_check
  check (target_players between 2 and 10);

alter table public.match_rooms
  drop constraint if exists match_rooms_target_players_check;

alter table public.match_rooms
  add constraint match_rooms_target_players_check
  check (target_players between 2 and 10);

update public.offline_games
set min_players = 2
where id = 'game-story-table';
