create or replace function public.consume_dashboard_challenge(challenge_nonce text, challenge_wallet text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare consumed_nonce text;
begin
  update public.dashboard_challenges as challenge
     set used_at = now()
   where challenge.nonce = challenge_nonce
     and lower(challenge.wallet) = lower(challenge_wallet)
     and challenge.used_at is null
     and challenge.expires_at > now()
  returning challenge.nonce into consumed_nonce;
  return consumed_nonce is not null;
end;
$$;
revoke all on function public.consume_dashboard_challenge(text, text) from public, anon, authenticated;
grant execute on function public.consume_dashboard_challenge(text, text) to service_role;
