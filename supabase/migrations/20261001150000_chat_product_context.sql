-- Das zuletzt besprochene Nexus-Produkt je privatem Telegram-Chat.
--
-- Der Bot laeuft serverlos; jede Nachricht ist ein frischer Aufruf ohne
-- Gedaechtnis. Auf "Was kostet Cover fuer Aave?" folgte "Und was ist da
-- versichert?", und der Bot wusste nicht mehr, was "da" ist. Gespeichert wird
-- nur, WELCHES Produkt gerade Thema ist: Chat-ID, Nexus-Produkt-IDs, Zeit.
-- Kein Nachrichtentext, keine Wallet. Gelesen wird nur, was juenger als 15
-- Minuten ist; aeltere Zeilen raeumt der Bot beim Schreiben selbst weg.

create table if not exists public.chat_product_context (
	chat_id text primary key,
	product_ids integer[] not null check (cardinality(product_ids) between 1 and 5),
	updated_at timestamptz not null default now()
);

alter table public.chat_product_context enable row level security;
revoke all on table public.chat_product_context from public, anon, authenticated;
grant select, insert, update, delete on table public.chat_product_context to service_role;

comment on table public.chat_product_context is 'Zuletzt besprochenes Nexus-Produkt je privatem Telegram-Chat, fuer Rueckfragen. Gilt 15 Minuten. Server-only.';
