/*
	UNISWAP V3 ETHEREUM -> NEXUS PRODUKT 72: KAPAZITAET UND INFORMATIVE QUOTE
	(21.10.2026).

	  gepruefte LP-Position (uniswap-v3-ethereum.mjs)
	  -> Principal-Exposure in USD (UNISWAP_V3_LP_EXPOSURE_V1, ohne Gebuehren)
	  -> Produkt 72 (eigener Pin, nicht PINNED_PRODUCTS)
	  -> Kapazitaet (hoechstens 60 s alt)
	  -> Umrechnung USD -> ETH / USDC / cbBTC ueber CHAINLINK_PRICE_REFERENCE_V1
	  -> eine Quote je NFT, nur zur Information

	Wiederverwendet, unveraendert: die strengen Nexus-Leser und -Parser
	(nexus-read-api.mjs: Produkt, Produkttyp, Kapazitaet, Quote mit Bindung an
	Asset, Betrag, Pools und Praemie), capacityView (nexus-read-model.mjs) sowie
	QUOTE_TTL_MS, parseAssetAmount und quoteFreshness (nexus-quote.mjs).

	Erreichbar nur ueber den Server (uniswap-v3-service.mjs hinter
	POST /api/nexus/quote): informative Quote, kein Kauf, keine Wallet-Methode.
	purchaseReady ist immer false. Die Aave-Zuordnung in nexus-pinned.mjs /
	nexus-mapping.mjs bleibt unveraendert (nur Produkt 97).
*/
import { formatUnits, isAddress } from 'viem';
import { productTerms } from '../nexus-facts.mjs';
import { COVER_PERIOD_DAYS, NEXUS_ASSETS } from '../nexus-pinned.mjs';
import { readCapacity, readProduct, readProductType, readQuote } from '../nexus-read-api.mjs';
import { capacityView } from '../nexus-read-model.mjs';
import { QUOTE_TTL_MS, parseAssetAmount, quoteFreshness } from '../nexus-quote.mjs';
import { CHAINLINK_FEEDS } from './price-reference.mjs';
import { COVER_ASSET_REFERENCES, EXTERNAL_BLOCKERS, NEXUS_UNISWAP_V3, PHASE_BLOCKERS, uniswapNexusMapping } from './uniswap-v3-ethereum.mjs';

export const PRODUCT_ID = NEXUS_UNISWAP_V3.productId;
/** Kapazitaet fuer eine Quote hoechstens so alt wie eine Quote gueltig ist (wie beim Aave-Pfad). */
export const CAPACITY_MAX_AGE_MS = QUOTE_TTL_MS;
/** Ein Positions-Scan ist fuer eine Quote hoechstens 5 Minuten alt (Block-Zeitstempel gegen jetzt). */
export const POSITION_MAX_AGE_MS = 300_000;
/** Toleranz, um die eine Quote ueber dem angefragten Betrag liegen darf - dieselbe wie in parseQuote (1 % + 1 Einheit). */
export const QUOTE_OVERAGE = Object.freeze({ percent: 1n, units: 1n });
export const QUOTE_MODES = Object.freeze(['POSITION', 'AGGREGATE']);

const COVER_ASSET_IDS = Object.freeze([0, 6, 7]);
const fail = (code, extra = {}) => Object.freeze({ ok: false, code, ...extra });
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '');
const sameList = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort().every((value, i) => value === [...b].sort()[i]);
const POSITIVE = /^[1-9][0-9]{0,60}$/;

/* --------------------------------------------------------- Produkt 72 -- */

/**
 * Vergleicht Produkt und Produkttyp (geparst von nexus-read-api) mit dem Pin
 * fuer Produkt 72. Strenger als beim Aave-Pfad: die Cover-Assets muessen genau
 * ETH, USDC, cbBTC sein, die Grace Period genau 35 Tage, kein Annex.
 */
