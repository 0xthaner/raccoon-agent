/**
 * Uniswap v3 auf Ethereum - inaktive Positionserkennung und Exposure (21.10.2026).
 *
 * Offline. Grundlage sind drei Mitschnitte vom 21.10.2026:
 *  - ethereum-verify: Nexus-Produkt 72 (API und CoverProducts on-chain), kanonische
 *    Uniswap-Adressen aus dem SDK und ihre on-chain-Gegenprobe, CREATE2-Ableitung
 *  - positions: neun Live-Positionen in einem Block, mit Referenzmengen aus eth_call
 *    (decreaseLiquidity/collect vom Eigentuemer simuliert, nichts gesendet)
 *  - prices/chainlink-ethereum: die Chainlink-Runden (ETH, USDC, cbBTC, USDT,
 *    WBTC/BTC, BTC, PAXG), gelesen in Block 26240768. Jede dieser Runden ist
 *    VOR dem Positionsblock 26240621 veroeffentlicht und bis 26240768 nicht
 *    ersetzt worden - sie ist also genau die Runde, die im Positionsblock galt.
 *    Der nachgebaute Client liefert sie unveraendert zum Zeitstempel des
 *    Positionsblocks; Frische und Pruefungen laufen wie on-chain.
 *  - reference-vectors: TickMath-Snapshot aus v3-core und Positionswerte aus dem v3-sdk
 * Geprueft werden Mathematik, Validierung, Leser (ueber einen nachgebauten
 * Client), Exposure, Readiness und dass nichts davon produktiv erreichbar ist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatUnits, getAddress, keccak256 } from 'viem';

Object.assign(process.env, {
	SUPABASE_URL: process.env.SUPABASE_URL || 'https://supabase.test.invalid',
	SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY || 'test-secret-key'
});

const M = await import('../src/positions/uniswap-v3-math.mjs');
const U = await import('../src/positions/uniswap-v3-ethereum.mjs');
const P = await import('../src/positions/price-reference.mjs');
const { AAVE_V3_MARKETS, nexusProductIdFor } = await import('../src/positions/aave-registry.mjs');
const { PINNED_PRODUCTS } = await import('../src/nexus-pinned.mjs');
const { matchPositionToNexus } = await import('../src/positions/nexus-mapping.mjs');
const { getNexusReadModel } = await import('../src/nexus-read-model.mjs');
const { checkQuoteRequest, parseCoverRequest } = await import('../src/nexus-quote.mjs');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/uniswap/${name}`, import.meta.url), 'utf8'));
const VERIFY = load('ethereum-verify-20261021.json');
const LIVE = load('positions-20261021.json');
const REF = load('reference-vectors.json');
const PRICES = JSON.parse(readFileSync(new URL('./fixtures/prices/chainlink-ethereum-20261021.json', import.meta.url), 'utf8'));
const CODE = {
	npm: readFileSync(new URL('./fixtures/uniswap/runtime-npm-c36442b4.hex', import.meta.url), 'utf8').trim(),
	factory: readFileSync(new URL('./fixtures/uniswap/runtime-factory-1f98431c.hex', import.meta.url), 'utf8').trim()
};
const D = U.UNISWAP_V3_ETHEREUM;
const CORE = AAVE_V3_MARKETS.find((m) => m.deploymentKey === 'aave-v3-ethereum-core');
const ZERO = '0x0000000000000000000000000000000000000000';
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const BLOCK = BigInt(LIVE.block.number);
const BLOCK_TIME = BigInt(LIVE.block.timestamp);
const FEED_BY_PROXY = new Map(Object.entries(PRICES.feeds).map(([key, f]) => [f.directory.proxyAddress.toLowerCase(), { key, ...f.onchain }]));
const B = (x) => BigInt(x);
const byId = Object.fromEntries(LIVE.vectors.map((v) => [v.tokenId, v]));
const lc = (a) => a.toLowerCase();

/* ------------------------------------------------------- Nachbau der Chain -- */

function positionTuple(p) {
	return [0n, ZERO, getAddress(p.token0), getAddress(p.token1), p.fee, p.tickLower, p.tickUpper, B(p.liquidity), B(p.feeGrowthInside0LastX128), B(p.feeGrowthInside1LastX128), B(p.tokensOwed0), B(p.tokensOwed1)];
}
const tickTuple = (info) => [info.initialized ? 1n : 0n, 0n, B(info.feeGrowthOutside0X128), B(info.feeGrowthOutside1X128), 0n, 0n, 0, info.initialized];

/** Welt aus den Live-Vektoren; `ids` gehoeren WALLET. `patch` veraendert gezielt einzelne Antworten. */
function world(ids, { patch = () => undefined, chainId = 1, code = CODE, extraPositions = {}, extraPools = {}, extraTokens = {}, delay = null, shorten = false, multicallThrows = false } = {}) {
	const positions = new Map();
	const pools = new Map();
	const tokens = new Map();
	for (const v of LIVE.vectors) {
		positions.set(B(v.tokenId), { owner: WALLET, tuple: positionTuple(v.position) });
		tokens.set(lc(v.token0.address), v.token0);
		tokens.set(lc(v.token1.address), v.token1);
		const pool = pools.get(lc(v.pool)) ?? {
			address: v.pool, factory: D.factory, token0: v.token0.address, token1: v.token1.address, fee: v.position.fee, tickSpacing: D.feeTickSpacing[v.position.fee],
			slot0: [B(v.slot0.sqrtPriceX96), v.slot0.tick, 0, 1, 1, 0, true], g0: B(v.feeGrowthGlobal0X128), g1: B(v.feeGrowthGlobal1X128), ticks: new Map()
		};
		pool.ticks.set(v.position.tickLower, tickTuple(v.tickLowerInfo));
		pool.ticks.set(v.position.tickUpper, tickTuple(v.tickUpperInfo));
		pools.set(lc(v.pool), pool);
	}
	for (const [id, entry] of Object.entries(extraPositions)) positions.set(B(id), entry);
	for (const [address, pool] of Object.entries(extraPools)) pools.set(lc(address), pool);
	for (const [address, token] of Object.entries(extraTokens)) tokens.set(lc(address), token);
	const calls = [];
	const success = (result) => ({ status: 'success', result });
	const failure = (why) => ({ status: 'failure', error: new Error(why) });
	const answer = (c) => {
		const patched = patch(c);
		if (patched !== undefined) return patched;
		const a = lc(c.address);
		const fn = c.functionName;
		if (a === lc(D.positionManager)) {
			if (fn === 'factory') return success(D.factory);
			if (fn === 'WETH9') return success(D.weth9);
			if (fn === 'supportsInterface') return success(c.args[0] === '0x780e9d63');
			if (fn === 'balanceOf') return success(lc(c.args[0]) === lc(WALLET) ? BigInt(ids.length) : 0n);
			if (fn === 'tokenOfOwnerByIndex') return lc(c.args[0]) === lc(WALLET) && c.args[1] < BigInt(ids.length) ? success(B(ids[Number(c.args[1])])) : failure('index');
			if (fn === 'positions') return positions.has(c.args[0]) ? success(positions.get(c.args[0]).tuple) : failure('Invalid token ID');
			if (fn === 'ownerOf') return positions.has(c.args[0]) ? success(getAddress(positions.get(c.args[0]).owner)) : failure('ERC721: owner query for nonexistent token');
		}
		if (a === lc(D.factory)) {
			if (fn === 'feeAmountTickSpacing') return success(D.feeTickSpacing[c.args[0]] ?? 0);
			if (fn === 'getPool') {
				const pool = [...pools.values()].find((p) => lc(p.token0) === lc(c.args[0]) && lc(p.token1) === lc(c.args[1]) && p.fee === c.args[2] && p.registered !== false);
				return success(pool ? getAddress(pool.registeredAs ?? pool.address) : ZERO);
			}
		}
		if (pools.has(a)) {
			const p = pools.get(a);
			const map = { factory: p.factory, token0: getAddress(p.token0), token1: getAddress(p.token1), fee: p.fee, tickSpacing: p.tickSpacing, slot0: p.slot0, feeGrowthGlobal0X128: p.g0, feeGrowthGlobal1X128: p.g1 };
			if (fn === 'ticks') return success(p.ticks.get(c.args[0]) ?? [0n, 0n, 0n, 0n, 0n, 0n, 0, false]);
			if (Object.hasOwn(map, fn)) return success(map[fn]);
		}
		if (tokens.has(a)) {
			const t = tokens.get(a);
			if (fn === 'decimals') return t.decimals === undefined ? failure('no decimals') : success(t.decimals);
			if (fn === 'symbol') return success(t.symbol);
		}
		if (FEED_BY_PROXY.has(a)) {
			const f = FEED_BY_PROXY.get(a);
			const r = f.latestRoundData;
			if (fn === 'description') return success(f.description);
			if (fn === 'decimals') return success(f.decimals);
			if (fn === 'latestRoundData') return success([B(r.roundId), B(r.answer), B(r.startedAt), B(r.updatedAt), B(r.answeredInRound)]);
		}
		return failure('no contract');
	};
	return {
		calls,
		client: {
			async getChainId() { return chainId; },
			async getBlock() { if (delay === 'block') return new Promise(() => {}); return { number: BLOCK, timestamp: BLOCK_TIME, hash: '0x00' }; },
			async getCode({ address, blockNumber }) {
				assert.equal(blockNumber, BLOCK, 'getCode at the scan block');
				if (lc(address) === lc(D.positionManager)) return code.npm;
				if (lc(address) === lc(D.factory)) return code.factory;
				return undefined;
			},
			async multicall({ contracts, blockNumber, allowFailure }) {
				assert.equal(blockNumber, BLOCK, 'every multicall at the scan block');
				assert.equal(allowFailure, true);
				if (multicallThrows) throw new Error('transport');
				if (delay === 'multicall') return new Promise(() => {});
				calls.push(...contracts);
				const results = contracts.map(answer);
				return shorten ? results.slice(0, -1) : results;
			}
		}
	};
}
const scan = (ids, opts = {}) => {
	const w = world(ids, opts);
	return U.readUniswapV3Positions(WALLET, { client: w.client, now: () => Date.UTC(2026, 9, 21, 11), rpcTimeoutMs: opts.rpcTimeoutMs ?? 2_000, lookupBudgetMs: 5_000 }).then((result) => ({ result, calls: w.calls }));
};

