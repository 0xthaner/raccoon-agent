-- Nexus P4J, 20.10.2026: dauerhafte Ausfuehrungsversuche nach dem Verbrauch einer
-- P4I-Sitzung - das Protokoll zwischen "Sitzung verbraucht" und "P4D SUBMITTED".
--
-- NUR LOKAL: diese Migration wird in P4J weder auf Produktion noch auf ein
-- gehostetes Projekt angewendet. Es gibt keinen Kaufpfad: keine Route, keine
-- Wallet-Methode, kein Senden, kein Signieren. Die Tabelle haelt nur, was ein
-- spaeterer Wallet-Schritt ueber seinen Versuch weiss; der Wallet-Aufruf selbst
-- existiert nicht.
--
-- Begriffe (bewusst kein "exactly once"):
--   - Datenbank-Berechtigung: hoechstens ein Verbrauch je Sitzung (P4I) und
--     hoechstens EIN Versuch je verbrauchter Sitzung (UNIQUE session_id);
--   - Wallet-Aufruf: hoechstens einer je Versuch, soweit durchsetzbar: der
--     Wallet-Schritt darf die Wallet nur rufen, nachdem er den Uebergang
--     AUTHORIZED -> WALLET_REQUEST_STARTED als einziger Gewinner des
--     Compare-and-Set selbst geschrieben hat (Write-ahead). Wer ihn nicht gewinnt,
--     ruft die Wallet nicht;
--   - Transaktion auf der Kette: bestimmt allein durch tx_hash, Nonce und Receipt.
--     Was die Wallet oder der Provider nach dem Start tut, kann die Datenbank weder
--     sehen noch verhindern; deshalb gibt es UNCERTAIN und keinen blinden Neustart.
--
-- Zustaende (aus den Fehlerfaellen abgeleitet, siehe src/purchase-execution-protocol.mjs):
--   AUTHORIZED              Sitzung verbraucht, Versuch angelegt, noch KEIN Wallet-Aufruf
--   WALLET_REQUEST_STARTED  Write-ahead geschrieben; ab hier kann eine Transaktion existieren
--   UNCERTAIN               Wallet/Provider ohne eindeutiges Ergebnis (Timeout, Netzfehler)
--   ABORTED_NO_TX           ausdrueckliche Ablehnung der Wallet vor jedem tx_hash, oder
--                           Abgleich mit der Kette ohne Treffer nach der Ruhezeit
--   TX_HASH_OBSERVED        tx_hash an Versuch, Sitzung, Intent und Art gebunden
--   SUBMITTED               nur buyCover: P4D BUILT -> SUBMITTED mit genau diesem tx_hash
--   APPROVAL_VERIFIED       nur Freigabe: Allowance unabhaengig nachgeprueft
--   APPROVAL_FAILED         nur Freigabe: Receipt ohne die geforderte Allowance
--
-- Sperren (nur in dieser Tabelle; P4D- und P4I-Tabellen, -Trigger und -Funktionen bleiben unveraendert):
--   - je Wallet hoechstens EIN Versuch in WALLET_REQUEST_STARTED, UNCERTAIN oder
--     TX_HASH_OBSERVED (partieller UNIQUE-Index): solange eine Transaktion
--     unterwegs sein kann, startet fuer diese Wallet kein weiterer Wallet-Aufruf -
--     auch nicht ueber einen neuen Intent, nachdem der alte abgelaufen oder
--     abgebrochen ist;
--   - der Kauf-Intent wird nur ueber submit_cover_purchase_execution_attempt und nur
--     mit dem an einen buyCover-Versuch gebundenen tx_hash SUBMITTED; ein
--     Freigabe-Hash wird nie zum Kauf-Hash;
--   - ein buyCover-Versuch nach einer verbrauchten Freigabe-Sitzung entsteht nur,
--     wenn der Freigabe-Versuch APPROVAL_VERIFIED ist und die buyCover-Sitzung an
--     einem Block ab dieser Pruefung verifiziert wurde (frische Vorpruefung); ein
--     Freigabe-Versuch nach einer verbrauchten buyCover-Sitzung entsteht nie.
--
-- Zugriff: niemand liest oder schreibt die Tabelle direkt (auch service_role
-- nicht). service_role ruft genau acht SECURITY-DEFINER-Funktionen mit festem
-- search_path und ohne dynamisches SQL. Gespeichert werden keine Schluessel,
-- keine Signaturen, keine Provider-Objekte, keine Tokens, keine IP, kein
-- User-Agent und keine freien Metadaten; nur Kennungen, Zustand, tx_hash und
-- Block-/Nonce-Nachweise.

