/**
 * Nexus Mutual lesend, Phase P1 + P2 (18.10.2026): gepinnte Produktidentitaet,
 * strenge Zuordnung Position -> Produkt 97, Kapazitaet, Wording, Engagement.
 *
 * Offline. Eine Attrappe beantwortet die drei erlaubten GET-Endpunkte aus den
 * Mitschnitten in test/fixtures/nexus (api.nexusmutual.io, 18.10.2026). Kein
 * Netz, keine RPC, keine Datenbank, keine Transaktion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { AAVE_V3_MARKETS } = await import('../src/positions/aave-registry.mjs');
const { matchPositionToNexus, MATCH_STATUSES } = await import('../src/positions/nexus-mapping.mjs');
const { computeAaveExposure, EXPOSURE_METHOD, EXPOSURE_DISCLAIMERS } = await import('../src/positions/exposure.mjs');
const { nexusGet, parseCapacity, NexusReadError, _test: readCache } = await import('../src/nexus-read-api.mjs');
const { getNexusReadModel, ELIGIBILITY_STATUSES } = await import('../src/nexus-read-model.mjs');
const { NEXUS_API_BASE, NEXUS_CHAIN_ID, NEXUS_CONTRACTS, PINNED_PRODUCTS, PURCHASE_ANNEX_CID, COVER_PERIOD_DAYS } = await import('../src/nexus-pinned.mjs');

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/nexus/${name}.json`, import.meta.url), 'utf8'));
const PRODUCT = fixture('product-97');
const PRODUCT_TYPE = fixture('product-type-0');
const CAPACITY = fixture('capacity-97');
const [CORE, LIDO, ETHERFI] = AAVE_V3_MARKETS;
const NOW = Date.UTC(2026, 9, 18, 12);
const clone = (value) => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------- Attrappen -- */

function position(market = CORE, overrides = {}) {
	return {
		wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		chainId: market.chainId,
		protocolKey: market.protocolKey,
		protocolVersion: market.protocolVersion,
		deploymentKey: market.deploymentKey,
		label: market.label,
		marketAddress: market.pool,
		supplied: [
			{ symbol: 'WETH', usdValue: '25000.12345678', isCollateral: true },
			{ symbol: 'USDC', usdValue: '1000.5', isCollateral: false }
		],
		borrowed: [{ symbol: 'USDC', usdValue: '6000.00000001' }],
		totals: { suppliedUsd: '26000.62345678', debtUsd: '6000.00000001', netUsd: '20000.62345677', healthFactor: '3.2' },
		valueKind: 'DERIVED_FROM_AAVE_ORACLE',
		pricing: { source: 'aave-oracle', oracle: market.oracle, baseCurrency: 'USD', baseUnitDecimals: 8 },
		blockNumber: '21000000',
		status: 'OK',
		...overrides
	};
}

function jsonResponse(body, { status = 200, url } = {}) {
	const text = typeof body === 'string' ? body : JSON.stringify(body);
	return { ok: status >= 200 && status < 300, status, url, redirected: false, headers: new Headers({ 'content-type': 'application/json' }), text: async () => text };
}

/**
 * Antwortet je Pfad aus `routes` (Standard: die Mitschnitte). Ein Eintrag kann
 * ein Objekt (JSON), eine Funktion (url, init) -> Response oder ein Fehler sein.
 */
function fakeNexus(routes = {}) {
	const calls = [];
	const table = { '/v2/products/97': PRODUCT, '/v2/product-types/0': PRODUCT_TYPE, '/v2/capacity/97': CAPACITY, ...routes };
	const fetchImpl = async (url, init) => {
		calls.push({ url, method: init?.method, redirect: init?.redirect, hasSignal: init?.signal instanceof AbortSignal });
		assert.ok(url.startsWith(`${NEXUS_API_BASE}/`), `unexpected host: ${url}`);
		const route = table[url.slice(NEXUS_API_BASE.length)];
		if (route === undefined) return jsonResponse({ error: 'not found' }, { status: 404 });
		if (route instanceof Error) throw route;
		if (typeof route === 'function') return route(url, init);
		return jsonResponse(route, { url });
	};
	return { fetchImpl, calls };
}

async function model(pos = position(), routes, options = {}) {
	readCache.reset();
	const nexus = fakeNexus(routes);
	const result = await getNexusReadModel(pos, { fetchImpl: nexus.fetchImpl, now: NOW, ...options });
	return { result, calls: nexus.calls };
}

