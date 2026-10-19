/*
	NEXUS P4E: UNABHAENGIGE, NUR LESENDE BELEG-PRUEFUNG EINES KAUFS (19.10.2026).

	Frage: hat die eingereichte Ethereum-Transaktion GENAU das Cover erzeugt, das der
	gespeicherte CoverRaccoon-Intent beschreibt? Antwort nur aus der Kette, gelesen
	ueber ZWEI unabhaengige, injizierte RPC-Leser; jeder autoritative Wert muss bei
	beiden identisch sein, sonst RPC_DISAGREEMENT (keine Mehrheit, kein "einer hat
	wohl recht"). Erst wenn jede Pruefung bestanden ist: VERIFIED_COVER_PURCHASE.

	Eingaben kommen vom Server (Intent und calldata_hash aus der Datenbank, txHash);
	ein vom Client geliefertes receipt / logs / coverId / blockNumber / from / to /
	data / value wird abgelehnt, nie verwendet.

	Nur lesend: erlaubt sind ausschliesslich die Methoden in READ_METHODS. Kein
	Signieren, kein Senden, keine Wallet, keine Datenbank, keine Nexus-HTTP-API, kein
	Builder (die Transaktion muss fuer sich bestehen; geprueft wird mit dem
	unabhaengigen P4C-Decoder). Deterministisch fuer einen festen Kettenzustand.
	Bis zu einer spaeteren Phase importiert nur test/ dieses Modul (P4E-IMPORT).

	Semantik aus den verifizierten Quellen (Cover v3.3.0, Commit 0709725; CoverBroker
	v2.12.1; Proxy OwnedUpgradeabilityProxy, solc 0.8.18):
	- Cover.buyCover emittiert CoverBought(coverId, originalCoverId, buyerMemberId,
	  productId); die ersten drei indiziert. Bei einem neuen Cover (params.coverId 0)
	  ist originalCoverId == coverId; buyerMemberId = registry.getMemberId(msg.sender),
	  hier der Broker (Mitglied 9301).
	- _buyCover praegt coverNFT.mint(params.owner) -> Transfer(0, owner, coverId) und
	  setzt _coverMetadata[coverId] = params.ipfsData.
	- _createCover speichert CoverData(productId, coverAsset, amount = zugeteilte
	  Summe >= params.amount, start = block.timestamp, period = params.period, ...).
	  Ablauf = start + period.
	- ERC-20-Zahlung: Broker zieht maxPremiumInAsset vom Kaeufer, Cover zieht die
	  Praemie vom Broker in den Pool, eine Kommission nur wenn > 0 an das Ziel, der
	  Rest geht als Erstattung an den Kaeufer zurueck.
	- Der Cover-Proxy liest die Implementierung aus
	  keccak256("org.govblocks.proxy.implementation") - NICHT aus dem EIP-1967-Slot.
*/
import { keccak256, decodeAbiParameters } from 'viem';
import { NEXUS_CHAIN_ID, NEXUS_CONTRACT_SOURCES } from './nexus-pinned.mjs';
import { validatePurchaseIntent, PURCHASE_PINS, ZERO_ADDRESS } from './purchase-intent.mjs';
import { decodeNexusBuyCover, validateDecodedAgainstIntent } from './purchase-tx-decode.mjs';

/** Nur diese JSON-RPC-Methoden werden je an einen Leser gegeben. */
export const READ_METHODS = Object.freeze(['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_blockNumber', 'eth_getStorageAt', 'eth_getCode', 'eth_call']);