create table if not exists public.cover_purchase_execution_attempts (
	attempt_id uuid primary key,
	-- session_id ohne Fremdschluessel: er wuerde das TRUNCATE-Verbot der Sitzungen (P4I-Trigger) durch einen
	-- anderen Fehler ersetzen; die Bindung setzt allein open_cover_purchase_execution_attempt aus der gesperrten Sitzung.
	session_id uuid not null,
	intent_id uuid not null references public.cover_purchase_intents (id),
	wallet text not null check (wallet ~ '^0x[0-9a-f]{40}$'),
	transaction_kind text not null check (transaction_kind in ('USDC_APPROVAL', 'NEXUS_BUY_COVER')),
	consumer_request_id uuid not null,
	state text not null check (state in ('AUTHORIZED', 'WALLET_REQUEST_STARTED', 'UNCERTAIN', 'ABORTED_NO_TX', 'TX_HASH_OBSERVED', 'SUBMITTED', 'APPROVAL_VERIFIED', 'APPROVAL_FAILED')),
	abort_reason text check (abort_reason is null or abort_reason in ('WALLET_REJECTED', 'RECONCILED_NO_TX')),
	tx_hash text check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$'),
	tx_hash_source text check (tx_hash_source is null or tx_hash_source in ('WALLET_RESPONSE', 'CHAIN_RECONCILIATION')),
	reconciled_to_block bigint check (reconciled_to_block is null or reconciled_to_block > 0),
	reconciled_wallet_nonce bigint check (reconciled_wallet_nonce is null or reconciled_wallet_nonce >= 0),
	approval_verified_block bigint check (approval_verified_block is null or approval_verified_block > 0),
	approval_allowance_raw numeric check (approval_allowance_raw is null or (approval_allowance_raw >= 0 and approval_allowance_raw = trunc(approval_allowance_raw))),
	created_at timestamptz not null default now(),
	wallet_request_started_at timestamptz,
	settled_at timestamptz,
	updated_at timestamptz not null default now(),
	-- ein Versuch je verbrauchter Sitzung; ein tx_hash gehoert hoechstens einem Versuch
	constraint cover_purchase_execution_attempts_one_per_session unique (session_id),
	constraint cover_purchase_execution_attempts_tx_hash_key unique (tx_hash),
	constraint cover_purchase_execution_attempts_shape check (
		(tx_hash is null) = (tx_hash_source is null)
		and (wallet_request_started_at is null or wallet_request_started_at >= created_at)
		and (state <> 'AUTHORIZED' or (wallet_request_started_at is null and tx_hash is null and abort_reason is null and settled_at is null))
		and (state <> 'WALLET_REQUEST_STARTED' or (wallet_request_started_at is not null and tx_hash is null and abort_reason is null and settled_at is null))
		and (state <> 'UNCERTAIN' or (wallet_request_started_at is not null and tx_hash is null and abort_reason is null and settled_at is null))
		and (state <> 'ABORTED_NO_TX' or (wallet_request_started_at is not null and tx_hash is null and abort_reason is not null and settled_at is not null
			and (abort_reason <> 'RECONCILED_NO_TX' or (reconciled_to_block is not null and reconciled_wallet_nonce is not null))))
		and (state <> 'TX_HASH_OBSERVED' or (wallet_request_started_at is not null and tx_hash is not null and abort_reason is null and settled_at is null))
		and (state <> 'SUBMITTED' or (transaction_kind = 'NEXUS_BUY_COVER' and tx_hash is not null and settled_at is not null))
		and (state <> 'APPROVAL_VERIFIED' or (transaction_kind = 'USDC_APPROVAL' and tx_hash is not null and settled_at is not null and approval_verified_block is not null and approval_allowance_raw is not null))
		and (state <> 'APPROVAL_FAILED' or (transaction_kind = 'USDC_APPROVAL' and tx_hash is not null and settled_at is not null))
		and (abort_reason is null or state = 'ABORTED_NO_TX')
		and ((approval_verified_block is null) = (approval_allowance_raw is null))
		and (approval_verified_block is null or state = 'APPROVAL_VERIFIED')
	)
);

create index if not exists cover_purchase_execution_attempts_intent_idx on public.cover_purchase_execution_attempts (intent_id);
-- Je Wallet hoechstens ein Versuch, bei dem eine Transaktion unterwegs sein kann.
create unique index if not exists cover_purchase_execution_attempts_wallet_busy on public.cover_purchase_execution_attempts (wallet) where state in ('WALLET_REQUEST_STARTED', 'UNCERTAIN', 'TX_HASH_OBSERVED');

alter table public.cover_purchase_execution_attempts enable row level security;
revoke all on table public.cover_purchase_execution_attempts from public, anon, authenticated, service_role;

comment on table public.cover_purchase_execution_attempts is 'Nexus-Ausfuehrungsversuche (P4J). Ein Versuch je verbrauchter Sitzung, Uebergaenge nur vorwaerts ueber die cover_purchase_execution_attempt-Funktionen. Server-only. Kein Kaufpfad, kein Wallet-Aufruf.';

/* ------------------------------------------------------------------ Trigger -- */