/** Kapazitaet mit frei waehlbaren Poolwerten; die Gesamtsumme rechnet die Attrappe selbst. */
function capacityWith(perPool) {
	const meta = { 0: ['ETH', 18], 1: ['DAI', 18], 6: ['USDC', 6], 7: ['cbBTC', 8] };
	const entry = (assetId, amount) => ({ assetId: Number(assetId), amount, asset: { id: Number(assetId), symbol: meta[assetId][0], decimals: meta[assetId][1] } });
	const ids = Object.keys(perPool);
	const pools = perPool[ids[0]].length;
	return {
		productId: 97,
		availableCapacity: ids.map((id) => entry(id, pools === 1 ? perPool[id][0] : perPool[id].reduce((a, b) => (BigInt(a) + BigInt(b)).toString(), '0'))),
		allocatedNxm: '0',
		minAnnualPrice: '0.0374',
		maxAnnualPrice: '0.0468',
		capacityPerPool: Array.from({ length: pools }, (_, i) => ({ poolId: i + 1, availableCapacity: ids.map((id) => entry(id, perPool[id][i])), allocatedNxm: '0', minAnnualPrice: '0.0374', maxAnnualPrice: '0.0468' }))
	};
}

/* --------------------------------------------------------- Pins / Mapping -- */

test('NEXUS-PIN product 97 identity, chain, API base and contracts are pinned', () => {
	assert.equal(NEXUS_API_BASE, 'https://api.nexusmutual.io');
	assert.equal(NEXUS_CHAIN_ID, 1);
	assert.deepEqual(Object.keys(PINNED_PRODUCTS), ['97']);
	assert.deepEqual({ ...PINNED_PRODUCTS[97], proofOfLossInputTypes: [...PINNED_PRODUCTS[97].proofOfLossInputTypes] }, {
		productId: 97, name: 'Aave v3', productTypeId: 0, productTypeName: 'Single Protocol Cover', category: 'lending',
		proofOfLossInputTypes: ['address'], wordingCid: 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY', annexCid: 'QmWAdgxbaPGj6umcoZJk5xwc8K5rxZRSFx5DSyMxNfSkuJ'
	});
	// Lese- und Kauf-Pin sind getrennt: die Kaufstrecke bleibt ohne Annex (cover_purchase_intents.annex_cid ist null).
	assert.equal(PURCHASE_ANNEX_CID, null);
	assert.deepEqual({ ...COVER_PERIOD_DAYS }, { min: 28, max: 365 });
	assert.equal(NEXUS_CONTRACTS.CoverBroker, '0xCB2B736652D2dBf7d72e4dB880Cf6B7d99507814');
	assert.ok(Object.isFrozen(PINNED_PRODUCTS) && Object.isFrozen(PINNED_PRODUCTS[97]));
});

test('NEXUS-MAP Aave v3 Ethereum Core maps EXACT to product 97, type 0', () => {
	const match = matchPositionToNexus(position(CORE));
	assert.deepEqual({ ...match }, { status: 'EXACT', productId: 97, productTypeId: 0, reason: 'PINNED_DEPLOYMENT', supportedCoverAssets: null, proofOfLossInputTypes: null });
	assert.deepEqual(MATCH_STATUSES, ['EXACT', 'PROBABLE', 'AMBIGUOUS', 'NO_LISTING']);
});

test('NEXUS-MAP Lido/Prime and EtherFi markets are PROBABLE, never EXACT', () => {
	for (const market of [LIDO, ETHERFI]) {
		const match = matchPositionToNexus(position(market));
		assert.equal(match.status, 'PROBABLE', market.deploymentKey);
		assert.equal(match.reason, 'NEXUS_SCOPE_UNCONFIRMED');
	}
});

test('NEXUS-MAP wrong chain is AMBIGUOUS, never EXACT', () => {
	for (const chainId of [10, 8453, 42161, '1', 1n, undefined]) {
		const match = matchPositionToNexus(position(CORE, { chainId }));
		assert.equal(match.status, 'AMBIGUOUS', `chainId ${String(chainId)}`);
		assert.equal(match.reason, 'CHAIN_CONFLICT');
	}
});

