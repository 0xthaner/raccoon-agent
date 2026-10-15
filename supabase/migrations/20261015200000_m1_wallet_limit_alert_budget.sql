-- Restaudit M1, 15.10.2026: Erinnerungslauf gegen Ressourcen-Erschoepfung.
--
-- 1. Hoechstens 10 verknuepfte Wallets je Telegram-Chat, DURCHGESETZT IN DER
--    DATENBANK. Beide Wege, die Zeilen in monitored_wallets anlegen
--    (consume_wallet_link und der ungenutzte consume_telegram_handoff), laufen
--    ueber dieselbe Pruefung. Ein Chat-weiter Transaktions-Advisory-Lock
--    serialisiert gleichzeitige Verknuepfungen DESSELBEN Chats: Zaehlen und
--    Einfuegen geschehen unter dem Lock, die Zaehlung sieht jede vorher
--    abgeschlossene Verknuepfung (READ COMMITTED, neuer Snapshot je Anweisung).
--    Bereits verknuepfte Wallets bleiben unberuehrt; eine schon verknuepfte
--    Wallet erneut zu verknuepfen zaehlt nicht als neue. Am Limit wird NICHTS
--    geschrieben - auch der Code bleibt unverbraucht (kein halber Zustand).
--
-- 2. alert_subscriptions_page: seitenweises, deterministisch sortiertes Lesen der
--    Erinnerungs-Abos (Keyset ueber den Primaerschluessel chat_id, wallet). Die
--    Seitengroesse ist serverseitig auf 200 gedeckelt; der Aufrufer liest, bis
--    eine Seite LEER ist, und verlaesst sich nie darauf, dass eine Antwort alles
--    enthaelt (PostgREST kappt Antworten bei max_rows).
--
-- 3. alert_run_state: ein einziger Cursor, damit ein durch Budget beendeter Lauf
--    beim naechsten Mal HINTER der letzten bearbeiteten Zeile weitermacht und
--    keine Zeile dauerhaft hinten herunterfaellt.
--
-- Alles nur fuer service_role, wie jede Funktion und Tabelle dieses Projekts.

-- ------------------------------------------------------------ 1. Wallet-Limit

