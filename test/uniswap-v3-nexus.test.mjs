/**
 * Uniswap v3 Ethereum -> Nexus Produkt 72: Kapazitaet und informative Quote (21.10.2026), inaktiv.
 *
 * Offline. Grundlage:
 *  - uniswap/nexus-72: Produkt 72, Produkttyp 0, Kapazitaet 72 und 14 Quotes
 *    (ETH, USDC, cbBTC; kleine bis normale Betraege, 30 Tage), am 21.10.2026
 *    per GET von api.nexusmutual.io gelesen, unveraendert gespeichert
 *  - uniswap/positions + prices/chainlink-ethereum: Live-Positionen und die
 *    Chainlink-Runden, die im Positionsblock galten (siehe uniswap-v3-ethereum.test)
 * Der Nexus-Server wird nachgebaut; jede Antwort laeuft durch die bestehenden,
 * strengen Parser von nexus-read-api.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { getAddress } from 'viem';

Object.assign(process.env, {
	SUPABASE_URL: process.env.SUPABASE_URL || 'https://supabase.test.invalid',
	SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY || 'test-secret-key'
});

const U = await import('../src/positions/uniswap-v3-ethereum.mjs');
const N = await import('../src/positions/uniswap-v3-nexus.mjs');
const P = await import('../src/positions/price-reference.mjs');
const API = await import('../src/nexus-read-api.mjs');
const { PINNED_PRODUCTS, NEXUS_ASSETS } = await import('../src/nexus-pinned.mjs');
const { verifyPinnedProduct } = await import('../src/nexus-read-model.mjs');

const json = (rel) => JSON.parse(readFileSync(new URL(`./fixtures/${rel}`, import.meta.url), 'utf8'));
const LIVE = json('uniswap/positions-20261021.json');
const VERIFY = json('uniswap/ethereum-verify-20261021.json');
const PRICES = json('prices/chainlink-ethereum-20261021.json');
const NX = Object.fromEntries(readdirSync(new URL('./fixtures/uniswap/nexus-72/', import.meta.url)).map((f) => [f.replace('.json', ''), json(`uniswap/nexus-72/${f}`)]));
const D = U.UNISWAP_V3_ETHEREUM;
const B = (x) => BigInt(x);
const lc = (a) => a.toLowerCase();
const WALLET = '0x1111111111111111111111111111111111111111';
const BLOCK = Object.freeze({ number: B(LIVE.block.number), timestamp: B(LIVE.block.timestamp) });
const NOW = Number(LIVE.block.timestamp) * 1_000 + 20_000;
const byId = Object.fromEntries(LIVE.vectors.map((v) => [v.tokenId, v]));
const IN = '1387464', ABOVE_USDC = '1380247', ZERO_LIQ = '1387153', BELOW_PAXG = '1383966';
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ------------------------------------------------- Position und Preise -- */

function rawFor(id) {
	const v = byId[id];
	const p = v.position;
	return {
		tokenId: B(id), owner: WALLET, positionManager: D.positionManager,
		position: { token0: p.token0, token1: p.token1, fee: p.fee, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: B(p.liquidity), feeGrowthInside0LastX128: B(p.feeGrowthInside0LastX128), feeGrowthInside1LastX128: B(p.feeGrowthInside1LastX128), tokensOwed0: B(p.tokensOwed0), tokensOwed1: B(p.tokensOwed1) },
		factoryTickSpacing: D.feeTickSpacing[p.fee], registeredPool: v.pool,
		pool: { address: v.pool, factory: D.factory, token0: p.token0, token1: p.token1, fee: p.fee, tickSpacing: D.feeTickSpacing[p.fee], sqrtPriceX96: B(v.slot0.sqrtPriceX96), tick: v.slot0.tick, feeGrowthGlobal0X128: B(v.feeGrowthGlobal0X128), feeGrowthGlobal1X128: B(v.feeGrowthGlobal1X128) },
		tickLowerInfo: { feeGrowthOutside0X128: B(v.tickLowerInfo.feeGrowthOutside0X128), feeGrowthOutside1X128: B(v.tickLowerInfo.feeGrowthOutside1X128), initialized: v.tickLowerInfo.initialized },
		tickUpperInfo: { feeGrowthOutside0X128: B(v.tickUpperInfo.feeGrowthOutside0X128), feeGrowthOutside1X128: B(v.tickUpperInfo.feeGrowthOutside1X128), initialized: v.tickUpperInfo.initialized },
		token0Meta: { decimals: v.token0.decimals, symbol: v.token0.symbol }, token1Meta: { decimals: v.token1.decimals, symbol: v.token1.symbol }
	};
}
/** Chainlink-Runden des Mitschnitts, gelesen "im" Positionsblock; `patch` aendert einzelne Feeds. */
function readings(patch = {}) {
	return Object.fromEntries(Object.entries(PRICES.feeds).map(([key, f]) => {
		const r = f.onchain.latestRoundData;
		return [key, { blockNumber: BLOCK.number, ok: true, description: f.onchain.description, decimals: f.onchain.decimals, roundId: B(r.roundId), answer: B(r.answer), startedAt: B(r.startedAt), updatedAt: B(r.updatedAt), answeredInRound: B(r.answeredInRound), ...(patch[key] ?? {}) }];
	}));
}
const COVER_TOKENS = Object.values(U.COVER_ASSET_REFERENCES).map((r) => r.token);
function setup(id, { patch = {}, raw = {} } = {}) {
	const position = U.validatePosition({ ...rawFor(id), ...raw }, { wallet: WALLET, chainId: 1, block: BLOCK });
	const tokens = position.status === 'VALID' ? [position.token0, position.token1].map((t) => ({ address: t.address, decimals: t.decimals })) : [];
	const priceBook = U.buildPriceBook({ tokens: [...tokens, ...COVER_TOKENS.filter((t) => !tokens.some((x) => lc(x.address) === lc(t))).map((address) => ({ address }))], block: BLOCK, readings: readings(patch) });
	return { position, priceBook, exposure: U.computeUniswapLpExposure(position, priceBook) };
}
const answer = (key) => B(PRICES.feeds[key].onchain.latestRoundData.answer);