export function verifyUniswapProduct(product, productType) {
	const pin = NEXUS_UNISWAP_V3;
	const no = (reason) => Object.freeze({ ok: false, reason });
	if (!product || product.productId !== pin.productId) return no('PRODUCT_ID_MISMATCH');
	if (product.name !== pin.name) return no('PRODUCT_NAME_MISMATCH');
	if (product.productTypeId !== pin.productTypeId) return no('PRODUCT_TYPE_MISMATCH');
	if (!productType || productType.productTypeId !== pin.productTypeId || productType.name !== pin.productTypeName) return no('PRODUCT_TYPE_MISMATCH');
	if (product.private !== pin.isPrivate) return no('PRODUCT_PRIVATE');
	if (product.deprecated !== pin.isDeprecated) return no('PRODUCT_DEPRECATED');
	if (product.category !== pin.category) return no('CATEGORY_MISMATCH');
	if (!sameList(product.proofOfLossInputTypes, pin.proofOfLossInputTypes)) return no('PROOF_OF_LOSS_CHANGED');
	if (productType.wordingCid !== pin.wordingCid) return no('TERMS_CHANGED');
	if (productTerms(product.metadata) !== 'NONE' || pin.annexCid !== null) return no('TERMS_CHANGED');
	if (productType.gracePeriodSeconds !== pin.gracePeriodSec) return no('GRACE_PERIOD_CHANGED');
	const assets = Array.isArray(product.coverAssets) ? product.coverAssets : [];
	const ids = assets.map((asset) => asset.assetId);
	if (!sameList(ids, COVER_ASSET_IDS)) return no('COVER_ASSETS_CHANGED');
	if (assets.some((asset) => NEXUS_ASSETS[asset.assetId].symbol !== asset.symbol)) return no('ASSET_IDENTITY_MISMATCH');
	if (!sameList(COVER_ASSET_IDS.map((id) => NEXUS_ASSETS[id].symbol), pin.coverAssets)) return no('COVER_ASSETS_CHANGED');
	return Object.freeze({
		ok: true,
		productId: pin.productId,
		name: pin.name,
		productTypeId: pin.productTypeId,
		productTypeName: pin.productTypeName,
		category: pin.category,
		proofOfLossInputTypes: Object.freeze([...pin.proofOfLossInputTypes]),
		supportedCoverAssets: Object.freeze(COVER_ASSET_IDS.map((id) => NEXUS_ASSETS[id])),
		wordingCid: pin.wordingCid,
		annexCid: null,
		gracePeriodSeconds: pin.gracePeriodSec
	});
}

/* ---------------------------------------------------------- Kapazitaet -- */

/** Frische einer gelesenen Kapazitaet gegen `now`. Zukunft (Uhr zurueckgesprungen) gilt nie als frisch. */
export function capacityFreshness(capacity, now) {
	const fetched = Date.parse(capacity?.fetchedAt ?? '');
	if (!Number.isFinite(fetched) || !Number.isFinite(now)) return 'INVALID';
	if (fetched > now) return 'CLOCK_SKEW';
	return now - fetched <= CAPACITY_MAX_AGE_MS ? 'FRESH' : 'STALE';
}

/** Kapazitaet nur fuer Produkt 72 und nur fuer dessen Cover-Assets; jede Abweichung schliesst. */
export function uniswapCapacity(capacity, verified, now) {
	if (capacity?.productId !== PRODUCT_ID) return Object.freeze({ status: 'UNAVAILABLE', reason: 'CAPACITY_PRODUCT_MISMATCH' });
	const freshness = capacityFreshness(capacity, now);
	if (freshness !== 'FRESH') return Object.freeze({ status: 'UNAVAILABLE', reason: `CAPACITY_${freshness}`, fetchedAt: capacity.fetchedAt ?? null });
	const view = capacityView(capacity, verified);
	if (view.status === 'UNAVAILABLE') return view;
	if (view.missingAssets.length) return Object.freeze({ ...view, status: 'UNAVAILABLE', reason: 'CAPACITY_ASSET_MISSING' });
	return view.status === 'AVAILABLE' ? view : Object.freeze({ ...view, reason: 'NO_CAPACITY' });
}

