/*
	NEXUS MUTUAL: LESENDER API-ZUGRIFF MIT STRENGER FORMPRUEFUNG (P1, 18.10.2026).

	Genau vier oeffentliche GET-Endpunkte, nur unter der gepinnten Basis-URL:
	  /v2/products/:id  /v2/product-types/:id  /v2/capacity/:id
	  /v2/quote?productId&amount&period&coverAsset&paymentAsset (P3, nie gecacht)
	Kein POST, keine Weiterleitung (redirect: 'error'), Zeitlimit und
	Groessendeckel. Jede Antwort wird gegen die erwartete Form geprueft; was
	nicht passt, wird ein NexusReadError und nie ein Teilergebnis. Ein Fehler
	wird nicht zwischengespeichert, damit ein Ausfall nicht laenger haelt als er
	dauert - und nie als "verfuegbar" weiterlebt.
*/
import { ipfsUrl } from './nexus-facts.mjs';
import { NEXUS_API_BASE, PROOF_OF_LOSS_TYPES } from './nexus-pinned.mjs';

export class NexusReadError extends Error {
	constructor(code) {
		super(`Nexus read failed: ${code}`);
		this.name = 'NexusReadError';
		this.code = code;
	}
}

export const READ_LIMITS = Object.freeze({ timeoutMs: 8_000, maxBytes: 256 * 1024 });
const READ_PATH = /^\/v2\/(products|product-types|capacity)\/(0|[1-9][0-9]{0,5})$/;
const QUOTE_PATH = /^\/v2\/quote\?productId=(0|[1-9][0-9]{0,5})&amount=[1-9][0-9]{0,77}&period=[1-9][0-9]{0,2}&coverAsset=[0-9]{1,3}&paymentAsset=[0-9]{1,3}$/;
const TTL_MS = Object.freeze({ products: 60 * 60_000, 'product-types': 60 * 60_000, capacity: 10 * 60_000 });
const DIGITS = /^(0|[1-9][0-9]{0,77})$/;
const RATIO = /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,30})?$/;
const MAX_GRACE_SECONDS = 10 * 365 * 86_400;

const cache = new Map();