const COVER_IMMUTABLES = NEXUS_CONTRACT_SOURCES.Cover.immutables;
/** Ziele und Pins, alle aus verifizierten Quellen; keiner kommt vom Aufrufer. */
export const RECEIPT_PINS = Object.freeze({
	broker: PURCHASE_PINS.broker,
	brokerCodeHash: PURCHASE_PINS.brokerCodeHash,
	coverProxy: PURCHASE_PINS.coverProxy,
	coverImplementation: PURCHASE_PINS.coverImplementation,
	coverImplementationCodeHash: PURCHASE_PINS.coverImplementationCodeHash,
	// Laufzeitcode des Cover-Proxys (OwnedUpgradeabilityProxy, solc 0.8.18; identisch mit dem Sourcify-exakten CoverProducts-Proxy)
	coverProxyCodeHash: '0xd772ae50e8c6515f53b17b60eb2bf13e0d40ec60cc3d2d5dd8d58d78afb8a1e0',
	// keccak256("org.govblocks.proxy.implementation"), UpgradeabilityProxy.IMPLEMENTATION_POSITION
	coverImplementationSlot: '0x7fb5080a7084f4c60aade0a78fc13ba4ba6555b60e554360d005f0d684cea186',
	coverNft: COVER_IMMUTABLES.coverNFT.toLowerCase(),
	pool: COVER_IMMUTABLES.pool.toLowerCase(),
	usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
	brokerMemberId: 9301n,
	productId: 97n,
	coverAssetId: 6n
});

/** Topics und Selektoren; die Tests rechnen sie aus den Quellsignaturen nach. */
export const EVENT_TOPICS = Object.freeze({
	CoverBought: '0xe2b69afa632923dbb71755db531ac4d82b79662feb2c342c55d80c644a97003f', // CoverBought(uint256,uint256,uint256,uint256)
	Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' // Transfer(address,address,uint256)
});
export const VIEW_SELECTORS = Object.freeze({ getCoverData: '0x00407d2a', getCoverReference: '0x2a15e644', getCoverMetadata: '0x09f117d7', ownerOf: '0x6352211e' });

/** Vorschlag fuer Produktion: Block finalisiert UND mindestens 64 Bestaetigungen (zwei Epochen). */
export const PRODUCTION_CONFIRMATION_POLICY = Object.freeze({ minConfirmations: 64, requireFinalized: true });

export const RECEIPT_STATUSES = Object.freeze([
	'VERIFIED_COVER_PURCHASE', 'INVALID_INPUT', 'TEMPORARY_RPC_FAILURE', 'RPC_DISAGREEMENT', 'WRONG_CHAIN', 'TX_NOT_FOUND', 'RECEIPT_NOT_FOUND', 'TX_FAILED',
	'RECEIPT_MISMATCH', 'BLOCK_HASH_MISMATCH', 'INSUFFICIENT_CONFIRMATIONS', 'WRONG_SENDER', 'WRONG_TARGET', 'WRONG_VALUE', 'CALLDATA_HASH_MISMATCH',
	'CALLDATA_POLICY_MISMATCH', 'PROXY_DRIFT_AT_EXECUTION', 'BROKER_DRIFT_AT_EXECUTION', 'COVERBOUGHT_MISSING', 'COVERBOUGHT_MISMATCH', 'NFT_MINT_MISSING',
	'NFT_OWNER_MISMATCH', 'COVER_STATE_MISMATCH', 'POL_METADATA_MISMATCH', 'TOKEN_FLOW_MISMATCH'
]);
/** Alle Pruefungen, die fuer VERIFIED bestanden sein muessen. */
export const REQUIRED_CHECKS = Object.freeze(['input', 'chain', 'transaction', 'receipt', 'block', 'confirmations', 'sender', 'target', 'value', 'calldataHash', 'calldataPolicy',
	'brokerCode', 'proxyCode', 'proxyImplementation', 'implementationCode', 'coverBought', 'nftMint', 'coverState', 'coverOwner', 'metadata', 'tokenFlow']);

/** Erlaubte Schluessel; alles andere (insbesondere clientseitige Belege) fuehrt zu INVALID_INPUT. */
const INPUT_KEYS = Object.freeze(['rpcA', 'rpcB', 'intent', 'txHash', 'calldataHash', 'minConfirmations', 'requireFinalized']);
const HASH = /^0x[0-9a-f]{64}$/;

