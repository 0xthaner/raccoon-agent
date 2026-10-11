/**
 * DeFi-Positionen Phase 1: Aave v3 auf Ethereum (11.10.2026).
 *
 * Offline. Ein Attrappen-Client beantwortet jeden Vertragsaufruf aus einer
 * Fixture; die Kontosummen rechnet die Fixture wie Aave selbst (Sicherheiten
 * abgerundet, Schulden aufgerundet). Kein Netz, keine RPC, keine Datenbank.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatUnits, getAddress } from 'viem';

Object.assign(process.env, {
	DASHBOARD_SESSION_SECRET: 'test-dashboard-secret-0123456789abcd',
	APP_BASE_URL: 'https://coverraccoon.com',
	SUPABASE_URL: process.env.SUPABASE_URL || 'https://supabase.test.invalid',
	SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY || 'test-secret-key',
	DEMO_WALLET: '0xd00000000000000000000000000000000000d000'
});
delete process.env.ALCHEMY_API_KEY;

const { AAVE_V3_MARKETS, AAVE_V3_NEXUS_PRODUCT_ID, nexusProductIdFor } = await import('../src/positions/aave-registry.mjs');
const { readAaveV3Positions, LIMITS, safeSymbol } = await import('../src/positions/aave-v3.mjs');
const { matchDeployment } = await import('../src/positions/match-nexus.mjs');
const { getWalletPositions, CACHE_TTL_MS, FAILURE_TTL_MS, _test: positionsCache } = await import('../src/positions/index.mjs');
const { createPositionsHandler } = await import('../api/positions.mjs');
const { createDashboardSession, SESSION_COOKIE } = await import('../src/dashboard-auth.mjs');

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const [CORE, LIDO, ETHERFI] = AAVE_V3_MARKETS;
const ZERO = '0x0000000000000000000000000000000000000000';
const MAX_UINT = (1n << 256n) - 1n;
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
const WEETH = '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee';
const asset = (n) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);

/* --------------------------------------------------------------- Fixture -- */

function reserve(address, symbol, decimals, priceUsd8, user = {}) {
	return { address, symbol, decimals, price: priceUsd8, supply: 0n, stableDebt: 0n, variableDebt: 0n, collateral: false, liquidationThreshold: 8_000n, ...user };
}

/** Aaves eigene Kontosummen: Sicherheiten abgerundet, Schulden aufgerundet. */
function accountTotals(reserves) {
	let collateral = 0n, debt = 0n;
	for (const r of reserves) {
		const unit = 10n ** BigInt(r.decimals);
		if (r.collateral) collateral += (r.supply * r.price) / unit;
		const d = r.stableDebt + r.variableDebt;
		if (d > 0n) debt += (d * r.price + unit - 1n) / unit;
	}
	return { collateral, debt };
}

function marketState(market, reserves = [], overrides = {}) {
	const totals = accountTotals(reserves);
	return {
		market, reserves,
		pool: market.pool, oracle: market.oracle, dataProvider: market.dataProvider,
		baseCurrency: ZERO, baseUnit: 100_000_000n,
		account: [totals.collateral, totals.debt, 0n, 8_200n, 7_500n, totals.debt === 0n ? MAX_UINT : 1_650_000_000_000_000_000n],
		...overrides
	};
}

/** Antwortet wie viem.multicall(allowFailure: true). `fail` erzwingt Fehler je Aufruf. */
function fakeClient(states, { fail = () => false, block = 21_000_000n, onCall = () => {}, hang = false, truncate = false } = {}) {
	const byAddress = new Map();
	for (const s of states) for (const a of [s.market.poolAddressesProvider, s.market.pool, s.market.dataProvider, s.market.oracle]) byAddress.set(a.toLowerCase(), s);
	const calls = [];
	return {
		calls,
		async getBlockNumber() { return block; },
		async multicall({ contracts, blockNumber, allowFailure }) {
			assert.equal(allowFailure, true);
			assert.equal(blockNumber, block, 'alle Lesungen im selben Block');
			if (hang) return new Promise(() => {});
			const out = contracts.map((c) => {
				calls.push(c); onCall(c);
				if (fail(c)) return { status: 'failure', error: new Error('reverted') };
				const s = byAddress.get(c.address.toLowerCase());
				if (!s) return { status: 'failure', error: new Error('unknown contract') };
				const find = (a) => s.reserves.find((r) => r.address.toLowerCase() === String(a).toLowerCase());
				switch (c.functionName) {
					case 'getPool': return { status: 'success', result: s.pool };
					case 'getPriceOracle': return { status: 'success', result: s.oracle };
					case 'getPoolDataProvider': return { status: 'success', result: s.dataProvider };
					case 'getReservesList': return { status: 'success', result: s.reserveList ?? s.reserves.map((r) => r.address) };
					case 'getUserAccountData': return { status: 'success', result: s.account };
					case 'BASE_CURRENCY': return { status: 'success', result: s.baseCurrency };
					case 'BASE_CURRENCY_UNIT': return { status: 'success', result: s.baseUnit };
					case 'getAllReservesTokens': return { status: 'success', result: s.reserves.map((r) => ({ symbol: r.symbol, tokenAddress: r.address })) };
					case 'getUserReserveData': {
						const r = find(c.args[0]);
						assert.equal(c.args[1], getAddress(WALLET).length ? c.args[1] : null);
						return { status: 'success', result: [r.supply, r.stableDebt, r.variableDebt, 0n, 0n, 0n, 0n, 0, r.collateral] };
					}
					case 'getReserveConfigurationData': {
						const r = find(c.args[0]);
						return { status: 'success', result: [BigInt(r.decimals), 7_500n, r.liquidationThreshold, 10_500n, 1_000n, true, true, false, true, false] };
					}
					case 'getAssetsPrices': return { status: 'success', result: s.prices ?? c.args[0].map((a) => find(a).price) };
					default: return { status: 'failure', error: new Error('unexpected function') };
				}
			});
			return truncate ? out.slice(0, -1) : out;
		}
	};
}

const empty = (market) => marketState(market, [reserve(WETH, 'WETH', 18, 300_000_000_000n)]);
const markets = (...states) => {
	const keys = new Set(states.map((s) => s.market.deploymentKey));
	return [...states, ...AAVE_V3_MARKETS.filter((m) => !keys.has(m.deploymentKey)).map(empty)];
};
const read = (states, options = {}) => readAaveV3Positions(WALLET, { client: fakeClient(states, options), ...options });
const byKey = (result, market) => result.markets.find((m) => m.market.deploymentKey === market.deploymentKey);

const CATALOG = [{ productId: 97, officialName: 'Aave v3', normalizedName: 'aave v3', productType: 0, typeName: 'Single Protocol Cover', status: 'ACTIVE', deprecated: false }];

/* -------------------------------------------------- B: Marktidentitaet ---- */

