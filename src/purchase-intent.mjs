/*
	NEXUS P4A: REINES KAUF-INTENT-MODELL (19.10.2026).

	Das ist KEIN Kauf, KEINE Wallet-Anbindung, KEIN Transaktions-Builder und
	KEINE Datenbank. Dieses Modul liefert nur:
	  - das kanonische Intent-Modell und seine Validierung,
	  - den kanonischen Intent-Hash (keccak256 ueber abi.encode, Version 1),
	  - die reinen Zustandsuebergaenge,
	  - die Pruefung der Pool-Allokationen nach Cover v3.3.0,
	  - eine Bereitschaftsaussage, die nie "sendebereit" lautet.

	Rein: keine Netz-, RPC-, DB-, Wallet-, Datei- oder Umgebungszugriffe, keine
	Uhr (jede Zeit wird uebergeben). Bis zu spaeteren P4-Phasen importiert nur
	test/ dieses Modul (Import-Guard in test/purchase-intent.test.mjs).

	Grundlage: verifizierte Quellen (SRC-NEXUS-COVERBROKER v2.12.1,
	SRC-NEXUS-COVER v3.3.0). Cover v3.3.0 _requestAllocation rechnet jede
	Allokation aufgerundet in NXM-Einheiten um und verlangt nur
	Summe >= amount; gespeichert wird die Summe. Kommission 0 heisst dort: kein
	Transfer, das Ziel wird nicht gelesen.
*/
import { encodeAbiParameters, keccak256, isAddress } from 'viem';
import { NEXUS_CHAIN_ID, NEXUS_CONTRACT_SOURCES, PINNED_PRODUCTS, COVER_PERIOD_DAYS } from './nexus-pinned.mjs';

export const PURCHASE_INTENT_DOMAIN = 'coverraccoon.purchase-intent';
export const PURCHASE_INTENT_HASH_VERSION = 1;

/** Version des Vertrags-Pins, an den ein Intent gebunden ist. Aendert sich ein Pin, aendert sich diese Kennung. */
export const PURCHASE_PIN_VERSION = 'nexus-pin-1:broker-v2.12.1:cover-v3.3.0';

const { CoverBroker: brokerPin, Cover: coverPin } = NEXUS_CONTRACT_SOURCES;
/** Die im Hash gebundenen Vertragsidentitaeten (nur Referenz, kein Aufruf). */
export const PURCHASE_PINS = Object.freeze({
	broker: brokerPin.address.toLowerCase(),
	brokerCodeHash: brokerPin.runtime.keccak256,
	coverProxy: coverPin.address.toLowerCase(),
	coverImplementation: coverPin.implementation.toLowerCase(),
	coverImplementationCodeHash: coverPin.runtime.keccak256
});

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** P4A-Politik: keine Kommission, kein Ziel. SDK-Voreinstellungen (Produkttyp-Kommission) gelten nicht. */
export const COMMISSION_POLICY = Object.freeze({ ratio: 0, destination: ZERO_ADDRESS });

export const MVP_DEPLOYMENT_KEYS = Object.freeze(['aave-v3-ethereum-core']);
export const MVP_PRODUCT_ID = 97;
export const MVP_COVER_ASSET_IDS = Object.freeze([6]); // USDC
export const INTENT_MAX_LIFETIME_SECONDS = 15 * 60;
export const QUOTE_MAX_AGE_SECONDS = 60;
export const ALLOCATION_MAX_COUNT = 10;
/** Versionierte Obergrenze fuer die Ueberdeckung der Allokationen gegenueber dem angefragten Betrag. */
export const ALLOCATION_MAX_OVERSHOOT_BPS = 100;

