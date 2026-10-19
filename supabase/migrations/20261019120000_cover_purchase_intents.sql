-- Nexus P4D, 19.10.2026: Kauf-Intents dauerhaft, unveraenderlich, einmal nutzbar.
--
-- NUR LOKAL: diese Migration wird in P4D weder auf Produktion noch auf ein
-- gehostetes Projekt angewendet. Es gibt keinen Kaufpfad: keine Route, keine
-- Wallet-Methode, kein Senden. Die Tabelle haelt den in P4A definierten Intent
-- (Hash nach P4A, vom Server berechnet) und die spaeteren, bereits anderswo
-- geprueften Fakten (Build, Einreichung, Bestaetigung).
--
-- Sicherheitseigenschaften (CR-PURCHASE-003 P5, CR-PURCHASE-005 P5-P11):
--   - alle sicherheitskritischen Felder sind nach dem INSERT unveraenderlich
--     (BEFORE-UPDATE-Trigger); einmal gesetzte Werte (calldata_hash, built_at,
--     build_deadline, tx_hash, tx_nonce, cover_id) werden nie geaendert oder
--     geloescht; late nur false -> true;
--   - hoechstens ein aktiver Intent (OPEN/BUILT/SUBMITTED) je Wallet (partieller
--     UNIQUE-Index); Idempotenz ueber (wallet, client_request_id), gleicher
--     Schluessel mit anderen Daten wird abgelehnt;
--   - genau ein Build, genau eine Einreichung: jeder Uebergang ist EIN
--     UPDATE ... WHERE <Erwartung> RETURNING (Compare-and-Set), kein Netz, keine
--     lange Transaktion;
--   - tx_hash und cover_id global eindeutig;
--   - OPEN/BUILT sind nur vor expires_at nutzbar, BUILT nur vor build_deadline
--     (beide Grenzen exklusiv: nutzbar nur bei now() < Grenze). Die Korrektheit
--     haengt an keinem Aufraeumlauf; SUBMITTED laeuft nie ab;
--   - FAILED -> CONFIRMED nur ueber den eigenen Spaet-Bestaetigungsweg (gleiche
--     tx_hash, gleiche calldata_hash, late = true). EXPIRED und CANCELLED werden
--     nie wieder geoeffnet;
--   - kein DELETE: kein Recht, kein Helfer, und ein Trigger lehnt es ab.
--
-- Zugriff: anon/authenticated nichts. service_role liest die Tabelle und ruft die
-- acht Funktionen; Schreiben nur ueber diese SECURITY-DEFINER-Funktionen mit
-- festem search_path und ohne dynamisches SQL. Gespeichert werden keine IP, kein
-- User-Agent, keine Proof-of-Loss-Inhalte, keine Signaturen, kein Quote-JSON.

