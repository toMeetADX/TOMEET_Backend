-- Restore worker access after the lease-aware RPC signatures were replaced.
grant execute on function public.heartbeat_llm_job(uuid, text) to service_role;
grant execute on function public.complete_llm_job(uuid, jsonb, text) to service_role;
grant execute on function public.fail_llm_job(uuid, text, text) to service_role;
