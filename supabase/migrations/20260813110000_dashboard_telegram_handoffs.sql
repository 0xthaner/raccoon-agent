create table public.telegram_handoffs (
  code text primary key,
  wallet text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

create index telegram_handoffs_expires_at_idx on public.telegram_handoffs (expires_at);

alter table public.telegram_handoffs enable row level security;
revoke all on table public.telegram_handoffs from anon, authenticated;

comment on table public.telegram_handoffs is 'Single-use dashboard-to-Telegram handoffs for already verified wallets. Server-only.';

create or replace function public.consume_telegram_handoff(handoff_code text, telegram_chat_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_wallet text;
begin
  update public.telegram_handoffs
     set used_at = now()
   where code = handoff_code
     and used_at is null
     and expires_at > now()
  returning wallet into linked_wallet;

  if linked_wallet is null then
    return null;
  end if;

  insert into public.wallet_links (chat_id, wallet, linked_at, alerts_enabled)
  values (telegram_chat_id, lower(linked_wallet), now(), true)
  on conflict (chat_id) do update
    set wallet = excluded.wallet,
        linked_at = excluded.linked_at,
        alerts_enabled = true;

  return linked_wallet;
end;
$$;

revoke all on function public.consume_telegram_handoff(text, text) from public, anon, authenticated;
grant execute on function public.consume_telegram_handoff(text, text) to service_role;
