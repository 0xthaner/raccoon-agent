/*
	NEXUS P4I: DAUERHAFTE, EINMAL NUTZBARE AUSFUEHRUNGS-SITZUNGEN (20.10.2026).

	Genau zwei Operationen, je EIN Aufruf genau einer festen Funktion aus
	supabase/migrations/20261020140000_cover_purchase_execution_sessions.sql:

	  persistExecutionSession  -> create_cover_purchase_execution_session
	  consumeExecutionSession  -> consume_cover_purchase_execution_session

	Kein generisches Update, kein SQL, kein Tabellenzugriff, kein frei waehlbarer
	RPC-Name. Der Aufrufer uebergibt einen Client mit rpc(name, args) (supabase-js
	mit service_role); dieses Modul liest keine Umgebung und baut keine Verbindung.

	Hash-Hoheit: der Sitzungs-Hash wird HIER aus den kanonischen P4H-Feldern neu
	berechnet (computeExecutionSessionHash) und nur dieser Wert gespeichert. Ein
	mitgelieferter Hash, der nicht passt, wird abgelehnt (nie uebernommen). Beim
	Verbrauch wird der Hash aus der zurueckgegebenen Zeile erneut berechnet und mit
	dem erwarteten und dem gespeicherten verglichen.

	Einmal-Nutzung: von der Datenbank durchgesetzt (EIN Compare-and-Set-UPDATE,
	Ablauf in SQL, hoechstens eine offene Sitzung je Intent, hoechstens eine
	verbrauchte je Intent und Art). Wiederholung derselben Anfrage (gleiche
	consumerRequestId) liefert denselben verbrauchten Datensatz als
	IDEMPOTENT_REPLAY - das ist KEINE zweite Berechtigung; eine andere Anfrage
	erhaelt ALREADY_CONSUMED.

	Vom Client kommt hier nichts ausser Kennungen: beim Verbrauch sessionId,
	intentId und consumerRequestId; der erwartete Sitzungs-Hash ist ein
	serverseitig gehaltener Wert (Ergebnis von persistExecutionSession).

	Kein Kaufpfad: kein Senden, kein Signieren, keine Wallet, kein Provider, keine
	neue Transaktion; die Bytes werden nur unveraendert zurueckgegeben. Bis zu einer
	spaeteren Phase importiert nur test/ dieses Modul (P4I-IMPORT).
*/
import { keccak256 } from 'viem';
import { computeExecutionSessionHash, TRANSACTION_KINDS } from './purchase-execution-session.mjs';

/** Ehrliche Bezeichnung: durchgesetzt in der Datenbank, nicht nur modelliert. */
export const SINGLE_USE_ENFORCEMENT = 'PERSISTED_DB_COMPARE_AND_SET';
export const CONSUME_STATUSES = Object.freeze(['CONSUMED', 'IDEMPOTENT_REPLAY', 'ALREADY_CONSUMED', 'REJECTED', 'CONFLICT']);

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DATA = /^0x(?:[0-9a-f]{2}){4,4096}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Genau die Felder einer P4H-Sitzung (createExecutionSession). */
const SESSION_KEYS = Object.freeze(['sessionId', 'intentId', 'intentHash', 'calldataHash', 'wallet', 'chainId', 'transactionKind', 'to', 'value', 'data', 'verifiedAtBlock',
	'verifiedAtBlockHash', 'expiresAt', 'dataHash', 'createdAt', 'singleUse', 'singleUseEnforcement', 'executionSessionHash', 'toctou'].sort());
const CONSUME_KEYS = Object.freeze(['sessionId', 'sessionHash', 'intentId', 'consumerRequestId'].sort());
/** Genau die Spalten der festen JSON-Antwort. */
const ROW_KEYS = Object.freeze(['session_id', 'intent_id', 'session_hash', 'intent_hash', 'calldata_hash', 'wallet', 'chain_id', 'transaction_kind', 'target', 'value_raw', 'data',
	'verified_block', 'verified_block_hash', 'created_at', 'expires_at', 'consumed_at', 'consumer_request_id'].sort());