test('NEXUS-MAP Aave v2 is never mapped as v3', () => {
	const v2 = matchPositionToNexus(position(CORE, { protocolVersion: 'v2' }));
	assert.equal(v2.status, 'AMBIGUOUS');
	assert.equal(v2.reason, 'PROTOCOL_CONFLICT');
	for (const deploymentKey of ['aave-v2-ethereum', 'aave-v4-ethereum', 'aave-v3-ethereum-horizon', 'aave-v3-base', 'spark-ethereum']) {
		const match = matchPositionToNexus(position(CORE, { deploymentKey }));
		assert.equal(match.status, 'NO_LISTING', deploymentKey);
		assert.equal(match.productId, null);
	}
});

test('NEXUS-MAP similar protocol identities are AMBIGUOUS, not matched by name', () => {
	for (const protocolKey of ['Aave', 'aave-fork', 'aave ', 'spark', undefined]) {
		const match = matchPositionToNexus(position(CORE, { protocolKey }));
		assert.equal(match.status, 'AMBIGUOUS', String(protocolKey));
		assert.equal(match.reason, 'PROTOCOL_CONFLICT');
	}
	// Der Anzeigename spielt keine Rolle.
	assert.equal(matchPositionToNexus(position(CORE, { label: 'Aave v2 Ethereum' })).status, 'EXACT');
	assert.equal(matchPositionToNexus(position(LIDO, { label: 'Aave v3 Ethereum Core' })).status, 'PROBABLE');
});

test('NEXUS-MAP core key with another market address is AMBIGUOUS', () => {
	const match = matchPositionToNexus(position(CORE, { marketAddress: LIDO.pool }));
	assert.equal(match.status, 'AMBIGUOUS');
	assert.equal(match.reason, 'MARKET_CONFLICT');
	assert.equal(matchPositionToNexus(position(CORE, { marketAddress: CORE.pool.toLowerCase() })).status, 'EXACT');
	for (const bad of [null, 42, {}, [], 'core']) assert.equal(matchPositionToNexus(bad).status, 'NO_LISTING');
});

/* ------------------------------------------------------------ Read model -- */

test('NEXUS-MODEL core position with valid Nexus data is AVAILABLE', async () => {
	const { result, calls } = await model();
	assert.equal(result.eligibility.status, 'AVAILABLE');
	assert.deepEqual(result.eligibility.reasons, []);
	assert.deepEqual(Object.keys(result).sort(), ['capacity', 'eligibility', 'exposure', 'generatedAt', 'nexusMatch', 'position', 'wording']);
	assert.deepEqual([...result.nexusMatch.supportedCoverAssets], ['ETH', 'USDC', 'cbBTC']);
	assert.deepEqual([...result.nexusMatch.proofOfLossInputTypes], ['address']);
	assert.equal(result.position.deploymentKey, CORE.deploymentKey);
	assert.deepEqual(calls.map((c) => c.url).sort(), [`${NEXUS_API_BASE}/v2/capacity/97`, `${NEXUS_API_BASE}/v2/product-types/0`, `${NEXUS_API_BASE}/v2/products/97`]);
	assert.ok(calls.every((c) => c.method === 'GET' && c.redirect === 'error' && c.hasSignal));
});

test('NEXUS-MODEL renamed product 97 is never AVAILABLE', async () => {
	for (const name of ['Aave v3 Horizon', 'Aave v4', 'Aave v2', 'Spark Lend']) {
		const { result } = await model(position(), { '/v2/products/97': { ...PRODUCT, name } });
		assert.equal(result.eligibility.status, 'UNAVAILABLE', name);
		assert.deepEqual([...result.eligibility.reasons], ['PRODUCT_NAME_MISMATCH'], name);
		assert.equal(result.capacity, null);
		assert.equal(result.wording, null);
	}
});

test('NEXUS-MODEL similar product names are not accepted as Aave v3', async () => {
	for (const name of ['aave v3', 'AAVE V3', 'Aave V3', ' Aave v3', 'Aave v3 ', 'Aave v3']) {
		const { result } = await model(position(), { '/v2/products/97': { ...PRODUCT, name } });
		assert.equal(result.eligibility.status, 'UNAVAILABLE', JSON.stringify(name));
		assert.deepEqual([...result.eligibility.reasons], ['PRODUCT_NAME_MISMATCH'], JSON.stringify(name));
	}
});

test('NEXUS-MODEL wrong product type is never AVAILABLE', async () => {
	for (const productType of [1, 24]) {
		const { result } = await model(position(), { '/v2/products/97': { ...PRODUCT, productType } });
		assert.equal(result.eligibility.status, 'UNAVAILABLE', `type ${productType}`);
		assert.deepEqual([...result.eligibility.reasons], ['PRODUCT_TYPE_MISMATCH']);
	}
	const renamedType = await model(position(), { '/v2/product-types/0': { ...PRODUCT_TYPE, name: 'Single Protocol Cover v2' } });
	assert.deepEqual([...renamedType.result.eligibility.reasons], ['PRODUCT_TYPE_MISMATCH']);
});

