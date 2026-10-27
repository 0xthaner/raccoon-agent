/**
 * Uniswap v3 Ethereum im Dashboard (21.10.2026): GET /api/positions mit
 * Abschnitt uniswapV3 und POST /api/nexus/quote mit den Aktionen
 * uniswap-details / uniswap-quote. Nur lesend, nur informativ.
 *
 * Offline. Echte Handler, echte Sitzung (signiertes Cookie), echte Herkunfts-
 * und JSON-Pruefung, echter Dienst (uniswap-v3-service.mjs), echtes Nexus-72-
 * Modell und echter Quote-Parser. Ersetzt sind nur der Scan (aus den
 * Mitschnitten vom 21.10.2026: Positionen und Chainlink-Runden desselben
 * Blocks), die Rate-Limit-Speicher und Nexus (Mitschnitte; fuer Betraege ohne
 * Mitschnitt eine streng gebaute Quote, die denselben Parser bestehen muss).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

Object.assign(process.env, {
	DASHBOARD_SESSION_SECRET: 'uniswap-dashboard-secret-0123456789abcdef',
	APP_BASE_URL: 'https://coverraccoon.com',
	SUPABASE_URL: process.env.SUPABASE_URL || 'https://supabase.test.invalid',
	SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY || 'test-secret-key'
});
delete process.env.ALCHEMY_API_KEY;

const U = await import('../src/positions/uniswap-v3-ethereum.mjs');
const S = await import('../src/positions/uniswap-v3-service.mjs');
const API = await import('../src/nexus-read-api.mjs');
const { createNexusQuoteHandler } = await import('../api/nexus/quote.mjs');
const { createPositionsHandler } = await import('../api/positions.mjs');
const { createDashboardSession, SESSION_COOKIE } = await import('../src/dashboard-auth.mjs');
const { WALLET_METHODEN_ALLE } = await import('../web/src/wallet-methods.js');
const { createRecordingDom } = await import('../test-support/recording-dom.mjs');
const { loadPage } = await import('../test-support/browser-world.mjs');

const json = (rel) => JSON.parse(readFileSync(new URL(`./fixtures/${rel}`, import.meta.url), 'utf8'));
const LIVE = json('uniswap/positions-20261021.json');
const PRICES = json('prices/chainlink-ethereum-20261021.json');
const NX = Object.fromEntries(readdirSync(new URL('./fixtures/uniswap/nexus-72/', import.meta.url)).map((f) => [f.replace('.json', ''), json(`uniswap/nexus-72/${f}`)]));
const D = U.UNISWAP_V3_ETHEREUM;
const B = (x) => BigInt(x);
const lc = (a) => a.toLowerCase();
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const BLOCK = Object.freeze({ number: B(LIVE.block.number), timestamp: B(LIVE.block.timestamp) });
const NOW = Number(LIVE.block.timestamp) * 1_000 + 20_000;
const byId = Object.fromEntries(LIVE.vectors.map((v) => [v.tokenId, v]));
const IN = '1387464', IN2 = '1387513', ABOVE_USDC = '1380247', ZERO_LIQ = '1387153', BELOW_PAXG = '1383966';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const DAY = 86_400;

/* ---------------------------------------------------------- Scan-Nachbau -- */

function rawFor(id, owner = WALLET) {
	const v = byId[id];
	const p = v.position;
	return {
		tokenId: B(id), owner, positionManager: D.positionManager,
		position: { token0: p.token0, token1: p.token1, fee: p.fee, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: B(p.liquidity), feeGrowthInside0LastX128: B(p.feeGrowthInside0LastX128), feeGrowthInside1LastX128: B(p.feeGrowthInside1LastX128), tokensOwed0: B(p.tokensOwed0), tokensOwed1: B(p.tokensOwed1) },
		factoryTickSpacing: D.feeTickSpacing[p.fee], registeredPool: v.pool,
		pool: { address: v.pool, factory: D.factory, token0: p.token0, token1: p.token1, fee: p.fee, tickSpacing: D.feeTickSpacing[p.fee], sqrtPriceX96: B(v.slot0.sqrtPriceX96), tick: v.slot0.tick, feeGrowthGlobal0X128: B(v.feeGrowthGlobal0X128), feeGrowthGlobal1X128: B(v.feeGrowthGlobal1X128) },
		tickLowerInfo: { feeGrowthOutside0X128: B(v.tickLowerInfo.feeGrowthOutside0X128), feeGrowthOutside1X128: B(v.tickLowerInfo.feeGrowthOutside1X128), initialized: v.tickLowerInfo.initialized },
		tickUpperInfo: { feeGrowthOutside0X128: B(v.tickUpperInfo.feeGrowthOutside0X128), feeGrowthOutside1X128: B(v.tickUpperInfo.feeGrowthOutside1X128), initialized: v.tickUpperInfo.initialized },
		token0Meta: { decimals: v.token0.decimals, symbol: v.token0.symbol }, token1Meta: { decimals: v.token1.decimals, symbol: v.token1.symbol }
	};
}
function readings(patch = {}) {
	return Object.fromEntries(Object.entries(PRICES.feeds).map(([key, f]) => {
		const r = f.onchain.latestRoundData;
		return [key, { blockNumber: BLOCK.number, ok: true, description: f.onchain.description, decimals: f.onchain.decimals, roundId: B(r.roundId), answer: B(r.answer), startedAt: B(r.startedAt), updatedAt: B(r.updatedAt), answeredInRound: B(r.answeredInRound), ...(patch[key] ?? {}) }];
	}));
}
const answer = (key) => B(PRICES.feeds[key].onchain.latestRoundData.answer);
const COVER_TOKENS = Object.values(U.COVER_ASSET_REFERENCES).map((r) => r.token);

/** Ein Scan wie readUniswapV3Positions ihn liefert - aus den Mitschnitten, ein Block. */
function scanOf(entries, { wallet = WALLET, patch = {}, unpriced = [] } = {}) {
	const positions = entries.map((entry) => {
		const { id, owner = wallet, raw = {} } = typeof entry === 'string' ? { id: entry } : entry;
		return U.validatePosition({ ...rawFor(id, owner), ...raw }, { wallet, chainId: 1, block: BLOCK });
	});
	const tokens = [...new Map(positions.filter((p) => p.status === 'VALID').flatMap((p) => [p.token0, p.token1]).map((t) => [lc(t.address), { address: t.address, decimals: t.decimals }])).values()];
	const fullBook = U.buildPriceBook({ tokens: [...tokens, ...COVER_TOKENS.filter((t) => !tokens.some((x) => lc(x.address) === lc(t))).map((address) => ({ address }))], block: BLOCK, readings: readings(patch) });
	// `unpriced`: Token ohne Preis-Referenz (wie ein nicht gelisteter Token) - der Eintrag fehlt im Preisbuch.
	const priceBook = Object.freeze(Object.fromEntries(Object.entries(fullBook).filter(([address]) => !unpriced.map(lc).includes(address))));
	const exposures = positions.map((position) => U.computeUniswapLpExposure(position, priceBook));
	return Object.freeze({ status: 'OK', wallet: lc(wallet), chainId: 1, blockNumber: String(BLOCK.number), blockTimestamp: String(BLOCK.timestamp), detectedAt: new Date(NOW).toISOString(), positions, priceBook, exposures, aggregate: U.aggregateUniswapLpExposure(exposures) });
}

/* -------------------------------------------------------- Nexus-Nachbau -- */

const RECORDED = Object.fromEntries(Object.entries(NX).filter(([k]) => k.startsWith('quote-72-')).map(([k, v]) => { const [, , a, amount] = k.split('-'); return [`${a.slice(1)}:${amount}`, v]; }));
const ASSET = { 0: { id: 0, symbol: 'ETH', decimals: 18 }, 6: { id: 6, symbol: 'USDC', decimals: 6 }, 7: { id: 7, symbol: 'cbBTC', decimals: 8 } };

/** Eine Quote, wie Nexus sie fuer einen Betrag ohne Mitschnitt baut: ein Pool (22), 0,50 % p. a., Praemie exakt. */
function builtQuote(assetId, amount, period) {
	const total = B(amount);
	const premium = (total * 50n * B(period)) / (10_000n * 365n);
	return { quote: { totalCoverAmountInAsset: total.toString(), annualPrice: '50', premiumInNXM: '1000', premiumInAsset: (premium > 0n ? premium : 1n).toString(), refundInNXM: '0', refundInAsset: '0', premiumInNXMWithRefund: '1000', premiumInAssetWithRefund: (premium > 0n ? premium : 1n).toString(), poolAllocationRequests: [{ poolId: '22', coverAmountInAsset: total.toString() }], asset: ASSET[assetId] } };
}