test('B: registry holds exactly Core, Lido/Prime and EtherFi on Ethereum with checksummed addresses', () => {
	assert.deepEqual(AAVE_V3_MARKETS.map((m) => m.deploymentKey), ['aave-v3-ethereum-core', 'aave-v3-ethereum-lido', 'aave-v3-ethereum-etherfi']);
	for (const m of AAVE_V3_MARKETS) {
		assert.equal(m.chainId, 1);
		assert.equal(m.protocolKey, 'aave');
		assert.equal(m.protocolVersion, 'v3');
		for (const field of ['poolAddressesProvider', 'pool', 'dataProvider', 'oracle']) assert.equal(m[field], getAddress(m[field]), `${m.deploymentKey}.${field}`);
		assert.equal(nexusProductIdFor(m.deploymentKey), 97);
		assert.ok(Object.isFrozen(m));
	}
	assert.equal(CORE.pool, '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2');
	assert.equal(LIDO.pool, '0x4e033931ad43597d96D6bcc25c280717730B58B1');
	assert.equal(ETHERFI.pool, '0x0AA97c284e98396202b6A04024F5E2c65026F3c0');
	assert.equal(nexusProductIdFor('aave-v3-ethereum-horizon'), null);
	assert.deepEqual(matchDeployment('aave-v4-ethereum-main', CATALOG), { state: 'UNSUPPORTED', productId: null });
});

/* ------------------------------------------------------ C/D: Positionen ---- */

test('C: supply-only, not as collateral, is still detected', async () => {
	const result = await read(markets(marketState(CORE, [reserve(USDC, 'USDC', 6, 100_000_000n, { supply: 2_500_000_000n, collateral: false })])));
	const position = byKey(result, CORE).position;
	assert.equal(byKey(result, CORE).status, 'OK');
	assert.deepEqual(position.supplied.map((s) => [s.symbol, s.amount, s.usdValue, s.isCollateral]), [['USDC', '2500', '2500', false]]);
	assert.deepEqual(position.borrowed, []);
	assert.equal(position.totals.healthFactor, null);
	assert.equal(position.totals.netUsd, '2500');
});

test('C: borrow-only is never missed', async () => {
	const result = await read(markets(marketState(LIDO, [reserve(WETH, 'WETH', 18, 300_000_000_000n, { variableDebt: 500_000_000_000_000_000n })])));
	const position = byKey(result, LIDO).position;
	assert.deepEqual(position.supplied, []);
	assert.deepEqual(position.borrowed.map((b) => [b.symbol, b.amount, b.usdValue]), [['WETH', '0.5', '1500']]);
	assert.equal(position.totals.netUsd, '-1500');
});

test('C: supply + borrow over several reserves, collateral flags kept', async () => {
	const result = await read(markets(marketState(CORE, [
		reserve(WETH, 'WETH', 18, 300_000_000_000n, { supply: 2_000_000_000_000_000_000n, collateral: true }),
		reserve(WSTETH, 'wstETH', 18, 360_000_000_000n, { supply: 1_000_000_000_000_000_000n, collateral: false }),
		reserve(USDC, 'USDC', 6, 100_000_000n, { variableDebt: 1_000_000_000n, stableDebt: 1_000_000n })
	])));
	const position = byKey(result, CORE).position;
	assert.deepEqual(position.supplied.map((s) => [s.symbol, s.isCollateral]), [['WETH', true], ['wstETH', false]]);
	assert.equal(position.totals.suppliedUsd, '9600');
	assert.equal(position.totals.debtUsd, '1001', 'stabile und variable Schulden zusammen');
	assert.equal(position.totals.netUsd, '8599');
	assert.equal(position.totals.healthFactor, '1.65');
	assert.equal(position.deploymentKey, 'aave-v3-ethereum-core');
	assert.equal(position.protocolVersion, 'v3');
	assert.equal(position.marketAddress, CORE.pool);
	assert.equal(position.blockNumber, '21000000');
	assert.deepEqual(position.pricing, { source: 'aave-oracle', oracle: CORE.oracle, baseCurrency: 'USD', baseUnitDecimals: 8 });
});

test('C: a zero position produces no card, but the market counts as read', async () => {
	const result = await read(markets());
	for (const m of AAVE_V3_MARKETS) {
		assert.equal(byKey(result, m).status, 'OK');
		assert.equal(byKey(result, m).position, null);
	}
});

test('D: oracle decimals and token decimals are exact, no floating-point drift', async () => {
	// 0.1 + 0.2 waere in Float 0.30000000000000004; hier rechnen wir in BigInt.
	const result = await read(markets(marketState(ETHERFI, [
		reserve(WEETH, 'weETH', 18, 1n, { supply: 100_000_000_000_000_000n, collateral: true }),
		reserve(USDC, 'USDC', 6, 100n, { supply: 200_000n, collateral: true }),
		reserve(asset(0xbeef), 'TINY', 8, 12_345_678_901n, { supply: 3n, collateral: false })
	])));
	const position = byKey(result, ETHERFI).position;
	// 0.1 weETH * 1e-8 USD rundet wie bei Aave auf 0; 0.2 USDC * 1e-6 USD = 2e-7; 3e-8 TINY * 123.45 USD = 3.7e-6.
	assert.deepEqual(position.supplied.map((s) => s.usdValue), ['0', '0.0000002', '0.0000037']);
	assert.equal(position.totals.suppliedUsd, '0.0000039');
	assert.deepEqual(position.supplied.map((s) => s.amount), ['0.1', '0.2', '0.00000003']);
	const amount = 123_456_789_123_456_789_123_456_789n, price = 999_999_999_999_999n;
	const big = await read(markets(marketState(CORE, [reserve(WETH, 'WETH', 18, price, { supply: amount, collateral: true })])));
	assert.equal(byKey(big, CORE).position.supplied[0].usdValue, formatUnits((amount * price) / 10n ** 18n, 8));
	assert.equal(byKey(big, CORE).position.supplied[0].amountRaw, amount.toString(), 'Rohwert verlustfrei');
	assert.notEqual(Number(byKey(big, CORE).position.supplied[0].amountRaw), Number.MAX_SAFE_INTEGER);
});

/* ----------------------------------------------------- E: Fail closed ---- */

test('E: RPC timeout makes every market UNAVAILABLE, never empty', async () => {
	const started = Date.now();
	const result = await readAaveV3Positions(WALLET, { client: fakeClient(markets(), { hang: true }), rpcTimeoutMs: 30 });
	assert.ok(Date.now() - started < 2_000);
	for (const m of result.markets) assert.deepEqual([m.status, m.reason], ['UNAVAILABLE', 'RPC_TIMEOUT']);
	const noBlock = await readAaveV3Positions(WALLET, { client: { getBlockNumber: () => new Promise(() => {}), multicall: () => { throw new Error('no'); } }, rpcTimeoutMs: 30 });
	assert.ok(noBlock.markets.every((m) => m.status === 'UNAVAILABLE'));
});

test('E: one failing required call fails only that market', async () => {
	const states = markets(marketState(CORE, [reserve(WETH, 'WETH', 18, 300_000_000_000n, { supply: 1n * 10n ** 18n, collateral: true })]));
	const result = await read(states, { fail: (c) => c.functionName === 'getUserReserveData' && c.address === CORE.dataProvider });
	assert.deepEqual([byKey(result, CORE).status, byKey(result, CORE).reason], ['UNAVAILABLE', 'CALL_FAILED']);
	assert.equal(byKey(result, LIDO).status, 'OK');
	for (const fn of ['getUserAccountData', 'getAssetsPrices', 'getReserveConfigurationData', 'getReservesList', 'BASE_CURRENCY_UNIT']) {
		const r = await read(states, { fail: (c) => c.functionName === fn && [CORE.pool, CORE.oracle, CORE.dataProvider].includes(c.address) });
		assert.equal(byKey(r, CORE).status, 'UNAVAILABLE', fn);
	}
});

