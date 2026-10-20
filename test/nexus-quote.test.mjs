/**
 * Nexus P3 (18.10.2026): Cover-Details und Live-Quote, nur Anzeige.
 *
 * Offline. Der echte Handler (api/nexus/quote.mjs) mit echter Sitzung, echter
 * Herkunfts- und JSON-Pruefung, echtem Lesemodell und echter Quote-Pruefung;
 * ersetzt sind nur die Positionsquelle, die Rate-Limit-Speicher und das Netz
 * (Mitschnitte in test/fixtures/nexus, api.nexusmutual.io am 18.10.2026).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

Object.assign(process.env, {
	DASHBOARD_SESSION_SECRET: 'quote-test-secret-0123456789abcdef-0123',
	APP_BASE_URL: 'https://coverraccoon.com',
	SUPABASE_URL: process.env.SUPABASE_URL || 'https://supabase.test.invalid',
	SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY || 'test-secret-key'
});

const { AAVE_V3_MARKETS, REFERENCE_TOKENS } = await import('../src/positions/aave-registry.mjs');
const { getNexusReadModel } = await import('../src/nexus-read-model.mjs');
const { nexusGet, readQuote, _test: readCache } = await import('../src/nexus-read-api.mjs');
const quoteLib = await import('../src/nexus-quote.mjs');
const { checkQuoteRequest, coverDetails, parseCoverRequest, quoteFreshness, isQuoteUsable, quoteView, requestCoverQuote, QUOTE_TTL_MS } = quoteLib;
const { createNexusQuoteHandler, LIMITS } = await import('../api/nexus/quote.mjs');
const { createDashboardSession, SESSION_COOKIE } = await import('../src/dashboard-auth.mjs');
const { NEXUS_API_BASE } = await import('../src/nexus-pinned.mjs');

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/nexus/${name}.json`, import.meta.url), 'utf8'));
const PRODUCT = fixture('product-97');
const PRODUCT_TYPE = fixture('product-type-0');
const CAPACITY = fixture('capacity-97');
const QUOTE_USDC = fixture('quote-97-usdc-1000-30d');
const QUOTE_ETH = fixture('quote-97-eth-1-365d');
const USDC_QUERY = '/v2/quote?productId=97&amount=1000000000&period=30&coverAsset=6&paymentAsset=6';
const ETH_QUERY = '/v2/quote?productId=97&amount=1000000000000000000&period=365&coverAsset=0&paymentAsset=0';
const [CORE, LIDO, ETHERFI] = AAVE_V3_MARKETS;
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = Date.UTC(2026, 9, 18, 12);
const clone = (value) => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------- Attrappen -- */

const REFERENCE = [
	{ token: 'WETH', asset: REFERENCE_TOKENS.WETH, decimals: 18, price: '400000000000' }, // 4000 USD
	{ token: 'USDC', asset: REFERENCE_TOKENS.USDC, decimals: 6, price: '100000000' }, // 1 USD
	{ token: 'cbBTC', asset: REFERENCE_TOKENS.cbBTC, decimals: 8, price: '10000000000000' } // 100000 USD
];

function position(market = CORE, overrides = {}) {
	return {
		wallet: WALLET, chainId: 1, protocolKey: 'aave', protocolVersion: 'v3', deploymentKey: market.deploymentKey, label: market.label, marketAddress: market.pool,
		supplied: [{ symbol: 'WETH', usdValue: '25000.12345678', isCollateral: true }, { symbol: 'USDC', usdValue: '1000.5', isCollateral: false }],
		borrowed: [{ symbol: 'USDC', usdValue: '6000.00000001' }],
		totals: { suppliedUsd: '26000.62345678', debtUsd: '6000.00000001', netUsd: '20000.62345677', healthFactor: '3.2' },
		valueKind: 'DERIVED_FROM_AAVE_ORACLE',
		pricing: { source: 'aave-oracle', oracle: market.oracle, baseCurrency: 'USD', baseUnitDecimals: 8, reference: REFERENCE },
		blockNumber: '21000000', status: 'OK', ...overrides
	};
}
/** Sehr grosses Engagement: dann begrenzt die Kapazitaet, nicht das Engagement. */
const whale = () => position(CORE, { supplied: [{ usdValue: '900000000000' }], borrowed: [], totals: { suppliedUsd: '900000000000', debtUsd: '0', netUsd: '900000000000' } });

const jsonResponse = (body, { status = 200, url, type = 'application/json; charset=utf-8' } = {}) => {
	const text = typeof body === 'string' ? body : JSON.stringify(body);
	return { ok: status >= 200 && status < 300, status, url, redirected: false, headers: new Headers({ 'content-type': type }), text: async () => text };
};

