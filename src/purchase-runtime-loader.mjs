/*
	NEXUS P4H: SERVERSEITIGER LADER FUER DIE AUSFUEHRUNGS-VORBEREITUNG (20.10.2026).

	Laedt genau einen gespeicherten Kauf-Intent per id ueber ein injiziertes
	Repository mit genau einer Methode, loadIntentForExecution(id) (P4D-Helfer
	ueber die feste Lesefunktion der Migration 20261020120000), und baut daraus das
	kanonische Modell, das P4A, der P4C-Decoder, P4F und ein spaeterer Wallet-Pfad
	brauchen: intent, intentHash, calldataHash, status, builtAt, buildDeadline,
	expiresAt, txHash, coverId.

	Streng, ohne Reparatur: genau die erwarteten Spalten; der P4A-Intent muss gueltig
	sein und seinen gespeicherten Hash ergeben; nur BUILT, noch ohne tx_hash und
	cover_id, mit bytes32-calldata_hash, mit Proof-of-Loss-CID und einem P4D-Build-
	fenster; nutzbar nur bei now < expires_at und now < build_deadline (beide
	exklusiv). Der Aufrufer nennt nur intentId (und der Server die Uhr); jede Kopie
	von Intent, Hashes, Status oder Zeiten wird abgelehnt.

	60 s / 120 s (Aave-Phase, 20.10.2026): Quote und Kapazitaet sind nach P3/P4A
	hoechstens 60 s alt, das P4D-Build-Fenster ist aber 120 s lang und ein Intent
	lebt bis zu 15 Minuten. Damit nie eine aeltere Quote oder Kapazitaet zu einem
	Senden fuehrt, gilt hier zusaetzlich: nutzbar nur bei
	now < quote_fetched_at + 60 und now < capacity_fetched_at + 60 (exklusiv,
	QUOTE_STALE_FOR_EXECUTION / CAPACITY_STALE_FOR_EXECUTION), und
	executionFreshUntil begrenzt jede Ausfuehrungs-Sitzung auf genau diese Grenze.
	Eine spaetere Quote heisst: neuer Intent, nie ein Nachtragen.

	Kein Kaufpfad: liest nur, schreibt nie, kein Netz, keine Wallet. Bis zu einer
	spaeteren Phase importieren nur test/ und das selbst unerreichbare
	src/purchase-execution-session.mjs dieses Modul (P4H-IMPORT).
*/
import { validatePurchaseIntent, computePurchaseIntentHash, isIntentId, QUOTE_MAX_AGE_SECONDS } from './purchase-intent.mjs';

export const LOADER_STATUSES = Object.freeze(['LOADED', 'INVALID_INPUT', 'NOT_FOUND', 'DB_UNAVAILABLE', 'PERSISTED_RECORD_INVALID', 'INVALID_STATUS', 'INTENT_EXPIRED', 'BUILD_DEADLINE_EXPIRED', 'QUOTE_STALE_FOR_EXECUTION', 'CAPACITY_STALE_FOR_EXECUTION']);
/** P4D: Terms-Version neben dem Terms-Hash; jede andere Version ist ein anderer Vertrag. */
export const EXPECTED_TERMS_VERSION = 'coverraccoon.terms/1';
/** P4D: build_deadline = built_at + 120 s und nie nach expires_at. */
const BUILD_WINDOW_SECONDS = 120;
/** Hoechstalter von Quote und Kapazitaet bis zum Ende jeder Ausfuehrungs-Sitzung (gleich P4A QUOTE_MAX_AGE_SECONDS). */
export const EXECUTION_QUOTE_MAX_AGE_SECONDS = QUOTE_MAX_AGE_SECONDS;

/** Letzte Sekunde (exklusiv), bis zu der Quote und Kapazitaet eines Intents fuer eine Ausfuehrung frisch sind. */
export const executionFreshUntil = (intent) => Math.min(intent.quoteFetchedAt, intent.capacityFetchedAt) + EXECUTION_QUOTE_MAX_AGE_SECONDS;