/* ------------------------------------------------------------- Gate -- */

const isFreshBlock = (blockTimestamp, now) => {
	if (typeof blockTimestamp !== 'string' || !/^[1-9][0-9]{0,15}$/.test(blockTimestamp) || !Number.isFinite(now)) return 'POSITION_BLOCK_MISSING';
	const at = Number(blockTimestamp) * 1_000;
	if (at > now + 60_000) return 'POSITION_CLOCK_SKEW';
	return now - at <= POSITION_MAX_AGE_MS ? null : 'POSITION_STALE';
};

/**
 * Vor jedem Nexus-Abruf: nur eine gueltige, kanonische, aktive und voll
 * bewertete Position aus einem frischen Scan. Ein NFT ohne Liquiditaet fragt
 * weder Kapazitaet noch Quote an.
 */
export function uniswapQuoteGate(position, exposure, { now = Date.now() } = {}) {
	if (position?.status !== 'VALID') return fail('POSITION_NOT_VALID', { reason: position?.reason ?? null });
	const mapping = uniswapNexusMapping(position);
	if (mapping.mappingClass !== 'MATCHED' || mapping.productId !== PRODUCT_ID) return fail('NOT_MATCHED', { mappingClass: mapping.mappingClass, reason: mapping.reason });
	if (!exposure || exposure.tokenId !== position.tokenId || lower(exposure.pool) !== lower(position.pool) || exposure.blockNumber !== position.blockNumber) return fail('EXPOSURE_MISMATCH');
	if (position.liquidityState !== 'ACTIVE' || exposure.liquidityState !== 'ACTIVE') return fail('ZERO_LIQUIDITY');
	if (exposure.pricingStatus !== 'PRICED' || exposure.counted !== true || !POSITIVE.test(exposure.suggestedExposureUsd8 ?? '')) return fail('PRICING_INCOMPLETE', { pricingStatus: exposure.pricingStatus ?? null });
	if (exposure.feesIncluded !== false) return fail('FEES_INCLUDED');
	const stale = isFreshBlock(exposure.blockTimestamp, now);
	if (stale) return fail(stale);
	return Object.freeze({ ok: true, mapping, suggestedExposureUsd8: BigInt(exposure.suggestedExposureUsd8) });
}

/* -------------------------------------------------------------- Modell -- */

const errorCode = (settled) => settled?.reason?.code ?? 'UNKNOWN';

/**
 * Reine Zusammenfuehrung je NFT. `sources` sind Promise.allSettled-Ergebnisse
 * von readProduct(72) / readProductType(0) / readCapacity(72).
 */
