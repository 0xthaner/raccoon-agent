create table public.dashboard_challenges (
  nonce text primary key,
  wallet text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);
create index dashboard_challenges_expiry_idx on public.dashboard_challenges (expires_at);
alter table public.dashboard_challenges enable row level security;
revoke all on table public.dashboard_challenges from anon, authenticated;

create or replace function public.consume_dashboard_challenge(challenge_nonce text, challenge_wallet text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare consumed text;
begin
  update public.dashboard_challenges
     set used_at = now()
   where nonce = challenge_nonce
     and wallet = lower(challenge_wallet)
     and used_at is null
     and expires_at > now()
  returning nonce into consumed;
  return consumed is not null;
end;
$$;
revoke all on function public.consume_dashboard_challenge(text, text) from public, anon, authenticated;
grant execute on function public.consume_dashboard_challenge(text, text) to service_role;

create table public.api_rate_limits (
  key_hash text not null,
  bucket_start timestamptz not null,
  requests integer not null default 1,
  primary key (key_hash, bucket_start)
);
create index api_rate_limits_expiry_idx on public.api_rate_limits (bucket_start);
alter table public.api_rate_limits enable row level security;
revoke all on table public.api_rate_limits from anon, authenticated;

create or replace function public.check_agent_rate_limit(rate_key text, window_seconds integer, max_requests integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  bucket timestamptz;
  current_requests integer;
begin
  if window_seconds < 1 or max_requests < 1 or length(rate_key) > 200 then return false; end if;
  bucket := to_timestamp(floor(extract(epoch from now()) / window_seconds) * window_seconds);
  insert into public.api_rate_limits (key_hash, bucket_start, requests)
  values (rate_key, bucket, 1)
  on conflict (key_hash, bucket_start) do update
    set requests = public.api_rate_limits.requests + 1
  returning requests into current_requests;
  delete from public.api_rate_limits where bucket_start < now() - interval '1 day';
  return current_requests <= max_requests;
end;
$$;
revoke all on function public.check_agent_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.check_agent_rate_limit(text, integer, integer) to service_role;

comment on table public.dashboard_challenges is 'Single-use wallet login nonces. Server-only.';
comment on table public.api_rate_limits is 'Pseudonymous fixed-window API abuse counters. Server-only.';