const UINT96_MAX = (1n << 96n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const UINT40_MAX = (1n << 40n) - 1n;
const TIMESTAMP_MAX = 2 ** 40;
const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1_BASE32 = /^b[a-z2-7]{58}$/;
const PIN_VERSION = /^[a-z0-9][a-z0-9.:+_-]{2,63}$/;

/** Genau diese Felder; abgeleitete Werte (periodSeconds, owner) und alles andere werden abgelehnt. */
export const INTENT_FIELDS = Object.freeze([
	'id', 'wallet', 'chainId', 'deploymentKey', 'productId', 'productTypeId', 'coverAssetId', 'amountRaw', 'periodDays',
	'quotePremiumRaw', 'maxPremiumRaw', 'quoteFetchedAt', 'capacityFetchedAt', 'wordingCid', 'annexCid', 'termsHash',
	'proofOfLossCid', 'commissionRatio', 'commissionDestination', 'pinVersion', 'acknowledgedAt', 'expiresAt'
]);

/** Kanonische Ganzzahl-Zeichenkette -> BigInt. Keine Vorzeichen, Exponenten, Dezimalstellen, Leerzeichen, fuehrenden Nullen. */
export function parseRawUint(value, { max = UINT256_MAX, positive = false } = {}) {
	if (typeof value !== 'string' || !CANONICAL_UINT.test(value)) return null;
	const n = BigInt(value);
	if (n > max || (positive && n === 0n)) return null;
	return n;
}

const isSafeTimestamp = (t) => Number.isSafeInteger(t) && t > 0 && t < TIMESTAMP_MAX;
const isCid = (c) => typeof c === 'string' && (CID_V0.test(c) || CID_V1_BASE32.test(c));

function normalizeWallet(value) {
	if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
	// gemischte Schreibweise nur mit gueltiger EIP-55-Pruefsumme
	if (value !== value.toLowerCase() && value.slice(2) !== value.slice(2).toUpperCase() && !isAddress(value, { strict: true })) return null;
	return value.toLowerCase();
}

/**
 * Prueft einen Intent gegen das P4A-Modell. Liefert { ok: true, intent } mit kanonischen Werten
 * (BigInt fuer Rohbetraege, Kleinschreibung fuer Adressen) oder { ok: false, errors }.
 */
export function validatePurchaseIntent(input) {
	const errors = [];
	const fail = (code) => { errors.push(code); };
	if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['NOT_AN_OBJECT'] };
	for (const key of Object.keys(input)) if (!INTENT_FIELDS.includes(key)) fail(`UNKNOWN_FIELD:${key}`);
	for (const key of INTENT_FIELDS) if (!Object.hasOwn(input, key)) fail(`MISSING_FIELD:${key}`);
	if (errors.length) return { ok: false, errors };

	const id = typeof input.id === 'string' && UUID.test(input.id) ? input.id : (fail('ID'), null);
	const wallet = normalizeWallet(input.wallet) ?? (fail('WALLET'), null);
	if (input.chainId !== NEXUS_CHAIN_ID) fail('CHAIN');
	if (!MVP_DEPLOYMENT_KEYS.includes(input.deploymentKey)) fail('DEPLOYMENT');
	const product = PINNED_PRODUCTS[MVP_PRODUCT_ID];
	if (input.productId !== MVP_PRODUCT_ID) fail('PRODUCT');
	if (input.productTypeId !== product.productTypeId) fail('PRODUCT_TYPE');
	if (!MVP_COVER_ASSET_IDS.includes(input.coverAssetId)) fail('COVER_ASSET');
	const amountRaw = parseRawUint(input.amountRaw, { max: UINT96_MAX, positive: true }) ?? (fail('AMOUNT'), null);
	if (!Number.isInteger(input.periodDays) || input.periodDays < COVER_PERIOD_DAYS.min || input.periodDays > COVER_PERIOD_DAYS.max) fail('PERIOD');
	const quotePremiumRaw = parseRawUint(input.quotePremiumRaw, { positive: true }) ?? (fail('QUOTE_PREMIUM'), null);
	const maxPremiumRaw = parseRawUint(input.maxPremiumRaw, { positive: true }) ?? (fail('MAX_PREMIUM'), null);
	if (quotePremiumRaw !== null && maxPremiumRaw !== null && maxPremiumRaw < quotePremiumRaw) fail('MAX_PREMIUM_BELOW_QUOTE');
	if (!isCid(input.wordingCid) || input.wordingCid !== product.wordingCid) fail('WORDING_CID');
	if (input.annexCid !== null && !isCid(input.annexCid)) fail('ANNEX_CID');
	if (input.annexCid !== product.annexCid) fail('ANNEX_CID_NOT_PINNED');
	if (typeof input.termsHash !== 'string' || !BYTES32.test(input.termsHash)) fail('TERMS_HASH');
	if (input.proofOfLossCid !== null && !isCid(input.proofOfLossCid)) fail('PROOF_OF_LOSS_CID');
	if (input.commissionRatio !== COMMISSION_POLICY.ratio) fail('COMMISSION_RATIO');
	if (input.commissionDestination !== COMMISSION_POLICY.destination) fail('COMMISSION_DESTINATION');
	if (typeof input.pinVersion !== 'string' || !PIN_VERSION.test(input.pinVersion) || input.pinVersion !== PURCHASE_PIN_VERSION) fail('PIN_VERSION');

	const times = ['quoteFetchedAt', 'capacityFetchedAt', 'acknowledgedAt', 'expiresAt'];
	for (const key of times) if (!isSafeTimestamp(input[key])) fail(`TIME:${key}`);
	if (times.every((key) => isSafeTimestamp(input[key]))) {
		const { quoteFetchedAt, capacityFetchedAt, acknowledgedAt, expiresAt } = input;
		if (quoteFetchedAt > acknowledgedAt || acknowledgedAt - quoteFetchedAt > QUOTE_MAX_AGE_SECONDS) fail('QUOTE_STALE_AT_ACKNOWLEDGEMENT');
		if (capacityFetchedAt > acknowledgedAt || acknowledgedAt - capacityFetchedAt > QUOTE_MAX_AGE_SECONDS) fail('CAPACITY_STALE_AT_ACKNOWLEDGEMENT');
		if (expiresAt <= acknowledgedAt) fail('EXPIRES_NOT_AFTER_ACKNOWLEDGEMENT');
		if (expiresAt - acknowledgedAt > INTENT_MAX_LIFETIME_SECONDS) fail('LIFETIME_TOO_LONG');
	}
	if (errors.length) return { ok: false, errors };
	return { ok: true, intent: Object.freeze({ ...input, id, wallet, amountRaw, quotePremiumRaw, maxPremiumRaw }) };
}

