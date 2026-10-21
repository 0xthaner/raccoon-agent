/*
	UNISWAP V3 ETHEREUM IM DASHBOARD - NUR LESEN, NUR INFORMATIVE QUOTE (21.10.2026).

	  Sitzungs-Wallet -> Scan (uniswap-v3-ethereum.mjs, ein Block, Chainlink)
	  -> bereinigte Ansicht je NFT fuer GET /api/positions
	  -> Produkt 72, Kapazitaet, Umrechnung, informative Quote (uniswap-v3-nexus.mjs)
	     fuer POST /api/nexus/quote

	Alles laeuft auf dem Server, ueber denselben lesenden Alchemy-Client wie
	die Aave-Positionen (positions/index.mjs, retryCount 0). Die RPC-Adresse, die Preis-Feeds, die
	Rohdaten der Kette (Gebuehren-Wachstum, sqrtPrice, Ticks) und das
	Preisbuch verlassen dieses Modul nie; der Browser bekommt nur die
	Ansicht aus uniswapSection() bzw. die Antworten unten.

	Zwischenspeicher, je Instanz im Arbeitsspeicher:
	  Scan     30 s (Fehler 15 s), Schluessel nur die normalisierte Wallet
	  Preise   gehoeren zum Scan (selber Block), kein eigener Speicher
	  Kapazitaet hoechstens 60 s (nexus-read-api, maxAgeMs)
	  Quote    hoechstens bis quoteExpiresAt (60 s), Schluessel Wallet, Kette,
	           NFT, Asset, Laufzeit, Betrag und Block
	Eine andere Wallet bekommt nie den Eintrag einer Wallet.

	Kein Kauf, keine Freigabe, keine Signatur, keine Transaktion. purchaseReady
	ist immer false; die drei externen Blocker bleiben offen.
*/
import { isAddress } from 'viem';
import { COVER_PERIOD_DAYS, NEXUS_ASSETS } from '../nexus-pinned.mjs';
import { ipfsUrl } from '../nexus-facts.mjs';
import { PERIOD_PRESETS, QUOTE_TTL_MS } from '../nexus-quote.mjs';
import { defaultClient, LookupNotAdmittedError, PositionsBusyError } from './index.mjs';
import { CHAIN_ID, EXTERNAL_BLOCKERS, NEXUS_UNISWAP_V3, readUniswapV3Positions, uniswapNexusMapping } from './uniswap-v3-ethereum.mjs';
import { PRODUCT_ID, checkUniswapQuoteRequest, getUniswapNexusModel, parseUniswapQuoteRequest, requestUniswapQuote, uniswapCoverBounds, uniswapV3QuoteReadiness } from './uniswap-v3-nexus.mjs';

export const SCAN_TTL_MS = 30_000;
export const SCAN_FAILURE_TTL_MS = 15_000;
export const MAX_CONCURRENT_SCANS = 4;
const MAX_SCAN_ENTRIES = 200;
const MAX_QUOTE_ENTRIES = 500;

const scans = new Map();
const scansInFlight = new Map();
let activeScans = 0;
const quotes = new Map();

const fail = (code, extra = {}) => Object.freeze({ ok: false, code, ...extra });

async function scanOnce(wallet, { client, now }) {
	const reader = client ?? defaultClient();
	if (!reader) return Object.freeze({ status: 'UNAVAILABLE', reason: 'RPC_NOT_CONFIGURED', wallet, chainId: CHAIN_ID, detectedAt: new Date(now()).toISOString() });
	return readUniswapV3Positions(wallet, { client: reader, now });
}

/**
 * Scan genau einer Wallet; `wallet` kommt ausschliesslich aus der verifizierten
 * Sitzung. `admit` wird nur vor einem echten Kette-Abruf gefragt (wie bei Aave).
 */