export function buildUniswapNexusModel(position, exposure, sources, { now = Date.now() } = {}) {
	const gate = uniswapQuoteGate(position, exposure, { now });
	const model = (status, reasons, extra = {}) => Object.freeze({
		mode: 'POSITION',
		tokenId: position?.tokenId ?? null,
		pool: position?.pool ?? null,
		blockNumber: position?.blockNumber ?? null,
		suggestedExposureUsd8: gate.ok ? gate.suggestedExposureUsd8.toString() : null,
		suggestedExposureUsd: gate.ok ? exposure.suggestedExposureUsd : null,
		nexusMappingClass: gate.ok ? 'MATCHED' : gate.mappingClass ?? 'UNSUPPORTED',
		product: null,
		capacity: null,
		...extra,
		eligibility: Object.freeze({ status, reasons: Object.freeze(reasons) }),
		generatedAt: new Date(now).toISOString()
	});
	if (!gate.ok) return model(gate.code === 'NOT_MATCHED' ? (gate.mappingClass === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'UNSUPPORTED') : 'UNAVAILABLE', [gate.code]);
	const { product, productType, capacity } = sources ?? {};
	if (product?.status !== 'fulfilled') return model('UNAVAILABLE', [`PRODUCT_UNAVAILABLE:${errorCode(product)}`]);
	if (productType?.status !== 'fulfilled') return model('UNAVAILABLE', [`PRODUCT_TYPE_UNAVAILABLE:${errorCode(productType)}`]);
	const verified = verifyUniswapProduct(product.value, productType.value);
	if (!verified.ok) return model('UNAVAILABLE', [verified.reason]);
	const productView = Object.freeze({ productId: verified.productId, name: verified.name, productTypeName: verified.productTypeName, supportedCoverAssets: Object.freeze(verified.supportedCoverAssets.map((asset) => asset.symbol)), proofOfLossInputTypes: verified.proofOfLossInputTypes, wordingCid: verified.wordingCid, gracePeriodDays: verified.gracePeriodSeconds / 86_400 });
	if (capacity?.status !== 'fulfilled') return model('UNAVAILABLE', [`CAPACITY_UNAVAILABLE:${errorCode(capacity)}`], { product: productView });
	const capacityResult = uniswapCapacity(capacity.value, verified, now);
	if (capacityResult.status !== 'AVAILABLE') return model('UNAVAILABLE', [capacityResult.reason], { product: productView, capacity: capacityResult });
	return model('AVAILABLE', [], { product: productView, capacity: capacityResult });
}

/**
 * Liest Produkt, Produkttyp und Kapazitaet - nur wenn das Gate passt; sonst kein
 * einziger Abruf. Kapazitaet hoechstens CAPACITY_MAX_AGE_MS alt.
 */
export async function getUniswapNexusModel(position, exposure, { fetchImpl, now = Date.now(), timeoutMs } = {}) {
	if (!uniswapQuoteGate(position, exposure, { now }).ok) return buildUniswapNexusModel(position, exposure, null, { now });
	const options = { fetchImpl, now, ...(timeoutMs ? { timeoutMs } : {}) };
	const [product, productType, capacity] = await Promise.allSettled([
		readProduct(PRODUCT_ID, options),
		readProductType(NEXUS_UNISWAP_V3.productTypeId, options),
		readCapacity(PRODUCT_ID, { ...options, maxAgeMs: CAPACITY_MAX_AGE_MS })
	]);
	return buildUniswapNexusModel(position, exposure, { product, productType, capacity }, { now });
}

/* ----------------------------------------------- Umrechnung in Cover-Asset -- */

/**
 * USD (8 Stellen) -> Cover-Asset, exakt: floor(usd8 x 10^decimals / priceUsd8).
 * Preis nur aus CHAINLINK_PRICE_REFERENCE_V1, fuer den gepinnten Referenz-Token
 * und genau dessen Feed, aus demselben Block wie die Exposure. Nie Pool-Spotpreis,
 * nie Nexus, nie Symbol, nie eine angenommene Paritaet.
 */