create or replace function public.link_wallet_to_chat_limited(target_chat text, linked_wallet text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  max_wallets constant integer := 10;
  normalized text := lower(linked_wallet);
  wallet_count integer;
  already_linked boolean;
begin
  -- Muss bereits unter dem Chat-Lock laufen; der Aufrufer nimmt ihn.
  select exists (select 1 from public.monitored_wallets m where m.chat_id = target_chat and m.wallet = normalized) into already_linked;
  select count(*) into wallet_count from public.monitored_wallets m where m.chat_id = target_chat;
  if not already_linked and wallet_count >= max_wallets then return 'wallet_limit'; end if;

  insert into public.monitored_wallets (chat_id, wallet, label, is_primary, alerts_enabled)
  values (target_chat, normalized, case when wallet_count = 0 then 'Main Wallet' else 'Wallet ' || (wallet_count + 1) end, wallet_count = 0, true)
  on conflict (chat_id, wallet) do update set alerts_enabled = true, updated_at = now();

  insert into public.wallet_links (chat_id, wallet, linked_at, alerts_enabled)
  values (target_chat, normalized, now(), true)
  on conflict (chat_id) do update set wallet = excluded.wallet, linked_at = excluded.linked_at, alerts_enabled = true;
  return 'linked';
end;
$$;

create or replace function public.lock_chat_wallets(target_chat text)
returns void
language sql
security definer
set search_path = public
as $$
  select pg_advisory_xact_lock(hashtextextended('monitored_wallets:' || target_chat, 0));
$$;

create or replace function public.consume_wallet_link_v2(link_code text, linked_wallet text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_chat text;
  consumed_code text;
  outcome text;
begin
  -- Ein Code gehoert fest zu genau einem Chat. Erst den Chat bestimmen, dann
  -- unter dessen Lock pruefen: gleichzeitige Versuche fuer denselben Chat (auch
  -- mit demselben Code) laufen nacheinander.
  select p.chat_id into target_chat from public.pending_links p where p.code = link_code;
  if target_chat is null then return jsonb_build_object('status', 'invalid'); end if;
  perform public.lock_chat_wallets(target_chat);

  if not exists (select 1 from public.pending_links p
                  where p.code = link_code and p.used_at is null and p.expires_at > now()) then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- Am Limit schreibt der Helfer nichts, und der Code bleibt unverbraucht.
  outcome := public.link_wallet_to_chat_limited(target_chat, linked_wallet);
  if outcome = 'wallet_limit' then return jsonb_build_object('status', 'wallet_limit', 'chat_id', target_chat); end if;

  update public.pending_links p set used_at = now() where p.code = link_code and p.used_at is null
  returning p.code into consumed_code;
  -- Unter dem Lock unmoeglich; falls doch: alles zuruecknehmen, nichts halb verknuepft.
  if consumed_code is null then raise exception 'link code consumed concurrently'; end if;
  return jsonb_build_object('status', 'linked', 'chat_id', target_chat);
end;
$$;

-- Die bisherige Funktion bleibt fuer den Uebergang (alter Code bis zum Deploy)
-- erhalten, laeuft aber ueber dieselbe Grenze. Am Limit: null wie "Code ungueltig".
create or replace function public.consume_wallet_link(link_code text, linked_wallet text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  outcome jsonb;
begin
  outcome := public.consume_wallet_link_v2(link_code, linked_wallet);
  if outcome->>'status' = 'linked' then return outcome->>'chat_id'; end if;
  return null;
end;
$$;

-- Ungenutzt (Restaudit L2), aber aufrufbar: dieselbe Grenze, damit es keinen
-- zweiten Weg ohne Limit gibt. Am Limit: null, Handoff bleibt unverbraucht.
create or replace function public.consume_telegram_handoff(handoff_code text, telegram_chat_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_wallet text;
begin
  perform public.lock_chat_wallets(telegram_chat_id);
  select h.wallet into linked_wallet from public.telegram_handoffs h
   where h.code = handoff_code and h.used_at is null and h.expires_at > now()
   for update;
  if linked_wallet is null then return null; end if;
  if public.link_wallet_to_chat_limited(telegram_chat_id, linked_wallet) = 'wallet_limit' then return null; end if;
  update public.telegram_handoffs h set used_at = now() where h.code = handoff_code;
  return linked_wallet;
end;
$$;

-- --------------------------------------------- 2. Seitenweise Erinnerungs-Abos

create or replace function public.alert_subscriptions_page(after_chat text, after_wallet text, through_chat text, through_wallet text, page_size integer)
returns table (chat_id text, wallet text, label text, alert_thresholds integer[], weekly_summary boolean, language text)
language sql
stable
security definer
set search_path = public
as $$
  select m.chat_id, m.wallet, m.label, m.alert_thresholds, m.weekly_summary, coalesce(p.language, 'de')
    from public.monitored_wallets m
    left join public.user_preferences p on p.chat_id = m.chat_id
   where m.alerts_enabled
     and (after_chat is null or (m.chat_id, m.wallet) > (after_chat, after_wallet))
     and (through_chat is null or (m.chat_id, m.wallet) <= (through_chat, through_wallet))
   order by m.chat_id, m.wallet
   limit least(greatest(coalesce(page_size, 1), 1), 200);
$$;

-- ------------------------------------------------------- 3. Cursor des Laufs

create table if not exists public.alert_run_state (
  id text primary key check (id = 'expiry-alerts'),
  cursor_chat_id text,
  cursor_wallet text,
  updated_at timestamptz not null default now(),
  check ((cursor_chat_id is null) = (cursor_wallet is null))
);

alter table public.alert_run_state enable row level security;
revoke all on table public.alert_run_state from public, anon, authenticated;
grant select, insert, update on table public.alert_run_state to service_role;

comment on table public.alert_run_state is 'Fortsetzungspunkt des taeglichen Erinnerungslaufs (Fairness bei Budget-Ende). Server-only.';

-- ---------------------------------------------------------------- Rechte

revoke all on function public.link_wallet_to_chat_limited(text, text) from public, anon, authenticated, service_role;
revoke all on function public.lock_chat_wallets(text) from public, anon, authenticated, service_role;
revoke all on function public.consume_wallet_link_v2(text, text) from public, anon, authenticated;
revoke all on function public.consume_wallet_link(text, text) from public, anon, authenticated;
revoke all on function public.consume_telegram_handoff(text, text) from public, anon, authenticated;
revoke all on function public.alert_subscriptions_page(text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.consume_wallet_link_v2(text, text) to service_role;
grant execute on function public.consume_wallet_link(text, text) to service_role;
grant execute on function public.consume_telegram_handoff(text, text) to service_role;
grant execute on function public.alert_subscriptions_page(text, text, text, text, integer) to service_role;
