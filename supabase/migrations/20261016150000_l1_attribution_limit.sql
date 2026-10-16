-- Restaudit L1, 16.10.2026: hoechstens 60 Cover-Zuordnungen je Wallet - atomar.
--
-- Bisher zaehlte der Handler (api/position-attributions.mjs) die gespeicherten
-- Zeilen und schrieb danach mit einem eigenen Upsert. Gleichzeitige Anfragen sahen
-- alle noch Platz: gegen echten Postgres wurden aus 59 Zeilen und 40 gleichzeitigen
-- Bestaetigungen 99 Zeilen.
--
-- Jetzt prueft und schreibt EINE Funktion unter einer Sperre je Wallet
-- (transaktionsgebundene Advisory-Sperre, wie lock_chat_wallets fuer M1):
--   1. dieselbe Relation existiert schon -> nur bestaetigen ('updated'), zaehlt nicht neu;
--   2. sonst zaehlen; ab 60 -> 'limit', nichts geschrieben;
--   3. sonst einfuegen -> 'inserted'.
-- Andere Wallets warten nie aufeinander (eigener Sperrschluessel je Wallet).
--
-- Gezaehlt wird jede gespeicherte Zeile der Wallet, auch eine, die der naechste
-- Abgleich als veraltet loeschen wird: das Limit begrenzt Speicher, nicht Anzeige.
-- Loeschen (Abgleich, DELETE, Aufbewahrung) senkt die Zahl nur und braucht die
-- Sperre nicht.
--
-- SECURITY INVOKER: die Funktion braucht keine eigenen Rechte; service_role hat
-- die Tabellenrechte bereits (20261014120000). Nur service_role darf sie aufrufen.
-- Additiv: keine Tabelle, keine Zeile und keine bestehende Berechtigung aendert sich.

create or replace function public.upsert_position_attribution_limited(
  p_wallet text,
  p_protocol_key text,
  p_protocol_version text,
  p_deployment_key text,
  p_product_id integer,
  p_cover_id bigint,
  p_confirmed_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  max_rows constant integer := 60;
  normalized text := lower(p_wallet);
  stored integer;
  saved jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('position_cover_attributions:' || normalized, 0));

  update public.position_cover_attributions a
     set confirmed_at = p_confirmed_at, updated_at = p_confirmed_at
   where a.wallet = normalized and a.deployment_key = p_deployment_key and a.cover_id = p_cover_id
  returning jsonb_build_object('deployment_key', a.deployment_key, 'product_id', a.product_id, 'cover_id', a.cover_id, 'source', a.source, 'confirmed_at', a.confirmed_at)
    into saved;
  if saved is not null then return jsonb_build_object('status', 'updated', 'row', saved); end if;

  select count(*) into stored from public.position_cover_attributions a where a.wallet = normalized;
  if stored >= max_rows then return jsonb_build_object('status', 'limit'); end if;

  insert into public.position_cover_attributions as a (wallet, protocol_key, protocol_version, deployment_key, product_id, cover_id, source, confirmed_at, updated_at)
  values (normalized, p_protocol_key, p_protocol_version, p_deployment_key, p_product_id, p_cover_id, 'user_confirmed', p_confirmed_at, p_confirmed_at)
  returning jsonb_build_object('deployment_key', a.deployment_key, 'product_id', a.product_id, 'cover_id', a.cover_id, 'source', a.source, 'confirmed_at', a.confirmed_at)
    into saved;
  return jsonb_build_object('status', 'inserted', 'row', saved);
end;
$$;

revoke all on function public.upsert_position_attribution_limited(text, text, text, text, integer, bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.upsert_position_attribution_limited(text, text, text, text, integer, bigint, timestamptz) to service_role;