/* ----------------------------------------------------- Nexus-Nachbau -- */

const QUOTES = Object.fromEntries(Object.entries(NX).filter(([k]) => k.startsWith('quote-72-')).map(([k, v]) => {
	const [, , a, amount] = k.split('-');
	return [`${a.slice(1)}:${amount}`, v];
}));

/** Nexus-API aus den Mitschnitten. `override(path)` kann einzelne Antworten ersetzen (Objekt, Fehler, 'timeout'). */
function nexus({ override = () => undefined } = {}) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		assert.equal(init.method, 'GET');
		const path = url.replace('https://api.nexusmutual.io', '');
		calls.push(path);
		const o = override(path);
		if (o === 'timeout') { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }
		let body;
		let status = 200;
		if (o && o.status) status = o.status;
		else if (o !== undefined) body = o;
		else if (path === '/v2/products/72') body = NX['product-72'];
		else if (path === '/v2/product-types/0') body = NX['product-type-0'];
		else if (path === '/v2/capacity/72') body = NX['capacity-72'];
		else if (path.startsWith('/v2/quote?')) {
			const q = new URLSearchParams(path.split('?')[1]);
			assert.equal(q.get('productId'), '72', 'quote always for product 72');
			assert.equal(q.get('paymentAsset'), q.get('coverAsset'));
			body = QUOTES[`${q.get('coverAsset')}:${q.get('amount')}`];
			if (!body) status = 404;
		} else status = 404;
		const text = JSON.stringify(body ?? {});
		return { ok: status === 200, status, url: '', redirected: false, headers: { get: (h) => (h === 'content-type' ? 'application/json' : String(text.length)) }, text: async () => text };
	};
	return { fetchImpl, calls };
}

async function modelFor(id, { at = NOW, override, patch, raw } = {}) {
	API._test.reset();
	const s = setup(id, { patch, raw });
	const n = nexus({ override });
	const model = await N.getUniswapNexusModel(s.position, s.exposure, { fetchImpl: n.fetchImpl, now: at });
	return { ...s, model, calls: n.calls, fetchImpl: n.fetchImpl };
}
const req = (coverAsset, amount, extra = {}) => N.parseUniswapQuoteRequest({ mode: 'POSITION', tokenId: IN, coverAsset, amount, periodDays: 30, ...extra });

/* ------------------------------------------------------------ Produkt -- */

