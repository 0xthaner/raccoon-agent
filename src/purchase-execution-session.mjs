/*
	NEXUS P4H: KURZLEBIGE AUSFUEHRUNGS-SITZUNG, OHNE SENDEN (20.10.2026).

	Die serverseitige Grenze, die ein spaeterer Wallet-Pfad benutzen muss:

	  BUILT-Intent (fester DB-Lader) -> P4F verifyPurchasePreSend -> unabhaengiger
	  P4C-Decoder -> Sitzung mit executionSessionHash -> (noch) KEIN Senden

	Eine Sitzung bindet deterministisch (feste ABI-Kodierung + keccak256, Domaene
	coverraccoon.execution-session, Version 1) intentId, intentHash, calldataHash,
	Wallet, chainId, Art, Ziel, value, data, verifiedAtBlock, verifiedAtBlockHash,
	expiresAt und die sessionId. Sie entsteht nur, wenn der gespeicherte Intent
	weiterhin BUILT, unabgelaufen und vor seiner Build-Deadline ist, P4F fuer genau
	diesen Intent PRE_SEND_VERIFIED mit Block und Block-Hash geliefert hat und der
	unabhaengige Decoder die Bytes Feld fuer Feld gegen den Intent bestaetigt (bei
	buyCover zusaetzlich keccak256(data) == gespeicherter calldata_hash). Der Builder
	wird nie importiert und seiner Ausgabe nie vertraut.

	Laufzeit: hoechstens SESSION_TTL_SECONDS und nie nach build_deadline oder
	expires_at; ohne positives Fenster keine Sitzung, keine Verlaengerung.

	Einmal-Nutzung: hier nur MODELLIERT (checkSessionUse mit einer vom Aufrufer
	gefuehrten Menge verbrauchter Hashes). Das ist KEINE Durchsetzung; die gehoert
	in den Wallet-Schritt mit dauerhafter Speicherung.

	Restrisiko (TOCTOU): P4F hat die Vertrags-Pins am verifiedAtBlock geprueft, die
	Sitzung bindet diesen Block und Hash. Bis zum Mining kann sich die Kette
	trotzdem aendern (Proxy-Upgrade, USDC-Pause, Reorg); P4E prueft nach der
	Ausfuehrung den Zustand am Ausfuehrungsblock.

	Kein Kaufpfad: kein Senden, kein Signieren, keine Wallet, kein Provider. Bis zu
	einer spaeteren Phase importiert nur test/ dieses Modul (P4H-IMPORT).
*/
import { encodeAbiParameters, keccak256 } from 'viem';
import { decodeUsdcApproval, decodeNexusBuyCover, validateDecodedAgainstIntent } from './purchase-tx-decode.mjs';
import { verifyPurchasePreSend, PRE_SEND_CHECKS, PRE_SEND_PINS } from './purchase-pre-send.mjs';
import { loadPurchaseForExecution, recheckPurchase } from './purchase-runtime-loader.mjs';

export const EXECUTION_SESSION_DOMAIN = 'coverraccoon.execution-session';
export const EXECUTION_SESSION_VERSION = 1;
/** Hoechstens 30 Sekunden; nie nach build_deadline oder expires_at. */
export const SESSION_TTL_SECONDS = 30;
/** Ehrliche Bezeichnung: Einmal-Nutzung ist nur modelliert, nicht dauerhaft durchgesetzt. */
export const SINGLE_USE_ENFORCEMENT = 'MODEL_ONLY_NOT_PERSISTED';
export const TRANSACTION_KINDS = Object.freeze({ USDC_APPROVAL: 1, NEXUS_BUY_COVER: 2 });
export const SESSION_STATUSES = Object.freeze([
	'SESSION_CREATED', 'INVALID_INPUT', 'PURCHASE_REJECTED', 'PRE_SEND_NOT_VERIFIED', 'TRANSACTION_REJECTED', 'CALLDATA_HASH_MISMATCH', 'NO_SESSION_WINDOW'
]);
export const TOCTOU_RESIDUAL = 'NOT eliminated: P4F verified the contract pins at verifiedAtBlock and the session binds that block and hash, but the chain can still change before mining (proxy upgrade, USDC pause, reorg); P4E re-checks the state at the execution block after the transaction.';

