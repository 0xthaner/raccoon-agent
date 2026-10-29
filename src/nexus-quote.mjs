/*
	NEXUS COVER-DETAILS UND QUOTE, NUR ANZEIGE (P3, 18.10.2026).

	Baut auf dem Lesemodell (nexus-read-model.mjs) auf und fuegt genau zwei
	Dinge hinzu: die Grenzen fuer eine Cover-Summe und eine Live-Quote.

	Der Client nennt nur { deploymentKey, coverAsset (Symbol), amount (Dezimal-
	text im Asset), periodDays }. Produkt, Produkttyp, Asset-ID, Pools und alle
	Adressen leitet der Server ab. Eine Produkt-ID im Body wird abgelehnt.

	Grenzen je Cover-Asset (alles BigInt, keine Gleitkommazahl):
	  maxFromExposure = floor(suggestedExposure[USD, 8 Stellen] x 10^decimals / Preis)
	  quoteMax        = verfuegbare Kapazitaet (Grenze der unverbindlichen Quote)
	  purchaseMax     = min(maxFromExposure, verfuegbare Kapazitaet) (Grenze der
	                    Kaufbereitschaft, aave-cover-readiness.mjs, CR-NEXUS-007.P4)
	  Preis: Aave-Orakel aus demselben Block wie die Position (pricing.reference);
	  ETH wird zum Orakelpreis von WETH bewertet (1:1).

	Freie Quote (29.10.2026, fachlich freigegeben): die gewuenschte Summe darf
	ueber dem erkannten Engagement liegen; sie geht unveraendert an Nexus und
	wird nur als aboveExposure gekennzeichnet. Nexus darf sie hoechstens 5 %
	aufrunden (QUOTE_ROUNDING.ALLOCATION_UNITS, nexus-read-api.mjs); die Quote
	traegt angefragte und angebotene Summe getrennt, die Praemie gilt fuer die
	angebotene. Eine Quote ist nie eine Deckung.
	Laufzeit 28..365 Tage (Cover.sol v3.4.0) - die Nexus-API prueft das selbst
	nicht (am 18.10.2026 lieferte sie Quotes fuer 27 Tage und fuer DAI).

	Eine Quote hat bei Nexus weder Ablauf noch Signatur. CoverRaccoon gibt ihr
	eine eigene, kurze Gueltigkeit (QUOTE_TTL_MS); danach ist sie nur noch als
	"veraltet" anzeigbar und darf nie Grundlage einer spaeteren Aktion sein
	(isQuoteUsable). Es gibt hier keinen Kauf, keine Freigabe, keine Transaktion,
	keine Vertriebsgebuehr, keinen Proof-of-Loss-Upload.

	Aave-Phase (20.10.2026): die Details tragen zusaetzlich den Bereitschafts-
	Status aus aave-cover-readiness.mjs (status BLOCKED und neutrale Gruende),
	damit die Anzeige ehrlich sagt, warum es keinen Abschluss gibt.
*/
import { formatUnits } from 'viem';
import { AAVE_V3_MARKETS, REFERENCE_TOKENS } from './positions/aave-registry.mjs';
import { COVER_PERIOD_DAYS, NEXUS_ASSETS } from './nexus-pinned.mjs';
import { QUOTE_ROUNDING, readQuote } from './nexus-read-api.mjs';
import { evaluateAavePurchaseReadiness, publicReadiness } from './aave-cover-readiness.mjs';

export const QUOTE_TTL_MS = 60_000;
export const PERIOD_PRESETS = Object.freeze([30, 90, 180, 365]);
/** Cover-Asset -> Referenz-Token im Aave-Orakel. */
export const PRICE_REFERENCE = Object.freeze({ ETH: 'WETH', USDC: 'USDC', cbBTC: 'cbBTC' });

const DEPLOYMENT_KEY = /^[a-z0-9-]{1,64}$/;
const DETAILS_KEYS = ['action', 'deploymentKey'];
const QUOTE_KEYS = ['action', 'deploymentKey', 'coverAsset', 'amount', 'periodDays'];
const USD = /^(0|[1-9][0-9]{0,29})(\.[0-9]{1,8})?$/;

