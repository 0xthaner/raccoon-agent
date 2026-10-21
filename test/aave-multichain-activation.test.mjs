/**
 * Aave v3 Multi-Chain - inaktive RPC-, Oracle- und Umrechnungs-Vorbereitung (21.10.2026).
 *
 * Offline. Client-Konfiguration, Chain-Identitaet, RPC-Budget, Oracle-Frische
 * und Sequencer, chain-spezifische Umrechnungs-Referenzen, Randfaelle des
 * Lesers und die Aktivierungs-Bereitschaft. Dazu die Isolation: kein
 * Produktionsmodul importiert die Vorbereitung, kein RPC-Endpunkt im Browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';

Object.assign(process.env, {
	SUPABASE_URL: process.env.SUPABASE_URL || 'https://supabase.test.invalid',
	SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY || 'test-secret-key'
});

const A = await import('../src/positions/aave-multichain-activation.mjs');
const { AAVE_V3_MULTICHAIN_CANDIDATES: C } = await import('../src/positions/aave-multichain-candidates.mjs');
const { AAVE_V3_MARKETS, REFERENCE_TOKENS } = await import('../src/positions/aave-registry.mjs');
const { LIMITS } = await import('../src/positions/aave-v3.mjs');
const { computeAaveExposure } = await import('../src/positions/exposure.mjs');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORACLE = JSON.parse(readFileSync(new URL('./fixtures/aave/multichain-oracle-20261021.json', import.meta.url), 'utf8')).chains;
const ZERO = '0x0000000000000000000000000000000000000000';
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const cfg = (key) => A.configFor(key);
const ARB = cfg('aave-v3-arbitrum');
const OP = cfg('aave-v3-optimism');
const POLY = cfg('aave-v3-polygon');
const AVAX = cfg('aave-v3-avalanche');
const BASE = cfg('aave-v3-base');
const ETH = cfg('aave-v3-ethereum-core');
const NAME = { 42161: 'arbitrum', 8453: 'base', 10: 'optimism', 137: 'polygon', 43114: 'avalanche' };
const T = 1_792_564_900;

/* ----------------------------------------------------- Fake-Client -- */

function reserve(address, symbol, decimals, price, { supply = 0n, debt = 0n, collateral = false, frozen = false } = {}) {
	return { address, symbol, decimals, price, supply, debt, collateral, frozen };
}
function fakeClient(config, reserves, { chainId = config.chainId, hangChainId = false, hangMulticall = false, failFn = () => false } = {}) {
	const unit = (r) => 10n ** BigInt(r.decimals);
	const collateral = reserves.filter((r) => r.collateral).reduce((s, r) => s + (r.supply * r.price) / unit(r), 0n);
	const debt = reserves.reduce((s, r) => s + (r.debt > 0n ? (r.debt * r.price + unit(r) - 1n) / unit(r) : 0n), 0n);
	const calls = [];
	return {
		calls,
		getChainId: () => (hangChainId ? new Promise(() => {}) : Promise.resolve(chainId)),
		getBlockNumber: async () => 1_000n,
		async multicall({ contracts }) {
			if (hangMulticall) return new Promise(() => {});
			return contracts.map((c) => {
				calls.push(c);
				if (failFn(c)) return { status: 'failure', error: new Error('reverted') };
				const r = reserves.find((x) => x.address.toLowerCase() === String(c.args?.[0]).toLowerCase());
				const ok = (result) => ({ status: 'success', result });
				switch (c.functionName) {
					case 'getPool': return ok(config.pool);
					case 'getPriceOracle': return ok(config.oracle);
					case 'getPoolDataProvider': return ok(config.dataProvider);
					case 'getReservesList': return ok(reserves.map((x) => x.address));
					case 'getUserAccountData': return ok([collateral, debt, 0n, 8_200n, 7_500n, debt === 0n ? (1n << 256n) - 1n : 2n * 10n ** 18n]);
					case 'BASE_CURRENCY': return ok(ZERO);
					case 'BASE_CURRENCY_UNIT': return ok(100_000_000n);
					case 'getAllReservesTokens': return ok(reserves.map((x) => ({ symbol: x.symbol, tokenAddress: x.address })));
					case 'getUserReserveData': return ok([r.supply, 0n, r.debt, 0n, 0n, 0n, 0n, 0, r.collateral]);
					case 'getReserveConfigurationData': return ok([BigInt(r.decimals), 7_500n, 8_000n, 10_500n, 1_000n, true, true, false, true, r.frozen]);
					case 'getAssetsPrices': return ok(c.args[0].map((a) => reserves.find((x) => x.address.toLowerCase() === a.toLowerCase()).price));
					default: return { status: 'failure', error: new Error('unexpected') };
				}
			});
		}
	};
}
const scan = (config, reserves, options = {}) => A.scanDeployment(WALLET, config, { client: fakeClient(config, reserves, options), allowInactive: true, ...options });