function nexus({ override = () => undefined } = {}) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		assert.equal(init.method, 'GET', 'Nexus is only read');
		assert.ok(url.startsWith('https://api.nexusmutual.io/'), url);
		const path = url.replace('https://api.nexusmutual.io', '');
		calls.push(path);
		const o = override(path);
		let body;
		let status = 200;
		let raw = null;
		if (o && o.status) { status = o.status; raw = o.text ?? null; } else if (o !== undefined) body = o;
		else if (path === '/v2/products/72') body = NX['product-72'];
		else if (path === '/v2/product-types/0') body = NX['product-type-0'];
		else if (path === '/v2/capacity/72') body = NX['capacity-72'];
		else if (path.startsWith('/v2/quote?')) {
			const q = new URLSearchParams(path.split('?')[1]);
			assert.equal(q.get('productId'), '72', 'a Uniswap quote is always product 72');
			body = RECORDED[`${q.get('coverAsset')}:${q.get('amount')}`] ?? builtQuote(Number(q.get('coverAsset')), q.get('amount'), q.get('period'));
		} else status = 404;
		const text = raw ?? JSON.stringify(body ?? {});
		return { ok: status === 200, status, url: '', redirected: false, headers: { get: (h) => (h === 'content-type' ? 'application/json' : String(text.length)) }, text: async () => text };
	};
	return { fetchImpl, calls, quoteCalls: () => calls.filter((c) => c.startsWith('/v2/quote')) };
}

/* ------------------------------------------------------------ Handler -- */