/** Ein gueltiger Rohdatensatz fuer validatePosition, aus einem Live-Vektor. */
function rawFor(id, patch = {}) {
	const v = byId[id];
	const p = v.position;
	return {
		tokenId: B(id),
		owner: WALLET,
		positionManager: D.positionManager,
		position: { token0: p.token0, token1: p.token1, fee: p.fee, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: B(p.liquidity), feeGrowthInside0LastX128: B(p.feeGrowthInside0LastX128), feeGrowthInside1LastX128: B(p.feeGrowthInside1LastX128), tokensOwed0: B(p.tokensOwed0), tokensOwed1: B(p.tokensOwed1) },
		factoryTickSpacing: D.feeTickSpacing[p.fee],
		registeredPool: v.pool,
		pool: { address: v.pool, factory: D.factory, token0: p.token0, token1: p.token1, fee: p.fee, tickSpacing: D.feeTickSpacing[p.fee], sqrtPriceX96: B(v.slot0.sqrtPriceX96), tick: v.slot0.tick, feeGrowthGlobal0X128: B(v.feeGrowthGlobal0X128), feeGrowthGlobal1X128: B(v.feeGrowthGlobal1X128) },
		tickLowerInfo: { feeGrowthOutside0X128: B(v.tickLowerInfo.feeGrowthOutside0X128), feeGrowthOutside1X128: B(v.tickLowerInfo.feeGrowthOutside1X128), initialized: v.tickLowerInfo.initialized },
		tickUpperInfo: { feeGrowthOutside0X128: B(v.tickUpperInfo.feeGrowthOutside0X128), feeGrowthOutside1X128: B(v.tickUpperInfo.feeGrowthOutside1X128), initialized: v.tickUpperInfo.initialized },
		token0Meta: { decimals: v.token0.decimals, symbol: v.token0.symbol },
		token1Meta: { decimals: v.token1.decimals, symbol: v.token1.symbol },
		...patch
	};
}
const validate = (raw, opts = {}) => U.validatePosition(raw, { wallet: WALLET, chainId: 1, ...opts });

const IN = '1387464', IN2 = '1387513', IN3 = '1387263', ABOVE_WBTC = '1387314', ABOVE_USDC = '1380247', ZERO_LIQ = '1387153', BELOW_PAXG = '1383966', BELOW_WETH = '1384767';
// Erwarteter Preis unabhaengig vom Modul: Antwort des Feeds aus dem Mitschnitt; WBTC = WBTC/BTC x BTC/USD / 1e8.
const answerOf = (key) => B(PRICES.feeds[key].onchain.latestRoundData.answer);
const FEED_OF_SYMBOL = { WETH: 'eth-usd', USDC: 'usdc-usd', cbBTC: 'cbbtc-usd', USDT: 'usdt-usd', PAXG: 'paxg-usd' };
const priceOf = (address) => {
	const symbol = Object.entries(PRICES.tokens).find(([, t]) => lc(t.address) === lc(address))[0];
	return symbol === 'WBTC' ? (answerOf('wbtc-btc') * answerOf('btc-usd')) / 10n ** 8n : answerOf(FEED_OF_SYMBOL[symbol]);
};
const PROXIES = Object.values(PRICES.feeds).map((f) => f.directory.proxyAddress);
const usd8 = (amount, decimals, price) => (B(amount) * price) / 10n ** BigInt(decimals);

/* ------------------------------------------------------------- Registry -- */

test('UNI-CANONICAL position manager, factory, WETH9 and init code hash equal the Uniswap SDK and the chain', () => {
	const src = VERIFY.uniswap.sources;
	assert.equal(D.chainId, 1);
	assert.equal(VERIFY.chainId, 1);
	assert.equal(D.factory, src.sdkCoreAddresses.v3CoreFactoryAddress);
	assert.equal(D.positionManager, src.sdkCoreAddresses.nonfungiblePositionManagerAddress);
	assert.equal(D.weth9, src.sdkCoreAddresses.WETH9_chain1);
	assert.equal(D.poolInitCodeHash, src.v3SdkPoolInitCodeHash);
	assert.equal(D.poolInitCodeHash, src.v3PeripheryPoolAddressInitCodeHash);
	for (const field of ['factory', 'positionManager', 'weth9']) assert.equal(D[field], getAddress(D[field]), `${field} checksummed`);
	const npm = VERIFY.uniswap.positionManager;
	assert.deepEqual([npm.factory, npm.WETH9, npm.name, npm.symbol, npm.erc721, npm.erc721Enumerable], [D.factory, D.weth9, 'Uniswap V3 Positions NFT-V1', 'UNI-V3-POS', true, true]);
	assert.equal(npm.code, D.positionManagerCodeHash);
	assert.equal(VERIFY.uniswap.factory.code, D.factoryCodeHash);
	assert.equal(keccak256(CODE.npm), D.positionManagerCodeHash, 'stored runtime code hashes to the pin');
	assert.equal(keccak256(CODE.factory), D.factoryCodeHash);
	assert.deepEqual([VERIFY.uniswap.weth.symbol, VERIFY.uniswap.weth.decimals], ['WETH', 18]);
	// genau die aktiven Gebuehrenstufen, mit dem on-chain gelesenen Abstand
	const tiers = Object.entries(VERIFY.uniswap.factory.feeTiers).filter(([, spacing]) => spacing !== 0);
	assert.deepEqual(Object.fromEntries(tiers.map(([fee, spacing]) => [fee, spacing])), { 100: 1, 500: 10, 3000: 60, 10000: 200 });
	assert.deepEqual({ ...D.feeTickSpacing }, { 100: 1, 500: 10, 3000: 60, 10000: 200 });
	assert.ok(Object.isFrozen(D) && Object.isFrozen(D.feeTickSpacing));
});

test('UNI-POOL-DERIVATION CREATE2 with the pinned init code hash gives exactly the factory pools, and the pools point back', () => {
	assert.equal(VERIFY.uniswap.create2.length, 8);
	for (const pool of VERIFY.uniswap.create2) {
		assert.equal(U.computePoolAddress(pool.token0, pool.token1, pool.fee), pool.factoryGetPool, `${pool.token0}/${pool.token1}/${pool.fee}`);
		assert.equal(pool.getPoolReversedArgs, pool.factoryGetPool, 'factory is symmetric; derivation is not');
		assert.deepEqual([pool.poolFactory, pool.poolToken0, pool.poolToken1, pool.poolFee, pool.tickSpacing], [D.factory, pool.token0, pool.token1, pool.fee, D.feeTickSpacing[pool.fee]]);
	}
	const [first] = VERIFY.uniswap.create2;
	assert.throws(() => U.computePoolAddress(first.token1, first.token0, first.fee), /TOKEN_ORDER/, 'unsorted tokens are rejected, never silently sorted');
	assert.throws(() => U.computePoolAddress(first.token0, first.token0, first.fee), /TOKEN_ORDER/);
	assert.throws(() => U.computePoolAddress(first.token0, 'USDC', first.fee), /TOKEN_INVALID/);
	assert.notEqual(U.computePoolAddress(first.token0, first.token1, 3000), U.computePoolAddress(first.token0, first.token1, 500), 'fee tier is part of the identity');
	for (const p of LIVE.vectors) assert.equal(U.computePoolAddress(p.position.token0, p.position.token1, p.position.fee), getAddress(p.pool), `live ${p.tokenId}`);
});

/* ---------------------------------------------------------------- Nexus -- */