const INPUT_KEYS = Object.freeze(['repository', 'intentId', 'now']);
const REPOSITORY_KEYS = Object.freeze(['loadIntentForExecution']);
/** Genau die Spalten der festen Lesefunktion. */
const ROW_KEYS = Object.freeze([
	'id', 'wallet', 'chain_id', 'deployment_key', 'product_id', 'product_type_id', 'cover_asset_id', 'amount_raw', 'period_days', 'quote_premium_raw',
	'max_premium_raw', 'quote_fetched_at', 'capacity_fetched_at', 'wording_cid', 'annex_cid', 'terms_version', 'terms_hash', 'proof_of_loss_cid',
	'commission_ratio', 'commission_destination', 'pin_version', 'intent_hash', 'acknowledged_at', 'expires_at', 'status', 'calldata_hash',
	'built_at', 'build_deadline', 'tx_hash', 'cover_id'
]);
const PURCHASE_KEYS = Object.freeze(['intentId', 'intent', 'intentHash', 'calldataHash', 'status', 'builtAt', 'buildDeadline', 'expiresAt', 'txHash', 'coverId']);
const HASH = /^0x[0-9a-f]{64}$/;
const isTime = (t) => Number.isSafeInteger(t) && t > 0;

class Stop extends Error { constructor(status, errors) { super(status); this.status = status; this.errors = errors; } }
const stop = (status, ...errors) => { throw new Stop(status, errors.length ? errors : [status]); };

/** Zeile der Lesefunktion -> kanonischer P4A-Intent (Feldnamen von P4A, keine weiteren). */
function intentOf(row) {
	return {
		id: row.id, wallet: row.wallet, chainId: row.chain_id, deploymentKey: row.deployment_key, productId: row.product_id, productTypeId: row.product_type_id,
		coverAssetId: row.cover_asset_id, amountRaw: row.amount_raw, periodDays: row.period_days, quotePremiumRaw: row.quote_premium_raw, maxPremiumRaw: row.max_premium_raw,
		quoteFetchedAt: row.quote_fetched_at, capacityFetchedAt: row.capacity_fetched_at, wordingCid: row.wording_cid, annexCid: row.annex_cid, termsHash: row.terms_hash,
		proofOfLossCid: row.proof_of_loss_cid, commissionRatio: row.commission_ratio, commissionDestination: row.commission_destination, pinVersion: row.pin_version,
		acknowledgedAt: row.acknowledged_at, expiresAt: row.expires_at
	};
}

/**
 * Prueft ein (geladenes oder weitergereichtes) Kauf-Modell vollstaendig neu gegen die Uhr.
 * Wirft Stop; vertraut keinem frueheren Ergebnis.
 */
function checkPurchase(p, now) {
	if (!p || typeof p !== 'object' || Array.isArray(p)) stop('PERSISTED_RECORD_INVALID', 'PURCHASE_NOT_OBJECT');
	const extra = Object.keys(p).filter((k) => !PURCHASE_KEYS.includes(k));
	if (extra.length) stop('PERSISTED_RECORD_INVALID', ...extra.map((k) => `PURCHASE_FIELD:${k}`));
	const checked = validatePurchaseIntent(p.intent);
	if (!checked.ok) stop('PERSISTED_RECORD_INVALID', 'INTENT_INVALID', ...checked.errors);
	if (checked.intent.id !== p.intentId) stop('PERSISTED_RECORD_INVALID', 'INTENT_ID');
	if (checked.intent.proofOfLossCid === null) stop('PERSISTED_RECORD_INVALID', 'INTENT_WITHOUT_PROOF_OF_LOSS');
	if (typeof p.intentHash !== 'string' || !HASH.test(p.intentHash)) stop('PERSISTED_RECORD_INVALID', 'INTENT_HASH_FORMAT');
	if (computePurchaseIntentHash(p.intent) !== p.intentHash) stop('PERSISTED_RECORD_INVALID', 'INTENT_HASH_MISMATCH');
	if (p.expiresAt !== checked.intent.expiresAt) stop('PERSISTED_RECORD_INVALID', 'EXPIRES_AT');
	if (p.status !== 'BUILT') stop('INVALID_STATUS', `STATUS:${p.status}`);
	if (p.txHash !== null) stop('PERSISTED_RECORD_INVALID', 'TX_HASH_ALREADY_SET');
	if (p.coverId !== null) stop('PERSISTED_RECORD_INVALID', 'COVER_ID_ALREADY_SET');
	if (typeof p.calldataHash !== 'string' || !HASH.test(p.calldataHash)) stop('PERSISTED_RECORD_INVALID', 'CALLDATA_HASH_FORMAT');
	if (!isTime(p.builtAt) || !isTime(p.buildDeadline)) stop('PERSISTED_RECORD_INVALID', 'BUILD_TIMES');
	if (!(p.buildDeadline > p.builtAt) || p.buildDeadline - p.builtAt > BUILD_WINDOW_SECONDS || p.buildDeadline > p.expiresAt) stop('PERSISTED_RECORD_INVALID', 'BUILD_WINDOW');
	// P4D-Grenzen, beide exklusiv.
	if (!(now < p.expiresAt)) stop('INTENT_EXPIRED');
	if (!(now < p.buildDeadline)) stop('BUILD_DEADLINE_EXPIRED');
	// 60/120: keine Ausfuehrung mit einer Quote oder Kapazitaet, die 60 s oder aelter ist.
	if (!(now < checked.intent.quoteFetchedAt + EXECUTION_QUOTE_MAX_AGE_SECONDS)) stop('QUOTE_STALE_FOR_EXECUTION');
	if (!(now < checked.intent.capacityFetchedAt + EXECUTION_QUOTE_MAX_AGE_SECONDS)) stop('CAPACITY_STALE_FOR_EXECUTION');
	return checked.intent;
}