function fakeNexus(routes = {}) {
	const calls = [];
	const table = { '/v2/products/97': PRODUCT, '/v2/product-types/0': PRODUCT_TYPE, '/v2/capacity/97': CAPACITY, [USDC_QUERY]: QUOTE_USDC, [ETH_QUERY]: QUOTE_ETH, ...routes };
	const fetchImpl = async (url, init) => {
		calls.push({ url, method: init?.method, redirect: init?.redirect, hasSignal: init?.signal instanceof AbortSignal, body: init?.body });
		assert.ok(url.startsWith(`${NEXUS_API_BASE}/`), `unexpected host: ${url}`);
		const route = table[url.slice(NEXUS_API_BASE.length)];
		if (route === undefined) return jsonResponse({ message: 'not found' }, { status: 404 });
		if (route instanceof Error) throw route;
		if (typeof route === 'function') return route(url, init);
		return jsonResponse(route, { url });
	};
	return { fetchImpl, calls, quoteCalls: () => calls.filter((c) => c.url.includes('/v2/quote')) };
}

const cookie = (wallet = WALLET) => `${SESSION_COOKIE}=${encodeURIComponent(createDashboardSession(wallet))}`;
function res() {
	return { statusCode: null, body: null, headers: {}, headersSent: false, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
}
function req(body, { method = 'POST', headers = {}, url = '/api/nexus/quote', wallet = WALLET } = {}) {
	return { method, url, body, headers: { 'content-type': 'application/json', origin: 'https://coverraccoon.com', 'sec-fetch-site': 'same-origin', ...(wallet ? { cookie: cookie(wallet) } : {}), ...headers } };
}

function setup({ routes, positions = [position(CORE), position(LIDO), position(ETHERFI)], limits = {}, timeoutMs } = {}) {
	readCache.reset();
	const nexus = fakeNexus(routes);
	const seen = { limits: [], positionsFor: [] };
	const limited = (scope) => (limits[scope] ?? true);
	const handler = createNexusQuoteHandler({
		getPositions: async (wallet) => { seen.positionsFor.push(wallet); return { ok: true, wallet, positions }; },
		isRevoked: async () => false,
		rateLimit: async (_req, response, scope, max, window) => { seen.limits.push(`${scope}:${max}/${window}`); if (!limited(scope)) { response.status(429).json({ ok: false }); return false; } return true; },
		rateLimitFor: async (response, scope, value, max, window) => { seen.limits.push(`${scope}:${value}:${max}/${window}`); if (!limited(scope)) { response.status(429).json({ ok: false }); return false; } return true; },
		readModel: (pos, options) => getNexusReadModel(pos, { ...options, fetchImpl: nexus.fetchImpl }),
		quote: (request, model, pos, options) => requestCoverQuote(request, model, pos, { ...options, fetchImpl: nexus.fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) }),
		now: () => NOW
	});
	return { nexus, seen, call: async (body, options) => { const r = res(); await handler(req(body, options), r); return r; } };
}
const quoteBody = (overrides = {}) => ({ action: 'quote', deploymentKey: CORE.deploymentKey, coverAsset: 'USDC', amount: '1000', periodDays: 30, ...overrides });

async function availableModel(pos = position(CORE), routes) {
	readCache.reset();
	const nexus = fakeNexus(routes);
	return { model: await getNexusReadModel(pos, { fetchImpl: nexus.fetchImpl, now: NOW }), nexus };
}

/* ---------------------------------------------------------- gueltige Quote -- */

test('QUOTE-VALID USDC quote for an Aave v3 Core position', async () => {
	const { call, nexus } = setup();
	const r = await call(quoteBody());
	assert.equal(r.statusCode, 200, JSON.stringify(r.body));
	assert.equal(r.body.status, 'QUOTED');
	const q = r.body.quote;
	assert.equal(q.provider, 'Nexus Mutual');
	assert.equal(q.productName, 'Aave v3');
	assert.equal(q.productTypeName, 'Single Protocol Cover');
	assert.equal(q.coverAsset, 'USDC');
	assert.equal(q.coverAmount, '1000');
	assert.equal(q.periodDays, 30);
	assert.equal(q.premium, '3.000578');
	assert.equal(q.premiumAsset, 'USDC');
	assert.equal(q.annualPricePercent, '3.65');
	assert.equal(q.quoteFetchedAt, new Date(NOW).toISOString());
	assert.equal(q.quoteExpiresAt, new Date(NOW + 60_000).toISOString());
	assert.equal(q.freshness, 'FRESH');
	const [quoteCall] = nexus.quoteCalls();
	assert.equal(quoteCall.url, `${NEXUS_API_BASE}${USDC_QUERY}`, 'productId 97 derived by the server, asset id from the pinned table');
	assert.equal(quoteCall.method, 'GET');
	assert.equal(quoteCall.redirect, 'error');
	assert.ok(quoteCall.hasSignal);
	assert.equal(quoteCall.body, undefined);
});

test('QUOTE-VALID ETH quote, one year', async () => {
	const { call, nexus } = setup();
	const r = await call(quoteBody({ coverAsset: 'ETH', amount: '1', periodDays: 365 }));
	assert.equal(r.statusCode, 200, JSON.stringify(r.body));
	assert.equal(r.body.quote.premium, '0.036503848080697347');
	assert.equal(r.body.quote.premiumAsset, 'ETH');
	assert.equal(r.body.quote.coverAmount, '1');
	assert.deepEqual(nexus.quoteCalls().map((c) => c.url), [`${NEXUS_API_BASE}${ETH_QUERY}`]);
});

