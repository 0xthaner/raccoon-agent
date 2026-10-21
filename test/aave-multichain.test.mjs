/**
 * Aave v3 auf Arbitrum, Base, Optimism, Polygon, Avalanche - inaktive Kandidaten (21.10.2026).
 *
 * Offline. Prueft die exakte Identitaet (chainId, Key, Pool, Provider) gegen den
 * on-chain gelesenen Fixture-Stand, die Ablehnung falscher Chains, Pools, Provider,
 * Namen und nicht gepruefter Deployments, dass kein Kandidat eine Quote bekommt,
 * dass die Laufzeit (Registry, Nexus-Zuordnung, Read-Model) unveraendert nur
 * Ethereum kennt und dass kein Produktionsmodul die Kandidaten importiert.
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

const MC = await import('../src/positions/aave-multichain-candidates.mjs');
const R = await import('../src/aave-cover-readiness.mjs');
const { AAVE_V3_MARKETS, nexusProductIdFor } = await import('../src/positions/aave-registry.mjs');
const { matchPositionToNexus } = await import('../src/positions/nexus-mapping.mjs');
const { matchDeployment } = await import('../src/positions/match-nexus.mjs');
const { readAaveV3Positions } = await import('../src/positions/aave-v3.mjs');
const { computeAaveExposure } = await import('../src/positions/exposure.mjs');
const { getNexusReadModel } = await import('../src/nexus-read-model.mjs');
const { checkQuoteRequest, parseCoverRequest } = await import('../src/nexus-quote.mjs');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/aave/multichain-verify-20261021.json', import.meta.url), 'utf8')).deployments;
const C = MC.AAVE_V3_MULTICHAIN_CANDIDATES;
const byKey = Object.fromEntries(C.map((entry) => [entry.deploymentKey, entry]));
const ARB = byKey['aave-v3-arbitrum'];
const CORE = AAVE_V3_MARKETS[0];
const ZERO = '0x0000000000000000000000000000000000000000';
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = Date.UTC(2026, 9, 21, 6);
const claim = (entry, patch = {}) => ({ chainId: entry.chainId, protocolKey: 'aave', protocolVersion: 'v3', deploymentKey: entry.deploymentKey, pool: entry.pool, poolAddressesProvider: entry.poolAddressesProvider, ...patch });
const asPosition = (entry, patch = {}) => ({ wallet: WALLET, chainId: entry.chainId, protocolKey: 'aave', protocolVersion: 'v3', deploymentKey: entry.deploymentKey, label: entry.label, marketAddress: entry.pool, ...patch });

test('AAVE-MC-REGISTRY five candidates, pinned to the on-chain verified address book entries, all inactive', () => {
	assert.deepEqual(C.map((e) => [e.deploymentKey, e.chainId]), [['aave-v3-arbitrum', 42161], ['aave-v3-base', 8453], ['aave-v3-optimism', 10], ['aave-v3-polygon', 137], ['aave-v3-avalanche', 43114]]);
	for (const entry of C) {
		const onchain = FIXTURE[entry.label.toLowerCase()];
		assert.ok(onchain && !onchain.error, entry.deploymentKey);
		assert.equal(onchain.chainIdRpc, entry.chainId);
		assert.equal(onchain.marketId, entry.marketId);
		assert.ok(onchain.poolMatches && onchain.oracleMatches && onchain.dataProviderMatches, `${entry.deploymentKey} provider -> pool/oracle/data provider`);
		for (const field of ['poolAddressesProvider', 'pool', 'oracle', 'dataProvider']) {
			assert.equal(entry[field], getAddress(entry[field]), `${entry.deploymentKey} ${field} checksummed`);
			assert.equal(entry[field], onchain[field], `${entry.deploymentKey} ${field}`);
		}
		assert.deepEqual([entry.deploymentClass, entry.nexusScope, entry.productionEnabled], ['SUPPORTED_CANDIDATE', 'PROBABLE', false]);
		assert.ok(Object.isFrozen(entry));
	}
	assert.ok(!C.some((e) => e.nexusScope === 'CONFIRMED' || e.productionEnabled !== false), 'nothing confirmed or enabled');
	assert.equal(new Set(C.map((e) => e.chainId)).size, C.length, 'one market per chain');
});

test('AAVE-MC-EXPOSURE every candidate prices in USD with 8 decimals, no zero price, no paused reserve, sane decimals', () => {
	for (const entry of C) {
		const onchain = FIXTURE[entry.label.toLowerCase()];
		assert.deepEqual([onchain.baseCurrency, onchain.baseUnit], [ZERO, '100000000'], entry.deploymentKey);
		assert.deepEqual(onchain.zeroPrices, []);
		assert.deepEqual(onchain.paused, []);
		assert.equal(onchain.active, onchain.reserves);
		assert.ok(onchain.reserves > 0 && onchain.reserves <= 128);
		assert.ok(onchain.decimals.every((d) => Number.isInteger(d) && d >= 0 && d <= 36));
		assert.ok(onchain.multicall3Deployed);
	}
});

test('AAVE-MC-EXACT only the exact (chainId, key, pool, provider) tuple resolves', () => {
	for (const entry of C) assert.deepEqual(MC.resolveMultichainCandidate(claim(entry)), { class: 'SUPPORTED_CANDIDATE', reason: 'EXACT_CANDIDATE_MATCH', deploymentKey: entry.deploymentKey });
	assert.equal(MC.resolveMultichainCandidate(claim(ARB, { pool: ARB.pool.toLowerCase() })).class, 'SUPPORTED_CANDIDATE', 'address case is not identity');
});

test('AAVE-MC-REJECT wrong chain, pool, provider, fuzzy names, other versions and unverified deployments fail closed', () => {
	const cls = (patch, entry = ARB) => MC.resolveMultichainCandidate(claim(entry, patch));
	// falsche Chain, auch als String oder mit Ethereum
	for (const chainId of [1, 10, 137, 8453, 43114, 42170, '42161', 42161n, null, undefined, 42161.5]) assert.notEqual(cls({ chainId }).class, 'SUPPORTED_CANDIDATE', String(chainId));
	assert.deepEqual([cls({ chainId: 10 }).class, cls({ chainId: 10 }).reason], ['AMBIGUOUS', 'CHAIN_CONFLICT']);
	// falscher Pool / Provider
	assert.deepEqual(cls({ pool: byKey['aave-v3-base'].pool }).reason, 'POOL_CONFLICT');
	assert.deepEqual(cls({ pool: CORE.pool }).reason, 'POOL_CONFLICT');
	assert.deepEqual(cls({ pool: undefined }).reason, 'POOL_CONFLICT');
	assert.deepEqual(cls({ poolAddressesProvider: byKey['aave-v3-base'].poolAddressesProvider }).reason, 'PROVIDER_CONFLICT');
	assert.deepEqual(cls({ poolAddressesProvider: undefined }).reason, 'PROVIDER_CONFLICT');
	assert.deepEqual(cls({ pool: `${ARB.pool} ` }).reason, 'POOL_CONFLICT');
	// Namen und Varianten sind keine Kennung
	for (const deploymentKey of ['Arbitrum', 'arbitrum', 'Arbitrum Aave Market', 'AaveV3Arbitrum', 'AAVE-V3-ARBITRUM', ' aave-v3-arbitrum', 'aave-v3-arbitrum-core', 'aave-v3-arb', 'aave v3 arbitrum', undefined]) {
		assert.deepEqual(cls({ deploymentKey }).class, 'UNSUPPORTED', String(deploymentKey));
	}
	// andere Protokolle, Versionen, nicht gepruefte Deployments
	assert.equal(cls({ protocolKey: 'Aave' }).class, 'UNSUPPORTED');
	assert.equal(cls({ protocolVersion: 'v2' }).class, 'DEPRECATED');
	assert.equal(cls({ protocolVersion: 'v4' }).class, 'UNSUPPORTED');
	for (const deploymentKey of ['aave-v3-bnb', 'aave-v3-gnosis', 'aave-v3-linea', 'aave-v3-ink', 'aave-v3-fantom', 'aave-v3-harmony', 'aave-v3-ethereum-horizon', 'aave-v3-ethereum-core']) {
		assert.equal(cls({ deploymentKey }).class, 'UNSUPPORTED', deploymentKey);
	}
	assert.equal(MC.resolveMultichainCandidate(null).class, 'UNSUPPORTED');
	assert.ok(MC.OTHER_AAVE_V3_DEPLOYMENTS.every((d) => d.class === 'UNSUPPORTED'));
	assert.equal(MC.OTHER_AAVE_V3_DEPLOYMENTS.length, 15);
});

test('AAVE-MC-NO-LEAK shared addresses never identify a market; Ethereum mapping does not leak to other chains or back', () => {
	// Arbitrum, Optimism, Polygon und Avalanche teilen Pool und Provider
	const shared = C.filter((e) => e.pool === ARB.pool);
	assert.deepEqual(shared.map((e) => e.label), ['Arbitrum', 'Optimism', 'Polygon', 'Avalanche']);
	assert.ok(shared.every((e) => e.poolAddressesProvider === ARB.poolAddressesProvider));
	for (const a of shared) for (const b of shared) {
		const verdict = MC.resolveMultichainCandidate(claim(a, { chainId: b.chainId }));
		assert.equal(verdict.class === 'SUPPORTED_CANDIDATE', a === b, `${a.label} key on ${b.label} chain`);
	}
	// ohne Key gibt es keinen Treffer, auch mit passender Chain und Adresse
	assert.equal(MC.resolveMultichainCandidate({ chainId: 42161, protocolKey: 'aave', protocolVersion: 'v3', pool: ARB.pool, poolAddressesProvider: ARB.poolAddressesProvider }).class, 'UNSUPPORTED');
	// Ethereum-Core-Kennung auf anderer Chain und umgekehrt
	assert.equal(MC.resolveMultichainCandidate(claim(CORE, { poolAddressesProvider: CORE.poolAddressesProvider, chainId: 42161 })).class, 'UNSUPPORTED');
	for (const entry of C) {
		assert.notEqual(R.nexusMappingClass(asPosition(CORE, { chainId: entry.chainId })).class, 'MATCHED', `core key on ${entry.label}`);
		assert.notEqual(R.nexusMappingClass(asPosition(entry, { deploymentKey: CORE.deploymentKey })).class, 'MATCHED', `core key with ${entry.label} pool`);
		assert.notEqual(R.nexusMappingClass(asPosition(entry, { deploymentKey: CORE.deploymentKey, chainId: 1 })).class, 'MATCHED', `core key, chain 1, ${entry.label} pool`);
	}
});

test('AAVE-MC-NO-QUOTE PROBABLE scope gives no product, no Nexus read and no quote; runtime still knows only Ethereum', async () => {
	assert.ok(AAVE_V3_MARKETS.every((m) => m.chainId === 1), 'runtime registry unchanged');
	assert.equal(R.EXCLUDED_AAVE_SCOPES.find((s) => s.scope === 'aave-v3-other-chains').class, 'UNSUPPORTED');
	for (const entry of C) {
		assert.deepEqual(MC.multichainNexusScope(claim(entry)), { nexusScope: 'PROBABLE', productId: null, quoteEligible: false, reason: 'NEXUS_SCOPE_NOT_CONFIRMED' });
		assert.equal(MC.multichainNexusScope(claim(entry, { chainId: 1 })).quoteEligible, false);
		const pos = asPosition(entry);
		assert.equal(nexusProductIdFor(entry.deploymentKey), null);
		assert.equal(matchPositionToNexus(pos).status, 'NO_LISTING');
		assert.equal(R.classifyAaveDeployment(pos).class, 'UNSUPPORTED');
		assert.equal(R.nexusMappingClass(pos).class, 'UNSUPPORTED');
		assert.equal(matchDeployment(entry.deploymentKey, [{ productId: 97, normalizedName: 'aave v3', productType: 0, typeName: 'Single Protocol Cover', status: 'ACTIVE', deprecated: false }]).state, 'UNSUPPORTED');
		let calls = 0;
		const model = await getNexusReadModel(pos, { fetchImpl: async () => { calls += 1; throw new Error('no network in tests'); }, now: NOW });
		assert.equal(calls, 0, `no Nexus read for ${entry.label}`);
		assert.equal(model.eligibility.status, 'UNSUPPORTED');
		const request = parseCoverRequest({ action: 'quote', deploymentKey: entry.deploymentKey, coverAsset: 'USDC', amount: '1000', periodDays: 30 });
		assert.equal(checkQuoteRequest(request, model, pos).code, 'COVER_NOT_AVAILABLE');
	}
	assert.ok(MC.multichainSupportMatrix().every((row) => row.quoteEligible === false && row.productionEnabled === false));
});

test('AAVE-MC-READER the existing reader and AAVE_NET_EXPOSURE_V1 handle a candidate market unchanged (offline)', async () => {
	const WETH_ARB = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
	const USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
	const reserves = [
		{ address: WETH_ARB, symbol: 'WETH', decimals: 18, price: 300_000_000_000n, supply: 2n * 10n ** 18n, debt: 0n, collateral: true },
		{ address: USDC_ARB, symbol: 'USDC', decimals: 6, price: 100_000_000n, supply: 0n, debt: 1_000n * 10n ** 6n, collateral: false }
	];
	const block = 516_833_305n;
	const calls = [];
	const client = {
		async getBlockNumber() { return block; },
		async multicall({ contracts, blockNumber }) {
			assert.equal(blockNumber, block);
			return contracts.map((c) => {
				calls.push(c);
				const r = reserves.find((x) => x.address.toLowerCase() === String(c.args?.[0]).toLowerCase());
				const ok = (result) => ({ status: 'success', result });
				switch (c.functionName) {
					case 'getPool': return ok(ARB.pool);
					case 'getPriceOracle': return ok(ARB.oracle);
					case 'getPoolDataProvider': return ok(ARB.dataProvider);
					case 'getReservesList': return ok(reserves.map((x) => x.address));
					case 'getUserAccountData': return ok([600_000_000_000n, 100_000_000_000n, 0n, 8_200n, 7_500n, 4n * 10n ** 18n]);
					case 'BASE_CURRENCY': return ok(ZERO);
					case 'BASE_CURRENCY_UNIT': return ok(100_000_000n);
					case 'getAllReservesTokens': return ok(reserves.map((x) => ({ symbol: x.symbol, tokenAddress: x.address })));
					case 'getUserReserveData': return ok([r.supply, 0n, r.debt, 0n, 0n, 0n, 0n, 0, r.collateral]);
					case 'getReserveConfigurationData': return ok([BigInt(r.decimals), 7_500n, 8_000n, 10_500n, 1_000n, true, true, false, true, false]);
					case 'getAssetsPrices': return ok(c.args[0].map((a) => reserves.find((x) => x.address.toLowerCase() === a.toLowerCase()).price));
					default: return { status: 'failure', error: new Error('unexpected') };
				}
			});
		}
	};
	const result = await readAaveV3Positions(WALLET, { client, markets: [ARB] });
	const [market] = result.markets;
	assert.equal(market.status, 'OK');
	const pos = market.position;
	assert.deepEqual([pos.chainId, pos.deploymentKey, pos.marketAddress, pos.totals.suppliedUsd, pos.totals.debtUsd], [42161, 'aave-v3-arbitrum', ARB.pool, '6000', '1000']);
	// Referenz-Token (WETH/USDC/cbBTC) sind Ethereum-Adressen: auf Arbitrum kein Treffer, also keine Umrechnung in Cover-Assets
	assert.deepEqual(pos.pricing.reference, []);
	const allowed = new Set([ARB.poolAddressesProvider, ARB.pool, ARB.dataProvider, ARB.oracle].map((a) => a.toLowerCase()));
	assert.ok(calls.every((c) => allowed.has(c.address.toLowerCase())), 'only candidate contracts');
	const exposure = computeAaveExposure(pos);
	assert.equal(exposure.suggestedExposure, '5000');
	// trotz lesbarer Position: keine Nexus-Zuordnung
	assert.equal(R.nexusMappingClass(pos).class, 'UNSUPPORTED');
});

test('AAVE-MC-INACTIVE no production module imports the candidates; the doc matrix matches the code', () => {
	const walk = (dir) => readdirSync(dir).flatMap((name) => {
		const full = path.join(dir, name);
		return statSync(full).isDirectory() ? (name === 'node_modules' ? [] : walk(full)) : [full];
	});
	const importers = ['api', 'src', 'web/src', 'scripts'].flatMap((dir) => walk(path.join(REPO, dir)))
		.filter((file) => /\.m?js$/.test(file) && readFileSync(file, 'utf8').includes('aave-multichain-candidates'))
		.map((file) => path.relative(REPO, file));
	// nur die ebenso inaktive Aktivierungs-Vorbereitung (siehe aave-multichain-activation.test.mjs)
	assert.deepEqual(importers, ['src/positions/aave-multichain-activation.mjs']);
	const doc = JSON.parse(readFileSync(path.join(REPO, 'docs/aave-v3-multichain-support.json'), 'utf8'));
	assert.deepEqual(doc, JSON.parse(JSON.stringify(MC.multichainSupportMatrix())));
});