export function coverAssetConversion(usd8, assetId, priceBook, blockNumber) {
	if (typeof usd8 !== 'bigint' || usd8 <= 0n) return fail('NO_EXPOSURE');
	if (!Object.hasOwn(COVER_ASSET_REFERENCES, assetId) || !Object.hasOwn(NEXUS_ASSETS, assetId)) return fail('ASSET_NOT_SUPPORTED');
	const ref = COVER_ASSET_REFERENCES[assetId];
	const asset = NEXUS_ASSETS[assetId];
	const entry = Object.hasOwn(priceBook ?? {}, lower(ref.token)) ? priceBook[lower(ref.token)] : null;
	if (!entry) return fail('COVER_ASSET_PRICE_UNAVAILABLE');
	if (entry.status !== 'PRICE_OK') return fail('COVER_ASSET_PRICE_UNAVAILABLE', { priceStatus: entry.status, priceReason: entry.reason ?? null });
	const feed = CHAINLINK_FEEDS[ref.feed];
	if (entry.chainId !== 1 || !isAddress(entry.token ?? '') || lower(entry.token) !== lower(ref.token) || entry.sourceType !== 'CHAINLINK_DIRECT'
		|| !Array.isArray(entry.feeds) || entry.feeds.length !== 1 || lower(entry.feeds[0]) !== lower(feed.proxy) || typeof entry.priceUsd8 !== 'bigint' || entry.priceUsd8 <= 0n) return fail('COVER_ASSET_PRICE_INVALID');
	if (typeof blockNumber !== 'string' || entry.blockNumber !== blockNumber) return fail('COVER_ASSET_PRICE_NOT_SAME_BLOCK');
	const amount = (usd8 * 10n ** BigInt(asset.decimals)) / entry.priceUsd8;
	return Object.freeze({
		ok: true,
		assetId,
		symbol: asset.symbol,
		decimals: asset.decimals,
		amountRaw: amount,
		priceUsd8: entry.priceUsd8,
		feed: feed.proxy,
		feedDescription: feed.description,
		updatedAt: entry.updatedAt,
		blockNumber,
		rule: `floor(USD x 10^${asset.decimals} / ${feed.description})`
	});
}

/** Grenzen je Cover-Asset: min(Exposure umgerechnet, Kapazitaet). Nur fuer ein AVAILABLE-Modell. */
export function uniswapCoverBounds(model, priceBook) {
	if (model?.eligibility?.status !== 'AVAILABLE' || model.mode !== 'POSITION') return [];
	const usd8 = BigInt(model.suggestedExposureUsd8);
	return model.capacity.assets.map((capacity) => {
		const capacityRaw = BigInt(capacity.amount);
		const conversion = coverAssetConversion(usd8, capacity.assetId, priceBook, model.blockNumber);
		const base = { assetId: capacity.assetId, symbol: capacity.symbol, decimals: capacity.decimals, capacity: formatUnits(capacityRaw, capacity.decimals), capacityRaw: capacityRaw.toString() };
		if (!conversion.ok) return Object.freeze({ ...base, selectable: false, reason: conversion.code });
		const max = conversion.amountRaw < capacityRaw ? conversion.amountRaw : capacityRaw;
		return Object.freeze({
			...base,
			selectable: max > 0n,
			...(max > 0n ? {} : { reason: conversion.amountRaw === 0n ? 'NO_EXPOSURE' : 'NO_CAPACITY' }),
			maxFromExposureRaw: conversion.amountRaw.toString(),
			maxFromExposure: formatUnits(conversion.amountRaw, capacity.decimals),
			maxAmountRaw: max.toString(),
			maxAmount: formatUnits(max, capacity.decimals),
			limitedBy: conversion.amountRaw <= capacityRaw ? 'EXPOSURE' : 'CAPACITY',
			conversion: Object.freeze({ source: 'CHAINLINK_PRICE_REFERENCE_V1', feed: conversion.feed, description: conversion.feedDescription, priceUsd: formatUnits(conversion.priceUsd8, 8), updatedAt: conversion.updatedAt, blockNumber: conversion.blockNumber, rule: conversion.rule })
		});
	});
}

/* ------------------------------------------------------- Quote-Anfrage -- */

const REQUEST_KEYS = ['mode', 'tokenId', 'coverAsset', 'amount', 'periodDays'];