create table if not exists public.cover_purchase_intents (
	id uuid primary key,
	wallet text not null check (wallet ~ '^0x[0-9a-f]{40}$'),
	chain_id integer not null check (chain_id = 1),
	deployment_key text not null check (deployment_key = 'aave-v3-ethereum-core'),
	product_id integer not null check (product_id = 97),
	product_type_id integer not null check (product_type_id = 0),
	cover_asset_id smallint not null check (cover_asset_id = 6),
	-- uint96 wie BuyCoverParams.amount
	amount_raw numeric not null check (amount_raw > 0 and amount_raw = trunc(amount_raw) and amount_raw <= 79228162514264337593543950335),
	period_days smallint not null check (period_days between 28 and 365),
	quote_premium_raw numeric not null check (quote_premium_raw > 0 and quote_premium_raw = trunc(quote_premium_raw) and quote_premium_raw <= 115792089237316195423570985008687907853269984665640564039457584007913129639935),
	max_premium_raw numeric not null check (max_premium_raw >= quote_premium_raw and max_premium_raw = trunc(max_premium_raw) and max_premium_raw <= 115792089237316195423570985008687907853269984665640564039457584007913129639935),
	quote_fetched_at timestamptz not null,
	capacity_fetched_at timestamptz not null,
	wording_cid text not null check (wording_cid = 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY'),
	annex_cid text check (annex_cid is null),
	terms_version text not null check (terms_version = 'coverraccoon.terms/1'),
	terms_hash bytea not null check (octet_length(terms_hash) = 32),
	proof_of_loss_cid text check (proof_of_loss_cid is null or proof_of_loss_cid ~ '^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58})$'),
	commission_ratio smallint not null check (commission_ratio = 0),
	commission_destination text not null check (commission_destination = '0x0000000000000000000000000000000000000000'),
	pin_version text not null check (pin_version = 'nexus-pin-1:broker-v2.12.1:cover-v3.3.0'),
	intent_hash bytea not null check (octet_length(intent_hash) = 32),
	acknowledged_at timestamptz not null,
	expires_at timestamptz not null,
	status text not null default 'OPEN' check (status in ('OPEN', 'BUILT', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED')),
	-- nur feste Codes, vom Server gesetzt; kein Freitext, keine Fehlermeldung
	status_reason text check (status_reason is null or status_reason in ('INTENT_EXPIRED', 'BUILD_DEADLINE_PASSED', 'USER_CANCELLED', 'PIN_DRIFT', 'QUOTE_STALE', 'TX_REVERTED', 'TX_DROPPED', 'TX_REPLACED', 'LATE_CONFIRMATION')),
	calldata_hash bytea check (calldata_hash is null or octet_length(calldata_hash) = 32),
	built_at timestamptz,
	build_deadline timestamptz,
	tx_hash text check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$'),
	tx_nonce bigint check (tx_nonce is null or tx_nonce >= 0),
	late boolean not null default false,
	cover_id bigint check (cover_id is null or cover_id > 0),
	client_request_id uuid not null,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint cover_purchase_intents_intent_hash_key unique (intent_hash),
	constraint cover_purchase_intents_tx_hash_key unique (tx_hash),
	constraint cover_purchase_intents_cover_id_key unique (cover_id),
	constraint cover_purchase_intents_request_key unique (wallet, client_request_id),
	-- P4A-Zeitregeln, nicht weiter: Quote/Kapazitaet hoechstens 60 s vor der Bestaetigung, Lebensdauer hoechstens 15 min
	constraint cover_purchase_intents_timing check (
		quote_fetched_at <= acknowledged_at and acknowledged_at - quote_fetched_at <= interval '60 seconds'
		and capacity_fetched_at <= acknowledged_at and acknowledged_at - capacity_fetched_at <= interval '60 seconds'
		and expires_at > acknowledged_at and expires_at - acknowledged_at <= interval '15 minutes'
		and expires_at > created_at and expires_at <= created_at + interval '15 minutes'
	),
	constraint cover_purchase_intents_build check (
		(calldata_hash is null) = (built_at is null) and (built_at is null) = (build_deadline is null)
		and (build_deadline is null or (build_deadline > built_at and build_deadline <= built_at + interval '120 seconds' and build_deadline <= expires_at))
	),
	constraint cover_purchase_intents_tx check ((tx_hash is null) = (tx_nonce is null) and (tx_hash is null or calldata_hash is not null)),
	constraint cover_purchase_intents_state check (
		(status = 'OPEN' and calldata_hash is null and tx_hash is null and cover_id is null and status_reason is null and not late)
		or (status = 'BUILT' and calldata_hash is not null and tx_hash is null and cover_id is null and status_reason is null and not late)
		or (status = 'SUBMITTED' and tx_hash is not null and cover_id is null and status_reason is null and not late)
		or (status = 'CONFIRMED' and tx_hash is not null and cover_id is not null and ((not late and status_reason is null) or (late and status_reason = 'LATE_CONFIRMATION')))
		or (status = 'FAILED' and tx_hash is not null and cover_id is null and status_reason in ('TX_REVERTED', 'TX_DROPPED', 'TX_REPLACED') and not late)
		or (status = 'EXPIRED' and tx_hash is null and cover_id is null and status_reason in ('INTENT_EXPIRED', 'BUILD_DEADLINE_PASSED') and not late)
		or (status = 'CANCELLED' and tx_hash is null and cover_id is null and status_reason in ('USER_CANCELLED', 'PIN_DRIFT', 'QUOTE_STALE') and not late)
	)
);

-- Hoechstens ein aktiver Intent je Wallet. SUBMITTED zaehlt mit: die Transaktion kann noch gemined werden.
create unique index if not exists cover_purchase_intents_one_active on public.cover_purchase_intents (wallet) where status in ('OPEN', 'BUILT', 'SUBMITTED');
create index if not exists cover_purchase_intents_wallet_created_idx on public.cover_purchase_intents (wallet, created_at);

alter table public.cover_purchase_intents enable row level security;
revoke all on table public.cover_purchase_intents from public, anon, authenticated, service_role;
-- Lesen fuer den Server (SUBMITTED bleibt nach Ablauf beobachtbar); Schreiben nur ueber die Funktionen unten.
grant select on table public.cover_purchase_intents to service_role;

comment on table public.cover_purchase_intents is 'Nexus-Kauf-Intents (P4D). Unveraenderlich nach dem Anlegen, Uebergaenge nur ueber die cover_purchase_intent-Funktionen. Server-only. Kein Kaufpfad.';

/* ------------------------------------------------------------------ Trigger -- */

create or replace function public.cover_purchase_intents_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'cover_purchase_intents: rows are never deleted';
  end if;

  -- unveraenderlich nach dem INSERT
  if new.id is distinct from old.id then raise exception 'cover_purchase_intents: id is immutable'; end if;
  if new.wallet is distinct from old.wallet then raise exception 'cover_purchase_intents: wallet is immutable'; end if;
  if new.chain_id is distinct from old.chain_id then raise exception 'cover_purchase_intents: chain_id is immutable'; end if;
  if new.deployment_key is distinct from old.deployment_key then raise exception 'cover_purchase_intents: deployment_key is immutable'; end if;
  if new.product_id is distinct from old.product_id then raise exception 'cover_purchase_intents: product_id is immutable'; end if;
  if new.product_type_id is distinct from old.product_type_id then raise exception 'cover_purchase_intents: product_type_id is immutable'; end if;
  if new.cover_asset_id is distinct from old.cover_asset_id then raise exception 'cover_purchase_intents: cover_asset_id is immutable'; end if;
  if new.amount_raw is distinct from old.amount_raw then raise exception 'cover_purchase_intents: amount_raw is immutable'; end if;
  if new.period_days is distinct from old.period_days then raise exception 'cover_purchase_intents: period_days is immutable'; end if;
  if new.quote_premium_raw is distinct from old.quote_premium_raw then raise exception 'cover_purchase_intents: quote_premium_raw is immutable'; end if;
  if new.max_premium_raw is distinct from old.max_premium_raw then raise exception 'cover_purchase_intents: max_premium_raw is immutable'; end if;
  if new.quote_fetched_at is distinct from old.quote_fetched_at then raise exception 'cover_purchase_intents: quote_fetched_at is immutable'; end if;
  if new.capacity_fetched_at is distinct from old.capacity_fetched_at then raise exception 'cover_purchase_intents: capacity_fetched_at is immutable'; end if;
  if new.wording_cid is distinct from old.wording_cid then raise exception 'cover_purchase_intents: wording_cid is immutable'; end if;
  if new.annex_cid is distinct from old.annex_cid then raise exception 'cover_purchase_intents: annex_cid is immutable'; end if;
  if new.terms_version is distinct from old.terms_version then raise exception 'cover_purchase_intents: terms_version is immutable'; end if;
  if new.terms_hash is distinct from old.terms_hash then raise exception 'cover_purchase_intents: terms_hash is immutable'; end if;
  if new.proof_of_loss_cid is distinct from old.proof_of_loss_cid then raise exception 'cover_purchase_intents: proof_of_loss_cid is immutable'; end if;
  if new.commission_ratio is distinct from old.commission_ratio then raise exception 'cover_purchase_intents: commission_ratio is immutable'; end if;
  if new.commission_destination is distinct from old.commission_destination then raise exception 'cover_purchase_intents: commission_destination is immutable'; end if;
  if new.pin_version is distinct from old.pin_version then raise exception 'cover_purchase_intents: pin_version is immutable'; end if;
  if new.intent_hash is distinct from old.intent_hash then raise exception 'cover_purchase_intents: intent_hash is immutable'; end if;
  if new.acknowledged_at is distinct from old.acknowledged_at then raise exception 'cover_purchase_intents: acknowledged_at is immutable'; end if;
  if new.expires_at is distinct from old.expires_at then raise exception 'cover_purchase_intents: expires_at is immutable'; end if;
  if new.client_request_id is distinct from old.client_request_id then raise exception 'cover_purchase_intents: client_request_id is immutable'; end if;
  if new.created_at is distinct from old.created_at then raise exception 'cover_purchase_intents: created_at is immutable'; end if;

  -- einmal gesetzt, nie geaendert oder geloescht
  if old.calldata_hash is not null and new.calldata_hash is distinct from old.calldata_hash then raise exception 'cover_purchase_intents: calldata_hash is set once'; end if;
  if old.built_at is not null and new.built_at is distinct from old.built_at then raise exception 'cover_purchase_intents: built_at is set once'; end if;
  if old.build_deadline is not null and new.build_deadline is distinct from old.build_deadline then raise exception 'cover_purchase_intents: build_deadline is set once'; end if;
  if old.tx_hash is not null and new.tx_hash is distinct from old.tx_hash then raise exception 'cover_purchase_intents: tx_hash is set once'; end if;
  if old.tx_nonce is not null and new.tx_nonce is distinct from old.tx_nonce then raise exception 'cover_purchase_intents: tx_nonce is set once'; end if;
  if old.cover_id is not null and new.cover_id is distinct from old.cover_id then raise exception 'cover_purchase_intents: cover_id is set once'; end if;
  if old.late and not new.late then raise exception 'cover_purchase_intents: late is never cleared'; end if;

  -- Uebergaenge wie P4A (canTransition), dazu nur der Spaet-Bestaetigungsweg FAILED -> CONFIRMED mit late
  if new.status is distinct from old.status then
    if not (
      (old.status = 'OPEN' and new.status in ('BUILT', 'EXPIRED', 'CANCELLED'))
      or (old.status = 'BUILT' and new.status in ('SUBMITTED', 'EXPIRED', 'CANCELLED'))
      or (old.status = 'SUBMITTED' and new.status in ('CONFIRMED', 'FAILED'))
      or (old.status = 'FAILED' and new.status = 'CONFIRMED' and new.late and not old.late)
    ) then
      raise exception 'cover_purchase_intents: illegal transition % -> %', old.status, new.status;
    end if;
  elsif new.status_reason is distinct from old.status_reason or new.late is distinct from old.late then
    raise exception 'cover_purchase_intents: reason or late flag changed without a transition';
  end if;
  if new.late and not old.late and not (old.status = 'FAILED' and new.status = 'CONFIRMED') then
    raise exception 'cover_purchase_intents: late is set only by FAILED -> CONFIRMED';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cover_purchase_intents_guard on public.cover_purchase_intents;
create trigger cover_purchase_intents_guard
before update or delete on public.cover_purchase_intents
for each row execute function public.cover_purchase_intents_guard();

revoke all on function public.cover_purchase_intents_guard() from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------- Helfer -- */

-- Antwortform; keine Rechte fuer irgendeine Rolle, nur von den Funktionen unten genutzt.
create or replace function public.cover_purchase_intent_json(i public.cover_purchase_intents)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', i.id, 'wallet', i.wallet, 'status', i.status, 'status_reason', i.status_reason,
    'intent_hash', '0x' || encode(i.intent_hash, 'hex'),
    'calldata_hash', case when i.calldata_hash is null then null else '0x' || encode(i.calldata_hash, 'hex') end,
    'built_at', i.built_at, 'build_deadline', i.build_deadline, 'tx_hash', i.tx_hash, 'tx_nonce', i.tx_nonce,
    'cover_id', i.cover_id, 'late', i.late, 'expires_at', i.expires_at, 'created_at', i.created_at
  );
$$;

revoke all on function public.cover_purchase_intent_json(public.cover_purchase_intents) from public, anon, authenticated, service_role;

/* ---------------------------------------------------------------- Anlegen -- */

create or replace function public.create_cover_purchase_intent(
  p_id uuid,
  p_wallet text,
  p_chain_id integer,
  p_deployment_key text,
  p_product_id integer,
  p_product_type_id integer,
  p_cover_asset_id smallint,
  p_amount_raw numeric,
  p_period_days smallint,
  p_quote_premium_raw numeric,
  p_max_premium_raw numeric,
  p_quote_fetched_at timestamptz,
  p_capacity_fetched_at timestamptz,
  p_wording_cid text,
  p_annex_cid text,
  p_terms_version text,
  p_terms_hash text,
  p_proof_of_loss_cid text,
  p_commission_ratio smallint,
  p_commission_destination text,
  p_pin_version text,
  p_intent_hash text,
  p_acknowledged_at timestamptz,
  p_expires_at timestamptz,
  p_client_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.cover_purchase_intents;
  terms bytea;
  ihash bytea;
begin
  if p_terms_hash is null or p_terms_hash !~ '^0x[0-9a-f]{64}$' or p_intent_hash is null or p_intent_hash !~ '^0x[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'rejected', 'code', 'HASH_FORMAT');
  end if;
  terms := decode(substr(p_terms_hash, 3), 'hex');
  ihash := decode(substr(p_intent_hash, 3), 'hex');

  -- Abgelaufene OPEN/BUILT dieser Wallet zuerst schliessen; die Korrektheit haengt an keinem Aufraeumlauf.
  update public.cover_purchase_intents i
     set status = 'EXPIRED',
         status_reason = case when i.status = 'BUILT' and i.expires_at > now() then 'BUILD_DEADLINE_PASSED' else 'INTENT_EXPIRED' end
   where i.wallet = p_wallet
     and ((i.status = 'OPEN' and i.expires_at <= now()) or (i.status = 'BUILT' and (i.expires_at <= now() or i.build_deadline <= now())));

  begin
    insert into public.cover_purchase_intents as i (
      id, wallet, chain_id, deployment_key, product_id, product_type_id, cover_asset_id, amount_raw, period_days,
      quote_premium_raw, max_premium_raw, quote_fetched_at, capacity_fetched_at, wording_cid, annex_cid, terms_version,
      terms_hash, proof_of_loss_cid, commission_ratio, commission_destination, pin_version, intent_hash, acknowledged_at,
      expires_at, status, late, client_request_id, created_at, updated_at
    ) values (
      p_id, p_wallet, p_chain_id, p_deployment_key, p_product_id, p_product_type_id, p_cover_asset_id, p_amount_raw, p_period_days,
      p_quote_premium_raw, p_max_premium_raw, p_quote_fetched_at, p_capacity_fetched_at, p_wording_cid, p_annex_cid, p_terms_version,
      terms, p_proof_of_loss_cid, p_commission_ratio, p_commission_destination, p_pin_version, ihash, p_acknowledged_at,
      p_expires_at, 'OPEN', false, p_client_request_id, now(), now()
    )
    on conflict do nothing
    returning * into saved;
  exception when check_violation or not_null_violation then
    return jsonb_build_object('status', 'rejected', 'code', 'INVALID_INTENT');
  end;
  if saved.id is not null then
    return jsonb_build_object('status', 'created', 'intent', public.cover_purchase_intent_json(saved));
  end if;

  -- Idempotenz: derselbe Schluessel liefert denselben Intent - nur bei exakt denselben kanonischen Daten.
  select * into saved from public.cover_purchase_intents i where i.wallet = p_wallet and i.client_request_id = p_client_request_id;
  if found then
    if (saved.id, saved.chain_id, saved.deployment_key, saved.product_id, saved.product_type_id, saved.cover_asset_id, saved.amount_raw,
        saved.period_days, saved.quote_premium_raw, saved.max_premium_raw, saved.quote_fetched_at, saved.capacity_fetched_at,
        saved.wording_cid, saved.annex_cid, saved.terms_version, saved.terms_hash, saved.proof_of_loss_cid, saved.commission_ratio,
        saved.commission_destination, saved.pin_version, saved.intent_hash, saved.acknowledged_at, saved.expires_at)
       is not distinct from
       (p_id, p_chain_id, p_deployment_key, p_product_id, p_product_type_id, p_cover_asset_id, p_amount_raw,
        p_period_days, p_quote_premium_raw, p_max_premium_raw, p_quote_fetched_at, p_capacity_fetched_at,
        p_wording_cid, p_annex_cid, p_terms_version, terms, p_proof_of_loss_cid, p_commission_ratio,
        p_commission_destination, p_pin_version, ihash, p_acknowledged_at, p_expires_at) then
      return jsonb_build_object('status', 'existing', 'intent', public.cover_purchase_intent_json(saved));
    end if;
    return jsonb_build_object('status', 'conflict', 'code', 'IDEMPOTENCY_KEY_REUSED');
  end if;
  if exists (select 1 from public.cover_purchase_intents i where i.id = p_id or i.intent_hash = ihash) then
    return jsonb_build_object('status', 'conflict', 'code', 'INTENT_ID_TAKEN');
  end if;
  return jsonb_build_object('status', 'conflict', 'code', 'ACTIVE_INTENT_EXISTS');
end;
$$;

/* -------------------------------------------------------------- Uebergaenge -- */

-- OPEN -> BUILT, genau einmal. Zeiten vom Datenbankserver; build_deadline = built_at + 120 s und nie nach expires_at.
create or replace function public.mark_cover_purchase_intent_built(p_id uuid, p_wallet text, p_intent_hash text, p_calldata_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.cover_purchase_intents;
  ihash bytea;
  chash bytea;
begin
  if p_intent_hash is null or p_intent_hash !~ '^0x[0-9a-f]{64}$' or p_calldata_hash is null or p_calldata_hash !~ '^0x[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'rejected', 'code', 'HASH_FORMAT');
  end if;
  ihash := decode(substr(p_intent_hash, 3), 'hex');
  chash := decode(substr(p_calldata_hash, 3), 'hex');

  update public.cover_purchase_intents i
     set status = 'BUILT', calldata_hash = chash, built_at = now(), build_deadline = now() + interval '120 seconds', updated_at = now()
   where i.id = p_id
     and i.wallet = p_wallet
     and i.intent_hash = ihash
     and i.status = 'OPEN'
     and i.calldata_hash is null
     and i.built_at is null
     and now() < i.expires_at
     and now() + interval '120 seconds' <= i.expires_at
  returning * into saved;
  if found then return jsonb_build_object('status', 'built', 'intent', public.cover_purchase_intent_json(saved)); end if;

  select * into saved from public.cover_purchase_intents i where i.id = p_id;
  if not found or saved.wallet is distinct from p_wallet then return jsonb_build_object('status', 'rejected', 'code', 'NOT_FOUND'); end if;
  if saved.intent_hash is distinct from ihash then return jsonb_build_object('status', 'rejected', 'code', 'INTENT_HASH_MISMATCH'); end if;
  if saved.status = 'BUILT' and saved.calldata_hash = chash then return jsonb_build_object('status', 'existing', 'intent', public.cover_purchase_intent_json(saved)); end if;
  if saved.status not in ('OPEN', 'BUILT') then return jsonb_build_object('status', 'conflict', 'code', 'NOT_OPEN'); end if;
  if saved.calldata_hash is not null then return jsonb_build_object('status', 'conflict', 'code', 'CALLDATA_ALREADY_SET'); end if;
  if saved.status <> 'OPEN' then return jsonb_build_object('status', 'conflict', 'code', 'NOT_OPEN'); end if;
  if now() >= saved.expires_at then return jsonb_build_object('status', 'rejected', 'code', 'EXPIRED'); end if;
  return jsonb_build_object('status', 'rejected', 'code', 'BUILD_WINDOW_TOO_SHORT');
end;
$$;

-- BUILT -> SUBMITTED, genau ein tx_hash; derselbe tx_hash erneut ist idempotent.
create or replace function public.mark_cover_purchase_intent_submitted(p_id uuid, p_wallet text, p_calldata_hash text, p_tx_hash text, p_tx_nonce bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.cover_purchase_intents;
  chash bytea;
begin
  if p_calldata_hash is null or p_calldata_hash !~ '^0x[0-9a-f]{64}$' or p_tx_hash is null or p_tx_hash !~ '^0x[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'rejected', 'code', 'HASH_FORMAT');
  end if;
  if p_tx_nonce is null or p_tx_nonce < 0 then return jsonb_build_object('status', 'rejected', 'code', 'TX_NONCE'); end if;
  chash := decode(substr(p_calldata_hash, 3), 'hex');

  begin
    update public.cover_purchase_intents i
       set status = 'SUBMITTED', tx_hash = p_tx_hash, tx_nonce = p_tx_nonce, updated_at = now()
     where i.id = p_id
       and i.wallet = p_wallet
       and i.status = 'BUILT'
       and i.calldata_hash = chash
       and i.tx_hash is null
       and now() < i.build_deadline
       and now() < i.expires_at
    returning * into saved;
  exception when unique_violation then
    return jsonb_build_object('status', 'conflict', 'code', 'TX_HASH_TAKEN');
  end;
  if saved.id is not null then return jsonb_build_object('status', 'submitted', 'intent', public.cover_purchase_intent_json(saved)); end if;

  select * into saved from public.cover_purchase_intents i where i.id = p_id;
  if not found or saved.wallet is distinct from p_wallet then return jsonb_build_object('status', 'rejected', 'code', 'NOT_FOUND'); end if;
  if saved.calldata_hash is distinct from chash then return jsonb_build_object('status', 'rejected', 'code', 'CALLDATA_MISMATCH'); end if;
  if saved.tx_hash = p_tx_hash and saved.tx_nonce = p_tx_nonce then return jsonb_build_object('status', 'existing', 'intent', public.cover_purchase_intent_json(saved)); end if;
  if saved.tx_hash is not null then return jsonb_build_object('status', 'conflict', 'code', 'TX_HASH_ALREADY_SET'); end if;
  if saved.status <> 'BUILT' then return jsonb_build_object('status', 'conflict', 'code', 'NOT_BUILT'); end if;
  if now() >= saved.expires_at then return jsonb_build_object('status', 'rejected', 'code', 'EXPIRED'); end if;
  return jsonb_build_object('status', 'rejected', 'code', 'BUILD_DEADLINE_PASSED');
end;
$$;

-- SUBMITTED -> CONFIRMED mit einer bereits anderswo geprueften Cover-ID. Prueft keine Kette.
create or replace function public.mark_cover_purchase_intent_confirmed(p_id uuid, p_tx_hash text, p_cover_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.cover_purchase_intents;
begin
  if p_tx_hash is null or p_tx_hash !~ '^0x[0-9a-f]{64}$' then return jsonb_build_object('status', 'rejected', 'code', 'HASH_FORMAT'); end if;
  if p_cover_id is null or p_cover_id <= 0 then return jsonb_build_object('status', 'rejected', 'code', 'COVER_ID'); end if;

  begin
    update public.cover_purchase_intents i
       set status = 'CONFIRMED', cover_id = p_cover_id, updated_at = now()
     where i.id = p_id
       and i.status = 'SUBMITTED'
       and i.tx_hash = p_tx_hash
       and i.cover_id is null
    returning * into saved;
  exception when unique_violation then
    return jsonb_build_object('status', 'conflict', 'code', 'COVER_ID_TAKEN');
  end;
  if saved.id is not null then return jsonb_build_object('status', 'confirmed', 'intent', public.cover_purchase_intent_json(saved)); end if;

  select * into saved from public.cover_purchase_intents i where i.id = p_id;
  if not found then return jsonb_build_object('status', 'rejected', 'code', 'NOT_FOUND'); end if;
  if saved.tx_hash is distinct from p_tx_hash then return jsonb_build_object('status', 'rejected', 'code', 'TX_HASH_MISMATCH'); end if;
  if saved.status = 'CONFIRMED' and saved.cover_id = p_cover_id then return jsonb_build_object('status', 'existing', 'intent', public.cover_purchase_intent_json(saved)); end if;
  if saved.status = 'CONFIRMED' then return jsonb_build_object('status', 'conflict', 'code', 'COVER_ID_MISMATCH'); end if;
  return jsonb_build_object('status', 'conflict', 'code', 'NOT_SUBMITTED');
end;
$$;

-- SUBMITTED -> FAILED. Beweist NICHT, dass die signierte Transaktion nie gemined wird; tx_hash, tx_nonce, calldata_hash bleiben.
create or replace function public.mark_cover_purchase_intent_failed(p_id uuid, p_tx_hash text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.cover_purchase_intents;
begin
  if p_tx_hash is null or p_tx_hash !~ '^0x[0-9a-f]{64}$' then return jsonb_build_object('status', 'rejected', 'code', 'HASH_FORMAT'); end if;
  if p_reason is null or p_reason not in ('TX_REVERTED', 'TX_DROPPED', 'TX_REPLACED') then return jsonb_build_object('status', 'rejected', 'code', 'REASON'); end if;

  update public.cover_purchase_intents i
     set status = 'FAILED', status_reason = p_reason, updated_at = now()
   where i.id = p_id
     and i.status = 'SUBMITTED'
     and i.tx_hash = p_tx_hash
  returning * into saved;
  if found then return jsonb_build_object('status', 'failed', 'intent', public.cover_purchase_intent_json(saved)); end if;

  select * into saved from public.cover_purchase_intents i where i.id = p_id;
  if not found then return jsonb_build_object('status', 'rejected', 'code', 'NOT_FOUND'); end if;
  if saved.tx_hash is distinct from p_tx_hash then return jsonb_build_object('status', 'rejected', 'code', 'TX_HASH_MISMATCH'); end if;
  if saved.status = 'FAILED' and saved.status_reason = p_reason then return jsonb_build_object('status', 'existing', 'intent', public.cover_purchase_intent_json(saved)); end if;
  return jsonb_build_object('status', 'conflict', 'code', 'NOT_SUBMITTED');
end;
$$;

-- FAILED -> CONFIRMED nur fuer einen spaeter unabhaengig nachgewiesenen Erfolg DERSELBEN Transaktion:
-- gleiche tx_hash, unveraenderte calldata_hash, gueltige und eindeutige cover_id, late = true.
-- EXPIRED und CANCELLED haben nie eine eingereichte Transaktion und werden nie geoeffnet.
create or replace function public.mark_cover_purchase_intent_late_confirmed(p_id uuid, p_tx_hash text, p_calldata_hash text, p_cover_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.cover_purchase_intents;
  chash bytea;
begin
  if p_tx_hash is null or p_tx_hash !~ '^0x[0-9a-f]{64}$' or p_calldata_hash is null or p_calldata_hash !~ '^0x[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'rejected', 'code', 'HASH_FORMAT');
  end if;
  if p_cover_id is null or p_cover_id <= 0 then return jsonb_build_object('status', 'rejected', 'code', 'COVER_ID'); end if;
  chash := decode(substr(p_calldata_hash, 3), 'hex');

  begin
    update public.cover_purchase_intents i
       set status = 'CONFIRMED', cover_id = p_cover_id, late = true, status_reason = 'LATE_CONFIRMATION', updated_at = now()
     where i.id = p_id
       and i.status = 'FAILED'
       and i.tx_hash = p_tx_hash
       and i.calldata_hash = chash
       and i.cover_id is null
       and not i.late
    returning * into saved;
  exception when unique_violation then
    return jsonb_build_object('status', 'conflict', 'code', 'COVER_ID_TAKEN');
  end;
  if saved.id is not null then return jsonb_build_object('status', 'confirmed', 'intent', public.cover_purchase_intent_json(saved)); end if;

  select * into saved from public.cover_purchase_intents i where i.id = p_id;
  if not found then return jsonb_build_object('status', 'rejected', 'code', 'NOT_FOUND'); end if;
  if saved.tx_hash is distinct from p_tx_hash then return jsonb_build_object('status', 'rejected', 'code', 'TX_HASH_MISMATCH'); end if;
  if saved.calldata_hash is distinct from chash then return jsonb_build_object('status', 'rejected', 'code', 'CALLDATA_MISMATCH'); end if;
  if saved.status = 'CONFIRMED' and saved.late and saved.cover_id = p_cover_id then return jsonb_build_object('status', 'existing', 'intent', public.cover_purchase_intent_json(saved)); end if;
  return jsonb_build_object('status', 'conflict', 'code', 'NOT_FAILED');
end;
$$;

-- OPEN/BUILT -> CANCELLED. Widerruft keine bereits signierte Transaktion ausserhalb der Datenbank; calldata_hash und built_at bleiben.
create or replace function public.cancel_cover_purchase_intent(p_id uuid, p_wallet text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.cover_purchase_intents;
begin
  if p_reason is null or p_reason not in ('USER_CANCELLED', 'PIN_DRIFT', 'QUOTE_STALE') then return jsonb_build_object('status', 'rejected', 'code', 'REASON'); end if;

  update public.cover_purchase_intents i
     set status = 'CANCELLED', status_reason = p_reason, updated_at = now()
   where i.id = p_id
     and i.wallet = p_wallet
     and i.status in ('OPEN', 'BUILT')
  returning * into saved;
  if found then return jsonb_build_object('status', 'cancelled', 'intent', public.cover_purchase_intent_json(saved)); end if;

  select * into saved from public.cover_purchase_intents i where i.id = p_id;
  if not found or saved.wallet is distinct from p_wallet then return jsonb_build_object('status', 'rejected', 'code', 'NOT_FOUND'); end if;
  if saved.status = 'CANCELLED' then return jsonb_build_object('status', 'existing', 'intent', public.cover_purchase_intent_json(saved)); end if;
  return jsonb_build_object('status', 'conflict', 'code', 'NOT_CANCELLABLE');
end;
$$;

-- Optionales Aufraeumen OPEN/BUILT -> EXPIRED. Keine Sicherheitseigenschaft haengt daran.
create or replace function public.expire_cover_purchase_intent(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.cover_purchase_intents;
begin
  update public.cover_purchase_intents i
     set status = 'EXPIRED',
         status_reason = case when i.status = 'BUILT' and i.expires_at > now() then 'BUILD_DEADLINE_PASSED' else 'INTENT_EXPIRED' end,
         updated_at = now()
   where i.id = p_id
     and ((i.status = 'OPEN' and i.expires_at <= now()) or (i.status = 'BUILT' and (i.expires_at <= now() or i.build_deadline <= now())))
  returning * into saved;
  if found then return jsonb_build_object('status', 'expired', 'intent', public.cover_purchase_intent_json(saved)); end if;

  select * into saved from public.cover_purchase_intents i where i.id = p_id;
  if not found then return jsonb_build_object('status', 'rejected', 'code', 'NOT_FOUND'); end if;
  if saved.status = 'EXPIRED' then return jsonb_build_object('status', 'existing', 'intent', public.cover_purchase_intent_json(saved)); end if;
  if saved.status in ('OPEN', 'BUILT') then return jsonb_build_object('status', 'rejected', 'code', 'NOT_EXPIRED'); end if;
  return jsonb_build_object('status', 'conflict', 'code', 'NOT_EXPIRABLE');
end;
$$;

revoke all on function public.create_cover_purchase_intent(uuid, text, integer, text, integer, integer, smallint, numeric, smallint, numeric, numeric, timestamptz, timestamptz, text, text, text, text, text, smallint, text, text, text, timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.mark_cover_purchase_intent_built(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.mark_cover_purchase_intent_submitted(uuid, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.mark_cover_purchase_intent_confirmed(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.mark_cover_purchase_intent_failed(uuid, text, text) from public, anon, authenticated;
revoke all on function public.mark_cover_purchase_intent_late_confirmed(uuid, text, text, bigint) from public, anon, authenticated;
revoke all on function public.cancel_cover_purchase_intent(uuid, text, text) from public, anon, authenticated;
revoke all on function public.expire_cover_purchase_intent(uuid) from public, anon, authenticated;

grant execute on function public.create_cover_purchase_intent(uuid, text, integer, text, integer, integer, smallint, numeric, smallint, numeric, numeric, timestamptz, timestamptz, text, text, text, text, text, smallint, text, text, text, timestamptz, timestamptz, uuid) to service_role;
grant execute on function public.mark_cover_purchase_intent_built(uuid, text, text, text) to service_role;
grant execute on function public.mark_cover_purchase_intent_submitted(uuid, text, text, text, bigint) to service_role;
grant execute on function public.mark_cover_purchase_intent_confirmed(uuid, text, bigint) to service_role;
grant execute on function public.mark_cover_purchase_intent_failed(uuid, text, text) to service_role;
grant execute on function public.mark_cover_purchase_intent_late_confirmed(uuid, text, text, bigint) to service_role;
grant execute on function public.cancel_cover_purchase_intent(uuid, text, text) to service_role;
grant execute on function public.expire_cover_purchase_intent(uuid) to service_role;