/* -------------------------------------------- A: Client-Konfiguration -- */

test('MC-RPC-CONFIG six chain configs; only Ethereum (mirror of production) enabled; no URL, no key', () => {
	assert.deepEqual(A.CHAIN_CLIENT_CONFIGS.map((c) => [c.chainId, c.deploymentKey, c.rpc.network, c.enabled]), [
		[1, 'aave-v3-ethereum-core', 'eth-mainnet', true],
		[42161, 'aave-v3-arbitrum', 'arb-mainnet', false],
		[8453, 'aave-v3-base', 'base-mainnet', false],
		[10, 'aave-v3-optimism', 'opt-mainnet', false],
		[137, 'aave-v3-polygon', 'polygon-mainnet', false],
		[43114, 'aave-v3-avalanche', 'avax-mainnet', false]
	]);
	for (const c of A.CHAIN_CLIENT_CONFIGS) {
		const market = [...AAVE_V3_MARKETS, ...C].find((m) => m.deploymentKey === c.deploymentKey);
		assert.deepEqual([c.pool, c.poolAddressesProvider, c.oracle, c.dataProvider], [market.pool, market.poolAddressesProvider, market.oracle, market.dataProvider]);
		assert.equal(c.multicall3, '0xcA11bde05977b3631167028862bE2a173976CA11');
		assert.equal(c.multicallAvailable, true);
		assert.equal(c.rpc.configKey, 'ALCHEMY_API_KEY');
		assert.equal(c.rpc.provisioned, c.chainId === 1);
		assert.equal(c.budget, A.RPC_BUDGET);
		assert.doesNotMatch(JSON.stringify(c), /https?:|\/\/|alchemy\.com|publicnode|infura/i, 'no endpoint in config');
		assert.ok(Object.isFrozen(c) && Object.isFrozen(c.rpc));
	}
	assert.ok(C.every((entry) => entry.productionEnabled === false));
	// Sequencer-Feeds nur auf den Rollups, on-chain als solche beschrieben
	for (const c of A.CHAIN_CLIENT_CONFIGS.filter((x) => x.chainId !== 1)) {
		const seen = ORACLE[NAME[c.chainId]].sequencer;
		if (c.sequencerFeed) assert.deepEqual([seen.address, seen.description], [c.sequencerFeed, 'L2 Sequencer Uptime Status Feed']);
		else assert.equal(seen, undefined, `${c.deploymentKey}: no rollup sequencer`);
		assert.equal(ORACLE[NAME[c.chainId]].fallbackOracle, ZERO, 'no fallback oracle');
	}
});

/* ------------------------------------------------ C: Budget -- */

test('MC-RPC-BUDGET budget equals the production reader limits; reverts never retried, transport at most once within budget', () => {
	assert.deepEqual(
		[A.RPC_BUDGET.requestTimeoutMs, A.RPC_BUDGET.scanBudgetMs, A.RPC_BUDGET.maxCallsPerScan, A.RPC_BUDGET.maxReservesPerMarket],
		[LIMITS.rpcTimeoutMs, LIMITS.lookupBudgetMs, LIMITS.maxCallsPerLookup, LIMITS.maxReservesPerMarket]
	);
	assert.equal(A.RPC_BUDGET.maxMulticallItems, 8 + 2 * 128 + 1);
	assert.deepEqual([A.RPC_BUDGET.transportRetries, A.RPC_BUDGET.revertRetries, A.RPC_BUDGET.viemRetryCount], [1, 0, 0]);
	const d = (kind, attempt, elapsedMs) => A.retryDecision({ kind, attempt, elapsedMs }).retry;
	assert.equal(d('REVERT', 0, 0), false);
	assert.equal(d('CHAIN_MISMATCH', 0, 0), false);
	assert.equal(d('IDENTITY_MISMATCH', 0, 0), false);
	assert.equal(d('TIMEOUT', 0, 0), true);
	assert.equal(d('TRANSPORT', 0, 6_999), true);
	assert.equal(d('TRANSPORT', 0, 7_001), false, 'not enough budget for a full request');
	assert.equal(d('TIMEOUT', 1, 0), false, 'at most one retry');
	assert.equal(d('SOMETHING', 0, 0), false);
	assert.equal(d('TIMEOUT', -1, 0), false);
	assert.equal(d('TIMEOUT', 0, Number.NaN), false);
});