test('QUOTE-DETAILS shows product, exposure, bounds with unit conversion, terms and proof of loss without a quote call', async () => {
	const { call, nexus } = setup();
	const r = await call({ action: 'details', deploymentKey: CORE.deploymentKey });
	assert.equal(r.statusCode, 200);
	const d = r.body;
	assert.equal(d.available, true);
	assert.equal(d.provider, 'Nexus Mutual');
	assert.equal(d.productName, 'Aave v3');
	assert.equal(d.productTypeName, 'Single Protocol Cover');
	assert.deepEqual(d.position, { protocol: 'Aave v3', network: 'Ethereum', market: 'Core', deploymentKey: 'aave-v3-ethereum-core' });
	assert.equal(d.exposure.suggestedExposure, '20000.62345677');
	assert.equal(d.exposure.calculationMethod, 'AAVE_NET_EXPOSURE_V1');
	assert.deepEqual(d.assets.map((a) => [a.symbol, a.maxFromExposure, a.maxAmount, a.limitedBy]), [
		['ETH', '5.0001558641925', '5.0001558641925', 'EXPOSURE'],
		['USDC', '20000.623456', '20000.623456', 'EXPOSURE'],
		['cbBTC', '0.20000623', '0.20000623', 'EXPOSURE']
	]);
	const eth = d.assets[0];
	assert.equal(eth.conversion.referenceToken, 'WETH');
	assert.equal(eth.conversion.priceUsd, '4000');
	assert.equal(eth.conversion.source, 'aave-oracle');
	assert.match(eth.conversion.note, /WETH/);
	assert.deepEqual(d.periodDays, { min: 28, max: 365, presets: [30, 90, 180, 365] });
	assert.deepEqual(d.proofOfLoss, { inputTypes: ['address'] });
	assert.equal(d.gracePeriodDays, 35);
	assert.equal(d.wording.url, `${NEXUS_API_BASE}/ipfs/QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY`);
	assert.equal(d.annex, null);
	assert.equal(d.quoteTtlSeconds, 60);
	assert.equal(nexus.quoteCalls().length, 0, 'details never request a quote');
});

/* ------------------------------------------------- Produkt nur vom Server -- */

test('QUOTE-PRODUCTID a client-supplied productId is rejected; the product is derived server-side', async () => {
	const { call, nexus, seen } = setup();
	for (const extra of [{ productId: 2 }, { productId: 97 }, { product: 449 }, { productType: 24 }, { nexusProductId: 2 }]) {
		const r = await call({ ...quoteBody(), ...extra });
		assert.equal(r.statusCode, 400, JSON.stringify(extra));
		assert.equal(r.body.code, 'PRODUCT_ID_NOT_ACCEPTED');
		const details = await call({ action: 'details', deploymentKey: CORE.deploymentKey, ...extra });
		assert.equal(details.body.code, 'PRODUCT_ID_NOT_ACCEPTED');
	}
	for (const extra of [{ coverAssetId: 1 }, { wallet: WALLET }, { url: 'https://evil.example' }, { poolId: 1 }]) {
		const r = await call({ ...quoteBody(), ...extra });
		assert.equal(r.statusCode, 400, JSON.stringify(extra));
	}
	assert.equal(nexus.calls.length, 0);
	assert.equal(seen.positionsFor.length, 0, 'rejected before any lookup');
	const ok = await call(quoteBody());
	assert.equal(ok.statusCode, 200);
	assert.ok(nexus.quoteCalls().every((c) => new URL(c.url).searchParams.get('productId') === '97'));
});

test('QUOTE-AMBIGUOUS Lido/Prime and EtherFi positions get a neutral status and never a quote', async () => {
	const { call, nexus } = setup();
	for (const market of [LIDO, ETHERFI]) {
		const details = await call({ action: 'details', deploymentKey: market.deploymentKey });
		assert.equal(details.statusCode, 200);
		assert.deepEqual(details.body, { ok: true, available: false, status: 'AMBIGUOUS' });
		const q = await call(quoteBody({ deploymentKey: market.deploymentKey }));
		assert.equal(q.statusCode, 409);
		assert.equal(q.body.code, 'COVER_NOT_AVAILABLE');
		assert.equal(q.body.quote, undefined);
	}
	// Das Gate selbst: ohne EXACT keine Quote, auch wenn das Modell sonst "AVAILABLE" saehe.
	const { model } = await availableModel();
	const probable = { ...model, nexusMatch: { ...model.nexusMatch, status: 'PROBABLE' } };
	assert.equal(checkQuoteRequest({ coverAsset: 'USDC', amount: '1', periodDays: 30 }, probable, position()).code, 'COVER_NOT_AVAILABLE');
	const conflict = setup({ positions: [position(CORE, { marketAddress: LIDO.pool })] });
	const r = await conflict.call(quoteBody());
	assert.equal(r.body.code, 'COVER_NOT_AVAILABLE');
	assert.equal(nexus.quoteCalls().length + conflict.nexus.quoteCalls().length, 0);
});

