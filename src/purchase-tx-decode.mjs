/*
	NEXUS P4C: UNABHAENGIGER DECODER (19.10.2026).

	Liest transaktionsfoermige Objekte (chainId, to, value, data) und prueft sie
	Feld fuer Feld gegen einen P4A-Intent und die Quote-Daten. Importiert den
	Builder NICHT: eigene ABI-Abschrift (gegen dieselbe verifizierte
	Rekompilierung getestet), eigene Erwartungswerte, eigene Ableitung der
	Laufzeit. Gemeinsam sind nur Pins und die primitiven P4A-Validatoren.

	Strikt: Selector exakt, Dekodierung muss kanonisch sein (Neu-Kodierung ergibt
	byte-gleich dieselben Daten, also keine angehaengten oder umgelenkten Bytes),
	jedes Feld exakt gleich. Kein "nah genug". Kein Netz, keine Wallet, keine Uhr.
	Ein gueltiges Ergebnis heisst nur: die Bytes entsprechen dem Intent - nicht,
	dass gesendet werden darf (productionReady bleibt false).
*/
import { decodeFunctionData, encodeFunctionData, keccak256 } from 'viem';
import { NEXUS_CONTRACT_SOURCES } from './nexus-pinned.mjs';
import { validatePurchaseIntent, validatePoolAllocations, computePurchaseIntentHash, normalizeWallet, parseRawUint } from './purchase-intent.mjs';

const BROKER = NEXUS_CONTRACT_SOURCES.CoverBroker.address.toLowerCase();
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const SELECTORS = Object.freeze({ buyCover: '0x7c59cac4', approve: '0x095ea7b3' });
const ZERO = `0x${'0'.repeat(40)}`;
/** Erwartete feste Werte, hier eigens festgelegt. */
const EXPECTED = Object.freeze({ chainId: 1, coverId: 0n, productId: 97, coverAsset: 6, paymentAsset: 6, commissionRatio: 0, commissionDestination: ZERO });

/** Eigene Abschrift von CoverBroker v2.12.1 buyCover (ICover.sol). */
export const DECODER_BUY_COVER_ABI = Object.freeze([{
	type: 'function', name: 'buyCover', stateMutability: 'payable',
	inputs: [
		{ name: 'params', type: 'tuple', components: [
			{ name: 'coverId', type: 'uint256' }, { name: 'owner', type: 'address' }, { name: 'productId', type: 'uint24' },
			{ name: 'coverAsset', type: 'uint8' }, { name: 'amount', type: 'uint96' }, { name: 'period', type: 'uint32' },
			{ name: 'maxPremiumInAsset', type: 'uint256' }, { name: 'paymentAsset', type: 'uint8' }, { name: 'commissionRatio', type: 'uint16' },
			{ name: 'commissionDestination', type: 'address' }, { name: 'ipfsData', type: 'string' }
		] },
		{ name: 'poolAllocationRequests', type: 'tuple[]', components: [{ name: 'poolId', type: 'uint256' }, { name: 'coverAmountInAsset', type: 'uint256' }] }
	],
	outputs: [{ name: 'coverId', type: 'uint256' }]
}]);
export const DECODER_APPROVE_ABI = Object.freeze([{
	type: 'function', name: 'approve', stateMutability: 'nonpayable',
	inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }]
}]);

/** Erlaubte Schluessel eines transaktionsfoermigen Objekts; gas, nonce, from, Gebuehren u. a. werden abgelehnt. */
const TX_KEYS = Object.freeze(['kind', 'chainId', 'to', 'value', 'data', 'intentId', 'intentHash', 'calldataHash', 'productionReady', 'blockers']);
const HEX_DATA = /^0x(?:[0-9a-f]{2})+$/;

