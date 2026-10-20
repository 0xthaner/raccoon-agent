/*
	NEXUS P4F: NUR LESENDE PRE-SEND-PRUEFUNG VON KETTE UND VERTRAEGEN (20.10.2026).

	Frage: sind die Vertraege und der Kettenzustand, gegen die P4C gebaut hat, JETZT
	noch genau die verifizierten? Geprueft wird unmittelbar vor einer (spaeteren)
	Wallet-Anfrage; dieses Modul fragt selbst keine Wallet an, signiert nichts,
	sendet nichts und schreibt keine Datenbank. PRE_SEND_VERIFIED heisst nur: die
	nur lesend pruefbaren technischen Voraussetzungen stimmen in diesem Moment.

	Eingaben kommen vom Server: der gespeicherte Intent mit seinem intent_hash und
	calldata_hash, Status, built_at und build_deadline (Unix-Sekunden, abgerundet)
	und die Serverzeit. Vom Browser wird nichts davon uebernommen; eine
	mitgelieferte Transaktion (to / data / value / spender / ABI / Selektor) wird
	abgelehnt, nie gelesen.

	Zwei injizierte, unabhaengige Leser (dasselbe Objekt zweimal: RPC_NOT_INDEPENDENT).
	Ein Block fuer alles: min(Kopf A, Kopf B); beide muessen denselben Block-Hash
	nennen, und JEDER Code- und Speicherzugriff liest per EIP-1898 genau diesen
	Block-Hash. Jeder Wert muss bei beiden Lesern identisch sein, sonst
	RPC_DISAGREEMENT; keine Mehrheit, kein Ergebnis aus Teildaten.

	Pins (alle fest, keiner vom Aufrufer):
	- CoverBroker v2.12.1 (P4B, Rekompilierung),
	- Cover-Proxy: OwnedUpgradeabilityProxy, Implementierungs-Slot
	  keccak256("org.govblocks.proxy.implementation") - NICHT EIP-1967 (P4E),
	- Cover-Implementierung v3.3.0 (P4B, Rekompilierung),
	- USDC (P4F, unabhaengig): FiatTokenProxy (zeppelinos AdminUpgradeabilityProxy,
	  Slot keccak256("org.zeppelinos.proxy.implementation")) -> FiatTokenV2_2,
	  Circle stablecoin-evm v2.2.0; beide Laufzeitcodes aus der Quelle
	  rekompiliert, ausfuehrbare Bytes identisch, abweichend nur der
	  CBOR-Metadaten-Hash (wie Sourcify "match"). test/purchase-pre-send.test.mjs.

	RESTRISIKO (TOCTOU), NICHT beseitigt: zwischen dieser Pruefung und dem Minen der
	Transaktion kann sich die Kette aendern (Proxy-Upgrade von Cover oder USDC,
	Pausieren von USDC, Reorg). Siehe TOCTOU_RESIDUAL.

	Bis zu einer spaeteren Phase importiert nur test/ dieses Modul (P4F-IMPORT).
*/
import { keccak256 } from 'viem';
import { NEXUS_CHAIN_ID } from './nexus-pinned.mjs';
import { validatePurchaseIntent, computePurchaseIntentHash, PURCHASE_PINS, INTENT_STATUSES } from './purchase-intent.mjs';