/** Strenge Anfrage: genau diese Felder. Produkt, Pool, Asset-ID oder Adressen kommen nie vom Aufrufer. */
export function parseUniswapQuoteRequest(body) {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail('INVALID_BODY');
	const keys = Object.keys(body);
	if (keys.some((key) => /product/i.test(key))) return fail('PRODUCT_ID_NOT_ACCEPTED');
	if (keys.length !== REQUEST_KEYS.length || keys.some((key) => !REQUEST_KEYS.includes(key))) return fail('INVALID_BODY');
	if (body.mode === 'AGGREGATE') return fail('AGGREGATE_QUOTE_NOT_ENABLED');
	if (body.mode !== 'POSITION') return fail('INVALID_BODY');
	if (typeof body.tokenId !== 'string' || !/^[1-9][0-9]{0,77}$/.test(body.tokenId)) return fail('INVALID_BODY');
	if (typeof body.coverAsset !== 'string' || !COVER_ASSET_IDS.some((id) => NEXUS_ASSETS[id].symbol === body.coverAsset)) return fail('ASSET_NOT_SUPPORTED');
	if (typeof body.amount !== 'string' || body.amount.length > 48) return fail('INVALID_AMOUNT');
	if (!Number.isSafeInteger(body.periodDays) || body.periodDays < COVER_PERIOD_DAYS.min || body.periodDays > COVER_PERIOD_DAYS.max) return fail('PERIOD_OUT_OF_RANGE');
	return Object.freeze({ ok: true, mode: 'POSITION', tokenId: body.tokenId, coverAsset: body.coverAsset, amount: body.amount, periodDays: body.periodDays });
}

/**
 * Prueft eine (geparste) Anfrage gegen ein AVAILABLE-Modell zu `now`. Betrag
 * hoechstens die umgerechnete Principal-Exposure und hoechstens die Kapazitaet.
 */
export function checkUniswapQuoteRequest(request, model, priceBook, { now = Date.now() } = {}) {
	if (request?.ok !== true || request.mode !== 'POSITION') return fail('INVALID_BODY');
	if (model?.mode !== 'POSITION' || model.eligibility?.status !== 'AVAILABLE' || model.nexusMappingClass !== 'MATCHED') return fail('COVER_NOT_AVAILABLE');
	if (model.product?.productId !== PRODUCT_ID || model.capacity?.productId !== PRODUCT_ID) return fail('PRODUCT_MISMATCH');
	if (request.tokenId !== model.tokenId) return fail('POSITION_MISMATCH');
	if (capacityFreshness(model.capacity, now) !== 'FRESH') return fail('CAPACITY_STALE');
	if (request.periodDays < COVER_PERIOD_DAYS.min || request.periodDays > COVER_PERIOD_DAYS.max) return fail('PERIOD_OUT_OF_RANGE');
	const asset = COVER_ASSET_IDS.map((id) => NEXUS_ASSETS[id]).find((entry) => entry.symbol === request.coverAsset);
	if (!asset || !model.product.supportedCoverAssets.includes(asset.symbol)) return fail('ASSET_NOT_SUPPORTED');
	const bound = uniswapCoverBounds(model, priceBook).find((entry) => entry.assetId === asset.assetId);
	if (!bound) return fail('ASSET_NOT_SUPPORTED');
	if (!bound.selectable) return fail(bound.reason === 'NO_CAPACITY' || bound.reason === 'NO_EXPOSURE' ? 'AMOUNT_OUT_OF_RANGE' : bound.reason, { maxAmount: bound.maxAmount ?? '0' });
	const amount = parseAssetAmount(request.amount, asset.decimals);
	if (amount === null) return fail('INVALID_AMOUNT');
	if (amount <= 0n) return fail('AMOUNT_OUT_OF_RANGE', { maxAmount: bound.maxAmount });
	if (amount > BigInt(bound.capacityRaw)) return fail('AMOUNT_OUT_OF_RANGE', { maxAmount: bound.maxAmount, limitedBy: 'CAPACITY' });
	if (amount > BigInt(bound.maxFromExposureRaw)) return fail('AMOUNT_ABOVE_EXPOSURE', { maxAmount: bound.maxAmount, limitedBy: 'EXPOSURE' });
	return Object.freeze({ ok: true, productId: PRODUCT_ID, coverAsset: asset, amount, periodDays: request.periodDays, maxFromExposure: BigInt(bound.maxFromExposureRaw), bound });
}