function shapeErrors(tx, { to, kind }) {
	if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return ['TX_NOT_OBJECT'];
	const errors = Object.keys(tx).filter((k) => !TX_KEYS.includes(k)).map((k) => `TX_FIELD:${k}`);
	if (tx.chainId !== EXPECTED.chainId) errors.push('CHAIN');
	if (typeof tx.to !== 'string' || normalizeWallet(tx.to) !== to) errors.push('TARGET');
	if (tx.value !== 0n) errors.push('VALUE');
	if (typeof tx.data !== 'string' || !HEX_DATA.test(tx.data)) errors.push('DATA');
	else if (Object.hasOwn(tx, 'calldataHash') && tx.calldataHash !== keccak256(tx.data)) errors.push('CALLDATA_HASH');
	if (Object.hasOwn(tx, 'kind') && tx.kind !== kind) errors.push('KIND');
	if (Object.hasOwn(tx, 'productionReady') && tx.productionReady !== false) errors.push('PRODUCTION_READY_CLAIMED');
	return errors;
}

/** Selector exakt, Dekodierung kanonisch: neu kodiert muessen dieselben Bytes entstehen. */
function decodeStrict(abi, name, data) {
	if (data.slice(0, 10) !== SELECTORS[name]) return { error: 'SELECTOR' };
	let decoded;
	try { decoded = decodeFunctionData({ abi, data }); } catch { return { error: 'UNDECODABLE' }; }
	if (decoded.functionName !== name) return { error: 'SELECTOR' };
	let again;
	try { again = encodeFunctionData({ abi, functionName: name, args: decoded.args }); } catch { return { error: 'UNDECODABLE' }; }
	if (again !== data) return { error: 'NON_CANONICAL_ENCODING' };
	return { args: decoded.args };
}

/** Struktur einer USDC-Freigabe: Ziel USDC, value 0, approve(address,uint256). */
export function decodeUsdcApproval(tx) {
	const errors = shapeErrors(tx, { to: USDC, kind: 'USDC_APPROVAL' });
	if (errors.includes('DATA') || errors.includes('TX_NOT_OBJECT')) return Object.freeze({ ok: false, errors: Object.freeze(errors) });
	const { args, error } = decodeStrict(DECODER_APPROVE_ABI, 'approve', tx.data);
	if (error) errors.push(error);
	if (errors.length) return Object.freeze({ ok: false, errors: Object.freeze(errors) });
	return Object.freeze({ ok: true, call: Object.freeze({ spender: args[0].toLowerCase(), amount: args[1] }) });
}

/** Struktur eines buyCover-Aufrufs am verifizierten Broker. */
export function decodeNexusBuyCover(tx) {
	const errors = shapeErrors(tx, { to: BROKER, kind: 'NEXUS_BUY_COVER' });
	if (errors.includes('DATA') || errors.includes('TX_NOT_OBJECT')) return Object.freeze({ ok: false, errors: Object.freeze(errors) });
	const { args, error } = decodeStrict(DECODER_BUY_COVER_ABI, 'buyCover', tx.data);
	if (error) errors.push(error);
	if (errors.length) return Object.freeze({ ok: false, errors: Object.freeze(errors) });
	const [p, requests] = args;
	return Object.freeze({ ok: true, call: Object.freeze({
		params: Object.freeze({ ...p, owner: p.owner.toLowerCase(), commissionDestination: p.commissionDestination.toLowerCase() }),
		allocations: Object.freeze(requests.map((a) => Object.freeze({ poolId: a.poolId, coverAmountInAsset: a.coverAmountInAsset })))
	}) });
}

function bindingErrors(tx, intentInput, intent) {
	const errors = [];
	if (Object.hasOwn(tx, 'intentId') && tx.intentId !== intent.id) errors.push('INTENT_ID');
	if (Object.hasOwn(tx, 'intentHash') && tx.intentHash !== computePurchaseIntentHash(intentInput)) errors.push('INTENT_HASH');
	return errors;
}