create or replace function public.cover_purchase_execution_attempts_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'cover_purchase_execution_attempts: rows are never deleted';
  end if;

  -- unveraenderlich nach dem INSERT
  if new.attempt_id is distinct from old.attempt_id then raise exception 'cover_purchase_execution_attempts: attempt_id is immutable'; end if;
  if new.session_id is distinct from old.session_id then raise exception 'cover_purchase_execution_attempts: session_id is immutable'; end if;
  if new.intent_id is distinct from old.intent_id then raise exception 'cover_purchase_execution_attempts: intent_id is immutable'; end if;
  if new.wallet is distinct from old.wallet then raise exception 'cover_purchase_execution_attempts: wallet is immutable'; end if;
  if new.transaction_kind is distinct from old.transaction_kind then raise exception 'cover_purchase_execution_attempts: transaction_kind is immutable'; end if;
  if new.consumer_request_id is distinct from old.consumer_request_id then raise exception 'cover_purchase_execution_attempts: consumer_request_id is immutable'; end if;
  if new.created_at is distinct from old.created_at then raise exception 'cover_purchase_execution_attempts: created_at is immutable'; end if;

  -- einmal gesetzt, nie geaendert oder geloescht
  if old.tx_hash is not null and new.tx_hash is distinct from old.tx_hash then raise exception 'cover_purchase_execution_attempts: tx_hash is set once'; end if;
  if old.tx_hash_source is not null and new.tx_hash_source is distinct from old.tx_hash_source then raise exception 'cover_purchase_execution_attempts: tx_hash_source is set once'; end if;
  if old.wallet_request_started_at is not null and new.wallet_request_started_at is distinct from old.wallet_request_started_at then raise exception 'cover_purchase_execution_attempts: wallet_request_started_at is set once'; end if;
  if old.abort_reason is not null and new.abort_reason is distinct from old.abort_reason then raise exception 'cover_purchase_execution_attempts: abort_reason is set once'; end if;
  if old.settled_at is not null and new.settled_at is distinct from old.settled_at then raise exception 'cover_purchase_execution_attempts: settled_at is set once'; end if;

  -- nur vorwaerts; nie zurueck in einen Zustand, der einen neuen Wallet-Aufruf erlauben wuerde
  if new.state is distinct from old.state then
    if not (
      (old.state = 'AUTHORIZED' and new.state = 'WALLET_REQUEST_STARTED')
      or (old.state = 'WALLET_REQUEST_STARTED' and new.state in ('UNCERTAIN', 'ABORTED_NO_TX', 'TX_HASH_OBSERVED'))
      or (old.state = 'UNCERTAIN' and new.state in ('ABORTED_NO_TX', 'TX_HASH_OBSERVED'))
      or (old.state = 'TX_HASH_OBSERVED' and new.state in ('SUBMITTED', 'APPROVAL_VERIFIED', 'APPROVAL_FAILED'))
    ) then
      raise exception 'cover_purchase_execution_attempts: illegal transition % -> %', old.state, new.state;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cover_purchase_execution_attempts_guard on public.cover_purchase_execution_attempts;
create trigger cover_purchase_execution_attempts_guard
before update or delete on public.cover_purchase_execution_attempts
for each row execute function public.cover_purchase_execution_attempts_guard();

drop trigger if exists cover_purchase_execution_attempts_no_truncate on public.cover_purchase_execution_attempts;
create trigger cover_purchase_execution_attempts_no_truncate
before truncate on public.cover_purchase_execution_attempts
for each statement execute function public.cover_purchase_execution_attempts_guard();

revoke all on function public.cover_purchase_execution_attempts_guard() from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------- Helfer -- */

create or replace function public.cover_purchase_execution_attempt_json(a public.cover_purchase_execution_attempts)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'attempt_id', a.attempt_id, 'session_id', a.session_id, 'intent_id', a.intent_id, 'wallet', a.wallet, 'transaction_kind', a.transaction_kind,
    'consumer_request_id', a.consumer_request_id, 'state', a.state, 'abort_reason', a.abort_reason, 'tx_hash', a.tx_hash,
    'tx_hash_source', a.tx_hash_source, 'approval_verified_block', a.approval_verified_block::text,
    'created_at', extract(epoch from a.created_at), 'wallet_request_started_at', extract(epoch from a.wallet_request_started_at),
    'settled_at', extract(epoch from a.settled_at)
  );
$$;

revoke all on function public.cover_purchase_execution_attempt_json(public.cover_purchase_execution_attempts) from public, anon, authenticated, service_role;

/* ---------------------------------------------------------------- Anlegen -- */

