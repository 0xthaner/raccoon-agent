/*
	NEXUS P4G: SERVERSEITIGE BESTAETIGUNG NUR NACH UNABHAENGIGER BELEG-PRUEFUNG (20.10.2026).

	Ein gespeicherter Kauf-Intent wird nur dann CONFIRMED, wenn der P4E-Pruefer
	(verifyPurchaseReceipt) fuer GENAU diesen Intent und GENAU dessen gespeicherte
	Transaktion VERIFIED_COVER_PURCHASE geliefert hat - frisch, in diesem Aufruf.

	  SUBMITTED (aus der Datenbank) -> verifyPurchaseReceipt -> nur VERIFIED -> markConfirmed

	Hoheit: Intent, Wallet, txHash, calldataHash, Produkt, Asset, Betrag, Laufzeit,
	PoL-CID, Kommission und Terms-Hash kommen ausschliesslich aus dem gespeicherten
	Datensatz, den das injizierte Repository liefert; die Cover-ID ausschliesslich aus
	dem Pruefer. Der Aufrufer nennt nur intentId. Jeder weitere Schluessel
	(txHash, coverId, receipt, logs, verdict, ...) fuehrt zu INVALID_INPUT.

	Schmal: das Repository hat genau zwei Methoden, loadIntentById(id) und
	markConfirmed({ id, txHash, coverId }) (P4D, SUBMITTED -> CONFIRMED). Kein
	generisches Update, kein SQL, kein FAILED, kein spaetes Bestaetigen (der P4D-Pfad
	FAILED -> CONFIRMED bleibt getrennt und ist hier nicht erreichbar).

	Nicht bestaetigt heisst: keine Schreiboperation. Unsicherheit der Infrastruktur
	(Leserausfall, Uneinigkeit, zu wenige Bestaetigungen, Transaktion oder Beleg noch
	nicht sichtbar, Reorg) bleibt SUBMITTED und ist wiederholbar; jede andere
	Abweichung ebenfalls SUBMITTED, aber als NOT_VERIFIED zur Pruefung. FAILED setzt
	diese Phase nie.

	Finalitaet: fest die P4E-Produktionspolitik (finalisiert UND >= 64 Bestaetigungen);
	der Aufrufer kann sie nicht senken. Kein Zwischenspeicher fuer Pruefergebnisse.

	Kein Kaufpfad: keine Route, kein Cron, keine Wallet, kein Senden, kein Signieren,
	kein Builder. Bis zu einer spaeteren Phase importiert nur test/ dieses Modul (P4G-IMPORT).
*/
import { validatePurchaseIntent, computePurchaseIntentHash, isIntentId } from './purchase-intent.mjs';
import { verifyPurchaseReceipt, PRODUCTION_CONFIRMATION_POLICY, REQUIRED_CHECKS } from './purchase-receipt.mjs';

/** Fest: die dokumentierte P4E-Produktionspolitik. Kein Parameter, keine Testabkuerzung. */
export const CONFIRMATION_POLICY = PRODUCTION_CONFIRMATION_POLICY;

export const CONFIRMATION_STATUSES = Object.freeze([
	'CONFIRMED', 'ALREADY_CONFIRMED', 'INVALID_INPUT', 'INTENT_NOT_FOUND', 'INVALID_STATUS', 'PERSISTED_RECORD_INVALID',
	'UNRESOLVED_RETRYABLE', 'NOT_VERIFIED', 'DB_UNAVAILABLE', 'DB_CONFIRMATION_CONFLICT'
]);

/** P4E-Ergebnisse, die nur Unsicherheit bedeuten: SUBMITTED bleibt, spaeter erneut pruefen. */
export const RETRYABLE_VERIFIER_STATUSES = Object.freeze(['TEMPORARY_RPC_FAILURE', 'RPC_DISAGREEMENT', 'INSUFFICIENT_CONFIRMATIONS', 'TX_NOT_FOUND', 'RECEIPT_NOT_FOUND', 'BLOCK_HASH_MISMATCH']);