test('QUOTE-UNSUPPORTED unknown or undetected positions and unavailable products never get a quote', async () => {
	const { call, nexus } = setup({ positions: [position(CORE)] });
	assert.equal((await call(quoteBody({ deploymentKey: LIDO.deploymentKey }))).statusCode, 404);
	assert.equal((await call(quoteBody({ deploymentKey: 'aave-v2-ethereum' }))).statusCode, 404);
	assert.equal((await call(quoteBody({ deploymentKey: '../../v2/quote' }))).statusCode, 400);
	const other = setup({ positions: [{ ...position(CORE), wallet: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }] });
	assert.equal((await other.call(quoteBody())).statusCode, 404, 'a position of another wallet is never used');
	const renamed = setup({ routes: { '/v2/products/97': { ...PRODUCT, name: 'Aave v3 Horizon' } } });
	const details = await renamed.call({ action: 'details', deploymentKey: CORE.deploymentKey });
	assert.deepEqual(details.body, { ok: true, available: false, status: 'UNAVAILABLE' });
	assert.equal((await renamed.call(quoteBody())).body.code, 'COVER_NOT_AVAILABLE');
	assert.equal(nexus.quoteCalls().length + other.nexus.quoteCalls().length + renamed.nexus.quoteCalls().length, 0);
});

/* --------------------------------------------------------------- Grenzen -- */

test('QUOTE-ASSET only the product cover assets ETH, USDC and cbBTC can be quoted', async () => {
	const { call, nexus } = setup();
	for (const coverAsset of ['DAI', 'NXM', 'WETH', 'eth', 'usdc', 'stETH', '0', 6]) {
		const r = await call(quoteBody({ coverAsset }));
		assert.equal(r.statusCode, 422, String(coverAsset));
		assert.equal(r.body.code, 'ASSET_NOT_SUPPORTED');
	}
	assert.equal(nexus.quoteCalls().length, 0);
	const { model } = await availableModel();
	assert.equal(checkQuoteRequest({ coverAsset: 'DAI', amount: '1', periodDays: 30 }, model, position()).code, 'ASSET_NOT_SUPPORTED');
	// Das Gate selbst: ein Asset, das die Zuordnung nicht fuehrt, ist nie quotierbar - auch wenn Kapazitaet dafuer da waere.
	const narrowed = { ...model, nexusMatch: { ...model.nexusMatch, supportedCoverAssets: ['ETH', 'cbBTC'] } };
	assert.equal(checkQuoteRequest({ coverAsset: 'USDC', amount: '1', periodDays: 30 }, narrowed, position()).code, 'ASSET_NOT_SUPPORTED');
	const noUsdc = await availableModel(position(), { '/v2/products/97': { ...PRODUCT, coverAssets: [{ assetId: 0, assetSymbol: 'ETH' }] } });
	assert.equal(checkQuoteRequest({ coverAsset: 'USDC', amount: '1', periodDays: 30 }, noUsdc.model, position()).code, 'ASSET_NOT_SUPPORTED', 'only assets the product itself lists');
});

test('QUOTE-AMOUNT bounded by the suggested exposure (converted with the Aave oracle price)', async () => {
	const { model } = await availableModel();
	const pos = position();
	const check = (coverAsset, amount) => checkQuoteRequest({ coverAsset, amount, periodDays: 30 }, model, pos);
	assert.equal(check('USDC', '20000.623456').ok, true, 'exactly the maximum');
	assert.equal(check('USDC', '20000.623456').amount, 20_000_623_456n);
	assert.deepEqual({ ...check('USDC', '20000.623457') }, { ok: false, code: 'AMOUNT_OUT_OF_RANGE', maxAmount: '20000.623456', limitedBy: 'EXPOSURE' });
	assert.equal(check('ETH', '5.0001558641925').ok, true);
	assert.equal(check('ETH', '5.000155864192500001').code, 'AMOUNT_OUT_OF_RANGE');
	assert.equal(check('cbBTC', '0.20000624').code, 'AMOUNT_OUT_OF_RANGE');
	assert.equal(check('USDC', '0').code, 'AMOUNT_OUT_OF_RANGE');
	for (const bad of ['-1', '1e3', '0x10', '1.0000001', ' 1', '', '1,5', 'NaN']) assert.equal(check('USDC', bad).code, 'INVALID_AMOUNT', bad);
	const underwater = position(CORE, { supplied: [{ usdValue: '100' }], borrowed: [{ usdValue: '150' }], totals: { suppliedUsd: '100', debtUsd: '150' } });
	const zero = await availableModel(underwater);
	assert.equal(checkQuoteRequest({ coverAsset: 'USDC', amount: '1', periodDays: 30 }, zero.model, underwater).code, 'AMOUNT_OUT_OF_RANGE', 'no exposure, nothing selectable');
	const noPrice = position(CORE, { pricing: { ...position().pricing, reference: [] } });
	const unpriced = await availableModel(noPrice);
	assert.equal(checkQuoteRequest({ coverAsset: 'USDC', amount: '1', periodDays: 30 }, unpriced.model, noPrice).code, 'AMOUNT_OUT_OF_RANGE', 'no trusted price, no conversion');
	assert.ok(coverDetails(unpriced.model, noPrice).assets.every((a) => a.selectable === false && a.reason === 'PRICE_UNAVAILABLE'));
	const { call } = setup();
	const r = await call(quoteBody({ amount: '20000.623457' }));
	assert.equal(r.statusCode, 422);
	assert.equal(r.body.code, 'AMOUNT_OUT_OF_RANGE');
	assert.equal(r.body.maxAmount, '20000.623456');
});