class Stop extends Error { constructor(status, errors) { super(status); this.status = status; this.errors = errors; } }
const stop = (status, ...errors) => { throw new Stop(status, errors.length ? errors : [status]); };
const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
const canonical = (v) => JSON.stringify(v, (k, x) => (typeof x === 'string' ? x.toLowerCase() : x));
const quantity = (v, what) => { if (typeof v !== 'string' || !/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(v)) stop('RPC_DISAGREEMENT', `MALFORMED:${what}`); return BigInt(v); };
const word = (n) => n.toString(16).padStart(64, '0');
const topicAddress = (t) => `0x${t.slice(26)}`.toLowerCase();

/** Nur der gemeinsame, autoritative Kern; Anbieter liefern unterschiedlich viele Zusatzfelder. */
const txCore = (t) => (t === null ? null : { hash: lower(t.hash), from: lower(t.from), to: lower(t.to ?? null), input: lower(t.input), value: lower(t.value), chainId: lower(t.chainId ?? null), blockHash: lower(t.blockHash ?? null), blockNumber: lower(t.blockNumber ?? null) });
const logCore = (l) => ({ address: lower(l.address), topics: (l.topics ?? []).map(lower), data: lower(l.data), logIndex: lower(l.logIndex), blockHash: lower(l.blockHash), transactionHash: lower(l.transactionHash), removed: l.removed === true });
const receiptCore = (r) => (r === null ? null : { transactionHash: lower(r.transactionHash), status: lower(r.status), from: lower(r.from), to: lower(r.to ?? null), blockHash: lower(r.blockHash), blockNumber: lower(r.blockNumber), logs: (r.logs ?? []).map(logCore) });
const blockCore = (b) => (b === null ? null : { number: lower(b.number), hash: lower(b.hash), timestamp: lower(b.timestamp) });

/**
 * Zwei Leser, jeder Wert von beiden; Fehler eines Lesers -> TEMPORARY_RPC_FAILURE,
 * Abweichung -> RPC_DISAGREEMENT. `core` reduziert auf die verglichenen Felder.
 */
function dualReader(rpcA, rpcB) {
	const one = async (rpc, method, params) => {
		if (!READ_METHODS.includes(method)) throw new Error(`method ${method} is not read-only`);
		return rpc.request({ method, params });
	};
	const both = async (method, params) => {
		const settled = await Promise.allSettled([one(rpcA, method, params), one(rpcB, method, params)]);
		const failed = settled.filter((s) => s.status === 'rejected');
		if (failed.length) stop('TEMPORARY_RPC_FAILURE', ...settled.map((s, i) => (s.status === 'rejected' ? `RPC_${'AB'[i]}_FAILED:${method}` : null)).filter(Boolean));
		return settled.map((s) => s.value);
	};
	return {
		/** Autoritativer Wert: muss bei beiden Lesern identisch sein. */
		async agreed(method, params, core = (x) => x) {
			const [a, b] = await both(method, params);
			const ca = core(a ?? null), cb = core(b ?? null);
			if (canonical(ca) !== canonical(cb)) stop('RPC_DISAGREEMENT', `RPC_DISAGREEMENT:${method}`);
			return ca;
		},
		/** Kettenkopf: darf sich zwischen Anbietern um Bloecke unterscheiden; es zaehlt der KLEINERE. */
		async lowest(method, params, pick) {
			const values = (await both(method, params)).map((v) => pick(v));
			return values.reduce((m, v) => (v < m ? v : m));
		}
	};
}

function checkInput(input) {
	const errors = [];
	if (!input || typeof input !== 'object' || Array.isArray(input)) stop('INVALID_INPUT', 'NOT_AN_OBJECT');
	for (const key of Object.keys(input)) if (!INPUT_KEYS.includes(key)) errors.push(`CLIENT_FIELD:${key}`);
	const { rpcA, rpcB, intent, txHash, calldataHash, minConfirmations, requireFinalized } = input;
	if (typeof rpcA?.request !== 'function' || typeof rpcB?.request !== 'function') errors.push('RPC_READERS');
	else if (rpcA === rpcB) errors.push('RPC_NOT_INDEPENDENT');
	const checked = validatePurchaseIntent(intent);
	if (!checked.ok) errors.push('INTENT_INVALID');
	else if (checked.intent.proofOfLossCid === null) errors.push('INTENT_WITHOUT_PROOF_OF_LOSS');
	if (typeof txHash !== 'string' || !HASH.test(txHash)) errors.push('TX_HASH');
	if (typeof calldataHash !== 'string' || !HASH.test(calldataHash)) errors.push('CALLDATA_HASH');
	if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 1) errors.push('MIN_CONFIRMATIONS');
	if (requireFinalized !== undefined && typeof requireFinalized !== 'boolean') errors.push('REQUIRE_FINALIZED');
	if (errors.length) stop('INVALID_INPUT', ...errors);
	return { intent: checked.intent, intentInput: intent, txHash, calldataHash, minConfirmations, requireFinalized: requireFinalized ?? true };
}

