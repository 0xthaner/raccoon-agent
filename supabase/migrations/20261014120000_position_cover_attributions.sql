-- Vom Nutzer bestaetigte Zuordnung "erkannte DeFi-Position <-> oeffentliches
-- Nexus Cover" (14.10.2026).
--
-- Eine Zeile sagt NUR: der angemeldete Wallet-Inhaber hat bestaetigt, dass
-- CoverRaccoon dieses oeffentliche Nexus Cover mit diesem erkannten Aave-v3-Markt
-- verknuepfen soll. Sie ist KEIN Nachweis einer Deckung, keine von Nexus
-- gepruefte Angabe, keine Aussage ueber einen Claim oder eine Auszahlung, und sie
-- sagt nichts ueber die privaten Proof-of-Loss-Daten bei Nexus aus.
--
-- Gespeichert werden nur Bezeichner: Wallet, Markt, Produkt-ID, Cover-ID, Quelle
-- und Zeitpunkte. Kein Betrag, kein Guthaben, keine Adresse aus einer Proof of
-- Loss, keine Signatur, keine Nexus-Metadaten. Automatische 1:1-Zuordnungen
-- werden NICHT gespeichert; sie entstehen jedes Mal neu aus oeffentlichen Daten.
--
-- Schreiben und Lesen nur ueber den Server (service_role) nach serverseitiger
-- Pruefung von Sitzung, Position und Cover. Der Browser hat keinen Zugriff.
--
-- Aufbewahrung: bis der Nutzer die Zuordnung entfernt, oder bis sie nachweislich
-- veraltet ist (Cover abgelaufen/nicht mehr in der Wallet, Position weg, Markt
-- nicht mehr unterstuetzt) - dann loescht der Server sie beim naechsten Abgleich.
-- Spaetestens 400 Tage nach der letzten Bestaetigung loescht die taegliche
-- Bereinigung sie: ein Nexus Cover laeuft hoechstens 365 Tage plus Grace Period,
-- danach kann die Zuordnung nicht mehr aktuell sein.

create table if not exists public.position_cover_attributions (
	id uuid primary key default gen_random_uuid(),
	wallet text not null check (wallet ~ '^0x[0-9a-f]{40}$'),
	protocol_key text not null check (protocol_key = 'aave'),
	protocol_version text not null check (protocol_version = 'v3'),
	-- Genau die geprueften Maerkte aus src/positions/aave-registry.mjs.
	deployment_key text not null check (deployment_key in ('aave-v3-ethereum-core', 'aave-v3-ethereum-lido', 'aave-v3-ethereum-etherfi')),
	-- Kanonische Nexus-Produkt-ID fuer Aave v3.
	product_id integer not null check (product_id = 97),
	cover_id bigint not null check (cover_id > 0),
	source text not null default 'user_confirmed' check (source = 'user_confirmed'),
	confirmed_at timestamptz not null default now(),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint position_cover_attributions_relation_key unique (wallet, deployment_key, cover_id)
);

-- Die Eindeutigkeit (wallet, deployment_key, cover_id) dient zugleich als Index
-- fuer "alle Zeilen einer Wallet". Bewusst NICHT eindeutig: cover_id je Wallet
-- (ein Cover darf mehreren Maerkten zugeordnet werden) und deployment_key je
-- Wallet (ein Markt darf mehrere Covers haben).
create index if not exists position_cover_attributions_wallet_product_idx on public.position_cover_attributions (wallet, product_id);
create index if not exists position_cover_attributions_wallet_cover_idx on public.position_cover_attributions (wallet, cover_id);
create index if not exists position_cover_attributions_confirmed_at_idx on public.position_cover_attributions (confirmed_at);

alter table public.position_cover_attributions enable row level security;
revoke all on table public.position_cover_attributions from public, anon, authenticated;
grant select, insert, update, delete on table public.position_cover_attributions to service_role;

comment on table public.position_cover_attributions is 'Vom Wallet-Inhaber bestaetigte Zuordnung erkannter DeFi-Markt <-> oeffentliches Nexus Cover. Kein Deckungsnachweis, keine Nexus-Metadaten. Server-only.';