test('E: incomplete multicall results and reserve limits fail closed', async () => {
	const truncated = await read(markets(), { truncate: true });
	assert.ok(truncated.markets.every((m) => m.status === 'UNAVAILABLE' && m.reason === 'INCOMPLETE_RESULT'));
	const many = Array.from({ length: LIMITS.maxReservesPerMarket + 1 }, (_, i) => reserve(asset(i + 1), `T${i}`, 18, 1n));
	const limited = await read(markets(marketState(CORE, many)));
	assert.deepEqual([byKey(limited, CORE).status, byKey(limited, CORE).reason], ['UNAVAILABLE', 'RESERVE_LIMIT']);
	const duplicates = await read(markets({ ...marketState(CORE, [reserve(WETH, 'WETH', 18, 1n)]), reserveList: [WETH, WETH] }));
	assert.equal(byKey(duplicates, CORE).reason, 'BAD_RESERVE_LIST');
	const prices = await read(markets({ ...marketState(CORE, [reserve(WETH, 'WETH', 18, 1n)]), prices: [] }));
	assert.equal(byKey(prices, CORE).reason, 'INCOMPLETE_RESULT');
});

test('E: account totals that disagree with per-reserve values fail the market closed', async () => {
	const reserves = [reserve(WETH, 'WETH', 18, 300_000_000_000n, { supply: 10n ** 18n, collateral: true }), reserve(USDC, 'USDC', 6, 100_000_000n, { variableDebt: 100_000_000n })];
	const good = marketState(CORE, reserves);
	const missingCollateral = { ...good, account: [good.account[0] * 2n, good.account[1], 0n, 0n, 0n, 2n * 10n ** 18n] };
	assert.equal(byKey(await read(markets(missingCollateral)), CORE).reason, 'TOTALS_MISMATCH');
	const missingDebt = { ...good, account: [good.account[0], good.account[1] + 10_000_000_000n, 0n, 0n, 0n, 10n ** 18n] };
	assert.equal(byKey(await read(markets(missingDebt)), CORE).reason, 'TOTALS_MISMATCH');
	// Konto zeigt Schulden, aber keine Reserve liefert sie: nie "keine Position".
	const hidden = { ...marketState(CORE, []), account: [0n, 5_000_000_000n, 0n, 0n, 0n, 10n ** 18n] };
	assert.equal(byKey(await read(markets(hidden)), CORE).status, 'UNAVAILABLE');
	// Rundung innerhalb der dokumentierten Toleranz bleibt OK.
	const rounded = { ...good, account: [good.account[0] + 1n, good.account[1] - 1n, 0n, 0n, 0n, 10n ** 18n] };
	assert.equal(byKey(await read(markets(rounded)), CORE).status, 'OK');
	// Aeltere v3-Regel: Sicherheiten mit Liquidationsschwelle 0 zaehlen nicht.
	const zeroLt = marketState(CORE, [reserve(WETH, 'WETH', 18, 300_000_000_000n, { supply: 10n ** 18n, collateral: true, liquidationThreshold: 0n })], {});
	assert.equal(byKey(await read(markets({ ...zeroLt, account: [0n, 0n, 0n, 0n, 0n, MAX_UINT] })), CORE).status, 'OK');
});

test('E: registry drift and non-USD oracles fail closed', async () => {
	const moved = { ...marketState(CORE, []), pool: '0x1111111111111111111111111111111111111111' };
	assert.equal(byKey(await read(markets(moved)), CORE).reason, 'REGISTRY_MISMATCH');
	const ethBase = { ...marketState(CORE, []), baseCurrency: WETH, baseUnit: 10n ** 18n };
	assert.equal(byKey(await read(markets(ethBase)), CORE).reason, 'UNSUPPORTED_BASE_CURRENCY');
	const zeroPrice = marketState(CORE, [reserve(WETH, 'WETH', 18, 0n, { supply: 10n ** 18n })]);
	assert.equal(byKey(await read(markets(zeroPrice)), CORE).reason, 'MISSING_PRICE');
});

/* ------------------------------------------------- J: Sicherheit ---- */

test('J: only reviewed registry contracts are ever called, with the session wallet', async () => {
	const allowed = new Set(AAVE_V3_MARKETS.flatMap((m) => [m.poolAddressesProvider, m.pool, m.dataProvider, m.oracle]).map((a) => a.toLowerCase()));
	const client = fakeClient(markets(marketState(CORE, [reserve(WETH, 'WETH', 18, 1n, { supply: 1n })])));
	await readAaveV3Positions(WALLET, { client });
	assert.ok(client.calls.length > 0);
	assert.ok(client.calls.every((c) => allowed.has(c.address.toLowerCase())), 'keine fremde Adresse');
	for (const c of client.calls.filter((call) => ['getUserAccountData', 'getUserReserveData'].includes(call.functionName))) {
		assert.equal(c.args.at(-1), getAddress(WALLET));
	}
	assert.ok(client.calls.length <= LIMITS.maxCallsPerLookup);
	await assert.rejects(readAaveV3Positions('not-an-address', { client }), TypeError);
	await assert.rejects(getWalletPositions('0x1234', { client }), TypeError);
});

test('J: the call budget stops oversized lookups before round 2', async () => {
	const many = Array.from({ length: LIMITS.maxReservesPerMarket }, (_, i) => reserve(asset(i + 1), `T${i}`, 18, 1n));
	const extra = AAVE_V3_MARKETS.map((m, i) => ({ ...m, deploymentKey: `${m.deploymentKey}-copy${i}` }));
	const all = [...AAVE_V3_MARKETS, extra[0]];
	const states = all.map((m) => marketState(m, many));
	const client = fakeClient(states);
	const result = await readAaveV3Positions(WALLET, { client, markets: all });
	assert.ok(result.markets.every((m) => m.reason === 'CALL_LIMIT'));
	assert.ok(client.calls.every((c) => !['getUserReserveData', 'getReserveConfigurationData'].includes(c.functionName)));
});

test('J: token symbols are untrusted display data', () => {
	assert.equal(safeSymbol('USDC', USDC), 'USDC');
	assert.equal(safeSymbol('wstETH', WSTETH), 'wstETH');
	for (const hostile of ['<img src=x onerror=alert(1)>', 'USD₮0', 'A'.repeat(40), '', null, 'visit evil.example now']) {
		assert.equal(safeSymbol(hostile, USDC), '0xA0b8…eB48', String(hostile));
	}
});

/* ---------------------------------------------------- F: Nexus-Zuordnung ---- */

test('F: canonical productId 97 is MATCHED only with the expected identity', () => {
	assert.equal(AAVE_V3_NEXUS_PRODUCT_ID, 97);
	assert.deepEqual(matchDeployment(CORE.deploymentKey, CATALOG), { state: 'MATCHED', productId: 97, productName: 'Aave v3' });
	assert.deepEqual(matchDeployment(CORE.deploymentKey, []), { state: 'NO_PRODUCT', productId: 97 });
	assert.equal(matchDeployment(CORE.deploymentKey, [{ ...CATALOG[0], deprecated: true, status: 'DEPRECATED' }]).state, 'PRODUCT_DEPRECATED');
	assert.deepEqual(matchDeployment(CORE.deploymentKey, null), { state: 'UNAVAILABLE', productId: 97, reason: 'CATALOG_UNAVAILABLE' });
	for (const patch of [{ normalizedName: 'aave v4' }, { normalizedName: 'aave v3 lite' }, { productType: 24 }, { typeName: 'Leveraged Liquidation Cover' }]) {
		assert.deepEqual(matchDeployment(CORE.deploymentKey, [{ ...CATALOG[0], ...patch }]), { state: 'UNAVAILABLE', productId: 97, reason: 'PRODUCT_IDENTITY_MISMATCH' }, JSON.stringify(patch));
	}
});