/** Abgeleitete Werte; nie Eingabe. */
export const periodSecondsOf = (intent) => BigInt(intent.periodDays) * 86400n;
export const ownerOf = (intent) => intent.wallet;

const HASH_LAYOUT = [
	['string', 'domain'], ['uint8', 'version'], ['bytes16', 'id'], ['address', 'wallet'], ['uint256', 'chainId'],
	['address', 'broker'], ['bytes32', 'brokerCodeHash'], ['address', 'coverProxy'], ['address', 'coverImplementation'], ['bytes32', 'coverImplementationCodeHash'],
	['uint256', 'productId'], ['uint256', 'productTypeId'], ['uint256', 'coverAssetId'], ['uint256', 'amountRaw'], ['uint256', 'periodSeconds'],
	['uint256', 'maxPremiumRaw'], ['bytes32', 'termsHash'], ['string', 'proofOfLossCid'], ['uint256', 'commissionRatio'], ['address', 'commissionDestination'],
	['address', 'owner'], ['uint256', 'expiresAt'], ['string', 'pinVersion'],
	// ab hier: weitere sicherheitsrelevante Felder des Modells, feste Reihenfolge
	['string', 'deploymentKey'], ['uint256', 'quotePremiumRaw'], ['uint256', 'quoteFetchedAt'], ['uint256', 'capacityFetchedAt'], ['uint256', 'acknowledgedAt'],
	['string', 'wordingCid'], ['string', 'annexCid']
];
export const PURCHASE_INTENT_HASH_FIELDS = Object.freeze(HASH_LAYOUT.map(([, name]) => name));

/**
 * Kodiert einen bereits kanonischen Intent mit gegebenen Pins (abi.encode, feste Reihenfolge).
 * Nur fuer computePurchaseIntentHash und Tests der Feldbindung; prueft keine Politik.
 */
export function encodeCanonicalIntent(intent, pins) {
	const values = {
		domain: PURCHASE_INTENT_DOMAIN, version: PURCHASE_INTENT_HASH_VERSION, id: `0x${intent.id.replaceAll('-', '')}`, wallet: intent.wallet, chainId: BigInt(intent.chainId),
		broker: pins.broker, brokerCodeHash: pins.brokerCodeHash, coverProxy: pins.coverProxy, coverImplementation: pins.coverImplementation, coverImplementationCodeHash: pins.coverImplementationCodeHash,
		productId: BigInt(intent.productId), productTypeId: BigInt(intent.productTypeId), coverAssetId: BigInt(intent.coverAssetId), amountRaw: intent.amountRaw, periodSeconds: periodSecondsOf(intent),
		maxPremiumRaw: intent.maxPremiumRaw, termsHash: intent.termsHash, proofOfLossCid: intent.proofOfLossCid ?? '', commissionRatio: BigInt(intent.commissionRatio), commissionDestination: intent.commissionDestination,
		owner: ownerOf(intent), expiresAt: BigInt(intent.expiresAt), pinVersion: intent.pinVersion,
		deploymentKey: intent.deploymentKey, quotePremiumRaw: intent.quotePremiumRaw, quoteFetchedAt: BigInt(intent.quoteFetchedAt), capacityFetchedAt: BigInt(intent.capacityFetchedAt), acknowledgedAt: BigInt(intent.acknowledgedAt),
		wordingCid: intent.wordingCid, annexCid: intent.annexCid ?? ''
	};
	return encodeAbiParameters(HASH_LAYOUT.map(([type]) => ({ type })), HASH_LAYOUT.map(([, name]) => values[name]));
}

