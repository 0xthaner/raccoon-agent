-- Nexus P4I, 20.10.2026: dauerhafte, einmal nutzbare Ausfuehrungs-Sitzungen.
--
-- NUR LOKAL: diese Migration wird in P4I weder auf Produktion noch auf ein
-- gehostetes Projekt angewendet. Es gibt keinen Kaufpfad: keine Route, keine
-- Wallet-Methode, kein Senden, kein Signieren. Die Tabelle haelt die in P4H
-- gebildete Sitzung (src/purchase-execution-session.mjs) und macht ihre
-- Einmal-Nutzung durchsetzbar.
--
-- Sicherheitseigenschaften:
--   - die Sitzungsfakten (Intent, Hashes, Wallet, Kette, Art, Ziel, value, Bytes,
--     verifizierter Block und Block-Hash, Zeiten) sind nach dem INSERT
--     unveraenderlich (BEFORE-UPDATE-Trigger, auch fuer den Owner);
--   - Laufzeit hoechstens 30 s ab created_at (Datenbankuhr) und nie nach
--     build_deadline oder expires_at des Intents;
--   - hoechstens EINE offene (weder verbrauchte noch abgeloeste) Sitzung je Intent
--     (partieller UNIQUE-Index); eine abgelaufene, nie verbrauchte Sitzung wird
--     beim Anlegen der naechsten im selben Aufruf abgeloest (superseded_at) und ist
--     danach nie mehr nutzbar;
--   - je Intent und Transaktionsart hoechstens EINE verbrauchte Sitzung
--     (partieller UNIQUE-Index): eine neue Sitzung schafft keine zweite
--     Ausfuehrungsberechtigung fuer dieselbe Transaktion;
--   - Verbrauch genau einmal: EIN UPDATE ... WHERE consumed_at IS NULL AND
--     now() < expires_at ... RETURNING (Compare-and-Set); der Ablauf wird in SQL
--     geprueft, ohne Aufraeumlauf; genau an expires_at abgelehnt;
--   - beim Verbrauch muss der Intent weiterhin BUILT sein, ohne tx_hash und
--     cover_id, mit gleichem intent_hash, calldata_hash und gleicher Wallet, vor
--     build_deadline und expires_at; die Intent-Zeile ist dabei gesperrt
--     (FOR NO KEY UPDATE), kein Uebergang und kein anderes Anlegen oder
--     Verbrauchen fuer denselben Intent laeuft dazwischen;
--   - Idempotenz ueber consumer_request_id: dieselbe Anfrage erhaelt denselben
--     verbrauchten Datensatz zurueck (existing), jede andere ALREADY_CONSUMED;
--     consumed_at und consumer_request_id werden genau einmal gesetzt und nie
--     geloescht;
--   - kein DELETE und kein TRUNCATE: kein Recht, kein Helfer, und ein Trigger
--     lehnt beides ab.
--
-- Die Datenbank kann keinen keccak256 berechnen: den Sitzungs-Hash berechnet der
-- Server-Helfer (src/purchase-execution-session-db.mjs) aus den kanonischen
-- P4H-Feldern neu und prueft ihn beim Verbrauch erneut gegen die gespeicherte Zeile.
-- Die Datenbank prueft, was sie pruefen kann: Format, Ziel und Selector je Art,
-- value 0, Kette 1, Zeitfenster und die Bindung an die gespeicherte Intent-Zeile.
--
-- Zugriff: niemand liest oder schreibt die Tabelle direkt (auch service_role
-- nicht). service_role ruft genau zwei SECURITY-DEFINER-Funktionen mit festem
-- search_path und ohne dynamisches SQL. Gespeichert werden keine Schluessel,
-- keine Signaturen, keine Receipts, keine RPC-Antworten, keine IP, kein
-- User-Agent und keine freien Metadaten.