/** Nur diese JSON-RPC-Methoden werden je an einen Leser gegeben. */
export const PRE_SEND_READ_METHODS = Object.freeze(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_call']);

/**
 * USDC auf Ethereum-Mainnet, unabhaengig festgestellt am 20.10.2026 (Block 26230145 ff., zwei Anbieter).
 * status 'PINNED' nur, solange Adresse, Slot und beide Laufzeit-Hashes belegt sind; sonst USDC_PIN_UNRESOLVED.
 */
export const USDC_PIN = Object.freeze({
	status: 'PINNED',
	proxy: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
	// FiatTokenProxy, solc 0.4.24, ohne Optimierer, byzantium; 2186 Bytes
	proxyCodeHash: '0xd80d4b7c890cb9d6a4893e6b52bc34b56b25335cb13716e0d1d31383e6b41505',
	// keccak256("org.zeppelinos.proxy.implementation"), UpgradeabilityProxy.IMPLEMENTATION_SLOT
	implementationSlot: '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3',
	implementation: '0x43506849d7c04f9138d1a2050bbf3a0c054402dd',
	// FiatTokenV2_2, Circle stablecoin-evm v2.2.0 (405efc10), solc 0.6.12, runs 10000000, istanbul; 23464 Bytes
	implementationCodeHash: '0xcdfb7d322961af3acae7a8f7ee8b69c205b36f576cc5b077f170c7eb8ecbe3ea'
});

/** Alle Pins der Pre-Send-Pruefung. Broker und Cover-Implementierung sind dieselben, die der Intent-Hash bindet. */
export const PRE_SEND_PINS = Object.freeze({
	chainId: NEXUS_CHAIN_ID,
	broker: PURCHASE_PINS.broker,
	brokerCodeHash: PURCHASE_PINS.brokerCodeHash,
	coverProxy: PURCHASE_PINS.coverProxy,
	// OwnedUpgradeabilityProxy, solc 0.8.18, 863 Bytes (P4E)
	coverProxyCodeHash: '0xd772ae50e8c6515f53b17b60eb2bf13e0d40ec60cc3d2d5dd8d58d78afb8a1e0',
	// keccak256("org.govblocks.proxy.implementation"), NICHT EIP-1967
	coverImplementationSlot: '0x7fb5080a7084f4c60aade0a78fc13ba4ba6555b60e554360d005f0d684cea186',
	coverImplementation: PURCHASE_PINS.coverImplementation,
	coverImplementationCodeHash: PURCHASE_PINS.coverImplementationCodeHash,
	usdc: USDC_PIN
});

/** Kopf-Abstand der beiden Leser, ab dem sie nicht mehr dieselbe Kette meinen (8 Bloecke, etwa 96 s). */
export const MAX_HEAD_SKEW_BLOCKS = 8n;
/** Der gepruefte Block darf hoechstens so alt sein (und nicht so weit in der Zukunft liegen) wie diese Sekunden. */
export const MAX_BLOCK_AGE_SECONDS = 120;

export const PRE_SEND_STATUSES = Object.freeze([
	'PRE_SEND_VERIFIED', 'INVALID_INPUT', 'WRONG_CHAIN', 'INVALID_INTENT', 'INVALID_STATUS', 'INTENT_EXPIRED', 'BUILD_DEADLINE_EXPIRED',
	'RPC_NOT_INDEPENDENT', 'RPC_DISAGREEMENT', 'TEMPORARY_RPC_FAILURE', 'STALE_CHAIN_VIEW', 'BROKER_DRIFT', 'COVER_PROXY_DRIFT',
	'COVER_IMPLEMENTATION_DRIFT', 'USDC_DRIFT', 'USDC_PIN_UNRESOLVED'
]);
/** Alle Pruefungen, die fuer PRE_SEND_VERIFIED bestanden sein muessen, in dieser Reihenfolge. */
export const PRE_SEND_CHECKS = Object.freeze(['input', 'intent', 'intentHash', 'calldataHash', 'status', 'expiry', 'buildDeadline', 'usdcPin', 'chain', 'block',
	'brokerCode', 'coverProxyCode', 'coverImplementationSlot', 'coverImplementationCode', 'usdcProxyCode', 'usdcImplementationSlot', 'usdcImplementationCode']);

/** Was eine bestandene Pruefung NICHT leistet. */
export const TOCTOU_RESIDUAL = 'NOT eliminated: the chain can change between this read-only check and the mining of a later transaction '
	+ '(Cover or USDC proxy upgrade, USDC pause, reorg). Mitigations for a later phase: run the check immediately before the wallet request, '
	+ 'bind verifiedAtBlock/verifiedAtBlockHash to the transaction session, keep the build deadline short, and re-check the pins at the execution block with the P4E receipt verifier.';

const INPUT_KEYS = Object.freeze(['rpcA', 'rpcB', 'persistedIntent', 'persistedIntentHash', 'persistedCalldataHash', 'persistedStatus', 'persistedBuiltAt', 'persistedBuildDeadline', 'now', 'observeAllowance']);
/** P4D: build_deadline = built_at + 120 s und nie nach expires_at. */
const BUILD_WINDOW_SECONDS = 120;
const HASH = /^0x[0-9a-f]{64}$/;
const ALLOWANCE_SELECTOR = '0xdd62ed3e'; // allowance(address,address)

class Stop extends Error { constructor(status, errors) { super(status); this.status = status; this.errors = errors; } }
const stop = (status, ...errors) => { throw new Stop(status, errors.length ? errors : [status]); };
const isTime = (t) => Number.isSafeInteger(t) && t > 0;
const quantity = (v, what) => { if (typeof v !== 'string' || !/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(v)) stop('RPC_DISAGREEMENT', `MALFORMED:${what}`); return BigInt(v); };
const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
/** Ein Speicherwort, das genau eine Adresse traegt (obere 12 Bytes null); sonst null. */
const slotAddress = (w) => (typeof w === 'string' && /^0x0{24}[0-9a-f]{40}$/.test(lower(w)) ? `0x${lower(w).slice(26)}` : null);

/** Zwei Leser, jeder Wert von beiden. Fehler eines Lesers -> TEMPORARY_RPC_FAILURE, Abweichung -> RPC_DISAGREEMENT. */
function dualReader(rpcA, rpcB) {
	const one = async (rpc, method, params) => {
		if (!PRE_SEND_READ_METHODS.includes(method)) throw new Error(`method ${method} is not read-only`);
		return rpc.request({ method, params });
	};
	const both = async (method, params) => {
		const settled = await Promise.allSettled([one(rpcA, method, params), one(rpcB, method, params)]);
		if (settled.some((s) => s.status === 'rejected')) stop('TEMPORARY_RPC_FAILURE', ...settled.map((s, i) => (s.status === 'rejected' ? `RPC_${'AB'[i]}_FAILED:${method}` : null)).filter(Boolean));
		return settled.map((s) => s.value);
	};
	return {
		both,
		async agreed(method, params) {
			const [a, b] = (await both(method, params)).map((v) => lower(v ?? null));
			if (a !== b) stop('RPC_DISAGREEMENT', `RPC_DISAGREEMENT:${method}`);
			return a;
		}
	};
}

function checkInput(input, pass) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) stop('INVALID_INPUT', 'NOT_AN_OBJECT');
	const unknown = Object.keys(input).filter((k) => !INPUT_KEYS.includes(k));
	if (unknown.length) stop('INVALID_INPUT', ...unknown.map((k) => `CLIENT_FIELD:${k}`));
	const { rpcA, rpcB, now, observeAllowance } = input;
	if (typeof rpcA?.request !== 'function' || typeof rpcB?.request !== 'function') stop('INVALID_INPUT', 'RPC_READERS');
	if (rpcA === rpcB) stop('RPC_NOT_INDEPENDENT');
	if (!isTime(now)) stop('INVALID_INPUT', 'NOW');
	if (observeAllowance !== undefined && typeof observeAllowance !== 'boolean') stop('INVALID_INPUT', 'OBSERVE_ALLOWANCE');
	pass('input');

	const checked = validatePurchaseIntent(input.persistedIntent);
	if (!checked.ok) stop('INVALID_INTENT', ...checked.errors);
	if (checked.intent.proofOfLossCid === null) stop('INVALID_INTENT', 'INTENT_WITHOUT_PROOF_OF_LOSS');
	pass('intent');
	// P4A-Hash neu berechnet; der gespeicherte muss exakt gleich sein.
	if (typeof input.persistedIntentHash !== 'string' || !HASH.test(input.persistedIntentHash)) stop('INVALID_INTENT', 'PERSISTED_INTENT_HASH');
	if (computePurchaseIntentHash(input.persistedIntent) !== input.persistedIntentHash) stop('INVALID_INTENT', 'INTENT_HASH_MISMATCH');
	pass('intentHash');
	if (typeof input.persistedCalldataHash !== 'string' || !HASH.test(input.persistedCalldataHash)) stop('INVALID_INTENT', 'PERSISTED_CALLDATA_HASH');
	pass('calldataHash');

	const { persistedStatus: status, persistedBuiltAt: builtAt, persistedBuildDeadline: deadline } = input;
	if (!INTENT_STATUSES.includes(status)) stop('INVALID_STATUS', 'UNKNOWN_STATUS');
	if (status !== 'BUILT') stop('INVALID_STATUS', `STATUS_${status}`);
	pass('status');
	// P4D-Grenzen, beide exklusiv: nutzbar nur bei now < expires_at und now < build_deadline.
	if (!(now < checked.intent.expiresAt)) stop('INTENT_EXPIRED');
	pass('expiry');
	if (!isTime(builtAt) || !isTime(deadline)) stop('INVALID_INTENT', 'BUILD_TIMES');
	if (!(deadline > builtAt) || deadline - builtAt > BUILD_WINDOW_SECONDS || deadline > checked.intent.expiresAt) stop('INVALID_INTENT', 'BUILD_WINDOW');
	if (!(now < deadline)) stop('BUILD_DEADLINE_EXPIRED');
	pass('buildDeadline');
	return { intent: checked.intent, now, observeAllowance: observeAllowance === true };
}