test('UNI-NEXUS product 72 identity is proven exactly by API and on-chain CoverProducts; other Uniswap listings never map', () => {
	const api = VERIFY.nexus.api.product72;
	const chain = VERIFY.nexus.onchain;
	const N = U.NEXUS_UNISWAP_V3;
	assert.deepEqual([api.id, api.name, api.productType, api.category, api.isPrivate, api.isDeprecated, api.metadata], [N.productId, N.name, N.productTypeId, N.category, N.isPrivate, N.isDeprecated, N.productMetadata]);
	assert.deepEqual(api.coverAssets.map((a) => a.assetSymbol), [...N.coverAssets]);
	assert.deepEqual(api.proofOfLossInputTypes, [...N.proofOfLossInputTypes]);
	assert.deepEqual(api.allowedPools, [...N.allowedPools]);
	assert.equal(chain.name72, N.name);
	const [product, type] = chain.productWithType72;
	assert.deepEqual([product.productType, product.coverAssets, product.isDeprecated], [N.productTypeId, N.coverAssetsBitmap, false]);
	assert.deepEqual([0, 6, 7].reduce((bits, id) => bits | (1 << id), 0), N.coverAssetsBitmap, 'bitmap 193 = assets 0 (ETH), 6 (USDC), 7 (cbBTC)');
	assert.equal(type.gracePeriod, N.gracePeriodSec);
	assert.equal(N.gracePeriodSec, 35 * 86_400);
	assert.equal(VERIFY.nexus.api.productType0.gracePeriod, String(N.gracePeriodSec));
	assert.deepEqual([chain.latestMetadata72.ipfsHash, chain.allowedPools72], ['', []], 'no product metadata, no annex');
	assert.deepEqual([chain.typeName0, chain.typeMetadata0.ipfsHash, VERIFY.nexus.wording.cid], [N.productTypeName, N.wordingCid, N.wordingCid]);
	assert.equal(N.annexCid, null);
	assert.equal(VERIFY.nexus.wording.containsPhraseDepositedInTheDesignatedProtocol, false);
	assert.equal(N.mappingClass, 'MATCHED');
	assert.equal(N.runtimeEnabled, true, 'informational quotes only (21.10.2026)');
	// alle Listings mit "Uniswap" im Namen: nur 72 ist Uniswap v3 als Single Protocol Cover
	const listings = VERIFY.nexus.api.productsWithUniswapInName.map((p) => p.id).sort((a, b) => a - b);
	assert.deepEqual(listings, [71, 72, 168, 256]);
	assert.deepEqual(U.OTHER_UNISWAP_LISTINGS.map((p) => p.productId).sort((a, b) => a - b), [71, 168, 256]);
	assert.ok(U.OTHER_UNISWAP_LISTINGS.every((p) => p.class === 'UNSUPPORTED'));
});

/* --------------------------------------------------------------- Mathe -- */

test('UNI-MATH-TICK sqrtRatioAtTick equals the v3-core TickMath snapshot and the bounds', () => {
	const vectors = Object.entries(REF.sqrtRatioAtTick);
	assert.ok(vectors.length >= 20);
	for (const [tick, expected] of vectors) assert.equal(M.sqrtRatioAtTick(Number(tick)).toString(), expected, `tick ${tick}`);
	assert.equal(M.sqrtRatioAtTick(M.MIN_TICK), M.MIN_SQRT_RATIO);
	assert.equal(M.sqrtRatioAtTick(M.MAX_TICK), M.MAX_SQRT_RATIO);
	assert.equal(M.sqrtRatioAtTick(0), M.Q96);
	for (const tick of [M.MIN_TICK - 1, M.MAX_TICK + 1, 1.5, '0', 0n, NaN, null]) assert.throws(() => M.sqrtRatioAtTick(tick), /TICK_OUT_OF_RANGE/, String(tick));
	let previous = 0n;
	for (let tick = -887_000; tick <= 887_000; tick += 17_741) {
		const value = M.sqrtRatioAtTick(tick);
		assert.ok(value > previous, 'strictly increasing');
		previous = value;
	}
});

test('UNI-MATH-SDK below / in / above range equal the v3-sdk Position test vectors', () => {
	const sdk = REF.sdkPosition;
	const sqrtPriceX96 = B(sdk.sqrtPriceX96);
	// aktueller Tick: groesster Tick mit sqrtRatioAtTick(tick) <= sqrtPrice (getTickAtSqrtRatio)
	let lo = M.MIN_TICK, hi = M.MAX_TICK;
	while (lo < hi) { const mid = Math.floor((lo + hi + 1) / 2); if (M.sqrtRatioAtTick(mid) <= sqrtPriceX96) lo = mid; else hi = mid - 1; }
	const tick = lo;
	const usable = Math.round(tick / sdk.tickSpacing) * sdk.tickSpacing;
	for (const c of sdk.cases) {
		const result = M.principalAmounts({ liquidity: B(c.liquidity), tickLower: usable + c.tickLowerOffset * sdk.tickSpacing, tickUpper: usable + c.tickUpperOffset * sdk.tickSpacing, sqrtPriceX96, tick });
		if (c.amount0 !== null) assert.equal(result.amount0.toString(), c.amount0, c.name);
		if (c.amount1 !== null) assert.equal(result.amount1.toString(), c.amount1, c.name);
	}
	const below = M.principalAmounts({ liquidity: 10n ** 20n, tickLower: usable + 10, tickUpper: usable + 20, sqrtPriceX96, tick });
	const inside = M.principalAmounts({ liquidity: 10n ** 20n, tickLower: usable - 20, tickUpper: usable + 20, sqrtPriceX96, tick });
	const above = M.principalAmounts({ liquidity: 10n ** 20n, tickLower: usable - 20, tickUpper: usable - 10, sqrtPriceX96, tick });
	assert.deepEqual([below.rangeState, below.amount0 > 0n, below.amount1], ['BELOW_RANGE', true, 0n], 'current tick below the range -> only token0');
	assert.deepEqual([inside.rangeState, inside.amount0 > 0n, inside.amount1 > 0n], ['IN_RANGE', true, true], 'inside -> token0 + token1');
	assert.deepEqual([above.rangeState, above.amount0, above.amount1 > 0n], ['ABOVE_RANGE', 0n, true], 'current tick above the range -> only token1');
	// Grenzen wie im Pool: tick == tickLower ist in der Spanne (token1 = 0), tick == tickUpper schon darueber (token0 = 0)
	const atLower = M.principalAmounts({ liquidity: 10n ** 20n, tickLower: 0, tickUpper: 60, sqrtPriceX96: M.sqrtRatioAtTick(0), tick: 0 });
	assert.deepEqual([atLower.rangeState, atLower.amount0 > 0n, atLower.amount1], ['IN_RANGE', true, 0n]);
	const atUpper = M.principalAmounts({ liquidity: 10n ** 20n, tickLower: -60, tickUpper: 0, sqrtPriceX96: M.sqrtRatioAtTick(0), tick: 0 });
	assert.deepEqual([atUpper.rangeState, atUpper.amount0, atUpper.amount1 > 0n], ['ABOVE_RANGE', 0n, true]);
	assert.equal(atUpper.amount1, M.amount1Delta(M.sqrtRatioAtTick(-60), M.sqrtRatioAtTick(0), 10n ** 20n));
	// abwaerts genau auf der Grenze geendet: tick = -1 bei sqrtPrice = sqrtRatioAtTick(0) -> noch in der Spanne [-60, 0)
	const justBelow = M.principalAmounts({ liquidity: 10n ** 20n, tickLower: -60, tickUpper: 0, sqrtPriceX96: M.sqrtRatioAtTick(0), tick: -1 });
	assert.deepEqual([justBelow.rangeState, justBelow.amount0, justBelow.amount1], ['IN_RANGE', 0n, atUpper.amount1]);
});

test('UNI-MATH-LIVE principal and uncollected fees equal eth_call decreaseLiquidity/collect on nine live positions', () => {
	const seen = new Set();
	for (const v of LIVE.vectors) {
		const raw = rawFor(v.tokenId);
		const result = validate(raw);
		assert.equal(result.status, 'VALID', `${v.tokenId} ${result.reason}`);
		const expectedPrincipal = v.reference.decreaseLiquidityAll ?? ['0', '0'];
		assert.deepEqual([result.principal.amount0Raw, result.principal.amount1Raw], expectedPrincipal, `${v.tokenId} principal`);
		assert.deepEqual([result.uncollectedFees.amount0Raw, result.uncollectedFees.amount1Raw], v.reference.collectMaxWithoutDecrease, `${v.tokenId} fees`);
		seen.add(result.liquidityState === 'ZERO_LIQUIDITY' ? 'ZERO' : result.rangeState);
		if (result.rangeState === 'BELOW_RANGE' && result.liquidityState === 'ACTIVE') assert.equal(result.principal.amount1Raw, '0');
		if (result.rangeState === 'ABOVE_RANGE') assert.equal(result.principal.amount0Raw, '0');
	}
	assert.deepEqual([...seen].sort(), ['ABOVE_RANGE', 'BELOW_RANGE', 'IN_RANGE', 'ZERO']);
	assert.ok(LIVE.vectors.some((v) => v.reference.collectMaxWithoutDecrease.some((x) => x !== '0')), 'at least one vector with real accrued fees');
});

