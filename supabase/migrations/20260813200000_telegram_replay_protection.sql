drop function if exists public.consume_dashboard_challenge(text, text);

create table public.telegram_updates (
  update_id bigint primary key,
  received_at timestamptz not null default now()
);
create index telegram_updates_received_idx on public.telegram_updates (received_at);
alter table public.telegram_updates enable row level security;
revoke all on table public.telegram_updates from anon, authenticated;
comment on table public.telegram_updates is 'Telegram webhook replay protection. Server-only; message contents are not stored.';