/* ----------------------------------------- B: Chain-Identitaet -- */

test('MC-IDENTITY same Pool/Provider on the wrong chain fails closed; only chainId + key + provider-reported contracts pass', () => {
	const observe = (c, patch = {}) => ({ rpcChainId: c.chainId, pool: c.pool, oracle: c.oracle, dataProvider: c.dataProvider, ...patch });
	for (const c of A.CHAIN_CLIENT_CONFIGS) assert.equal(A.verifyChainIdentity(c, observe(c)).ok, true, c.deploymentKey);
	// Arbitrum, Optimism, Polygon, Avalanche: gleicher Pool und Provider
	const shared = [ARB, OP, POLY, AVAX];
	assert.equal(new Set(shared.map((c) => c.pool)).size, 1);
	assert.equal(new Set(shared.map((c) => c.poolAddressesProvider)).size, 1);
	for (const a of shared) for (const b of shared) {
		if (a === b) continue;
		// Client einer anderen Chain, die denselben Pool meldet
		assert.equal(A.verifyChainIdentity(a, observe(a, { rpcChainId: b.chainId })).reason, 'CHAIN_MISMATCH', `${a.deploymentKey} via ${b.deploymentKey}`);
		// richtige Chain, aber Oracle/Data-Provider der anderen Chain
		if (a.oracle !== b.oracle) assert.equal(A.verifyChainIdentity(a, observe(a, { oracle: b.oracle })).reason, 'ORACLE_MISMATCH');
	}
	assert.equal(A.verifyChainIdentity(BASE, observe(BASE, { pool: ARB.pool })).reason, 'POOL_MISMATCH');
	assert.equal(A.verifyChainIdentity(BASE, observe(BASE, { dataProvider: ARB.dataProvider })).reason, 'DATA_PROVIDER_MISMATCH');
	for (const rpcChainId of ['42161', 42161n, null, 1, 42161.0 + 0.5]) assert.equal(A.verifyChainIdentity(ARB, observe(ARB, { rpcChainId })).ok, false, String(rpcChainId));
	assert.equal(A.verifyChainIdentity({ ...ARB }, observe(ARB)).reason, 'UNKNOWN_CONFIG', 'copied/forged config');
	assert.equal(A.verifyChainIdentity(ARB, null).reason, 'NO_OBSERVATION');
});