export async function getUniswapScan(wallet, { client = null, now = () => Date.now(), admit = async () => true } = {}) {
	if (typeof wallet !== 'string' || !isAddress(wallet)) throw new TypeError('invalid wallet');
	const key = wallet.toLowerCase();
	const hit = scans.get(key);
	if (hit && now() < hit.expires) return hit.value;
	if (scansInFlight.has(key)) return scansInFlight.get(key).catch((error) => { throw error instanceof LookupNotAdmittedError ? new PositionsBusyError('busy') : error; });
	if (activeScans >= MAX_CONCURRENT_SCANS) throw new PositionsBusyError('busy');
	activeScans++;
	const pending = Promise.resolve()
		.then(() => admit())
		.then((admitted) => {
			if (!admitted) throw new LookupNotAdmittedError('not admitted');
			return scanOnce(key, { client, now });
		})
		.then((value) => {
			scans.delete(key);
			scans.set(key, { value, expires: now() + (value.status === 'OK' ? SCAN_TTL_MS : SCAN_FAILURE_TTL_MS) });
			while (scans.size > MAX_SCAN_ENTRIES) scans.delete(scans.keys().next().value);
			return value;
		})
		.finally(() => { scansInFlight.delete(key); activeScans--; });
	scansInFlight.set(key, pending);
	return pending;
}

/* ------------------------------------------------- Ansicht fuer /api/positions -- */

const AMBIGUOUS_REASONS = new Set(['NON_CANONICAL_POOL', 'POOL_MISMATCH', 'POOL_NOT_REGISTERED', 'WRONG_FACTORY', 'DEPLOYMENT_CONFLICT']);
const feeTierPercent = (fee) => (fee / 10_000).toFixed(2);

function pricingStatus(exposure) {
	if (exposure.pricingStatus === 'PRICED' || exposure.pricingStatus === 'NOT_REQUIRED') return exposure.pricingStatus;
	const statuses = (exposure.missingPrices ?? []).map((entry) => entry.status);
	if (statuses.includes('NO_PRICE_REFERENCE')) return 'UNSUPPORTED_TOKEN_PRICE';
	if (statuses.includes('PRICE_STALE')) return 'STALE_PRICE';
	return 'PRICE_UNAVAILABLE';
}

/** Warum es fuer dieses NFT keine Cover-Optionen gibt - oder AVAILABLE. Ohne Nexus-Abruf. */
function coverOptions(position, exposure) {
	const mapping = uniswapNexusMapping(position);
	if (mapping.mappingClass !== 'MATCHED') return mapping.mappingClass === 'AMBIGUOUS' ? 'MAPPING_AMBIGUOUS' : 'NOT_SUPPORTED';
	if (position.liquidityState !== 'ACTIVE') return 'ZERO_LIQUIDITY';
	const pricing = pricingStatus(exposure);
	if (pricing !== 'PRICED') return pricing;
	return 'AVAILABLE';
}

function positionView(position, exposure) {
	const mapping = uniswapNexusMapping(position);
	const token = (meta, amount) => Object.freeze({ address: meta.address, symbol: meta.symbol, decimals: meta.decimals, amount });
	return Object.freeze({
		protocol: 'Uniswap v3',
		chainId: CHAIN_ID,
		tokenId: position.tokenId,
		pool: position.pool,
		feeTier: position.fee,
		feeTierPercent: feeTierPercent(position.fee),
		rangeState: position.rangeState,
		token0: token(position.token0, exposure.amount0),
		token1: token(position.token1, exposure.amount1),
		liquidityState: position.liquidityState,
		principalExposureUsd: exposure.principalExposureUsd,
		suggestedExposureUsd: exposure.suggestedExposureUsd,
		fees: Object.freeze({ token0Amount: exposure.fees0, token1Amount: exposure.fees1, includedInSuggestedExposure: false }),
		pricingStatus: pricingStatus(exposure),
		nexus: mapping.mappingClass === 'MATCHED'
			? Object.freeze({ productId: PRODUCT_ID, productName: NEXUS_UNISWAP_V3.name, productTypeName: NEXUS_UNISWAP_V3.productTypeName, mapping: 'MATCHED' })
			: Object.freeze({ productId: null, productName: null, mapping: mapping.mappingClass }),
		coverOptions: coverOptions(position, exposure),
		purchaseAvailable: false
	});
}

/**
 * Der Uniswap-Abschnitt der Positionsantwort. Nur gepruefte Felder; keine
 * Gebuehren-Wachstumswerte, keine Ticks, keine Preis-Feeds, keine Rohdaten.
 */