test('QUOTE-CAPACITY bounded by the available capacity of the asset', async () => {
	const pos = whale();
	const { model } = await availableModel(pos);
	const capacity = CAPACITY.availableCapacity.find((a) => a.assetId === 6).amount; // 8712444.805266 USDC
	const check = (amount) => checkQuoteRequest({ coverAsset: 'USDC', amount, periodDays: 30 }, model, pos);
	assert.equal(check('8712444.805266').ok, true);
	assert.equal(check('8712444.805266').amount, BigInt(capacity));
	assert.deepEqual({ ...check('8712444.805267') }, { ok: false, code: 'AMOUNT_OUT_OF_RANGE', maxAmount: '8712444.805266', limitedBy: 'CAPACITY' });
	assert.equal(coverDetails(model, pos).assets.find((a) => a.symbol === 'USDC').limitedBy, 'CAPACITY');
});

test('QUOTE-PERIOD only 28 to 365 days', async () => {
	const { call, nexus } = setup();
	for (const periodDays of [27, 366, 0, -30, 28.5, '30', null, 1e9]) {
		const r = await call(quoteBody({ periodDays }));
		assert.equal(r.statusCode, 422, String(periodDays));
		assert.equal(r.body.code, 'PERIOD_OUT_OF_RANGE');
	}
	assert.equal(nexus.quoteCalls().length, 0, 'Nexus itself would quote 27 days - CoverRaccoon must not ask');
	const { model } = await availableModel();
	for (const periodDays of [28, 29, 100, 364, 365]) assert.equal(checkQuoteRequest({ coverAsset: 'USDC', amount: '1', periodDays }, model, position()).ok, true, String(periodDays));
	for (const periodDays of [27, 366]) assert.equal(checkQuoteRequest({ coverAsset: 'USDC', amount: '1', periodDays }, model, position()).code, 'PERIOD_OUT_OF_RANGE');
});

/* ------------------------------------------------- Quote-Antwort pruefen -- */

async function quoteWith(response, body = { coverAsset: 'USDC', amount: '1000', periodDays: 30 }, options = {}) {
	const { model } = await availableModel();
	const nexus = fakeNexus({ [USDC_QUERY]: response });
	return requestCoverQuote(body, model, position(), { fetchImpl: nexus.fetchImpl, now: NOW, ...options });
}
const quoteWithPatch = (patch) => { const q = clone(QUOTE_USDC); patch(q.quote); return quoteWith(q); };

test('QUOTE-MALFORMED malformed Nexus quote responses never become a premium', async () => {
	const cases = [
		(q) => { q.premiumInAsset = '3.0'; },
		(q) => { q.premiumInAsset = 3000578; },
		(q) => { q.annualPrice = '0'; },
		(q) => { q.annualPrice = '20000'; },
		(q) => { delete q.asset; },
		(q) => { q.refundInAsset = '5'; },
		(q) => { q.poolAllocationRequests = []; },
		(q) => { q.poolAllocationRequests = [{ poolId: 2, coverAmountInAsset: '1000192871' }]; },
		(q) => { q.poolAllocationRequests = [{ poolId: '2', coverAmountInAsset: '1000000000' }]; },
		(q) => { q.totalCoverAmountInAsset = '-1000192871'; }
	];
	for (const patch of cases) {
		const result = await quoteWithPatch(patch);
		assert.equal(result.ok, false, patch.toString());
		assert.equal(result.code, 'QUOTE_UNAVAILABLE');
		assert.equal(result.quote, undefined);
	}
	for (const body of ['{"quote":', '<html>quote</html>', { message: 'Not enough capacity for the cover amount' }, { quote: null }, []]) {
		assert.equal((await quoteWith(body)).code, 'QUOTE_UNAVAILABLE', JSON.stringify(body));
	}
	assert.equal((await quoteWith(() => jsonResponse(QUOTE_USDC, { type: 'text/html' }))).reason, 'NOT_JSON');
	const { call } = setup({ routes: { [USDC_QUERY]: { quote: { ...QUOTE_USDC.quote, premiumInAsset: 'free' } } } });
	const r = await call(quoteBody());
	assert.equal(r.statusCode, 503);
	assert.equal(r.body.code, 'QUOTE_UNAVAILABLE');
	assert.doesNotMatch(JSON.stringify(r.body), /premium/i);
});