const isPlain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const sameKeys = (o, keys) => { const k = Object.keys(o).sort(); return k.length === keys.length && k.every((x, i) => x === keys[i]); };
const rejected = (code) => Object.freeze({ status: 'rejected', code });

async function call(client, name, args) {
	const { data, error } = await client.rpc(name, args);
	if (error) throw new Error(`${name} failed: ${error.code ?? 'DB_ERROR'}`);
	if (!data || typeof data !== 'object' || typeof data.status !== 'string') throw new Error(`${name} returned no status`);
	return data;
}

/** Kanonische P4H-Felder pruefen; liefert die Felder fuer den Hash oder einen Fehlercode. */
function canonicalFields(s) {
	if (!isPlain(s) || !sameKeys(s, SESSION_KEYS)) return { error: 'SESSION_SHAPE' };
	if (!UUID_V4.test(s.sessionId) || !UUID.test(s.intentId)) return { error: 'ID' };
	if (![s.intentHash, s.calldataHash, s.verifiedAtBlockHash, s.executionSessionHash, s.dataHash].every((h) => typeof h === 'string' && HASH.test(h))) return { error: 'HASH_FORMAT' };
	if (typeof s.wallet !== 'string' || !ADDRESS.test(s.wallet) || typeof s.to !== 'string' || !ADDRESS.test(s.to)) return { error: 'ADDRESS' };
	if (s.chainId !== 1 || s.value !== 0n || !Object.hasOwn(TRANSACTION_KINDS, s.transactionKind)) return { error: 'FIELD' };
	if (typeof s.data !== 'string' || !DATA.test(s.data) || keccak256(s.data) !== s.dataHash) return { error: 'DATA' };
	if (typeof s.verifiedAtBlock !== 'bigint' || s.verifiedAtBlock <= 0n || s.verifiedAtBlock >= 2n ** 63n) return { error: 'BLOCK' };
	if (!Number.isSafeInteger(s.expiresAt) || s.expiresAt <= 0 || !Number.isSafeInteger(s.createdAt) || !(s.expiresAt > s.createdAt) || s.expiresAt - s.createdAt > 30) return { error: 'WINDOW' };
	if (s.singleUse !== true) return { error: 'SINGLE_USE' };
	// buyCover: die Bytes sind ueber den gespeicherten calldata_hash an den Build gebunden
	if (s.transactionKind === 'NEXUS_BUY_COVER' && keccak256(s.data) !== s.calldataHash) return { error: 'CALLDATA_HASH_MISMATCH' };
	const fields = {
		sessionId: s.sessionId, intentId: s.intentId, intentHash: s.intentHash, calldataHash: s.calldataHash, wallet: s.wallet, chainId: 1, transactionKind: s.transactionKind,
		to: s.to, value: 0n, data: s.data, verifiedAtBlock: s.verifiedAtBlock, verifiedAtBlockHash: s.verifiedAtBlockHash, expiresAt: s.expiresAt
	};
	return { fields, hash: computeExecutionSessionHash(fields) };
}

/** Feste Antwortzeile -> kanonische Felder; der Hash wird aus der Zeile neu berechnet. */
function fromRow(row) {
	if (!isPlain(row) || !sameKeys(row, ROW_KEYS)) return null;
	if (![row.session_hash, row.intent_hash, row.calldata_hash, row.verified_block_hash].every((h) => typeof h === 'string' && HASH.test(h))) return null;
	if (typeof row.data !== 'string' || !DATA.test(row.data) || !ADDRESS.test(row.wallet) || !ADDRESS.test(row.target)) return null;
	if (row.chain_id !== 1 || row.value_raw !== '0' || !Object.hasOwn(TRANSACTION_KINDS, row.transaction_kind)) return null;
	if (typeof row.verified_block !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.verified_block) || !Number.isSafeInteger(row.expires_at)) return null;
	const fields = {
		sessionId: row.session_id, intentId: row.intent_id, intentHash: row.intent_hash, calldataHash: row.calldata_hash, wallet: row.wallet, chainId: 1,
		transactionKind: row.transaction_kind, to: row.target, value: 0n, data: row.data, verifiedAtBlock: BigInt(row.verified_block),
		verifiedAtBlockHash: row.verified_block_hash, expiresAt: row.expires_at
	};
	let recomputed;
	try { recomputed = computeExecutionSessionHash(fields); } catch { return null; }
	if (recomputed !== row.session_hash) return null;
	return Object.freeze({ ...fields, executionSessionHash: recomputed, createdAt: row.created_at, consumedAt: row.consumed_at, consumerRequestId: row.consumer_request_id });
}