/** Ein USDC-Pin zaehlt nur vollstaendig: Status PINNED und jede Adresse / jeder Hash wohlgeformt. */
export function usdcPinState(pin) {
	const address = /^0x[0-9a-f]{40}$/;
	if (!pin || pin.status !== 'PINNED') return 'USDC_PIN_UNRESOLVED';
	if (!address.test(pin.proxy ?? '') || !address.test(pin.implementation ?? '')) return 'USDC_PIN_UNRESOLVED';
	if (![pin.proxyCodeHash, pin.implementationSlot, pin.implementationCodeHash].every((h) => typeof h === 'string' && HASH.test(h))) return 'USDC_PIN_UNRESOLVED';
	return 'PINNED';
}

/**
 * Nur lesende Pre-Send-Pruefung. Liefert ein eingefrorenes
 * { ok, status, verifiedAtBlock, verifiedAtBlockHash, contractPins, currentAllowance, checks, errors, toctou }.
 * ok nur, wenn jede Pruefung aus PRE_SEND_CHECKS bestanden ist. Fuehrt nie etwas aus.
 */
export async function verifyPurchasePreSend(input) {
	const checks = Object.fromEntries(PRE_SEND_CHECKS.map((c) => [c, null]));
	const facts = { verifiedAtBlock: null, verifiedAtBlockHash: null, contractPins: null, currentAllowance: null };
	const pass = (name) => { checks[name] = true; };
	try {
		const { intent, now, observeAllowance } = checkInput(input, pass);
		const pins = PRE_SEND_PINS;
		if (usdcPinState(pins.usdc) !== 'PINNED') stop('USDC_PIN_UNRESOLVED');
		pass('usdcPin');
		const rpc = dualReader(input.rpcA, input.rpcB);

		if (await rpc.agreed('eth_chainId', []) !== `0x${pins.chainId.toString(16)}`) stop('WRONG_CHAIN');
		pass('chain');

		// Ein Block fuer alles: der kleinere Kopf; beide Leser muessen ihn mit demselben Hash kennen.
		const heads = (await rpc.both('eth_blockNumber', [])).map((v) => quantity(v, 'head'));
		const [low, high] = heads[0] <= heads[1] ? heads : [heads[1], heads[0]];
		if (high - low > MAX_HEAD_SKEW_BLOCKS) stop('RPC_DISAGREEMENT', 'HEAD_SKEW');
		const tag = `0x${low.toString(16)}`;
		const blocks = (await rpc.both('eth_getBlockByNumber', [tag, false])).map((b) => (b && typeof b === 'object' ? { number: lower(b.number), hash: lower(b.hash), timestamp: lower(b.timestamp) } : null));
		if (blocks.some((b) => b === null || b.number !== tag || !HASH.test(b.hash ?? ''))) stop('RPC_DISAGREEMENT', 'BLOCK_MISSING');
		if (blocks[0].hash !== blocks[1].hash || blocks[0].timestamp !== blocks[1].timestamp) stop('RPC_DISAGREEMENT', 'BLOCK_HASH');
		const block = blocks[0];
		const age = now - Number(quantity(block.timestamp, 'timestamp'));
		if (age > MAX_BLOCK_AGE_SECONDS) stop('STALE_CHAIN_VIEW', 'BLOCK_TOO_OLD');
		if (age < -MAX_BLOCK_AGE_SECONDS) stop('STALE_CHAIN_VIEW', 'BLOCK_IN_FUTURE');
		facts.verifiedAtBlock = low; facts.verifiedAtBlockHash = block.hash;
		pass('block');

		// Jeder weitere Zugriff liest genau diesen Block (EIP-1898).
		const at = { blockHash: block.hash };
		const codeHash = async (address) => {
			const code = await rpc.agreed('eth_getCode', [address, at]);
			return typeof code === 'string' && /^0x(?:[0-9a-f]{2})+$/.test(code) ? keccak256(code) : null;
		};
		const slot = (address, position) => rpc.agreed('eth_getStorageAt', [address, position, at]);
		const observed = {};

		observed.brokerCodeHash = await codeHash(pins.broker);
		if (observed.brokerCodeHash !== pins.brokerCodeHash) stop('BROKER_DRIFT');
		pass('brokerCode');
		observed.coverProxyCodeHash = await codeHash(pins.coverProxy);
		if (observed.coverProxyCodeHash !== pins.coverProxyCodeHash) stop('COVER_PROXY_DRIFT');
		pass('coverProxyCode');
		observed.coverImplementation = slotAddress(await slot(pins.coverProxy, pins.coverImplementationSlot));
		if (observed.coverImplementation !== pins.coverImplementation) stop('COVER_IMPLEMENTATION_DRIFT', 'IMPLEMENTATION_ADDRESS');
		pass('coverImplementationSlot');
		observed.coverImplementationCodeHash = await codeHash(pins.coverImplementation);
		if (observed.coverImplementationCodeHash !== pins.coverImplementationCodeHash) stop('COVER_IMPLEMENTATION_DRIFT', 'IMPLEMENTATION_CODE');
		pass('coverImplementationCode');

		observed.usdcProxyCodeHash = await codeHash(pins.usdc.proxy);
		if (observed.usdcProxyCodeHash !== pins.usdc.proxyCodeHash) stop('USDC_DRIFT', 'USDC_PROXY_CODE');
		pass('usdcProxyCode');
		observed.usdcImplementation = slotAddress(await slot(pins.usdc.proxy, pins.usdc.implementationSlot));
		if (observed.usdcImplementation !== pins.usdc.implementation) stop('USDC_DRIFT', 'USDC_IMPLEMENTATION_ADDRESS');
		pass('usdcImplementationSlot');
		observed.usdcImplementationCodeHash = await codeHash(pins.usdc.implementation);
		if (observed.usdcImplementationCodeHash !== pins.usdc.implementationCodeHash) stop('USDC_DRIFT', 'USDC_IMPLEMENTATION_CODE');
		pass('usdcImplementationCode');
		facts.contractPins = Object.freeze(observed);

		// Nur Beobachtung, nie Teil des Urteils: die aktuelle Freigabe des Wallets an den Broker.
		if (observeAllowance) facts.currentAllowance = await observeCurrentAllowance(rpc, intent.wallet, pins, at);

		const unresolved = PRE_SEND_CHECKS.filter((c) => checks[c] !== true);
		if (unresolved.length) stop('INVALID_INPUT', ...unresolved.map((c) => `UNRESOLVED:${c}`));
		return result(true, 'PRE_SEND_VERIFIED', facts, checks, []);
	} catch (error) {
		if (error instanceof Stop) return result(false, error.status, facts, checks, error.errors);
		return result(false, 'TEMPORARY_RPC_FAILURE', facts, checks, ['UNEXPECTED_READ_ERROR']);
	}
}

/** allowance(wallet, Broker) am geprueften Block; bei Fehler oder Abweichung null. Entscheidet nichts. */
async function observeCurrentAllowance(rpc, wallet, pins, at) {
	const data = `${ALLOWANCE_SELECTOR}${wallet.slice(2).padStart(64, '0')}${pins.broker.slice(2).padStart(64, '0')}`;
	try {
		const raw = await rpc.agreed('eth_call', [{ to: pins.usdc.proxy, data }, at]);
		return typeof raw === 'string' && HASH.test(raw) ? BigInt(raw).toString() : null;
	} catch { return null; }
}

function result(ok, status, facts, checks, errors) {
	const failedAt = ok ? null : PRE_SEND_CHECKS.find((c) => checks[c] !== true) ?? null;
	if (failedAt) checks[failedAt] = false;
	return Object.freeze({
		ok, status, verifiedAtBlock: facts.verifiedAtBlock, verifiedAtBlockHash: facts.verifiedAtBlockHash, contractPins: facts.contractPins,
		currentAllowance: facts.currentAllowance, checks: Object.freeze({ ...checks }), errors: Object.freeze([...errors]), toctou: TOCTOU_RESIDUAL
	});
}