test('MC-SCAN chainId is checked before any read; RPC timeout and partial multicall failure stay UNAVAILABLE; inactive needs opt-in', async () => {
	const weth = reserve('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 'WETH', 18, 244_083_000_000n, { supply: 10n ** 18n, collateral: true });
	// Chain eines anderen Deployments mit demselben Pool: kein einziger Lesevorgang
	const wrong = fakeClient(ARB, [weth], { chainId: 10 });
	assert.deepEqual(await A.scanDeployment(WALLET, ARB, { client: wrong, allowInactive: true }), { status: 'UNAVAILABLE', reason: 'CHAIN_MISMATCH' });
	assert.equal(wrong.calls.length, 0);
	// ohne Opt-in wird ein inaktives Deployment nicht gelesen
	const idle = fakeClient(ARB, [weth]);
	assert.equal((await A.scanDeployment(WALLET, ARB, { client: idle })).reason, 'NOT_ENABLED');
	assert.equal(idle.calls.length, 0);
	assert.equal((await A.scanDeployment(WALLET, { ...ARB, enabled: true }, { client: idle })).reason, 'UNKNOWN_CONFIG');
	// Timeouts
	const fast = { ...A.RPC_BUDGET, requestTimeoutMs: 20, scanBudgetMs: 50 };
	assert.equal((await scan(ARB, [weth], { hangChainId: true, budget: fast })).reason, 'RPC_TIMEOUT');
	assert.equal((await scan(ARB, [weth], { hangMulticall: true, budget: fast })).reason, 'RPC_TIMEOUT');
	// ein einzelner fehlgeschlagener Aufruf im Multicall
	const partial = await scan(ARB, [weth], { failFn: (c) => c.functionName === 'getReserveConfigurationData' });
	assert.deepEqual([partial.status, partial.reason, partial.position], ['UNAVAILABLE', 'CALL_FAILED', null]);
	const ok = await scan(ARB, [weth]);
	assert.deepEqual([ok.status, ok.chainId, ok.position.deploymentKey, ok.position.totals.suppliedUsd], ['OK', 42161, 'aave-v3-arbitrum', '2440.83']);
});

/* --------------------------------- F: Randfaelle des Lesers -- */

test('MC-EDGE decimals 2/6/8/18, frozen reserve with balance, wrapped native, zero price, duplicate USDC symbols', async () => {
	const reserves = [
		reserve('0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 'WETH', 18, 244_062_797_133n, { supply: 10n ** 18n, collateral: true }),
		reserve('0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', 'WPOL', 18, 9_553_485n, { supply: 1_000n * 10n ** 18n, collateral: true }),
		reserve('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 'USDC', 6, 99_980_204n, { supply: 500n * 10n ** 6n, collateral: true }),
		reserve('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 'USDC', 6, 99_980_204n, { debt: 100n * 10n ** 6n, frozen: true }),
		reserve('0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', 'WBTC', 8, 8_272_943_100_000n, { supply: 1_000_000n, collateral: true }),
		reserve('0xE111178A87A3BFf0c8d18DECBa5798827539Ae99', 'EURS', 2, 112_220_000n, { supply: 10_000n, collateral: true, frozen: true })
	];
	const result = await scan(POLY, reserves);
	assert.equal(result.status, 'OK');
	const p = result.position;
	const bySymbolAddr = (list, sym, addr) => list.find((x) => x.symbol === sym && x.asset.toLowerCase() === addr.toLowerCase());
	assert.equal(bySymbolAddr(p.supplied, 'WETH', reserves[0].address).usdValue, '2440.62797133');
	assert.equal(bySymbolAddr(p.supplied, 'WPOL', reserves[1].address).usdValue, '95.53485');
	assert.equal(bySymbolAddr(p.supplied, 'USDC', reserves[2].address).usdValue, '499.90102');
	assert.equal(bySymbolAddr(p.borrowed, 'USDC', reserves[3].address).usdValue, '99.980204', 'frozen bridged USDC debt still counted');
	assert.equal(bySymbolAddr(p.supplied, 'WBTC', reserves[4].address).usdValue, '827.29431');
	assert.equal(bySymbolAddr(p.supplied, 'EURS', reserves[5].address).usdValue, '112.22', '2 decimals, frozen, still valued');
	// zwei Eintraege mit Symbol USDC, unterschieden nur ueber die Adresse
	assert.equal([...p.supplied, ...p.borrowed].filter((x) => x.symbol === 'USDC').length, 2);
	assert.equal(A.classifyReserveForConversion(137, reserves[2].address).status, 'SUPPORTED_REFERENCE');
	assert.equal(A.classifyReserveForConversion(137, reserves[3].address).status, 'AMBIGUOUS_REFERENCE');
	assert.equal(A.classifyReserveForConversion(137, reserves[1].address).status, 'UNAVAILABLE_REFERENCE', 'WPOL is not a cover asset');
	assert.equal(computeAaveExposure(p).status, 'OK');
	// Preis 0 -> Markt nicht bewertbar, nie "keine Position"
	const zero = await scan(POLY, [reserve(reserves[0].address, 'WETH', 18, 0n, { supply: 10n ** 18n, collateral: true })]);
	assert.deepEqual([zero.status, zero.reason], ['UNAVAILABLE', 'MISSING_PRICE']);
});

test('MC-EDGE-REFERENCE Ethereum reference tokens leak by address onto Base in the current reader; the chain-keyed resolver does not', async () => {
	// cbBTC hat auf Base dieselbe Adresse wie auf Ethereum
	assert.equal(REFERENCE_TOKENS.cbBTC, '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf');
	const cbbtc = reserve(REFERENCE_TOKENS.cbBTC, 'cbBTC', 8, 8_276_061_693_696n, { supply: 100_000n, collateral: true });
	const leaked = await scan(BASE, [cbbtc]);
	assert.deepEqual(leaked.position.pricing.reference.map((r) => r.token), ['cbBTC'], 'documented hazard: production reader matches by address only');
	// deshalb vor jeder Aktivierung: Referenzen nur ueber (chainId, Adresse)
	assert.equal(A.classifyReserveForConversion(8453, REFERENCE_TOKENS.cbBTC).status, 'SUPPORTED_REFERENCE');
	for (const chainId of [42161, 10, 137, 43114]) assert.equal(A.classifyReserveForConversion(chainId, REFERENCE_TOKENS.cbBTC).status, 'UNAVAILABLE_REFERENCE', String(chainId));
	assert.equal(A.classifyReserveForConversion(1, REFERENCE_TOKENS.cbBTC).status, 'UNAVAILABLE_REFERENCE', 'Ethereum stays on the production path');
	// WETH 0x4200...0006 gibt es auf Base und Optimism
	const opWeth = '0x4200000000000000000000000000000000000006';
	assert.equal(A.classifyReserveForConversion(8453, opWeth).status, 'SUPPORTED_REFERENCE');
	assert.equal(A.classifyReserveForConversion(10, opWeth).status, 'SUPPORTED_REFERENCE');
	assert.equal(A.classifyReserveForConversion(42161, opWeth).status, 'UNAVAILABLE_REFERENCE');
	assert.equal(A.resolveConversionReference(10, 'ETH', { token: opWeth, decimals: 18, price: 1n, aaveSource: A.referencesFor(8453)[0].aaveSource, sourceDescription: 'ETH / USD' }).reason, 'PRICE_SOURCE_MISMATCH', 'Base source on Optimism');
});

/* ---------------------------------------- E: Umrechnungs-Referenzen -- */

test('MC-REFERENCE per chain: ETH and native USDC supported, bridged USDC ambiguous, cbBTC only on Base, all checked against the on-chain reading', () => {
	const expected = {
		42161: ['SUPPORTED_REFERENCE', 'SUPPORTED_REFERENCE', 'UNAVAILABLE_REFERENCE'],
		8453: ['SUPPORTED_REFERENCE', 'SUPPORTED_REFERENCE', 'SUPPORTED_REFERENCE'],
		10: ['SUPPORTED_REFERENCE', 'SUPPORTED_REFERENCE', 'UNAVAILABLE_REFERENCE'],
		137: ['SUPPORTED_REFERENCE', 'SUPPORTED_REFERENCE', 'UNAVAILABLE_REFERENCE'],
		43114: ['SUPPORTED_REFERENCE', 'SUPPORTED_REFERENCE', 'UNAVAILABLE_REFERENCE']
	};
	for (const [chainId, statuses] of Object.entries(expected)) {
		const id = Number(chainId);
		assert.deepEqual(A.COVER_ASSETS.map((asset) => A.resolveConversionReference(id, asset).status), statuses, chainId);
		assert.equal(A.resolveConversionReference(id, 'cbBTC').reason, id === 8453 ? 'STATIC' : 'ASSET_NOT_ON_CHAIN');
		const seen = Object.values(ORACLE[NAME[id]].assets);
		for (const r of A.referencesFor(id)) {
			assert.equal(r.token, getAddress(r.token));
			const onchain = seen.find((x) => x.address === r.token);
			assert.ok(onchain, `${chainId} ${r.coverAsset} read on-chain`);
			assert.deepEqual([onchain.decimals, onchain.source, onchain.description], [r.decimals, r.aaveSource, r.sourceDescription]);
			assert.equal(r.freshnessFeed, onchain.roundData ? onchain.source : onchain.innerAggregator, 'freshness feed exposes updatedAt');
			assert.ok(BigInt(onchain.price) > 0n);
			const observed = { token: r.token, decimals: onchain.decimals, price: BigInt(onchain.price), aaveSource: onchain.source, sourceDescription: onchain.description };
			assert.equal(A.resolveConversionReference(id, r.coverAsset, observed).status, 'SUPPORTED_REFERENCE');
			// Abweichungen fallen geschlossen
			assert.equal(A.resolveConversionReference(id, r.coverAsset, { ...observed, price: 0n }).status, 'UNAVAILABLE_REFERENCE');
			assert.equal(A.resolveConversionReference(id, r.coverAsset, { ...observed, price: 5 }).status, 'UNAVAILABLE_REFERENCE');
			assert.equal(A.resolveConversionReference(id, r.coverAsset, { ...observed, decimals: 18 === r.decimals ? 6 : 18 }).status, 'AMBIGUOUS_REFERENCE');
			assert.equal(A.resolveConversionReference(id, r.coverAsset, { ...observed, sourceDescription: 'stETH / ETH' }).status, 'AMBIGUOUS_REFERENCE', 'bridged native-like asset with a different feed');
			assert.equal(A.resolveConversionReference(id, r.coverAsset, { ...observed, token: '0x000000000000000000000000000000000000dEaD' }).status, 'UNAVAILABLE_REFERENCE', 'unknown token');
		}
	}
	// gebridgte USDC: gleiches Symbol, sogar dieselbe Aave-Quelle, trotzdem keine Referenz
	for (const [name, bridged] of [['arbitrum', 'USDC_bridged'], ['optimism', 'USDC_bridged'], ['polygon', 'USDC_bridged'], ['base', 'USDbC']]) {
		const chainId = Number(Object.keys(NAME).find((k) => NAME[k] === name));
		const b = ORACLE[name].assets[bridged];
		const native = A.referencesFor(chainId).find((r) => r.coverAsset === 'USDC');
		assert.equal(b.source, native.aaveSource, `${name}: same Aave price source`);
		const verdict = A.resolveConversionReference(chainId, 'USDC', { token: b.address, decimals: b.decimals, price: BigInt(b.price), aaveSource: b.source, sourceDescription: b.description });
		assert.deepEqual([verdict.status, verdict.reason], ['AMBIGUOUS_REFERENCE', 'BRIDGED_USDC'], name);
	}
	// gebridgtes ETH (Polygon WETH, Avalanche WETH.e) nur mit direktem ETH/USD-Feed
	assert.deepEqual(A.referencesFor(137).find((r) => r.coverAsset === 'ETH').kind, 'bridged-weth');
	assert.deepEqual(A.referencesFor(43114).find((r) => r.coverAsset === 'ETH').kind, 'bridged-weth');
	// nicht unterstuetzte Cover-Assets, Wrapped Native, Ethereum, unbekannte Chain
	for (const asset of ['WAVAX', 'WPOL', 'DAI', 'NXM', 'eth', 'usdc', 'BTC', 'WBTC']) assert.deepEqual(A.resolveConversionReference(43114, asset).reason, 'NOT_A_COVER_ASSET', asset);
	assert.equal(A.resolveConversionReference(1, 'USDC').reason, 'ETHEREUM_USES_PRODUCTION_PATH');
	assert.equal(A.resolveConversionReference(56, 'USDC').reason, 'UNSUPPORTED_CHAIN');
	assert.equal(A.resolveConversionReference('42161', 'USDC').reason, 'UNSUPPORTED_CHAIN');
	assert.equal(A.classifyReserveForConversion(43114, '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7').status, 'UNAVAILABLE_REFERENCE', 'WAVAX');
	assert.equal(A.classifyReserveForConversion(43114, 'WAVAX').reason, 'UNKNOWN_TOKEN');
	assert.equal(A.classifyReserveForConversion('8453', REFERENCE_TOKENS.cbBTC).reason, 'UNKNOWN_TOKEN', 'chainId as string');
});

/* -------------------------------------------- D: Oracle-Frische -- */

test('MC-ORACLE freshness: fresh, stale, sequencer down, grace period and every missing piece is UNKNOWN', () => {
	const feedsFor = (chainId, updatedAt = T - 600, answer = '100000000') => A.referencesFor(chainId).map((r) => ({ feed: r.freshnessFeed, answer, updatedAt }));
	const up = { answer: 0, startedAt: T - 10 * 86_400 };
	const f = (chainId, patch = {}) => A.oracleFreshness(chainId, { nowSec: T, sequencer: A.configFor(C.find((c) => c.chainId === chainId).deploymentKey).sequencerFeed ? up : null, feeds: feedsFor(chainId), ...patch });
	for (const c of C) assert.equal(f(c.chainId).state, 'ORACLE_FRESH', c.label);
	// real gelesene Alter (bis ~16 h beim USDC-Feed) liegen innerhalb der Grenze
	for (const c of C) {
		const seen = ORACLE[NAME[c.chainId]];
		const feeds = A.referencesFor(c.chainId).map((r) => {
			const a = Object.values(seen.assets).find((x) => x.address === r.token);
			return { feed: r.freshnessFeed, answer: a.roundData?.answer ?? '1', updatedAt: seen.timestamp - (a.roundData ? a.roundData.ageSec : a.innerAgeSec) };
		});
		const sequencer = seen.sequencer ? { answer: Number(seen.sequencer.answer), startedAt: seen.sequencer.startedAt } : null;
		assert.equal(A.oracleFreshness(c.chainId, { nowSec: seen.timestamp, sequencer, feeds }).state, 'ORACLE_FRESH', `${c.label} as read on 21.10.2026`);
	}
	// veraltet
	assert.equal(f(42161, { feeds: feedsFor(42161, T - A.ORACLE_POLICY.maxFeedAgeSec - 1) }).state, 'ORACLE_STALE');
	assert.equal(f(137, { feeds: feedsFor(137, T - A.ORACLE_POLICY.maxFeedAgeSec) }).state, 'ORACLE_FRESH', 'boundary');
	// Sequencer
	assert.equal(f(8453, { sequencer: { answer: 1, startedAt: T - 100 } }).state, 'SEQUENCER_DOWN');
	assert.equal(f(10, { sequencer: { answer: 0, startedAt: T - 3_599 } }).state, 'SEQUENCER_GRACE_PERIOD');
	assert.equal(f(10, { sequencer: { answer: 0, startedAt: T - 3_600 } }).state, 'ORACLE_FRESH');
	for (const sequencer of [null, undefined, {}, { answer: 0 }, { answer: 0, startedAt: 0 }, { answer: 0, startedAt: T + 3_600 }, { answer: 0, startedAt: '1' }]) {
		assert.equal(f(42161, { sequencer }).state, 'UNKNOWN', JSON.stringify(sequencer));
	}
	assert.equal(f(137, { sequencer: up }).reason, 'UNEXPECTED_SEQUENCER_DATA', 'Polygon has no sequencer feed');
	// Feeds
	assert.equal(f(8453, { feeds: feedsFor(8453).slice(1) }).reason, 'FEED_MISSING', 'cbBTC/USDC/ETH all required on Base');
	assert.equal(f(43114, { feeds: [] }).state, 'UNKNOWN');
	assert.equal(f(43114, { feeds: feedsFor(43114, T - 60, '0') }).reason, 'FEED_ANSWER_INVALID');
	assert.equal(f(43114, { feeds: feedsFor(43114, T - 60, '-1') }).reason, 'FEED_ANSWER_INVALID');
	assert.equal(f(43114, { feeds: feedsFor(43114, T + 3_600) }).reason, 'FEED_TIMESTAMP_INVALID');
	assert.equal(f(43114, { feeds: feedsFor(43114, '1792564000') }).reason, 'FEED_TIMESTAMP_INVALID');
	assert.equal(f(43114, { feeds: feedsFor(42161) }).reason, 'FEED_MISSING', 'feeds of another chain do not count');
	assert.equal(A.oracleFreshness(42161, null).state, 'UNKNOWN');
	assert.equal(A.oracleFreshness(1, { nowSec: T }).reason, 'UNSUPPORTED_CHAIN');
	assert.equal(A.oracleFreshness(56, { nowSec: T }).state, 'UNKNOWN');
	assert.deepEqual(A.ORACLE_STATES, ['ORACLE_FRESH', 'ORACLE_STALE', 'SEQUENCER_DOWN', 'SEQUENCER_GRACE_PERIOD', 'UNKNOWN']);
});

/* --------------------------------- G: Aktivierungs-Bereitschaft -- */

test('MC-READINESS no candidate is quote- or production-ready; PROBABLE always blocks; all six conditions are needed', () => {
	for (const c of C) {
		const facts = A.currentActivationFacts(c.deploymentKey);
		assert.deepEqual([facts.detectionReady, facts.rpcReady, facts.oracleReady, facts.conversionReady, facts.nexusScope, facts.enabled], [true, false, false, true, 'PROBABLE', false]);
		const r = A.activationReadiness(facts);
		assert.deepEqual([r.quoteReady, r.productionActivationReady], [false, false]);
		assert.deepEqual(r.blockers, ['RPC_NOT_PROVISIONED', 'ORACLE_FRESHNESS_NOT_PROVEN', 'NEXUS_SCOPE_PROBABLE', 'NOT_ENABLED', 'NO_PRODUCTION_PATH']);
	}
	const all = { detectionReady: true, rpcReady: true, oracleReady: true, conversionReady: true, nexusScope: 'CONFIRMED', enabled: true };
	// hypothetisch alles erfuellt: Quote waere moeglich, Produktion trotzdem nicht
	assert.deepEqual([A.activationReadiness(all).quoteReady, A.activationReadiness(all).productionActivationReady, A.activationReadiness(all).blockers], [true, false, ['NO_PRODUCTION_PATH']]);
	for (const key of Object.keys(all)) {
		const missing = { ...all, [key]: key === 'nexusScope' ? 'PROBABLE' : false };
		assert.equal(A.activationReadiness(missing).quoteReady, false, key);
	}
	for (const nexusScope of ['PROBABLE', 'AMBIGUOUS', 'UNSUPPORTED', 'confirmed', undefined]) assert.equal(A.activationReadiness({ ...all, nexusScope }).quoteReady, false, String(nexusScope));
	assert.equal(A.activationReadiness({ ...all, enabled: 'true' }).quoteReady, false, 'only boolean true');
	assert.equal(A.activationReadiness(null).quoteReady, false);
	assert.equal(A.currentActivationFacts('aave-v3-ethereum-core'), null);
	assert.ok(A.activationMatrix().every((row) => row.quoteReady === false && row.productionActivationReady === false && row.productionEnabled === false));
});

/* ----------------------------------------------- Isolation -- */

test('MC-ISOLATION nothing in production imports the preparation; no RPC endpoint in browser code; doc matrix matches', () => {
	const walk = (dir) => readdirSync(dir).flatMap((name) => {
		const full = path.join(dir, name);
		return statSync(full).isDirectory() ? (name === 'node_modules' ? [] : walk(full)) : [full];
	});
	const sources = ['api', 'src', 'web', 'scripts'].flatMap((dir) => walk(path.join(REPO, dir))).filter((file) => /\.(m?js|html)$/.test(file));
	const importers = sources.filter((file) => /aave-multichain-(activation|candidates)/.test(readFileSync(file, 'utf8'))).map((file) => path.relative(REPO, file));
	assert.deepEqual(importers, ['src/positions/aave-multichain-activation.mjs'], 'only the activation module itself refers to the candidates');
	// Browser-Code kennt keinen RPC-Endpunkt
	for (const file of sources.filter((f) => path.relative(REPO, f).startsWith('web/'))) {
		assert.doesNotMatch(readFileSync(file, 'utf8'), /alchemy\.com|publicnode|infura\.io|(arb|base|opt|polygon|avax)-mainnet|\.g\.alchemy|rpc\.ankr/i, path.relative(REPO, file));
	}
	// keine neue API-Route
	const routes = walk(path.join(REPO, 'api')).map((f) => path.relative(REPO, f)).filter((f) => /purchase|buy|execute|multichain|arbitrum|optimism|polygon|avalanche/i.test(f));
	assert.deepEqual(routes, []);
	const doc = JSON.parse(readFileSync(path.join(REPO, 'docs/aave-v3-multichain-activation.json'), 'utf8'));
	assert.deepEqual(doc, JSON.parse(JSON.stringify(A.activationMatrix())));
});
