/*
	NEXUS P4C: OFFLINE-TRANSAKTIONSBUILDER (19.10.2026).

	Kodiert genau zwei Transaktionsarten als reine Bytes zur Offline-Pruefung:
	  - USDC_APPROVAL: USDC.approve(CoverBroker, intent.maxPremiumRaw)
	  - NEXUS_BUY_COVER: CoverBroker.buyCover(params, allocations), USDC, value 0
	Nichts davon wird gesendet, signiert oder gespeichert; kein Wallet-, Netz-,
	RPC-, DB-, Datei-, Umgebungs- oder Uhrzugriff. Kein generischer Aufruf: Ziel,
	ABI, Funktion, Spender und jeder autoritative Parameter stehen hier fest oder
	kommen aus dem validierten P4A-Intent. Der Aufrufer liefert nur den Intent und
	die frischen Quote-Daten (Praemie, Gesamtdeckung, Allokationen).

	Jede Ausgabe traegt productionReady: false. Echte Nutzung bleibt gesperrt:
	Proof-of-Loss ungeklaert (P4B, CR-POL-002), Nexus-Texte unbestaetigt
	(CR-TERMS-002), kein gepruefter Wallet-Pfad (CR-PURCHASE-008 P3).

	Faehigkeit des Builders selbst: nur offline (BUILDER_CAPABILITY). Er kennt von
	USDC nur die Adresse und liest nie die Kette. Bis P4F (20.10.2026) hiess das
	global "USDC_IMPLEMENTATION_NOT_PINNED" und "NO_PRE_SEND_CHAIN_VALIDATION";
	beides leistet seither ausserhalb des Builders der nur lesende Pre-Send-Pruefer
	(src/purchase-pre-send.mjs: unabhaengiger USDC-Pin, Pins an einem Block). Ein
	spaeterer Wallet-Pfad muss ihn unmittelbar vor der Wallet-Anfrage ausfuehren;
	diese Verdrahtung fehlt (EXTERNAL_REQUIRED_CONTROLS).

	Broker-ABI: lokal festgeschrieben nach NexusMutual/smart-contracts v2.12.1
	(Commit 20082c81, ICover.sol BuyCoverParams / PoolAllocationRequest), geprueft
	gegen die unabhaengige Rekompilierung (P4C-ABI in test/purchase-tx-builder.test.mjs,
	Selector 0x7c59cac4). Nicht die v3-ABI aus @nexusmutual/deployments.

	Die Gegenpruefung leistet src/purchase-tx-decode.mjs, das diesen Builder
	nicht importiert.
*/
import { encodeFunctionData, keccak256 } from 'viem';
import { NEXUS_CHAIN_ID, NEXUS_CONTRACT_SOURCES } from './nexus-pinned.mjs';
import { validatePurchaseIntent, validatePoolAllocations, computePurchaseIntentHash, parseRawUint, MVP_PRODUCT_ID, COMMISSION_POLICY } from './purchase-intent.mjs';

/** Ethereum-Mainnet-USDC. Der Builder kennt nur die Adresse; Proxy und Implementierung pinnt und prueft P4F, nicht der Builder. */
export const USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
/** Bis P4F: 'ADDRESS_ONLY_IMPLEMENTATION_NOT_PINNED'. Fuer den Builder allein gilt weiter "nur Adresse"; der Pin liegt extern. */
export const USDC_PIN_STATUS = 'BUILDER_ADDRESS_ONLY_PIN_EXTERNAL_P4F';
/** Der Builder kodiert nur Bytes; er liest keine Kette, prueft keine Pins und fuehrt nichts aus. */
export const BUILDER_CAPABILITY = 'OFFLINE_ONLY';
/** Was ausserhalb des Builders vor echter Nutzung erfuellt sein muss, und durch wen. Satisfied heisst: das Modul existiert, nicht dass es verdrahtet ist. */
export const EXTERNAL_REQUIRED_CONTROLS = Object.freeze({
	USDC_PIN: 'SATISFIED_BY_P4F',
	PRE_SEND_CHAIN_VALIDATION: 'SATISFIED_BY_P4F',
	RECEIPT_BEFORE_CONFIRMATION: 'SATISFIED_BY_P4G',
	WALLET_ORCHESTRATION: 'UNRESOLVED',
	TERMS: 'UNRESOLVED',
	PROOF_OF_LOSS: 'UNRESOLVED'
});
const USDC_ASSET_ID = 6;
export const BROKER_ADDRESS = NEXUS_CONTRACT_SOURCES.CoverBroker.address.toLowerCase();
export const BUY_COVER_SELECTOR = '0x7c59cac4';
export const APPROVE_SELECTOR = '0x095ea7b3';
export const TX_KINDS = Object.freeze(['USDC_APPROVAL', 'NEXUS_BUY_COVER']);

