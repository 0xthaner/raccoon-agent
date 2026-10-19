/*
	NEXUS P4D: SCHMALER DATENBANK-HELFER FUER KAUF-INTENTS (19.10.2026).

	Genau acht Operationen, je EIN Aufruf genau einer festen Funktion aus
	supabase/migrations/20261019120000_cover_purchase_intents.sql. Kein
	generisches Update, kein SQL, kein frei waehlbarer RPC-Name. Der Aufrufer
	uebergibt einen Client mit rpc(name, args) (supabase-js mit service_role);
	dieses Modul liest keine Umgebung und baut keine Verbindung auf.

	Hash-Hoheit: der Intent-Hash wird hier aus dem kanonischen P4A-Intent
	berechnet (computePurchaseIntentHash), nie vom Aufrufer uebernommen. Zeiten
	der Uebergaenge setzt die Datenbank (now()), nicht der Aufrufer.

	Kein Kaufpfad: keine Route, keine Wallet, kein Senden. Bis zu einer spaeteren
	Phase importiert nur test/ dieses Modul (P4D-IMPORT).
*/
import { validatePurchaseIntent, computePurchaseIntentHash, normalizeWallet, isIntentId, COMMISSION_POLICY } from './purchase-intent.mjs';

/** Version der Bestaetigungs-Bindung (P4B TERMS_DOMAIN / TERMS_HASH_VERSION), gespeichert neben dem Terms-Hash. */
export const TERMS_VERSION = 'coverraccoon.terms/1';
export const FAILURE_REASONS = Object.freeze(['TX_REVERTED', 'TX_DROPPED', 'TX_REPLACED']);
export const CANCEL_REASONS = Object.freeze(['USER_CANCELLED', 'PIN_DRIFT', 'QUOTE_STALE']);

const HASH = /^0x[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const iso = (seconds) => new Date(seconds * 1000).toISOString();
const rejected = (code) => Object.freeze({ status: 'rejected', code });

function wantHash(value, code) { if (typeof value !== 'string' || !HASH.test(value)) throw new TypeError(code); return value; }
function wantId(value) { if (!isIntentId(value)) throw new TypeError('INTENT_ID'); return value; }
function wantWallet(value) { const w = normalizeWallet(value); if (w === null) throw new TypeError('WALLET'); return w; }
function wantPositive(value, code) {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
	if (typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)) return value;
	throw new TypeError(code);
}
function wantNonce(value) {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
	throw new TypeError('TX_NONCE');
}
async function call(client, name, args) {
	const { data, error } = await client.rpc(name, args);
	if (error) throw new Error(`${name} failed: ${error.code ?? 'DB_ERROR'}`);
	if (!data || typeof data !== 'object' || typeof data.status !== 'string') throw new Error(`${name} returned no status`);
	return Object.freeze(data);
}

/** Legt einen OPEN-Intent an (idempotent je wallet + clientRequestId). Hash und Termsversion berechnet der Server. */
export async function createIntent(client, { intent, clientRequestId }) {
	if (typeof clientRequestId !== 'string' || !UUID.test(clientRequestId)) throw new TypeError('CLIENT_REQUEST_ID');
	const checked = validatePurchaseIntent(intent);
	if (!checked.ok) return rejected('INVALID_INTENT');
	const i = checked.intent;
	return call(client, 'create_cover_purchase_intent', {
		p_id: i.id, p_wallet: i.wallet, p_chain_id: i.chainId, p_deployment_key: i.deploymentKey, p_product_id: i.productId,
		p_product_type_id: i.productTypeId, p_cover_asset_id: i.coverAssetId, p_amount_raw: i.amountRaw.toString(), p_period_days: i.periodDays,
		p_quote_premium_raw: i.quotePremiumRaw.toString(), p_max_premium_raw: i.maxPremiumRaw.toString(),
		p_quote_fetched_at: iso(i.quoteFetchedAt), p_capacity_fetched_at: iso(i.capacityFetchedAt), p_wording_cid: i.wordingCid, p_annex_cid: i.annexCid,
		p_terms_version: TERMS_VERSION, p_terms_hash: i.termsHash, p_proof_of_loss_cid: i.proofOfLossCid,
		p_commission_ratio: COMMISSION_POLICY.ratio, p_commission_destination: COMMISSION_POLICY.destination, p_pin_version: i.pinVersion,
		p_intent_hash: computePurchaseIntentHash(intent), p_acknowledged_at: iso(i.acknowledgedAt), p_expires_at: iso(i.expiresAt),
		p_client_request_id: clientRequestId
	});
}