const CREATE_KEYS = Object.freeze(['purchase', 'preSendVerdict', 'transaction', 'now', 'sessionId']);
const PREPARE_KEYS = Object.freeze(['repository', 'rpcA', 'rpcB', 'intentId', 'transaction', 'now', 'sessionId']);
const TX_KEYS = Object.freeze(['kind', 'chainId', 'to', 'value', 'data']);
const HASH = /^0x[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isTime = (t) => Number.isSafeInteger(t) && t > 0;
/** Die Pins, die P4F an genau diesem Block beobachtet haben muss. */
const EXPECTED_PINS = Object.freeze({
	brokerCodeHash: PRE_SEND_PINS.brokerCodeHash, coverProxyCodeHash: PRE_SEND_PINS.coverProxyCodeHash, coverImplementation: PRE_SEND_PINS.coverImplementation,
	coverImplementationCodeHash: PRE_SEND_PINS.coverImplementationCodeHash, usdcProxyCodeHash: PRE_SEND_PINS.usdc.proxyCodeHash,
	usdcImplementation: PRE_SEND_PINS.usdc.implementation, usdcImplementationCodeHash: PRE_SEND_PINS.usdc.implementationCodeHash
});

const SESSION_HASH_TYPES = [
	{ type: 'string' }, { type: 'uint8' }, { type: 'bytes16' }, { type: 'bytes16' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' },
	{ type: 'uint8' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint64' }
];
const uuidBytes = (id) => `0x${id.replaceAll('-', '')}`;

/**
 * executionSessionHash = keccak256(abi.encode(domain, version, sessionId, intentId, intentHash, calldataHash,
 * wallet, chainId, kind, to, value, data, verifiedAtBlock, verifiedAtBlockHash, expiresAt)). Feste Typen, kein JSON.
 */
export function computeExecutionSessionHash(s) {
	return keccak256(encodeAbiParameters(SESSION_HASH_TYPES, [
		EXECUTION_SESSION_DOMAIN, EXECUTION_SESSION_VERSION, uuidBytes(s.sessionId), uuidBytes(s.intentId), s.intentHash, s.calldataHash,
		s.wallet, BigInt(s.chainId), TRANSACTION_KINDS[s.transactionKind], s.to, s.value, s.data, s.verifiedAtBlock, s.verifiedAtBlockHash, BigInt(s.expiresAt)
	]));
}

/** Nur ein vollstaendiges P4F-Urteil mit Block, Block-Hash und den erwarteten Pins zaehlt. */
function verdictErrors(v) {
	if (!v || typeof v !== 'object') return ['VERDICT_SHAPE'];
	const errors = [];
	if (v.ok !== true || v.status !== 'PRE_SEND_VERIFIED') errors.push(`PRE_SEND_STATUS:${v.status}`);
	if (!Array.isArray(v.errors) || v.errors.length !== 0) errors.push('PRE_SEND_ERRORS');
	if (!v.checks || PRE_SEND_CHECKS.some((c) => v.checks[c] !== true)) errors.push('PRE_SEND_CHECKS');
	if (typeof v.verifiedAtBlock !== 'bigint' || v.verifiedAtBlock <= 0n) errors.push('VERIFIED_AT_BLOCK');
	if (typeof v.verifiedAtBlockHash !== 'string' || !HASH.test(v.verifiedAtBlockHash)) errors.push('VERIFIED_AT_BLOCK_HASH');
	const pins = v.contractPins;
	if (!pins || Object.keys(EXPECTED_PINS).some((k) => pins[k] !== EXPECTED_PINS[k])) errors.push('CONTRACT_PINS');
	return errors;
}

/** Unabhaengige Pruefung der Bytes; buyCover zusaetzlich gegen den gespeicherten calldata_hash. */
function transactionErrors(tx, purchase) {
	if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return { status: 'TRANSACTION_REJECTED', errors: ['TX_NOT_OBJECT'] };
	const extra = Object.keys(tx).filter((k) => !TX_KEYS.includes(k));
	if (extra.length) return { status: 'TRANSACTION_REJECTED', errors: extra.map((k) => `TX_FIELD:${k}`) };
	if (!Object.hasOwn(TRANSACTION_KINDS, tx.kind)) return { status: 'TRANSACTION_REJECTED', errors: ['TX_KIND'] };
	if (tx.kind === 'USDC_APPROVAL') {
		const decoded = decodeUsdcApproval(tx);
		if (!decoded.ok) return { status: 'TRANSACTION_REJECTED', errors: decoded.errors };
		const semantic = validateDecodedAgainstIntent(tx, purchase.intent, null);
		return semantic.ok ? null : { status: 'TRANSACTION_REJECTED', errors: semantic.errors };
	}
	if (typeof tx.data !== 'string' || keccak256(tx.data) !== purchase.calldataHash) return { status: 'CALLDATA_HASH_MISMATCH', errors: ['CALLDATA_HASH_MISMATCH'] };
	const decoded = decodeNexusBuyCover(tx);
	if (!decoded.ok) return { status: 'TRANSACTION_REJECTED', errors: decoded.errors };
	// Allokationen aus den Bytes selbst; sie sind ueber den gespeicherten calldata_hash an den Build gebunden.
	const allocations = decoded.call.allocations.map((a) => ({ poolId: a.poolId.toString(), coverAmountInAsset: a.coverAmountInAsset.toString() }));
	const total = decoded.call.allocations.reduce((sum, a) => sum + a.coverAmountInAsset, 0n);
	const semantic = validateDecodedAgainstIntent(tx, purchase.intent, { premiumRaw: String(purchase.intent.quotePremiumRaw), quoteTotalCoverAmountRaw: total.toString(), allocations });
	return semantic.ok ? null : { status: 'TRANSACTION_REJECTED', errors: semantic.errors };
}

const outcome = (status, { session = null, errors = [], preSend = null } = {}) => Object.freeze({ ok: status === 'SESSION_CREATED', status, session, preSend, errors: Object.freeze([...errors]) });

/**
 * Reiner Schritt: bildet aus einem geladenen BUILT-Kauf, einem P4F-Urteil und den Server-Bytes eine
 * Sitzung. Prueft alles selbst neu. Laufzeitgrenze ist prepareExecutionSession, die P4F fuer genau
 * diesen Kauf ausfuehrt; dieser Schritt allein kann ein Urteil nicht an einen Intent binden.
 */
export function createExecutionSession(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return outcome('INVALID_INPUT', { errors: ['NOT_AN_OBJECT'] });
	const unknown = Object.keys(input).filter((k) => !CREATE_KEYS.includes(k));
	if (unknown.length) return outcome('INVALID_INPUT', { errors: unknown.map((k) => `CLIENT_FIELD:${k}`) });
	const { purchase, preSendVerdict, transaction, now, sessionId } = input;
	if (!isTime(now)) return outcome('INVALID_INPUT', { errors: ['NOW'] });
	if (typeof sessionId !== 'string' || !UUID_V4.test(sessionId)) return outcome('INVALID_INPUT', { errors: ['SESSION_ID'] });

	const recheck = recheckPurchase(purchase, now);
	if (!recheck.ok) return outcome('PURCHASE_REJECTED', { errors: [recheck.status, ...recheck.errors] });
	const intent = recheck.intent;

	const vErrors = verdictErrors(preSendVerdict);
	if (vErrors.length) return outcome('PRE_SEND_NOT_VERIFIED', { errors: vErrors });

	const txProblem = transactionErrors(transaction, purchase);
	if (txProblem) return outcome(txProblem.status, { errors: txProblem.errors });

	const expiresAt = Math.min(now + SESSION_TTL_SECONDS, purchase.buildDeadline, purchase.expiresAt);
	if (!(expiresAt > now)) return outcome('NO_SESSION_WINDOW');

	const fields = {
		sessionId, intentId: purchase.intentId, intentHash: purchase.intentHash, calldataHash: purchase.calldataHash, wallet: intent.wallet, chainId: 1,
		transactionKind: transaction.kind, to: transaction.to.toLowerCase(), value: 0n, data: transaction.data,
		verifiedAtBlock: preSendVerdict.verifiedAtBlock, verifiedAtBlockHash: preSendVerdict.verifiedAtBlockHash, expiresAt
	};
	const session = Object.freeze({
		...fields, dataHash: keccak256(transaction.data), createdAt: now, singleUse: true, singleUseEnforcement: SINGLE_USE_ENFORCEMENT,
		executionSessionHash: computeExecutionSessionHash(fields), toctou: TOCTOU_RESIDUAL
	});
	return outcome('SESSION_CREATED', { session });
}

/**
 * Laufzeitgrenze (noch von nichts erreichbar): laedt den Intent ueber den festen Lader, fuehrt P4F fuer
 * GENAU diesen Intent aus und bildet erst dann die Sitzung. Vom Client kommt spaeter nur intentId;
 * transaction (Server-Bytes), now und sessionId setzt der Server. Sendet nie.
 */
export async function prepareExecutionSession(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return outcome('INVALID_INPUT', { errors: ['NOT_AN_OBJECT'] });
	const unknown = Object.keys(input).filter((k) => !PREPARE_KEYS.includes(k));
	if (unknown.length) return outcome('INVALID_INPUT', { errors: unknown.map((k) => `CLIENT_FIELD:${k}`) });
	const { repository, rpcA, rpcB, intentId, transaction, now, sessionId } = input;
	const loaded = await loadPurchaseForExecution({ repository, intentId, now });
	if (!loaded.ok) return outcome(loaded.status === 'INVALID_INPUT' ? 'INVALID_INPUT' : 'PURCHASE_REJECTED', { errors: [loaded.status, ...loaded.errors] });
	const p = loaded.purchase;
	const preSend = await verifyPurchasePreSend({
		rpcA, rpcB, persistedIntent: p.intent, persistedIntentHash: p.intentHash, persistedCalldataHash: p.calldataHash,
		persistedStatus: p.status, persistedBuiltAt: p.builtAt, persistedBuildDeadline: p.buildDeadline, now
	});
	const created = createExecutionSession({ purchase: p, preSendVerdict: preSend, transaction, now, sessionId });
	return Object.freeze({ ...created, preSend: Object.freeze({ ok: preSend.ok, status: preSend.status, errors: preSend.errors }) });
}

/**
 * MODELL der Einmal-Nutzung (keine Durchsetzung): USABLE nur, wenn der Hash zu den Feldern passt,
 * now < expiresAt und der Hash nicht in `consumed` (vom Aufrufer gefuehrte Menge) steht.
 */
export function checkSessionUse({ session, now, consumed }) {
	if (!session || typeof session !== 'object' || !isTime(now) || !(consumed instanceof Set)) return 'INVALID_INPUT';
	let recomputed;
	try { recomputed = computeExecutionSessionHash(session); } catch { return 'TAMPERED'; }
	if (recomputed !== session.executionSessionHash) return 'TAMPERED';
	if (!(now < session.expiresAt)) return 'EXPIRED';
	if (consumed.has(session.executionSessionHash)) return 'CONSUMED';
	return 'USABLE';
}