const fail = (code, extra = {}) => Object.freeze({ ok: false, code, ...extra });

/**
 * Strenger Body: genau die erlaubten Felder, nichts sonst. Eine Produkt-ID
 * (oder sonst ein Nexus-Feld) wird ausdruecklich abgelehnt.
 */
export function parseCoverRequest(body) {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail('INVALID_BODY');
	const keys = Object.keys(body);
	if (keys.some((key) => /product/i.test(key))) return fail('PRODUCT_ID_NOT_ACCEPTED');
	if (typeof body.deploymentKey !== 'string' || !DEPLOYMENT_KEY.test(body.deploymentKey)) return fail('INVALID_BODY');
	if (body.action === 'details') {
		if (keys.some((key) => !DETAILS_KEYS.includes(key))) return fail('INVALID_BODY');
		return Object.freeze({ ok: true, action: 'details', deploymentKey: body.deploymentKey });
	}
	if (body.action !== 'quote' || keys.some((key) => !QUOTE_KEYS.includes(key)) || keys.length !== QUOTE_KEYS.length) return fail('INVALID_BODY');
	if (typeof body.coverAsset !== 'string' || !Object.hasOwn(PRICE_REFERENCE, body.coverAsset)) return fail('ASSET_NOT_SUPPORTED');
	if (typeof body.amount !== 'string' || body.amount.length > 48) return fail('INVALID_AMOUNT');
	if (!Number.isSafeInteger(body.periodDays)) return fail('PERIOD_OUT_OF_RANGE');
	if (body.periodDays < COVER_PERIOD_DAYS.min || body.periodDays > COVER_PERIOD_DAYS.max) return fail('PERIOD_OUT_OF_RANGE');
	return Object.freeze({ ok: true, action: 'quote', deploymentKey: body.deploymentKey, coverAsset: body.coverAsset, amount: body.amount, periodDays: body.periodDays });
}