/** Interne Ansicht einer Quote; keine Pools, keine Vertragsdaten. Nur Information. */
export function uniswapQuoteView(quote, checked, model, now = Date.now()) {
	const asset = checked.coverAsset;
	const fetchedAt = Date.parse(quote.fetchedAt);
	const view = {
		provider: 'Nexus Mutual',
		productId: PRODUCT_ID,
		productName: model.product.name,
		productTypeName: model.product.productTypeName,
		tokenId: model.tokenId,
		pool: model.pool,
		suggestedExposureUsd: model.suggestedExposureUsd,
		coverAsset: asset.symbol,
		requestedCoverAmount: formatUnits(checked.amount, asset.decimals),
		quotedCoverAmount: formatUnits(BigInt(quote.totalCoverAmount), asset.decimals),
		periodDays: quote.periodDays,
		premium: formatUnits(BigInt(quote.premiumInAsset), asset.decimals),
		premiumAsset: asset.symbol,
		annualPricePercent: (quote.annualPriceBps / 100).toFixed(2),
		capacity: checked.bound.capacity,
		quoteFetchedAt: new Date(fetchedAt).toISOString(),
		quoteExpiresAt: new Date(fetchedAt + QUOTE_TTL_MS).toISOString(),
		informationalOnly: true,
		purchaseAvailable: false
	};
	return Object.freeze({ ...view, status: quoteFreshness(view, now) });
}

/**
 * Eine informative Quote je NFT: Pruefung, dann genau ein GET /v2/quote ueber
 * den bestehenden, streng pruefenden Leser. Jeder Fehler ergibt einen Code, nie
 * eine Ersatz-Praemie und nie einen hoeheren Betrag.
 */
export async function requestUniswapQuote(request, model, priceBook, { fetchImpl, now = Date.now(), timeoutMs } = {}) {
	const checked = checkUniswapQuoteRequest(request, model, priceBook, { now });
	if (!checked.ok) return checked;
	let quote;
	try {
		quote = await readQuote({ productId: PRODUCT_ID, coverAsset: checked.coverAsset, amount: checked.amount, periodDays: checked.periodDays, capacity: model.capacity }, { fetchImpl, now, ...(timeoutMs ? { timeoutMs } : {}) });
	} catch (error) {
		const reason = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
		// Nexus rundet je Pool auf ganze Allokations-Einheiten (0,01 NXM) auf; fuer Produkt 72 am 21.10.2026 belegt.
		if (reason === 'QUOTE_AMOUNT_ROUNDED_UP') return fail('QUOTE_AMOUNT_TOO_SMALL', { reason });
		if (['TIMEOUT', 'UNREACHABLE', 'HTTP_ERROR', 'NOT_FOUND', 'NOT_JSON', 'TOO_LARGE', 'REDIRECTED', 'MALFORMED_JSON'].includes(reason)) return fail('QUOTE_UNAVAILABLE', { reason });
		return fail('QUOTE_REJECTED', { reason });
	}
	// Doppelte Sicherung: die Quote bindet an Produkt 72 und das Asset und bleibt innerhalb der Toleranz ueber der Exposure.
	if (quote.productId !== PRODUCT_ID || quote.coverAsset !== checked.coverAsset.symbol || quote.periodDays !== checked.periodDays) return fail('QUOTE_REJECTED', { reason: 'QUOTE_BINDING_MISMATCH' });
	const total = BigInt(quote.totalCoverAmount);
	const cap = checked.maxFromExposure + (checked.maxFromExposure * QUOTE_OVERAGE.percent) / 100n + QUOTE_OVERAGE.units;
	if (total > cap) return fail('QUOTE_REJECTED', { reason: 'QUOTE_AMOUNT_ABOVE_EXPOSURE' });
	return Object.freeze({ ok: true, quote: uniswapQuoteView(quote, checked, model, now) });
}

/* ---------------------------------------------------------- Aggregat -- */

