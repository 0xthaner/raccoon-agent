-- Nexus P4H, 20.10.2026: feste Lesefunktion fuer die serverseitige Ausfuehrungs-Vorbereitung.
--
-- NUR LOKAL: diese Migration wird in P4H weder auf Produktion noch auf ein
-- gehostetes Projekt angewendet. Es gibt keinen Kaufpfad: keine Route, keine
-- Wallet-Methode, kein Senden.
--
-- Eine Funktion, ein Intent per exakter id, nur die Felder, die der kanonische
-- P4A-Intent und die Ausfuehrungs-Vorbereitung brauchen (keine client_request_id,
-- keine Zeitstempel der Zeile, kein tx_nonce, kein status_reason; die Tabelle
-- speichert ohnehin keine IP, keinen User-Agent, keine Signatur, kein Quote-JSON).
-- Kein Filter ausser der id, kein dynamisches SQL, kein Schreiben.
--
-- SECURITY INVOKER (bewusst nicht DEFINER): service_role darf die Tabelle bereits
-- lesen (P4D); die Funktion braucht keine erhoehten Rechte. anon/authenticated
-- haben weder Tabellen- noch Ausfuehrungsrecht.
--
-- Zeiten als ganze Unix-Sekunden. built_at wird AUFgerundet, build_deadline
-- ABgerundet: das Fenster wird dadurch nur enger, nie weiter.

create or replace function public.get_cover_purchase_intent_for_execution(p_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(
    (select jsonb_build_object('status', 'found', 'intent', jsonb_build_object(
        'id', i.id, 'wallet', i.wallet, 'chain_id', i.chain_id, 'deployment_key', i.deployment_key,
        'product_id', i.product_id, 'product_type_id', i.product_type_id, 'cover_asset_id', i.cover_asset_id,
        'amount_raw', i.amount_raw::text, 'period_days', i.period_days,
        'quote_premium_raw', i.quote_premium_raw::text, 'max_premium_raw', i.max_premium_raw::text,
        'quote_fetched_at', extract(epoch from i.quote_fetched_at)::bigint,
        'capacity_fetched_at', extract(epoch from i.capacity_fetched_at)::bigint,
        'wording_cid', i.wording_cid, 'annex_cid', i.annex_cid,
        'terms_version', i.terms_version, 'terms_hash', '0x' || encode(i.terms_hash, 'hex'),
        'proof_of_loss_cid', i.proof_of_loss_cid,
        'commission_ratio', i.commission_ratio, 'commission_destination', i.commission_destination,
        'pin_version', i.pin_version, 'intent_hash', '0x' || encode(i.intent_hash, 'hex'),
        'acknowledged_at', extract(epoch from i.acknowledged_at)::bigint,
        'expires_at', extract(epoch from i.expires_at)::bigint,
        'status', i.status,
        'calldata_hash', case when i.calldata_hash is null then null else '0x' || encode(i.calldata_hash, 'hex') end,
        'built_at', case when i.built_at is null then null else ceil(extract(epoch from i.built_at))::bigint end,
        'build_deadline', case when i.build_deadline is null then null else floor(extract(epoch from i.build_deadline))::bigint end,
        'tx_hash', i.tx_hash, 'cover_id', i.cover_id
      ))
     from public.cover_purchase_intents i
     where i.id = p_id),
    jsonb_build_object('status', 'rejected', 'code', 'NOT_FOUND'));
$$;

revoke all on function public.get_cover_purchase_intent_for_execution(uuid) from public, anon, authenticated;
grant execute on function public.get_cover_purchase_intent_for_execution(uuid) to service_role;

comment on function public.get_cover_purchase_intent_for_execution(uuid) is 'Nexus P4H: ein Kauf-Intent per id fuer die serverseitige Ausfuehrungs-Vorbereitung. Nur lesen, nur service_role. Kein Kaufpfad.';