/* ------------------------------------------------------------- Logs -- */

function coverBoughtOf(logs, intent) {
	const shaped = logs.filter((l) => l.topics[0] === EVENT_TOPICS.CoverBought);
	if (shaped.some((l) => l.address !== RECEIPT_PINS.coverProxy)) stop('COVERBOUGHT_MISMATCH', 'COVERBOUGHT_FOREIGN_EMITTER');
	if (shaped.length === 0) stop('COVERBOUGHT_MISSING');
	if (shaped.length > 1) stop('COVERBOUGHT_MISMATCH', 'COVERBOUGHT_NOT_UNIQUE');
	const [log] = shaped;
	if (log.topics.length !== 4 || !/^0x[0-9a-f]{64}$/.test(log.data)) stop('COVERBOUGHT_MISMATCH', 'COVERBOUGHT_SHAPE');
	const coverId = BigInt(log.topics[1]), originalCoverId = BigInt(log.topics[2]), buyerMemberId = BigInt(log.topics[3]), productId = BigInt(log.data);
	const errors = [];
	if (coverId === 0n) errors.push('COVER_ID_ZERO');
	if (originalCoverId !== coverId) errors.push('ORIGINAL_COVER_ID');
	if (buyerMemberId !== RECEIPT_PINS.brokerMemberId) errors.push('BUYER_MEMBER_ID');
	if (productId !== BigInt(intent.productId)) errors.push('COVERBOUGHT_PRODUCT');
	if (errors.length) stop('COVERBOUGHT_MISMATCH', ...errors);
	return coverId;
}

function nftMintOf(logs, intent, coverId) {
	const transfers = logs.filter((l) => l.address === RECEIPT_PINS.coverNft && l.topics[0] === EVENT_TOPICS.Transfer);
	if (transfers.length === 0) stop('NFT_MINT_MISSING');
	if (transfers.length > 1) stop('NFT_OWNER_MISMATCH', 'NFT_TRANSFER_NOT_UNIQUE');
	const [t] = transfers;
	if (t.topics.length !== 4 || t.data !== '0x') stop('NFT_OWNER_MISMATCH', 'NFT_TRANSFER_SHAPE');
	const errors = [];
	if (topicAddress(t.topics[1]) !== ZERO_ADDRESS) errors.push('NFT_NOT_A_MINT');
	if (topicAddress(t.topics[2]) !== intent.wallet) errors.push('NFT_RECIPIENT');
	if (BigInt(t.topics[3]) !== coverId) errors.push('NFT_TOKEN_ID');
	if (errors.length) stop('NFT_OWNER_MISMATCH', ...errors);
}

