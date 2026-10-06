-- HARD-002: reader-compatible wallet cutoffs, with no session registry.
-- Apply before deploying the RPC caller. Old writers must be drained before
-- claiming serialization guarantees; they do not acquire this advisory lock.
begin;

create function public.revoke_dashboard_sessions_atomic(revoke_wallet text, requested_cutoff bigint)
returns bigint
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  normalized text := lower(revoke_wallet);
  effective_cutoff bigint := requested_cutoff;
  stored record;
  parsed bigint;
begin
  if normalized is null or normalized !~ '^0x[0-9a-f]{40}$' then
    raise exception 'Invalid revocation wallet';
  end if;
  -- Positive integer epoch milliseconds, safely representable in JavaScript.
  -- Bound also keeps the retained timestamptz representable.
  if requested_cutoff is null or requested_cutoff < 1 or requested_cutoff > 8640000000000000 then
    raise exception 'Invalid revocation cutoff';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('dashboard-revoke:' || normalized, 0));
  for stored in
    select nonce from public.pending_links
    where chat_id = 'revoked:' || normalized for update
  loop
    if stored.nonce !~ '^[0-9]{1,16}$' then
      raise exception 'Malformed stored revocation cutoff';
    end if;
    parsed := stored.nonce::bigint;
    if parsed < 1 or parsed > 8640000000000000 then
      raise exception 'Malformed stored revocation cutoff';
    end if;
    effective_cutoff := greatest(effective_cutoff, parsed);
  end loop;

  -- Validation precedes mutations. Function errors roll back every mutation.
  delete from public.pending_links where chat_id = 'revoked:' || normalized;
  insert into public.pending_links (code, chat_id, nonce, expires_at)
  values ('revoked_wallet_' || normalized, 'revoked:' || normalized,
          effective_cutoff::text,
          to_timestamp(effective_cutoff::double precision / 1000) + interval '3650 days');
  delete from public.pending_links
  where chat_id like 'dashboard:%' and nonce = normalized;
  return effective_cutoff;
end;
$$;

revoke all on function public.revoke_dashboard_sessions_atomic(text, bigint) from public, anon, authenticated;
grant execute on function public.revoke_dashboard_sessions_atomic(text, bigint) to service_role;

commit;