test('F: no name-based or fuzzy matching: another product named "Aave v3" never matches', () => {
	const impostor = [{ ...CATALOG[0], productId: 1, officialName: 'Aave v3' }];
	assert.equal(matchDeployment(CORE.deploymentKey, impostor).state, 'NO_PRODUCT');
	const source = readFileSync(new URL('../src/positions/match-nexus.mjs', import.meta.url), 'utf8');
	assert.doesNotMatch(source, /includes\(|startsWith\(|levenshtein|similar|openai|fuzzy\(/i);
});

/* ------------------------------------------------------- G: Cache ---- */

test('G: per-wallet cache with TTL, no cross-wallet reuse, short failure TTL', async () => {
	positionsCache.reset();
	let clock = 1_000_000;
	const now = () => clock;
	const catalogLoader = async () => CATALOG;
	const clientA = fakeClient(markets(marketState(CORE, [reserve(USDC, 'USDC', 6, 100_000_000n, { supply: 5_000_000n })])));
	const first = await getWalletPositions(WALLET, { client: clientA, catalogLoader, now });
	const callsAfterFirst = clientA.calls.length;
	const again = await getWalletPositions(getAddress(WALLET), { client: clientA, catalogLoader, now });
	assert.equal(again, first, 'gleiche Wallet, gleicher Eintrag');
	assert.equal(clientA.calls.length, callsAfterFirst, 'kein neuer RPC-Aufruf innerhalb der TTL');
	const clientB = fakeClient(markets());
	const other = await getWalletPositions(OTHER, { client: clientB, catalogLoader, now });
	assert.equal(other.wallet, OTHER);
	assert.deepEqual(other.positions, [], 'Wallet B bekommt nie die Positionen von A');
	assert.ok(clientB.calls.length > 0);
	clock += CACHE_TTL_MS + 1;
	await getWalletPositions(WALLET, { client: clientA, catalogLoader, now });
	assert.ok(clientA.calls.length > callsAfterFirst, 'nach Ablauf neu gelesen');
	positionsCache.reset();
	const failing = fakeClient(markets(), { hang: true });
	const down = await getWalletPositions(WALLET, { client: { ...failing, multicall: () => Promise.reject(new Error('down')), getBlockNumber: failing.getBlockNumber }, catalogLoader, now });
	assert.equal(down.complete, false);
	assert.ok(down.checkedDeployments.every((d) => d.status === 'UNAVAILABLE'));
	clock += FAILURE_TTL_MS - 1;
	assert.equal(await getWalletPositions(WALLET, { client: clientA, catalogLoader, now }), down, 'Fehler kurz gemerkt');
	clock += 2;
	const recovered = await getWalletPositions(WALLET, { client: clientA, catalogLoader, now });
	assert.equal(recovered.complete, true, 'nach 15 s wieder frisch gelesen');
	assert.ok(FAILURE_TTL_MS < CACHE_TTL_MS);
});

test('G: result shape binds every position to its deployment and the Nexus match', async () => {
	positionsCache.reset();
	const client = fakeClient(markets(
		marketState(CORE, [reserve(USDC, 'USDC', 6, 100_000_000n, { supply: 1_000_000n })]),
		marketState(ETHERFI, [reserve(WEETH, 'weETH', 18, 320_000_000_000n, { supply: 10n ** 18n, collateral: true })])
	));
	const result = await getWalletPositions(WALLET, { client, catalogLoader: async () => CATALOG });
	assert.equal(result.ok, true);
	assert.equal(result.chainId, 1);
	assert.equal(result.complete, true);
	assert.deepEqual(result.checkedDeployments.map((d) => [d.deploymentKey, d.status]), AAVE_V3_MARKETS.map((m) => [m.deploymentKey, 'OK']));
	assert.deepEqual(result.positions.map((p) => [p.deploymentKey, p.nexus.state, p.nexus.productId]), [['aave-v3-ethereum-core', 'MATCHED', 97], ['aave-v3-ethereum-etherfi', 'MATCHED', 97]]);
	assert.ok(result.positions.every((p) => p.wallet === WALLET));
	assert.doesNotMatch(JSON.stringify(result), /uncovered|gap|recommended|coverAmount|covered/i);
	const noCatalog = await (positionsCache.reset(), getWalletPositions(WALLET, { client, catalogLoader: async () => null }));
	assert.ok(noCatalog.positions.every((p) => p.nexus.state === 'UNAVAILABLE'));
});

/* ---------------------------------------------------------- A: Auth ---- */

function handler(overrides = {}) {
	const seen = { wallets: [], limits: [] };
	const h = createPositionsHandler({
		getPositions: async (wallet) => { seen.wallets.push(wallet); return { ok: true, wallet, positions: [] }; },
		isRevoked: async () => false,
		rateLimit: async (_req, _res, scope) => { seen.limits.push(scope); return true; },
		rateLimitFor: async (_res, scope, value) => { seen.limits.push(`${scope}:${value}`); return true; },
		...overrides
	});
	return { h, seen };
}
function res() {
	return { statusCode: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
const cookie = (wallet) => ({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(createDashboardSession(wallet))}` });

test('A: no session is 401 and never reads positions', async () => {
	const { h, seen } = handler();
	const r = res();
	await h({ method: 'GET', headers: {}, query: {} }, r);
	assert.equal(r.statusCode, 401);
	assert.equal(r.body.code, 'NO_SESSION');
	assert.deepEqual(seen.wallets, []);
	assert.equal(r.headers['cache-control'], 'no-store');
});

test('A: revoked session is 401; a failing revocation check is 503, not a pass', async () => {
	const revoked = handler({ isRevoked: async () => true });
	const r1 = res();
	await revoked.h({ method: 'GET', headers: cookie(WALLET), query: {} }, r1);
	assert.deepEqual([r1.statusCode, r1.body.code], [401, 'SESSION_REVOKED']);
	assert.deepEqual(revoked.seen.wallets, []);
	const broken = handler({ isRevoked: async () => { throw new Error('db down'); } });
	const r2 = res();
	await broken.h({ method: 'GET', headers: cookie(WALLET), query: {} }, r2);
	assert.equal(r2.statusCode, 503);
	assert.deepEqual(broken.seen.wallets, []);
});

test('A: a ?wallet= parameter is rejected; positions come only from the session wallet', async () => {
	const { h, seen } = handler();
	const r = res();
	await h({ method: 'GET', headers: cookie(WALLET), query: { wallet: OTHER } }, r);
	assert.deepEqual([r.statusCode, r.body.code], [400, 'WALLET_PARAMETER_NOT_ALLOWED']);
	assert.deepEqual(seen.wallets, []);
	const ok = res();
	await h({ method: 'GET', headers: cookie(WALLET), query: {} }, ok);
	assert.equal(ok.statusCode, 200);
	assert.deepEqual(seen.wallets, [WALLET]);
	assert.ok(seen.limits.includes('positions-read'));
	assert.ok(seen.limits.includes(`positions-wallet:${WALLET}`));
	assert.ok(seen.limits.includes('positions-global:all'));
	const post = res();
	await h({ method: 'POST', headers: cookie(WALLET), query: {} }, post);
	assert.equal(post.statusCode, 405);
});

test('A: Safe-App Bearer session works; cookie/Bearer conflict fails closed', async () => {
	const { h, seen } = handler();
	const r = res();
	await h({ method: 'GET', headers: { authorization: `Bearer ${createDashboardSession(OTHER)}` }, query: {} }, r);
	assert.equal(r.statusCode, 200);
	assert.deepEqual(seen.wallets, [OTHER]);
	const conflict = res();
	await h({ method: 'GET', headers: { ...cookie(WALLET), authorization: `Bearer ${createDashboardSession(OTHER)}` }, query: {} }, conflict);
	assert.equal(conflict.statusCode, 401);
	assert.deepEqual(seen.wallets, [OTHER]);
});

test('A: rate-limit refusal and reader failure never leak data', async () => {
	const limited = handler({ rateLimitFor: async (response) => { response.status(429).json({ ok: false }); return false; } });
	const r1 = res();
	await limited.h({ method: 'GET', headers: cookie(WALLET), query: {} }, r1);
	assert.equal(r1.statusCode, 429);
	assert.deepEqual(limited.seen.wallets, []);
	const failing = handler({ getPositions: async () => { throw new Error('rpc https://eth-mainnet.g.alchemy.com/v2/SECRETKEY'); } });
	const r2 = res();
	await failing.h({ method: 'GET', headers: cookie(WALLET), query: {} }, r2);
	assert.equal(r2.statusCode, 503);
	assert.doesNotMatch(JSON.stringify(r2.body), /alchemy|SECRETKEY/);
});

test('A: the endpoint is separate from /api/dashboard and persists nothing', () => {
	const api = readFileSync(new URL('../api/positions.mjs', import.meta.url), 'utf8');
	const dashboard = readFileSync(new URL('../api/dashboard.mjs', import.meta.url), 'utf8');
	assert.doesNotMatch(dashboard, /positions/i, 'dashboardData bleibt unveraendert');
	const modules = ['index', 'aave-v3', 'aave-registry', 'match-nexus'].map((f) => readFileSync(new URL(`../src/positions/${f}.mjs`, import.meta.url), 'utf8')).join('\n');
	const sources = modules + api;
	assert.doesNotMatch(modules, /db\.mjs|@supabase/, 'Positionsmodule kennen die Datenbank nicht');
	assert.doesNotMatch(sources, /\.from\(['"]|\.insert\(|\.upsert\(|db\.rpc\(|supabase\.co/, 'keine Speicherung in Supabase');
	assert.match(api, /import \{ isDashboardSessionRevoked \} from '\.\.\/src\/db\.mjs';/, 'die Datenbank nur fuer die Widerrufspruefung');
	assert.doesNotMatch(sources, /signTypedData|sendTransaction|writeContract|approve\(|eth_sign/i, 'keine Signatur, keine Transaktion');
	assert.doesNotMatch(sources, /debank|zapper|zerion|covalent|moralis/i, 'kein Portfolio-Dienst');
	assert.doesNotMatch(api, /request\.query\.wallet|request\.body/);
});

/* ------------------------------------------------------- I: Demo-Fehler ---- */

test('I: the demo cover uses the canonical Aave v3 productId, never productId 1', async () => {
	const { getWalletCovers } = await import('../src/covers.mjs');
	const fetchImpl = async (url) => ({
		ok: true,
		json: async () => (String(url).includes('getNFTsForOwner') ? { ownedNfts: [], totalCount: 0 } : [{ id: 1, name: '1Inch' }, { id: 97, name: 'Aave v3' }])
	});
	const result = await getWalletCovers(process.env.DEMO_WALLET, { apiKey: 'test', fetchImpl });
	const demo = result.covers.find((cover) => cover.demo);
	assert.equal(demo.productId, 97);
	assert.equal(demo.productName, 'Aave v3');
	assert.ok(!result.covers.some((cover) => cover.productId === 1 && /aave/i.test(cover.productName ?? '')));
});

/* ---------------------------------------------------- H: Oberflaeche ---- */

const main = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

/** Minimaler DOM, gerade genug fuer renderPositions; Text nur ueber textContent. */
function fakeDom() {
	const nodes = new Map();
	const make = (tag) => ({
		tag, className: '', children: [], _text: '',
		set textContent(v) { this._text = String(v); this.children = []; }, get textContent() { return this._text + this.children.map((c) => c.textContent).join(' | '); },
		appendChild(c) { this.children.push(c); return c; }, replaceChildren() { this.children = []; this._text = ''; }
	});
	for (const id of ['#position-list', '#positions-title', '#positions-note', '#positions-checked']) nodes.set(id, make('div'));
	return { document: { createElement: make, querySelector: (s) => nodes.get(s) ?? null }, nodes };
}

function renderWith(state, dashboardData, lang = 'de') {
	const start = main.indexOf('function formatAmount(');
	const end = main.indexOf('function renderDashboard(');
	const translationsStart = main.indexOf('const translations = {');
	const translationsEnd = main.indexOf("let language = localStorage.getItem('raccoon_language')");
	const { document, nodes } = fakeDom();
	const source = `${main.slice(translationsStart, translationsEnd)}
		const t = translations[lang];
		function addTextElement(parent, tag, value, className = '') { const el = document.createElement(tag); if (className) el.className = className; el.textContent = String(value ?? ''); parent.appendChild(el); return el; }
		function formatDate(iso) { return iso ? iso.slice(0, 10) : '—'; }
		let positionsState = state;
		${main.slice(start, end)}
		renderPositions();`;
	new Function('document', 'window', 'lang', 'state', 'language', source)(document, { dashboardData }, lang, state, lang);
	return nodes.get('#position-list');
}

const SAMPLE = {
	ok: true, wallet: WALLET, chainId: 1, complete: false,
	checkedDeployments: [
		{ deploymentKey: CORE.deploymentKey, label: 'Core', status: 'OK' },
		{ deploymentKey: LIDO.deploymentKey, label: 'Lido / Prime', status: 'UNAVAILABLE', reason: 'RPC_TIMEOUT' },
		{ deploymentKey: ETHERFI.deploymentKey, label: 'EtherFi', status: 'OK' }
	],
	positions: [{
		deploymentKey: CORE.deploymentKey, label: 'Core',
		supplied: [{ symbol: 'WETH', amount: '2', usdValue: '6000', isCollateral: true }],
		borrowed: [{ symbol: 'USDC', amount: '1000', usdValue: '1000' }],
		totals: { suppliedUsd: '6000', debtUsd: '1000', netUsd: '5000', healthFactor: '1.65' },
		nexus: { state: 'MATCHED', productId: 97, productName: 'Aave v3' }
	}]
};
const COVERS = [
	{ coverId: 7, productId: 97, productName: 'Aave v3', status: 'active', amount: '3', asset: { symbol: 'ETH' }, endsAt: '2026-12-01T00:00:00.000Z' },
	{ coverId: 8, productId: 1, productName: 'Aave v3', status: 'active', amount: '9', asset: { symbol: 'ETH' }, endsAt: '2026-12-01T00:00:00.000Z' },
	{ coverId: 9, productId: 97, productName: 'Aave v3', status: 'expired', amount: '5', asset: { symbol: 'ETH' }, endsAt: '2025-12-01T00:00:00.000Z' }
];

test('H: a card keeps detected position, matching product and wallet covers separate', () => {
	const list = renderWith({ wallet: WALLET, status: 'ok', data: SAMPLE }, { covers: COVERS });
	const card = list.children[0];
	assert.equal(card.className, 'position-card');
	assert.equal(card.children[0].textContent, 'Aave v3 · Core');
	const [, detected, product, held] = card.children;
	assert.match(detected.textContent, /^Erkannte DeFi-Position/);
	assert.match(detected.textContent, /Eingezahlt \| 2 WETH \(.*6\.000,00.*\) · als Sicherheit/);
	assert.match(detected.textContent, /Geliehen \| 1[.\s\u00a0\u202f]?000 USDC/);
	assert.match(detected.textContent, /Nettoposition: .*5\.000,00/);
	assert.match(product.textContent, /^Passendes Nexus-Produkt \| Passendes Nexus-Produkt verfügbar \| Aave v3 · Produkt #97/);
	assert.match(held.textContent, /^Vorhandene Covers dieser Wallet \| Cover #7 · 3 ETH/);
	assert.doesNotMatch(held.textContent, /Cover #8|Cover #9/, 'nur productId 97 und nur aktive; Name zaehlt nicht');
	assert.match(held.textContent, /nicht direkt vergleichbar/);
	assert.match(list.textContent, /Aave v3 · Lido \/ Prime: Daten konnten nicht vollständig gelesen werden/);
	assert.doesNotMatch(list.textContent, /Keine Aave-v3-Positionen/, 'unvollstaendig ist nicht leer');
});

test('H: genuine zero positions, loading and errors are distinct states', () => {
	const none = renderWith({ wallet: WALLET, status: 'ok', data: { ...SAMPLE, positions: [], checkedDeployments: SAMPLE.checkedDeployments.map((d) => ({ ...d, status: 'OK' })) } }, { covers: [] });
	assert.match(none.textContent, /Keine Aave-v3-Positionen auf Ethereum gefunden/);
	assert.match(renderWith({ wallet: WALLET, status: 'error', data: null }, {}).textContent, /konnten gerade nicht geladen werden/);
	assert.match(renderWith({ wallet: WALLET, status: 'loading', data: null }, {}).textContent, /werden gelesen/);
	const noCovers = renderWith({ wallet: WALLET, status: 'ok', data: SAMPLE }, { covers: [] }, 'en');
	assert.match(noCovers.textContent, /Matching Nexus product available/);
	assert.match(noCovers.textContent, /No matching covers found in this wallet/);
	const deprecated = renderWith({ wallet: WALLET, status: 'ok', data: { ...SAMPLE, positions: [{ ...SAMPLE.positions[0], nexus: { state: 'PRODUCT_DEPRECATED', productId: 97, productName: 'Aave v3' } }] } }, { covers: COVERS });
	assert.doesNotMatch(deprecated.textContent, /Cover #7/, 'ohne MATCHED keine Zuordnung von Covers');
});

test('H: no gap, difference or coverage wording anywhere in the positions UI', () => {
	const helpers = main.slice(main.indexOf('let positionsState'), main.indexOf('function renderDashboard('));
	assert.doesNotMatch(helpers, /usdValue\s*-|netUsd\s*-|amount\s*-|- *cover|uncovered|gap|Lücke|Deckungs/i);
	const de = main.slice(main.indexOf('Object.assign(translations.de'), main.indexOf('Object.assign(translations.en'));
	const en = main.slice(main.indexOf('Object.assign(translations.en'), main.indexOf("let language = localStorage.getItem('raccoon_language')"));
	const note = /positionsNote: '[^']*'/;
	for (const block of [de, en]) {
		const withoutNote = block.replace(note, '');
		assert.doesNotMatch(withoutNote, /gedeckt|versichert|geschützt|Schutz|covered|insured|protected|protection|guarantee|garantiert|uncovered|gap|Lücke/i);
	}
	assert.match(de, /Ein passendes Nexus-Produkt bedeutet nicht, dass ein konkreter Verlust gedeckt oder ein bestimmter Betrag erstattungsfähig ist\. Maßgeblich sind die Produktbedingungen und der Claims-Prozess von Nexus Mutual\./);
	assert.match(de, /productAvailable: 'Passendes Nexus-Produkt verfügbar'/);
	assert.match(en, /productAvailable: 'Matching Nexus product available'/);
	assert.match(de, /walletCovers: 'Vorhandene Covers dieser Wallet'/);
	assert.match(de, /detectedPosition: 'Erkannte DeFi-Position'/);
});

test('Wording: the dashboard no longer promises "Schutz" / "Protection"', () => {
	assert.doesNotMatch(main, /'Dein Schutz'|'Your protection'|protectionAmount: 'Schutz'|protectionAmount: 'Protection'|\['Schutz, '|\['Protection, '/);
	assert.match(main, /protection: 'Deine Covers'/);
	assert.match(main, /protection: 'Your covers'/);
	assert.match(main, /protectionAmount: 'Cover-Betrag'/);
	assert.match(main, /protectionAmount: 'Cover amount'/);
	assert.doesNotMatch(html, />Dein Schutz<|>Schutz, </);
	assert.match(html, /id="protection-title">Deine Covers</);
	assert.match(html, /id="positions-title">DeFi-Positionen</);
	assert.match(html, /id="position-list"/);
	assert.doesNotMatch(main.slice(main.indexOf('let positionsState'), main.indexOf('function renderDashboard(')), /localStorage|sessionStorage|indexedDB/, 'Positionen nie im Browser speichern');
});

test('Privacy page describes the position read exactly as implemented', () => {
	const privacy = readFileSync(new URL('../web/datenschutz.html', import.meta.url), 'utf8');
	assert.match(privacy, /<strong>DeFi-Positionen<\/strong>/);
	assert.match(privacy, /öffentliche On-Chain-Daten der angemeldeten Wallet zu Aave v3 auf Ethereum/);
	assert.match(privacy, /über die bereits genannte Infrastruktur von Alchemy/);
	assert.match(privacy, /keine weitere Signatur nötig, und private Schlüssel oder Seed Phrases werden nie abgefragt/);
	assert.match(privacy, /nicht in der Datenbank \(Supabase\) gespeichert/);
	assert.match(privacy, /im Dashboard zusätzlich, um die Aave-v3-Positionen dieser Wallet auf Ethereum zu lesen/);
});

/* ======================================================================== *
 * Sicherheitspruefung 11.10.2026: adversariale Regressionstests.
 * ======================================================================== */

const { MAX_CONCURRENT_LOOKUPS, PositionsBusyError, LookupNotAdmittedError } = await import('../src/positions/index.mjs');
const WALLET_C = '0xcccccccccccccccccccccccccccccccccccccccc';

function walletClient() {
	// Jede Wallet bekommt eine andere, eindeutig erkennbare Position.
	const amounts = new Map([[getAddress(WALLET), 1_000_000n], [getAddress(OTHER), 2_000_000n], [getAddress(WALLET_C), 3_000_000n]]);
	const base = fakeClient(markets(marketState(CORE, [reserve(USDC, 'USDC', 6, 100_000_000n)])));
	return {
		calls: base.calls,
		getBlockNumber: base.getBlockNumber,
		async multicall(args) {
			const user = args.contracts.find((c) => c.functionName === 'getUserAccountData' || c.functionName === 'getUserReserveData')?.args.at(-1);
			const supply = amounts.get(user) ?? 0n;
			const state = markets(marketState(CORE, [reserve(USDC, 'USDC', 6, 100_000_000n, { supply })]));
			return fakeClient(state).multicall(args);
		}
	};
}
const usdcOf = (result) => result.positions.find((p) => p.deploymentKey === CORE.deploymentKey)?.supplied[0]?.amount ?? null;

test('SEC cache: alternating A / B / A never mixes results', async () => {
	positionsCache.reset();
	const client = walletClient();
	const options = { client, catalogLoader: async () => CATALOG };
	const a1 = await getWalletPositions(WALLET, options);
	const b = await getWalletPositions(OTHER, options);
	const a2 = await getWalletPositions(WALLET, options);
	assert.deepEqual([usdcOf(a1), usdcOf(b), usdcOf(a2)], ['1', '2', '1']);
	assert.deepEqual([a1.wallet, b.wallet, a2.wallet], [WALLET, OTHER, WALLET]);
	assert.equal(a2, a1, 'A aus dem eigenen Cache');
	assert.ok(b.positions.every((p) => p.wallet === OTHER));
});

test('SEC cache: concurrent A + B coalesce per wallet only', async () => {
	positionsCache.reset();
	const client = walletClient();
	const options = { client, catalogLoader: async () => CATALOG };
	const [a1, b1, a2, b2] = await Promise.all([WALLET, OTHER, WALLET, OTHER].map((w) => getWalletPositions(w, options)));
	assert.equal(a1, a2, 'gleiche Wallet teilt eine Abfrage');
	assert.equal(b1, b2);
	assert.notEqual(a1, b1);
	assert.deepEqual([usdcOf(a1), usdcOf(b1)], ['1', '2']);
	assert.equal(positionsCache.activeLookups(), 0, 'Zaehler nach Abschluss wieder frei');
});

test('SEC cache: a failure cached for A does not affect B', async () => {
	positionsCache.reset();
	const broken = { getBlockNumber: async () => { throw new Error('down'); }, multicall: async () => { throw new Error('down'); } };
	const a = await getWalletPositions(WALLET, { client: broken, catalogLoader: async () => CATALOG });
	assert.equal(a.complete, false);
	const b = await getWalletPositions(OTHER, { client: walletClient(), catalogLoader: async () => CATALOG });
	assert.equal(b.complete, true);
	assert.equal(usdcOf(b), '2');
	assert.equal(await getWalletPositions(WALLET, { client: walletClient(), catalogLoader: async () => CATALOG }), a, 'A bleibt fuer 15 s beim eigenen Fehler');
});

test('SEC cache: checksum and lowercase spellings of ONE address share an entry; distinct addresses never collide', async () => {
	positionsCache.reset();
	const client = walletClient();
	const options = { client, catalogLoader: async () => CATALOG };
	const lower = await getWalletPositions(WALLET, options);
	assert.equal(await getWalletPositions(getAddress(WALLET), options), lower);
	// Gleiches Praefix, andere Adresse: eigener Eintrag.
	const prefixTwin = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab';
	const twin = await getWalletPositions(prefixTwin, options);
	assert.notEqual(twin, lower);
	assert.equal(twin.wallet, prefixTwin);
	assert.deepEqual(twin.positions, []);
	await assert.rejects(getWalletPositions(WALLET.slice(0, 41), options), TypeError);
	await assert.rejects(getWalletPositions(`${WALLET} `, options), TypeError);
});

test('SEC amplification: admit is asked only for real chain lookups; a refusal reads nothing', async () => {
	positionsCache.reset();
	const client = walletClient();
	let asked = 0;
	const admit = async () => { asked++; return true; };
	await Promise.all([getWalletPositions(WALLET, { client, catalogLoader: async () => CATALOG, admit }), getWalletPositions(WALLET, { client, catalogLoader: async () => CATALOG, admit })]);
	await getWalletPositions(WALLET, { client, catalogLoader: async () => CATALOG, admit });
	assert.equal(asked, 1, 'Cache-Treffer und mitlaufende Abfragen zaehlen nicht');
	const before = client.calls.length;
	await assert.rejects(getWalletPositions(OTHER, { client, catalogLoader: async () => CATALOG, admit: async () => false }), LookupNotAdmittedError);
	assert.equal(client.calls.length, before, 'kein RPC-Aufruf ohne Zulassung');
	assert.equal(positionsCache.activeLookups(), 0);
	await assert.rejects(getWalletPositions(OTHER, { client, catalogLoader: async () => CATALOG, admit: async () => { throw new Error('db'); } }), /db/);
	assert.equal(positionsCache.activeLookups(), 0, 'auch ein Fehler gibt den Platz frei');
});

test('SEC amplification: at most MAX_CONCURRENT_LOOKUPS cold lookups run per instance', async () => {
	positionsCache.reset();
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const slow = { calls: [], getBlockNumber: async () => { await gate; return 21_000_000n; }, multicall: (args) => walletClient().multicall(args) };
	const wallets = Array.from({ length: MAX_CONCURRENT_LOOKUPS }, (_, i) => `0x${String(i + 1).repeat(40)}`);
	const running = wallets.map((w) => getWalletPositions(w, { client: slow, catalogLoader: async () => CATALOG }));
	await new Promise((r) => setImmediate(r));
	assert.equal(positionsCache.activeLookups(), MAX_CONCURRENT_LOOKUPS);
	await assert.rejects(getWalletPositions(WALLET_C, { client: slow, catalogLoader: async () => CATALOG }), PositionsBusyError);
	// Eine bereits laufende Wallet kann sich anhaengen, ohne einen Platz zu brauchen.
	const joined = getWalletPositions(wallets[0], { client: slow, catalogLoader: async () => CATALOG });
	release();
	await Promise.all([...running, joined]);
	assert.equal(positionsCache.activeLookups(), 0);
	assert.equal(MAX_CONCURRENT_LOOKUPS, 4);
});

test('SEC amplification: the production RPC client never retries in the background', () => {
	const source = readFileSync(new URL('../src/positions/index.mjs', import.meta.url), 'utf8');
	assert.match(source, /http\(`https:\/\/eth-mainnet\.g\.alchemy\.com\/v2\/\$\{apiKey\}`, \{ timeout: LIMITS\.rpcTimeoutMs, retryCount: 0 \}\)/);
	assert.match(source, /createPublicClient\(\{ chain: mainnet, transport: http\(`https:\/\/eth-mainnet\./, 'Chain und Endpunkt fest Mainnet');
	assert.doesNotMatch(source, /process\.env\.(?!ALCHEMY_API_KEY)[A-Z_]+/, 'keine weitere Umgebungsvariable bestimmt Chain oder URL');
	assert.equal(LIMITS.maxReservesPerMarket, 128);
	assert.equal(LIMITS.maxCallsPerLookup, 900);
	assert.equal(LIMITS.rpcTimeoutMs, 8_000);
	assert.equal(LIMITS.lookupBudgetMs, 15_000);
});

test('SEC amplification: worst-case payload stays bounded', async () => {
	const full = AAVE_V3_MARKETS.map((m) => marketState(m, Array.from({ length: LIMITS.maxReservesPerMarket }, (_, i) => reserve(asset(i + 1), `T${i}`, 18, 100_000_000n, { supply: 10n ** 18n, variableDebt: 10n ** 17n, collateral: true }))));
	positionsCache.reset();
	const result = await getWalletPositions(WALLET, { client: fakeClient(full), catalogLoader: async () => CATALOG });
	assert.equal(result.complete, true);
	const bytes = JSON.stringify(result).length;
	assert.ok(bytes < 400_000, `payload ${bytes} bytes`);
	assert.equal(result.positions.reduce((n, p) => n + p.supplied.length + p.borrowed.length, 0), 3 * 128 * 2);
});

test('SEC valuation: a mismatch far below 0.01 % of a large position now fails; exact Aave rounding passes', async () => {
	const big = [reserve(USDC, 'USDC', 6, 100_000_000n, { supply: 10_000_000_000_000n, collateral: true })]; // 10 Mio. USDC
	const good = marketState(CORE, big);
	assert.equal(byKey(await read(markets(good)), CORE).status, 'OK');
	const off = { ...good, account: [good.account[0] - 50_000_000_000n, 0n, 0n, 0n, 0n, MAX_UINT] }; // 500 USD = 0,005 %
	assert.equal(byKey(await read(markets(off)), CORE).reason, 'TOTALS_MISMATCH');
	const rounding = { ...good, account: [good.account[0] - 2n, 0n, 0n, 0n, 0n, MAX_UINT] };
	assert.equal(byKey(await read(markets(rounding)), CORE).status, 'OK', '2 Einheiten je Reserve bleiben erlaubt');
	const beyond = { ...good, account: [good.account[0] - 3n, 0n, 0n, 0n, 0n, MAX_UINT] };
	assert.equal(byKey(await read(markets(beyond)), CORE).reason, 'TOTALS_MISMATCH');
});

test('SEC registry: malformed reserve addresses and unexpected identities fail closed', async () => {
	const malformed = { ...marketState(CORE, [reserve(WETH, 'WETH', 18, 1n)]), reserveList: ['not-an-address'] };
	assert.equal(byKey(await read(markets(malformed)), CORE).reason, 'BAD_RESERVE_LIST');
	const otherProvider = { ...marketState(CORE, []), dataProvider: '0x2222222222222222222222222222222222222222' };
	assert.equal(byKey(await read(markets(otherProvider)), CORE).reason, 'REGISTRY_MISMATCH');
	const otherOracle = { ...marketState(CORE, []), oracle: '0x3333333333333333333333333333333333333333' };
	assert.equal(byKey(await read(markets(otherOracle)), CORE).reason, 'REGISTRY_MISMATCH');
	// Reserve-Adressen sind nur Argumente, nie Ziel eines Aufrufs.
	const client = fakeClient(markets(marketState(CORE, [reserve(WETH, 'WETH', 18, 1n, { supply: 1n })])));
	await readAaveV3Positions(WALLET, { client });
	assert.ok(!client.calls.some((c) => c.address.toLowerCase() === WETH.toLowerCase()));
});

test('SEC registry: the public lookup has no way to inject markets, contracts, chains or URLs', async () => {
	positionsCache.reset();
	const client = fakeClient(markets());
	const evil = { address: '0x4444444444444444444444444444444444444444', label: 'evil' };
	await getWalletPositions(WALLET, { client, catalogLoader: async () => CATALOG, markets: [evil], chainId: 137, rpcUrl: 'http://169.254.169.254/' });
	const allowed = new Set(AAVE_V3_MARKETS.flatMap((m) => [m.poolAddressesProvider, m.pool, m.dataProvider, m.oracle]).map((a) => a.toLowerCase()));
	assert.ok(client.calls.every((c) => allowed.has(c.address.toLowerCase())));
	const sources = ['index', 'aave-v3', 'match-nexus', 'aave-registry'].map((f) => readFileSync(new URL(`../src/positions/${f}.mjs`, import.meta.url), 'utf8')).join('\n');
	assert.doesNotMatch(sources, /fetch\(|tokenURI|ipfs|new URL\(/, 'kein URL-Abruf aus Positionsdaten');
});

test('SEC nexus: the displayed product name is pinned, never catalogue free text', () => {
	const odd = [{ ...CATALOG[0], officialName: `Aave${'!'.repeat(5_000)}v3` }];
	assert.deepEqual(matchDeployment(CORE.deploymentKey, odd), { state: 'MATCHED', productId: 97, productName: 'Aave v3' });
	assert.equal(matchDeployment(CORE.deploymentKey, [{ ...CATALOG[0], deprecated: true, status: 'DEPRECATED', officialName: '<b>x</b>' }]).productName, 'Aave v3');
});

test('SEC api: strict GET without parameters; rate-limit or DB failure is a clean 503', async () => {
	const { h, seen } = handler();
	for (const query of [{ Wallet: OTHER }, { 'wallet[]': OTHER }, { foo: 'bar' }, { x: 'y'.repeat(10_000) }]) {
		const r = res();
		await h({ method: 'GET', headers: cookie(WALLET), query }, r);
		assert.equal(r.statusCode, 400, JSON.stringify(Object.keys(query)));
	}
	for (const method of ['HEAD', 'OPTIONS', 'PUT', 'DELETE']) {
		const r = res();
		await h({ method, headers: cookie(WALLET), query: {} }, r);
		assert.equal(r.statusCode, 405, method);
	}
	assert.deepEqual(seen.wallets, []);
	for (const broken of [{ rateLimit: async () => { throw new Error('rate db password=x'); } }, { rateLimitFor: async () => { throw new Error('rate db'); } }]) {
		const b = handler(broken);
		const r = res();
		await b.h({ method: 'GET', headers: cookie(WALLET), query: {} }, r);
		assert.equal(r.statusCode, 503);
		assert.doesNotMatch(JSON.stringify(r.body), /password|rate db/);
		assert.deepEqual(b.seen.wallets, []);
	}
});

test('SEC api: busy and not-admitted lookups never return data or a second response', async () => {
	const busy = handler({ getPositions: async () => { throw new PositionsBusyError('busy'); } });
	const r1 = res();
	await busy.h({ method: 'GET', headers: cookie(WALLET), query: {} }, r1);
	assert.deepEqual([r1.statusCode, r1.body.code, r1.headers['retry-after']], [503, 'POSITIONS_BUSY', '5']);
	let writes = 0;
	const refused = handler({
		getPositions: async (_wallet, { admit }) => { if (!await admit()) throw new LookupNotAdmittedError('no'); return { ok: true }; },
		rateLimitFor: async (response, scope) => { if (scope === 'positions-lookup-global') { writes++; response.status(429).json({ ok: false }); return false; } return true; }
	});
	const r2 = res();
	await refused.h({ method: 'GET', headers: cookie(WALLET), query: {} }, r2);
	assert.equal(r2.statusCode, 429);
	assert.equal(writes, 1);
	assert.deepEqual(r2.body, { ok: false });
});

test('SEC api: wallet comes from the session even if headers or body try to name another', async () => {
	const { h, seen } = handler();
	const r = res();
	await h({ method: 'GET', headers: { ...cookie(WALLET), 'x-wallet': OTHER, 'x-forwarded-user': OTHER }, query: {}, body: { wallet: OTHER } }, r);
	assert.equal(r.statusCode, 200);
	assert.deepEqual(seen.wallets, [WALLET]);
});

test('SEC amplification: a joiner of a refused lookup gets busy, never a hanging request', async () => {
	positionsCache.reset();
	let resolveAdmit;
	const admit = () => new Promise((resolve) => { resolveAdmit = resolve; });
	const client = walletClient();
	const owner = getWalletPositions(WALLET, { client, catalogLoader: async () => CATALOG, admit });
	const joiner = getWalletPositions(WALLET, { client, catalogLoader: async () => CATALOG, admit: async () => { throw new Error('joiner must not be asked'); } });
	await new Promise((r) => setImmediate(r));
	resolveAdmit(false);
	await assert.rejects(owner, LookupNotAdmittedError);
	await assert.rejects(joiner, PositionsBusyError);
	assert.equal(client.calls.length, 0);
	assert.equal(positionsCache.activeLookups(), 0);
	assert.equal(positionsCache.cacheSize(), 0, 'eine Ablehnung wird nicht gecacht');
});