const cookie = (wallet = WALLET) => `${SESSION_COOKIE}=${encodeURIComponent(createDashboardSession(wallet))}`;
function res() {
	return { statusCode: null, body: null, headers: {}, headersSent: false, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
}
function req(body, { method = 'POST', headers = {}, url = '/api/nexus/quote', wallet = WALLET } = {}) {
	return { method, url, body, headers: { 'content-type': 'application/json', origin: 'https://coverraccoon.com', 'sec-fetch-site': 'same-origin', ...(wallet ? { cookie: cookie(wallet) } : {}), ...headers } };
}

/** Quote-Handler mit Scan je Wallet (`scans`), Nexus-Nachbau und aufgezeichneten Budgets. */
function quoteSetup({ scans = { [WALLET]: scanOf([IN, IN2, ZERO_LIQ]) }, override, revoked = false, now = NOW, modelAt = (at) => at, limits = {}, model = null, quoteRun = null, enabled = true } = {}) {
	API._test.reset();
	S._test.reset();
	const nx = nexus({ override });
	const seen = { limits: [], scansFor: [], positionsFor: [] };
	const handler = createNexusQuoteHandler({
		getPositions: async (wallet) => { seen.positionsFor.push(wallet); return { ok: true, wallet, positions: [] }; },
		isRevoked: async () => revoked,
		readModel: async () => { throw new Error('the Aave read model is never used for Uniswap'); },
		quote: async () => { throw new Error('the Aave quote is never used for Uniswap'); },
		getUniswap: async (wallet) => { seen.scansFor.push(wallet); const scan = scans[wallet] ?? scans[lc(wallet)]; if (scan instanceof Error) throw scan; return scan ?? scanOf([], { wallet }); },
		uniswapModel: model ?? ((found, options) => S.uniswapModelFor(found, { ...options, now: modelAt(options.now), fetchImpl: nx.fetchImpl })),
		uniswapQuote: quoteRun ?? ((prepared, model, priceBook, found, options) => S.runUniswapQuote(prepared, model, priceBook, found, { ...options, fetchImpl: nx.fetchImpl })),
		// Seit 27.10.2026 standardmaessig aus (UNISWAP_V3_AKTIV); diese Tests pruefen den eingeschalteten Pfad.
		...(enabled === 'default' ? {} : { uniswapEnabled: enabled }),
		rateLimit: async (_req, response, scope, max, window) => { seen.limits.push(`${scope}:${max}/${window}`); if (limits[scope] === false) { response.status(429).json({ ok: false }); return false; } return true; },
		rateLimitFor: async (response, scope, value, max, window) => { seen.limits.push(`${scope}:${value}:${max}/${window}`); if (limits[scope] === false) { response.status(429).json({ ok: false }); return false; } return true; },
		now: () => now
	});
	return { nx, seen, call: async (body, options) => { const r = res(); await handler(req(body, options), r); return r; } };
}
const quoteBody = (extra = {}) => ({ action: 'uniswap-quote', tokenId: IN, coverAsset: 'USDC', periodDays: 30, ...extra });

function positionsSetup({ aave = { ok: true, wallet: WALLET, complete: true, positions: [], checkedDeployments: [{ deploymentKey: 'aave-v3-ethereum-core', label: 'Core', status: 'OK' }] }, uniswap = () => scanOf([IN]), revoked = false, enabled = true } = {}) {
	const seen = { uniswapFor: [], aaveFor: [] };
	const handler = createPositionsHandler({
		getPositions: async (wallet) => { seen.aaveFor.push(wallet); return { ...aave, wallet }; },
		getUniswap: async (wallet) => { seen.uniswapFor.push(wallet); const value = uniswap(wallet); if (value instanceof Error) throw value; return value; },
		...(enabled === 'default' ? {} : { uniswapEnabled: enabled }),
		isRevoked: async () => revoked,
		rateLimit: async () => true,
		rateLimitFor: async () => true
	});
	return { seen, call: async ({ wallet = WALLET, url = '/api/positions' } = {}) => { const r = res(); await handler({ method: 'GET', url, headers: wallet ? { cookie: cookie(wallet) } : {} }, r); return r; } };
}

/** Erwartete Obergrenze, unabhaengig vom Code gerechnet: floor(USD8 x 10^d / Chainlink-Antwort), min Kapazitaet. */
function expectedMax(id, assetId, feed) {
	const exposure = scanOf([id]).exposures[0];
	const decimals = ASSET[assetId].decimals;
	const fromExposure = (B(exposure.suggestedExposureUsd8) * 10n ** B(decimals)) / answer(feed);
	const capacity = B(NX['capacity-72'].availableCapacity.find((a) => a.assetId === assetId).amount);
	return fromExposure < capacity ? fromExposure : capacity;
}
const units = (raw, decimals) => { const s = raw.toString().padStart(decimals + 1, '0'); const whole = s.slice(0, -decimals) || '0'; const frac = s.slice(-decimals).replace(/0+$/, ''); return decimals === 0 ? s : frac ? `${whole}.${frac}` : whole; };

/* ===================================== Schalter UNISWAP_V3_AKTIV (27.10.2026) == */

test('UNI-OFF the switch ships off: src/pause.mjs sets UNISWAP_V3_AKTIV = false', async () => {
	const { UNISWAP_V3_AKTIV } = await import('../src/pause.mjs');
	assert.equal(UNISWAP_V3_AKTIV, false);
});

test('UNI-OFF by default GET /api/positions never scans Uniswap and answers like before the Uniswap release', async () => {
	const p = positionsSetup({ enabled: 'default' });
	const r = await p.call();
	assert.equal(r.statusCode, 200);
	assert.deepEqual(p.seen.uniswapFor, [], 'no Uniswap scan, so no Uniswap RPC call');
	assert.equal(p.seen.aaveFor.length, 1, 'Aave is read as before');
	assert.equal('uniswapV3' in r.body, false);
	assert.deepEqual(r.body.protocols, [{ protocol: 'Aave v3', chainId: 1, status: 'OK' }]);
	assert.deepEqual(r.body.checkedDeployments, [{ deploymentKey: 'aave-v3-ethereum-core', label: 'Core', status: 'OK' }]);
});

test('UNI-OFF by default uniswap-* actions are INVALID_BODY before session, scan, Nexus and wallet or quote budgets', async () => {
	for (const body of [quoteBody(), { action: 'uniswap-details', tokenId: IN }]) {
		const q = quoteSetup({ enabled: 'default' });
		const r = await q.call(body);
		assert.deepEqual([r.statusCode, r.body.code], [400, 'INVALID_BODY']);
		assert.deepEqual([q.seen.scansFor, q.seen.positionsFor, q.nx.calls], [[], [], []]);
		assert.deepEqual(q.seen.limits, ['nexus-cover-ip:30/600'], 'only the IP budget every request pays');
		const anonymous = await quoteSetup({ enabled: 'default' }).call(body, { wallet: null });
		assert.deepEqual([anonymous.statusCode, anonymous.body.code], [400, 'INVALID_BODY'], 'same answer with or without a session');
	}
});

/* ========================================================= Autorisierung == */

test('UNI-AUTH without a session neither positions nor Uniswap actions answer, and nothing is scanned', async () => {
	const p = positionsSetup();
	const r = await p.call({ wallet: null });
	assert.deepEqual([r.statusCode, r.body.code], [401, 'NO_SESSION']);
	const q = quoteSetup();
	for (const body of [quoteBody(), { action: 'uniswap-details', tokenId: IN }]) {
		const x = await q.call(body, { wallet: null });
		assert.deepEqual([x.statusCode, x.body.code], [401, 'NO_SESSION']);
	}
	assert.deepEqual([p.seen.uniswapFor, q.seen.scansFor, q.nx.calls], [[], [], []]);
});

test('UNI-AUTH a revoked session is refused before any scan or Nexus read', async () => {
	const p = positionsSetup({ revoked: true });
	assert.deepEqual([(await p.call()).statusCode, p.seen.uniswapFor.length], [401, 0]);
	const q = quoteSetup({ revoked: true });
	const r = await q.call(quoteBody());
	assert.deepEqual([r.statusCode, r.body.code, q.seen.scansFor.length, q.nx.calls.length], [401, 'SESSION_REVOKED', 0, 0]);
});

test('UNI-AUTH the scanned wallet is always the session wallet; a client wallet, owner or address is refused', async () => {
	const p = positionsSetup();
	assert.equal((await p.call()).statusCode, 200);
	assert.deepEqual(p.seen.uniswapFor, [lc(WALLET)]);
	for (const url of ['/api/positions?wallet=0x2222222222222222222222222222222222222222', '/api/positions?owner=0x22', '/api/positions?tokenId=1']) {
		const r = await p.call({ url });
		assert.equal(r.statusCode, 400, url);
	}
	assert.deepEqual(p.seen.uniswapFor, [lc(WALLET)], 'no extra scan for a query');
	const q = quoteSetup({ scans: { [WALLET]: scanOf([IN]), [OTHER]: scanOf([IN], { wallet: OTHER }) } });
	for (const extra of [{ wallet: OTHER }, { owner: OTHER }, { address: OTHER }, { pool: byId[IN].pool }, { exposure: '1' }, { premium: '0' }, { capacity: '1' }, { chainId: 1 }]) {
		const r = await q.call(quoteBody(extra));
		assert.deepEqual([r.statusCode, r.body.code], [400, 'INVALID_BODY'], JSON.stringify(extra));
	}
	assert.deepEqual([q.seen.scansFor, q.nx.calls], [[], []], 'refused before the session wallet is even scanned');
	await q.call(quoteBody(), { wallet: OTHER });
	assert.deepEqual(q.seen.scansFor, [lc(OTHER)], 'a session for wallet B scans wallet B, never A');
});

test('UNI-AUTH a transferred NFT (owner is another wallet) is neither shown nor quotable', async () => {
	const scan = scanOf([IN, { id: IN2, owner: OTHER }]);
	const p = positionsSetup({ uniswap: () => scan });
	const r = await p.call();
	assert.deepEqual(r.body.uniswapV3.positions.map((x) => x.tokenId), [IN]);
	assert.deepEqual(r.body.uniswapV3.unsupported, []);
	const q = quoteSetup({ scans: { [WALLET]: scan } });
	for (const tokenId of [IN2, '999999999']) {
		const x = await q.call(quoteBody({ tokenId }));
		assert.deepEqual([x.statusCode, x.body.code], [404, 'POSITION_NOT_FOUND'], tokenId);
	}
	assert.equal(q.nx.calls.length, 0);
});

/* ============================================================ Positionen == */

test('UNI-POS GET /api/positions keeps the Aave answer and adds a sanitized Uniswap v3 section per NFT', async () => {
	const aave = { ok: true, wallet: WALLET, complete: true, positions: [{ deploymentKey: 'aave-v3-ethereum-core', label: 'Core' }], checkedDeployments: [{ deploymentKey: 'aave-v3-ethereum-core', label: 'Core', status: 'OK' }], fetchedAt: 'x', blockNumber: '1' };
	const p = positionsSetup({ aave, uniswap: () => scanOf([IN, IN2, ABOVE_USDC]) });
	const r = await p.call();
	assert.equal(r.statusCode, 200);
	for (const key of Object.keys(aave)) assert.deepEqual(r.body[key], key === 'wallet' ? WALLET : aave[key], `Aave field ${key} unchanged`);
	assert.deepEqual(r.body.protocols, [{ protocol: 'Aave v3', chainId: 1, status: 'OK' }, { protocol: 'Uniswap v3', chainId: 1, status: 'OK' }]);
	const u = r.body.uniswapV3;
	assert.deepEqual([u.protocol, u.chainId, u.status, u.positions.length], ['Uniswap v3', 1, 'OK', 3], 'multiple NFTs, each its own entry');
	const x = u.positions.find((entry) => entry.tokenId === IN);
	const exposure = scanOf([IN]).exposures[0];
	assert.deepEqual(Object.keys(x).sort(), ['chainId', 'coverOptions', 'feeTier', 'feeTierPercent', 'fees', 'liquidityState', 'nexus', 'pool', 'pricingStatus', 'principalExposureUsd', 'protocol', 'purchaseAvailable', 'rangeState', 'suggestedExposureUsd', 'token0', 'token1', 'tokenId'].sort());
	assert.deepEqual([x.protocol, x.chainId, x.feeTier, x.feeTierPercent, x.rangeState, x.liquidityState, x.pricingStatus, x.coverOptions, x.purchaseAvailable], ['Uniswap v3', 1, 3000, '0.30', 'IN_RANGE', 'ACTIVE', 'PRICED', 'AVAILABLE', false]);
	assert.deepEqual(x.token0, { address: exposure.token0.address, symbol: 'WETH', decimals: 18, amount: exposure.amount0 });
	assert.deepEqual(x.fees, { token0Amount: exposure.fees0, token1Amount: exposure.fees1, includedInSuggestedExposure: false });
	assert.deepEqual([x.principalExposureUsd, x.suggestedExposureUsd], [exposure.principalExposureUsd, exposure.principalExposureUsd], 'suggested = principal, fees excluded');
	assert.deepEqual(x.nexus, { productId: 72, productName: 'Uniswap v3', productTypeName: 'Single Protocol Cover', mapping: 'MATCHED' });
	// nichts Rohes: keine Gebuehren-Wachstumswerte, Ticks, sqrtPrice, Preisquellen, Bytecode, RPC
	const text = JSON.stringify(r.body);
	assert.doesNotMatch(text, /feeGrowth|sqrtPrice|tickLower|tickUpper|currentTick|liquidity"|priceSources|priceUsd8|feeds|sourceAddress|bytecode|codeHash|alchemy|publicnode|rpc|missingPrices|"principal"|uncollectedFees/i);
	assert.equal(u.suggestedExposureUsd, scanOf([IN, IN2, ABOVE_USDC]).aggregate.suggestedExposureUsd);
});

test('UNI-POS zero liquidity, unsupported token price, stale price, fake pool, wrong chain and an empty wallet are explicit states', async () => {
	const call = async (uniswap) => (await positionsSetup({ uniswap }).call()).body.uniswapV3;
	const zero = await call(() => scanOf([ZERO_LIQ]));
	assert.deepEqual([zero.status, zero.positions[0].liquidityState, zero.positions[0].coverOptions], ['OK', 'ZERO_LIQUIDITY', 'ZERO_LIQUIDITY']);
	const kpd = await call(() => scanOf([IN], { unpriced: [USDT] }));
	assert.deepEqual([kpd.status, kpd.reason, kpd.positions[0].pricingStatus, kpd.positions[0].coverOptions, kpd.positions[0].suggestedExposureUsd, kpd.suggestedExposureUsd], ['INCOMPLETE', 'PRICING_INCOMPLETE', 'UNSUPPORTED_TOKEN_PRICE', 'UNSUPPORTED_TOKEN_PRICE', null, null]);
	const stalePaxg = await call(() => scanOf([BELOW_PAXG], { patch: { 'paxg-usd': { updatedAt: BLOCK.timestamp - 10n * B(DAY) } } }));
	assert.deepEqual([stalePaxg.status, stalePaxg.positions[0].pricingStatus, stalePaxg.positions[0].coverOptions], ['INCOMPLETE', 'STALE_PRICE', 'STALE_PRICE']);
	const fake = await call(() => scanOf([{ id: IN, raw: { registeredPool: byId[ABOVE_USDC].pool } }]));
	assert.deepEqual([fake.positions, fake.unsupported], [[], [{ tokenId: IN, reason: 'MAPPING_AMBIGUOUS' }]], 'a non-canonical pool is never a position, never product 72');
	// falsche Kette: der echte Dienst mit einem Client, der eine andere Chain meldet
	S._test.reset();
	const polygon = { getChainId: async () => 137, getBlock: async () => { throw new Error('not reached'); }, getCode: async () => '0x', multicall: async () => [] };
	const wrong = await call(() => S.getUniswapScan(WALLET, { client: polygon, now: () => NOW }));
	assert.deepEqual([wrong.status, wrong.reason, wrong.positions], ['UNAVAILABLE', 'SCAN_INCOMPLETE', []]);
	const empty = await call(() => scanOf([]));
	assert.deepEqual([empty.status, empty.positions, empty.unsupported], ['OK', [], []]);
	// ein Ausfall des Uniswap-Scans laesst die Aave-Antwort stehen
	const failing = positionsSetup({ uniswap: () => new Error('rpc down') });
	const r = await failing.call();
	assert.deepEqual([r.statusCode, r.body.ok, r.body.uniswapV3.status, r.body.protocols[1].status], [200, true, 'UNAVAILABLE', 'UNAVAILABLE']);
	assert.doesNotMatch(JSON.stringify(r.body), /rpc down/);
});

test('UNI-POS the scan cache is per wallet and short-lived; without an RPC key nothing is read', async () => {
	S._test.reset();
	let reads = 0;
	const client = { getChainId: async () => { reads += 1; return 137; }, getBlock: async () => ({}), getCode: async () => '0x', multicall: async () => [] };
	let clock = NOW;
	const a = await S.getUniswapScan(WALLET, { client, now: () => clock });
	await S.getUniswapScan(WALLET.toUpperCase().replace('0X', '0x'), { client, now: () => clock });
	assert.equal(reads, 1, 'same wallet (any case) within the TTL: one read');
	const b = await S.getUniswapScan(OTHER, { client, now: () => clock });
	assert.equal(reads, 2, 'another wallet never shares the entry');
	assert.deepEqual([a.wallet, b.wallet], [lc(WALLET), lc(OTHER)]);
	clock += S.SCAN_FAILURE_TTL_MS + 1;
	await S.getUniswapScan(WALLET, { client, now: () => clock });
	assert.equal(reads, 3, 'a failed scan is kept for at most 15 s');
	assert.ok(S.SCAN_TTL_MS <= 30_000);
	S._test.reset();
	const none = await S.getUniswapScan(WALLET, { now: () => NOW });
	assert.deepEqual([none.status, none.reason], ['UNAVAILABLE', 'RPC_NOT_CONFIGURED']);
	await assert.rejects(S.getUniswapScan('not-a-wallet'), TypeError);
	let admitted = 0;
	S._test.reset();
	await assert.rejects(S.getUniswapScan(WALLET, { client, now: () => NOW, admit: async () => { admitted += 1; return false; } }), (error) => error.constructor.name === 'LookupNotAdmittedError');
	assert.equal(admitted, 1);
});

/* ================================================================= Quote == */

test('UNI-QUOTE ETH, USDC and cbBTC: product 72, server-derived amount = min(exposure via Chainlink, capacity), informational only', async () => {
	for (const [coverAsset, assetId, feed] of [['ETH', 0, 'eth-usd'], ['USDC', 6, 'usdc-usd'], ['cbBTC', 7, 'cbbtc-usd']]) {
		const { call, nx, seen } = quoteSetup();
		const r = await call(quoteBody({ coverAsset, periodDays: 90 }));
		assert.equal(r.statusCode, 200, `${coverAsset}: ${JSON.stringify(r.body)}`);
		const q = r.body.quote;
		const max = expectedMax(IN, assetId, feed);
		assert.equal(q.coverAmount, units(max, ASSET[assetId].decimals), `${coverAsset}: exactly the Chainlink bound, fees excluded, no pool spot price`);
		assert.deepEqual([q.provider, q.productName, q.productTypeName, q.coverAsset, q.periodDays, q.informationalOnly, q.purchaseAvailable, q.freshness], ['Nexus Mutual', 'Uniswap v3', 'Single Protocol Cover', coverAsset, 90, true, false, 'FRESH']);
		assert.deepEqual(q.readiness, { quoteDataReady: true, purchaseReady: false, blockers: ['NEXUS_TERMS_INTERPRETATION_UNCONFIRMED', 'NEXUS_PROOF_OF_LOSS_UNCONFIRMED', 'WALLET_EXECUTION_NOT_AVAILABLE'] });
		assert.deepEqual([q.quoteFetchedAt, q.quoteExpiresAt], [new Date(NOW).toISOString(), new Date(NOW + 60_000).toISOString()]);
		const [quoteCall] = nx.quoteCalls();
		const query = new URLSearchParams(quoteCall.split('?')[1]);
		assert.deepEqual([query.get('productId'), query.get('coverAsset'), query.get('amount'), query.get('period')], ['72', String(assetId), max.toString(), '90']);
		assert.doesNotMatch(JSON.stringify(r.body), /productId|"pool"|poolId|feGrowth|premiumInNXM|allocation/i, 'no contract or pool data in the answer');
		assert.deepEqual(seen.limits.filter((l) => !l.startsWith('nexus-cover-ip')).map((l) => l.split(':')[0]), ['nexus-cover-wallet', 'nexus-read-global', 'nexus-quote-wallet', 'nexus-quote-global']);
	}
	// Der Nenner ist der Chainlink-Preis desselben Blocks, nie der Pool-Spotpreis: ein anderer
	// ETH/USD-Feedwert (Pool unveraendert) aendert die Obergrenze genau nach floor(USD8 x 10^18 / Feed).
	const moved = answer('eth-usd') * 11n / 10n;
	const scan = scanOf([IN], { patch: { 'eth-usd': { answer: moved } } });
	const { call } = quoteSetup({ scans: { [WALLET]: scan } });
	const r = await call(quoteBody({ coverAsset: 'ETH' }));
	assert.equal(r.statusCode, 200, JSON.stringify(r.body));
	assert.equal(r.body.quote.coverAmount, units((B(scan.exposures[0].suggestedExposureUsd8) * 10n ** 18n) / moved, 18));
	assert.equal(scan.exposures[0].feesIncluded, false);
});

test('UNI-QUOTE details show product, exposure, per-asset capacity and bound and the open blockers - without a quote call', async () => {
	const { call, nx } = quoteSetup();
	const r = await call({ action: 'uniswap-details', tokenId: IN });
	assert.equal(r.statusCode, 200, JSON.stringify(r.body));
	const d = r.body;
	assert.deepEqual([d.available, d.productId, d.productName, d.productTypeName, d.provider], [true, 72, 'Uniswap v3', 'Single Protocol Cover', 'Nexus Mutual']);
	assert.deepEqual(d.position, { protocol: 'Uniswap v3', network: 'Ethereum', chainId: 1, tokenId: IN, pair: 'WETH/USDT', feeTierPercent: '0.30' });
	assert.deepEqual(d.exposure, { calculationMethod: 'UNISWAP_V3_LP_EXPOSURE_V1', currency: 'USD', suggestedExposure: scanOf([IN]).exposures[0].suggestedExposureUsd, feesIncluded: false });
	assert.deepEqual(d.assets.map((a) => [a.symbol, a.selectable, a.maxAmount]), [['ETH', true, units(expectedMax(IN, 0, 'eth-usd'), 18)], ['USDC', true, units(expectedMax(IN, 6, 'usdc-usd'), 6)], ['cbBTC', true, units(expectedMax(IN, 7, 'cbbtc-usd'), 8)]]);
	assert.deepEqual(d.assets[1].conversion, { source: 'Chainlink', description: 'USDC / USD', priceUsd: units(answer('usdc-usd'), 8), updatedAt: d.assets[1].conversion.updatedAt }, 'USDC has its own feed, no assumed 1 USD');
	assert.deepEqual(d.periodDays, { min: 28, max: 365, presets: [30, 90, 180, 365] });
	assert.deepEqual(d.readiness.blockers, ['NEXUS_TERMS_INTERPRETATION_UNCONFIRMED', 'NEXUS_PROOF_OF_LOSS_UNCONFIRMED', 'WALLET_EXECUTION_NOT_AVAILABLE']);
	assert.equal(d.readiness.purchaseReady, false);
	assert.equal(d.wording.url, 'https://api.nexusmutual.io/ipfs/QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY');
	assert.equal(nx.quoteCalls().length, 0);
	assert.doesNotMatch(JSON.stringify(d), /0x5f4eC3Df|0x8fFfFfd4|0x2665701293|feeds|priceUsd8/i, 'no feed addresses or raw price structure');
});

test('UNI-QUOTE input bounds: asset, period 28..365, productId, amount above exposure or capacity, malformed body', async () => {
	const { call, nx } = quoteSetup();
	for (const [extra, status, code] of [
		[{ coverAsset: 'DAI' }, 422, 'ASSET_NOT_SUPPORTED'], [{ coverAsset: 'eth' }, 422, 'ASSET_NOT_SUPPORTED'], [{ coverAsset: 'NXM' }, 422, 'ASSET_NOT_SUPPORTED'],
		[{ periodDays: 27 }, 422, 'PERIOD_OUT_OF_RANGE'], [{ periodDays: 366 }, 422, 'PERIOD_OUT_OF_RANGE'], [{ periodDays: '30' }, 422, 'PERIOD_OUT_OF_RANGE'], [{ periodDays: 30.5 }, 422, 'PERIOD_OUT_OF_RANGE'],
		[{ productId: 72 }, 400, 'PRODUCT_ID_NOT_ACCEPTED'], [{ productId: 97 }, 400, 'PRODUCT_ID_NOT_ACCEPTED'], [{ product: 'Uniswap v3' }, 400, 'PRODUCT_ID_NOT_ACCEPTED'],
		[{ tokenId: '0' }, 400, 'INVALID_BODY'], [{ tokenId: 1387464 }, 400, 'INVALID_BODY'], [{ tokenId: '01' }, 400, 'INVALID_BODY'], [{ mode: 'AGGREGATE' }, 400, 'INVALID_BODY'],
		[{ amount: 1 }, 422, 'INVALID_AMOUNT']
	]) {
		const r = await call(quoteBody(extra));
		assert.deepEqual([r.statusCode, r.body.code], [status, code], JSON.stringify(extra));
	}
	const { coverAsset: _, periodDays: __, ...missing } = quoteBody();
	assert.equal((await call(missing)).body.code, 'INVALID_BODY');
	assert.equal((await call({ action: 'uniswap-buy', tokenId: IN })).body.code, 'INVALID_BODY');
	const above = units(expectedMax(IN, 6, 'usdc-usd') + 1n, 6);
	const r = await call(quoteBody({ amount: above }));
	assert.deepEqual([r.statusCode, r.body.code, r.body.limitedBy], [422, 'AMOUNT_ABOVE_EXPOSURE', 'EXPOSURE'], 'one unit above the exposure is refused');
	assert.equal((await call(quoteBody({ amount: '0' }))).body.code, 'AMOUNT_OUT_OF_RANGE');
	assert.equal((await call(quoteBody({ amount: '1.0000001' }))).body.code, 'INVALID_AMOUNT');
	const exact = await call(quoteBody({ amount: units(expectedMax(IN, 6, 'usdc-usd'), 6) }));
	assert.equal(exact.statusCode, 200, 'exactly the bound is allowed');
	assert.equal(nx.quoteCalls().length, 1, 'only the valid request reached Nexus');
});

test('UNI-QUOTE zero liquidity, fake pool, incomplete or stale price, stale position and stale capacity never reach a quote', async () => {
	const cases = [
		[{ scans: { [WALLET]: scanOf([ZERO_LIQ]) } }, quoteBody({ tokenId: ZERO_LIQ }), 409, 'ZERO_LIQUIDITY', 0],
		[{ scans: { [WALLET]: scanOf([{ id: IN, raw: { registeredPool: byId[ABOVE_USDC].pool } }]) } }, quoteBody(), 409, 'MAPPING_AMBIGUOUS', 0],
		[{ scans: { [WALLET]: scanOf([IN], { unpriced: [USDT] }) } }, quoteBody(), 409, 'UNSUPPORTED_TOKEN_PRICE', 0],
		[{ scans: { [WALLET]: scanOf([IN], { patch: { 'eth-usd': { updatedAt: BLOCK.timestamp - 2n * B(DAY) } } }) } }, quoteBody(), 409, 'STALE_PRICE', 0],
		[{ now: NOW + 6 * 60_000 }, quoteBody(), 409, 'POSITION_STALE', 0],
		[{ modelAt: (at) => at - 61_000 }, quoteBody(), 503, 'CAPACITY_UNAVAILABLE', 3],
		[{ scans: { [WALLET]: { status: 'UNAVAILABLE', reason: 'WRONG_CHAIN', wallet: lc(WALLET) } } }, quoteBody(), 503, 'SCAN_INCOMPLETE', 0],
		[{ override: (path) => (path === '/v2/capacity/72' ? { status: 500, text: 'internal: capacity db down at 10.0.0.7' } : undefined) }, quoteBody(), 503, 'CAPACITY_UNAVAILABLE', 3]
	];
	for (const [options, body, status, code, nexusCalls] of cases) {
		const { call, nx } = quoteSetup(options);
		const r = await call(body);
		assert.deepEqual([r.statusCode, r.body.code], [status, code], `${code}: ${JSON.stringify(r.body)}`);
		assert.equal(nx.quoteCalls().length, 0, `${code}: no quote`);
		assert.equal(nx.calls.length, nexusCalls, `${code}: Nexus reads`);
		assert.deepEqual(Object.keys(r.body).sort(), ['code', 'error', 'ok'], `${code}: no upstream detail`);
	}
	// stale USDC price only for the cover asset: the position (WETH/USDT) keeps its value, USDC is not offered
	const usdcStale = quoteSetup({ scans: { [WALLET]: scanOf([IN], { patch: { 'usdc-usd': { updatedAt: BLOCK.timestamp - 3n * B(DAY) } } }) } });
	const r = await usdcStale.call(quoteBody());
	assert.deepEqual([r.statusCode, r.body.code, usdcStale.nx.quoteCalls().length], [409, 'PRICE_UNAVAILABLE', 0], 'no assumed USDC = 1 USD');
	const eth = await usdcStale.call(quoteBody({ coverAsset: 'ETH' }));
	assert.equal(eth.statusCode, 200);
});

test('UNI-QUOTE a tiny amount is QUOTE_AMOUNT_TOO_SMALL, never increased; malformed or failing Nexus answers never leak', async () => {
	const tiny = quoteSetup();
	const r = await tiny.call(quoteBody({ amount: '1' }));
	assert.deepEqual([r.statusCode, r.body.code], [422, 'QUOTE_AMOUNT_TOO_SMALL']);
	assert.equal(tiny.nx.quoteCalls().length, 1);
	assert.match(tiny.nx.quoteCalls()[0], /amount=1000000&/, 'asked exactly for 1 USDC; no automatic increase, no second request');
	for (const [override, label] of [
		[(path) => (path.startsWith('/v2/quote') ? { quote: { totalCoverAmountInAsset: 'x' } } : undefined), 'malformed'],
		[(path) => (path.startsWith('/v2/quote') ? { status: 500, text: '<html>stack trace at nexus-internal:1234 SECRET</html>' } : undefined), 'http 500'],
		[(path) => (path.startsWith('/v2/quote') ? { quote: { ...builtQuote(6, '5', 30).quote, totalCoverAmountInAsset: '999999999999999' } } : undefined), 'amount far above'],
		[(path) => (path.startsWith('/v2/quote') ? { quote: { ...builtQuote(6, '5', 30).quote, asset: { id: 0, symbol: 'ETH', decimals: 18 } } } : undefined), 'wrong asset']
	]) {
		const { call } = quoteSetup({ override });
		const x = await call(quoteBody());
		assert.deepEqual([x.statusCode, x.body.code], [503, 'QUOTE_UNAVAILABLE'], label);
		assert.deepEqual(Object.keys(x.body).sort(), ['code', 'error', 'ok'], label);
		assert.doesNotMatch(JSON.stringify(x.body), /stack|SECRET|nexus-internal|MALFORMED|MISMATCH|html/i, label);
	}
	// Ein unbekannter Code aus Modell oder Quote (z. B. ein roher Upstream-Grund) wird nie durchgereicht.
	const leak = { ok: false, code: 'RPC_TIMEOUT_AT_nexus-internal', error: 'SECRET upstream body', reason: 'stack', maxAmount: '1', limitedBy: 'SECRET' };
	for (const [options, label] of [[{ model: async () => leak }, 'model'], [{ quoteRun: async () => leak }, 'quote']]) {
		const { call } = quoteSetup(options);
		const x = await call(quoteBody());
		assert.deepEqual([x.statusCode, x.body.code], [503, 'QUOTE_UNAVAILABLE'], label);
		assert.deepEqual(Object.keys(x.body).sort(), ['code', 'error', 'ok'], label);
		assert.doesNotMatch(JSON.stringify(x.body), /stack|SECRET|nexus-internal|RPC_TIMEOUT/i, label);
	}
});

test('UNI-QUOTE quotes are reused for at most 60 s per wallet, NFT, asset, period and amount; a hit costs no quote budget', async () => {
	const scans = { [WALLET]: scanOf([IN]), [OTHER]: scanOf([IN], { wallet: OTHER }) };
	let clock = NOW;
	API._test.reset();
	S._test.reset();
	const nx = nexus();
	const limits = [];
	const handler = createNexusQuoteHandler({
		getPositions: async () => { throw new Error('unused'); }, isRevoked: async () => false, readModel: async () => { throw new Error('unused'); }, quote: async () => { throw new Error('unused'); },
		getUniswap: async (wallet) => scans[wallet], uniswapEnabled: true,
		uniswapModel: (found, options) => S.uniswapModelFor(found, { ...options, fetchImpl: nx.fetchImpl }),
		uniswapQuote: (prepared, model, priceBook, found, options) => S.runUniswapQuote(prepared, model, priceBook, found, { ...options, fetchImpl: nx.fetchImpl }),
		rateLimit: async () => true, rateLimitFor: async (_r, scope) => { limits.push(scope); return true; }, now: () => clock
	});
	const call = async (body, wallet = WALLET) => { const r = res(); await handler(req(body, { wallet }), r); return r; };
	const first = await call(quoteBody());
	const again = await call(quoteBody());
	assert.deepEqual(again.body.quote, first.body.quote);
	assert.equal(nx.quoteCalls().length, 1, 'the second identical request is served from the 60 s quote cache');
	assert.equal(limits.filter((s) => s === 'nexus-quote-wallet').length, 1, 'a cache hit pulls no quote budget');
	await call(quoteBody({ periodDays: 31 }));
	await call(quoteBody({ coverAsset: 'ETH' }));
	assert.equal(nx.quoteCalls().length, 3, 'period and asset are part of the key');
	await call(quoteBody(), OTHER);
	assert.equal(nx.quoteCalls().length, 4, 'another wallet never receives this wallet\'s quote');
	clock += 60_000;
	const later = await call(quoteBody());
	assert.equal(nx.quoteCalls().length, 5, 'after 60 s a new quote is requested');
	assert.equal(later.body.quote.quoteFetchedAt, new Date(clock).toISOString());
	assert.ok(S._test.quoteCacheSize() >= 1);
});

test('UNI-QUOTE rate limits: per IP and wallet before the scan, global read budget before Nexus, quote budgets only before a live quote', async () => {
	const blocked = quoteSetup({ limits: { 'nexus-quote-global': false } });
	const r = await blocked.call(quoteBody());
	assert.equal(r.statusCode, 429);
	assert.equal(blocked.nx.quoteCalls().length, 0, 'no quote without the global quote budget');
	const ip = quoteSetup({ limits: { 'nexus-cover-ip': false } });
	assert.equal((await ip.call(quoteBody())).statusCode, 429);
	assert.deepEqual([ip.seen.scansFor, ip.nx.calls], [[], []]);
	const read = quoteSetup({ limits: { 'nexus-read-global': false } });
	assert.equal((await read.call({ action: 'uniswap-details', tokenId: IN })).statusCode, 429);
	assert.equal(read.nx.calls.length, 0);
	// Werte der Budgets: dieselben wie fuer Aave (keine eigene, groessere Quelle)
	const ok = quoteSetup();
	await ok.call(quoteBody());
	assert.deepEqual(ok.seen.limits, ['nexus-cover-ip:30/600', `nexus-cover-wallet:${lc(WALLET)}:20/600`, 'nexus-read-global:all:400/600', `nexus-quote-wallet:${lc(WALLET)}:10/600`, 'nexus-quote-global:all:200/600']);
});

/* ==================================================================== UI == */

const SECTION = {
	protocol: 'Uniswap v3', chainId: 1, status: 'OK', blockNumber: '26240621', detectedAt: '2026-10-21T12:00:00.000Z', unsupported: [], suggestedExposureUsd: '12345.6789',
	positions: [
		{ protocol: 'Uniswap v3', chainId: 1, tokenId: IN, pool: byId[IN].pool, feeTier: 3000, feeTierPercent: '0.30', rangeState: 'IN_RANGE', liquidityState: 'ACTIVE',
			token0: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18, amount: '1.5' }, token1: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6, amount: '2500' },
			principalExposureUsd: '8500.25', suggestedExposureUsd: '8500.25', fees: { token0Amount: '0.01', token1Amount: '12', includedInSuggestedExposure: false }, pricingStatus: 'PRICED',
			nexus: { productId: 72, productName: 'Uniswap v3', productTypeName: 'Single Protocol Cover', mapping: 'MATCHED' }, coverOptions: 'AVAILABLE', purchaseAvailable: false },
		{ protocol: 'Uniswap v3', chainId: 1, tokenId: ZERO_LIQ, pool: byId[ZERO_LIQ].pool, feeTier: 500, feeTierPercent: '0.05', rangeState: 'ABOVE_RANGE', liquidityState: 'ZERO_LIQUIDITY',
			token0: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6, amount: '0' }, token1: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18, amount: '0' },
			principalExposureUsd: '0', suggestedExposureUsd: '0', fees: { token0Amount: '0', token1Amount: '0', includedInSuggestedExposure: false }, pricingStatus: 'NOT_REQUIRED',
			nexus: { productId: 72, productName: 'Uniswap v3', productTypeName: 'Single Protocol Cover', mapping: 'MATCHED' }, coverOptions: 'ZERO_LIQUIDITY', purchaseAvailable: false }
	]
};
const DETAILS = {
	ok: true, available: true, status: 'AVAILABLE', provider: 'Nexus Mutual', productId: 72, productName: 'Uniswap v3', productTypeName: 'Single Protocol Cover',
	position: { protocol: 'Uniswap v3', network: 'Ethereum', chainId: 1, tokenId: IN, pair: 'WETH/USDT', feeTierPercent: '0.30' },
	exposure: { calculationMethod: 'UNISWAP_V3_LP_EXPOSURE_V1', currency: 'USD', suggestedExposure: '8500.25', feesIncluded: false },
	assets: [
		{ symbol: 'ETH', decimals: 18, selectable: true, capacity: '3628.96', maxFromExposure: '2.1', maxAmount: '2.1', limitedBy: 'EXPOSURE', conversion: { source: 'Chainlink', description: 'ETH / USD', priceUsd: '4000', updatedAt: '2026-10-21T11:59:00.000Z' } },
		{ symbol: 'USDC', decimals: 6, selectable: true, capacity: '8922543.44', maxFromExposure: '8500.9', maxAmount: '8500.9', limitedBy: 'EXPOSURE', conversion: { source: 'Chainlink', description: 'USDC / USD', priceUsd: '0.9999', updatedAt: '2026-10-21T11:00:00.000Z' } },
		{ symbol: 'cbBTC', decimals: 8, selectable: false, reason: 'PRICE_UNAVAILABLE', capacity: '108.08' }
	],
	periodDays: { min: 28, max: 365, presets: [30, 90, 180, 365] }, proofOfLoss: { inputTypes: ['address'] }, gracePeriodDays: 35,
	wording: { cid: 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY', url: 'https://api.nexusmutual.io/ipfs/QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY' },
	quoteTtlSeconds: 60, readiness: { quoteDataReady: true, purchaseReady: false, blockers: ['NEXUS_TERMS_INTERPRETATION_UNCONFIRMED', 'NEXUS_PROOF_OF_LOSS_UNCONFIRMED', 'WALLET_EXECUTION_NOT_AVAILABLE'] }
};
const QUOTE = { provider: 'Nexus Mutual', productName: 'Uniswap v3', productTypeName: 'Single Protocol Cover', tokenId: IN, suggestedExposureUsd: '8500.25', coverAsset: 'ETH', coverAmount: '2.1', periodDays: 90, premium: '0.0026', premiumAsset: 'ETH', annualPricePercent: '0.50', capacity: '3628.96', quoteFetchedAt: new Date(NOW).toISOString(), quoteExpiresAt: new Date(NOW + 60_000).toISOString(), freshness: 'FRESH', informationalOnly: true, purchaseAvailable: false };
const FORBIDDEN_CTA = /buy|kaufen|approve|freigeben|purchase|abschlie|confirm|bestätig|sign|signier|insure|versicher/i;

async function mountSection(language = 'en', section = SECTION, { quote = QUOTE, details = DETAILS, quoteResult } = {}) {
	const dom = createRecordingDom();
	const walletCalls = [];
	globalThis.document = dom.document;
	globalThis.window = { ethereum: { request: async (args) => { walletCalls.push(args); return null; }, on() {}, removeListener() {} } };
	const cover = await import('../web/src/uniswap-cover.js');
	const posts = [];
	const panels = new Map();
	let lang = language;
	const post = async (body) => {
		posts.push(body);
		if (body.action === 'uniswap-details') return typeof details === 'function' ? details() : { status: 200, body: details };
		return quoteResult ? quoteResult() : { status: 200, body: { ok: true, status: 'QUOTED', quote } };
	};
	const root = dom.document.createElement('div');
	dom.document.body.appendChild(root);
	const render = () => { root.replaceChildren(); cover.renderUniswapSection(root, section, { language: lang, panelFor: (id) => panels.get(id) ?? null, openPanel: (id) => { const panel = cover.createUniswapPanel({ tokenId: id, post, language: lang, now: () => NOW, setTimer: () => {} }); panels.set(id, panel); render(); return panel.load(); } }); };
	render();
	const buttons = () => dom.all().filter((el) => el.tagName === 'BUTTON');
	const button = (label) => buttons().find((el) => el.textContent === label);
	const switchLanguage = (next) => { lang = next; for (const panel of panels.values()) panel.setLanguage(next); render(); };
	return { dom, root, posts, walletCalls, panels, buttons, button, switchLanguage, text: () => root.textContent };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('UNI-UI a separate Uniswap card per NFT: pair, fee tier, NFT number, LP amounts, suggested exposure, fees excluded, product 72 line, View cover options', async () => {
	const v = await mountSection('en');
	const all = v.text();
	for (const part of ['Uniswap v3 · Ethereum', 'Uniswap v3 · WETH/USDT', 'NFT #1387464', 'Fee tier', '0.30 %', 'In range', 'Current LP amounts', '1.5 WETH · 2,500 USDT', 'Suggested exposure', 'US$8,500.25',
		'Uncollected fees', '0.01 WETH · 12 USDT', 'Not included in suggested exposure', 'Nexus Mutual', 'Uniswap v3 – Single Protocol Cover', 'View cover options',
		'Impermanent loss and normal market losses are excluded', 'Quotes are for information only; cover cannot be taken out through CoverRaccoon yet.', 'Not a guaranteed claim amount.',
		'This position has no active liquidity, so no cover options are shown.', 'Source: Uniswap v3 · Ethereum (live), valued with Chainlink price feeds']) assert.ok(all.includes(part), `missing: ${part}`);
	assert.deepEqual(v.buttons().map((b) => b.textContent), ['View cover options'], 'one action, only for the active NFT');
	assert.equal(v.dom.log.violations.length, 0);
	const de = await mountSection('de');
	for (const part of ['Uniswap v3 · WETH/USDT', 'Gebührenstufe', 'Im Bereich', 'Aktuelle LP-Mengen', '1,5 WETH · 2.500 USDT', 'Vorgeschlagenes Engagement', 'Nicht eingesammelte Gebühren', 'Nicht im vorgeschlagenen Engagement enthalten', 'Cover-Optionen ansehen', 'Impermanent Loss und normale Marktverluste sind ausgenommen']) assert.ok(de.text().includes(part), `de missing: ${part}`);
});

test('UNI-UI quote view: product, provider, exposure, ETH/USDC selector, period, capacity, premium, annual price, freshness; only neutral actions; no wallet call', async () => {
	const v = await mountSection('en');
	await v.button('View cover options').click();
	await tick();
	assert.deepEqual(v.posts, [{ action: 'uniswap-details', tokenId: IN }]);
	const labels = v.buttons().map((b) => b.textContent);
	assert.deepEqual(labels, ['ETH', 'USDC', '30 days', '90 days', '180 days', '365 days', 'Get informational quote'], 'cbBTC without a current price is not offered');
	for (const label of labels) assert.doesNotMatch(label, FORBIDDEN_CTA, label);
	for (const part of ['Uniswap v3 – Single Protocol Cover', 'Suggested exposure (LP principal, fees excluded)', 'Available capacity', '3628.96 ETH', 'Amount for the quote', '2.1 ETH', 'Converted with Chainlink ETH / USD = 4000 USD', 'Cover through CoverRaccoon', 'Not available yet']) assert.ok(v.text().includes(part), `missing: ${part}`);
	v.button('USDC').click();
	assert.ok(v.text().includes('8500.9 USDC'));
	v.button('ETH').click();
	v.button('90 days').click();
	v.button('Get informational quote').click();
	await tick();
	assert.deepEqual(v.posts.at(-1), { action: 'uniswap-quote', tokenId: IN, coverAsset: 'ETH', periodDays: 90 }, 'no wallet, product, amount, pool or exposure from the browser');
	for (const part of ['Informational live quote from Nexus Mutual.', 'Informational quote', '2.1 ETH · 90 days', 'Premium', '0.0026 ETH', 'Annual price', '0.50 %', 'Valid until', 'For information only. Cover cannot be taken out through CoverRaccoon yet.']) assert.ok(v.text().includes(part), `missing: ${part}`);
	assert.deepEqual(v.walletCalls, [], 'never a wallet request');
	assert.equal(v.dom.log.violations.length, 0);
	assert.deepEqual([...new Set(v.dom.log.urls.map((u) => u.value))], ['https://api.nexusmutual.io/ipfs/QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY'], 'only the validated wording link');
});

test('UNI-UI a DE/EN switch updates the open card and quote without reload, without losing the quote and without a new request', async () => {
	const v = await mountSection('en');
	await v.button('View cover options').click();
	await tick();
	v.button('180 days').click();
	v.button('Get informational quote').click();
	await tick();
	const posts = v.posts.length;
	v.switchLanguage('de');
	const de = v.text();
	for (const part of ['Informative Live-Quote von Nexus Mutual.', 'Prämie', '0.0026 ETH', 'Jahrespreis', 'Informative Quote abrufen', 'Verfügbare Kapazität', 'Nicht eingesammelte Gebühren', 'Nur zur Information. Ein Abschluss über CoverRaccoon ist noch nicht möglich.']) assert.ok(de.includes(part), `de missing: ${part}`);
	assert.doesNotMatch(de, /Get informational quote|Uncollected fees|Premium\b/);
	assert.equal(v.posts.length, posts, 'no new Nexus request on a language switch');
	assert.equal([...v.panels.values()][0].state.period, 180, 'inputs survive');
	assert.ok([...v.panels.values()][0].state.quote, 'the quote survives');
	v.switchLanguage('en');
	assert.ok(v.text().includes('Informational live quote from Nexus Mutual.'));
	assert.equal(v.posts.length, posts);
});

test('UNI-UI explicit failure states: no positions, incomplete scan, unsupported or stale price, ambiguous mapping, capacity, too small, temporarily unavailable', async () => {
	const states = [
		[{ ...SECTION, positions: [] }, 'No Uniswap v3 LP positions found on Ethereum.'],
		[{ protocol: 'Uniswap v3', chainId: 1, status: 'UNAVAILABLE', reason: 'SCAN_INCOMPLETE', positions: [], unsupported: [] }, 'Uniswap v3 positions could not be read completely right now. Nothing is shown as zero.'],
		[null, 'Uniswap v3 positions could not be read completely right now.'],
		[{ ...SECTION, status: 'INCOMPLETE', reason: 'PRICING_INCOMPLETE', positions: [{ ...SECTION.positions[0], pricingStatus: 'UNSUPPORTED_TOKEN_PRICE', coverOptions: 'UNSUPPORTED_TOKEN_PRICE', suggestedExposureUsd: null }] }, 'A token in this position has no supported price feed, so there is no suggested exposure.'],
		[{ ...SECTION, status: 'INCOMPLETE', reason: 'PRICING_INCOMPLETE', positions: [{ ...SECTION.positions[0], pricingStatus: 'STALE_PRICE', coverOptions: 'STALE_PRICE', suggestedExposureUsd: null }] }, 'A price for this position is not current right now, so there is no suggested exposure.'],
		[{ ...SECTION, positions: [], unsupported: [{ tokenId: '42', reason: 'MAPPING_AMBIGUOUS' }] }, 'This position cannot be matched to a cover product unambiguously.']
	];
	for (const [section, message] of states) {
		const v = await mountSection('en', section);
		assert.ok(v.text().includes(message), message);
		assert.deepEqual(v.buttons().map((b) => b.textContent).filter((l) => l === 'View cover options'), [], `${message}: no cover options`);
	}
	for (const [code, status, message] of [
		['CAPACITY_UNAVAILABLE', 503, 'Nexus Mutual capacity is not available right now.'],
		['QUOTE_AMOUNT_TOO_SMALL', 422, 'A Nexus quote cannot currently be created for this very small amount.'],
		['QUOTE_UNAVAILABLE', 503, 'Nexus Mutual could not return a valid quote right now. Please try again shortly.'],
		['SOMETHING_NEW', 503, 'Nexus Mutual could not return a valid quote right now. Please try again shortly.'],
		[null, 429, 'Too many requests. Please try again in a few minutes.']
	]) {
		const v = await mountSection('en', SECTION, { quoteResult: () => ({ status, body: { ok: false, code, error: 'raw upstream text <b>x</b>' } }) });
		await v.button('View cover options').click();
		await tick();
		v.button('Get informational quote').click();
		await tick();
		assert.ok(v.text().includes(message), `${code}: ${message}`);
		assert.ok(!v.text().includes('raw upstream text'), 'the server error text is never shown');
	}
	const failedDetails = await mountSection('en', SECTION, { details: () => ({ status: 409, body: { ok: false, code: 'MAPPING_AMBIGUOUS' } }) });
	await failedDetails.button('View cover options').click();
	await tick();
	assert.ok(failedDetails.text().includes('This position cannot be matched to a cover product unambiguously.'));
	assert.deepEqual(failedDetails.buttons().map((b) => b.textContent), [], 'no quote action without details');
});

test('UNI-UI the real page: Aave and Uniswap render side by side; View cover options and a DE/EN switch never touch the wallet', async () => {
	const requests = [];
	const ethereum = { request: async (args) => { requests.push(args); return null; }, on() {}, removeListener() {} };
	const dashboard = { ok: true, wallet: WALLET, checkedAt: new Date().toISOString(), telegramLinked: true, agentSettings: { alertThresholds: [7], weeklySummary: false }, covers: [] };
	const aavePosition = { deploymentKey: 'aave-v3-ethereum-core', label: 'Core', nexus: { state: 'MATCHED', productId: 97, productName: 'Aave v3' }, supplied: [{ symbol: 'USDC', amount: '100', usdValue: '100', isCollateral: true }], borrowed: [], totals: { suppliedUsd: '100', debtUsd: '0', netUsd: '100', healthFactor: null } };
	const positions = { ok: true, wallet: WALLET, complete: true, fetchedAt: new Date().toISOString(), positions: [aavePosition], checkedDeployments: [{ deploymentKey: 'aave-v3-ethereum-core', label: 'Core', status: 'OK' }], protocols: [], uniswapV3: SECTION };
	const page = await loadPage('main.js', { storage: { raccoon_language: 'en' }, ethereum, routes: {
		'GET /api/config': { body: { ok: true, telegramUsername: 'Raccoon_Agent_Bot', reownProjectId: 'x' } },
		'GET /api/dashboard': { body: dashboard },
		'GET /api/positions': { body: positions },
		'GET /api/position-attributions': { body: { ok: true, attributions: [] } },
		'POST /api/nexus/quote': (_url, init) => (JSON.parse(init.body).action === 'uniswap-details' ? { body: DETAILS } : { body: { ok: true, status: 'QUOTED', quote: { ...QUOTE, quoteFetchedAt: new Date().toISOString(), quoteExpiresAt: new Date(Date.now() + 60_000).toISOString() } } })
	} });
	await page.settle();
	const list = () => page.dom.document.querySelector('#position-list').textContent;
	assert.match(list(), /Aave v3 · Core/);
	assert.match(list(), /Uniswap v3 · WETH\/USDT/);
	assert.match(list(), /NFT #1387464/);
	assert.match(page.dom.document.querySelector('#positions-checked').textContent, /Aave v3 and Uniswap v3/);
	const options = page.dom.all().find((el) => el.tagName === 'BUTTON' && el.textContent === 'View cover options');
	options.click();
	await page.settle();
	page.dom.all().find((el) => el.tagName === 'BUTTON' && el.textContent === 'Get informational quote').click();
	await page.settle();
	assert.match(list(), /Informational live quote from Nexus Mutual\./);
	const quotePosts = page.calls.filter((c) => c.key === 'POST /api/nexus/quote').map((c) => JSON.parse(c.body));
	assert.deepEqual(quotePosts, [{ action: 'uniswap-details', tokenId: IN }, { action: 'uniswap-quote', tokenId: IN, coverAsset: 'ETH', periodDays: 90 }]);
	const callsBefore = page.calls.length;
	page.dom.all().find((el) => el.dataset?.language === 'de').click();
	await page.settle();
	assert.match(list(), /Informative Live-Quote von Nexus Mutual\./, 'the open quote follows the language');
	assert.match(list(), /Cover-Optionen ansehen|Informative Quote abrufen/);
	assert.match(list(), /Aave v3 · Core/, 'Aave still renders after the switch');
	assert.equal(page.calls.length, callsBefore, 'no request on a language switch');
	assert.deepEqual(requests, [], 'no wallet popup');
	assert.deepEqual(page.code.eval, []);
	for (const el of page.dom.all().filter((node) => node.tagName === 'BUTTON')) assert.doesNotMatch(el.textContent, /\b(buy|kaufen|approve|freigeben|purchase|confirm transaction)\b/i, el.textContent);
});

test('UNI-OFF the real page without a uniswapV3 section shows Aave only: no Uniswap section, card, button or quote request', async () => {
	const ethereum = { request: async () => null, on() {}, removeListener() {} };
	const dashboard = { ok: true, wallet: WALLET, checkedAt: new Date().toISOString(), telegramLinked: true, agentSettings: { alertThresholds: [7], weeklySummary: false }, covers: [] };
	const aavePosition = { deploymentKey: 'aave-v3-ethereum-core', label: 'Core', nexus: { state: 'MATCHED', productId: 97, productName: 'Aave v3' }, supplied: [{ symbol: 'USDC', amount: '100', usdValue: '100', isCollateral: true }], borrowed: [], totals: { suppliedUsd: '100', debtUsd: '0', netUsd: '100', healthFactor: null } };
	// Genau die Antwort des ausgeschalteten Servers: kein uniswapV3, protocols nur Aave.
	const positions = { ok: true, wallet: WALLET, complete: true, fetchedAt: new Date().toISOString(), positions: [aavePosition], checkedDeployments: [{ deploymentKey: 'aave-v3-ethereum-core', label: 'Core', status: 'OK' }], protocols: [{ protocol: 'Aave v3', chainId: 1, status: 'OK' }] };
	for (const language of ['en', 'de']) {
		const page = await loadPage('main.js', { storage: { raccoon_language: language }, ethereum, routes: {
			'GET /api/config': { body: { ok: true, telegramUsername: 'Raccoon_Agent_Bot', reownProjectId: 'x' } },
			'GET /api/dashboard': { body: dashboard },
			'GET /api/positions': { body: positions },
			'GET /api/position-attributions': { body: { ok: true, attributions: [] } }
		} });
		await page.settle();
		const list = page.dom.document.querySelector('#position-list').textContent;
		assert.match(list, /Aave v3 · Core/);
		assert.doesNotMatch(list, /Uniswap/, `${language}: no Uniswap text, not even "scan incomplete"`);
		assert.equal(page.dom.all().filter((el) => /uniswap/.test(el.className ?? '')).length, 0, `${language}: no Uniswap element`);
		assert.equal(page.dom.document.querySelector('#positions-checked').textContent, language === 'en' ? 'Checked: Aave v3 on Ethereum' : 'Geprüft: Aave v3 auf Ethereum');
		assert.deepEqual(page.calls.filter((c) => c.key === 'POST /api/nexus/quote'), []);
	}
});

test('UNI-UI hostile details and quote values from the server render as text only; a hostile wording URL is never linked', async () => {
	const HOSTILE = ['<script>window.__xss=1</script>', '<img src=x onerror=window.__xss=1>', '"><svg onload=window.__xss=1>', 'javascript:window.__xss=1', 'data:text/html,<script>1</script>', '//evil.example/x', 'https://evil.example/ipfs/QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY'];
	for (const h of HOSTILE) {
		const details = { ...DETAILS, productName: h, productTypeName: h, exposure: { suggestedExposure: h }, gracePeriodDays: h, wording: { url: h },
			assets: [{ symbol: h, selectable: true, capacity: h, maxAmount: h, limitedBy: h, conversion: { description: h, priceUsd: h } }] };
		const quote = { ...QUOTE, coverAmount: h, coverAsset: h, premium: h, premiumAsset: h, annualPricePercent: h, capacity: h, quoteExpiresAt: h, quoteFetchedAt: h };
		const v = await mountSection('en', SECTION, { details, quote });
		await v.button('View cover options').click();
		await tick();
		v.button('Get informational quote').click();
		await tick();
		assert.deepEqual(v.dom.log.violations, [], h);
		for (const a of v.dom.log.attributes) assert.doesNotMatch(a.name, /^on/i, h);
		assert.deepEqual(v.dom.log.urls, [], `${h}: no link from an unvalidated URL`);
		assert.ok(v.text().includes(h), `${h}: rendered as text`);
		assert.deepEqual(v.walletCalls, []);
	}
});

/* ============================================================ Sicherheit == */

test('UNI-SEC the browser keeps its wallet allowlist; the Uniswap module asks for nothing and imports nothing', () => {
	assert.deepEqual([...WALLET_METHODEN_ALLE], ['eth_requestAccounts', 'eth_accounts', 'personal_sign', 'wallet_switchEthereumChain']);
	const code = readFileSync(new URL('../web/src/uniswap-cover.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	assert.doesNotMatch(code, /^\s*import\s|\bimport\(|\bfetch\b|XMLHttpRequest|window\.ethereum|\.request\(|eth_[a-z]|wallet_[a-z]|personal_sign|signTypedData|sendTransaction|writeContract|sendCalls|approve|permit|buyCover|innerHTML|insertAdjacentHTML|outerHTML/i);
	const main = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');
	assert.match(main, /^import \{ createUniswapPanel, renderUniswapSection \} from '\.\/uniswap-cover\.js';$/m);
	assert.match(main, /createUniswapPanel\(\{ tokenId, post: nexusQuoteApi\.post, language \}\)/, 'the panel only gets the existing same-origin quote route');
});

test('UNI-SEC the server service imports no purchase or wallet code and never builds a transaction', () => {
	const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
	for (const file of ['src/positions/uniswap-v3-service.mjs', 'api/nexus/quote.mjs', 'api/positions.mjs']) {
		const code = strip(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
		assert.doesNotMatch(code, /purchase-|createWalletClient|walletActions|sendTransaction|sendRawTransaction|writeContract|signTypedData|buyCover|approve|permit|sendCalls|privateKeyToAccount|mnemonic/i, file);
	}
	assert.equal(S.parseUniswapBody({ action: 'uniswap-quote', tokenId: IN, coverAsset: 'ETH', periodDays: 30, productId: 72 }).code, 'PRODUCT_ID_NOT_ACCEPTED');
});