test('QUOTE-WRONGPRODUCT a quote allocated to pools outside product 97 is rejected', async () => {
	const foreignPool = await quoteWithPatch((q) => { q.poolAllocationRequests = [{ poolId: '99', coverAmountInAsset: q.totalCoverAmountInAsset }]; });
	assert.deepEqual({ ...foreignPool }, { ok: false, code: 'QUOTE_UNAVAILABLE', reason: 'QUOTE_PRODUCT_MISMATCH' });
	const overPool = await quoteWithPatch((q) => { q.totalCoverAmountInAsset = '2574534383155'; q.poolAllocationRequests = [{ poolId: '2', coverAmountInAsset: '2574534383155' }]; });
	assert.equal(overPool.ok, false);
	const noAssetPool = await quoteWithPatch((q) => { q.poolAllocationRequests = [{ poolId: '4', coverAmountInAsset: q.totalCoverAmountInAsset }]; });
	assert.equal(noAssetPool.reason, 'QUOTE_PRODUCT_MISMATCH', 'pool 4 belongs to the product but has no USDC capacity');
	const split = await quoteWithPatch((q) => { q.poolAllocationRequests = [{ poolId: '2', coverAmountInAsset: '500000000' }, { poolId: '23', coverAmountInAsset: '500192871' }]; });
	assert.equal(split.ok, true, 'control: a split over two pools of the product is fine');
	assert.equal((await quoteWith(QUOTE_USDC)).ok, true, 'control: the captured quote for product 97 is accepted');
});

test('QUOTE-WRONGASSET a quote in another asset than requested is rejected', async () => {
	for (const asset of [{ id: 1, symbol: 'DAI', decimals: 18 }, { id: 6, symbol: 'USDT', decimals: 6 }, { id: 6, symbol: 'USDC', decimals: 18 }, { id: 0, symbol: 'ETH', decimals: 18 }]) {
		const result = await quoteWithPatch((q) => { q.asset = asset; });
		assert.deepEqual({ ...result }, { ok: false, code: 'QUOTE_UNAVAILABLE', reason: 'QUOTE_ASSET_MISMATCH' }, JSON.stringify(asset));
	}
});

test('QUOTE-PRICE premium and amount must match the quoted price and the requested amount', async () => {
	assert.equal((await quoteWithPatch((q) => { q.premiumInAsset = '30005780'; q.premiumInAssetWithRefund = '30005780'; })).reason, 'QUOTE_PRICE_INCONSISTENT');
	assert.equal((await quoteWithPatch((q) => { q.premiumInAsset = '1'; q.premiumInAssetWithRefund = '1'; })).reason, 'QUOTE_PRICE_INCONSISTENT');
	assert.equal((await quoteWithPatch((q) => { q.totalCoverAmountInAsset = '999000000'; q.poolAllocationRequests[0].coverAmountInAsset = '999000000'; })).reason, 'QUOTE_AMOUNT_MISMATCH');
	assert.equal((await quoteWithPatch((q) => { q.totalCoverAmountInAsset = '1100000000'; q.poolAllocationRequests[0].coverAmountInAsset = '1100000000'; })).reason, 'QUOTE_AMOUNT_MISMATCH');
});

test('QUOTE-TIMEOUT a hanging Nexus quote gives QUOTE_UNAVAILABLE without any fallback premium', async () => {
	const hang = (url, init) => new Promise((_, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true }); });
	const { call } = setup({ routes: { [USDC_QUERY]: hang }, timeoutMs: 30 });
	const pending = call(quoteBody());
	let timer;
	const outcome = await Promise.race([pending, new Promise((resolve) => { timer = setTimeout(resolve, 1_500, 'HUNG'); })]);
	clearTimeout(timer);
	assert.notEqual(outcome, 'HUNG');
	assert.equal(outcome.statusCode, 503);
	assert.deepEqual(outcome.body, { ok: false, code: 'QUOTE_UNAVAILABLE', error: 'Nexus Mutual hat gerade keine gültige Quote geliefert.' });
	const direct = await quoteWith(hang, undefined, { timeoutMs: 30 });
	assert.deepEqual({ ...direct }, { ok: false, code: 'QUOTE_UNAVAILABLE', reason: 'TIMEOUT' });
	for (const failure of [new TypeError('fetch failed'), () => jsonResponse({ message: 'Not enough capacity for the cover amount' }, { status: 400 }), () => jsonResponse('x', { status: 500 })]) {
		const result = await quoteWith(failure);
		assert.equal(result.ok, false);
		assert.equal(result.quote, undefined);
	}
});