create table if not exists public.cover_purchase_execution_sessions (
	session_id uuid primary key,
	intent_id uuid not null references public.cover_purchase_intents (id),
	session_hash bytea not null check (octet_length(session_hash) = 32),
	intent_hash bytea not null check (octet_length(intent_hash) = 32),
	calldata_hash bytea not null check (octet_length(calldata_hash) = 32),
	wallet text not null check (wallet ~ '^0x[0-9a-f]{40}$'),
	chain_id integer not null check (chain_id = 1),
	transaction_kind text not null check (transaction_kind in ('USDC_APPROVAL', 'NEXUS_BUY_COVER')),
	target text not null check (target ~ '^0x[0-9a-f]{40}$'),
	value_raw numeric not null check (value_raw = 0),
	data bytea not null check (octet_length(data) between 4 and 4096),
	verified_block bigint not null check (verified_block > 0),
	verified_block_hash bytea not null check (octet_length(verified_block_hash) = 32),
	created_at timestamptz not null default now(),
	expires_at timestamptz not null,
	consumed_at timestamptz,
	consumer_request_id uuid,
	superseded_at timestamptz,
	constraint cover_purchase_execution_sessions_session_hash_key unique (session_hash),
	constraint cover_purchase_execution_sessions_window check (expires_at > created_at and expires_at <= created_at + interval '30 seconds'),
	-- Ziel und Selector je Art: USDC.approve an den Broker (genau 68 Bytes), CoverBroker.buyCover
	constraint cover_purchase_execution_sessions_target check (
		(transaction_kind = 'USDC_APPROVAL' and target = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' and substring(data from 1 for 4) = '\x095ea7b3'::bytea and octet_length(data) = 68)
		or (transaction_kind = 'NEXUS_BUY_COVER' and target = '0xcb2b736652d2dbf7d72e4db880cf6b7d99507814' and substring(data from 1 for 4) = '\x7c59cac4'::bytea)
	),
	constraint cover_purchase_execution_sessions_consumed check (
		(consumed_at is null) = (consumer_request_id is null)
		and (consumed_at is null or (consumed_at >= created_at and consumed_at < expires_at))
	),
	constraint cover_purchase_execution_sessions_superseded check (superseded_at is null or (consumed_at is null and superseded_at >= expires_at))
);

-- Hoechstens eine offene Sitzung je Intent.
create unique index if not exists cover_purchase_execution_sessions_one_open on public.cover_purchase_execution_sessions (intent_id) where consumed_at is null and superseded_at is null;
-- Hoechstens eine verbrauchte Sitzung je Intent und Transaktionsart.
create unique index if not exists cover_purchase_execution_sessions_one_consumed on public.cover_purchase_execution_sessions (intent_id, transaction_kind) where consumed_at is not null;

alter table public.cover_purchase_execution_sessions enable row level security;
revoke all on table public.cover_purchase_execution_sessions from public, anon, authenticated, service_role;

comment on table public.cover_purchase_execution_sessions is 'Nexus-Ausfuehrungs-Sitzungen (P4I). Unveraenderlich nach dem Anlegen, genau einmal verbrauchbar, nur ueber die cover_purchase_execution_session-Funktionen. Server-only. Kein Kaufpfad.';

/* ------------------------------------------------------------------ Trigger -- */

create or replace function public.cover_purchase_execution_sessions_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'cover_purchase_execution_sessions: rows are never deleted';
  end if;

  -- unveraenderlich nach dem INSERT
  if new.session_id is distinct from old.session_id then raise exception 'cover_purchase_execution_sessions: session_id is immutable'; end if;
  if new.intent_id is distinct from old.intent_id then raise exception 'cover_purchase_execution_sessions: intent_id is immutable'; end if;
  if new.session_hash is distinct from old.session_hash then raise exception 'cover_purchase_execution_sessions: session_hash is immutable'; end if;
  if new.intent_hash is distinct from old.intent_hash then raise exception 'cover_purchase_execution_sessions: intent_hash is immutable'; end if;
  if new.calldata_hash is distinct from old.calldata_hash then raise exception 'cover_purchase_execution_sessions: calldata_hash is immutable'; end if;
  if new.wallet is distinct from old.wallet then raise exception 'cover_purchase_execution_sessions: wallet is immutable'; end if;
  if new.chain_id is distinct from old.chain_id then raise exception 'cover_purchase_execution_sessions: chain_id is immutable'; end if;
  if new.transaction_kind is distinct from old.transaction_kind then raise exception 'cover_purchase_execution_sessions: transaction_kind is immutable'; end if;
  if new.target is distinct from old.target then raise exception 'cover_purchase_execution_sessions: target is immutable'; end if;
  if new.value_raw is distinct from old.value_raw then raise exception 'cover_purchase_execution_sessions: value_raw is immutable'; end if;
  if new.data is distinct from old.data then raise exception 'cover_purchase_execution_sessions: data is immutable'; end if;
  if new.verified_block is distinct from old.verified_block then raise exception 'cover_purchase_execution_sessions: verified_block is immutable'; end if;
  if new.verified_block_hash is distinct from old.verified_block_hash then raise exception 'cover_purchase_execution_sessions: verified_block_hash is immutable'; end if;
  if new.created_at is distinct from old.created_at then raise exception 'cover_purchase_execution_sessions: created_at is immutable'; end if;
  if new.expires_at is distinct from old.expires_at then raise exception 'cover_purchase_execution_sessions: expires_at is immutable'; end if;

  -- einmal gesetzt, nie geaendert oder geloescht
  if old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at then raise exception 'cover_purchase_execution_sessions: consumed_at is set once'; end if;
  if old.consumer_request_id is not null and new.consumer_request_id is distinct from old.consumer_request_id then raise exception 'cover_purchase_execution_sessions: consumer_request_id is set once'; end if;
  if old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at then raise exception 'cover_purchase_execution_sessions: superseded_at is set once'; end if;
  if old.superseded_at is not null and new.consumed_at is not null then raise exception 'cover_purchase_execution_sessions: a superseded session is never consumed'; end if;
  return new;
end;
$$;

drop trigger if exists cover_purchase_execution_sessions_guard on public.cover_purchase_execution_sessions;
create trigger cover_purchase_execution_sessions_guard
before update or delete on public.cover_purchase_execution_sessions
for each row execute function public.cover_purchase_execution_sessions_guard();

drop trigger if exists cover_purchase_execution_sessions_no_truncate on public.cover_purchase_execution_sessions;
create trigger cover_purchase_execution_sessions_no_truncate
before truncate on public.cover_purchase_execution_sessions
for each statement execute function public.cover_purchase_execution_sessions_guard();

revoke all on function public.cover_purchase_execution_sessions_guard() from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------- Helfer -- */

-- Die Sitzung als feste JSON-Antwort; nur von den Funktionen unten benutzt.
create or replace function public.cover_purchase_execution_session_json(s public.cover_purchase_execution_sessions)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'session_id', s.session_id, 'intent_id', s.intent_id,
    'session_hash', '0x' || encode(s.session_hash, 'hex'), 'intent_hash', '0x' || encode(s.intent_hash, 'hex'),
    'calldata_hash', '0x' || encode(s.calldata_hash, 'hex'), 'wallet', s.wallet, 'chain_id', s.chain_id,
    'transaction_kind', s.transaction_kind, 'target', s.target, 'value_raw', s.value_raw::text,
    'data', '0x' || encode(s.data, 'hex'), 'verified_block', s.verified_block::text,
    'verified_block_hash', '0x' || encode(s.verified_block_hash, 'hex'),
    'created_at', extract(epoch from s.created_at), 'expires_at', extract(epoch from s.expires_at)::bigint,
    'consumed_at', extract(epoch from s.consumed_at), 'consumer_request_id', s.consumer_request_id
  );