/**
 * Speichert eine P4H-Sitzung (Ergebnis von createExecutionSession). Der Hash wird neu berechnet; ein
 * abweichender mitgelieferter Hash ist TAMPERED. Liefert die Datenbankantwort (created / existing /
 * conflict / rejected) und bei Erfolg den gespeicherten, gegengeprueften Hash.
 */
export async function persistExecutionSession(client, { session } = {}) {
	const c = canonicalFields(session);
	if (c.error) return rejected(c.error);
	if (session.executionSessionHash !== c.hash) return rejected('TAMPERED');
	const f = c.fields;
	const res = await call(client, 'create_cover_purchase_execution_session', {
		p_session_id: f.sessionId, p_intent_id: f.intentId, p_session_hash: c.hash, p_intent_hash: f.intentHash, p_calldata_hash: f.calldataHash,
		p_wallet: f.wallet, p_chain_id: 1, p_transaction_kind: f.transactionKind, p_target: f.to, p_value_raw: '0', p_data: f.data,
		p_verified_block: f.verifiedAtBlock.toString(), p_verified_block_hash: f.verifiedAtBlockHash, p_expires_at: f.expiresAt
	});
	if (res.status !== 'created' && res.status !== 'existing') return Object.freeze({ status: res.status, code: res.code });
	const stored = fromRow(res.session);
	if (!stored || stored.executionSessionHash !== c.hash) throw new Error('create_cover_purchase_execution_session returned another session');
	return Object.freeze({ status: res.status, sessionHash: c.hash, session: stored });
}

/**
 * Verbraucht eine gespeicherte Sitzung genau einmal. Eingaben nur Kennungen und der serverseitig
 * gehaltene Hash. CONSUMED oder IDEMPOTENT_REPLAY (dieselbe consumerRequestId) liefern die
 * gespeicherten, neu gehashten Sitzungsfakten - unveraendert, nichts wird gesendet.
 */
export async function consumeExecutionSession(client, input) {
	if (!isPlain(input) || !sameKeys(input, CONSUME_KEYS)) return Object.freeze({ status: 'REJECTED', code: 'INPUT_SHAPE', session: null });
	const { sessionId, sessionHash, intentId, consumerRequestId } = input;
	if (typeof sessionId !== 'string' || !UUID.test(sessionId) || typeof intentId !== 'string' || !UUID.test(intentId) || typeof consumerRequestId !== 'string' || !UUID.test(consumerRequestId)) {
		return Object.freeze({ status: 'REJECTED', code: 'ID', session: null });
	}
	if (typeof sessionHash !== 'string' || !HASH.test(sessionHash)) return Object.freeze({ status: 'REJECTED', code: 'HASH_FORMAT', session: null });
	const res = await call(client, 'consume_cover_purchase_execution_session', {
		p_session_id: sessionId, p_session_hash: sessionHash, p_intent_id: intentId, p_consumer_request_id: consumerRequestId
	});
	if (res.status === 'consumed' || res.status === 'existing') {
		const s = fromRow(res.session);
		if (!s || s.executionSessionHash !== sessionHash || s.sessionId !== sessionId || s.intentId !== intentId || s.consumerRequestId !== consumerRequestId) {
			throw new Error('consume_cover_purchase_execution_session returned another session');
		}
		return Object.freeze({ status: res.status === 'consumed' ? 'CONSUMED' : 'IDEMPOTENT_REPLAY', code: null, session: s });
	}
	if (res.status === 'conflict' && res.code === 'ALREADY_CONSUMED') return Object.freeze({ status: 'ALREADY_CONSUMED', code: res.code, session: null });
	return Object.freeze({ status: res.status === 'conflict' ? 'CONFLICT' : 'REJECTED', code: res.code ?? null, session: null });
}
