create table public.pending_links (
  code text primary key,
  chat_id text not null,
  nonce text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

create index pending_links_chat_id_idx on public.pending_links (chat_id);
create index pending_links_expires_at_idx on public.pending_links (expires_at);

create table public.wallet_links (
  chat_id text primary key,
  wallet text not null,
  linked_at timestamptz not null default now(),
  alerts_enabled boolean not null default true
);

create index wallet_links_wallet_idx on public.wallet_links (lower(wallet));

create table public.user_preferences (
  chat_id text primary key,
  language text not null check (language in ('de', 'en', 'zh')),
  updated_at timestamptz not null default now()
);

create table public.sent_alerts (
  chat_id text not null,
  cover_id text not null,
  ends_at timestamptz not null,
  threshold_days integer not null check (threshold_days in (0, 1, 3, 7, 14, 30)),
  sent_at timestamptz not null default now(),
  primary key (chat_id, cover_id, ends_at, threshold_days)
);

alter table public.pending_links enable row level security;
alter table public.wallet_links enable row level security;
alter table public.user_preferences enable row level security;
alter table public.sent_alerts enable row level security;

revoke all on table public.pending_links from anon, authenticated;
revoke all on table public.wallet_links from anon, authenticated;
revoke all on table public.user_preferences from anon, authenticated;
revoke all on table public.sent_alerts from anon, authenticated;

comment on table public.pending_links is 'Short-lived Telegram-to-wallet linking challenges. Server-only.';
comment on table public.wallet_links is 'Verified Telegram chat to wallet mappings. Server-only.';
comment on table public.user_preferences is 'Telegram user language preferences. Server-only.';
comment on table public.sent_alerts is 'Idempotency ledger for expiry notifications. Server-only.';