function freezePurchase(p) {
	return Object.freeze({ ...p, intent: Object.freeze({ ...p.intent }) });
}

const result = (status, { purchase = null, errors = [] } = {}) => Object.freeze({ ok: status === 'LOADED', status, purchase, errors: Object.freeze([...errors]) });

/**
 * Laedt und prueft einen BUILT-Intent fuer die Ausfuehrungs-Vorbereitung.
 * Liefert { ok, status, purchase, errors }; purchase nur bei LOADED.
 */
export async function loadPurchaseForExecution(input) {
	try {
		if (!input || typeof input !== 'object' || Array.isArray(input)) stop('INVALID_INPUT', 'NOT_AN_OBJECT');
		const unknown = Object.keys(input).filter((k) => !INPUT_KEYS.includes(k));
		if (unknown.length) stop('INVALID_INPUT', ...unknown.map((k) => `CLIENT_FIELD:${k}`));
		const { repository, intentId, now } = input;
		if (!isIntentId(intentId)) stop('INVALID_INPUT', 'INTENT_ID');
		if (!isTime(now)) stop('INVALID_INPUT', 'NOW');
		if (!repository || typeof repository !== 'object' || Object.keys(repository).join() !== REPOSITORY_KEYS.join() || typeof repository.loadIntentForExecution !== 'function') stop('INVALID_INPUT', 'REPOSITORY_NOT_NARROW');

		let answer;
		try { answer = await repository.loadIntentForExecution(intentId); } catch { stop('DB_UNAVAILABLE', 'LOAD_FAILED'); }
		if (answer?.status === 'rejected' && answer.code === 'NOT_FOUND') stop('NOT_FOUND');
		if (answer?.status !== 'found' || !answer.intent || typeof answer.intent !== 'object') stop('PERSISTED_RECORD_INVALID', 'ANSWER_SHAPE');
		const row = answer.intent;
		const keys = Object.keys(row);
		const missing = ROW_KEYS.filter((k) => !keys.includes(k)), extra = keys.filter((k) => !ROW_KEYS.includes(k));
		if (missing.length || extra.length) stop('PERSISTED_RECORD_INVALID', ...missing.map((k) => `ROW_MISSING:${k}`), ...extra.map((k) => `ROW_FIELD:${k}`));
		if (row.id !== intentId) stop('PERSISTED_RECORD_INVALID', 'ROW_ID');
		if (row.terms_version !== EXPECTED_TERMS_VERSION) stop('PERSISTED_RECORD_INVALID', 'TERMS_VERSION');

		const purchase = {
			intentId, intent: intentOf(row), intentHash: row.intent_hash, calldataHash: row.calldata_hash, status: row.status,
			builtAt: row.built_at, buildDeadline: row.build_deadline, expiresAt: row.expires_at, txHash: row.tx_hash, coverId: row.cover_id
		};
		checkPurchase(purchase, now);
		return result('LOADED', { purchase: freezePurchase(purchase) });
	} catch (error) {
		if (error instanceof Stop) return result(error.status, { errors: error.errors });
		return result('DB_UNAVAILABLE', { errors: ['UNEXPECTED_LOAD_ERROR'] });
	}
}

/**
 * Prueft ein bereits geladenes Kauf-Modell erneut (fuer jeden spaeteren Schritt; nichts wird
 * aus einem frueheren Ergebnis uebernommen). Liefert { ok, status, intent, errors }.
 */
export function recheckPurchase(purchase, now) {
	try {
		if (!isTime(now)) stop('INVALID_INPUT', 'NOW');
		return Object.freeze({ ok: true, status: 'LOADED', intent: checkPurchase(purchase, now), errors: Object.freeze([]) });
	} catch (error) {
		if (error instanceof Stop) return Object.freeze({ ok: false, status: error.status, intent: null, errors: Object.freeze([...error.errors]) });
		return Object.freeze({ ok: false, status: 'PERSISTED_RECORD_INVALID', intent: null, errors: Object.freeze(['UNEXPECTED']) });
	}
}