$$;

revoke all on function public.cover_purchase_execution_session_json(public.cover_purchase_execution_sessions) from public, anon, authenticated, service_role;

/* ---------------------------------------------------------------- Anlegen -- */

-- Legt die P4H-Sitzung an. Nur die kanonischen Felder, kein JSON, kein Status vom
-- Aufrufer; created_at setzt die Datenbank. Der Intent wird gesperrt (FOR NO KEY UPDATE) und
-- muss BUILT sein, ohne tx_hash und cover_id, mit genau diesen Hashes und dieser
-- Wallet; die Sitzung lebt hoechstens 30 s und nie ueber build_deadline oder
-- expires_at hinaus. Gleiche session_id mit gleichen Feldern ist idempotent.
create or replace function public.create_cover_purchase_execution_session(
  p_session_id uuid, p_intent_id uuid, p_session_hash text, p_intent_hash text, p_calldata_hash text,
  p_wallet text, p_chain_id integer, p_transaction_kind text, p_target text, p_value_raw numeric, p_data text,
  p_verified_block bigint, p_verified_block_hash text, p_expires_at bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  i public.cover_purchase_intents;
  saved public.cover_purchase_execution_sessions;
  shash bytea;
  ihash bytea;
  chash bytea;
  bhash bytea;
  tx bytea;
  exp timestamptz;
  cname text;
begin
  if p_session_id is null or p_intent_id is null or p_session_hash is null or p_intent_hash is null or p_calldata_hash is null
     or p_wallet is null or p_chain_id is null or p_transaction_kind is null or p_target is null or p_value_raw is null
     or p_data is null or p_verified_block is null or p_verified_block_hash is null or p_expires_at is null then
    return jsonb_build_object('status', 'rejected', 'code', 'INPUT');
  end if;
  if p_session_hash !~ '^0x[0-9a-f]{64}$' or p_intent_hash !~ '^0x[0-9a-f]{64}$' or p_calldata_hash !~ '^0x[0-9a-f]{64}$' or p_verified_block_hash !~ '^0x[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'rejected', 'code', 'HASH_FORMAT');
  end if;
  if p_wallet !~ '^0x[0-9a-f]{40}$' or p_target !~ '^0x[0-9a-f]{40}$' or p_data !~ '^0x([0-9a-f]{2})+$' then
    return jsonb_build_object('status', 'rejected', 'code', 'FORMAT');
  end if;
  if p_chain_id <> 1 or p_value_raw <> 0 or p_verified_block <= 0 or p_transaction_kind not in ('USDC_APPROVAL', 'NEXUS_BUY_COVER')
     or p_expires_at <= 0 or p_expires_at > 100000000000 then
    return jsonb_build_object('status', 'rejected', 'code', 'FIELD');
  end if;
  shash := decode(substr(p_session_hash, 3), 'hex');
  ihash := decode(substr(p_intent_hash, 3), 'hex');
  chash := decode(substr(p_calldata_hash, 3), 'hex');
  bhash := decode(substr(p_verified_block_hash, 3), 'hex');
  tx := decode(substr(p_data, 3), 'hex');
  exp := to_timestamp(p_expires_at);

  -- die Intent-Zeile, gesperrt gegen gleichzeitige Uebergaenge, Anlagen und Verbraeuche bis die Sitzung gespeichert ist
  select * into i from public.cover_purchase_intents x where x.id = p_intent_id for no key update;
  if not found then return jsonb_build_object('status', 'rejected', 'code', 'INTENT_NOT_FOUND'); end if;
  if i.wallet is distinct from p_wallet then return jsonb_build_object('status', 'rejected', 'code', 'WALLET_MISMATCH'); end if;
  if i.intent_hash is distinct from ihash then return jsonb_build_object('status', 'rejected', 'code', 'INTENT_HASH_MISMATCH'); end if;
  if i.calldata_hash is distinct from chash then return jsonb_build_object('status', 'rejected', 'code', 'CALLDATA_HASH_MISMATCH'); end if;
  if i.status <> 'BUILT' or i.tx_hash is not null or i.cover_id is not null then return jsonb_build_object('status', 'rejected', 'code', 'INTENT_NOT_BUILT'); end if;
  if now() >= i.build_deadline or now() >= i.expires_at then return jsonb_build_object('status', 'rejected', 'code', 'INTENT_WINDOW_CLOSED'); end if;
  if exp <= now() or exp > now() + interval '30 seconds' or exp > i.build_deadline or exp > i.expires_at then
    return jsonb_build_object('status', 'rejected', 'code', 'SESSION_WINDOW');
  end if;

  -- dieselbe session_id erneut: nur mit identischen Feldern idempotent
  select * into saved from public.cover_purchase_execution_sessions s where s.session_id = p_session_id;
  if found then
    if saved.intent_id = p_intent_id and saved.session_hash = shash and saved.intent_hash = ihash and saved.calldata_hash = chash
       and saved.wallet = p_wallet and saved.transaction_kind = p_transaction_kind and saved.target = p_target and saved.data = tx
       and saved.verified_block = p_verified_block and saved.verified_block_hash = bhash and saved.expires_at = exp then
      return jsonb_build_object('status', 'existing', 'session', public.cover_purchase_execution_session_json(saved));
    end if;
    return jsonb_build_object('status', 'conflict', 'code', 'SESSION_ID_REUSED');
  end if;

  if exists (select 1 from public.cover_purchase_execution_sessions s where s.intent_id = p_intent_id and s.transaction_kind = p_transaction_kind and s.consumed_at is not null) then
    return jsonb_build_object('status', 'conflict', 'code', 'KIND_ALREADY_CONSUMED');
  end if;

  -- eine abgelaufene, nie verbrauchte Sitzung dieses Intents wird abgeloest (danach nie mehr nutzbar)
  update public.cover_purchase_execution_sessions s
     set superseded_at = now()
   where s.intent_id = p_intent_id
     and s.consumed_at is null
     and s.superseded_at is null
     and s.expires_at <= now();

  begin
    insert into public.cover_purchase_execution_sessions (
      session_id, intent_id, session_hash, intent_hash, calldata_hash, wallet, chain_id, transaction_kind, target,
      value_raw, data, verified_block, verified_block_hash, created_at, expires_at)
    values (
      p_session_id, p_intent_id, shash, ihash, chash, p_wallet, p_chain_id, p_transaction_kind, p_target,
      p_value_raw, tx, p_verified_block, bhash, now(), exp)
    returning * into saved;
  exception
    when unique_violation then
      get stacked diagnostics cname = constraint_name;
      select * into saved from public.cover_purchase_execution_sessions s where s.session_id = p_session_id;
      if found then
        if saved.intent_id = p_intent_id and saved.session_hash = shash and saved.intent_hash = ihash and saved.calldata_hash = chash
           and saved.wallet = p_wallet and saved.transaction_kind = p_transaction_kind and saved.target = p_target and saved.data = tx
           and saved.verified_block = p_verified_block and saved.verified_block_hash = bhash and saved.expires_at = exp then
          return jsonb_build_object('status', 'existing', 'session', public.cover_purchase_execution_session_json(saved));
        end if;
        return jsonb_build_object('status', 'conflict', 'code', 'SESSION_ID_REUSED');
      end if;
      if cname = 'cover_purchase_execution_sessions_one_open' then return jsonb_build_object('status', 'conflict', 'code', 'OPEN_SESSION_EXISTS'); end if;
      if cname = 'cover_purchase_execution_sessions_session_hash_key' then return jsonb_build_object('status', 'conflict', 'code', 'SESSION_HASH_REUSED'); end if;
      raise;
    when check_violation then
      return jsonb_build_object('status', 'rejected', 'code', 'SESSION_CONSTRAINT');
  end;
  return jsonb_build_object('status', 'created', 'session', public.cover_purchase_execution_session_json(saved));
end;
$$;

/* -------------------------------------------------------------- Verbrauch -- */

-- Verbraucht die Sitzung genau einmal (Compare-and-Set). Eingaben nur die Kennungen:
-- session_id, der erwartete Sitzungs-Hash (serverseitig gehalten), intent_id und die
-- consumer_request_id der Anfrage. Dieselbe Anfrage erneut erhaelt denselben
-- verbrauchten Datensatz (existing), jede andere ALREADY_CONSUMED. Sendet nichts,
-- signiert nichts, baut keine Transaktion.
create or replace function public.consume_cover_purchase_execution_session(p_session_id uuid, p_session_hash text, p_intent_id uuid, p_consumer_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.cover_purchase_execution_sessions;
  shash bytea;
begin
  if p_session_id is null or p_intent_id is null or p_consumer_request_id is null or p_session_hash is null then
    return jsonb_build_object('status', 'rejected', 'code', 'INPUT');
  end if;
  if p_session_hash !~ '^0x[0-9a-f]{64}$' then return jsonb_build_object('status', 'rejected', 'code', 'HASH_FORMAT'); end if;
  shash := decode(substr(p_session_hash, 3), 'hex');

  -- die Intent-Zeile gesperrt: kein Uebergang und kein Anlegen zwischen dieser Pruefung und dem Verbrauch
  perform 1 from public.cover_purchase_intents x where x.id = p_intent_id for no key update;

  begin
    update public.cover_purchase_execution_sessions s
       set consumed_at = now(), consumer_request_id = p_consumer_request_id
     where s.session_id = p_session_id
       and s.session_hash = shash
       and s.intent_id = p_intent_id
       and s.consumed_at is null
       and s.superseded_at is null
       and now() < s.expires_at
       and exists (
         select 1 from public.cover_purchase_intents i
          where i.id = s.intent_id
            and i.status = 'BUILT'
            and i.tx_hash is null
            and i.cover_id is null
            and i.intent_hash = s.intent_hash
            and i.calldata_hash = s.calldata_hash
            and i.wallet = s.wallet
            and now() < i.build_deadline
            and now() < i.expires_at
       )
    returning * into saved;
  exception
    when unique_violation then
      return jsonb_build_object('status', 'conflict', 'code', 'KIND_ALREADY_CONSUMED');
  end;
  if saved.session_id is not null then return jsonb_build_object('status', 'consumed', 'session', public.cover_purchase_execution_session_json(saved)); end if;

  select * into saved from public.cover_purchase_execution_sessions s where s.session_id = p_session_id;
  if not found or saved.session_hash is distinct from shash or saved.intent_id is distinct from p_intent_id then
    return jsonb_build_object('status', 'rejected', 'code', 'SESSION_MISMATCH');
  end if;
  if saved.consumed_at is not null then
    if saved.consumer_request_id = p_consumer_request_id then
      return jsonb_build_object('status', 'existing', 'session', public.cover_purchase_execution_session_json(saved));
    end if;
    return jsonb_build_object('status', 'conflict', 'code', 'ALREADY_CONSUMED');
  end if;
  if saved.superseded_at is not null then return jsonb_build_object('status', 'rejected', 'code', 'SUPERSEDED'); end if;
  if now() >= saved.expires_at then return jsonb_build_object('status', 'rejected', 'code', 'EXPIRED'); end if;
  return jsonb_build_object('status', 'rejected', 'code', 'INTENT_NOT_ELIGIBLE');
end;
$$;

revoke all on function public.create_cover_purchase_execution_session(uuid, uuid, text, text, text, text, integer, text, text, numeric, text, bigint, text, bigint) from public, anon, authenticated;
revoke all on function public.consume_cover_purchase_execution_session(uuid, text, uuid, uuid) from public, anon, authenticated;

grant execute on function public.create_cover_purchase_execution_session(uuid, uuid, text, text, text, text, integer, text, text, numeric, text, bigint, text, bigint) to service_role;
grant execute on function public.consume_cover_purchase_execution_session(uuid, text, uuid, uuid) to service_role;

comment on function public.create_cover_purchase_execution_session(uuid, uuid, text, text, text, text, integer, text, text, numeric, text, bigint, text, bigint) is 'Nexus P4I: legt eine P4H-Ausfuehrungs-Sitzung an (hoechstens 30 s, eine offene je Intent). Nur service_role. Kein Kaufpfad.';
comment on function public.consume_cover_purchase_execution_session(uuid, text, uuid, uuid) is 'Nexus P4I: verbraucht eine Ausfuehrungs-Sitzung genau einmal (idempotent je consumer_request_id). Nur service_role. Sendet nichts.';