test('UNI-MATH-BOUNDS huge liquidity, overflow, impossible slot0 and fee-growth wraparound', () => {
	const full = { tickLower: -887_220, tickUpper: 887_220 };
	// groesste Liquiditaet ueber die ganze Spanne, Kurs an beiden Raendern: kein Ueberlauf, exakte Integer
	for (const tick of [M.MIN_TICK, 0, M.MAX_TICK - 1]) {
		const r = M.principalAmounts({ liquidity: M.MAX_UINT128, ...full, sqrtPriceX96: M.sqrtRatioAtTick(tick), tick });
		assert.equal(typeof r.amount0, 'bigint');
		assert.ok(r.amount0 < 1n << 256n && r.amount1 < 1n << 256n);
	}
	for (const liquidity of [M.MAX_UINT128 + 1n, -1n, 1, '1', null]) {
		assert.throws(() => M.principalAmounts({ liquidity, ...full, sqrtPriceX96: M.Q96, tick: 0 }), /LIQUIDITY_INVALID/, String(liquidity));
	}
	assert.throws(() => M.principalAmounts({ liquidity: 1n, tickLower: 10, tickUpper: 10, sqrtPriceX96: M.Q96, tick: 0 }), /TICK_ORDER/);
	assert.throws(() => M.principalAmounts({ liquidity: 1n, tickLower: 20, tickUpper: 10, sqrtPriceX96: M.Q96, tick: 0 }), /TICK_ORDER/);
	assert.throws(() => M.principalAmounts({ liquidity: 1n, tickLower: -887_273, tickUpper: 10, sqrtPriceX96: M.Q96, tick: 0 }), /TICK_OUT_OF_RANGE/);
	// slot0 in sich unmoeglich
	assert.throws(() => M.assertSlot0(M.Q96, 5), /SLOT0_INCONSISTENT/);
	assert.throws(() => M.assertSlot0(M.sqrtRatioAtTick(2), 0), /SLOT0_INCONSISTENT/);
	assert.throws(() => M.assertSlot0(M.MIN_SQRT_RATIO - 1n, M.MIN_TICK), /SQRT_PRICE_OUT_OF_RANGE/);
	assert.throws(() => M.assertSlot0(M.MAX_SQRT_RATIO, M.MAX_TICK), /SQRT_PRICE_OUT_OF_RANGE/);
	assert.throws(() => M.assertSlot0(0n, 0), /SQRT_PRICE_OUT_OF_RANGE/);
	M.assertSlot0(M.sqrtRatioAtTick(1), 0); // Swap endete abwaerts genau auf der Grenze: zulaessig
	M.assertSlot0(M.sqrtRatioAtTick(0), 0);
	// mulDiv wie FullMath: Ueberlauf und Division durch 0 werfen
	assert.throws(() => M.mulDiv(M.MAX_UINT256, 2n, 1n), /MULDIV_OVERFLOW/);
	assert.throws(() => M.mulDiv(1n, 1n, 0n), /MULDIV_INPUT/);
	assert.equal(M.mulDiv(M.MAX_UINT256, M.MAX_UINT256, M.MAX_UINT256), M.MAX_UINT256);
	// Gebuehrenwachstum: Subtraktion modulo 2^256 wie in Solidity <0.8
	const inside = M.feeGrowthInside({ tick: 0, tickLower: -10, tickUpper: 10, feeGrowthGlobal0X128: 5n, feeGrowthGlobal1X128: 0n, lower: { feeGrowthOutside0X128: 10n, feeGrowthOutside1X128: 0n }, upper: { feeGrowthOutside0X128: 0n, feeGrowthOutside1X128: 0n } });
	assert.equal(inside.inside0X128, (1n << 256n) - 5n);
	const fees = M.uncollectedFees({ liquidity: 1n << 127n, feeGrowthInside0LastX128: (1n << 256n) - 15n, feeGrowthInside1LastX128: 0n, tokensOwed0: 1n, tokensOwed1: 0n }, inside);
	assert.equal(fees.amount0, 6n, 'wrapped growth of 10 (x 2^127 / 2^128 = 5) + 1 owed');
	assert.throws(() => M.uncollectedFees({ liquidity: M.Q128, feeGrowthInside0LastX128: 0n, feeGrowthInside1LastX128: 0n, tokensOwed0: 0n, tokensOwed1: 0n }, inside), /POSITION_INVALID/, 'liquidity above uint128');
	assert.throws(() => M.uncollectedFees({ liquidity: M.MAX_UINT128, feeGrowthInside0LastX128: 0n, feeGrowthInside1LastX128: 0n, tokensOwed0: 0n, tokensOwed1: 0n }, { inside0X128: M.MAX_UINT256, inside1X128: 0n }), /FEE_OVERFLOW/);
	assert.throws(() => M.uncollectedFees({ liquidity: 1n, feeGrowthInside0LastX128: 0n, feeGrowthInside1LastX128: 0n, tokensOwed0: M.MAX_UINT128, tokensOwed1: 0n }, { inside0X128: M.Q128, inside1X128: 0n }), /FEE_OVERFLOW/);
	assert.throws(() => M.feeGrowthInside({ tick: 0, tickLower: -1, tickUpper: 1, feeGrowthGlobal0X128: -1n, feeGrowthGlobal1X128: 0n, lower: { feeGrowthOutside0X128: 0n, feeGrowthOutside1X128: 0n }, upper: { feeGrowthOutside0X128: 0n, feeGrowthOutside1X128: 0n } }), /FEE_GROWTH_INVALID/);
	assert.throws(() => M.amount0Delta(0n, M.Q96, 1n), /ZERO_SQRT_PRICE/);
});

/* ---------------------------------------------------------- Validierung -- */