/**
 * Warum keine Ausgabe produktionsreif ist. Bis P4F zusaetzlich USDC_IMPLEMENTATION_NOT_PINNED und
 * NO_PRE_SEND_CHAIN_VALIDATION; beide sind seit P4F extern geloest (EXTERNAL_REQUIRED_CONTROLS), aber erst
 * ein Wallet-Pfad, der den Pre-Send-Pruefer ausfuehrt, macht sie wirksam - daher WALLET_ORCHESTRATION_UNRESOLVED.
 */
export const PRODUCTION_BLOCKERS = Object.freeze(['PROOF_OF_LOSS_UNRESOLVED', 'NEXUS_TEXTS_UNCONFIRMED', 'WALLET_ORCHESTRATION_UNRESOLVED']);

/** CoverBroker v2.12.1 buyCover, Feldreihenfolge und Typen wie im verifizierten Quellcode. */
export const BROKER_BUY_COVER_ABI = Object.freeze([{
	type: 'function', name: 'buyCover', stateMutability: 'payable',
	inputs: [
		{ name: 'params', type: 'tuple', internalType: 'struct BuyCoverParams', components: [
			{ name: 'coverId', type: 'uint256' },
			{ name: 'owner', type: 'address' },
			{ name: 'productId', type: 'uint24' },
			{ name: 'coverAsset', type: 'uint8' },
			{ name: 'amount', type: 'uint96' },
			{ name: 'period', type: 'uint32' },
			{ name: 'maxPremiumInAsset', type: 'uint256' },
			{ name: 'paymentAsset', type: 'uint8' },
			{ name: 'commissionRatio', type: 'uint16' },
			{ name: 'commissionDestination', type: 'address' },
			{ name: 'ipfsData', type: 'string' }
		] },
		{ name: 'poolAllocationRequests', type: 'tuple[]', internalType: 'struct PoolAllocationRequest[]', components: [
			{ name: 'poolId', type: 'uint256' },
			{ name: 'coverAmountInAsset', type: 'uint256' }
		] }
	],
	outputs: [{ name: 'coverId', type: 'uint256' }]
}]);

/** ERC-20 approve(address,uint256); einzige erlaubte Freigabeart. */
export const ERC20_APPROVE_ABI = Object.freeze([{
	type: 'function', name: 'approve', stateMutability: 'nonpayable',
	inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
	outputs: [{ name: '', type: 'bool' }]
}]);

const QUOTE_FIELDS = Object.freeze(['premiumRaw', 'quoteTotalCoverAmountRaw', 'allocations']);

/** Genau diese Eingabeschluessel; alles andere (to, data, abi, spender, owner, ...) wird abgelehnt. */
function inputErrors(input, keys) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return ['INPUT_NOT_OBJECT'];
	const errors = Object.keys(input).filter((k) => !keys.includes(k)).map((k) => `UNKNOWN_INPUT:${k}`);
	for (const k of keys) if (!Object.hasOwn(input, k)) errors.push(`MISSING_INPUT:${k}`);
	return errors;
}

/** P4A-Validierung plus P4C-Grenzen: Mainnet, nur USDC, Freigabe nie ueber der Deckungssumme. */
function checkedIntent(raw) {
	const result = validatePurchaseIntent(raw);
	if (!result.ok) return { errors: result.errors.map((e) => `INTENT:${e}`) };
	const { intent } = result;
	const errors = [];
	if (intent.chainId !== NEXUS_CHAIN_ID) errors.push('CHAIN');
	if (intent.coverAssetId !== USDC_ASSET_ID) errors.push('UNSUPPORTED_ASSET');
	// Praemie nie hoeher als die Deckung (uint96): schliesst unbegrenzte Freigaben aus
	if (intent.maxPremiumRaw > intent.amountRaw) errors.push('MAX_PREMIUM_ABOVE_COVER_AMOUNT');
	return { intent, errors };
}