test('NEXUS-MODEL private, deprecated, changed category or proof-of-loss is UNAVAILABLE', async () => {
	const cases = [
		[{ isPrivate: true }, 'PRODUCT_PRIVATE'],
		[{ isDeprecated: true }, 'PRODUCT_DEPRECATED'],
		[{ category: 'restaking' }, 'CATEGORY_MISMATCH'],
		[{ proofOfLossInputTypes: ['address', 'free_text'] }, 'PROOF_OF_LOSS_CHANGED'],
		[{ coverAssets: [{ assetId: 1, assetSymbol: 'DAI' }] }, 'NO_SUPPORTED_ASSET'],
		[{ coverAssets: [{ assetId: 0, assetSymbol: 'WETH' }] }, 'ASSET_IDENTITY_MISMATCH']
	];
	for (const [patch, reason] of cases) {
		const { result } = await model(position(), { '/v2/products/97': { ...PRODUCT, ...patch } });
		assert.equal(result.eligibility.status, 'UNAVAILABLE', reason);
		assert.deepEqual([...result.eligibility.reasons], [reason]);
	}
});

test('NEXUS-MODEL changed wording CID or a new annex is TERMS_CHANGED', async () => {
	const otherCid = 'QmYhCNjfrNTMq8eyg8i7LbBpTkMCHfix9Sv1jrPb7dYZKd';
	const wording = await model(position(), { '/v2/product-types/0': { ...PRODUCT_TYPE, metadata: otherCid } });
	assert.deepEqual([...wording.result.eligibility.reasons], ['TERMS_CHANGED']);
	const annex = await model(position(), { '/v2/products/97': { ...PRODUCT, metadata: otherCid } });
	assert.deepEqual([...annex.result.eligibility.reasons], ['TERMS_CHANGED']);
	const unknownTerms = await model(position(), { '/v2/products/97': { ...PRODUCT, metadata: { annex: otherCid, extra: 'x' } } });
	assert.equal(unknownTerms.result.eligibility.status, 'UNAVAILABLE');
});

test('NEXUS-ANNEX only the pinned product 97 annex is accepted; missing, other, malformed or extended annex metadata is TERMS_CHANGED', async () => {
	// Gueltig: genau die on-chain registrierten Metadaten (Qmf5jx..., 27.10.2026).
	assert.deepEqual(PRODUCT.metadata, { version: '1.0', annex: 'QmWAdgxbaPGj6umcoZJk5xwc8K5rxZRSFx5DSyMxNfSkuJ' });
	const valid = await model();
	assert.equal(valid.result.eligibility.status, 'AVAILABLE');
	assert.equal(valid.result.wording.annexCid, 'QmWAdgxbaPGj6umcoZJk5xwc8K5rxZRSFx5DSyMxNfSkuJ');
	const otherCid = 'QmYhCNjfrNTMq8eyg8i7LbBpTkMCHfix9Sv1jrPb7dYZKd';
	for (const metadata of [
		'', null, { version: '1.0' }, otherCid, { version: '1.0', annex: otherCid },
		{ version: '1.0', annex: 'not-a-cid' }, { version: '1.0', annex: '' }, { version: '1.0', annex: 42 },
		{ version: '1.0', annex: 'QmWAdgxbaPGj6umcoZJk5xwc8K5rxZRSFx5DSyMxNfSkuJ', exclusions: ['x'] }
	]) {
		const { result } = await model(position(), { '/v2/products/97': { ...PRODUCT, metadata } });
		assert.equal(result.eligibility.status, 'UNAVAILABLE', JSON.stringify(metadata));
		assert.deepEqual([...result.eligibility.reasons], ['TERMS_CHANGED'], JSON.stringify(metadata));
	}
	// Metadaten als Liste verwirft schon der API-Parser, vor jedem Pin-Vergleich.
	const list = await model(position(), { '/v2/products/97': { ...PRODUCT, metadata: ['QmWAdgxbaPGj6umcoZJk5xwc8K5rxZRSFx5DSyMxNfSkuJ'] } });
	assert.deepEqual([...list.result.eligibility.reasons], ['PRODUCT_UNAVAILABLE:MALFORMED_PRODUCT']);
});