/**
 * Grundlage einer KUENFTIGEN Wallet-Quote ueber alle NFTs (Modus AGGREGATE).
 * In dieser Phase wird keine solche Quote angefragt (parseUniswapQuoteRequest
 * lehnt sie ab). Die Grundlage existiert nur, wenn das Aggregat COMPLETE ist
 * und jede aktive Position MATCHED ist; nie werden NFTs still zusammengelegt.
 */
export function aggregateQuoteBasis(scan) {
	if (scan?.status !== 'OK') return fail('SCAN_UNAVAILABLE');
	if (scan.aggregate?.status !== 'COMPLETE' || typeof scan.aggregate.suggestedExposureUsd !== 'string') return fail('AGGREGATE_INCOMPLETE', { reasons: scan.aggregate?.incompleteReasons ?? [] });
	const active = (scan.positions ?? []).filter((position) => position.status === 'VALID' && position.liquidityState === 'ACTIVE');
	if (!active.length) return fail('NO_ACTIVE_POSITION');
	if (active.some((position) => uniswapNexusMapping(position).mappingClass !== 'MATCHED')) return fail('NOT_MATCHED');
	return Object.freeze({ ok: true, mode: 'AGGREGATE', quoteEnabled: false, tokenIds: Object.freeze(active.map((position) => position.tokenId)), suggestedExposureUsd: scan.aggregate.suggestedExposureUsd });
}

/* --------------------------------------------------------- Readiness -- */

/**
 * Bereitschaft je NFT.
 *   quoteDataReady: technisch kann eine informative Quote angefragt werden
 *   quoteReady:     eine frische informative Quote liegt vor (nur Anzeige)
 *   purchaseReady:  immer false
 */
export function uniswapV3QuoteReadiness({ position, exposure, model, priceBook, quote = null, now = Date.now() } = {}) {
	const blockers = [];
	const positionValid = position?.status === 'VALID';
	if (!positionValid) blockers.push('POSITION_NOT_VALID');
	const mapping = positionValid ? uniswapNexusMapping(position) : { mappingClass: 'UNSUPPORTED' };
	if (mapping.mappingClass !== 'MATCHED') blockers.push('NEXUS_MAPPING_NOT_MATCHED');
	const gate = uniswapQuoteGate(position, exposure, { now });
	const exposureReady = positionValid && exposure?.counted === true && exposure.liquidityState === 'ACTIVE';
	if (!exposureReady) blockers.push(exposure?.liquidityState === 'ZERO_LIQUIDITY' ? 'ZERO_LIQUIDITY' : 'EXPOSURE_NOT_READY');
	const bounds = model ? uniswapCoverBounds(model, priceBook) : [];
	const pricingReady = gate.ok && exposure.pricingStatus === 'PRICED' && bounds.some((bound) => bound.selectable);
	if (!pricingReady) blockers.push('PRICING_NOT_READY');
	const capacityReady = gate.ok && model?.eligibility?.status === 'AVAILABLE' && capacityFreshness(model.capacity, now) === 'FRESH';
	if (!capacityReady) blockers.push('CAPACITY_NOT_READY');
	const quoteDataReady = positionValid && mapping.mappingClass === 'MATCHED' && exposureReady && pricingReady && capacityReady;
	if (!quoteDataReady) blockers.push('QUOTE_DATA_NOT_READY');
	if (quote && quote.status !== 'FRESH') blockers.push('QUOTE_STALE');
	blockers.push(...PHASE_BLOCKERS);
	return Object.freeze({
		deploymentClass: positionValid ? 'CANONICAL' : 'UNVERIFIED',
		nexusMappingClass: mapping.mappingClass,
		positionValid,
		exposureReady,
		pricingReady,
		capacityReady,
		quoteDataReady,
		termsReady: false,
		proofOfLossReady: false,
		quoteReady: quoteDataReady && quote?.status === 'FRESH',
		purchaseReady: false,
		blockers: Object.freeze([...new Set(blockers)])
	});
}

export { EXTERNAL_BLOCKERS };