/** Stuetzend, nicht primaer: USDC-Fluesse muessen zu Kommission 0 passen. Die USDC-Implementierung ist NICHT gepinnt. */
function tokenFlowErrors(logs, intent) {
	const usdc = logs.filter((l) => l.address === RECEIPT_PINS.usdc && l.topics[0] === EVENT_TOPICS.Transfer).map((l) => ({ from: topicAddress(l.topics[1]), to: topicAddress(l.topics[2]), value: BigInt(l.data) }));
	const errors = [];
	const pull = usdc.filter((x) => x.to === RECEIPT_PINS.broker);
	if (pull.length !== 1 || pull[0].from !== intent.wallet || pull[0].value !== intent.maxPremiumRaw) errors.push('USDC_PULL');
	const out = usdc.filter((x) => x.from === RECEIPT_PINS.broker);
	const toPool = out.filter((x) => x.to === RECEIPT_PINS.pool), refund = out.filter((x) => x.to === intent.wallet), other = out.filter((x) => x.to !== RECEIPT_PINS.pool && x.to !== intent.wallet);
	if (other.length) errors.push('USDC_THIRD_PARTY_TRANSFER');
	if (toPool.length !== 1 || refund.length > 1) errors.push('USDC_OUTFLOW_SHAPE');
	else if (toPool[0].value + (refund[0]?.value ?? 0n) !== intent.maxPremiumRaw) errors.push('USDC_BALANCE');
	return errors;
}

/* ------------------------------------------------------------- Zustand -- */

const viewCall = (selector, coverId) => `${selector}${word(coverId)}`;
function decodeStrict(types, data, what) {
	try { return decodeAbiParameters(types, data); } catch { stop('COVER_STATE_MISMATCH', `UNDECODABLE:${what}`); }
	return null;
}

/* ------------------------------------------------------------- Pruefung -- */

/**
 * Prueft einen eingereichten Kauf gegen die Kette. Liefert ein eingefrorenes
 * { ok, status, coverId, blockNumber, blockHash, checks, errors }. ok nur, wenn jede
 * Pruefung aus REQUIRED_CHECKS bestanden ist.
 */
