-- Restaudit L2, 16.10.2026: der tote Telegram-Handoff wird entfernt.
--
-- `telegram_handoffs` und `consume_telegram_handoff` banden eine Wallet an einen
-- Chat, ohne dass die Wallet dafuer signiert - nur ueber einen vom Dashboard
-- ausgestellten Code. Seit HARD-004 (04e8ca2) stellt keine Stelle mehr einen
-- solchen Code aus und keine loest ihn ein; die Helfer in src/db.mjs und
-- src/linking.mjs hatten keinen Aufrufer und sind mit dieser Migration geloescht.
-- Die Funktion blieb trotzdem fuer service_role aufrufbar (M1 hatte sie nur unter
-- dasselbe Wallet-Limit gestellt). Ein zweiter, unsignierter Bindungsweg in der
-- Datenbank ist ein Risiko ohne Nutzen.
--
-- Der einzige Bindungsweg bleibt: pending_links-Code -> Wallet-Signatur ->
-- Pruefung -> consume_wallet_link_v2 -> monitored_wallets. Nichts davon wird hier
-- beruehrt.
--
-- Bewusst ohne CASCADE: haengt noch etwas an Tabelle oder Funktion, scheitert die
-- Migration, statt es still mitzuloeschen. Index und RLS-Einstellung gehoeren zur
-- Tabelle und fallen mit ihr. Rechte werden nicht vergeben, nur entzogen (durch
-- das Loeschen); die Standardrechte aus AGENT-SEC-A7 bleiben unveraendert.
--
-- Die Tabelle enthaelt nur kurzlebige Einmalcodes (10 Minuten) mit Wallet-
-- Adresse. Ein noch offener, gueltiger Handoff waere ein Zeichen, dass doch noch
-- etwas ausstellt - dann bricht die Migration ab, statt ihn zu verwerfen.

do $$
begin
  if exists (select 1 from public.telegram_handoffs where used_at is null and expires_at > now()) then
    raise exception 'L2: offene, gueltige telegram_handoffs vorhanden - Abbruch, nichts geloescht';
  end if;
end;
$$;

drop function public.consume_telegram_handoff(text, text);
drop table public.telegram_handoffs;