test('UNI-VALIDATE wrong chain, manager, owner, factory, pool, fee tier, ticks, liquidity and metadata are rejected', () => {
	assert.equal(validate(rawFor(IN)).status, 'VALID');
	const reason = (patch, opts) => validate(rawFor(IN, patch), opts).reason;
	const pos = (fields) => ({ position: { ...rawFor(IN).position, ...fields } });
	const pool = (fields) => ({ pool: { ...rawFor(IN).pool, ...fields } });
	for (const chainId of [10, 42161, '1', 1n, undefined]) assert.equal(reason({}, { chainId }), 'WRONG_CHAIN', String(chainId));
	assert.equal(reason({ positionManager: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1' }), 'WRONG_POSITION_MANAGER', 'a look-alike manager (other chain / fork)');
	assert.equal(reason({ owner: OTHER }), 'OWNER_MISMATCH', 'transferred NFT');
	assert.equal(reason({ owner: undefined }), 'OWNER_MISMATCH');
	assert.equal(reason({ tokenId: 5 }), 'TOKEN_ID_INVALID');
	assert.equal(reason({ position: null }), 'POSITION_MALFORMED');
	assert.equal(reason(pos({ tokensOwed0: -1n })), 'POSITION_MALFORMED');
	const t0 = rawFor(IN).position.token0, t1 = rawFor(IN).position.token1;
	assert.equal(reason(pos({ token0: t1, token1: t0 })), 'TOKEN_ORDER');
	assert.equal(reason(pos({ token0: ZERO })), 'TOKEN_INVALID');
	assert.equal(reason(pos({ token1: 'USDT' })), 'TOKEN_INVALID');
	for (const fee of [2500, 0, 3000.5, '3000', 1]) assert.equal(reason(pos({ fee })), 'FEE_TIER_INVALID', String(fee));
	assert.equal(reason({ factoryTickSpacing: 50 }), 'FEE_TIER_INVALID', 'factory reports another spacing');
	assert.equal(reason({ factoryTickSpacing: 0 }), 'FEE_TIER_INVALID', 'tier disabled at the factory');
	const { tickLower, tickUpper } = rawFor(IN).position;
	assert.equal(reason(pos({ tickLower: tickUpper, tickUpper: tickLower })), 'TICKS_INVALID');
	assert.equal(reason(pos({ tickUpper: tickLower })), 'TICKS_INVALID');
	assert.equal(reason(pos({ tickLower: tickLower + 1 })), 'TICKS_INVALID', 'not on the tick spacing');
	assert.equal(reason(pos({ tickUpper: 887_280 })), 'TICKS_INVALID');
	for (const liquidity of [-1n, M.MAX_UINT128 + 1n, 1, null]) assert.equal(reason(pos({ liquidity })), 'LIQUIDITY_INVALID', String(liquidity));
	assert.equal(reason({ registeredPool: ZERO }), 'POOL_NOT_REGISTERED', 'fake NFT: no pool at the factory');
	assert.equal(reason({ registeredPool: undefined }), 'POOL_NOT_REGISTERED');
	assert.equal(reason({ registeredPool: byId[ABOVE_USDC].pool }), 'NON_CANONICAL_POOL', 'factory names another pool than CREATE2');
	assert.equal(reason(pool({ address: byId[ABOVE_USDC].pool })), 'POOL_MISMATCH');
	assert.equal(reason(pool({ factory: OTHER })), 'WRONG_FACTORY');
	assert.equal(reason(pool({ token0: OTHER })), 'POOL_MISMATCH');
	assert.equal(reason(pool({ token1: t0 })), 'POOL_MISMATCH');
	assert.equal(reason(pool({ fee: 500 })), 'POOL_MISMATCH');
	assert.equal(reason(pool({ tickSpacing: 10 })), 'POOL_MISMATCH');
	assert.equal(reason(pool({ sqrtPriceX96: undefined })), 'POOL_STATE_INVALID');
	assert.equal(reason(pool({ tick: rawFor(IN).pool.tick + 50 })), 'MATH_SLOT0_INCONSISTENT', 'impossible sqrtPrice/tick state');
	assert.equal(reason({ tickLowerInfo: { ...rawFor(IN).tickLowerInfo, initialized: false } }), 'POOL_STATE_INVALID', 'active liquidity on an uninitialized tick');
	assert.equal(reason({ token0Meta: { decimals: null, symbol: 'WETH' } }), 'TOKEN_METADATA_MISSING');
	assert.equal(reason({ token1Meta: { decimals: 77, symbol: 'USDT' } }), 'TOKEN_METADATA_MISSING');
	assert.equal(reason({ token1Meta: undefined }), 'TOKEN_METADATA_MISSING');
	// Symbole sind nur Anzeige: ein Fremdsymbol aendert nichts an Identitaet oder Werten
	const renamed = validate(rawFor(IN, { token1Meta: { decimals: 6, symbol: 'USDC' } }));
	assert.equal(renamed.token1.address, getAddress(t1));
	assert.equal(renamed.token1.symbol, 'USDC');
	assert.equal(validate(rawFor(IN, { token1Meta: { decimals: 6, symbol: '<script>' } })).token1.symbol, `${getAddress(t1).slice(0, 6)}…${getAddress(t1).slice(-4)}`);
});

/* ---------------------------------------------------------------- Leser -- */

test('UNI-READER multiple NFTs: same pool twice, two fee tiers, three pairs, 6/8/18 decimals, each kept apart and priced by address', async () => {
	const ids = [IN, IN2, IN3, ABOVE_WBTC, ABOVE_USDC, BELOW_WETH];
	const { result, calls } = await scan(ids);
	assert.equal(result.status, 'OK', result.reason);
	assert.equal(result.blockNumber, String(BLOCK));
	assert.deepEqual(result.positions.map((p) => [p.tokenId, p.status]), ids.map((id) => [id, 'VALID']));
	const pools = new Set(result.positions.map((p) => p.pool));
	assert.equal(pools.size, 4);
	assert.equal(result.positions.filter((p) => p.pool === result.positions[0].pool).length, 3, 'three NFTs in one pool stay three positions');
	assert.deepEqual([...new Set(result.positions.map((p) => p.fee))].sort((a, b) => a - b), [500, 3000]);
	assert.deepEqual([...new Set(result.positions.flatMap((p) => [p.token0.decimals, p.token1.decimals]))].sort((a, b) => a - b), [6, 8, 18]);
	for (const [i, id] of ids.entries()) {
		const v = byId[id];
		const e = result.exposures[i];
		const [a0, a1] = v.reference.decreaseLiquidityAll;
		const legs = [[a0, v.token0], [a1, v.token1]].map(([amount, token]) => (amount === '0' ? 0n : usd8(amount, token.decimals, priceOf(token.address))));
		assert.equal(e.suggestedExposureUsd8, String(legs[0] + legs[1]), `exposure ${id} from the eth_call reference and the Chainlink price`);
		assert.equal(e.pricingStatus, 'PRICED');
		assert.deepEqual([e.blockNumber, e.blockTimestamp], [String(BLOCK), String(BLOCK_TIME)], 'exposure carries its block');
		assert.ok(e.priceSources.every((source) => PROXIES.some((proxy) => source.feeds.includes(proxy))), 'priced by a pinned Chainlink feed');
		assert.equal(e.feesIncluded, false);
		assert.equal(e.suggestedExposureUsd, e.principalExposureUsd, 'suggested = principal only');
	}
	// WETH/kpdWBTC unterhalb der Spanne: nur WETH vorhanden, der unbekannte Token braucht keinen Preis
	const weird = result.exposures[5];
	assert.deepEqual([weird.amount1, weird.pricingStatus, weird.value1Usd], ['0', 'PRICED', '0']);
	assert.deepEqual([result.priceBook[lc(byId[BELOW_WETH].token1.address)].status, result.priceBook[lc(byId[BELOW_WETH].token1.address)].reason], ['PRICE_UNAVAILABLE', 'UNSUPPORTED_TOKEN'], 'zero leg: missing price does not block');
	assert.equal(result.blockTimestamp, String(BLOCK_TIME));
	assert.ok(Object.values(result.priceBook).every((entry) => entry.blockNumber === String(BLOCK)), 'prices from the scan block');
	// Referenzpreise der Nexus-Cover-Assets (ETH, USDC, cbBTC) werden im selben Block mitgelesen
	for (const ref of Object.values(U.COVER_ASSET_REFERENCES)) assert.equal(result.priceBook[lc(ref.token)].status, 'PRICE_OK', ref.symbol);
	const sum = result.exposures.reduce((total, e) => total + B(e.suggestedExposureUsd8), 0n);
	assert.deepEqual([result.aggregate.status, result.aggregate.positions, result.aggregate.countedPositions, result.aggregate.activePositions, result.aggregate.pricedPositions, result.aggregate.unpricedPositions], ['COMPLETE', 6, 6, 6, 6, 0]);
	assert.equal(result.aggregate.suggestedExposureUsd, formatUnits(sum, 8), 'exact sum of the six valid positions');
	assert.equal(result.aggregate.suggestedExposureUsd, result.aggregate.countedExposureUsd);
	// nur gepruefte Vertraege, nur lesende Funktionen
	const allowed = new Set([D.positionManager, D.factory, ...PROXIES, ...pools, ...result.positions.flatMap((p) => [p.token0.address, p.token1.address])].map(lc));
	assert.ok(calls.every((c) => allowed.has(lc(c.address))), 'only canonical contracts, derived pools, the position tokens and pinned Chainlink proxies');
	assert.ok(!calls.some((c) => lc(c.address) === lc(CORE.oracle) || lc(c.address) === lc(CORE.pool)), 'Aave is not the price source');
	const views = new Set(['factory', 'WETH9', 'supportsInterface', 'balanceOf', 'tokenOfOwnerByIndex', 'positions', 'ownerOf', 'feeAmountTickSpacing', 'getPool', 'token0', 'token1', 'fee', 'tickSpacing', 'slot0', 'feeGrowthGlobal0X128', 'feeGrowthGlobal1X128', 'ticks', 'decimals', 'symbol', 'description', 'latestRoundData']);
	assert.deepEqual(calls.filter((c) => !views.has(c.functionName)).map((c) => c.functionName), []);
	assert.ok(calls.every((c) => c.abi.find((f) => f.name === c.functionName).stateMutability === 'view'));
});

test('UNI-READER zero liquidity: closed NFT is not active principal; fees left after removal stay visible but excluded', async () => {
	const tuple = positionTuple(byId[ZERO_LIQ].position);
	tuple[10] = 1_234_567n; // USDC 6 Stellen
	tuple[11] = 10n ** 15n; // WETH
	const { result } = await scan([ZERO_LIQ, '999000001', IN], { extraPositions: { 999000001: { owner: WALLET, tuple } } });
	assert.equal(result.status, 'OK');
	const [closed, closedWithFees, active] = result.exposures;
	for (const e of [closed, closedWithFees]) {
		assert.deepEqual([e.liquidityState, e.principalExposureUsd, e.suggestedExposureUsd, e.pricingStatus, e.amount0, e.amount1], ['ZERO_LIQUIDITY', '0', '0', 'NOT_REQUIRED', '0', '0']);
	}
	assert.deepEqual([closedWithFees.fees0, closedWithFees.fees1, closedWithFees.feesPricingStatus], ['1.234567', '0.001', 'PRICED']);
	assert.ok(Number(closedWithFees.feesUsd) > 0);
	assert.equal(active.liquidityState, 'ACTIVE');
	assert.deepEqual([result.aggregate.positions, result.aggregate.activePositions, result.aggregate.status], [3, 1, 'COMPLETE']);
	assert.equal(result.aggregate.suggestedExposureUsd, active.suggestedExposureUsd, 'fees of the closed NFT are not added');
	// eine Wallet nur mit geschlossenem NFT hat keine Exposure-Bereitschaft
	const onlyClosed = (await scan([ZERO_LIQ])).result;
	assert.equal(U.uniswapV3Readiness(onlyClosed).exposureReady, false);
});

test('UNI-READER PAXG is priced by its own feed; one stale required price makes the NFT unpriced and the sum incomplete', async () => {
	const priced = (await scan([IN, BELOW_PAXG])).result;
	const paxgAddress = getAddress(byId[BELOW_PAXG].token0.address);
	assert.deepEqual([priced.exposures[1].pricingStatus, priced.exposures[1].priceSources[0].sourceAddress], ['PRICED', P.CHAINLINK_FEEDS['paxg-usd'].proxy]);
	assert.equal(priced.exposures[1].suggestedExposureUsd8, String(usd8(byId[BELOW_PAXG].reference.decreaseLiquidityAll[0], 18, answerOf('paxg-usd'))));
	assert.equal(priced.aggregate.status, 'COMPLETE');

	// PAXG-Runde aelter als 86400 + 4320 s: diese Position ohne Preis, die andere bleibt gezaehlt
	const stale = (c) => (c.functionName === 'latestRoundData' && lc(c.address) === lc(P.CHAINLINK_FEEDS['paxg-usd'].proxy) ? { status: 'success', result: [5n, 412282751395n, 1n, BLOCK_TIME - 90_721n, 5n] } : undefined);
	const { result } = await scan([IN, BELOW_PAXG], { patch: stale });
	assert.equal(result.status, 'OK');
	const paxg = result.exposures[1];
	assert.deepEqual([paxg.pricingStatus, paxg.principalExposureUsd, paxg.suggestedExposureUsd, paxg.counted], ['UNKNOWN', null, null, false]);
	assert.deepEqual(paxg.missingPrices, [{ token: paxgAddress, status: 'PRICE_STALE', reason: 'paxg-usd:OLDER_THAN_HEARTBEAT' }]);
	assert.deepEqual([result.aggregate.status, result.aggregate.suggestedExposureUsd, result.aggregate.excluded], ['INCOMPLETE', null, [{ tokenId: BELOW_PAXG, reason: 'PRICING_UNKNOWN' }]]);
	assert.deepEqual([result.aggregate.positions, result.aggregate.activePositions, result.aggregate.pricedPositions, result.aggregate.unpricedPositions, [...result.aggregate.incompleteReasons]], [2, 2, 1, 1, ['PRICING_UNKNOWN']]);
	assert.equal(result.aggregate.countedExposureUsd, result.exposures[0].suggestedExposureUsd, 'valid positions are still summed, but not suggested');
	assert.equal(U.uniswapV3Readiness(result).pricingReady, false);
	// eine Sekunde frischer: wieder bewertet (Grenze genau bei maxAge)
	const edge = (c) => (c.functionName === 'latestRoundData' && lc(c.address) === lc(P.CHAINLINK_FEEDS['paxg-usd'].proxy) ? { status: 'success', result: [5n, 412282751395n, 1n, BLOCK_TIME - 90_720n, 5n] } : undefined);
	assert.equal((await scan([BELOW_PAXG], { patch: edge })).result.exposures[0].pricingStatus, 'PRICED');

	// gleicher Name/Symbol, andere Adresse: ein falscher "USDC" (6 Stellen) neben WETH bekommt keinen USDC-Preis
	const FAKE_USDC = '0x00000000000000000000000000000000000fa4e1';
	const [token0, token1] = BigInt(FAKE_USDC) < BigInt(D.weth9) ? [FAKE_USDC, D.weth9] : [D.weth9, FAKE_USDC];
	const fakePool = U.computePoolAddress(token0, token1, 3000);
	const real = byId[IN];
	const tuple = positionTuple({ ...real.position, token0, token1, feeGrowthInside0LastX128: '0', feeGrowthInside1LastX128: '0' });
	const flat = [1n, 0n, 0n, 0n, 0n, 0n, 0, true];
	const { result: spoof } = await scan(['999000002'], {
		extraPositions: { 999000002: { owner: WALLET, tuple } },
		extraTokens: { [FAKE_USDC]: { address: FAKE_USDC, decimals: 6, symbol: 'USDC' } },
		extraPools: { [fakePool]: { address: fakePool, factory: D.factory, token0, token1, fee: 3000, tickSpacing: 60, slot0: [B(real.slot0.sqrtPriceX96), real.slot0.tick, 0, 1, 1, 0, true], g0: 0n, g1: 0n, ticks: new Map([[real.position.tickLower, flat], [real.position.tickUpper, flat]]) } }
	});
	assert.equal(spoof.positions[0].status, 'VALID');
	const fake = spoof.positions[0][lc(token0) === lc(FAKE_USDC) ? 'token0' : 'token1'];
	assert.deepEqual([fake.symbol, fake.address], ['USDC', getAddress(FAKE_USDC)]);
	assert.deepEqual([spoof.priceBook[lc(FAKE_USDC)].status, spoof.priceBook[lc(FAKE_USDC)].reason], ['PRICE_UNAVAILABLE', 'UNSUPPORTED_TOKEN']);
	assert.equal(spoof.exposures[0].pricingStatus, 'UNKNOWN');
	assert.equal(spoof.exposures[0].suggestedExposureUsd, null);
	assert.ok(!Object.keys(spoof.priceBook).includes('usdc'), 'never keyed by symbol');
	assert.ok(spoof.exposures[0].missingPrices.some((m) => m.token === getAddress(FAKE_USDC)));
	// kein Rueckgriff auf den Pool: trotz bekanntem WETH-Preis und Pool-Kurs kein USD-Wert fuer den falschen USDC
	assert.equal(spoof.exposures[0][lc(token0) === lc(FAKE_USDC) ? 'value0Usd' : 'value1Usd'], null);
});

test('UNI-READER transferred, burned, fake and cross-pool NFTs are rejected individually or fail the scan closed', async () => {
	// uebertragen: tokenOfOwnerByIndex nennt die Wallet, ownerOf im selben Block nicht
	const moved = await scan([IN, IN2], { patch: (c) => (c.functionName === 'ownerOf' && c.args[0] === B(IN2) ? { status: 'success', result: OTHER } : undefined) });
	assert.deepEqual(moved.result.positions.map((p) => [p.tokenId, p.status, p.reason]), [[IN, 'VALID', undefined], [IN2, 'INVALID', 'OWNER_MISMATCH']]);
	assert.equal(moved.result.aggregate.status, 'INCOMPLETE');
	// verbrannt / nicht existent: positions() revertiert -> nicht vollstaendig lesbar -> ganzer Scan UNAVAILABLE
	const burned = await scan([IN, '424242424242']);
	assert.deepEqual([burned.result.status, burned.result.reason], ['UNAVAILABLE', 'POSITION_READ_FAILED']);
	assert.equal(burned.result.positions, undefined, 'never reported as "no position"');
	// gefaelscht: Tokenpaar/Stufe ohne Pool bei der Factory
	const FAKE = '0x00000000000000000000000000000000000fa4e2';
	const fakeFirst = BigInt(FAKE) < BigInt(D.weth9);
	const fakeTuple = positionTuple({ ...byId[IN].position, token0: fakeFirst ? FAKE : D.weth9, token1: fakeFirst ? D.weth9 : FAKE });
	const fake = await scan(['999000003'], { extraPositions: { 999000003: { owner: WALLET, tuple: fakeTuple } }, extraTokens: { [FAKE]: { decimals: 18, symbol: 'WETH' } } });
	assert.deepEqual(fake.result.positions.map((p) => [p.status, p.reason]), [['INVALID', 'POOL_NOT_REGISTERED']]);
	// Factory nennt einen anderen Pool als die CREATE2-Ableitung
	const swapped = await scan([IN], { patch: (c) => (c.functionName === 'getPool' ? { status: 'success', result: getAddress(byId[ABOVE_USDC].pool) } : undefined) });
	assert.deepEqual(swapped.result.positions.map((p) => p.reason), ['NON_CANONICAL_POOL']);
	// Pool antwortet mit anderem Token oder anderer Factory
	const mismatch = await scan([IN], { patch: (c) => (c.functionName === 'token1' && lc(c.address) === lc(byId[IN].pool) ? { status: 'success', result: getAddress(byId[ABOVE_USDC].position.token0) } : undefined) });
	assert.deepEqual(mismatch.result.positions.map((p) => p.reason), ['POOL_MISMATCH']);
	const foreign = await scan([IN], { patch: (c) => (c.functionName === 'factory' && lc(c.address) === lc(byId[IN].pool) ? { status: 'success', result: OTHER } : undefined) });
	assert.deepEqual(foreign.result.positions.map((p) => p.reason), ['WRONG_FACTORY']);
	// unbekannte Gebuehrenstufe und abweichender Abstand
	const tier = positionTuple({ ...byId[IN].position, fee: 2500 });
	const odd = await scan(['999000004'], { extraPositions: { 999000004: { owner: WALLET, tuple: tier } } });
	assert.deepEqual(odd.result.positions.map((p) => p.reason), ['FEE_TIER_INVALID']);
	const spacing = await scan([IN], { patch: (c) => (c.functionName === 'feeAmountTickSpacing' && c.args[0] === 3000 ? { status: 'success', result: 50 } : undefined) });
	assert.deepEqual(spacing.result.positions.map((p) => p.reason), ['FEE_TIER_INVALID']);
	// fehlende Token-Metadaten
	const nodec = await scan([IN], { patch: (c) => (c.functionName === 'decimals' && lc(c.address) === lc(D.weth9) ? { status: 'failure', error: new Error('x') } : undefined) });
	assert.deepEqual(nodec.result.positions.map((p) => p.reason), ['TOKEN_METADATA_MISSING']);
});

test('UNI-READER wrong chain, wrong contracts, partial multicall, timeouts and limits fail closed', async () => {
	const reason = async (ids, opts) => { const { result } = await scan(ids, opts); assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.positions, undefined); return result.reason; };
	assert.equal(await reason([IN], { chainId: 10 }), 'WRONG_CHAIN');
	assert.equal(await reason([IN], { chainId: 8453 }), 'WRONG_CHAIN');
	assert.equal(await reason([IN], { code: { ...CODE, npm: `${CODE.npm.slice(0, -2)}00` } }), 'WRONG_POSITION_MANAGER', 'bytecode differs');
	assert.equal(await reason([IN], { code: { ...CODE, factory: '0x' } }), 'WRONG_FACTORY');
	assert.equal(await reason([IN], { patch: (c) => (c.functionName === 'factory' && lc(c.address) === lc(D.positionManager) ? { status: 'success', result: OTHER } : undefined) }), 'WRONG_FACTORY');
	assert.equal(await reason([IN], { patch: (c) => (c.functionName === 'WETH9' ? { status: 'success', result: OTHER } : undefined) }), 'WRONG_POSITION_MANAGER');
	assert.equal(await reason([IN], { patch: (c) => (c.functionName === 'supportsInterface' ? { status: 'success', result: false } : undefined) }), 'NOT_ENUMERABLE');
	assert.equal(await reason([IN], { patch: (c) => (c.functionName === 'balanceOf' ? { status: 'failure', error: new Error('x') } : undefined) }), 'CALL_FAILED');
	assert.equal(await reason([IN, IN2], { patch: (c) => (c.functionName === 'tokenOfOwnerByIndex' && c.args[1] === 1n ? { status: 'failure', error: new Error('x') } : undefined) }), 'ENUMERATION_FAILED');
	assert.equal(await reason([IN, IN], {}), 'ENUMERATION_FAILED', 'duplicate token id from enumeration');
	assert.equal(await reason([IN], { shorten: true }), 'INCOMPLETE_RESULT', 'partial multicall');
	assert.equal(await reason([IN], { multicallThrows: true }), 'RPC_FAILED');
	assert.equal(await reason([IN], { delay: 'multicall', rpcTimeoutMs: 30 }), 'RPC_TIMEOUT');
	assert.equal(await reason([IN], { delay: 'block', rpcTimeoutMs: 30 }), 'RPC_TIMEOUT');
	const many = Array.from({ length: U.LIMITS.maxPositionsPerWallet + 1 }, (_, i) => String(1_000_000 + i));
	assert.equal(await reason(many, {}), 'POSITION_LIMIT');
	// Teilausfall bei einem Pool: diese Position UNAVAILABLE, die Summe unvollstaendig, nie "0"
	const { result } = await scan([IN, ABOVE_USDC], { patch: (c) => (c.functionName === 'slot0' && lc(c.address) === lc(byId[ABOVE_USDC].pool) ? { status: 'failure', error: new Error('x') } : undefined) });
	assert.deepEqual(result.positions.map((p) => [p.status, p.reason]), [['VALID', undefined], ['UNAVAILABLE', 'POOL_READ_FAILED']]);
	assert.deepEqual([result.aggregate.status, result.aggregate.suggestedExposureUsd], ['INCOMPLETE', null]);
	// Preis-Feed faellt aus oder liefert Unsinn: kein Vorschlag
	const ethFeed = lc(P.CHAINLINK_FEEDS['eth-usd'].proxy);
	const feedPatch = (functionName, response) => (c) => (c.functionName === functionName && lc(c.address) === ethFeed ? response : undefined);
	const noPrice = (await scan([IN], { patch: feedPatch('latestRoundData', { status: 'failure', error: new Error('x') }) })).result;
	assert.deepEqual([noPrice.exposures[0].pricingStatus, noPrice.exposures[0].suggestedExposureUsd, noPrice.priceBook[lc(D.weth9)].reason], ['UNKNOWN', null, 'eth-usd:FEED_READ_FAILED']);
	for (const [fn, result, reason] of [
		['latestRoundData', [9n, 0n, 1n, BLOCK_TIME - 10n, 9n], 'eth-usd:NON_POSITIVE_ANSWER'],
		['latestRoundData', [9n, -1n, 1n, BLOCK_TIME - 10n, 9n], 'eth-usd:NON_POSITIVE_ANSWER'],
		['latestRoundData', [9n, 245545211980n, 1n, BLOCK_TIME + 1n, 9n], 'eth-usd:UPDATED_IN_FUTURE'],
		['latestRoundData', [9n, 245545211980n, 0n, 0n, 9n], 'eth-usd:ROUND_INCOMPLETE'],
		['description', 'ETH / EUR', 'eth-usd:DESCRIPTION_MISMATCH'],
		['decimals', 18, 'eth-usd:DECIMALS_MISMATCH']
	]) {
		const bad = (await scan([IN], { patch: feedPatch(fn, { status: 'success', result }) })).result;
		assert.deepEqual([bad.exposures[0].pricingStatus, bad.exposures[0].suggestedExposureUsd, bad.priceBook[lc(D.weth9)].reason, bad.aggregate.status], ['UNKNOWN', null, reason, 'INCOMPLETE'], reason);
	}
	// leere Wallet: OK und vollstaendig, Summe 0, aber nicht exposure-bereit
	const empty = (await scan([])).result;
	assert.deepEqual([empty.status, empty.positions.length, empty.aggregate.status, empty.aggregate.suggestedExposureUsd], ['OK', 0, 'COMPLETE', '0']);
	assert.equal(U.uniswapV3Readiness(empty).exposureReady, false);
	await assert.rejects(U.readUniswapV3Positions('vitalik.eth', { client: world([]).client }), /invalid wallet/);
});

/* ----------------------------------------------- Exposure und Readiness -- */

test('UNI-EXPOSURE definition, principal only, fees separate, invalid positions never counted', async () => {
	assert.equal(U.EXPOSURE_MODEL, 'UNISWAP_V3_LP_EXPOSURE_V1');
	assert.equal(U.EXPOSURE_DEFINITION, 'current estimated economic value of assets represented by the detected LP position');
	assert.deepEqual([...U.EXPOSURE_IS_NOT], ['guaranteed claimable amount', 'insured value', 'protection against impermanent loss', 'protection against normal market losses']);
	const { result } = await scan([IN]);
	const e = result.exposures[0];
	for (const key of ['protocol', 'chainId', 'tokenId', 'pool', 'token0', 'token1', 'amount0', 'amount1', 'value0Usd', 'value1Usd', 'principalExposureUsd', 'feesUsd', 'suggestedExposureUsd', 'pricingStatus']) assert.ok(Object.hasOwn(e, key), key);
	assert.deepEqual([e.protocol, e.chainId, e.model], ['Uniswap v3', 1, 'UNISWAP_V3_LP_EXPOSURE_V1']);
	assert.ok(Number(e.feesUsd) > 0, 'this live position has accrued fees');
	assert.equal(e.suggestedExposureUsd, e.principalExposureUsd);
	assert.notEqual(e.suggestedExposureUsd, String(Number(e.principalExposureUsd) + Number(e.feesUsd)));
	for (const value of [e.amount0, e.value0Usd, e.suggestedExposureUsd]) assert.equal(typeof value, 'string', 'decimal strings, no floats');
	for (const position of [{ status: 'INVALID', tokenId: '1', reason: 'OWNER_MISMATCH' }, { status: 'UNAVAILABLE', tokenId: '2', reason: 'POOL_READ_FAILED' }, null, { status: 'valid' }]) {
		const x = U.computeUniswapLpExposure(position, result.priceBook);
		assert.deepEqual([x.counted, x.suggestedExposureUsd, x.pricingStatus], [false, null, 'NOT_APPLICABLE']);
	}
	// ein Preis, der nicht zur exakten Adresse gehoert, gilt nicht
	const forged = { ...result.priceBook, [lc(D.weth9)]: { ...result.priceBook[lc(D.weth9)], token: OTHER } };
	assert.equal(U.computeUniswapLpExposure(result.positions[0], forged).pricingStatus, 'UNKNOWN');
	assert.equal(U.computeUniswapLpExposure(result.positions[0], {}).pricingStatus, 'UNKNOWN');
	assert.equal(U.computeUniswapLpExposure(result.positions[0], { ...result.priceBook, [lc(D.weth9)]: { ...result.priceBook[lc(D.weth9)], priceUsd8: 245545211980 } }).pricingStatus, 'UNKNOWN', 'number price is not accepted');
	assert.equal(U.computeUniswapLpExposure(result.positions[0], { ...result.priceBook, [lc(D.weth9)]: { ...result.priceBook[lc(D.weth9)], chainId: 10 } }).pricingStatus, 'UNKNOWN', 'price from another chain');
	// selber Block: ein Preis aus einem anderen Block gilt nicht fuer diese Position
	const otherBlock = { ...result.priceBook, [lc(D.weth9)]: { ...result.priceBook[lc(D.weth9)], blockNumber: String(BLOCK - 1n) } };
	const moved = U.computeUniswapLpExposure(result.positions[0], otherBlock);
	assert.deepEqual([moved.pricingStatus, moved.missingPrices[0].reason], ['UNKNOWN', 'NOT_SAME_BLOCK']);
	assert.equal(U.computeUniswapLpExposure({ ...result.positions[0], blockNumber: null }, result.priceBook).pricingStatus, 'UNKNOWN', 'position without block');
	const agg = U.aggregateUniswapLpExposure(result.exposures, { scanStatus: 'UNAVAILABLE' });
	assert.equal(agg.suggestedExposureUsd, null, 'never a sum for an unreadable scan');
});

test('UNI-READINESS detection alone never makes a quote ready, even with MATCHED mapping and a complete exposure', async () => {
	const { result } = await scan([IN, ABOVE_WBTC]);
	const r = U.uniswapV3Readiness(result);
	assert.deepEqual([r.deploymentClass, r.nexusMappingClass, r.positionValid, r.exposureReady], ['CANONICAL', 'MATCHED', true, true]);
	assert.deepEqual([r.pricingReady, r.capacityReady, r.quoteDataReady, r.termsReady, r.proofOfLossReady, r.quoteReady, r.purchaseReady], [true, false, false, false, false, false, false]);
	assert.deepEqual([...r.blockers], ['CAPACITY_NOT_VERIFIED', 'QUOTE_DATA_NOT_READY', ...U.PHASE_BLOCKERS], 'detection alone never verifies Nexus data');
	assert.deepEqual([...U.PHASE_BLOCKERS], ['NEXUS_TERMS_INTERPRETATION_UNCONFIRMED', 'NEXUS_PROOF_OF_LOSS_UNCONFIRMED', 'WALLET_EXECUTION_NOT_AVAILABLE']);
	for (const position of result.positions) assert.deepEqual(U.uniswapNexusMapping(position), { mappingClass: 'MATCHED', productId: 72, reason: 'CANONICAL_DEPLOYMENT_PRODUCT_72', quoteEligible: true });
	assert.equal(U.uniswapNexusMapping({ ...result.positions[0], chainId: 10 }).mappingClass, 'UNSUPPORTED');
	assert.equal(U.uniswapNexusMapping({ ...result.positions[0], positionManager: OTHER }).mappingClass, 'AMBIGUOUS');
	assert.equal(U.uniswapNexusMapping({ ...result.positions[0], deploymentKey: 'uniswap-v3-arbitrum' }).mappingClass, 'AMBIGUOUS');
	// andere Versionen und Vaults: nie Produkt 72
	for (const [deploymentKey, reason] of [['uniswap-v2-ethereum', 'OTHER_PROTOCOL_VERSION'], ['uniswap-v4-ethereum', 'OTHER_PROTOCOL_VERSION'], ['beefy-clm-uniswap-v3-ethereum', 'VAULT_OR_WRAPPER']]) {
		assert.deepEqual(U.uniswapNexusMapping({ ...result.positions[0], deploymentKey }), { mappingClass: 'UNSUPPORTED', productId: null, reason, quoteEligible: false }, deploymentKey);
	}
	// Pool, der nicht die CREATE2-Ableitung ist (gefaelschter Pool im Positionsobjekt)
	assert.deepEqual([U.uniswapNexusMapping({ ...result.positions[0], pool: byId[ABOVE_USDC].pool }).mappingClass, U.uniswapNexusMapping({ ...result.positions[0], pool: byId[ABOVE_USDC].pool }).reason], ['AMBIGUOUS', 'NON_CANONICAL_POOL']);
	assert.equal(U.uniswapNexusMapping({ ...result.positions[0], fee: 500 }).reason, 'NON_CANONICAL_POOL');
	assert.equal(U.uniswapNexusMapping({ ...result.positions[0], token0: { ...result.positions[0].token0, address: OTHER } }).reason, 'NON_CANONICAL_POOL');
	assert.equal(U.uniswapNexusMapping({ status: 'INVALID' }).mappingClass, 'UNSUPPORTED');
	// auch ein konstruiert perfekter Scan bleibt ohne Quote
	const perfect = { ...result, aggregate: { status: 'COMPLETE' } };
	assert.equal(U.uniswapV3Readiness(perfect).quoteReady, false);
	for (const input of [null, undefined, {}, { status: 'UNAVAILABLE' }, { status: 'OK', positions: 'x' }]) {
		const x = U.uniswapV3Readiness(input);
		assert.equal(x.quoteReady, false);
		assert.ok(x.blockers.length >= U.PHASE_BLOCKERS.length);
	}
	const bad = await scan([IN, BELOW_PAXG], { patch: (c) => (c.functionName === 'latestRoundData' && lc(c.address) === lc(P.CHAINLINK_FEEDS['paxg-usd'].proxy) ? { status: 'failure', error: new Error('x') } : undefined) });
	assert.ok(U.uniswapV3Readiness(bad.result).blockers.includes('EXPOSURE_NOT_READY'));
	assert.ok(U.uniswapV3Readiness(bad.result).blockers.includes('PRICING_INCOMPLETE'));
	assert.ok(U.uniswapV3SupportMatrix().every((row) => row.quoteReady === false && row.purchaseReady === false && row.productionEnabled === true && row.informationalQuote === true && row.quoteDataPath === 'PRODUCTION_READ_ONLY' && row.usdFromPoolSpotPrice === false && row.feesInSuggestedExposure === false && row.aggregateQuote === false));
});

/* -------------------------------------------------------------- Isolation -- */

test('UNI-REACH only the server service imports the Uniswap modules; no new route, no browser RPC, no wallet call; Aave and Nexus runtime unchanged', async () => {
	const walk = (dir) => readdirSync(dir).flatMap((name) => {
		const full = path.join(dir, name);
		return statSync(full).isDirectory() ? (name === 'node_modules' ? [] : walk(full)) : [full];
	});
	const sources = ['api', 'src', 'web', 'scripts'].flatMap((dir) => walk(path.join(REPO, dir))).filter((file) => /\.(m?js|html)$/.test(file));
	// Wer ein Modul wirklich importiert (statisch oder dynamisch), nicht wer es im Kommentar nennt.
	const importers = (name) => sources.filter((file) => new RegExp(`(?:from\\s*|import\\(\\s*)['"][^'"]*/${name}(?:\\.mjs)?['"]`).test(readFileSync(file, 'utf8'))).map((file) => path.relative(REPO, file));
	const mentions = (pattern) => sources.filter((file) => pattern.test(readFileSync(file, 'utf8'))).map((file) => path.relative(REPO, file));
	// Seit 21.10.2026 erreichbar - aber nur ueber den Server-Dienst, den die beiden bestehenden Routen nutzen.
	assert.deepEqual(importers('uniswap-v3-math'), ['src/positions/uniswap-v3-ethereum.mjs']);
	assert.deepEqual(importers('uniswap-v3-ethereum'), ['src/positions/uniswap-v3-nexus.mjs', 'src/positions/uniswap-v3-service.mjs']);
	assert.deepEqual(importers('uniswap-v3-nexus'), ['src/positions/uniswap-v3-service.mjs']);
	assert.deepEqual(importers('uniswap-v3-service'), ['api/nexus/quote.mjs', 'api/positions.mjs']);
	assert.deepEqual(importers('price-reference'), ['src/positions/aave-multichain-activation.mjs', 'src/positions/uniswap-v3-ethereum.mjs', 'src/positions/uniswap-v3-nexus.mjs'], 'the price layer stays server-side');
	assert.deepEqual(mentions(/uniswap-v3-(ethereum|math|nexus|service)|price-reference/).filter((file) => !file.startsWith('src/positions/') && !file.startsWith('api/')), [], 'no browser or script file refers to the server modules');
	assert.deepEqual(walk(path.join(REPO, 'api')).map((f) => path.relative(REPO, f)).filter((f) => /uniswap|liquidity|lp-|-lp/i.test(f)), [], 'no new API route');
	const feeds = Object.values(P.CHAINLINK_FEEDS).flatMap((feed) => [feed.proxy, feed.aggregator].filter(Boolean)).map((address) => address.toLowerCase());
	for (const file of sources.filter((f) => path.relative(REPO, f).startsWith('web/'))) {
		const code = readFileSync(file, 'utf8');
		assert.doesNotMatch(code, /C36442b4a4522E871399CD717aBDD847Ab11FE88|1F98431c8aD98523631AE4a59f267346ea31F984|publicnode|alchemy\.com|infura|latestRoundData|multicall|uniswap-v3-(ethereum|math|nexus|service)|price-reference/i, path.relative(REPO, file));
		for (const feed of feeds) assert.ok(!code.toLowerCase().includes(feed), `${path.relative(REPO, file)}: Chainlink feed address in the browser`);
	}
	// keine Transaktions- oder Wallet-Methode in den neuen Modulen (Kommentare ausgenommen)
	const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
	for (const file of ['src/positions/uniswap-v3-ethereum.mjs', 'src/positions/uniswap-v3-math.mjs', 'src/positions/price-reference.mjs', 'src/positions/uniswap-v3-nexus.mjs', 'src/positions/uniswap-v3-service.mjs', 'web/src/uniswap-cover.js']) {
		const code = strip(readFileSync(path.join(REPO, file), 'utf8'));
		assert.doesNotMatch(code, /decreaseLiquidity|increaseLiquidity|collect\b|['"]burn['"]|['"]mint['"]|safeTransferFrom|transferFrom|approve|setApprovalForAll|permit|sendTransaction|sendRawTransaction|writeContract|signTypedData|signMessage|personal_sign|createWalletClient|walletActions|\.request\(|eth_call|buyCover|fetch\(/, file);
		assert.doesNotMatch(code, /stateMutability: '(nonpayable|payable)'/, `${file}: only view ABI entries`);
		assert.doesNotMatch(code, /process\.env|https?:\/\/|createPublicClient|http\(/, `${file}: no RPC endpoint, no own client, no secret`);
	}
	// Der Dienst nutzt den einen, bereits geprueften Positions-Client (Alchemy, retryCount 0) - keinen eigenen.
	assert.match(readFileSync(path.join(REPO, 'src/positions/uniswap-v3-service.mjs'), 'utf8'), /^import \{ defaultClient, LookupNotAdmittedError, PositionsBusyError \} from '\.\/index\.mjs';$/m);
	assert.doesNotMatch(strip(readFileSync(path.join(REPO, 'web/src/uniswap-cover.js'), 'utf8')), /process\.env|https?:\/\/|^\s*import\s|\bfetch\b|window\.ethereum/m);
	// Nexus- und Aave-Laufzeit: kein Produkt 72, keine Zuordnung, keine Quote
	assert.deepEqual(Object.keys(PINNED_PRODUCTS), ['97']);
	assert.equal(nexusProductIdFor('uniswap-v3-ethereum'), null);
	assert.ok(AAVE_V3_MARKETS.every((m) => m.protocolKey === 'aave'));
	const { result } = await scan([IN]);
	const position = { ...result.positions[0], protocolKey: 'uniswap', protocolVersion: 'v3', marketAddress: result.positions[0].pool, wallet: WALLET };
	assert.equal(matchPositionToNexus(position).status, 'NO_LISTING');
	let fetches = 0;
	const model = await getNexusReadModel(position, { fetchImpl: async () => { fetches += 1; throw new Error('no network'); }, now: Date.UTC(2026, 9, 21, 11) });
	assert.equal(fetches, 0);
	assert.notEqual(model.eligibility.status, 'AVAILABLE');
	const request = parseCoverRequest({ action: 'quote', deploymentKey: 'uniswap-v3-ethereum', coverAsset: 'USDC', amount: '1000', periodDays: 30 });
	assert.equal(checkQuoteRequest(request, model, position).code, 'COVER_NOT_AVAILABLE');
	// die Doku-Matrix ist aus dem Code erzeugt
	const doc = JSON.parse(readFileSync(path.join(REPO, 'docs/uniswap-v3-ethereum-support.json'), 'utf8'));
	assert.deepEqual(doc, JSON.parse(JSON.stringify(U.uniswapV3SupportMatrix())));
});