/** OPEN -> BUILT. Der Intent-Hash wird aus dem Intent neu berechnet; calldataHash kommt aus dem P4C-Builder. */
export async function markBuilt(client, { intent, calldataHash }) {
	const checked = validatePurchaseIntent(intent);
	if (!checked.ok) return rejected('INVALID_INTENT');
	return call(client, 'mark_cover_purchase_intent_built', {
		p_id: checked.intent.id, p_wallet: checked.intent.wallet, p_intent_hash: computePurchaseIntentHash(intent), p_calldata_hash: wantHash(calldataHash, 'CALLDATA_HASH')
	});
}

/** BUILT -> SUBMITTED mit genau einem tx_hash. */
export async function markSubmitted(client, { id, wallet, calldataHash, txHash, txNonce }) {
	return call(client, 'mark_cover_purchase_intent_submitted', {
		p_id: wantId(id), p_wallet: wantWallet(wallet), p_calldata_hash: wantHash(calldataHash, 'CALLDATA_HASH'), p_tx_hash: wantHash(txHash, 'TX_HASH'), p_tx_nonce: wantNonce(txNonce)
	});
}

/** SUBMITTED -> CONFIRMED. Persistiert nur eine bereits anderswo gepruefte Cover-ID; prueft keine Kette. */
export async function markConfirmed(client, { id, txHash, coverId }) {
	return call(client, 'mark_cover_purchase_intent_confirmed', { p_id: wantId(id), p_tx_hash: wantHash(txHash, 'TX_HASH'), p_cover_id: wantPositive(coverId, 'COVER_ID') });
}

/** SUBMITTED -> FAILED mit festem Grund. Beweist nicht, dass die Transaktion nie gemined wird. */
export async function markFailed(client, { id, txHash, reason }) {
	if (!FAILURE_REASONS.includes(reason)) throw new TypeError('REASON');
	return call(client, 'mark_cover_purchase_intent_failed', { p_id: wantId(id), p_tx_hash: wantHash(txHash, 'TX_HASH'), p_reason: reason });
}

/** FAILED -> CONFIRMED (late) fuer einen spaeter unabhaengig nachgewiesenen Erfolg derselben Transaktion. */
export async function markLateConfirmed(client, { id, txHash, calldataHash, coverId }) {
	return call(client, 'mark_cover_purchase_intent_late_confirmed', {
		p_id: wantId(id), p_tx_hash: wantHash(txHash, 'TX_HASH'), p_calldata_hash: wantHash(calldataHash, 'CALLDATA_HASH'), p_cover_id: wantPositive(coverId, 'COVER_ID')
	});
}

/** OPEN/BUILT -> CANCELLED. Widerruft keine bereits signierte Transaktion. */
export async function cancelIntent(client, { id, wallet, reason = 'USER_CANCELLED' }) {
	if (!CANCEL_REASONS.includes(reason)) throw new TypeError('REASON');
	return call(client, 'cancel_cover_purchase_intent', { p_id: wantId(id), p_wallet: wantWallet(wallet), p_reason: reason });
}

/** Optionales Aufraeumen OPEN/BUILT -> EXPIRED; keine Sicherheitseigenschaft haengt daran. */
export async function expireIntent(client, { id }) {
	return call(client, 'expire_cover_purchase_intent', { p_id: wantId(id) });
}