export function uniswapSection(scan) {
	const base = { protocol: 'Uniswap v3', chainId: CHAIN_ID };
	if (scan?.status !== 'OK') return Object.freeze({ ...base, status: 'UNAVAILABLE', reason: 'SCAN_INCOMPLETE', positions: Object.freeze([]), unsupported: Object.freeze([]) });
	const exposures = new Map((scan.exposures ?? []).map((entry) => [entry.tokenId, entry]));
	const positions = [];
	const unsupported = [];
	for (const position of scan.positions ?? []) {
		// Gehoert das NFT (inzwischen) einer anderen Wallet, ist es hier keine Position - auch keine "nicht unterstuetzte".
		if (position.status === 'INVALID' && position.reason === 'OWNER_MISMATCH') continue;
		if (position.status === 'VALID' && exposures.has(position.tokenId)) positions.push(positionView(position, exposures.get(position.tokenId)));
		else if (position.status === 'UNAVAILABLE') unsupported.push(Object.freeze({ tokenId: position.tokenId, reason: 'UNREADABLE' }));
		else unsupported.push(Object.freeze({ tokenId: position.tokenId, reason: AMBIGUOUS_REASONS.has(position.reason) ? 'MAPPING_AMBIGUOUS' : 'NOT_SUPPORTED' }));
	}
	const complete = scan.aggregate?.status === 'COMPLETE' && unsupported.every((entry) => entry.reason !== 'UNREADABLE');
	return Object.freeze({
		...base,
		status: complete ? 'OK' : 'INCOMPLETE',
		...(complete ? {} : { reason: unsupported.some((entry) => entry.reason === 'UNREADABLE') ? 'SCAN_INCOMPLETE' : 'PRICING_INCOMPLETE' }),
		blockNumber: scan.blockNumber,
		detectedAt: scan.detectedAt,
		positions: Object.freeze(positions),
		unsupported: Object.freeze(unsupported),
		suggestedExposureUsd: scan.aggregate?.suggestedExposureUsd ?? null
	});
}

/* ------------------------------------------- Anfrage fuer /api/nexus/quote -- */

const BODY_KEYS = { 'uniswap-details': ['action', 'tokenId'], 'uniswap-quote': ['action', 'tokenId', 'coverAsset', 'periodDays'] };
const TOKEN_ID = /^[1-9][0-9]{0,77}$/;

/**
 * Strenger Body der Uniswap-Aktionen:
 *   { action: 'uniswap-details', tokenId }
 *   { action: 'uniswap-quote', tokenId, coverAsset, periodDays [, amount] }
 * Wallet, Produkt, Pool, Exposure, Praemie und Kapazitaet bestimmt der Server.
 */
export function parseUniswapBody(body) {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail('INVALID_BODY');
	const keys = Object.keys(body);
	if (keys.some((key) => /product/i.test(key))) return fail('PRODUCT_ID_NOT_ACCEPTED');
	const allowed = BODY_KEYS[body.action];
	if (!allowed) return fail('INVALID_BODY');
	const optional = body.action === 'uniswap-quote' ? ['amount'] : [];
	if (keys.some((key) => !allowed.includes(key) && !optional.includes(key)) || allowed.some((key) => !keys.includes(key))) return fail('INVALID_BODY');
	if (typeof body.tokenId !== 'string' || !TOKEN_ID.test(body.tokenId)) return fail('INVALID_BODY');
	if (body.action === 'uniswap-details') return Object.freeze({ ok: true, action: body.action, tokenId: body.tokenId });
	if (typeof body.coverAsset !== 'string' || !Object.values(NEXUS_ASSETS).some((asset) => asset.symbol === body.coverAsset)) return fail('ASSET_NOT_SUPPORTED');
	if (!Number.isSafeInteger(body.periodDays) || body.periodDays < COVER_PERIOD_DAYS.min || body.periodDays > COVER_PERIOD_DAYS.max) return fail('PERIOD_OUT_OF_RANGE');
	if ('amount' in body && (typeof body.amount !== 'string' || body.amount.length > 48)) return fail('INVALID_AMOUNT');
	return Object.freeze({ ok: true, action: body.action, tokenId: body.tokenId, coverAsset: body.coverAsset, periodDays: body.periodDays, ...('amount' in body ? { amount: body.amount } : {}) });
}

/** Genau das NFT dieser Wallet aus diesem Scan - oder null. Nie aus dem Body. */
export function findScannedPosition(scan, wallet, tokenId) {
	if (scan?.status !== 'OK' || typeof wallet !== 'string' || scan.wallet !== wallet.toLowerCase()) return null;
	const position = (scan.positions ?? []).find((entry) => entry.tokenId === tokenId);
	if (!position || (position.status === 'INVALID' && position.reason === 'OWNER_MISMATCH')) return null;
	const exposure = (scan.exposures ?? []).find((entry) => entry.tokenId === tokenId) ?? null;
	return { position, exposure };
}