test('QUOTE-STALE a quote is fresh for 60 s only and never usable afterwards', async () => {
	assert.equal(QUOTE_TTL_MS, 60_000);
	const { model } = await availableModel();
	const raw = { coverAsset: 'USDC', coverAmount: '1000000000', premiumInAsset: '3000578', annualPriceBps: 365, periodDays: 30, fetchedAt: new Date(NOW).toISOString() };
	const fresh = quoteView(raw, model, NOW);
	assert.equal(fresh.freshness, 'FRESH');
	assert.equal(fresh.quoteExpiresAt, new Date(NOW + 60_000).toISOString());
	assert.equal(quoteFreshness(fresh, NOW + 59_999), 'FRESH');
	assert.equal(quoteFreshness(fresh, NOW + 60_000), 'STALE');
	assert.equal(quoteFreshness(fresh, NOW + 3_600_000), 'STALE');
	assert.equal(isQuoteUsable(fresh, NOW + 1_000), true);
	assert.equal(isQuoteUsable(fresh, NOW + 60_000), false);
	assert.equal(isQuoteUsable({ ...fresh, quoteExpiresAt: 'never' }, NOW), false);
	assert.equal(quoteView(raw, model, NOW + 61_000).freshness, 'STALE', 'a view built after expiry is stale');
	readCache.reset();
	const nexus = fakeNexus();
	await readQuote({ productId: 97, coverAsset: { assetId: 6, symbol: 'USDC', decimals: 6 }, amount: 1_000_000_000n, periodDays: 30, capacity: model.capacity }, { fetchImpl: nexus.fetchImpl, now: NOW });
	await readQuote({ productId: 97, coverAsset: { assetId: 6, symbol: 'USDC', decimals: 6 }, amount: 1_000_000_000n, periodDays: 30, capacity: model.capacity }, { fetchImpl: nexus.fetchImpl, now: NOW });
	assert.equal(nexus.quoteCalls().length, 2, 'quotes are never cached');
});

/* -------------------------------------------------------- Netz-Grenze ---- */

test('QUOTE-SSRF only the fixed quote path on the pinned host, encoded values, no redirect', async () => {
	const nexus = fakeNexus();
	const hostile = [
		'/v2/quote', '/v2/quote?productId=97', `${USDC_QUERY}&x=1`, USDC_QUERY.replace('productId=97', 'productId=97%26x=1'),
		'/v2/quote?amount=1000000000&productId=97&period=30&coverAsset=6&paymentAsset=6', '/v2/quote?productId=97&amount=0&period=30&coverAsset=6&paymentAsset=6',
		'https://evil.example/v2/quote?productId=97&amount=1&period=30&coverAsset=6&paymentAsset=6', '//evil.example/v2/quote?productId=97&amount=1&period=30&coverAsset=6&paymentAsset=6',
		'/v2/quote/../cover-metadata', '/v2/cover-metadata', `${USDC_QUERY}#x`, `${USDC_QUERY}\r\nHost: evil.example`
	];
	for (const path of hostile) await assert.rejects(nexusGet(path, { fetchImpl: nexus.fetchImpl }), (error) => error.code === 'PATH_NOT_ALLOWED', path);
	assert.equal(nexus.calls.length, 0);
	const { model } = await availableModel();
	const usdc = { assetId: 6, symbol: 'USDC', decimals: 6 };
	for (const bad of [{ productId: '97&x=1' }, { periodDays: '30&coverAsset=1' }, { coverAsset: { ...usdc, assetId: '6&paymentAsset=1' } }, { amount: '1000000000' }]) {
		const scratch = fakeNexus();
		await assert.rejects(readQuote({ productId: 97, coverAsset: usdc, amount: 1_000_000_000n, periodDays: 30, capacity: model.capacity, ...bad }, { fetchImpl: scratch.fetchImpl, now: NOW }), JSON.stringify(bad));
		assert.ok(scratch.quoteCalls().every((c) => new URL(c.url).search.split('&').length === 5), 'no injected query parameter');
	}
	const redirected = await quoteWith(() => ({ ...jsonResponse(QUOTE_USDC), url: `https://evil.example${USDC_QUERY}` }));
	assert.deepEqual({ ...redirected }, { ok: false, code: 'QUOTE_UNAVAILABLE', reason: 'REDIRECTED' });
	const { call, nexus: n2 } = setup();
	await call(quoteBody());
	assert.ok(n2.calls.every((c) => c.redirect === 'error' && c.method === 'GET' && new URL(c.url).host === 'api.nexusmutual.io'));
});

/* ------------------------------------------------- Auth und Ratenlimits -- */

test('QUOTE-AUTH session, same origin, JSON, size and method are enforced before any lookup', async () => {
	const { call, nexus, seen } = setup();
	assert.equal((await call(quoteBody(), { wallet: null })).statusCode, 401);
	assert.equal((await call(quoteBody(), { headers: { 'sec-fetch-site': 'cross-site' } })).statusCode, 403);
	assert.equal((await call(quoteBody(), { headers: { origin: 'https://evil.example' } })).statusCode, 403);
	assert.equal((await call(quoteBody(), { headers: { 'content-type': 'text/plain' } })).statusCode, 415);
	assert.equal((await call({ ...quoteBody(), pad: 'x'.repeat(2_000) })).statusCode, 413);
	assert.equal((await call(quoteBody(), { method: 'GET' })).statusCode, 405);
	assert.equal((await call(quoteBody(), { url: '/api/nexus/quote?wallet=0xbb' })).statusCode, 400);
	assert.equal(nexus.calls.length, 0);
	assert.equal(seen.positionsFor.length, 0);
	await call(quoteBody());
	assert.deepEqual(seen.positionsFor, [WALLET], 'the position is resolved for the session wallet only');
});