-- Ein Versuch je verbrauchter Sitzung. Nur die Anfrage, die die Sitzung verbraucht hat
-- (consumer_request_id), legt ihn an; dieselbe Anfrage erneut erhaelt denselben Versuch.
create or replace function public.open_cover_purchase_execution_attempt(p_attempt_id uuid, p_session_id uuid, p_consumer_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.cover_purchase_execution_sessions;
  saved public.cover_purchase_execution_attempts;
begin
  if p_attempt_id is null or p_session_id is null or p_consumer_request_id is null then return jsonb_build_object('status', 'rejected', 'code', 'INPUT'); end if;
  select * into s from public.cover_purchase_execution_sessions x where x.session_id = p_session_id for update;
  if not found then return jsonb_build_object('status', 'rejected', 'code', 'SESSION_NOT_FOUND'); end if;
  if s.consumed_at is null then return jsonb_build_object('status', 'rejected', 'code', 'SESSION_NOT_CONSUMED'); end if;
  if s.consumer_request_id is distinct from p_consumer_request_id then return jsonb_build_object('status', 'rejected', 'code', 'REQUEST_MISMATCH'); end if;

  select * into saved from public.cover_purchase_execution_attempts a where a.session_id = p_session_id;
  if found then return jsonb_build_object('status', 'existing', 'attempt', public.cover_purchase_execution_attempt_json(saved)); end if;
  if now() >= s.expires_at then return jsonb_build_object('status', 'rejected', 'code', 'SESSION_EXPIRED'); end if;

  -- Freigabe und Kauf sind getrennte Berechtigungen: buyCover nach einer verbrauchten Freigabe nur mit
  -- nachgepruefter Freigabe und frischer Vorpruefung; keine Freigabe nach einem verbrauchten buyCover.
  if s.transaction_kind = 'NEXUS_BUY_COVER' and exists (
       select 1 from public.cover_purchase_execution_sessions x
        where x.intent_id = s.intent_id and x.transaction_kind = 'USDC_APPROVAL' and x.consumed_at is not null)
     and not exists (
       select 1 from public.cover_purchase_execution_attempts a
        where a.intent_id = s.intent_id and a.transaction_kind = 'USDC_APPROVAL' and a.state = 'APPROVAL_VERIFIED'
          and s.verified_block >= a.approval_verified_block) then
    return jsonb_build_object('status', 'rejected', 'code', 'APPROVAL_NOT_VERIFIED');
  end if;
  if s.transaction_kind = 'USDC_APPROVAL' and exists (
       select 1 from public.cover_purchase_execution_sessions x
        where x.intent_id = s.intent_id and x.transaction_kind = 'NEXUS_BUY_COVER' and x.consumed_at is not null) then
    return jsonb_build_object('status', 'rejected', 'code', 'PURCHASE_ALREADY_AUTHORIZED');
  end if;

  begin
    insert into public.cover_purchase_execution_attempts (attempt_id, session_id, intent_id, wallet, transaction_kind, consumer_request_id, state, created_at, updated_at)
    values (p_attempt_id, s.session_id, s.intent_id, s.wallet, s.transaction_kind, s.consumer_request_id, 'AUTHORIZED', now(), now())
    returning * into saved;
  exception when unique_violation then
    return jsonb_build_object('status', 'conflict', 'code', 'ATTEMPT_ID_REUSED');
  end;
  return jsonb_build_object('status', 'created', 'attempt', public.cover_purchase_execution_attempt_json(saved));
end;
$$;

/* ------------------------------------------------------------ Write-ahead -- */

-- AUTHORIZED -> WALLET_REQUEST_STARTED, genau einmal (Compare-and-Set), nur vor dem Ablauf der
-- Sitzung und nur, solange der Intent BUILT und vor seiner Build-Deadline ist. Nur der Gewinner
-- ('started') darf die Wallet aufrufen; jede Wiederholung erhaelt 'not_started' mit dem Zustand.
create or replace function public.start_cover_purchase_execution_attempt(p_attempt_id uuid, p_consumer_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.cover_purchase_execution_attempts;
begin
  if p_attempt_id is null or p_consumer_request_id is null then return jsonb_build_object('status', 'rejected', 'code', 'INPUT'); end if;
  begin
  update public.cover_purchase_execution_attempts a
     set state = 'WALLET_REQUEST_STARTED', wallet_request_started_at = now()
   where a.attempt_id = p_attempt_id
     and a.consumer_request_id = p_consumer_request_id
     and a.state = 'AUTHORIZED'
     and exists (
       select 1 from public.cover_purchase_execution_sessions s
         join public.cover_purchase_intents i on i.id = s.intent_id
        where s.session_id = a.session_id and s.consumed_at is not null and now() < s.expires_at
          and i.status = 'BUILT' and i.tx_hash is null and now() < i.build_deadline and now() < i.expires_at
     )
  returning * into saved;
  exception when unique_violation then
    -- eine andere Transaktion dieser Wallet kann unterwegs sein
    return jsonb_build_object('status', 'rejected', 'code', 'WALLET_BUSY');
  end;
  if saved.attempt_id is not null then return jsonb_build_object('status', 'started', 'attempt', public.cover_purchase_execution_attempt_json(saved)); end if;

  select * into saved from public.cover_purchase_execution_attempts a where a.attempt_id = p_attempt_id;
  if not found then return jsonb_build_object('status', 'rejected', 'code', 'ATTEMPT_NOT_FOUND'); end if;
  if saved.consumer_request_id is distinct from p_consumer_request_id then return jsonb_build_object('status', 'rejected', 'code', 'REQUEST_MISMATCH'); end if;
  if saved.state <> 'AUTHORIZED' then return jsonb_build_object('status', 'not_started', 'code', 'ALREADY_STARTED', 'attempt', public.cover_purchase_execution_attempt_json(saved)); end if;
  return jsonb_build_object('status', 'rejected', 'code', 'WINDOW_CLOSED');
end;
$$;

/* ------------------------------------------------------ Wallet-Ergebnisse -- */

-- WALLET_REQUEST_STARTED -> ABORTED_NO_TX (WALLET_REJECTED): ausdrueckliche Ablehnung vor jedem tx_hash.
-- Beruehrt den Intent nicht (kein FAILED, kein SUBMITTED). Der Versuch ist danach beendet.
create or replace function public.reject_cover_purchase_execution_attempt(p_attempt_id uuid, p_consumer_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.cover_purchase_execution_attempts;
begin
  if p_attempt_id is null or p_consumer_request_id is null then return jsonb_build_object('status', 'rejected', 'code', 'INPUT'); end if;
  update public.cover_purchase_execution_attempts a
     set state = 'ABORTED_NO_TX', abort_reason = 'WALLET_REJECTED', settled_at = now()
   where a.attempt_id = p_attempt_id and a.consumer_request_id = p_consumer_request_id and a.state = 'WALLET_REQUEST_STARTED'
  returning * into saved;
  if saved.attempt_id is not null then return jsonb_build_object('status', 'recorded', 'attempt', public.cover_purchase_execution_attempt_json(saved)); end if;
  select * into saved from public.cover_purchase_execution_attempts a where a.attempt_id = p_attempt_id;
  if not found or saved.consumer_request_id is distinct from p_consumer_request_id then return jsonb_build_object('status', 'rejected', 'code', 'ATTEMPT_NOT_FOUND'); end if;
  if saved.state = 'ABORTED_NO_TX' and saved.abort_reason = 'WALLET_REJECTED' then return jsonb_build_object('status', 'existing', 'attempt', public.cover_purchase_execution_attempt_json(saved)); end if;
  return jsonb_build_object('status', 'conflict', 'code', 'STATE', 'attempt', public.cover_purchase_execution_attempt_json(saved));
end;
$$;

-- WALLET_REQUEST_STARTED -> UNCERTAIN: Timeout, Netzfehler, unbekannte Antwort. Ob gesendet wurde, ist offen.
create or replace function public.mark_cover_purchase_execution_attempt_uncertain(p_attempt_id uuid, p_consumer_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.cover_purchase_execution_attempts;
begin
  if p_attempt_id is null or p_consumer_request_id is null then return jsonb_build_object('status', 'rejected', 'code', 'INPUT'); end if;
  update public.cover_purchase_execution_attempts a
     set state = 'UNCERTAIN'
   where a.attempt_id = p_attempt_id and a.consumer_request_id = p_consumer_request_id and a.state = 'WALLET_REQUEST_STARTED'
  returning * into saved;
  if saved.attempt_id is not null then return jsonb_build_object('status', 'recorded', 'attempt', public.cover_purchase_execution_attempt_json(saved)); end if;
  select * into saved from public.cover_purchase_execution_attempts a where a.attempt_id = p_attempt_id;
  if not found or saved.consumer_request_id is distinct from p_consumer_request_id then return jsonb_build_object('status', 'rejected', 'code', 'ATTEMPT_NOT_FOUND'); end if;
  if saved.state = 'UNCERTAIN' then return jsonb_build_object('status', 'existing', 'attempt', public.cover_purchase_execution_attempt_json(saved)); end if;
  return jsonb_build_object('status', 'conflict', 'code', 'STATE', 'attempt', public.cover_purchase_execution_attempt_json(saved));
end;
$$;

-- -> TX_HASH_OBSERVED: bindet genau einen tx_hash an Versuch, Sitzung, Intent und Art.
-- WALLET_RESPONSE nur aus WALLET_REQUEST_STARTED; CHAIN_RECONCILIATION (Fund auf der Kette nach einem
-- Absturz oder UNCERTAIN) aus WALLET_REQUEST_STARTED oder UNCERTAIN. Derselbe Hash erneut ist
-- idempotent, ein anderer ein Konflikt; ein Hash, der schon einem anderen Versuch gehoert, TX_HASH_TAKEN.
create or replace function public.bind_cover_purchase_execution_attempt_tx_hash(p_attempt_id uuid, p_consumer_request_id uuid, p_tx_hash text, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.cover_purchase_execution_attempts;
begin
  if p_attempt_id is null or p_consumer_request_id is null or p_tx_hash is null or p_source is null then return jsonb_build_object('status', 'rejected', 'code', 'INPUT'); end if;
  if p_tx_hash !~ '^0x[0-9a-f]{64}$' then return jsonb_build_object('status', 'rejected', 'code', 'HASH_FORMAT'); end if;
  if p_source not in ('WALLET_RESPONSE', 'CHAIN_RECONCILIATION') then return jsonb_build_object('status', 'rejected', 'code', 'SOURCE'); end if;
  if exists (select 1 from public.cover_purchase_execution_attempts a where a.tx_hash = p_tx_hash and a.attempt_id <> p_attempt_id) then
    return jsonb_build_object('status', 'conflict', 'code', 'TX_HASH_TAKEN');
  end if;
  begin
    update public.cover_purchase_execution_attempts a
       set state = 'TX_HASH_OBSERVED', tx_hash = p_tx_hash, tx_hash_source = p_source
     where a.attempt_id = p_attempt_id
       and a.consumer_request_id = p_consumer_request_id
       and a.tx_hash is null
       and (a.state = 'WALLET_REQUEST_STARTED' or (a.state = 'UNCERTAIN' and p_source = 'CHAIN_RECONCILIATION'))
    returning * into saved;
  exception when unique_violation then
    return jsonb_build_object('status', 'conflict', 'code', 'TX_HASH_TAKEN');
  end;
  if saved.attempt_id is not null then return jsonb_build_object('status', 'bound', 'attempt', public.cover_purchase_execution_attempt_json(saved)); end if;
  select * into saved from public.cover_purchase_execution_attempts a where a.attempt_id = p_attempt_id;
  if not found or saved.consumer_request_id is distinct from p_consumer_request_id then return jsonb_build_object('status', 'rejected', 'code', 'ATTEMPT_NOT_FOUND'); end if;
  if saved.tx_hash = p_tx_hash then return jsonb_build_object('status', 'existing', 'attempt', public.cover_purchase_execution_attempt_json(saved)); end if;
  if saved.tx_hash is not null then return jsonb_build_object('status', 'conflict', 'code', 'TX_HASH_CONFLICT', 'attempt', public.cover_purchase_execution_attempt_json(saved)); end if;
  return jsonb_build_object('status', 'conflict', 'code', 'STATE', 'attempt', public.cover_purchase_execution_attempt_json(saved));
end;
$$;

-- WALLET_REQUEST_STARTED/UNCERTAIN -> ABORTED_NO_TX (RECONCILED_NO_TX): nur nach einer Ruhezeit von
-- 30 Minuten seit dem Write-ahead und mit Nachweis des Abgleichs (bis zu welchem Block, Wallet-Nonce
-- dort). Die Nonce ist Nachweis, keine Berechtigung; den Restzweifel (eine signierte, zurueckgehaltene
-- Transaktion) beschreibt src/purchase-execution-protocol.mjs.
create or replace function public.reconcile_cover_purchase_execution_attempt_no_tx(p_attempt_id uuid, p_consumer_request_id uuid, p_scanned_to_block bigint, p_wallet_nonce bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.cover_purchase_execution_attempts;
begin
  if p_attempt_id is null or p_consumer_request_id is null or p_scanned_to_block is null or p_wallet_nonce is null then return jsonb_build_object('status', 'rejected', 'code', 'INPUT'); end if;
  if p_scanned_to_block <= 0 or p_wallet_nonce < 0 then return jsonb_build_object('status', 'rejected', 'code', 'EVIDENCE'); end if;
  update public.cover_purchase_execution_attempts a
     set state = 'ABORTED_NO_TX', abort_reason = 'RECONCILED_NO_TX', reconciled_to_block = p_scanned_to_block,
         reconciled_wallet_nonce = p_wallet_nonce, settled_at = now()
   where a.attempt_id = p_attempt_id
     and a.consumer_request_id = p_consumer_request_id
     and a.state in ('WALLET_REQUEST_STARTED', 'UNCERTAIN')
     and now() >= a.wallet_request_started_at + interval '30 minutes'
  returning * into saved;
  if saved.attempt_id is not null then return jsonb_build_object('status', 'recorded', 'attempt', public.cover_purchase_execution_attempt_json(saved)); end if;
  select * into saved from public.cover_purchase_execution_attempts a where a.attempt_id = p_attempt_id;
  if not found or saved.consumer_request_id is distinct from p_consumer_request_id then return jsonb_build_object('status', 'rejected', 'code', 'ATTEMPT_NOT_FOUND'); end if;
  if saved.state = 'ABORTED_NO_TX' and saved.abort_reason = 'RECONCILED_NO_TX' and saved.reconciled_to_block = p_scanned_to_block and saved.reconciled_wallet_nonce = p_wallet_nonce then
    return jsonb_build_object('status', 'existing', 'attempt', public.cover_purchase_execution_attempt_json(saved));
  end if;
  if saved.state in ('WALLET_REQUEST_STARTED', 'UNCERTAIN') then return jsonb_build_object('status', 'rejected', 'code', 'QUIET_PERIOD'); end if;
  return jsonb_build_object('status', 'conflict', 'code', 'STATE', 'attempt', public.cover_purchase_execution_attempt_json(saved));
end;
$$;

/* ------------------------------------------------------------- Weitergabe -- */

-- buyCover: TX_HASH_OBSERVED -> SUBMITTED zusammen mit P4D BUILT -> SUBMITTED in EINER Transaktion,
-- mit dem gebundenen tx_hash (nie einem vom Aufrufer). Die Nonce ist nur Nachweis fuer P4D.
create or replace function public.submit_cover_purchase_execution_attempt(p_attempt_id uuid, p_consumer_request_id uuid, p_intent_id uuid, p_tx_nonce bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.cover_purchase_execution_attempts;
  s public.cover_purchase_execution_sessions;
  res jsonb;
begin
  if p_attempt_id is null or p_consumer_request_id is null or p_intent_id is null or p_tx_nonce is null then return jsonb_build_object('status', 'rejected', 'code', 'INPUT'); end if;
  select * into saved from public.cover_purchase_execution_attempts a where a.attempt_id = p_attempt_id for update;
  if not found or saved.consumer_request_id is distinct from p_consumer_request_id then return jsonb_build_object('status', 'rejected', 'code', 'ATTEMPT_NOT_FOUND'); end if;
  if saved.intent_id is distinct from p_intent_id then return jsonb_build_object('status', 'rejected', 'code', 'INTENT_MISMATCH'); end if;
  if saved.transaction_kind <> 'NEXUS_BUY_COVER' then return jsonb_build_object('status', 'rejected', 'code', 'NOT_A_PURCHASE'); end if;
  if saved.state = 'SUBMITTED' then return jsonb_build_object('status', 'existing', 'attempt', public.cover_purchase_execution_attempt_json(saved)); end if;
  if saved.state <> 'TX_HASH_OBSERVED' then return jsonb_build_object('status', 'conflict', 'code', 'STATE', 'attempt', public.cover_purchase_execution_attempt_json(saved)); end if;
  select * into s from public.cover_purchase_execution_sessions x where x.session_id = saved.session_id;

  res := public.mark_cover_purchase_intent_submitted(saved.intent_id, s.wallet, '0x' || encode(s.calldata_hash, 'hex'), saved.tx_hash, p_tx_nonce);
  if res->>'status' not in ('submitted', 'existing') or res->'intent'->>'tx_hash' is distinct from saved.tx_hash then
    return jsonb_build_object('status', 'rejected', 'code', coalesce(res->>'code', 'NOT_SUBMITTED'), 'attempt', public.cover_purchase_execution_attempt_json(saved));
  end if;
  update public.cover_purchase_execution_attempts a
     set state = 'SUBMITTED', settled_at = now()
   where a.attempt_id = saved.attempt_id and a.state = 'TX_HASH_OBSERVED'
  returning * into saved;
  return jsonb_build_object('status', 'submitted', 'attempt', public.cover_purchase_execution_attempt_json(saved), 'intent', res->'intent');
end;
$$;

-- Freigabe: TX_HASH_OBSERVED -> APPROVAL_VERIFIED (unabhaengig gelesene Allowance >= max_premium_raw
-- des Intents an einem Block) oder APPROVAL_FAILED. Beruehrt den Kauf-Intent nie.
create or replace function public.settle_cover_purchase_approval_attempt(p_attempt_id uuid, p_consumer_request_id uuid, p_outcome text, p_verified_block bigint, p_allowance_raw numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  saved public.cover_purchase_execution_attempts;
  needed numeric;
begin
  if p_attempt_id is null or p_consumer_request_id is null or p_outcome is null then return jsonb_build_object('status', 'rejected', 'code', 'INPUT'); end if;
  if p_outcome not in ('VERIFIED', 'FAILED') then return jsonb_build_object('status', 'rejected', 'code', 'OUTCOME'); end if;
  if p_outcome = 'VERIFIED' and (p_verified_block is null or p_verified_block <= 0 or p_allowance_raw is null or p_allowance_raw < 0 or p_allowance_raw <> trunc(p_allowance_raw)) then
    return jsonb_build_object('status', 'rejected', 'code', 'EVIDENCE');
  end if;
  select * into saved from public.cover_purchase_execution_attempts a where a.attempt_id = p_attempt_id for update;
  if not found or saved.consumer_request_id is distinct from p_consumer_request_id then return jsonb_build_object('status', 'rejected', 'code', 'ATTEMPT_NOT_FOUND'); end if;
  if saved.transaction_kind <> 'USDC_APPROVAL' then return jsonb_build_object('status', 'rejected', 'code', 'NOT_AN_APPROVAL'); end if;
  if saved.state in ('APPROVAL_VERIFIED', 'APPROVAL_FAILED') then
    if saved.state = 'APPROVAL_' || p_outcome then return jsonb_build_object('status', 'existing', 'attempt', public.cover_purchase_execution_attempt_json(saved)); end if;
    return jsonb_build_object('status', 'conflict', 'code', 'ALREADY_SETTLED', 'attempt', public.cover_purchase_execution_attempt_json(saved));
  end if;
  if saved.state <> 'TX_HASH_OBSERVED' then return jsonb_build_object('status', 'conflict', 'code', 'STATE', 'attempt', public.cover_purchase_execution_attempt_json(saved)); end if;
  if p_outcome = 'VERIFIED' then
    select i.max_premium_raw into needed from public.cover_purchase_intents i where i.id = saved.intent_id;
    if p_allowance_raw < needed then return jsonb_build_object('status', 'rejected', 'code', 'ALLOWANCE_INSUFFICIENT'); end if;
    update public.cover_purchase_execution_attempts a
       set state = 'APPROVAL_VERIFIED', approval_verified_block = p_verified_block, approval_allowance_raw = p_allowance_raw, settled_at = now()
     where a.attempt_id = saved.attempt_id
    returning * into saved;
  else
    update public.cover_purchase_execution_attempts a
       set state = 'APPROVAL_FAILED', settled_at = now()
     where a.attempt_id = saved.attempt_id
    returning * into saved;
  end if;
  return jsonb_build_object('status', 'settled', 'attempt', public.cover_purchase_execution_attempt_json(saved));
end;
$$;

revoke all on function public.open_cover_purchase_execution_attempt(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.start_cover_purchase_execution_attempt(uuid, uuid) from public, anon, authenticated;
revoke all on function public.reject_cover_purchase_execution_attempt(uuid, uuid) from public, anon, authenticated;
revoke all on function public.mark_cover_purchase_execution_attempt_uncertain(uuid, uuid) from public, anon, authenticated;
revoke all on function public.bind_cover_purchase_execution_attempt_tx_hash(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.reconcile_cover_purchase_execution_attempt_no_tx(uuid, uuid, bigint, bigint) from public, anon, authenticated;
revoke all on function public.submit_cover_purchase_execution_attempt(uuid, uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.settle_cover_purchase_approval_attempt(uuid, uuid, text, bigint, numeric) from public, anon, authenticated;

grant execute on function public.open_cover_purchase_execution_attempt(uuid, uuid, uuid) to service_role;
grant execute on function public.start_cover_purchase_execution_attempt(uuid, uuid) to service_role;
grant execute on function public.reject_cover_purchase_execution_attempt(uuid, uuid) to service_role;
grant execute on function public.mark_cover_purchase_execution_attempt_uncertain(uuid, uuid) to service_role;
grant execute on function public.bind_cover_purchase_execution_attempt_tx_hash(uuid, uuid, text, text) to service_role;
grant execute on function public.reconcile_cover_purchase_execution_attempt_no_tx(uuid, uuid, bigint, bigint) to service_role;
grant execute on function public.submit_cover_purchase_execution_attempt(uuid, uuid, uuid, bigint) to service_role;
grant execute on function public.settle_cover_purchase_approval_attempt(uuid, uuid, text, bigint, numeric) to service_role;

comment on function public.open_cover_purchase_execution_attempt(uuid, uuid, uuid) is 'Nexus P4J: ein Ausfuehrungsversuch je verbrauchter Sitzung (nur die verbrauchende Anfrage). Nur service_role. Kein Wallet-Aufruf.';
comment on function public.start_cover_purchase_execution_attempt(uuid, uuid) is 'Nexus P4J: Write-ahead vor einem spaeteren Wallet-Aufruf, genau ein Gewinner. Nur service_role. Ruft keine Wallet.';
comment on function public.reject_cover_purchase_execution_attempt(uuid, uuid) is 'Nexus P4J: ausdrueckliche Wallet-Ablehnung vor jedem tx_hash. Nur service_role.';
comment on function public.mark_cover_purchase_execution_attempt_uncertain(uuid, uuid) is 'Nexus P4J: mehrdeutiges Wallet-/Provider-Ergebnis. Nur service_role.';
comment on function public.bind_cover_purchase_execution_attempt_tx_hash(uuid, uuid, text, text) is 'Nexus P4J: bindet genau einen tx_hash an den Versuch. Nur service_role.';
comment on function public.reconcile_cover_purchase_execution_attempt_no_tx(uuid, uuid, bigint, bigint) is 'Nexus P4J: Abgleich ohne Treffer nach 30 Minuten Ruhezeit. Nur service_role.';
comment on function public.submit_cover_purchase_execution_attempt(uuid, uuid, uuid, bigint) is 'Nexus P4J: buyCover-Versuch -> P4D SUBMITTED mit dem gebundenen tx_hash. Nur service_role.';
comment on function public.settle_cover_purchase_approval_attempt(uuid, uuid, text, bigint, numeric) is 'Nexus P4J: Freigabe-Versuch nachgeprueft oder gescheitert; beruehrt den Kauf nie. Nur service_role.';