const bad = (code) => { throw new NexusReadError(code); };
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const isAssetId = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 255;
const timeoutCode = (error) => (error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE');

/** Ein GET gegen die gepinnte API; liefert geparstes JSON oder wirft NexusReadError. */
export async function nexusGet(path, { fetchImpl = fetch, timeoutMs = READ_LIMITS.timeoutMs, maxBytes = READ_LIMITS.maxBytes } = {}) {
	if (typeof path !== 'string' || !(READ_PATH.test(path) || QUOTE_PATH.test(path))) bad('PATH_NOT_ALLOWED');
	const url = `${NEXUS_API_BASE}${path}`;
	let response;
	try {
		response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		bad(timeoutCode(error));
	}
	if (response?.redirected === true || (typeof response?.url === 'string' && response.url !== '' && response.url !== url)) bad('REDIRECTED');
	if (!response?.ok) bad(response?.status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR');
	if (!/^application\/json(\s*;|$)/i.test(String(response.headers?.get?.('content-type') ?? ''))) bad('NOT_JSON');
	const declared = Number(response.headers?.get?.('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) bad('TOO_LARGE');
	let text;
	try {
		text = await response.text();
	} catch (error) {
		bad(timeoutCode(error));
	}
	if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes) bad('TOO_LARGE');
	try {
		return JSON.parse(text);
	} catch {
		return bad('MALFORMED_JSON');
	}
}

/* ------------------------------------------------------------- Formpruefung -- */

export function parseProduct(raw, productId) {
	if (!isPlain(raw)) bad('MALFORMED_PRODUCT');
	if (raw.id !== productId) bad('PRODUCT_ID_MISMATCH');
	if (!isText(raw.name) || !Number.isSafeInteger(raw.productType) || raw.productType < 0) bad('MALFORMED_PRODUCT');
	if (typeof raw.isDeprecated !== 'boolean' || typeof raw.isPrivate !== 'boolean') bad('MALFORMED_PRODUCT');
	if (!Array.isArray(raw.coverAssets) || raw.coverAssets.length > 32) bad('MALFORMED_PRODUCT');
	const coverAssets = raw.coverAssets.map((asset) => {
		if (!isPlain(asset) || !isAssetId(asset.assetId) || !isText(asset.assetSymbol, 16)) bad('MALFORMED_PRODUCT');
		return { assetId: asset.assetId, symbol: asset.assetSymbol };
	});
	if (new Set(coverAssets.map((asset) => asset.assetId)).size !== coverAssets.length) bad('MALFORMED_PRODUCT');
	const proofOfLoss = raw.proofOfLossInputTypes;
	if (!Array.isArray(proofOfLoss) || proofOfLoss.some((type) => !PROOF_OF_LOSS_TYPES.includes(type)) || new Set(proofOfLoss).size !== proofOfLoss.length) bad('MALFORMED_PRODUCT');
	if (raw.category != null && !isText(raw.category, 64)) bad('MALFORMED_PRODUCT');
	const metadata = raw.metadata ?? null;
	if (metadata !== null && typeof metadata !== 'string' && !isPlain(metadata)) bad('MALFORMED_PRODUCT');
	if (metadata !== null && JSON.stringify(metadata).length > 2_000) bad('MALFORMED_PRODUCT');
	return {
		productId: raw.id,
		name: raw.name,
		productTypeId: raw.productType,
		category: raw.category ?? null,
		deprecated: raw.isDeprecated,
		private: raw.isPrivate,
		coverAssets,
		proofOfLossInputTypes: [...proofOfLoss],
		metadata
	};
}

export function parseProductType(raw, productTypeId) {
	if (!isPlain(raw)) bad('MALFORMED_PRODUCT_TYPE');
	if (raw.id !== productTypeId) bad('PRODUCT_TYPE_ID_MISMATCH');
	if (!isText(raw.name)) bad('MALFORMED_PRODUCT_TYPE');
	const grace = typeof raw.gracePeriod === 'string' && DIGITS.test(raw.gracePeriod) ? Number(raw.gracePeriod) : raw.gracePeriod;
	if (!Number.isSafeInteger(grace) || grace < 0 || grace > MAX_GRACE_SECONDS) bad('MALFORMED_PRODUCT_TYPE');
	if (!ipfsUrl(raw.metadata)) bad('MALFORMED_PRODUCT_TYPE');
	return { productTypeId: raw.id, name: raw.name, gracePeriodSeconds: grace, wordingCid: raw.metadata };
}

function parseAssetAmounts(list, code) {
	if (!Array.isArray(list) || list.length > 32) bad(code);
	const out = new Map();
	for (const entry of list) {
		if (!isPlain(entry) || !isAssetId(entry.assetId) || typeof entry.amount !== 'string' || !DIGITS.test(entry.amount)
			|| !isPlain(entry.asset) || entry.asset.id !== entry.assetId || !isText(entry.asset.symbol, 16)
			|| !Number.isSafeInteger(entry.asset.decimals) || entry.asset.decimals < 0 || entry.asset.decimals > 36) bad(code);
		if (out.has(entry.assetId)) bad(code);
		out.set(entry.assetId, { assetId: entry.assetId, symbol: entry.asset.symbol, decimals: entry.asset.decimals, amount: BigInt(entry.amount) });
	}
	return out;
}

function parseRatio(value) {
	if (typeof value !== 'string' || !RATIO.test(value)) bad('MALFORMED_CAPACITY');
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0 || number > 1) bad('MALFORMED_CAPACITY');
	return number;
}

/*
	Die Gesamtkapazitaet je Asset muss der Summe der Pools entsprechen (Nexus
	rundet je Pool, daher hoechstens eine Einheit Abweichung je Pool). Eine
	ueberhoehte Gesamtzahl allein faellt damit auf.
*/
export function parseCapacity(raw, productId) {
	if (!isPlain(raw)) bad('MALFORMED_CAPACITY');
	if (raw.productId !== productId) bad('CAPACITY_PRODUCT_MISMATCH');
	const total = parseAssetAmounts(raw.availableCapacity, 'MALFORMED_CAPACITY');
	if (!Array.isArray(raw.capacityPerPool) || raw.capacityPerPool.length === 0 || raw.capacityPerPool.length > 256) bad('MALFORMED_CAPACITY');
	const poolIds = new Set();
	const pools = raw.capacityPerPool.map((pool) => {
		if (!isPlain(pool) || !Number.isSafeInteger(pool.poolId) || pool.poolId < 0 || poolIds.has(pool.poolId)) bad('MALFORMED_CAPACITY');
		poolIds.add(pool.poolId);
		return parseAssetAmounts(pool.availableCapacity, 'MALFORMED_CAPACITY');
	});
	for (const [assetId, entry] of total) {
		let sum = 0n;
		for (const pool of pools) {
			const part = pool.get(assetId);
			if (!part) continue;
			if (part.symbol !== entry.symbol || part.decimals !== entry.decimals) bad('CAPACITY_INCONSISTENT');
			sum += part.amount;
		}
		const difference = entry.amount > sum ? entry.amount - sum : sum - entry.amount;
		if (difference > BigInt(pools.length)) bad('CAPACITY_INCONSISTENT');
	}
	const minAnnualPrice = parseRatio(raw.minAnnualPrice);
	const maxAnnualPrice = parseRatio(raw.maxAnnualPrice);
	if (maxAnnualPrice < minAnnualPrice) bad('MALFORMED_CAPACITY');
	return {
		productId,
		assets: [...total.values()].map((entry) => ({ ...entry, amount: entry.amount.toString() })),
		pools: raw.capacityPerPool.map((pool, i) => ({ poolId: pool.poolId, assets: [...pools[i].values()].map((entry) => ({ assetId: entry.assetId, amount: entry.amount.toString() })) })),
		minAnnualPrice: raw.minAnnualPrice,
		maxAnnualPrice: raw.maxAnnualPrice
	};
}

/*
	Quote (P3). Die Antwort traegt weder Produkt-ID noch Ablauf oder Signatur.
	Gebunden wird sie deshalb an die eigene Anfrage und an die zuvor gelesene
	Kapazitaet desselben Produkts:
	  - Asset (id, Symbol, Dezimalstellen) = angefragtes Cover-Asset
	  - Gesamtbetrag >= angefragter Betrag, hoechstens 1 % darueber (Pool-Rundung)
	  - Pool-Zuteilungen summieren exakt zum Gesamtbetrag, jeder Pool gehoert zum
	    Produkt (capacityPerPool) und traegt hoechstens seine Kapazitaet im Asset
	  - Jahrespreis in Basispunkten (1..10000); Praemie = Gesamtbetrag x Preis x
	    Tage / 365, wie Nexus selbst rechnet (Rundungstoleranz 0,1 % + 1 Einheit)
	  - keine Erstattung (es wird nie ein bestehendes Cover geaendert)
	Was nicht passt, ist ein Fehler - nie eine Praemie.
*/
const QUOTE_DIGITS = ['totalCoverAmountInAsset', 'annualPrice', 'premiumInNXM', 'premiumInAsset', 'refundInNXM', 'refundInAsset', 'premiumInNXMWithRefund', 'premiumInAssetWithRefund'];

/** NXM je Allokations-Einheit im Nexus-Cover-Vertrag (Cover.NXM_PER_ALLOCATION_UNIT, 1e16 = 0,01 NXM). */
export const NXM_PER_ALLOCATION_UNIT = 10n ** 16n;

/**
 * Erklaert die Aufrundung den Mehrbetrag? Wert einer Einheit im Asset aus dem Verhaeltnis
 * premiumInAsset / premiumInNXM derselben Quote; hoechstens eine Einheit je Pool (2 % Spielraum
 * fuer die Rundung des Verhaeltnisses). Nur fuer die Einordnung des Fehlers, nie fuer eine Annahme.
 */
function isAllocationRoundUp(q, amount, total) {
	const premiumInNXM = BigInt(q.premiumInNXM);
	const premiumInAsset = BigInt(q.premiumInAsset);
	const pools = Array.isArray(q.poolAllocationRequests) ? BigInt(Math.max(1, q.poolAllocationRequests.length)) : 1n;
	if (premiumInNXM <= 0n || premiumInAsset <= 0n) return false;
	const unitInAsset = (NXM_PER_ALLOCATION_UNIT * premiumInAsset) / premiumInNXM;
	return total - amount <= (pools * unitInAsset * 102n) / 100n + 1n;
}

export function parseQuote(raw, { coverAsset, amount, periodDays, capacity }) {
	if (!isPlain(raw) || !isPlain(raw.quote)) bad('MALFORMED_QUOTE');
	const q = raw.quote;
	for (const key of QUOTE_DIGITS) if (typeof q[key] !== 'string' || !DIGITS.test(q[key])) bad('MALFORMED_QUOTE');
	if (!isPlain(q.asset) || !Number.isSafeInteger(q.asset.id) || !isText(q.asset.symbol, 16) || !Number.isSafeInteger(q.asset.decimals)) bad('MALFORMED_QUOTE');
	if (q.asset.id !== coverAsset.assetId || q.asset.symbol !== coverAsset.symbol || q.asset.decimals !== coverAsset.decimals) bad('QUOTE_ASSET_MISMATCH');
	if (q.refundInNXM !== '0' || q.refundInAsset !== '0' || q.premiumInAssetWithRefund !== q.premiumInAsset || q.premiumInNXMWithRefund !== q.premiumInNXM) bad('MALFORMED_QUOTE');
	const total = BigInt(q.totalCoverAmountInAsset);
	if (total < amount) bad('QUOTE_AMOUNT_MISMATCH');
	// Nexus rundet die Cover-Summe je Pool auf ganze Allokations-Einheiten (Cover.NXM_PER_ALLOCATION_UNIT
	// = 0,01 NXM, on-chain gelesen am 20.10.2026). Bei kleinen Betraegen liegt das ueber 1 %. Eine solche
	// Quote bleibt abgelehnt; sie bekommt nur einen eigenen Grund, wenn die Aufrundung genau das erklaert.
	const roundedUp = total > amount + amount / 100n + 1n;
	if (roundedUp && !isAllocationRoundUp(q, amount, total)) bad('QUOTE_AMOUNT_MISMATCH');
	const annualPrice = BigInt(q.annualPrice);
	if (annualPrice < 1n || annualPrice > 10_000n) bad('MALFORMED_QUOTE');
	if (!Array.isArray(q.poolAllocationRequests) || q.poolAllocationRequests.length === 0 || q.poolAllocationRequests.length > 32) bad('MALFORMED_QUOTE');
	const seen = new Set();
	let allocated = 0n;
	for (const request of q.poolAllocationRequests) {
		if (!isPlain(request) || typeof request.poolId !== 'string' || !DIGITS.test(request.poolId) || typeof request.coverAmountInAsset !== 'string' || !DIGITS.test(request.coverAmountInAsset)) bad('MALFORMED_QUOTE');
		if (seen.has(request.poolId)) bad('MALFORMED_QUOTE');
		seen.add(request.poolId);
		const part = BigInt(request.coverAmountInAsset);
		const pool = capacity.pools.find((entry) => String(entry.poolId) === request.poolId);
		const room = pool?.assets.find((entry) => entry.assetId === coverAsset.assetId);
		if (!room || part > BigInt(room.amount)) bad('QUOTE_PRODUCT_MISMATCH');
		allocated += part;
	}
	if (allocated !== total) bad('MALFORMED_QUOTE');
	const premium = BigInt(q.premiumInAsset);
	const expected = (total * annualPrice * BigInt(periodDays)) / (10_000n * 365n);
	const drift = premium > expected ? premium - expected : expected - premium;
	if (premium <= 0n || drift > expected / 1_000n + 1n) bad('QUOTE_PRICE_INCONSISTENT');
	if (roundedUp) bad('QUOTE_AMOUNT_ROUNDED_UP');
	return { coverAsset: coverAsset.symbol, coverAmount: amount.toString(), totalCoverAmount: total.toString(), premiumInAsset: premium.toString(), annualPriceBps: Number(annualPrice) };
}

/* --------------------------------------------------------------- Abrufe -- */

function deepFreeze(value) {
	if (value && typeof value === 'object') {
		for (const inner of Object.values(value)) deepFreeze(inner);
		Object.freeze(value);
	}
	return value;
}

async function cachedRead(kind, id, parse, { now = Date.now(), maxAgeMs = TTL_MS[kind], ...options } = {}) {
	const path = `/v2/${kind}/${id}`;
	const hit = cache.get(path);
	if (hit && now - hit.at < Math.min(maxAgeMs, TTL_MS[kind])) return hit.value;
	const value = deepFreeze({ ...parse(await nexusGet(path, options), id), fetchedAt: new Date(now).toISOString(), source: `${NEXUS_API_BASE}${path}` });
	cache.set(path, { at: now, value });
	return value;
}

export const readProduct = (productId, options) => cachedRead('products', productId, parseProduct, options);
export const readProductType = (productTypeId, options) => cachedRead('product-types', productTypeId, parseProductType, options);
export const readCapacity = (productId, options) => cachedRead('capacity', productId, parseCapacity, options);

/**
 * Eine Quote, nie aus einem Cache. `productId` und `coverAsset` kommen vom
 * Server (gepinnte Zuordnung), nie vom Client; `capacity` ist die zuvor
 * gelesene Kapazitaet desselben Produkts.
 */
export async function readQuote({ productId, coverAsset, amount, periodDays, capacity }, { now = Date.now(), ...options } = {}) {
	if (capacity?.productId !== productId) bad('CAPACITY_PRODUCT_MISMATCH');
	const query = new URLSearchParams({ productId: String(productId), amount: amount.toString(), period: String(periodDays), coverAsset: String(coverAsset.assetId), paymentAsset: String(coverAsset.assetId) });
	const path = `/v2/quote?${query}`;
	const quote = parseQuote(await nexusGet(path, options), { coverAsset, amount, periodDays, capacity });
	return deepFreeze({ ...quote, productId, periodDays, fetchedAt: new Date(now).toISOString(), source: `${NEXUS_API_BASE}/v2/quote` });
}

export const _test = { reset: () => cache.clear(), cacheSize: () => cache.size };