const failed = (errors) => Object.freeze({ ok: false, errors: Object.freeze([...errors]) });
const output = (fields) => Object.freeze({ ok: true, tx: Object.freeze({ ...fields, calldataHash: keccak256(fields.data), productionReady: false, blockers: PRODUCTION_BLOCKERS }) });

/** USDC.approve(Broker, intent.maxPremiumRaw). Eingabe: { intent }. */
export function buildExactUsdcApproval(input) {
	const shape = inputErrors(input, ['intent']);
	if (shape.length) return failed(shape);
	const { intent, errors } = checkedIntent(input.intent);
	if (errors.length) return failed(errors);
	const amount = intent.maxPremiumRaw;
	if (amount <= 0n) return failed(['APPROVAL_AMOUNT']);
	const data = encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [BROKER_ADDRESS, amount] });
	if (data.slice(0, 10) !== APPROVE_SELECTOR) throw new Error('approve selector drift');
	return output({ kind: 'USDC_APPROVAL', chainId: NEXUS_CHAIN_ID, to: USDC_ADDRESS, value: 0n, data, intentId: intent.id, intentHash: computePurchaseIntentHash(input.intent) });
}

/**
 * CoverBroker.buyCover fuer einen USDC-Intent. Eingabe: { intent, quote: { premiumRaw,
 * quoteTotalCoverAmountRaw, allocations } }. ipfsData ist die im Intent gebundene
 * Proof-of-Loss-CID; ohne sie wird nichts gebaut (nie leeres ipfsData).
 */
export function buildNexusBuyCover(input) {
	const shape = inputErrors(input, ['intent', 'quote']);
	if (shape.length) return failed(shape);
	const { intent, errors } = checkedIntent(input.intent);
	if (!intent) return failed(errors);
	const { quote } = input;
	const quoteShape = inputErrors(quote, QUOTE_FIELDS).map((e) => `QUOTE:${e}`);
	if (quoteShape.length) return failed([...errors, ...quoteShape]);

	const premium = parseRawUint(quote.premiumRaw, { positive: true });
	if (premium === null) errors.push('QUOTE_PREMIUM');
	else if (premium > intent.maxPremiumRaw) errors.push('QUOTE_PREMIUM_ABOVE_MAX');
	const allocation = validatePoolAllocations({ requestedAmountRaw: input.intent.amountRaw, quoteTotalCoverAmountRaw: quote.quoteTotalCoverAmountRaw, allocations: quote.allocations });
	if (!allocation.ok) errors.push(...allocation.errors.map((e) => `ALLOCATION:${e}`));
	if (intent.proofOfLossCid === null) errors.push('PROOF_OF_LOSS_CID_MISSING');
	if (errors.length) return failed(errors);

	const params = {
		coverId: 0n,
		owner: intent.wallet,
		productId: MVP_PRODUCT_ID,
		coverAsset: USDC_ASSET_ID,
		amount: intent.amountRaw,
		period: intent.periodDays * 86400,
		maxPremiumInAsset: intent.maxPremiumRaw,
		paymentAsset: USDC_ASSET_ID,
		commissionRatio: COMMISSION_POLICY.ratio,
		commissionDestination: COMMISSION_POLICY.destination,
		ipfsData: intent.proofOfLossCid
	};
	const allocations = quote.allocations.map((a) => ({ poolId: BigInt(a.poolId), coverAmountInAsset: BigInt(a.coverAmountInAsset) }));
	const data = encodeFunctionData({ abi: BROKER_BUY_COVER_ABI, functionName: 'buyCover', args: [params, allocations] });
	if (data.slice(0, 10) !== BUY_COVER_SELECTOR) throw new Error('buyCover selector drift');
	return output({ kind: 'NEXUS_BUY_COVER', chainId: NEXUS_CHAIN_ID, to: BROKER_ADDRESS, value: 0n, data, intentId: intent.id, intentHash: computePurchaseIntentHash(input.intent) });
}