test('NEXUS-MODEL wrong chain position never reaches the Nexus API', async () => {
	const { result, calls } = await model(position(CORE, { chainId: 8453 }));
	assert.equal(result.nexusMatch.status, 'AMBIGUOUS');
	assert.equal(result.eligibility.status, 'AMBIGUOUS');
	assert.deepEqual([...result.eligibility.reasons], ['CHAIN_CONFLICT']);
	assert.equal(calls.length, 0);
});

test('NEXUS-MODEL Aave v2 position is never AVAILABLE', async () => {
	const { result, calls } = await model(position(CORE, { protocolVersion: 'v2' }));
	assert.equal(result.eligibility.status, 'AMBIGUOUS');
	assert.deepEqual([...result.eligibility.reasons], ['PROTOCOL_CONFLICT']);
	assert.equal(calls.length, 0);
	const v2Key = await model(position(CORE, { deploymentKey: 'aave-v2-ethereum', protocolVersion: 'v2' }));
	assert.equal(v2Key.result.eligibility.status, 'UNSUPPORTED');
	assert.equal(v2Key.calls.length, 0);
});

test('NEXUS-MODEL ambiguous deployments (Lido/Prime, EtherFi) are never AVAILABLE', async () => {
	for (const market of [LIDO, ETHERFI]) {
		const { result, calls } = await model(position(market));
		assert.equal(result.nexusMatch.status, 'PROBABLE', market.deploymentKey);
		assert.equal(result.eligibility.status, 'AMBIGUOUS', market.deploymentKey);
		assert.equal(result.capacity, null);
		assert.equal(result.wording, null);
		assert.equal(calls.length, 0, 'no Nexus read for a non-EXACT match');
	}
	const conflict = await model(position(CORE, { marketAddress: ETHERFI.pool }));
	assert.equal(conflict.result.eligibility.status, 'AMBIGUOUS');
});

test('NEXUS-MODEL unsupported positions are UNSUPPORTED without any read', async () => {
	const { result, calls } = await model(position(CORE, { deploymentKey: 'compound-v3-ethereum', protocolKey: 'compound' }));
	assert.equal(result.eligibility.status, 'UNSUPPORTED');
	assert.equal(calls.length, 0);
	assert.deepEqual(ELIGIBILITY_STATUSES, ['AVAILABLE', 'UNAVAILABLE', 'AMBIGUOUS', 'UNSUPPORTED']);
});

/* --------------------------------------------------------------- Capacity -- */

test('NEXUS-CAP only product cover assets count; DAI and NXM are dropped; timestamp kept', async () => {
	const { result } = await model();
	assert.equal(result.capacity.status, 'AVAILABLE');
	assert.deepEqual(result.capacity.assets.map((a) => a.symbol), ['ETH', 'USDC', 'cbBTC']);
	assert.ok(!JSON.stringify(result.capacity).includes('DAI') && !JSON.stringify(result.capacity).includes('NXM'));
	const eth = result.capacity.assets.find((a) => a.symbol === 'ETH');
	assert.equal(eth.amount, CAPACITY.availableCapacity.find((a) => a.assetId === 0).amount);
	assert.equal(eth.formatted, '3671.271908207964819328');
	assert.equal(result.capacity.fetchedAt, new Date(NOW).toISOString());
	assert.equal(result.capacity.source, `${NEXUS_API_BASE}/v2/capacity/97`);
	assert.deepEqual({ ...result.capacity.annualPriceRange }, { min: '0.0374', max: '0.046798437579996054' });
	const daiOnly = await model(position(), { '/v2/capacity/97': capacityWith({ 1: ['5000000000000000000000'] }) });
	assert.equal(daiOnly.result.eligibility.status, 'UNAVAILABLE');
	assert.deepEqual([...daiOnly.result.eligibility.reasons], ['NO_CAPACITY']);
	assert.deepEqual([...daiOnly.result.capacity.missingAssets], ['ETH', 'USDC', 'cbBTC']);
});

test('NEXUS-CAP zero capacity in every supported asset is UNAVAILABLE', async () => {
	const { result } = await model(position(), { '/v2/capacity/97': capacityWith({ 0: ['0', '0'], 6: ['0', '0'], 7: ['0', '0'] }) });
	assert.equal(result.eligibility.status, 'UNAVAILABLE');
	assert.deepEqual([...result.eligibility.reasons], ['NO_CAPACITY']);
});

