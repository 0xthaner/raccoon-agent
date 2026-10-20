/*
	NEXUS P4J: DAUERHAFTE AUSFUEHRUNGSVERSUCHE (20.10.2026).

	Genau acht Operationen, je EIN Aufruf genau einer festen Funktion aus
	supabase/migrations/20261020160000_cover_purchase_execution_attempts.sql:

	  openExecutionAttempt      -> open_cover_purchase_execution_attempt
	  startWalletRequest        -> start_cover_purchase_execution_attempt
	  recordWalletRejection     -> reject_cover_purchase_execution_attempt
	  recordWalletUncertain     -> mark_cover_purchase_execution_attempt_uncertain
	  bindTransactionHash       -> bind_cover_purchase_execution_attempt_tx_hash
	  reconcileNoTransaction    -> reconcile_cover_purchase_execution_attempt_no_tx
	  submitPurchaseAttempt     -> submit_cover_purchase_execution_attempt
	  settleApprovalAttempt     -> settle_cover_purchase_approval_attempt

	Kein generisches Update, kein SQL, kein Tabellenzugriff, kein frei waehlbarer
	RPC-Name. Der Aufrufer uebergibt einen Client mit rpc(name, args) (supabase-js
	mit service_role); dieses Modul liest keine Umgebung und baut keine Verbindung.

	startWalletRequest liefert WALLET_REQUEST_PERMITTED genau dem einen Gewinner
	des Write-ahead; jede Wiederholung (auch dieselbe Anfrage) erhaelt
	ALREADY_STARTED mit dem aktuellen Zustand und darf die Wallet NICHT rufen.
	WALLET_BUSY: fuer diese Wallet kann noch eine andere Transaktion unterwegs sein.

	Kein Kaufpfad: kein Senden, kein Signieren, keine Wallet, kein Provider. Bis zu
	einer spaeteren Phase importiert nur test/ dieses Modul (P4J-IMPORT).
*/
import { ATTEMPT_STATES, TRANSACTION_KINDS } from './purchase-execution-protocol.mjs';

