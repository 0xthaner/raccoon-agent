alter table public.cover_snapshots
  add column if not exists cover_asset_id integer,
  add column if not exists starts_at timestamptz,
  add column if not exists grace_ends_at timestamptz,
  add column if not exists original_cover_id text,
  add column if not exists latest_cover_id text,
  add column if not exists purchase_tx text,
  add column if not exists analysis_url text;

create table public.agent_events (
  id uuid primary key,
  chat_id text,
  wallet text,
  event_type text not null,
  source text not null check (source in ('telegram', 'dashboard', 'alert_worker', 'coverraccoon', 'system')),
  command text,
  cover_id text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index agent_events_chat_time_idx on public.agent_events (chat_id, occurred_at desc);
create index agent_events_wallet_time_idx on public.agent_events (lower(wallet), occurred_at desc) where wallet is not null;
create index agent_events_type_time_idx on public.agent_events (event_type, occurred_at desc);

create table public.telegram_deliveries (
  id uuid primary key,
  chat_id text not null,
  message_kind text not null,
  status text not null check (status in ('pending', 'sent', 'failed')),
  telegram_message_id text,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  attempted_at timestamptz not null default now(),
  completed_at timestamptz
);
create index telegram_deliveries_chat_time_idx on public.telegram_deliveries (chat_id, attempted_at desc);
create index telegram_deliveries_status_time_idx on public.telegram_deliveries (status, attempted_at desc);

create table public.renewal_attempts (
  id uuid primary key,
  wallet text not null,
  chat_id text,
  cover_id text not null,
  product_id integer,
  amount text,
  cover_asset_id integer,
  period_days integer,
  status text not null check (status in ('opened', 'quoted', 'approval_requested', 'approval_confirmed', 'purchase_requested', 'submitted', 'confirmed', 'failed', 'cancelled')),
  source text not null default 'coverraccoon',
  quote_max_premium text,
  quote_asset_symbol text,
  approval_tx_hash text,
  buy_tx_hash text,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index renewal_attempts_wallet_time_idx on public.renewal_attempts (lower(wallet), started_at desc);
create index renewal_attempts_cover_time_idx on public.renewal_attempts (cover_id, started_at desc);
create index renewal_attempts_chat_time_idx on public.renewal_attempts (chat_id, started_at desc) where chat_id is not null;
create unique index renewal_attempts_buy_tx_idx on public.renewal_attempts (lower(buy_tx_hash)) where buy_tx_hash is not null;

alter table public.agent_events enable row level security;
alter table public.telegram_deliveries enable row level security;
alter table public.renewal_attempts enable row level security;
revoke all on table public.agent_events from anon, authenticated;
revoke all on table public.telegram_deliveries from anon, authenticated;
revoke all on table public.renewal_attempts from anon, authenticated;

comment on table public.agent_events is 'Privacy-minimised command and lifecycle audit log. Server-only.';
comment on table public.telegram_deliveries is 'Telegram delivery outcomes without storing message bodies. Server-only.';
comment on table public.renewal_attempts is 'End-to-end Nexus renewal state, linked to Telegram by wallet where available. Server-only.';