test('NEXUS-CAP malformed capacity is UNAVAILABLE', async () => {
	const malformed = [
		capacityWith({ 0: ['-5'], 6: ['1000000'] }),
		capacityWith({ 0: ['1.5'], 6: ['1000000'] }),
		{ ...clone(CAPACITY), availableCapacity: 'lots' },
		{ ...clone(CAPACITY), capacityPerPool: [] },
		{ ...clone(CAPACITY), productId: 98 },
		{ ...clone(CAPACITY), minAnnualPrice: '0.5', maxAnnualPrice: '0.1' },
		'{"productId":97,'
	];
	for (const body of malformed) {
		const { result } = await model(position(), { '/v2/capacity/97': body });
		assert.equal(result.eligibility.status, 'UNAVAILABLE', JSON.stringify(body).slice(0, 80));
		assert.match(result.eligibility.reasons[0], /^CAPACITY_UNAVAILABLE:(MALFORMED_CAPACITY|CAPACITY_PRODUCT_MISMATCH|MALFORMED_JSON)$/);
	}
	const numeric = capacityWith({ 0: ['5'], 6: ['1000000'] });
	numeric.availableCapacity[0].amount = 5;
	numeric.capacityPerPool[0].availableCapacity[0].amount = 5;
	assert.throws(() => parseCapacity(numeric, 97), (error) => error instanceof NexusReadError && error.code === 'MALFORMED_CAPACITY');
});

test('NEXUS-CAP missing capacity is UNAVAILABLE', async () => {
	for (const route of [undefined, () => jsonResponse('upstream', { status: 503 })]) {
		const { result } = await model(position(), { '/v2/capacity/97': route });
		assert.equal(result.eligibility.status, 'UNAVAILABLE');
		assert.match(result.eligibility.reasons[0], /^CAPACITY_UNAVAILABLE:(NOT_FOUND|HTTP_ERROR)$/);
		assert.equal(result.capacity.status, 'UNAVAILABLE');
		assert.equal(result.wording.status, 'AVAILABLE', 'terms stay readable');
	}
});

test('NEXUS-CAP fake high total capacity that disagrees with the pools is rejected', async () => {
	const inflated = clone(CAPACITY);
	const eth = inflated.availableCapacity.find((a) => a.assetId === 0);
	eth.amount = (BigInt(eth.amount) * 1000n).toString();
	const { result } = await model(position(), { '/v2/capacity/97': inflated });
	assert.equal(result.eligibility.status, 'UNAVAILABLE');
	assert.deepEqual([...result.eligibility.reasons], ['CAPACITY_UNAVAILABLE:CAPACITY_INCONSISTENT']);
	// Rundung je Pool ist erlaubt: der echte Mitschnitt weicht um wenige Einheiten ab.
	assert.equal(parseCapacity(clone(CAPACITY), 97).assets.length, 5);
	const duplicatePool = clone(CAPACITY);
	duplicatePool.capacityPerPool[1].poolId = duplicatePool.capacityPerPool[0].poolId;
	assert.throws(() => parseCapacity(duplicatePool, 97), /MALFORMED_CAPACITY/);
});

/* ------------------------------------------------------------ API-Grenze -- */

test('NEXUS-API timeout makes the product UNAVAILABLE within the time budget', async () => {
	const hang = (url, init) => new Promise((_, reject) => {
		init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
	});
	const pending = model(position(), { '/v2/products/97': hang, '/v2/capacity/97': hang }, { timeoutMs: 30 });
	const outcome = await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 1_500, 'HUNG'))]);
	assert.notEqual(outcome, 'HUNG', 'a hanging Nexus API must not stall the read model');
	assert.equal(outcome.result.eligibility.status, 'UNAVAILABLE');
	assert.deepEqual([...outcome.result.eligibility.reasons], ['PRODUCT_UNAVAILABLE:TIMEOUT']);
	assert.equal(readCache.cacheSize(), 1, 'only the successful product-type read is cached');
});

