create table public.monitored_wallets (
  chat_id text not null,
  wallet text not null,
  label text not null default 'Wallet',
  is_primary boolean not null default false,
  alerts_enabled boolean not null default true,
  alert_thresholds integer[] not null default array[30,14,7,3,1,0],
  weekly_summary boolean not null default false,
  linked_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (chat_id, wallet),
  constraint monitored_wallets_thresholds check (alert_thresholds <@ array[0,1,3,7,14,30])
);

create unique index monitored_wallets_one_primary_idx
  on public.monitored_wallets (chat_id) where is_primary;
create index monitored_wallets_wallet_idx on public.monitored_wallets (lower(wallet));

insert into public.monitored_wallets (chat_id, wallet, label, is_primary, alerts_enabled, linked_at)
select chat_id, lower(wallet), 'Main Wallet', true, alerts_enabled, linked_at
from public.wallet_links
on conflict (chat_id, wallet) do nothing;

create table public.alert_snoozes (
  chat_id text not null,
  wallet text not null,
  cover_id text not null,
  remind_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (chat_id, wallet, cover_id)
);
create index alert_snoozes_due_idx on public.alert_snoozes (remind_at);

create table public.cover_snapshots (
  chat_id text not null,
  wallet text not null,
  cover_id text not null,
  product_id text,
  product_name text,
  status text not null,
  amount text,
  asset_symbol text,
  ends_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (chat_id, wallet, cover_id)
);

create table public.weekly_summary_log (
  chat_id text primary key,
  sent_week text not null,
  sent_at timestamptz not null default now()
);

alter table public.monitored_wallets enable row level security;
alter table public.alert_snoozes enable row level security;
alter table public.cover_snapshots enable row level security;
alter table public.weekly_summary_log enable row level security;
revoke all on table public.monitored_wallets from anon, authenticated;
revoke all on table public.alert_snoozes from anon, authenticated;
revoke all on table public.cover_snapshots from anon, authenticated;
revoke all on table public.weekly_summary_log from anon, authenticated;

create or replace function public.consume_wallet_link(link_code text, linked_wallet text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_chat_id text;
  wallet_count integer;
begin
  update public.pending_links
     set used_at = now()
   where code = link_code and used_at is null and expires_at > now()
  returning chat_id into linked_chat_id;
  if linked_chat_id is null then return null; end if;

  select count(*) into wallet_count from public.monitored_wallets where chat_id = linked_chat_id;
  insert into public.monitored_wallets (chat_id, wallet, label, is_primary, alerts_enabled)
  values (linked_chat_id, lower(linked_wallet), case when wallet_count = 0 then 'Main Wallet' else 'Wallet ' || (wallet_count + 1) end, wallet_count = 0, true)
  on conflict (chat_id, wallet) do update set alerts_enabled = true, updated_at = now();

  insert into public.wallet_links (chat_id, wallet, linked_at, alerts_enabled)
  values (linked_chat_id, lower(linked_wallet), now(), true)
  on conflict (chat_id) do update set wallet = excluded.wallet, linked_at = excluded.linked_at, alerts_enabled = true;
  return linked_chat_id;
end;
$$;

create or replace function public.consume_telegram_handoff(handoff_code text, telegram_chat_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_wallet text;
  wallet_count integer;
begin
  update public.telegram_handoffs set used_at = now()
   where code = handoff_code and used_at is null and expires_at > now()
  returning wallet into linked_wallet;
  if linked_wallet is null then return null; end if;

  select count(*) into wallet_count from public.monitored_wallets where chat_id = telegram_chat_id;
  insert into public.monitored_wallets (chat_id, wallet, label, is_primary, alerts_enabled)
  values (telegram_chat_id, lower(linked_wallet), case when wallet_count = 0 then 'Main Wallet' else 'Wallet ' || (wallet_count + 1) end, wallet_count = 0, true)
  on conflict (chat_id, wallet) do update set alerts_enabled = true, updated_at = now();

  insert into public.wallet_links (chat_id, wallet, linked_at, alerts_enabled)
  values (telegram_chat_id, lower(linked_wallet), now(), true)
  on conflict (chat_id) do update set wallet = excluded.wallet, linked_at = excluded.linked_at, alerts_enabled = true;
  return linked_wallet;
end;
$$;

revoke all on function public.consume_wallet_link(text, text) from public, anon, authenticated;
revoke all on function public.consume_telegram_handoff(text, text) from public, anon, authenticated;
grant execute on function public.consume_wallet_link(text, text) to service_role;
grant execute on function public.consume_telegram_handoff(text, text) to service_role;