function validateApproval(tx, intentInput, intent) {
	const decoded = decodeUsdcApproval(tx);
	if (!decoded.ok) return decoded.errors;
	const { spender, amount } = decoded.call;
	const errors = [];
	if (spender !== BROKER) errors.push('SPENDER');
	if (amount !== intent.maxPremiumRaw) errors.push('APPROVAL_AMOUNT');
	if (amount > intent.amountRaw) errors.push('APPROVAL_UNBOUNDED');
	return [...errors, ...bindingErrors(tx, intentInput, intent)];
}

function quoteErrors(intentInput, intent, quote) {
	if (!quote || typeof quote !== 'object' || Object.keys(quote).sort().join() !== 'allocations,premiumRaw,quoteTotalCoverAmountRaw') return ['QUOTE_SHAPE'];
	const errors = [];
	const premium = parseRawUint(quote.premiumRaw, { positive: true });
	if (premium === null || premium > intent.maxPremiumRaw) errors.push('QUOTE_PREMIUM');
	const allocation = validatePoolAllocations({ requestedAmountRaw: intentInput.amountRaw, quoteTotalCoverAmountRaw: quote.quoteTotalCoverAmountRaw, allocations: quote.allocations });
	if (!allocation.ok) errors.push('QUOTE_ALLOCATIONS');
	return errors;
}

function validateBuyCover(tx, intentInput, intent, quote) {
	const expectedQuote = quoteErrors(intentInput, intent, quote);
	if (expectedQuote.length) return expectedQuote;
	const decoded = decodeNexusBuyCover(tx);
	if (!decoded.ok) return decoded.errors;
	const { params: p, allocations } = decoded.call;
	const errors = [];
	if (p.coverId !== EXPECTED.coverId) errors.push('COVER_ID');
	if (p.owner !== intent.wallet) errors.push('OWNER');
	if (p.productId !== EXPECTED.productId) errors.push('PRODUCT');
	if (p.coverAsset !== EXPECTED.coverAsset) errors.push('COVER_ASSET');
	if (p.paymentAsset !== EXPECTED.paymentAsset) errors.push('PAYMENT_ASSET');
	if (p.amount !== intent.amountRaw) errors.push('AMOUNT');
	if (p.period !== intent.periodDays * 24 * 60 * 60) errors.push('PERIOD');
	if (p.maxPremiumInAsset !== intent.maxPremiumRaw) errors.push('MAX_PREMIUM');
	if (p.commissionRatio !== EXPECTED.commissionRatio) errors.push('COMMISSION_RATIO');
	if (p.commissionDestination !== EXPECTED.commissionDestination) errors.push('COMMISSION_DESTINATION');
	if (intent.proofOfLossCid === null) errors.push('PROOF_OF_LOSS_MISSING');
	else if (p.ipfsData !== intent.proofOfLossCid) errors.push('PROOF_OF_LOSS_CID');
	const want = quote.allocations;
	if (allocations.length !== want.length || allocations.some((a, i) => a.poolId !== BigInt(want[i].poolId) || a.coverAmountInAsset !== BigInt(want[i].coverAmountInAsset))) errors.push('ALLOCATIONS');
	return [...errors, ...bindingErrors(tx, intentInput, intent)];
}

/**
 * Prueft eine Transaktion semantisch gegen Intent (und bei buyCover die Quote-Daten). Die Art
 * folgt dem Selector. Liefert { ok, errors, productionReady: false }.
 */
export function validateDecodedAgainstIntent(tx, intentInput, quoteContext) {
	const result = (errors) => Object.freeze({ ok: errors.length === 0, errors: Object.freeze([...errors]), productionReady: false });
	const checked = validatePurchaseIntent(intentInput);
	if (!checked.ok) return result(['INTENT_INVALID']);
	const selector = typeof tx?.data === 'string' ? tx.data.slice(0, 10) : null;
	if (selector === SELECTORS.approve) return result(validateApproval(tx, intentInput, checked.intent));
	if (selector === SELECTORS.buyCover) return result(validateBuyCover(tx, intentInput, checked.intent, quoteContext));
	return result(['SELECTOR']);
}