test('NEXUS-API network errors and HTTP errors never produce AVAILABLE', async () => {
	const cases = [
		[{ '/v2/products/97': new TypeError('fetch failed') }, 'PRODUCT_UNAVAILABLE:UNREACHABLE'],
		[{ '/v2/products/97': undefined }, 'PRODUCT_UNAVAILABLE:NOT_FOUND'],
		[{ '/v2/product-types/0': () => jsonResponse('x', { status: 500 }) }, 'PRODUCT_TYPE_UNAVAILABLE:HTTP_ERROR'],
		[{ '/v2/products/97': { ...PRODUCT, id: 98 } }, 'PRODUCT_UNAVAILABLE:PRODUCT_ID_MISMATCH'],
		[{ '/v2/products/97': { ...PRODUCT, isPrivate: 'false' } }, 'PRODUCT_UNAVAILABLE:MALFORMED_PRODUCT'],
		[{ '/v2/products/97': { ...PRODUCT, proofOfLossInputTypes: ['address', 'selfie'] } }, 'PRODUCT_UNAVAILABLE:MALFORMED_PRODUCT'],
		[{ '/v2/products/97': () => ({ ...jsonResponse(PRODUCT), url: 'https://evil.example/v2/products/97' }) }, 'PRODUCT_UNAVAILABLE:REDIRECTED'],
		[{ '/v2/product-types/0': { ...PRODUCT_TYPE, metadata: 'not-a-cid' } }, 'PRODUCT_TYPE_UNAVAILABLE:MALFORMED_PRODUCT_TYPE']
	];
	for (const [routes, reason] of cases) {
		const { result } = await model(position(), routes);
		assert.equal(result.eligibility.status, 'UNAVAILABLE', reason);
		assert.deepEqual([...result.eligibility.reasons], [reason]);
	}
});

test('NEXUS-API failures are not cached; a later good read recovers', async () => {
	readCache.reset();
	const down = fakeNexus({ '/v2/capacity/97': new TypeError('fetch failed') });
	const first = await getNexusReadModel(position(), { fetchImpl: down.fetchImpl, now: NOW });
	assert.equal(first.eligibility.status, 'UNAVAILABLE');
	const up = fakeNexus();
	const second = await getNexusReadModel(position(), { fetchImpl: up.fetchImpl, now: NOW + 1_000 });
	assert.equal(second.eligibility.status, 'AVAILABLE');
	assert.deepEqual(up.calls.map((c) => c.url), [`${NEXUS_API_BASE}/v2/capacity/97`], 'product data cached, capacity re-read');
	const later = fakeNexus({ '/v2/capacity/97': new TypeError('fetch failed') });
	const stale = await getNexusReadModel(position(), { fetchImpl: later.fetchImpl, now: NOW + 11 * 60_000 });
	assert.equal(stale.eligibility.status, 'UNAVAILABLE', 'expired capacity is not reused after a failure');
});

test('NEXUS-API only the three GET paths under the pinned base are reachable', async () => {
	const nexus = fakeNexus();
	for (const path of ['/v2/quote', '/v2/products/97/../../quote', '/v2/products/97?x=1', '/v2/products/-1', 'https://evil.example/v2/products/97', '//evil.example/v2/products/97', '/v2/products/097', '/v2/cover/1']) {
		await assert.rejects(nexusGet(path, { fetchImpl: nexus.fetchImpl }), (error) => error.code === 'PATH_NOT_ALLOWED', path);
	}
	assert.equal(nexus.calls.length, 0);
	const huge = fakeNexus({ '/v2/products/97': () => jsonResponse(JSON.stringify({ ...PRODUCT, pad: 'x'.repeat(300_000) })) });
	await assert.rejects(nexusGet('/v2/products/97', { fetchImpl: huge.fetchImpl }), (error) => error.code === 'TOO_LARGE');
	const source = readFileSync(new URL('../src/nexus-read-api.mjs', import.meta.url), 'utf8');
	assert.doesNotMatch(source, /method:\s*'(POST|PUT|PATCH|DELETE)'/);
});

/* --------------------------------------------------------------- Wording -- */

