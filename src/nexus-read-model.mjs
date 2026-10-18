/*
	NEXUS-LESEMODELL JE POSITION (P1 + P2, 18.10.2026).

	Fasst fuer GENAU eine erkannte Position zusammen, was CoverRaccoon ueber ein
	passendes Nexus-Produkt sicher sagen kann:

	  { position, nexusMatch, exposure, capacity, wording, eligibility, generatedAt }

	eligibility.status:
	  AVAILABLE    nur bei EXACT-Zuordnung, bestaetigter gepinnter Identitaet,
	               gueltigem Wording-Bezug, gueltiger Kapazitaet > 0 in einem
	               unterstuetzten Asset und gueltigem Engagement
	  UNAVAILABLE  EXACT, aber irgendetwas davon fehlt, ist kaputt oder weicht ab
	  AMBIGUOUS    PROBABLE oder widerspruechliche Positionsangaben
	  UNSUPPORTED  keine unterstuetzte Zuordnung

	Nur lesend und nur intern: keine Quote, kein Kaufknopf, keine Transaktion,
	keine Provision, kein Proof-of-Loss-Upload, keine Speicherung. Ein Ausfall
	der Nexus-API ergibt UNAVAILABLE, nie AVAILABLE. Bedingungen werden nicht
	zusammengefasst; verlinkt wird das Wording selbst.
*/
import { formatUnits } from 'viem';
import { annexCid, ipfsUrl, productTerms } from './nexus-facts.mjs';
import { COVER_PERIOD_DAYS, NEXUS_ASSETS, PINNED_PRODUCTS } from './nexus-pinned.mjs';
import { readCapacity, readProduct, readProductType } from './nexus-read-api.mjs';
import { computeAaveExposure } from './positions/exposure.mjs';
import { matchPositionToNexus } from './positions/nexus-mapping.mjs';

export const ELIGIBILITY_STATUSES = Object.freeze(['AVAILABLE', 'UNAVAILABLE', 'AMBIGUOUS', 'UNSUPPORTED']);

const fail = (reason) => Object.freeze({ ok: false, reason });
const sameList = (a, b) => a.length === b.length && [...a].sort().every((value, i) => value === [...b].sort()[i]);

/** Vergleicht die gelesenen Produktdaten mit der gepinnten Identitaet; jede Abweichung ist ein Fehlschlag. */
export function verifyPinnedProduct(productId, product, productType) {
	const pinned = Object.hasOwn(PINNED_PRODUCTS, productId) ? PINNED_PRODUCTS[productId] : null;
	if (!pinned) return fail('NOT_PINNED');
	if (!product || product.productId !== productId) return fail('PRODUCT_ID_MISMATCH');
	if (product.name !== pinned.name) return fail('PRODUCT_NAME_MISMATCH');
	if (product.productTypeId !== pinned.productTypeId) return fail('PRODUCT_TYPE_MISMATCH');
	if (!productType || productType.productTypeId !== pinned.productTypeId || productType.name !== pinned.productTypeName) return fail('PRODUCT_TYPE_MISMATCH');
	if (product.private) return fail('PRODUCT_PRIVATE');
	if (product.deprecated) return fail('PRODUCT_DEPRECATED');
	if (product.category !== pinned.category) return fail('CATEGORY_MISMATCH');
	if (!sameList(product.proofOfLossInputTypes, pinned.proofOfLossInputTypes)) return fail('PROOF_OF_LOSS_CHANGED');
	if (productType.wordingCid !== pinned.wordingCid) return fail('TERMS_CHANGED');
	const terms = productTerms(product.metadata);
	const annex = terms === 'ANNEX' ? annexCid(product.metadata) : null;
	if (terms === 'UNSUPPORTED' || annex !== pinned.annexCid) return fail('TERMS_CHANGED');
	const supportedCoverAssets = [];
	for (const asset of product.coverAssets) {
		if (!Object.hasOwn(NEXUS_ASSETS, asset.assetId)) continue;
		const known = NEXUS_ASSETS[asset.assetId];
		if (known.symbol !== asset.symbol) return fail('ASSET_IDENTITY_MISMATCH');
		supportedCoverAssets.push(known);
	}
	if (!supportedCoverAssets.length) return fail('NO_SUPPORTED_ASSET');
	return Object.freeze({
		ok: true,
		productId,
		name: pinned.name,
		productTypeId: pinned.productTypeId,
		productTypeName: pinned.productTypeName,
		category: pinned.category,
		proofOfLossInputTypes: Object.freeze([...pinned.proofOfLossInputTypes]),
		supportedCoverAssets: Object.freeze(supportedCoverAssets),
		wordingCid: pinned.wordingCid,
		annexCid: annex,
		gracePeriodSeconds: productType.gracePeriodSeconds
	});
}