const INPUT_KEYS = Object.freeze(['repository', 'rpcA', 'rpcB', 'intentId']);
const REPOSITORY_KEYS = Object.freeze(['loadIntentById', 'markConfirmed']);
const RECORD_KEYS = Object.freeze(['id', 'status', 'late', 'intent', 'intentHash', 'calldataHash', 'txHash', 'coverId']);
const STATUSES = Object.freeze(['OPEN', 'BUILT', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED']);
const HASH = /^0x[0-9a-f]{64}$/;

/** Positive Cover-ID als bigint (Zahl oder Dezimal-String, wie die Datenbank sie liefert), sonst null. */
function coverIdOf(value) {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
	if (typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)) return BigInt(value);
	return null;
}

function outcome(status, { intentId = null, txHash = null, coverId = null, dbWrite = 'NONE', verdict = null, errors = [] } = {}) {
	return Object.freeze({
		ok: status === 'CONFIRMED' || status === 'ALREADY_CONFIRMED',
		status,
		retryable: status === 'UNRESOLVED_RETRYABLE' || status === 'DB_UNAVAILABLE',
		intentId,
		txHash,
		coverId: coverId === null ? null : coverId.toString(),
		dbWrite,
		verifier: verdict === null ? null : Object.freeze({
			ok: verdict.ok === true, status: String(verdict.status),
			blockNumber: typeof verdict.blockNumber === 'bigint' ? verdict.blockNumber.toString() : null,
			blockHash: typeof verdict.blockHash === 'string' ? verdict.blockHash : null,
			errors: Object.freeze(Array.isArray(verdict.errors) ? verdict.errors.map(String) : [])
		}),
		errors: Object.freeze([...errors])
	});
}

/**
 * Das Tor: nur ein vollstaendiges, positives P4E-Ergebnis liefert eine Cover-ID.
 * ok === true UND status VERIFIED_COVER_PURCHASE UND jede Pflichtpruefung bestanden UND
 * keine Fehler UND eine positive Cover-ID am festgestellten Block. Sonst null.
 */
export function confirmableCoverId(verdict) {
	if (!verdict || typeof verdict !== 'object') return null;
	if (verdict.ok !== true || verdict.status !== 'VERIFIED_COVER_PURCHASE') return null;
	if (!Array.isArray(verdict.errors) || verdict.errors.length !== 0) return null;
	if (!verdict.checks || REQUIRED_CHECKS.some((c) => verdict.checks[c] !== true)) return null;
	if (typeof verdict.blockNumber !== 'bigint' || typeof verdict.blockHash !== 'string' || !HASH.test(verdict.blockHash)) return null;
	if (typeof verdict.coverId !== 'bigint' || verdict.coverId <= 0n) return null;
	return verdict.coverId;
}

function inputErrors(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return ['NOT_AN_OBJECT'];
	const errors = Object.keys(input).filter((k) => !INPUT_KEYS.includes(k)).map((k) => `CLIENT_FIELD:${k}`);
	if (!isIntentId(input.intentId)) errors.push('INTENT_ID');
	const repo = input.repository;
	if (!repo || typeof repo !== 'object' || Object.keys(repo).sort().join() !== [...REPOSITORY_KEYS].sort().join() || REPOSITORY_KEYS.some((k) => typeof repo[k] !== 'function')) errors.push('REPOSITORY_NOT_NARROW');
	return errors;
}

/** Der gespeicherte Datensatz muss in sich stimmig sein und genau zum angefragten Intent gehoeren. */
function recordErrors(record, intentId) {
	if (!record || typeof record !== 'object' || Array.isArray(record)) return ['RECORD_NOT_OBJECT'];
	const errors = Object.keys(record).filter((k) => !RECORD_KEYS.includes(k)).map((k) => `RECORD_FIELD:${k}`);
	if (record.id !== intentId) errors.push('RECORD_ID');
	if (!STATUSES.includes(record.status)) errors.push('RECORD_STATUS');
	if (typeof record.late !== 'boolean') errors.push('RECORD_LATE');
	const checked = validatePurchaseIntent(record.intent);
	if (!checked.ok) errors.push('RECORD_INTENT');
	else {
		if (checked.intent.id !== intentId) errors.push('RECORD_INTENT_ID');
		if (checked.intent.proofOfLossCid === null) errors.push('RECORD_WITHOUT_PROOF_OF_LOSS');
		if (record.intentHash !== computePurchaseIntentHash(record.intent)) errors.push('RECORD_INTENT_HASH');
	}
	return errors;
}

/**
 * Bestaetigt einen gespeicherten SUBMITTED-Intent, wenn und nur wenn die frische,
 * unabhaengige P4E-Pruefung seiner gespeicherten Transaktion VERIFIED_COVER_PURCHASE
 * ergibt. Liefert ein eingefrorenes Ergebnis; sendet, signiert und loescht nie.
 */
export async function confirmVerifiedPurchase(input) {
	const bad = inputErrors(input);
	if (bad.length) return outcome('INVALID_INPUT', { errors: bad });
	const { repository, rpcA, rpcB, intentId } = input;

	let record;
	try { record = await repository.loadIntentById(intentId); } catch { return outcome('DB_UNAVAILABLE', { intentId, errors: ['LOAD_FAILED'] }); }
	if (record === null || record === undefined) return outcome('INTENT_NOT_FOUND', { intentId });
	const broken = recordErrors(record, intentId);
	if (broken.length) return outcome('PERSISTED_RECORD_INVALID', { intentId, errors: broken });

	// Bereits endgueltig: nur eine in sich stimmige, normale Bestaetigung wird gemeldet; keine Kette, keine Schreiboperation.
	if (record.status === 'CONFIRMED') {
		const done = coverIdOf(record.coverId);
		if (record.late || done === null || typeof record.txHash !== 'string' || !HASH.test(record.txHash)) return outcome('INVALID_STATUS', { intentId, errors: ['CONFIRMED_NOT_EXACT'] });
		return outcome('ALREADY_CONFIRMED', { intentId, txHash: record.txHash, coverId: done });
	}
	if (record.status !== 'SUBMITTED') return outcome('INVALID_STATUS', { intentId, errors: [`STATUS:${record.status}`] });

	// Bindung: genau der tx_hash und calldata_hash DIESES Datensatzes, noch ohne Cover-ID.
	const bound = [];
	if (typeof record.txHash !== 'string' || !HASH.test(record.txHash)) bound.push('RECORD_TX_HASH');
	if (typeof record.calldataHash !== 'string' || !HASH.test(record.calldataHash)) bound.push('RECORD_CALLDATA_HASH');
	if (record.coverId !== null || record.late !== false) bound.push('RECORD_NOT_PENDING');
	if (bound.length) return outcome('PERSISTED_RECORD_INVALID', { intentId, errors: bound });
	const { txHash, calldataHash } = record;

	// Frische, unabhaengige Pruefung; Leser-Unabhaengigkeit und Zwei-Leser-Politik verantwortet P4E.
	let verdict;
	try {
		verdict = await verifyPurchaseReceipt({ rpcA, rpcB, intent: record.intent, txHash, calldataHash, minConfirmations: CONFIRMATION_POLICY.minConfirmations, requireFinalized: CONFIRMATION_POLICY.requireFinalized });
	} catch {
		return outcome('UNRESOLVED_RETRYABLE', { intentId, txHash, errors: ['VERIFIER_THREW'] });
	}
	const coverId = confirmableCoverId(verdict);
	if (coverId === null) {
		const retry = RETRYABLE_VERIFIER_STATUSES.includes(verdict?.status);
		return outcome(retry ? 'UNRESOLVED_RETRYABLE' : 'NOT_VERIFIED', { intentId, txHash, verdict: verdict && typeof verdict === 'object' ? verdict : null });
	}

	// P4D: SUBMITTED -> CONFIRMED (Compare-and-Set auf id, Status und tx_hash). Die Cover-ID kommt nur vom Pruefer.
	let db;
	try { db = await repository.markConfirmed({ id: intentId, txHash, coverId: coverId.toString() }); } catch {
		return outcome('DB_UNAVAILABLE', { intentId, txHash, verdict, errors: ['CONFIRM_WRITE_FAILED'] });
	}
	const row = db?.intent;
	const exact = (db?.status === 'confirmed' || db?.status === 'existing') && row && row.id === intentId && row.status === 'CONFIRMED'
		&& row.tx_hash === txHash && row.late === false && coverIdOf(row.cover_id) === coverId;
	if (!exact) return outcome('DB_CONFIRMATION_CONFLICT', { intentId, txHash, verdict, errors: [`DB:${db?.status ?? 'NO_STATUS'}:${db?.code ?? (row ? 'ROW_MISMATCH' : 'NO_ROW')}`] });
	return outcome('CONFIRMED', { intentId, txHash, coverId, dbWrite: db.status === 'confirmed' ? 'CONFIRMED' : 'EXISTING', verdict });
}