test('NEXUS-WORDING exposes pinned wording, the pinned annex, PoL types and period limits without summarising terms', async () => {
	const { result } = await model();
	const w = result.wording;
	assert.equal(w.productName, 'Aave v3');
	assert.equal(w.productTypeName, 'Single Protocol Cover');
	assert.equal(w.wordingCid, 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY');
	assert.equal(w.wordingUrl, `${NEXUS_API_BASE}/ipfs/QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY`);
	assert.equal(w.annexCid, 'QmWAdgxbaPGj6umcoZJk5xwc8K5rxZRSFx5DSyMxNfSkuJ');
	assert.equal(w.annexUrl, `${NEXUS_API_BASE}/ipfs/QmWAdgxbaPGj6umcoZJk5xwc8K5rxZRSFx5DSyMxNfSkuJ`);
	assert.equal(w.gracePeriodDays, 35);
	assert.deepEqual({ ...w.coverPeriodDays }, { min: 28, max: 365 });
	assert.deepEqual([...w.proofOfLossInputTypes], ['address']);
	assert.deepEqual([...w.supportedCoverAssets], ['ETH', 'USDC', 'cbBTC']);
	assert.equal(w.exclusionsModeled, false);
	assert.ok(!Object.keys(w).some((key) => /summary|exclusion(s)?$|covered|deductible/i.test(key)));
});

/* -------------------------------------------------------------- Exposure -- */

test('NEXUS-EXPOSURE AAVE_NET_EXPOSURE_V1 is exact: gross deposits minus debt, floored at zero', () => {
	const exposure = computeAaveExposure(position());
	assert.equal(exposure.status, 'OK');
	assert.equal(exposure.calculationMethod, EXPOSURE_METHOD);
	assert.equal(exposure.calculationMethod, 'AAVE_NET_EXPOSURE_V1');
	assert.equal(exposure.grossExposure, '26000.62345678');
	assert.equal(exposure.debt, '6000.00000001');
	assert.equal(exposure.suggestedExposure, '20000.62345677');
	assert.deepEqual([...exposure.disclaimers], ['SUGGESTED_AMOUNT_ONLY', 'NOT_A_GUARANTEED_CLAIMABLE_AMOUNT', 'NEXUS_WORDING_GOVERNS']);
	assert.deepEqual(EXPOSURE_DISCLAIMERS, exposure.disclaimers);
	const underwater = computeAaveExposure(position(CORE, { supplied: [{ usdValue: '100' }], borrowed: [{ usdValue: '150.5' }], totals: { suppliedUsd: '100', debtUsd: '150.5' } }));
	assert.equal(underwater.suggestedExposure, '0');
	const tiny = computeAaveExposure(position(CORE, { supplied: [{ usdValue: '0.1' }, { usdValue: '0.2' }], borrowed: [], totals: { suppliedUsd: '0.3', debtUsd: '0' } }));
	assert.equal(tiny.suggestedExposure, '0.3', 'no floating-point drift');
	assert.ok(!JSON.stringify(exposure).match(/insured ?loss/i));
});

test('NEXUS-EXPOSURE inconsistent or malformed values give no number', async () => {
	const cases = [
		[{ totals: { suppliedUsd: '26000', debtUsd: '6000.00000001' } }, 'TOTALS_MISMATCH'],
		[{ supplied: [{ usdValue: '-5' }] }, 'MALFORMED_VALUES'],
		[{ supplied: [{ usdValue: 25000 }] }, 'MALFORMED_VALUES'],
		[{ borrowed: null }, 'MALFORMED_VALUES'],
		[{ valueKind: 'USER_SUPPLIED' }, 'UNSUPPORTED_VALUATION']
	];
	for (const [patch, reason] of cases) {
		const exposure = computeAaveExposure(position(CORE, patch));
		assert.equal(exposure.status, 'INVALID', reason);
		assert.equal(exposure.reason, reason);
		assert.equal(exposure.suggestedExposure, null);
	}
	const { result } = await model(position(CORE, { totals: { suppliedUsd: '1', debtUsd: '0' } }));
	assert.equal(result.eligibility.status, 'UNAVAILABLE');
	assert.deepEqual([...result.eligibility.reasons], ['EXPOSURE_TOTALS_MISMATCH']);
});

/* ---------------------------------------------------------- Abgrenzung P3 -- */

test('NEXUS-SCOPE read model carries no purchase, quote, transaction or commission fields', async () => {
	const { result } = await model();
	const text = JSON.stringify(result);
	assert.doesNotMatch(text, /premium|quote|approve|calldata|txHash|transaction|commission|buy|purchase|termsAccepted|proofOfLossUpload/i);
	for (const file of ['../src/nexus-read-model.mjs', '../src/nexus-read-api.mjs', '../src/positions/nexus-mapping.mjs', '../src/positions/exposure.mjs']) {
		const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
		assert.doesNotMatch(source, /CoverBroker|buyCover|approve\(|sendTransaction|writeContract|commission/i, file);
		// Seit P3 liest nur die API-Schicht Quotes (readQuote); das Lesemodell selbst bleibt quote-frei.
		if (!file.endsWith('nexus-read-api.mjs')) assert.doesNotMatch(source, /\/v2\/quote/, file);
	}
});
