/*
	NEXUS MUTUAL: LESENDER API-ZUGRIFF MIT STRENGER FORMPRUEFUNG (P1, 18.10.2026).

	Genau drei oeffentliche GET-Endpunkte, nur unter der gepinnten Basis-URL:
	  /v2/products/:id  /v2/product-types/:id  /v2/capacity/:id
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
	if (typeof path !== 'string' || !READ_PATH.test(path)) bad('PATH_NOT_ALLOWED');
	const url = `${NEXUS_API_BASE}${path}`;
	let response;
	try {
		response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		bad(timeoutCode(error));
	}
	if (response?.redirected === true || (typeof response?.url === 'string' && response.url !== '' && response.url !== url)) bad('REDIRECTED');
	if (!response?.ok) bad(response?.status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR');
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
		minAnnualPrice: raw.minAnnualPrice,
		maxAnnualPrice: raw.maxAnnualPrice
	};
}

/* --------------------------------------------------------------- Abrufe -- */

function deepFreeze(value) {
	if (value && typeof value === 'object') {
		for (const inner of Object.values(value)) deepFreeze(inner);
		Object.freeze(value);
	}
	return value;
}

async function cachedRead(kind, id, parse, { now = Date.now(), ...options } = {}) {
	const path = `/v2/${kind}/${id}`;
	const hit = cache.get(path);
	if (hit && now - hit.at < TTL_MS[kind]) return hit.value;
	const value = deepFreeze({ ...parse(await nexusGet(path, options), id), fetchedAt: new Date(now).toISOString(), source: `${NEXUS_API_BASE}${path}` });
	cache.set(path, { at: now, value });
	return value;
}

export const readProduct = (productId, options) => cachedRead('products', productId, parseProduct, options);
export const readProductType = (productTypeId, options) => cachedRead('product-types', productTypeId, parseProductType, options);
export const readCapacity = (productId, options) => cachedRead('capacity', productId, parseCapacity, options);

export const _test = { reset: () => cache.clear(), cacheSize: () => cache.size };