/* Gate- und Modellgruende -> ein fester, anzeigbarer Code. */
function unavailableCode(model, position, exposure) {
	const reasons = model?.eligibility?.reasons ?? [];
	const first = String(reasons[0] ?? '');
	if (model?.eligibility?.status === 'AMBIGUOUS' || position?.status === 'INVALID') return 'MAPPING_AMBIGUOUS';
	if (model?.eligibility?.status === 'UNSUPPORTED') return 'NOT_SUPPORTED';
	if (first === 'POSITION_NOT_VALID') return 'SCAN_INCOMPLETE';
	if (first === 'ZERO_LIQUIDITY') return 'ZERO_LIQUIDITY';
	if (first === 'PRICING_INCOMPLETE') return exposure ? pricingStatus(exposure) : 'PRICE_UNAVAILABLE';
	if (/^POSITION_(STALE|CLOCK_SKEW|BLOCK_MISSING)$/.test(first) || first === 'EXPOSURE_MISMATCH') return 'POSITION_STALE';
	if (/^CAPACITY_|NO_CAPACITY/.test(first)) return 'CAPACITY_UNAVAILABLE';
	return 'COVER_NOT_AVAILABLE';
}

const publicReadiness = (readiness) => Object.freeze({
	quoteDataReady: readiness.quoteDataReady,
	purchaseReady: false,
	blockers: Object.freeze([...EXTERNAL_BLOCKERS])
});

