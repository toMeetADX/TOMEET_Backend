-- Agent job lease: heartbeat + ownership-checked complete/fail.
-- Prevents stale 5-minute reclaim from letting a second worker finish
-- (or double-apply side effects of) a long agent_reply / settle job.

drop function if exists public.complete_llm_job(uuid, jsonb);
drop function if exists public.fail_llm_job(uuid, text);

create or replace function public.heartbeat_llm_job(p_job_id uuid, p_worker_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update llm_jobs
  set locked_at = now(),
      updated_at = now()
  where id = p_job_id
    and status = 'processing'
    and locked_by = p_worker_id;
  return found;
end;
$$;

create or replace function public.complete_llm_job(
  p_job_id uuid,
  p_result jsonb,
  p_worker_id text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update llm_jobs
  set status = 'completed',
      result = p_result,
      error = null,
      locked_at = null,
      locked_by = null,
      updated_at = now()
  where id = p_job_id
    and status = 'processing'
    and (p_worker_id is null or locked_by = p_worker_id);
  if not found then
    raise exception '任务不存在、状态已变化或锁持有者不匹配' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.fail_llm_job(
  p_job_id uuid,
  p_error text,
  p_worker_id text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update llm_jobs
  set status = case when attempts >= max_attempts then 'failed' else 'retry' end,
      run_at = case
        when attempts >= max_attempts then run_at
        else now() + make_interval(secs => least(60, power(2, attempts)::integer))
      end,
      error = left(p_error, 4000),
      locked_at = null,
      locked_by = null,
      updated_at = now()
  where id = p_job_id
    and status = 'processing'
    and (p_worker_id is null or locked_by = p_worker_id);
  if not found then
    raise exception '任务不存在、状态已变化或锁持有者不匹配' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.heartbeat_llm_job(uuid, text) from public, anon, authenticated;
revoke all on function public.complete_llm_job(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.fail_llm_job(uuid, text, text) from public, anon, authenticated;