export async function verifyPurchaseReceipt(input) {
	const checks = Object.fromEntries(REQUIRED_CHECKS.map((c) => [c, null]));
	const facts = { coverId: null, blockNumber: null, blockHash: null };
	const pass = (name) => { checks[name] = true; };
	try {
		const { intent, intentInput, txHash, calldataHash, minConfirmations, requireFinalized } = checkInput(input);
		pass('input');
		const rpc = dualReader(input.rpcA, input.rpcB);

		if (await rpc.agreed('eth_chainId', []) !== `0x${NEXUS_CHAIN_ID.toString(16)}`) stop('WRONG_CHAIN');
		pass('chain');

		const tx = await rpc.agreed('eth_getTransactionByHash', [txHash], txCore);
		if (tx === null) stop('TX_NOT_FOUND');
		if (tx.hash !== txHash) stop('RPC_DISAGREEMENT', 'TX_HASH_ECHO');
		// typisierte Transaktionen tragen ihre Kette selbst; fehlt sie (Legacy ohne EIP-155-Feld), zaehlt eth_chainId
		if (tx.chainId !== null && quantity(tx.chainId, 'chainId') !== BigInt(NEXUS_CHAIN_ID)) stop('WRONG_CHAIN', 'TX_CHAIN_ID');
		pass('transaction');
		const receipt = await rpc.agreed('eth_getTransactionReceipt', [txHash], receiptCore);
		if (receipt === null) stop('RECEIPT_NOT_FOUND');
		if (receipt.status !== '0x1') stop('TX_FAILED');
		const receiptErrors = [];
		if (receipt.transactionHash !== txHash) receiptErrors.push('RECEIPT_TX_HASH');
		if (!HASH.test(receipt.blockHash ?? '')) receiptErrors.push('RECEIPT_BLOCK_HASH');
		if (receipt.from !== tx.from || receipt.to !== tx.to) receiptErrors.push('RECEIPT_FROM_TO');
		if (tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber) receiptErrors.push('TX_RECEIPT_BLOCK');
		if (receipt.logs.some((l) => l.removed || l.blockHash !== receipt.blockHash || l.transactionHash !== txHash)) receiptErrors.push('RECEIPT_LOGS');
		if (receiptErrors.length) stop('RECEIPT_MISMATCH', ...receiptErrors);
		pass('receipt');
		const blockNumber = quantity(receipt.blockNumber, 'blockNumber');
		const atBlock = receipt.blockNumber;

		// Reorg: der Block unter dieser Nummer muss genau der Block des Belegs sein, bei beiden Lesern.
		const block = await rpc.agreed('eth_getBlockByNumber', [atBlock, false], blockCore);
		if (block === null || block.hash !== receipt.blockHash || block.number !== receipt.blockNumber) stop('BLOCK_HASH_MISMATCH');
		facts.blockNumber = blockNumber; facts.blockHash = receipt.blockHash;
		pass('block');

		const head = await rpc.lowest('eth_blockNumber', [], (v) => quantity(v, 'head'));
		if (head - blockNumber + 1n < BigInt(minConfirmations)) stop('INSUFFICIENT_CONFIRMATIONS');
		if (requireFinalized) {
			const finalized = await rpc.lowest('eth_getBlockByNumber', ['finalized', false], (b) => (b === null ? -1n : quantity(b.number, 'finalized')));
			if (finalized < blockNumber) stop('INSUFFICIENT_CONFIRMATIONS', 'NOT_FINALIZED');
		}
		pass('confirmations');

		if (tx.from !== intent.wallet) stop('WRONG_SENDER');
		pass('sender');
		if (tx.to !== RECEIPT_PINS.broker) stop('WRONG_TARGET');
		pass('target');
		if (quantity(tx.value, 'value') !== 0n) stop('WRONG_VALUE');
		pass('value');
		if (keccak256(tx.input) !== calldataHash) stop('CALLDATA_HASH_MISMATCH');
		pass('calldataHash');
		// Unabhaengiger P4C-Decoder; die Zuteilungen sind ueber calldata_hash an den gespeicherten Build gebunden.
		const shaped = { chainId: NEXUS_CHAIN_ID, to: tx.to, value: 0n, data: tx.input };
		const decoded = decodeNexusBuyCover(shaped);
		if (!decoded.ok) stop('CALLDATA_POLICY_MISMATCH', ...decoded.errors);
		const allocations = decoded.call.allocations.map((a) => ({ poolId: a.poolId.toString(), coverAmountInAsset: a.coverAmountInAsset.toString() }));
		const total = decoded.call.allocations.reduce((s, a) => s + a.coverAmountInAsset, 0n);
		const policy = validateDecodedAgainstIntent(shaped, intentInput, { premiumRaw: intent.quotePremiumRaw.toString(), quoteTotalCoverAmountRaw: total.toString(), allocations });
		if (!policy.ok) stop('CALLDATA_POLICY_MISMATCH', ...policy.errors);
		pass('calldataPolicy');

		// Pins am Ausfuehrungsblock.
		if (keccak256(await rpc.agreed('eth_getCode', [RECEIPT_PINS.broker, atBlock])) !== RECEIPT_PINS.brokerCodeHash) stop('BROKER_DRIFT_AT_EXECUTION');
		pass('brokerCode');
		if (keccak256(await rpc.agreed('eth_getCode', [RECEIPT_PINS.coverProxy, atBlock])) !== RECEIPT_PINS.coverProxyCodeHash) stop('PROXY_DRIFT_AT_EXECUTION', 'PROXY_CODE');
		pass('proxyCode');
		const slot = await rpc.agreed('eth_getStorageAt', [RECEIPT_PINS.coverProxy, RECEIPT_PINS.coverImplementationSlot, atBlock]);
		if (typeof slot !== 'string' || !HASH.test(slot) || topicAddress(slot) !== RECEIPT_PINS.coverImplementation) stop('PROXY_DRIFT_AT_EXECUTION', 'PROXY_IMPLEMENTATION');
		pass('proxyImplementation');
		if (keccak256(await rpc.agreed('eth_getCode', [RECEIPT_PINS.coverImplementation, atBlock])) !== RECEIPT_PINS.coverImplementationCodeHash) stop('PROXY_DRIFT_AT_EXECUTION', 'IMPLEMENTATION_CODE');
		pass('implementationCode');

		// Ereignisse dieses Belegs.
		const coverId = coverBoughtOf(receipt.logs, intent);
		facts.coverId = coverId;
		pass('coverBought');
		nftMintOf(receipt.logs, intent, coverId);
		pass('nftMint');

		// Zustand am Ausfuehrungsblock, ueber beide Leser.
		const call = (to, selector) => rpc.agreed('eth_call', [{ to, data: viewCall(selector, coverId) }, atBlock]);
		const dataRaw = await call(RECEIPT_PINS.coverProxy, VIEW_SELECTORS.getCoverData);
		if (typeof dataRaw !== 'string' || dataRaw.length !== 2 + 8 * 64) stop('COVER_STATE_MISMATCH', 'COVER_DATA_SHAPE');
		const [[productId, coverAsset, amount, start, period]] = decodeStrict([{ type: 'tuple', components: [{ type: 'uint24' }, { type: 'uint8' }, { type: 'uint96' }, { type: 'uint32' }, { type: 'uint32' }, { type: 'uint32' }, { type: 'uint16' }, { type: 'uint16' }] }], dataRaw, 'getCoverData');
		const referenceRaw = await call(RECEIPT_PINS.coverProxy, VIEW_SELECTORS.getCoverReference);
		if (typeof referenceRaw !== 'string' || referenceRaw.length !== 2 + 2 * 64) stop('COVER_STATE_MISMATCH', 'COVER_REFERENCE_SHAPE');
		const [[originalCoverId]] = decodeStrict([{ type: 'tuple', components: [{ type: 'uint32' }, { type: 'uint32' }] }], referenceRaw, 'getCoverReference');
		const stateErrors = [];
		if (BigInt(productId) !== BigInt(intent.productId)) stateErrors.push('STATE_PRODUCT');
		if (BigInt(coverAsset) !== BigInt(intent.coverAssetId)) stateErrors.push('STATE_ASSET');
		if (BigInt(amount) < intent.amountRaw) stateErrors.push('STATE_AMOUNT_BELOW_INTENT');
		if (BigInt(period) !== BigInt(intent.periodDays) * 86400n) stateErrors.push('STATE_PERIOD');
		if (BigInt(start) !== quantity(block.timestamp, 'timestamp')) stateErrors.push('STATE_START');
		if (BigInt(originalCoverId) !== coverId) stateErrors.push('STATE_NOT_ORIGINAL');
		if (stateErrors.length) stop('COVER_STATE_MISMATCH', ...stateErrors);
		pass('coverState');
		const ownerRaw = await call(RECEIPT_PINS.coverNft, VIEW_SELECTORS.ownerOf);
		if (typeof ownerRaw !== 'string' || !HASH.test(ownerRaw) || topicAddress(ownerRaw) !== intent.wallet) stop('NFT_OWNER_MISMATCH', 'OWNER_OF');
		pass('coverOwner');
		const [metadata] = decodeStrict([{ type: 'string' }], await call(RECEIPT_PINS.coverProxy, VIEW_SELECTORS.getCoverMetadata), 'getCoverMetadata');
		if (metadata !== intent.proofOfLossCid) stop('POL_METADATA_MISMATCH');
		pass('metadata');

		const flow = tokenFlowErrors(receipt.logs, intent);
		if (flow.length) stop('TOKEN_FLOW_MISMATCH', ...flow);
		pass('tokenFlow');

		const unresolved = REQUIRED_CHECKS.filter((c) => checks[c] !== true);
		if (unresolved.length) stop('INVALID_INPUT', ...unresolved.map((c) => `UNRESOLVED:${c}`));
		return result(true, 'VERIFIED_COVER_PURCHASE', facts, checks, []);
	} catch (error) {
		if (error instanceof Stop) return result(false, error.status, facts, checks, error.errors);
		return result(false, 'TEMPORARY_RPC_FAILURE', facts, checks, ['UNEXPECTED_READ_ERROR']);
	}
}

function result(ok, status, facts, checks, errors) {
	const failedAt = ok ? null : REQUIRED_CHECKS.find((c) => checks[c] !== true) ?? null;
	if (failedAt) checks[failedAt] = false;
	return Object.freeze({ ok, status, coverId: ok ? facts.coverId : null, blockNumber: facts.blockNumber, blockHash: facts.blockHash, checks: Object.freeze({ ...checks }), errors: Object.freeze([...errors]) });
}