/** Kapazitaet nur fuer die unterstuetzten Cover-Assets des Produkts; andere Assets der API (DAI, NXM) fallen weg. */
export function capacityView(capacity, verified) {
	const assets = [];
	const missingAssets = [];
	for (const known of verified.supportedCoverAssets) {
		const entry = capacity.assets.find((asset) => asset.assetId === known.assetId);
		if (!entry) { missingAssets.push(known.symbol); continue; }
		if (entry.symbol !== known.symbol || entry.decimals !== known.decimals) return Object.freeze({ status: 'UNAVAILABLE', reason: 'CAPACITY_ASSET_MISMATCH', fetchedAt: capacity.fetchedAt, source: capacity.source });
		assets.push(Object.freeze({ assetId: known.assetId, symbol: known.symbol, decimals: known.decimals, amount: entry.amount, formatted: formatUnits(BigInt(entry.amount), known.decimals) }));
	}
	const positive = assets.some((asset) => BigInt(asset.amount) > 0n);
	return Object.freeze({
		status: positive ? 'AVAILABLE' : 'NO_CAPACITY',
		fetchedAt: capacity.fetchedAt,
		source: capacity.source,
		assets: Object.freeze(assets),
		missingAssets: Object.freeze(missingAssets),
		annualPriceRange: Object.freeze({ min: capacity.minAnnualPrice, max: capacity.maxAnnualPrice })
	});
}

function wordingView(verified, product, productType) {
	return Object.freeze({
		status: 'AVAILABLE',
		productName: verified.name,
		productTypeName: verified.productTypeName,
		wordingCid: verified.wordingCid,
		wordingUrl: ipfsUrl(verified.wordingCid),
		annexCid: verified.annexCid,
		annexUrl: verified.annexCid ? ipfsUrl(verified.annexCid) : null,
		gracePeriodDays: verified.gracePeriodSeconds / 86_400,
		coverPeriodDays: COVER_PERIOD_DAYS,
		proofOfLossInputTypes: verified.proofOfLossInputTypes,
		supportedCoverAssets: Object.freeze(verified.supportedCoverAssets.map((asset) => asset.symbol)),
		exclusionsModeled: false,
		fetchedAt: product.fetchedAt,
		sources: Object.freeze([product.source, productType.source])
	});
}

function positionRef(position) {
	if (position === null || typeof position !== 'object') return null;
	return Object.freeze({
		deploymentKey: position.deploymentKey ?? null,
		chainId: position.chainId ?? null,
		protocolKey: position.protocolKey ?? null,
		protocolVersion: position.protocolVersion ?? null,
		marketAddress: position.marketAddress ?? null,
		blockNumber: position.blockNumber ?? null
	});
}

const errorCode = (settled) => settled?.reason?.code ?? 'UNKNOWN';

/**
 * Reine Zusammenfuehrung. `sources` sind die Promise.allSettled-Ergebnisse von
 * readProduct / readProductType / readCapacity (nur bei EXACT gelesen).
 */
export function buildNexusReadModel(position, sources = null, { now = Date.now() } = {}) {
	const staticMatch = matchPositionToNexus(position);
	const exposure = computeAaveExposure(position);
	const model = (nexusMatch, capacity, wording, status, reasons) => Object.freeze({
		position: positionRef(position),
		nexusMatch,
		exposure,
		capacity,
		wording,
		eligibility: Object.freeze({ status, reasons: Object.freeze(reasons) }),
		generatedAt: new Date(now).toISOString()
	});
	if (staticMatch.status === 'NO_LISTING') return model(staticMatch, null, null, 'UNSUPPORTED', [staticMatch.reason]);
	if (staticMatch.status !== 'EXACT') return model(staticMatch, null, null, 'AMBIGUOUS', [staticMatch.reason]);
	const { product, productType, capacity } = sources ?? {};
	if (product?.status !== 'fulfilled') return model(staticMatch, null, null, 'UNAVAILABLE', [`PRODUCT_UNAVAILABLE:${errorCode(product)}`]);
	if (productType?.status !== 'fulfilled') return model(staticMatch, null, null, 'UNAVAILABLE', [`PRODUCT_TYPE_UNAVAILABLE:${errorCode(productType)}`]);
	const verified = verifyPinnedProduct(staticMatch.productId, product.value, productType.value);
	if (!verified.ok) return model(staticMatch, null, null, 'UNAVAILABLE', [verified.reason]);
	const nexusMatch = matchPositionToNexus(position, verified);
	const wording = wordingView(verified, product.value, productType.value);
	const reasons = [];
	let capacityResult;
	if (capacity?.status !== 'fulfilled') {
		capacityResult = Object.freeze({ status: 'UNAVAILABLE', reason: errorCode(capacity) });
		reasons.push(`CAPACITY_UNAVAILABLE:${errorCode(capacity)}`);
	} else {
		capacityResult = capacityView(capacity.value, verified);
		if (capacityResult.status === 'UNAVAILABLE') reasons.push(capacityResult.reason);
		else if (capacityResult.status !== 'AVAILABLE') reasons.push('NO_CAPACITY');
	}
	if (exposure.status !== 'OK') reasons.push(`EXPOSURE_${exposure.reason}`);
	return model(nexusMatch, capacityResult, wording, reasons.length ? 'UNAVAILABLE' : 'AVAILABLE', reasons);
}

/** Liest die Nexus-Daten nur fuer eine EXACT-Zuordnung; sonst kein einziger Abruf. */
export async function getNexusReadModel(position, { fetchImpl = fetch, now = Date.now(), timeoutMs } = {}) {
	const match = matchPositionToNexus(position);
	if (match.status !== 'EXACT') return buildNexusReadModel(position, null, { now });
	const pinned = PINNED_PRODUCTS[match.productId];
	const options = { fetchImpl, now, ...(timeoutMs ? { timeoutMs } : {}) };
	const [product, productType, capacity] = await Promise.allSettled([
		readProduct(pinned.productId, options),
		readProductType(pinned.productTypeId, options),
		readCapacity(pinned.productId, options)
	]);
	return buildNexusReadModel(position, { product, productType, capacity }, { now });
}