test('NX72-PIN current product 72 equals the pin, the earlier evidence and the chain; every deviation fails closed', () => {
	const product = API.parseProduct(NX['product-72'], 72);
	const type = API.parseProductType(NX['product-type-0'], 0);
	const v = N.verifyUniswapProduct(product, type);
	assert.equal(v.ok, true, v.reason);
	assert.deepEqual([v.productId, v.name, v.productTypeName, v.category, [...v.proofOfLossInputTypes], v.wordingCid, v.annexCid, v.gracePeriodSeconds], [72, 'Uniswap v3', 'Single Protocol Cover', 'dex', ['address'], 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY', null, 3_024_000]);
	assert.deepEqual(v.supportedCoverAssets.map((a) => a.symbol), ['ETH', 'USDC', 'cbBTC']);
	assert.deepEqual([NX['product-72'].isPrivate, NX['product-72'].isDeprecated, NX['product-72'].metadata, NX['product-72'].allowedPools], [false, false, '', []]);
	// gleiche Identitaet wie im Mitschnitt der Erkennungsphase (API und CoverProducts on-chain)
	const earlier = { ...VERIFY.nexus.api.product72 };
	assert.deepEqual({ ...NX['product-72'] }, earlier, 'unchanged since the detection phase (same timestamp, assets, wording)');
	const pin = U.NEXUS_UNISWAP_V3;
	assert.deepEqual([pin.productId, pin.gracePeriodSec, pin.wordingCid], [72, Number(NX['product-type-0'].gracePeriod), NX['product-type-0'].metadata]);

	const reason = (productPatch = {}, typePatch = {}) => N.verifyUniswapProduct({ ...product, ...productPatch }, { ...type, ...typePatch }).reason;
	assert.equal(reason({ productId: 97 }), 'PRODUCT_ID_MISMATCH');
	assert.equal(reason({ name: 'Uniswap v2' }), 'PRODUCT_NAME_MISMATCH');
	assert.equal(reason({ name: 'Uniswap v4' }), 'PRODUCT_NAME_MISMATCH');
	assert.equal(reason({ name: 'Beefy CLM + Uniswap v3' }), 'PRODUCT_NAME_MISMATCH');
	assert.equal(reason({ productTypeId: 11 }), 'PRODUCT_TYPE_MISMATCH');
	assert.equal(reason({}, { name: 'Protocol Cover' }), 'PRODUCT_TYPE_MISMATCH');
	assert.equal(reason({ private: true }), 'PRODUCT_PRIVATE');
	assert.equal(reason({ deprecated: true }), 'PRODUCT_DEPRECATED');
	assert.equal(reason({ category: 'lending' }), 'CATEGORY_MISMATCH');
	assert.equal(reason({ proofOfLossInputTypes: ['address', 'free_text'] }), 'PROOF_OF_LOSS_CHANGED');
	assert.equal(reason({}, { wordingCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' }), 'TERMS_CHANGED');
	assert.equal(reason({ metadata: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' }), 'TERMS_CHANGED', 'an annex appears');
	assert.equal(reason({}, { gracePeriodSeconds: 2_592_000 }), 'GRACE_PERIOD_CHANGED');
	assert.equal(reason({ coverAssets: product.coverAssets.slice(0, 2) }), 'COVER_ASSETS_CHANGED');
	assert.equal(reason({ coverAssets: [...product.coverAssets, { assetId: 1, symbol: 'DAI' }] }), 'COVER_ASSETS_CHANGED');
	assert.equal(reason({ coverAssets: product.coverAssets.map((a) => (a.assetId === 6 ? { ...a, symbol: 'USDT' } : a)) }), 'ASSET_IDENTITY_MISMATCH');
	assert.equal(N.verifyUniswapProduct(null, type).reason, 'PRODUCT_ID_MISMATCH');
	// Produkt 97 bleibt unberuehrt: 72 ist dort nicht gepinnt, 97 bestaetigt weiter
	assert.deepEqual(Object.keys(PINNED_PRODUCTS), ['97']);
	assert.equal(verifyPinnedProduct(72, product, type).reason, 'NOT_PINNED');
});

/* -------------------------------------------------------- Kapazitaet -- */

test('NX72-CAPACITY fresh positive capacity for ETH/USDC/cbBTC; stale, skewed, zero, malformed, missing asset, wrong product and partial failures fail closed', async () => {
	const { model, calls } = await modelFor(IN);
	assert.equal(model.eligibility.status, 'AVAILABLE', model.eligibility.reasons.join());
	assert.deepEqual(calls, ['/v2/products/72', '/v2/product-types/0', '/v2/capacity/72']);
	assert.deepEqual(model.capacity.assets.map((a) => [a.symbol, a.amount]), [['ETH', NX['capacity-72'].availableCapacity[0].amount], ['USDC', '8922543444271'], ['cbBTC', '10808650134']]);
	assert.ok(!model.capacity.assets.some((a) => a.symbol === 'DAI' || a.symbol === 'NXM'), 'DAI and NXM are not cover assets');
	assert.equal(model.capacity.productId, 72);
	// Frische zu einem spaeteren Zeitpunkt
	const verified = N.verifyUniswapProduct(API.parseProduct(NX['product-72'], 72), API.parseProductType(NX['product-type-0'], 0));
	const cap = { ...API.parseCapacity(NX['capacity-72'], 72), fetchedAt: new Date(NOW).toISOString() };
	assert.equal(N.uniswapCapacity(cap, verified, NOW + 60_000).status, 'AVAILABLE');
	assert.deepEqual([N.uniswapCapacity(cap, verified, NOW + 60_001).status, N.uniswapCapacity(cap, verified, NOW + 60_001).reason], ['UNAVAILABLE', 'CAPACITY_STALE']);
	assert.equal(N.uniswapCapacity(cap, verified, NOW - 1).reason, 'CAPACITY_CLOCK_SKEW', 'clock jumped back');
	assert.equal(N.uniswapCapacity({ ...cap, fetchedAt: 'yesterday' }, verified, NOW).reason, 'CAPACITY_INVALID');
	assert.equal(N.uniswapCapacity({ ...cap, productId: 97 }, verified, NOW).reason, 'CAPACITY_PRODUCT_MISMATCH');
	// Null-Kapazitaet, fehlendes Asset
	const zero = clone(NX['capacity-72']);
	for (const list of [zero.availableCapacity, ...zero.capacityPerPool.map((p) => p.availableCapacity)]) for (const e of list) e.amount = '0';
	assert.deepEqual((await modelFor(IN, { override: (p) => (p === '/v2/capacity/72' ? zero : undefined) })).model.eligibility.reasons, ['NO_CAPACITY']);
	const noCbBtc = clone(NX['capacity-72']);
	noCbBtc.availableCapacity = noCbBtc.availableCapacity.filter((e) => e.assetId !== 7);
	for (const p of noCbBtc.capacityPerPool) p.availableCapacity = p.availableCapacity.filter((e) => e.assetId !== 7);
	assert.deepEqual((await modelFor(IN, { override: (p) => (p === '/v2/capacity/72' ? noCbBtc : undefined) })).model.eligibility.reasons, ['CAPACITY_ASSET_MISSING']);
	// kaputte Antworten
	const inflated = clone(NX['capacity-72']);
	inflated.availableCapacity[0].amount = (B(inflated.availableCapacity[0].amount) * 2n).toString();
	for (const [body, expected] of [
		[{ ...NX['capacity-72'], productId: 97 }, 'CAPACITY_UNAVAILABLE:CAPACITY_PRODUCT_MISMATCH'],
		[{ ...NX['capacity-72'], availableCapacity: 'lots' }, 'CAPACITY_UNAVAILABLE:MALFORMED_CAPACITY'],
		[{ ...NX['capacity-72'], minAnnualPrice: 0.005 }, 'CAPACITY_UNAVAILABLE:MALFORMED_CAPACITY'],
		[inflated, 'CAPACITY_UNAVAILABLE:CAPACITY_INCONSISTENT'],
		[{ status: 500 }, 'CAPACITY_UNAVAILABLE:HTTP_ERROR'],
		['timeout', 'CAPACITY_UNAVAILABLE:TIMEOUT']
	]) {
		const { model: m } = await modelFor(IN, { override: (p) => (p === '/v2/capacity/72' ? body : undefined) });
		assert.deepEqual([m.eligibility.status, [...m.eligibility.reasons]], ['UNAVAILABLE', [expected]], expected);
		assert.equal(N.uniswapCoverBounds(m, setup(IN).priceBook).length, 0, 'no bounds without capacity');
	}
	// Teilausfall: Produkt oder Typ nicht lesbar -> kein Modell, auch wenn die Kapazitaet da ist
	assert.deepEqual([...(await modelFor(IN, { override: (p) => (p === '/v2/products/72' ? 'timeout' : undefined) })).model.eligibility.reasons], ['PRODUCT_UNAVAILABLE:TIMEOUT']);
	assert.deepEqual([...(await modelFor(IN, { override: (p) => (p === '/v2/product-types/0' ? { status: 503 } : undefined) })).model.eligibility.reasons], ['PRODUCT_TYPE_UNAVAILABLE:HTTP_ERROR']);
	assert.deepEqual([...(await modelFor(IN, { override: (p) => (p === '/v2/products/72' ? { ...NX['product-72'], name: 'Uniswap v4' } : undefined) })).model.eligibility.reasons], ['PRODUCT_NAME_MISMATCH']);
});

/* --------------------------------------------------------------- Gate -- */

test('NX72-GATE zero-liquidity, invalid, non-canonical, other versions, incomplete pricing and stale scans never reach Nexus', async () => {
	const none = async (id, opts, code) => {
		const r = await modelFor(id, opts);
		assert.deepEqual(r.calls, [], `${code}: no Nexus request`);
		assert.deepEqual([...r.model.eligibility.reasons], [code]);
		return r.model;
	};
	const zero = await none(ZERO_LIQ, {}, 'ZERO_LIQUIDITY');
	assert.equal(zero.suggestedExposureUsd, null);
	const zs = setup(ZERO_LIQ);
	assert.deepEqual([zs.exposure.liquidityState, zs.exposure.suggestedExposureUsd, zs.exposure.pricingStatus], ['ZERO_LIQUIDITY', '0', 'NOT_REQUIRED'], 'still visible, no principal');
	await none(IN, { raw: { owner: '0x2222222222222222222222222222222222222222' } }, 'POSITION_NOT_VALID');
	await none(IN, { raw: { registeredPool: '0x0000000000000000000000000000000000000000' } }, 'POSITION_NOT_VALID');
	// PAXG-Feed veraltet -> Position nicht voll bewertet
	await none(BELOW_PAXG, { patch: { 'paxg-usd': { updatedAt: BLOCK.timestamp - 90_721n } } }, 'PRICING_INCOMPLETE');
	// Positionsscan zu alt / aus der Zukunft
	await none(IN, { at: Number(BLOCK.timestamp) * 1_000 + N.POSITION_MAX_AGE_MS + 1 }, 'POSITION_STALE');
	await none(IN, { at: Number(BLOCK.timestamp) * 1_000 - 120_000 }, 'POSITION_CLOCK_SKEW');
	const s = setup(IN);
	const gate = (position, exposure) => N.uniswapQuoteGate(position, exposure, { now: NOW });
	assert.equal(gate(s.position, s.exposure).ok, true);
	for (const [deploymentKey, cls] of [['uniswap-v2-ethereum', 'UNSUPPORTED'], ['uniswap-v4-ethereum', 'UNSUPPORTED'], ['beefy-clm-uniswap-v3-ethereum', 'UNSUPPORTED'], ['uniswap-v3-base', 'AMBIGUOUS']]) {
		const g = gate({ ...s.position, deploymentKey }, s.exposure);
		assert.deepEqual([g.code, g.mappingClass], ['NOT_MATCHED', cls], deploymentKey);
		assert.equal(N.buildUniswapNexusModel({ ...s.position, deploymentKey }, s.exposure, null, { now: NOW }).eligibility.status, cls);
	}
	assert.equal(gate({ ...s.position, pool: byId[ABOVE_USDC].pool }, { ...s.exposure, pool: byId[ABOVE_USDC].pool }).mappingClass, 'AMBIGUOUS', 'fake pool');
	assert.equal(gate({ ...s.position, chainId: 10 }, s.exposure).mappingClass, 'UNSUPPORTED');
	assert.equal(gate(s.position, { ...s.exposure, tokenId: '1' }).code, 'EXPOSURE_MISMATCH');
	assert.equal(gate(s.position, { ...s.exposure, blockNumber: '1' }).code, 'EXPOSURE_MISMATCH');
	assert.equal(gate(s.position, { ...s.exposure, feesIncluded: true }).code, 'FEES_INCLUDED');
	assert.equal(gate(s.position, { ...s.exposure, pricingStatus: 'UNKNOWN' }).code, 'PRICING_INCOMPLETE');
	assert.equal(gate(s.position, { ...s.exposure, suggestedExposureUsd8: '0' }).code, 'PRICING_INCOMPLETE');
	assert.equal(gate(null, s.exposure).code, 'POSITION_NOT_VALID');
});

/* -------------------------------------------------------- Umrechnung -- */

test('NX72-CONVERSION USD -> ETH/USDC/cbBTC exactly via the Chainlink reference of the same block; stale or forged references fail closed', () => {
	const { exposure, priceBook } = setup(IN);
	const usd8 = B(exposure.suggestedExposureUsd8);
	const expected = { 0: [18, 'eth-usd'], 6: [6, 'usdc-usd'], 7: [8, 'cbbtc-usd'] };
	for (const [id, [decimals, key]] of Object.entries(expected)) {
		const c = N.coverAssetConversion(usd8, Number(id), priceBook, exposure.blockNumber);
		assert.equal(c.ok, true, c.code);
		assert.equal(c.amountRaw, (usd8 * 10n ** BigInt(decimals)) / answer(key), `${key} floor(USD x 10^d / price)`);
		assert.deepEqual([c.feed, c.blockNumber], [P.CHAINLINK_FEEDS[key].proxy, String(BLOCK.number)]);
	}
	// USDC: keine angenommene Paritaet - 1 000 USD sind bei 0,99981255 USD mehr als 1 000 USDC
	const usdc = N.coverAssetConversion(1_000n * 10n ** 8n, 6, priceBook, exposure.blockNumber);
	assert.equal(usdc.amountRaw, (1_000n * 10n ** 8n * 10n ** 6n) / answer('usdc-usd'));
	assert.notEqual(usdc.amountRaw, 1_000_000_000n);
	// nie Pool-Spotpreis: die Umrechnung haengt nur vom Preisbuch ab, nicht von slot0
	assert.deepEqual(N.coverAssetConversion(usd8, 0, {}, exposure.blockNumber).code, 'COVER_ASSET_PRICE_UNAVAILABLE');
	const stale = setup(IN, { patch: { 'eth-usd': { updatedAt: BLOCK.timestamp - 3_781n } } });
	assert.equal(stale.exposure.pricingStatus, 'UNKNOWN', 'the WETH leg needs ETH/USD too');
	const staleUsdc = setup(IN, { patch: { 'usdc-usd': { updatedAt: BLOCK.timestamp - 86_941n } } });
	assert.equal(staleUsdc.exposure.pricingStatus, 'PRICED', 'WETH/USDT position does not need USDC');
	const c = N.coverAssetConversion(B(staleUsdc.exposure.suggestedExposureUsd8), 6, staleUsdc.priceBook, staleUsdc.exposure.blockNumber);
	assert.deepEqual([c.code, c.priceStatus], ['COVER_ASSET_PRICE_UNAVAILABLE', 'PRICE_STALE']);
	const weth = lc(U.COVER_ASSET_REFERENCES[0].token);
	const forged = (patchEntry) => N.coverAssetConversion(usd8, 0, { ...priceBook, [weth]: { ...priceBook[weth], ...patchEntry } }, exposure.blockNumber).code;
	assert.equal(forged({ blockNumber: String(BLOCK.number - 1n) }), 'COVER_ASSET_PRICE_NOT_SAME_BLOCK');
	assert.equal(forged({ feeds: [P.CHAINLINK_FEEDS['btc-usd'].proxy] }), 'COVER_ASSET_PRICE_INVALID');
	assert.equal(forged({ token: getAddress('0x00000000000000000000000000000000000fa4e1') }), 'COVER_ASSET_PRICE_INVALID');
	assert.equal(forged({ chainId: 10 }), 'COVER_ASSET_PRICE_INVALID');
	assert.equal(forged({ priceUsd8: 245545211980 }), 'COVER_ASSET_PRICE_INVALID', 'number price');
	assert.equal(forged({ sourceType: 'AAVE_ORACLE_VERIFIED' }), 'COVER_ASSET_PRICE_INVALID');
	assert.equal(N.coverAssetConversion(usd8, 1, priceBook, exposure.blockNumber).code, 'ASSET_NOT_SUPPORTED', 'DAI');
	assert.equal(N.coverAssetConversion(usd8, 255, priceBook, exposure.blockNumber).code, 'ASSET_NOT_SUPPORTED', 'NXM');
	assert.equal(N.coverAssetConversion(0n, 0, priceBook, exposure.blockNumber).code, 'NO_EXPOSURE');
	assert.equal(N.coverAssetConversion(1, 0, priceBook, exposure.blockNumber).code, 'NO_EXPOSURE', 'number amount');
});

/* ------------------------------------------------------------- Quote -- */

test('NX72-QUOTE informational quote per NFT for ETH, USDC and cbBTC; never above principal exposure; view without internals', async () => {
	const { model, priceBook, fetchImpl, exposure } = await modelFor(IN);
	const bounds = N.uniswapCoverBounds(model, priceBook);
	assert.deepEqual(bounds.map((b) => [b.symbol, b.selectable, b.limitedBy]), [['ETH', true, 'EXPOSURE'], ['USDC', true, 'EXPOSURE'], ['cbBTC', true, 'EXPOSURE']]);
	for (const [asset, amount, quoted] of [['ETH', '0.1', '0.100045441464956859'], ['USDC', '1000', '1000.327217'], ['cbBTC', '0.01', '0.01000141']]) {
		const r = await N.requestUniswapQuote(req(asset, amount), model, priceBook, { fetchImpl, now: NOW });
		assert.equal(r.ok, true, `${asset}: ${r.code} ${r.reason}`);
		const q = r.quote;
		assert.deepEqual(Object.keys(q).sort(), ['annualPricePercent', 'capacity', 'coverAsset', 'informationalOnly', 'periodDays', 'pool', 'premium', 'premiumAsset', 'productId', 'productName', 'productTypeName', 'provider', 'purchaseAvailable', 'quoteExpiresAt', 'quoteFetchedAt', 'quotedCoverAmount', 'requestedCoverAmount', 'status', 'suggestedExposureUsd', 'tokenId'].sort());
		assert.deepEqual([q.provider, q.productId, q.productName, q.productTypeName, q.tokenId, q.pool, q.coverAsset, q.requestedCoverAmount, q.quotedCoverAmount, q.periodDays, q.status, q.informationalOnly, q.purchaseAvailable], ['Nexus Mutual', 72, 'Uniswap v3', 'Single Protocol Cover', IN, byId[IN].pool, asset, amount, quoted, 30, 'FRESH', true, false]);
		assert.equal(q.suggestedExposureUsd, exposure.suggestedExposureUsd);
		assert.equal(q.annualPricePercent, '0.50');
		assert.equal(Date.parse(q.quoteExpiresAt) - Date.parse(q.quoteFetchedAt), 60_000);
		assert.equal(N.uniswapQuoteView({ ...r.quote, fetchedAt: q.quoteFetchedAt, totalCoverAmount: '1', premiumInAsset: '1', annualPriceBps: 50, periodDays: 30 }, { coverAsset: Object.values(NEXUS_ASSETS).find((a) => a.symbol === asset), amount: 1n, bound: { capacity: '1' } }, model, NOW + 60_000).status, 'STALE', 'stale after 60 s');
	}
	// Grenzen: Betrag ueber der Exposure, ueber der Kapazitaet, 0, falsches Format
	const eth = bounds.find((b) => b.symbol === 'ETH');
	for (const bnd of bounds) {
		const min = B(bnd.maxFromExposureRaw) < B(bnd.capacityRaw) ? B(bnd.maxFromExposureRaw) : B(bnd.capacityRaw);
		assert.equal(bnd.maxAmountRaw, min.toString(), `${bnd.symbol}: max = min(exposure, capacity)`);
	}
	assert.equal(eth.maxAmountRaw, eth.maxFromExposureRaw, 'a ~2 000 USD position is limited by its exposure, not by Nexus capacity');
	const above = (B(eth.maxFromExposureRaw) + 1n);
	const r = N.checkUniswapQuoteRequest(req('ETH', (Number(above) / 1e18).toFixed(18).replace(/0+$/, '')), model, priceBook, { now: NOW });
	assert.equal(r.code, 'AMOUNT_ABOVE_EXPOSURE');
	assert.equal(N.checkUniswapQuoteRequest(req('ETH', eth.maxFromExposure), model, priceBook, { now: NOW }).ok, true, 'exactly the exposure is allowed');
	assert.equal(N.checkUniswapQuoteRequest(req('ETH', '0'), model, priceBook, { now: NOW }).code, 'AMOUNT_OUT_OF_RANGE');
	assert.equal(N.checkUniswapQuoteRequest(req('USDC', '1.0000001'), model, priceBook, { now: NOW }).code, 'INVALID_AMOUNT');
	// Anfrage-Form
	assert.equal(req('DAI', '1').code, 'ASSET_NOT_SUPPORTED');
	assert.equal(req('eth', '1').code, 'ASSET_NOT_SUPPORTED', 'no case folding');
	assert.equal(req('ETH', '1', { periodDays: 27 }).code, 'PERIOD_OUT_OF_RANGE');
	assert.equal(req('ETH', '1', { periodDays: 366 }).code, 'PERIOD_OUT_OF_RANGE');
	assert.equal(req('ETH', '1', { periodDays: '30' }).code, 'PERIOD_OUT_OF_RANGE');
	assert.equal(req('ETH', '1', { periodDays: 28 }).ok, true);
	assert.equal(req('ETH', '1', { periodDays: 365 }).ok, true);
	assert.equal(N.parseUniswapQuoteRequest({ mode: 'POSITION', tokenId: IN, coverAsset: 'ETH', amount: '1', periodDays: 30, productId: 72 }).code, 'PRODUCT_ID_NOT_ACCEPTED');
	assert.equal(N.parseUniswapQuoteRequest({ mode: 'POSITION', tokenId: IN, coverAsset: 'ETH', amount: '1', periodDays: 30, pool: '0x' }).code, 'INVALID_BODY');
	assert.equal(N.parseUniswapQuoteRequest({ mode: 'AGGREGATE', tokenId: IN, coverAsset: 'ETH', amount: '1', periodDays: 30 }).code, 'AGGREGATE_QUOTE_NOT_ENABLED');
	assert.equal(N.checkUniswapQuoteRequest(req('ETH', '0.1', { tokenId: ABOVE_USDC }), model, priceBook, { now: NOW }).code, 'POSITION_MISMATCH');
	// Kapazitaet zur Quote-Zeit veraltet
	assert.equal(N.checkUniswapQuoteRequest(req('ETH', '0.1'), model, priceBook, { now: NOW + 60_001 }).code, 'CAPACITY_STALE');
	// Modell eines anderen Produkts
	assert.equal(N.checkUniswapQuoteRequest(req('ETH', '0.1'), { ...model, product: { ...model.product, productId: 97 } }, priceBook, { now: NOW }).code, 'PRODUCT_MISMATCH');
	// Cover-Asset ohne frischen Preis: nicht waehlbar
	const stale = setup(IN, { patch: { 'cbbtc-usd': { updatedAt: BLOCK.timestamp - 90_721n } } });
	assert.equal(N.checkUniswapQuoteRequest(req('cbBTC', '0.01'), model, stale.priceBook, { now: NOW }).code, 'COVER_ASSET_PRICE_UNAVAILABLE');
});

test('NX72-QUOTE-FAIL malformed, mismatched, inconsistent, rounded, timed-out or partial quotes never become a quote', async () => {
	const base = await modelFor(IN);
	const run = async (asset, amount, body) => {
		const n = nexus({ override: (p) => (p.startsWith('/v2/quote?') ? body : undefined) });
		return N.requestUniswapQuote(req(asset, amount), base.model, base.priceBook, { fetchImpl: n.fetchImpl, now: NOW });
	};
	const good = NX['quote-72-a0-100000000000000000-30d'];
	const edit = (fn) => { const x = clone(good); fn(x.quote); return x; };
	for (const [body, code, reason] of [
		[edit((q) => { q.asset = { id: 6, symbol: 'USDC', decimals: 6 }; }), 'QUOTE_REJECTED', 'QUOTE_ASSET_MISMATCH'],
		[edit((q) => { q.totalCoverAmountInAsset = '99999999999999999'; q.poolAllocationRequests[0].coverAmountInAsset = q.totalCoverAmountInAsset; }), 'QUOTE_REJECTED', 'QUOTE_AMOUNT_MISMATCH'],
		[edit((q) => { q.totalCoverAmountInAsset = '150000000000000000'; q.poolAllocationRequests[0].coverAmountInAsset = q.totalCoverAmountInAsset; }), 'QUOTE_REJECTED', 'QUOTE_AMOUNT_MISMATCH'],
		[edit((q) => { q.premiumInAsset = (B(q.premiumInAsset) * 2n).toString(); q.premiumInAssetWithRefund = q.premiumInAsset; }), 'QUOTE_REJECTED', 'QUOTE_PRICE_INCONSISTENT'],
		[edit((q) => { q.annualPrice = 50; }), 'QUOTE_REJECTED', 'MALFORMED_QUOTE'],
		[edit((q) => { delete q.poolAllocationRequests; }), 'QUOTE_REJECTED', 'MALFORMED_QUOTE'],
		[edit((q) => { q.poolAllocationRequests[0].poolId = '999'; }), 'QUOTE_REJECTED', 'QUOTE_PRODUCT_MISMATCH'],
		[edit((q) => { q.refundInAsset = '1'; }), 'QUOTE_REJECTED', 'MALFORMED_QUOTE'],
		[{ error: 'nope' }, 'QUOTE_REJECTED', 'MALFORMED_QUOTE'],
		[{ status: 500 }, 'QUOTE_UNAVAILABLE', 'HTTP_ERROR'],
		['timeout', 'QUOTE_UNAVAILABLE', 'TIMEOUT']
	]) {
		const r = await run('ETH', '0.1', body);
		assert.deepEqual([r.ok, r.code, r.reason], [false, code, reason], reason);
	}
	// echte Antworten von Nexus fuer winzige Betraege (Rundung auf Allokations-Einheiten)
	assert.deepEqual(await run('ETH', '0.0001', undefined), { ok: false, code: 'QUOTE_AMOUNT_TOO_SMALL', reason: 'QUOTE_AMOUNT_ROUNDED_UP' });
	assert.deepEqual(await run('USDC', '1', undefined), { ok: false, code: 'QUOTE_AMOUNT_TOO_SMALL', reason: 'QUOTE_AMOUNT_ROUNDED_UP' });
	assert.deepEqual(await run('cbBTC', '0.0001', undefined), { ok: false, code: 'QUOTE_AMOUNT_TOO_SMALL', reason: 'QUOTE_AMOUNT_ROUNDED_UP' });
	assert.deepEqual(await run('cbBTC', '0.00001', undefined), { ok: false, code: 'QUOTE_REJECTED', reason: 'QUOTE_AMOUNT_MISMATCH' }, 'zero premium: not even classified as rounding');
	// keine Quote ohne gueltiges Modell: kein einziger Abruf
	let fetched = 0;
	const r = await N.requestUniswapQuote(req('ETH', '0.1'), { ...base.model, eligibility: { status: 'UNAVAILABLE', reasons: ['X'] } }, base.priceBook, { fetchImpl: async () => { fetched += 1; throw new Error('x'); }, now: NOW });
	assert.deepEqual([r.code, fetched], ['COVER_NOT_AVAILABLE', 0]);
});

/* --------------------------------------------------------- Rundung -- */

test('NX72-ROUNDING product 72 rounds per pool to 0.01 NXM allocation units like product 97; the existing classifier holds; nothing is inflated', () => {
	const cap = API.parseCapacity(NX['capacity-72'], 72);
	const rows = Object.entries(QUOTES).map(([key, body]) => {
		const [assetId, amount] = key.split(':');
		const q = body.quote;
		const unit = B(q.premiumInNXM) > 0n ? (API.NXM_PER_ALLOCATION_UNIT * B(q.premiumInAsset)) / B(q.premiumInNXM) : null;
		let outcome;
		try { outcome = API.parseQuote(body, { coverAsset: NEXUS_ASSETS[assetId], amount: B(amount), periodDays: 30, capacity: cap }) && 'OK'; } catch (e) { outcome = e.code; }
		return { assetId: Number(assetId), amount: B(amount), total: B(q.totalCoverAmountInAsset), unit, pools: q.poolAllocationRequests.length, outcome };
	});
	assert.equal(rows.length, 14);
	// Ein einziger Pool: die Mindestsumme ist genau eine Allokations-Einheit (0,01 NXM im Asset)
	const ethTiny = rows.find((r) => r.assetId === 0 && r.amount === 10n ** 12n);
	assert.equal(ethTiny.pools, 1);
	const diff = ethTiny.total > ethTiny.unit ? ethTiny.total - ethTiny.unit : ethTiny.unit - ethTiny.total;
	assert.ok(diff * 1_000n <= ethTiny.unit, '1e12 wei becomes exactly one 0.01-NXM unit');
	assert.equal(rows.find((r) => r.assetId === 0 && r.amount === 10n ** 14n).total, ethTiny.total, 'same single unit');
	// Jede Gesamtsumme ist ein ganzes Vielfaches der Einheit (bis auf Rundung des Verhaeltnisses), nie weniger als angefragt
	for (const r of rows) assert.ok(r.total >= r.amount, `${r.assetId}:${r.amount} never below the request`);
	// Einordnung durch den bestehenden Parser: winzig -> ROUNDED_UP; ab ~10 Einheiten -> OK (<= 1 % + 1); Praemie 0 -> MISMATCH
	assert.deepEqual(rows.map((r) => `${r.assetId}:${r.amount}:${r.outcome}`).sort(), [
		'0:1000000000000:QUOTE_AMOUNT_ROUNDED_UP', '0:1000000000000000:QUOTE_AMOUNT_ROUNDED_UP', '0:1000000000000000000:OK', '0:100000000000000:QUOTE_AMOUNT_ROUNDED_UP', '0:10000000000000000:OK', '0:100000000000000000:OK',
		'6:1000000000:OK', '6:1000000:QUOTE_AMOUNT_ROUNDED_UP', '6:100000000:OK', '6:10000000:OK',
		'7:1000000:OK', '7:1000:QUOTE_AMOUNT_MISMATCH', '7:100000:OK', '7:10000:QUOTE_AMOUNT_ROUNDED_UP'
	].sort());
	// Jede akzeptierte Quote liegt hoechstens 1 % + 1 Einheit ueber der Anfrage
	for (const r of rows.filter((x) => x.outcome === 'OK')) assert.ok(r.total <= r.amount + r.amount / 100n + 1n);
	// Gleiche Einheit wie beim Aave-Produkt 97: der Mitschnitt quote-97-eth-tiny liegt bei derselben Groessenordnung je Einheit
	const aave = json('nexus/quote-97-eth-tiny-90d.json').quote;
	const aaveUnit = (API.NXM_PER_ALLOCATION_UNIT * B(aave.premiumInAsset)) / B(aave.premiumInNXM);
	assert.ok(aaveUnit * 100n > ethTiny.unit * 99n && aaveUnit * 100n < ethTiny.unit * 101n, 'unit in ETH equal within 1 % (NXM price moved between 20.10. and 21.10.)');
	assert.equal(API.NXM_PER_ALLOCATION_UNIT, 10n ** 16n);
	// Die Uniswap-Schicht erhoeht den Betrag nie: QUOTE_OVERAGE ist genau die Toleranz des Parsers
	assert.deepEqual({ ...N.QUOTE_OVERAGE }, { percent: 1n, units: 1n });
});

/* -------------------------------------------------------- Readiness -- */

test('NX72-READINESS quoteDataReady only with valid, matched, priced, fresh capacity; quoteReady and purchaseReady stay false', async () => {
	const ok = await modelFor(IN);
	const r = N.uniswapV3QuoteReadiness({ position: ok.position, exposure: ok.exposure, model: ok.model, priceBook: ok.priceBook, now: NOW });
	assert.deepEqual([r.deploymentClass, r.nexusMappingClass, r.positionValid, r.exposureReady, r.pricingReady, r.capacityReady, r.quoteDataReady], ['CANONICAL', 'MATCHED', true, true, true, true, true]);
	assert.deepEqual([r.termsReady, r.proofOfLossReady, r.quoteReady, r.purchaseReady], [false, false, false, false]);
	assert.deepEqual([...r.blockers], ['NO_PRODUCTION_PATH', 'NEXUS_TERMS_INTERPRETATION_UNCONFIRMED', 'NEXUS_PROOF_OF_LOSS_UNCONFIRMED', 'WALLET_EXECUTION_NOT_AVAILABLE']);
	const later = N.uniswapV3QuoteReadiness({ position: ok.position, exposure: ok.exposure, model: ok.model, priceBook: ok.priceBook, now: NOW + 60_001 });
	assert.deepEqual([later.capacityReady, later.quoteDataReady], [false, false]);
	assert.ok(later.blockers.includes('CAPACITY_NOT_READY'));
	const zero = await modelFor(ZERO_LIQ);
	const z = N.uniswapV3QuoteReadiness({ position: zero.position, exposure: zero.exposure, model: zero.model, priceBook: zero.priceBook, now: NOW });
	assert.deepEqual([z.exposureReady, z.quoteDataReady, z.purchaseReady], [false, false, false]);
	assert.ok(z.blockers.includes('ZERO_LIQUIDITY'));
	const noModel = N.uniswapV3QuoteReadiness({ position: ok.position, exposure: ok.exposure, model: null, priceBook: ok.priceBook, now: NOW });
	assert.deepEqual([noModel.pricingReady, noModel.capacityReady, noModel.quoteDataReady], [false, false, false]);
	const stale = N.uniswapV3QuoteReadiness({ position: ok.position, exposure: ok.exposure, model: ok.model, priceBook: ok.priceBook, quote: { status: 'STALE' }, now: NOW });
	assert.ok(stale.blockers.includes('QUOTE_STALE'));
	for (const input of [undefined, {}, { position: { status: 'INVALID' } }]) {
		const x = N.uniswapV3QuoteReadiness(input);
		assert.deepEqual([x.quoteDataReady, x.quoteReady, x.purchaseReady], [false, false, false]);
	}
});

/* ---------------------------------------------------------- Aggregat -- */

test('NX72-AGGREGATE wallet basis only for a COMPLETE aggregate of matched positions, and never quoted in this phase', () => {
	const parts = [IN, ABOVE_USDC, ZERO_LIQ].map((id) => setup(id));
	const scan = { status: 'OK', positions: parts.map((p) => p.position), aggregate: U.aggregateUniswapLpExposure(parts.map((p) => p.exposure)) };
	const basis = N.aggregateQuoteBasis(scan);
	assert.deepEqual([basis.ok, basis.mode, basis.quoteEnabled, [...basis.tokenIds], basis.suggestedExposureUsd], [true, 'AGGREGATE', false, [IN, ABOVE_USDC], scan.aggregate.suggestedExposureUsd], 'zero-liquidity NFT is not part of the basis');
	const withPaxg = [IN, BELOW_PAXG].map((id, i) => setup(id, i ? { patch: { 'paxg-usd': { updatedAt: BLOCK.timestamp - 90_721n } } } : {}));
	const incomplete = { status: 'OK', positions: withPaxg.map((p) => p.position), aggregate: U.aggregateUniswapLpExposure(withPaxg.map((p) => p.exposure)) };
	assert.equal(N.aggregateQuoteBasis(incomplete).code, 'AGGREGATE_INCOMPLETE');
	assert.equal(N.aggregateQuoteBasis({ ...scan, status: 'UNAVAILABLE' }).code, 'SCAN_UNAVAILABLE');
	assert.equal(N.aggregateQuoteBasis({ ...scan, positions: scan.positions.map((p) => ({ ...p, deploymentKey: 'uniswap-v4-ethereum' })) }).code, 'NOT_MATCHED');
	const onlyClosed = setup(ZERO_LIQ);
	assert.equal(N.aggregateQuoteBasis({ status: 'OK', positions: [onlyClosed.position], aggregate: U.aggregateUniswapLpExposure([onlyClosed.exposure]) }).code, 'NO_ACTIVE_POSITION');
});