/** Lesemodell fuer ein NFT der Sitzungs-Wallet; frische Kapazitaet (<= 60 s). */
export async function uniswapModelFor(found, { now, fetchImpl, timeoutMs } = {}) {
	const { position, exposure } = found;
	const model = await getUniswapNexusModel(position, exposure, { now, ...(fetchImpl ? { fetchImpl } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
	if (model.eligibility.status !== 'AVAILABLE') return fail(unavailableCode(model, position, exposure));
	return Object.freeze({ ok: true, model });
}

function assetView(bound) {
	return Object.freeze({
		symbol: bound.symbol,
		decimals: bound.decimals,
		selectable: bound.selectable,
		...(bound.reason ? { reason: bound.reason === 'COVER_ASSET_PRICE_UNAVAILABLE' || bound.reason === 'COVER_ASSET_PRICE_INVALID' || bound.reason === 'COVER_ASSET_PRICE_NOT_SAME_BLOCK' ? 'PRICE_UNAVAILABLE' : bound.reason } : {}),
		capacity: bound.capacity,
		...(bound.maxAmount === undefined ? {} : {
			maxFromExposure: bound.maxFromExposure,
			maxAmount: bound.maxAmount,
			limitedBy: bound.limitedBy,
			conversion: Object.freeze({ source: 'Chainlink', description: bound.conversion.description, priceUsd: bound.conversion.priceUsd, updatedAt: bound.conversion.updatedAt })
		})
	});
}

/** Cover-Optionen eines NFT: Produkt 72, Exposure, Grenzen je Asset, Bedingungen. Keine Quote. */
export function uniswapDetails(found, model, priceBook, now) {
	const { position, exposure } = found;
	const bounds = uniswapCoverBounds(model, priceBook);
	return Object.freeze({
		ok: true,
		available: true,
		status: 'AVAILABLE',
		provider: 'Nexus Mutual',
		productId: PRODUCT_ID,
		productName: model.product.name,
		productTypeName: model.product.productTypeName,
		position: Object.freeze({ protocol: 'Uniswap v3', network: 'Ethereum', chainId: CHAIN_ID, tokenId: position.tokenId, pair: `${position.token0.symbol}/${position.token1.symbol}`, feeTierPercent: feeTierPercent(position.fee) }),
		exposure: Object.freeze({ calculationMethod: exposure.model, currency: 'USD', suggestedExposure: exposure.suggestedExposureUsd, feesIncluded: false }),
		assets: Object.freeze(bounds.map(assetView)),
		periodDays: Object.freeze({ min: COVER_PERIOD_DAYS.min, max: COVER_PERIOD_DAYS.max, presets: PERIOD_PRESETS }),
		proofOfLoss: Object.freeze({ inputTypes: model.product.proofOfLossInputTypes }),
		gracePeriodDays: model.product.gracePeriodDays,
		wording: Object.freeze({ cid: model.product.wordingCid, url: ipfsUrl(model.product.wordingCid) }),
		capacityFetchedAt: model.capacity.fetchedAt,
		quoteTtlSeconds: QUOTE_TTL_MS / 1_000,
		readiness: publicReadiness(uniswapV3QuoteReadiness({ position, exposure, model, priceBook, now }))
	});
}

/**
 * Lokale Pruefung einer Quote-Anfrage. Ohne `amount` nimmt der Server die
 * Obergrenze min(Exposure umgerechnet, Kapazitaet); mit `amount` gilt dieselbe
 * Grenze. Kein Nexus-Abruf.
 */
export function prepareUniswapQuote(parsed, model, priceBook, { now } = {}) {
	const bound = uniswapCoverBounds(model, priceBook).find((entry) => entry.symbol === parsed.coverAsset);
	if (!bound) return fail('ASSET_NOT_SUPPORTED');
	if (!bound.selectable) return fail(bound.reason === 'NO_CAPACITY' ? 'CAPACITY_UNAVAILABLE' : bound.reason === 'NO_EXPOSURE' ? 'AMOUNT_OUT_OF_RANGE' : 'PRICE_UNAVAILABLE');
	const request = parseUniswapQuoteRequest({ mode: 'POSITION', tokenId: parsed.tokenId, coverAsset: parsed.coverAsset, amount: parsed.amount ?? bound.maxAmount, periodDays: parsed.periodDays });
	if (!request.ok) return request;
	const checked = checkUniswapQuoteRequest(request, model, priceBook, { now });
	if (!checked.ok) return checked.code === 'CAPACITY_STALE' ? fail('CAPACITY_UNAVAILABLE') : checked;
	return Object.freeze({ ok: true, request, checked });
}

export function quoteCacheKey(wallet, prepared, blockNumber) {
	const { request, checked } = prepared;
	return [wallet.toLowerCase(), CHAIN_ID, request.tokenId, checked.coverAsset.assetId, request.periodDays, checked.amount.toString(), blockNumber].join('|');
}

export function cachedQuote(key, now) {
	const hit = quotes.get(key);
	if (!hit) return null;
	if (!(now < Date.parse(hit.quoteExpiresAt))) { quotes.delete(key); return null; }
	return hit;
}

function publicQuote(view, readiness) {
	return Object.freeze({
		provider: view.provider,
		productName: view.productName,
		productTypeName: view.productTypeName,
		tokenId: view.tokenId,
		suggestedExposureUsd: view.suggestedExposureUsd,
		coverAsset: view.coverAsset,
		coverAmount: view.requestedCoverAmount,
		periodDays: view.periodDays,
		premium: view.premium,
		premiumAsset: view.premiumAsset,
		annualPricePercent: view.annualPricePercent,
		capacity: view.capacity,
		quoteFetchedAt: view.quoteFetchedAt,
		quoteExpiresAt: view.quoteExpiresAt,
		freshness: view.status,
		informationalOnly: true,
		purchaseAvailable: false,
		readiness
	});
}

/** Genau ein GET /v2/quote; das Ergebnis haelt hoechstens bis quoteExpiresAt. */
export async function runUniswapQuote(prepared, model, priceBook, found, { key, now, fetchImpl, timeoutMs } = {}) {
	const result = await requestUniswapQuote(prepared.request, model, priceBook, { now, ...(fetchImpl ? { fetchImpl } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
	if (!result.ok) {
		if (result.code === 'QUOTE_AMOUNT_TOO_SMALL') return fail('QUOTE_AMOUNT_TOO_SMALL');
		if (result.code === 'CAPACITY_STALE') return fail('CAPACITY_UNAVAILABLE');
		if (result.code === 'QUOTE_UNAVAILABLE' || result.code === 'QUOTE_REJECTED') return fail('QUOTE_UNAVAILABLE');
		return result;
	}
	const readiness = publicReadiness(uniswapV3QuoteReadiness({ position: found.position, exposure: found.exposure, model, priceBook, quote: result.quote, now }));
	const quote = publicQuote(result.quote, readiness);
	if (key) {
		quotes.delete(key);
		quotes.set(key, quote);
		while (quotes.size > MAX_QUOTE_ENTRIES) quotes.delete(quotes.keys().next().value);
	}
	return Object.freeze({ ok: true, quote });
}

export const _test = {
	reset: () => { scans.clear(); scansInFlight.clear(); activeScans = 0; quotes.clear(); },
	scanCacheSize: () => scans.size,
	quoteCacheSize: () => quotes.size
};
