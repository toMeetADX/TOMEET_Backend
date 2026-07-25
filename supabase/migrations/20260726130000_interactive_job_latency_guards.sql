-- Keep background memory work from blocking interactive replies, including jobs that were
-- queued before the application started using the dedicated memory partition.
update public.llm_jobs
set partition_key = 'memory:' || coalesce(
  payload->>'userId',
  payload#>>'{feedback,userId}'
)
where job_type in ('memory_extract', 'memory_consolidate', 'feedback_update')
  and status in ('pending', 'retry')
  and coalesce(payload->>'userId', payload#>>'{feedback,userId}') is not null;

-- A future retry must not reserve its partition during backoff. Ready jobs still preserve FIFO,
-- and a currently processing job remains the exclusive owner of its partition.
create or replace function public.claim_llm_job(p_worker_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row llm_jobs%rowtype;
begin
  update llm_jobs
  set status = 'retry',
      locked_at = null,
      locked_by = null,
      error = coalesce(error, '任务锁超时'),
      updated_at = now()
  where status = 'processing'
    and locked_at < now() - interval '5 minutes';

  with candidate as (
    select j.id
    from llm_jobs j
    where j.status in ('pending', 'retry')
      and j.run_at <= now()
      and (
        j.partition_key is null
        or not exists (
          select 1
          from llm_jobs earlier
          where earlier.partition_key = j.partition_key
            and (
              earlier.status = 'processing'
              or (
                earlier.status in ('pending', 'retry')
                and earlier.run_at <= now()
              )
            )
            and (
              earlier.created_at < j.created_at
              or (earlier.created_at = j.created_at and earlier.id < j.id)
            )
        )
      )
      and (
        j.partition_key is null
        or not exists (
          select 1
          from llm_jobs active
          where active.partition_key = j.partition_key
            and active.status = 'processing'
        )
      )
    order by j.run_at, j.created_at
    for update of j skip locked
    limit 1
  )
  update llm_jobs j
  set status = 'processing',
      attempts = attempts + 1,
      locked_at = now(),
      locked_by = p_worker_id,
      updated_at = now()
  from candidate c
  where j.id = c.id
  returning j.* into v_row;

  if v_row.id is null then return null; end if;
  return to_jsonb(v_row);
end;
$$;

revoke all on function public.claim_llm_job(text) from public, anon, authenticated;
grant execute on function public.claim_llm_job(text) to service_role;