test('QUOTE-RATE per-IP, per-wallet and global limits; quote budgets only before a real quote call', async () => {
	assert.deepEqual({ ...LIMITS }, { ip: [30, 600], wallet: [20, 600], readGlobal: [400, 600], quoteWallet: [10, 600], quoteGlobal: [200, 600] });
	const ok = setup();
	await ok.call(quoteBody());
	assert.deepEqual(ok.seen.limits, [
		'nexus-cover-ip:30/600', `nexus-cover-wallet:${WALLET}:20/600`, 'nexus-read-global:all:400/600',
		`nexus-quote-wallet:${WALLET}:10/600`, 'nexus-quote-global:all:200/600'
	]);
	const invalid = setup();
	await invalid.call(quoteBody({ amount: '999999999' }));
	assert.ok(!invalid.seen.limits.some((l) => l.startsWith('nexus-quote-')), 'an out-of-range request never costs quote budget');
	const details = setup();
	await details.call({ action: 'details', deploymentKey: CORE.deploymentKey });
	assert.ok(!details.seen.limits.some((l) => l.startsWith('nexus-quote-')));
	for (const scope of ['nexus-cover-ip', 'nexus-cover-wallet', 'nexus-read-global', 'nexus-quote-wallet', 'nexus-quote-global']) {
		const limited = setup({ limits: { [scope]: false } });
		const r = await limited.call(quoteBody());
		assert.equal(r.statusCode, 429, scope);
		assert.equal(limited.nexus.quoteCalls().length, 0, `${scope}: no Nexus quote after a 429`);
	}
});

/* ------------------------------------------------------ keine Kaufflaeche -- */

test('QUOTE-NOPURCHASE responses carry no pools, contract data, fees or transaction fields', async () => {
	const { call } = setup();
	const bodies = [await call(quoteBody()), await call(quoteBody({ coverAsset: 'ETH', amount: '1', periodDays: 365 })), await call({ action: 'details', deploymentKey: CORE.deploymentKey })].map((r) => JSON.stringify(r.body));
	for (const text of bodies) {
		assert.doesNotMatch(text, /poolAllocation|poolId|commission|calldata|buyCover|maxPremium|approve|transaction|txHash|"to":|"data":|"value":/i);
		assert.doesNotMatch(text, /Purchase|Buy now|Insure now|fully insured|guaranteed payout|covered loss|approved claim/i);
	}
});

const walk = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).flatMap((f) => (statSync(new URL(`../${dir}/${f}`, import.meta.url)).isDirectory() ? walk(`${dir}/${f}`) : /\.(m?js|html)$/.test(f) ? [`${dir}/${f}`] : []));
const OFFLINE_TX = ['src/purchase-tx-builder.mjs', 'src/purchase-tx-decode.mjs'];
test('QUOTE-SURFACE no purchase surface anywhere in runtime code', () => {
	const files = [...walk('src'), ...walk('api'), ...walk('web/src'), 'web/index.html'];
	for (const file of files) {
		const code = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		assert.doesNotMatch(code, /wallet_sendTransaction|eth_sendTransaction|wallet_sendCalls|sendTransaction|writeContract|cover-metadata|NEXUS_CONTRACTS\s*\.\s*CoverBroker|NEXUS_CONTRACTS\s*\[|\.approve\(/, file);
		// P4C (19.10.2026): nur die zwei reinen, unerreichbaren Offline-Module kodieren buyCover und approve
		// (P4C-IMPORT / P4C-SURFACE in test/purchase-tx-builder.test.mjs); Senden bleibt auch dort ausgeschlossen.
		if (OFFLINE_TX.includes(file)) continue;
		// NEXUS_CONTRACTS (nexus-pinned.mjs) nennt die CoverBroker-Adresse nur als Referenz; verwendet werden darf sie nirgends.
		assert.doesNotMatch(code, /buyCover|CoverBroker\s*\.|encodeFunctionData/, file);
		// P4A (19.10.2026): das reine Intent-Modell traegt die Kommissionsfelder, um sie auf 0 / Nulladresse festzulegen.
		// Es ist von keinem Laufzeitpfad erreichbar (P4A-IMPORT in test/purchase-intent.test.mjs); alle anderen Muster gelten auch dort.
		// P4H (20.10.2026): ebenso der unerreichbare Lader (P4H-LOADER-IMPORT), der die gespeicherten Spalten auf genau diese P4A-Felder abbildet.
		if (file !== 'src/purchase-intent.mjs' && file !== 'src/purchase-runtime-loader.mjs') assert.doesNotMatch(code, /commissionRatio|commissionDestination/, file);
		assert.doesNotMatch(code, /functionName:\s*'approve'/, file);
	}
});