/** Dezimaltext -> kleinste Einheit; null bei mehr Nachkommastellen als das Asset hat. */
export function parseAssetAmount(text, decimals) {
	const pattern = new RegExp(`^(0|[1-9][0-9]{0,29})(\\.[0-9]{1,${decimals}})?$`);
	if (typeof text !== 'string' || !pattern.test(text)) return null;
	const [whole, fraction = ''] = text.split('.');
	return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

function usdBase(text) {
	if (typeof text !== 'string' || !USD.test(text)) return null;
	const [whole, fraction = ''] = text.split('.');
	return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
}

function referencePrice(position, symbol) {
	const token = PRICE_REFERENCE[symbol];
	const entries = Array.isArray(position?.pricing?.reference) ? position.pricing.reference : [];
	const entry = entries.find((item) => item?.token === token && typeof item.asset === 'string' && item.asset.toLowerCase() === REFERENCE_TOKENS[token].toLowerCase());
	if (!entry || typeof entry.price !== 'string' || !/^[1-9][0-9]{0,40}$/.test(entry.price)) return null;
	return { token, asset: REFERENCE_TOKENS[token], decimals: entry.decimals, price: BigInt(entry.price) };
}

/**
 * Grenzen je unterstuetztem Cover-Asset. Nur fuer ein AVAILABLE-Lesemodell;
 * sonst leer. Jede Umrechnung wird mit Quelle und Regel ausgewiesen.
 */
export function coverBounds(model, position) {
	if (model?.eligibility?.status !== 'AVAILABLE' || model.exposure?.status !== 'OK') return [];
	const suggested = usdBase(model.exposure.suggestedExposure);
	if (suggested === null) return [];
	return model.capacity.assets.map((capacity) => {
		const asset = NEXUS_ASSETS[capacity.assetId];
		const capacityAmount = BigInt(capacity.amount);
		const price = referencePrice(position, asset.symbol);
		if (!price || price.decimals !== asset.decimals) {
			return Object.freeze({ symbol: asset.symbol, decimals: asset.decimals, selectable: false, purchaseSelectable: false, reason: 'PRICE_UNAVAILABLE', capacity: formatUnits(capacityAmount, asset.decimals), capacityRaw: capacityAmount.toString() });
		}
		const fromExposure = (suggested * 10n ** BigInt(asset.decimals)) / price.price;
		const purchaseMax = fromExposure < capacityAmount ? fromExposure : capacityAmount;
		return Object.freeze({
			symbol: asset.symbol,
			decimals: asset.decimals,
			// Quote: nur die Kapazitaet begrenzt; das Engagement nie.
			selectable: capacityAmount > 0n,
			...(capacityAmount > 0n ? {} : { reason: 'NO_CAPACITY' }),
			capacity: formatUnits(capacityAmount, asset.decimals),
			capacityRaw: capacityAmount.toString(),
			quoteMax: formatUnits(capacityAmount, asset.decimals),
			quoteMaxRaw: capacityAmount.toString(),
			maxFromExposure: formatUnits(fromExposure, asset.decimals),
			maxFromExposureRaw: fromExposure.toString(),
			// Kauf: Engagement und Kapazitaet (nur fuer die Kaufbereitschaft).
			purchaseSelectable: purchaseMax > 0n,
			purchaseMax: formatUnits(purchaseMax, asset.decimals),
			purchaseMaxRaw: purchaseMax.toString(),
			purchaseLimitedBy: fromExposure <= capacityAmount ? 'EXPOSURE' : 'CAPACITY',
			conversion: Object.freeze({
				source: 'aave-oracle',
				oracle: position.pricing.oracle ?? null,
				blockNumber: position.blockNumber ?? null,
				referenceToken: price.token,
				referenceAsset: price.asset,
				priceUsd: formatUnits(price.price, 8),
				rule: `amount = floor(USD x 10^${asset.decimals} / priceUsd)`,
				...(asset.symbol === 'ETH' ? { note: 'ETH valued at the Aave oracle price of WETH (1:1)' } : {})
			})
		});
	});
}

/** Nur fuer eine AVAILABLE-Zuordnung; alles andere ist eine neutrale Statusmeldung ohne Produkt. */
export function coverDetails(model, position, now = Date.now()) {
	const status = model?.eligibility?.status ?? 'UNAVAILABLE';
	if (status !== 'AVAILABLE') return Object.freeze({ ok: true, available: false, status });
	const market = AAVE_V3_MARKETS.find((entry) => entry.deploymentKey === position.deploymentKey);
	const w = model.wording;
	return Object.freeze({
		ok: true,
		available: true,
		status,
		provider: 'Nexus Mutual',
		productName: w.productName,
		productTypeName: w.productTypeName,
		position: Object.freeze({ protocol: 'Aave v3', network: 'Ethereum', market: market.label, deploymentKey: market.deploymentKey }),
		exposure: Object.freeze({
			calculationMethod: model.exposure.calculationMethod,
			currency: 'USD',
			grossExposure: model.exposure.grossExposure,
			debt: model.exposure.debt,
			suggestedExposure: model.exposure.suggestedExposure,
			disclaimers: model.exposure.disclaimers
		}),
		assets: Object.freeze(coverBounds(model, position).map(publicBound)),
		periodDays: Object.freeze({ min: COVER_PERIOD_DAYS.min, max: COVER_PERIOD_DAYS.max, presets: PERIOD_PRESETS }),
		proofOfLoss: Object.freeze({ inputTypes: w.proofOfLossInputTypes }),
		gracePeriodDays: w.gracePeriodDays,
		wording: Object.freeze({ cid: w.wordingCid, url: w.wordingUrl }),
		annex: w.annexUrl ? Object.freeze({ cid: w.annexCid, url: w.annexUrl }) : null,
		annualPriceRange: model.capacity.annualPriceRange,
		capacityFetchedAt: model.capacity.fetchedAt,
		quoteTtlSeconds: QUOTE_TTL_MS / 1_000,
		// Ohne Quote, Allokation und Ausfuehrungszustand nie bereit; die externen Blocker gelten ohnehin.
		readiness: publicReadiness(evaluateAavePurchaseReadiness({ sessionWallet: position.wallet, position, model, bounds: coverBounds(model, position), quote: null, allocation: null, execution: null, now }))
	});
}

/**
 * Prueft eine Quote-Anfrage gegen das AVAILABLE-Lesemodell. Liefert die vom
 * Server abgeleiteten Quote-Parameter oder einen Fehlercode - nie einen Wert
 * aus dem Client ausser Asset-Symbol, Betrag und Laufzeit.
 */
export function checkQuoteRequest(request, model, position) {
	if (model?.nexusMatch?.status !== 'EXACT' || model.eligibility?.status !== 'AVAILABLE') return fail('COVER_NOT_AVAILABLE');
	if (request.periodDays < COVER_PERIOD_DAYS.min || request.periodDays > COVER_PERIOD_DAYS.max) return fail('PERIOD_OUT_OF_RANGE');
	const bound = coverBounds(model, position).find((entry) => entry.symbol === request.coverAsset);
	const asset = Object.values(NEXUS_ASSETS).find((entry) => entry.symbol === request.coverAsset);
	if (!bound || !asset || !model.nexusMatch.supportedCoverAssets.includes(request.coverAsset)) return fail('ASSET_NOT_SUPPORTED');
	if (!bound.selectable) return fail('AMOUNT_OUT_OF_RANGE', { maxAmount: bound.quoteMax ?? '0', ...(bound.reason === 'NO_CAPACITY' ? { limitedBy: 'CAPACITY' } : {}) });
	const amount = parseAssetAmount(request.amount, asset.decimals);
	if (amount === null) return fail('INVALID_AMOUNT');
	if (amount <= 0n) return fail('AMOUNT_OUT_OF_RANGE', { maxAmount: bound.quoteMax, limitedBy: 'CAPACITY' });
	if (amount > BigInt(bound.quoteMaxRaw)) return fail('AMOUNT_OUT_OF_RANGE', { maxAmount: bound.quoteMax, limitedBy: 'CAPACITY' });
	// Ueber dem erkannten Engagement ist erlaubt, wird aber gekennzeichnet (nie eine Deckung).
	const exposureRaw = BigInt(bound.maxFromExposureRaw);
	return Object.freeze({ ok: true, productId: model.nexusMatch.productId, coverAsset: asset, amount, periodDays: request.periodDays, exposureRaw, aboveExposure: amount > exposureRaw });
}

/** Frisch bis quoteExpiresAt (ausschliesslich); danach nur noch als veraltet anzeigbar. */
export function quoteFreshness(quote, now = Date.now()) {
	const expires = Date.parse(quote?.quoteExpiresAt ?? '');
	return Number.isFinite(expires) && now < expires ? 'FRESH' : 'STALE';
}

/** Eine spaetere Aktion darf nur auf einer frischen Quote aufbauen. In P3 gibt es keine solche Aktion. */
export const isQuoteUsable = (quote, now = Date.now()) => quoteFreshness(quote, now) === 'FRESH';

/**
 * Oeffentliche Form einer Grenze: die Kaufgrenze (purchase*) bleibt serverintern
 * (nur aave-cover-readiness.mjs); angezeigt wird sie nur als Vorschlag fuer die Summe.
 */
function publicBound(bound) {
	const { purchaseSelectable, purchaseMax, purchaseMaxRaw, purchaseLimitedBy, ...rest } = bound;
	return Object.freeze({ ...rest, ...(purchaseSelectable ? { suggestedAmount: purchaseMax, suggestedLimitedBy: purchaseLimitedBy } : {}) });
}

/** Aufschlag in Prozent mit zwei Stellen, aufgerundet (nie kleiner dargestellt als er ist). */
function percentUp(delta, base) {
	const bps = (delta * 10_000n + base - 1n) / base;
	return `${bps / 100n}.${String(bps % 100n).padStart(2, '0')}`;
}

/**
 * Oeffentliche Form einer Quote: Anzeige-Werte, keine Pools, keine Vertragsdaten.
 * Drei Betraege bleiben getrennt: erkanntes Engagement (exposureAmount), angefragte
 * Summe (requestedAmount) und von Nexus angebotene Summe (offeredAmount, Grundlage der Praemie).
 */
export function quoteView(quote, model, now = Date.now(), { exposureRaw = null } = {}) {
	const asset = Object.values(NEXUS_ASSETS).find((entry) => entry.symbol === quote.coverAsset);
	const fetchedAt = Date.parse(quote.fetchedAt);
	const requested = BigInt(quote.coverAmount);
	const offered = BigInt(quote.totalCoverAmount);
	const delta = offered - requested;
	const view = {
		provider: 'Nexus Mutual',
		productName: model.wording.productName,
		productTypeName: model.wording.productTypeName,
		coverAsset: asset.symbol,
		requestedAmount: formatUnits(requested, asset.decimals),
		offeredAmount: formatUnits(offered, asset.decimals),
		roundingDelta: formatUnits(delta, asset.decimals),
		roundingPercent: percentUp(delta, requested),
		// Ueber 1 % ist die Aufrundung ausdruecklich anzuzeigen (Regel ALLOCATION_UNITS, hoechstens 5 %).
		roundingNotice: delta * 100n > requested,
		exposureAmount: exposureRaw === null ? null : formatUnits(exposureRaw, asset.decimals),
		aboveExposure: exposureRaw === null ? null : requested > exposureRaw,
		premiumBasis: 'OFFERED_AMOUNT',
		periodDays: quote.periodDays,
		premium: formatUnits(BigInt(quote.premiumInAsset), asset.decimals),
		premiumAsset: asset.symbol,
		annualPricePercent: (quote.annualPriceBps / 100).toFixed(2),
		quoteFetchedAt: new Date(fetchedAt).toISOString(),
		quoteExpiresAt: new Date(fetchedAt + QUOTE_TTL_MS).toISOString()
	};
	return Object.freeze({ ...view, freshness: quoteFreshness(view, now) });
}

/**
 * Ablauf einer Quote: Pruefung gegen das Lesemodell, dann genau ein GET
 * /v2/quote. Ein Nexus-Fehler ergibt QUOTE_UNAVAILABLE - nie eine Ersatz-Praemie.
 */
export async function requestCoverQuote(request, model, position, { fetchImpl = fetch, now = Date.now(), timeoutMs } = {}) {
	const checked = checkQuoteRequest(request, model, position);
	if (!checked.ok) return checked;
	const productId = checked.productId;
	let quote;
	try {
		// Nur dieser Aave-Core-Pfad nutzt die erweiterte Aufrundungsregel; Uniswap bleibt STRICT.
		quote = await readQuote({ productId, coverAsset: checked.coverAsset, amount: checked.amount, periodDays: checked.periodDays, capacity: model.capacity, rounding: QUOTE_ROUNDING.ALLOCATION_UNITS }, { fetchImpl, now, ...(timeoutMs ? { timeoutMs } : {}) });
	} catch (error) {
		// Erklaerte Aufrundung ueber 5 %: eigener Code, mit angefragter und angebotener Summe, ohne Praemie.
		if (error?.code === 'QUOTE_ROUNDING_EXCEEDED' && typeof error.offeredRaw === 'string') {
			const requested = checked.amount;
			const offered = BigInt(error.offeredRaw);
			return fail('QUOTE_ROUNDING_EXCEEDED', {
				requestedAmount: formatUnits(requested, checked.coverAsset.decimals),
				offeredAmount: formatUnits(offered, checked.coverAsset.decimals),
				roundingPercent: percentUp(offered - requested, requested),
				maxRoundingPercent: QUOTE_ROUNDING.ALLOCATION_UNITS.maxPercent.toString()
			});
		}
		return fail('QUOTE_UNAVAILABLE', { reason: typeof error?.code === 'string' ? error.code : 'UNKNOWN' });
	}
	return Object.freeze({ ok: true, quote: quoteView(quote, model, now, { exposureRaw: checked.exposureRaw }) });
}