/**
 * Kanonischer Intent-Hash. Validiert zuerst; ein ungueltiger Intent hat keinen Hash (wirft).
 * Ein mitgelieferter Hash ist kein Feld des Modells und wird als unbekanntes Feld abgelehnt.
 */
export function computePurchaseIntentHash(input) {
	const result = validatePurchaseIntent(input);
	if (!result.ok) throw new Error(`INVALID_PURCHASE_INTENT: ${result.errors.join(',')}`);
	return keccak256(encodeCanonicalIntent(result.intent, PURCHASE_PINS));
}

/* ------------------------------------------------------------ Zustaende -- */

export const INTENT_STATUSES = Object.freeze(['OPEN', 'BUILT', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED']);
const TRANSITIONS = Object.freeze({
	OPEN: Object.freeze(['BUILT', 'EXPIRED', 'CANCELLED']),
	BUILT: Object.freeze(['SUBMITTED', 'EXPIRED', 'CANCELLED']),
	// Nach der Einreichung gibt es kein Abbrechen und kein Ablaufen: die Transaktion kann noch gemined werden.
	SUBMITTED: Object.freeze(['CONFIRMED', 'FAILED']),
	CONFIRMED: Object.freeze([]),
	FAILED: Object.freeze([]),
	EXPIRED: Object.freeze([]),
	CANCELLED: Object.freeze([])
});

const known = (status) => INTENT_STATUSES.includes(status);
export const canTransition = (from, to) => known(from) && known(to) && TRANSITIONS[from].includes(to);
export function assertTransition(from, to) {
	if (!canTransition(from, to)) throw new Error(`ILLEGAL_TRANSITION: ${from} -> ${to}`);
}
export const isTerminal = (status) => known(status) && TRANSITIONS[status].length === 0;
export const canBuild = (status) => status === 'OPEN';
export const canSubmit = (status) => status === 'BUILT';
export const canConfirm = (status) => status === 'SUBMITTED';

/**
 * Kann zu diesem Intent noch eine echte On-Chain-Transaktion auftauchen? Das ist eine Beobachtung,
 * kein Anwendungszustand: SUBMITTED immer; EXPIRED/CANCELLED nur, wenn vorher BUILT war (die Wallet
 * hatte die Transaktion schon). Ein spaeterer Treffer wird spaeter als Beobachtung festgehalten,
 * ein terminaler Zustand wird dadurch nicht wieder geoeffnet.
 */
export function lateOnChainOutcomePossible(status, { builtBefore }) {
	if (typeof builtBefore !== 'boolean') throw new Error('builtBefore must be stated explicitly');
	if (status === 'SUBMITTED') return true;
	if (status === 'EXPIRED' || status === 'CANCELLED') return builtBefore;
	return false;
}

/* --------------------------------------------------------------- Ablauf -- */

const assertNow = (now) => { if (!isSafeTimestamp(now)) throw new Error('now must be an explicit unix timestamp in seconds'); };
export function isIntentExpired(intent, now) {
	assertNow(now);
	return now >= intent.expiresAt;
}

/**
 * Was bedeutet der Ablauf fuer diesen Zustand?
 *   USABLE        OPEN/BUILT vor expiresAt
 *   EXPIRE        OPEN/BUILT ab expiresAt -> Uebergang nach EXPIRED
 *   AWAIT_CHAIN   SUBMITTED: der Ablauf spielt keine Rolle, nur die Kette entscheidet
 *   TERMINAL      sonst
 */
export function expiryEffect(status, intent, now) {
	if (status === 'SUBMITTED') return 'AWAIT_CHAIN';
	if (status === 'OPEN' || status === 'BUILT') return isIntentExpired(intent, now) ? 'EXPIRE' : 'USABLE';
	if (isTerminal(status)) return 'TERMINAL';
	throw new Error(`UNKNOWN_STATUS: ${status}`);
}

/** Wirft, wenn der Intent in diesem Zustand zu diesem Zeitpunkt nicht weiterverwendet werden darf. */
export function assertIntentUsable(intent, now, status) {
	if (status !== 'OPEN' && status !== 'BUILT') throw new Error(`INTENT_NOT_USABLE_IN_STATUS: ${status}`);
	if (isIntentExpired(intent, now)) throw new Error('INTENT_EXPIRED');
}

/* -------------------------------------------------------- Bereitschaft -- */

export const READINESS = Object.freeze(['READY_MODEL_ONLY', 'BLOCKED_PROOF_OF_LOSS', 'INVALID_INTENT', 'EXPIRED']);

/**
 * Reine Bereitschaftsaussage. purpose 'MODEL': ist das Modell gueltig? purpose 'TRANSACTION': in P4A
 * nie bereit - Proof-of-Loss ist ungeklaert (NEXUS_CONFIRMATION_REQUIRED), auch mit CID.
 */
export function evaluateIntentReadiness(input, { now, purpose }) {
	assertNow(now);
	if (purpose !== 'MODEL' && purpose !== 'TRANSACTION') throw new Error('purpose must be MODEL or TRANSACTION');
	const result = validatePurchaseIntent(input);
	if (!result.ok) return Object.freeze({ status: 'INVALID_INTENT', reasons: Object.freeze([...result.errors]) });
	if (isIntentExpired(result.intent, now)) return Object.freeze({ status: 'EXPIRED', reasons: Object.freeze(['INTENT_EXPIRED']) });
	if (purpose === 'TRANSACTION') return Object.freeze({ status: 'BLOCKED_PROOF_OF_LOSS', reasons: Object.freeze([result.intent.proofOfLossCid === null ? 'PROOF_OF_LOSS_MISSING' : 'PROOF_OF_LOSS_UNRESOLVED']) });
	return Object.freeze({ status: 'READY_MODEL_ONLY', reasons: Object.freeze([]) });
}

/* ----------------------------------------------------------- Allokation -- */

/**
 * Prueft Pool-Allokationen eines Quotes nach Cover v3.3.0: Summe >= angefragt (der Vertrag
 * verlangt nur das), Summe == Quote-Gesamt, Ueberdeckung hoechstens overshootBps. Gleichheit mit
 * dem angefragten Betrag wird NICHT verlangt (Aufrundung auf NXM-Einheiten, Pool-Einheiten).
 */
export function validatePoolAllocations({ requestedAmountRaw, quoteTotalCoverAmountRaw, allocations, overshootBps = ALLOCATION_MAX_OVERSHOOT_BPS }) {
	const errors = [];
	const requested = parseRawUint(requestedAmountRaw, { max: UINT96_MAX, positive: true });
	const quoteTotal = parseRawUint(quoteTotalCoverAmountRaw, { positive: true });
	if (requested === null) errors.push('REQUESTED_AMOUNT');
	if (quoteTotal === null) errors.push('QUOTE_TOTAL');
	if (!Number.isInteger(overshootBps) || overshootBps < 0 || overshootBps > ALLOCATION_MAX_OVERSHOOT_BPS) errors.push('OVERSHOOT_BPS');
	if (!Array.isArray(allocations) || allocations.length < 1) errors.push('NO_ALLOCATIONS');
	else if (allocations.length > ALLOCATION_MAX_COUNT) errors.push('TOO_MANY_ALLOCATIONS');
	if (errors.length) return { ok: false, errors };

	const seen = new Set();
	let sum = 0n;
	for (const [i, allocation] of allocations.entries()) {
		if (!allocation || typeof allocation !== 'object' || Object.keys(allocation).sort().join() !== 'coverAmountInAsset,poolId') { errors.push(`ALLOCATION_SHAPE:${i}`); continue; }
		const poolId = parseRawUint(allocation.poolId, { max: UINT40_MAX, positive: true });
		const amount = parseRawUint(allocation.coverAmountInAsset, { positive: true });
		if (poolId === null) errors.push(`POOL_ID:${i}`);
		else if (seen.has(poolId)) errors.push(`DUPLICATE_POOL:${i}`);
		else seen.add(poolId);
		if (amount === null) errors.push(`ALLOCATION_AMOUNT:${i}`);
		else sum += amount;
	}
	if (errors.length) return { ok: false, errors };
	if (sum < requested) errors.push('ALLOCATED_BELOW_REQUESTED');
	if (sum !== quoteTotal) errors.push('ALLOCATED_NOT_QUOTE_TOTAL');
	if (sum * 10000n > requested * BigInt(10000 + overshootBps)) errors.push('OVERSHOOT_TOO_LARGE');
	if (errors.length) return { ok: false, errors };
	return { ok: true, totalRaw: sum, overshootRaw: sum - requested };
}