const HASH = /^0x[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROW_KEYS = Object.freeze(['attempt_id', 'session_id', 'intent_id', 'wallet', 'transaction_kind', 'consumer_request_id', 'state', 'abort_reason', 'tx_hash', 'tx_hash_source',
	'approval_verified_block', 'created_at', 'wallet_request_started_at', 'settled_at'].sort());

const isPlain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const sameKeys = (o, keys) => { const k = Object.keys(o).sort(); return k.length === keys.length && k.every((x, i) => x === keys[i]); };
const out = (status, code = null, attempt = null) => Object.freeze({ status, code, attempt });
/** Genau diese Eingabefelder; jedes weitere (etwa ein tx_hash, eine Wallet, ein Zustand vom Aufrufer) wird abgelehnt. */
function only(input, keys) {
	if (!isPlain(input)) throw new TypeError('INPUT');
	const extra = Object.keys(input).filter((k) => !keys.includes(k));
	if (extra.length) throw new TypeError(`CLIENT_FIELD:${extra.join(',')}`);
	return input;
}

function wantUuid(value, code) { if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError(code); return value; }
function wantBlock(value, code) {
	if (typeof value === 'bigint' && value > 0n && value < 2n ** 63n) return value.toString();
	throw new TypeError(code);
}
function wantAllowance(value) {
	if (typeof value === 'bigint' && value >= 0n) return value.toString();
	throw new TypeError('ALLOWANCE');
}
function wantNonce(value) {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
	throw new TypeError('NONCE');
}

/** Feste Antwortzeile -> eingefrorener Versuch; jede abweichende Form ist ein Fehler, kein Ergebnis. */
function attemptFrom(row, expected) {
	if (!isPlain(row) || !sameKeys(row, ROW_KEYS)) throw new Error('attempt row shape');
	if (!ATTEMPT_STATES.includes(row.state) || !TRANSACTION_KINDS.includes(row.transaction_kind)) throw new Error('attempt row values');
	if (row.tx_hash !== null && !HASH.test(row.tx_hash)) throw new Error('attempt row tx_hash');
	for (const [k, v] of Object.entries(expected)) if (row[k] !== v) throw new Error(`attempt row ${k}`);
	return Object.freeze({
		attemptId: row.attempt_id, sessionId: row.session_id, intentId: row.intent_id, wallet: row.wallet, transactionKind: row.transaction_kind, consumerRequestId: row.consumer_request_id,
		state: row.state, abortReason: row.abort_reason, txHash: row.tx_hash, txHashSource: row.tx_hash_source,
		approvalVerifiedBlock: row.approval_verified_block === null ? null : BigInt(row.approval_verified_block),
		createdAt: row.created_at, walletRequestStartedAt: row.wallet_request_started_at, settledAt: row.settled_at
	});
}

async function call(client, name, args) {
	const { data, error } = await client.rpc(name, args);
	if (error) throw new Error(`${name} failed: ${error.code ?? 'DB_ERROR'}`);
	if (!data || typeof data !== 'object' || typeof data.status !== 'string') throw new Error(`${name} returned no status`);
	return data;
}

/** Normiert die Antwort; Zeilen werden gegen die Eingabe-Kennungen gegengeprueft. */
function result(res, okStatuses, expected) {
	const attempt = res.attempt === undefined ? null : attemptFrom(res.attempt, expected);
	if (okStatuses.includes(res.status)) return out(res.status.toUpperCase(), null, attempt);
	return out(res.status === 'conflict' ? 'CONFLICT' : 'REJECTED', res.code ?? null, attempt);
}

/** Ein Versuch je verbrauchter Sitzung; nur die Anfrage, die die Sitzung verbraucht hat. */
export async function openExecutionAttempt(client, input) {
	const { attemptId, sessionId, consumerRequestId } = only(input, ['attemptId', 'sessionId', 'consumerRequestId']);
	if (typeof attemptId !== 'string' || !UUID_V4.test(attemptId)) throw new TypeError('ATTEMPT_ID');
	const res = await call(client, 'open_cover_purchase_execution_attempt', {
		p_attempt_id: attemptId, p_session_id: wantUuid(sessionId, 'SESSION_ID'), p_consumer_request_id: wantUuid(consumerRequestId, 'REQUEST_ID')
	});
	return result(res, ['created', 'existing'], { session_id: sessionId, consumer_request_id: consumerRequestId });
}

/**
 * Write-ahead vor dem Wallet-Aufruf. Nur WALLET_REQUEST_PERMITTED erlaubt einen (spaeteren) Aufruf -
 * genau einmal je Versuch. ALREADY_STARTED heisst: nicht rufen, Zustand lesen.
 */
export async function startWalletRequest(client, input) {
	const { attemptId, consumerRequestId } = only(input, ['attemptId', 'consumerRequestId']);
	const res = await call(client, 'start_cover_purchase_execution_attempt', { p_attempt_id: wantUuid(attemptId, 'ATTEMPT_ID'), p_consumer_request_id: wantUuid(consumerRequestId, 'REQUEST_ID') });
	const expected = { attempt_id: attemptId, consumer_request_id: consumerRequestId };
	if (res.status === 'started') return out('WALLET_REQUEST_PERMITTED', null, attemptFrom(res.attempt, expected));
	if (res.status === 'not_started') return out('ALREADY_STARTED', res.code ?? null, attemptFrom(res.attempt, expected));
	return out('REJECTED', res.code ?? null, null);
}

/** Ausdrueckliche Ablehnung (4001) vor jedem tx_hash. Beruehrt den Intent nicht. */
export async function recordWalletRejection(client, input) {
	const { attemptId, consumerRequestId } = only(input, ['attemptId', 'consumerRequestId']);
	const res = await call(client, 'reject_cover_purchase_execution_attempt', { p_attempt_id: wantUuid(attemptId, 'ATTEMPT_ID'), p_consumer_request_id: wantUuid(consumerRequestId, 'REQUEST_ID') });
	return result(res, ['recorded', 'existing'], { attempt_id: attemptId, consumer_request_id: consumerRequestId });
}

/** Mehrdeutiges Ergebnis: Timeout, Netzfehler, unbekannte Antwort. */
export async function recordWalletUncertain(client, input) {
	const { attemptId, consumerRequestId } = only(input, ['attemptId', 'consumerRequestId']);
	const res = await call(client, 'mark_cover_purchase_execution_attempt_uncertain', { p_attempt_id: wantUuid(attemptId, 'ATTEMPT_ID'), p_consumer_request_id: wantUuid(consumerRequestId, 'REQUEST_ID') });
	return result(res, ['recorded', 'existing'], { attempt_id: attemptId, consumer_request_id: consumerRequestId });
}

/** Bindet genau einen tx_hash (aus der Wallet-Antwort oder dem Ketten-Abgleich). */
export async function bindTransactionHash(client, input) {
	const { attemptId, consumerRequestId, txHash, source } = only(input, ['attemptId', 'consumerRequestId', 'txHash', 'source']);
	if (typeof txHash !== 'string' || !HASH.test(txHash)) throw new TypeError('TX_HASH');
	if (source !== 'WALLET_RESPONSE' && source !== 'CHAIN_RECONCILIATION') throw new TypeError('SOURCE');
	const res = await call(client, 'bind_cover_purchase_execution_attempt_tx_hash', {
		p_attempt_id: wantUuid(attemptId, 'ATTEMPT_ID'), p_consumer_request_id: wantUuid(consumerRequestId, 'REQUEST_ID'), p_tx_hash: txHash, p_source: source
	});
	return result(res, ['bound', 'existing'], { attempt_id: attemptId, consumer_request_id: consumerRequestId });
}

/** Abgleich ohne Treffer, erst nach der Ruhezeit; Block und Nonce sind Nachweis, keine Berechtigung. */
export async function reconcileNoTransaction(client, input) {
	const { attemptId, consumerRequestId, scannedToBlock, walletNonce } = only(input, ['attemptId', 'consumerRequestId', 'scannedToBlock', 'walletNonce']);
	const res = await call(client, 'reconcile_cover_purchase_execution_attempt_no_tx', {
		p_attempt_id: wantUuid(attemptId, 'ATTEMPT_ID'), p_consumer_request_id: wantUuid(consumerRequestId, 'REQUEST_ID'),
		p_scanned_to_block: wantBlock(scannedToBlock, 'BLOCK'), p_wallet_nonce: wantNonce(walletNonce)
	});
	return result(res, ['recorded', 'existing'], { attempt_id: attemptId, consumer_request_id: consumerRequestId });
}

/** buyCover: P4D SUBMITTED mit dem am Versuch gebundenen Hash (kein Hash vom Aufrufer). */
export async function submitPurchaseAttempt(client, input) {
	const { attemptId, consumerRequestId, intentId, txNonce } = only(input, ['attemptId', 'consumerRequestId', 'intentId', 'txNonce']);
	const res = await call(client, 'submit_cover_purchase_execution_attempt', {
		p_attempt_id: wantUuid(attemptId, 'ATTEMPT_ID'), p_consumer_request_id: wantUuid(consumerRequestId, 'REQUEST_ID'), p_intent_id: wantUuid(intentId, 'INTENT_ID'), p_tx_nonce: wantNonce(txNonce)
	});
	return result(res, ['submitted', 'existing'], { attempt_id: attemptId, consumer_request_id: consumerRequestId, intent_id: intentId });
}

/** Freigabe: nachgepruefte Allowance (VERIFIED) oder FAILED. Beruehrt den Kauf-Intent nie. */
export async function settleApprovalAttempt(client, input) {
	const { attemptId, consumerRequestId, outcome, verifiedAtBlock = null, allowanceRaw = null } = only(input, ['attemptId', 'consumerRequestId', 'outcome', 'verifiedAtBlock', 'allowanceRaw']);
	if (outcome !== 'VERIFIED' && outcome !== 'FAILED') throw new TypeError('OUTCOME');
	const res = await call(client, 'settle_cover_purchase_approval_attempt', {
		p_attempt_id: wantUuid(attemptId, 'ATTEMPT_ID'), p_consumer_request_id: wantUuid(consumerRequestId, 'REQUEST_ID'), p_outcome: outcome,
		p_verified_block: outcome === 'VERIFIED' ? wantBlock(verifiedAtBlock, 'BLOCK') : null,
		p_allowance_raw: outcome === 'VERIFIED' ? wantAllowance(allowanceRaw) : null
	});
	return result(res, ['settled', 'existing'], { attempt_id: attemptId, consumer_request_id: consumerRequestId });
}
