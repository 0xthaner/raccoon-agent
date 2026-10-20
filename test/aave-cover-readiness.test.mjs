/**
 * Aave v3 Ethereum als erster durchgehender Protokollpfad (20.10.2026).
 *
 * Offline. Scope und Zuordnung, Cover-Assets, Engagement, Quote-Grenzen,
 * Frische von Kapazitaet und Quote, Terms- und Proof-of-Loss-Blocker, die eine
 * Kaufbereitschafts-Entscheidung, Cover-Status und Ablauf-Monitoring.
 * Es gibt hier keinen positiven Pfad zu einer echten Ausfuehrung: die externen
 * Blocker sind fest und lassen sich nicht abschalten.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

Object.assign(process.env, {
	SUPABASE_URL: process.env.SUPABASE_URL || 'https://supabase.test.invalid',
	SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY || 'test-secret-key'
});

const R = await import('../src/aave-cover-readiness.mjs');
const { AAVE_V3_MARKETS, REFERENCE_TOKENS, CHAIN_ID } = await import('../src/positions/aave-registry.mjs');
const { computeAaveExposure } = await import('../src/positions/exposure.mjs');
const { getNexusReadModel } = await import('../src/nexus-read-model.mjs');
const { _test: readCache } = await import('../src/nexus-read-api.mjs');
const { checkQuoteRequest, coverBounds, coverDetails, parseCoverRequest, quoteFreshness, QUOTE_TTL_MS } = await import('../src/nexus-quote.mjs');
const { NEXUS_API_BASE } = await import('../src/nexus-pinned.mjs');
const { dueThreshold, formatExpiryAlert } = await import('../src/alerts.mjs');

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/nexus/${name}.json`, import.meta.url), 'utf8'));
const [CORE, LIDO, ETHERFI] = AAVE_V3_MARKETS;
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NOW = Date.UTC(2026, 9, 18, 12);
const DAY = 86_400_000;

const REFERENCE = [
	{ token: 'WETH', asset: REFERENCE_TOKENS.WETH, decimals: 18, price: '400000000000' },
	{ token: 'USDC', asset: REFERENCE_TOKENS.USDC, decimals: 6, price: '100000000' },
	{ token: 'cbBTC', asset: REFERENCE_TOKENS.cbBTC, decimals: 8, price: '10000000000000' }
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
function fakeNexus() {
	const table = { '/v2/products/97': fixture('product-97'), '/v2/product-types/0': fixture('product-type-0'), '/v2/capacity/97': fixture('capacity-97') };
	return async (url) => {
		const body = table[url.slice(NEXUS_API_BASE.length)];
		const text = JSON.stringify(body ?? { message: 'not found' });
		return { ok: !!body, status: body ? 200 : 404, url, redirected: false, headers: new Headers({ 'content-type': 'application/json' }), text: async () => text };
	};
}
async function modelFor(pos = position()) {
	readCache.reset();
	return getNexusReadModel(pos, { fetchImpl: fakeNexus(), now: NOW });
}
const quote = (patch = {}) => ({
	provider: 'Nexus Mutual', coverAsset: 'USDC', coverAmount: '1000', periodDays: 30, premium: '3.000578', premiumAsset: 'USDC',
	quoteFetchedAt: new Date(NOW).toISOString(), quoteExpiresAt: new Date(NOW + QUOTE_TTL_MS).toISOString(), freshness: 'FRESH', ...patch
});
/** Alles technisch Pruefbare erfuellt; nur die externen Blocker bleiben. */
async function allTechnical(patch = {}) {
	const pos = patch.position ?? position();
	const model = patch.model ?? await modelFor(pos);
	return {
		sessionWallet: WALLET, position: pos, model, bounds: coverBounds(model, pos), quote: quote(), allocation: { ok: true },
		execution: { pinsVerified: true, unresolvedAttempt: false, preSendFresh: true }, now: NOW + 1_000, ...patch
	};
}
const EXTERNAL_ONLY = ['TERMS_BLOCKED', 'POL_BLOCKED', 'EXTERNAL:CR-TERMS-002', 'EXTERNAL:CR-POL-002', 'EXTERNAL:CR-PURCHASE-008/P3'];

/* -------------------------------------------------------------- Scope -- */

test('AAVE-SCOPE exactly three Aave v3 Ethereum markets, pinned to the live-verified provider, pool, oracle and data provider', () => {
	assert.equal(CHAIN_ID, 1);
	assert.deepEqual(AAVE_V3_MARKETS.map((m) => [m.deploymentKey, m.chainId, m.protocolKey, m.protocolVersion, m.poolAddressesProvider, m.pool]), [
		['aave-v3-ethereum-core', 1, 'aave', 'v3', '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e', '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'],
		['aave-v3-ethereum-lido', 1, 'aave', 'v3', '0xcfBf336fe147D643B9Cb705648500e101504B16d', '0x4e033931ad43597d96D6bcc25c280717730B58B1'],
		['aave-v3-ethereum-etherfi', 1, 'aave', 'v3', '0xeBa440B438Ad808101d1c451C1C5322c90BEFCdA', '0x0AA97c284e98396202b6A04024F5E2c65026F3c0']
	]);
	for (const market of AAVE_V3_MARKETS) assert.equal(R.classifyAaveDeployment(position(market)).class, 'SUPPORTED', market.deploymentKey);
});

test('AAVE-SCOPE-REJECT other chains, v2, v4, Horizon, unknown keys, fuzzy names and conflicting pools fail closed', () => {
	const cls = (patch) => R.classifyAaveDeployment({ ...position(), ...patch }).class;
	for (const chainId of [10, 137, 8453, 42161, 43114, '1', 1n, null]) assert.equal(cls({ chainId }), 'UNSUPPORTED', String(chainId));
	assert.equal(cls({ protocolVersion: 'v2' }), 'DEPRECATED');
	for (const protocolVersion of ['v4', 'V3', '3', 'v3.1', null]) assert.equal(cls({ protocolVersion }), 'UNSUPPORTED', String(protocolVersion));
	for (const protocolKey of ['Aave', 'aave-v3', 'AAVE', 'spark', null]) assert.equal(cls({ protocolKey }), 'UNSUPPORTED', String(protocolKey));
	for (const deploymentKey of ['aave-v3-ethereum-horizon', 'aave-v3-ethereum', 'aave-v3-ethereum-core ', 'aave-v3-arbitrum-core', 'Aave v3 Core']) assert.equal(cls({ deploymentKey }), 'UNSUPPORTED', deploymentKey);
	assert.equal(cls({ marketAddress: LIDO.pool }), 'AMBIGUOUS', 'core key with the Lido pool');
	assert.equal(cls({ marketAddress: '0x0000000000000000000000000000000000000000' }), 'AMBIGUOUS');
	assert.equal(cls({ marketAddress: undefined }), 'AMBIGUOUS');
	assert.equal(R.classifyAaveDeployment(null).class, 'UNSUPPORTED');
	assert.deepEqual(R.EXCLUDED_AAVE_SCOPES.map((e) => [e.scope, e.class]), [
		['aave-v2-ethereum', 'DEPRECATED'], ['aave-v4', 'UNSUPPORTED'], ['aave-v3-ethereum-horizon', 'UNSUPPORTED'], ['aave-v3-other-chains', 'UNSUPPORTED']
	]);
});

/* ------------------------------------------------------------ Zuordnung -- */

test('AAVE-MAPPING only Core is MATCHED to product 97; Lido/Prime and EtherFi stay AMBIGUOUS; no name or client fallback', () => {
	assert.deepEqual(R.nexusMappingClass(position(CORE)), { class: 'MATCHED', productId: 97, reason: 'PINNED_DEPLOYMENT' });
	for (const market of [LIDO, ETHERFI]) assert.equal(R.nexusMappingClass(position(market)).class, 'AMBIGUOUS', market.deploymentKey);
	assert.equal(R.nexusMappingClass(position(CORE, { chainId: 10 })).class, 'AMBIGUOUS');
	assert.equal(R.nexusMappingClass(position(CORE, { protocolVersion: 'v2' })).class, 'AMBIGUOUS');
	assert.equal(R.nexusMappingClass(position(CORE, { marketAddress: LIDO.pool })).class, 'AMBIGUOUS');
	for (const deploymentKey of ['aave-v3-ethereum-horizon', 'aave v3', 'Aave v3']) assert.equal(R.nexusMappingClass(position(CORE, { deploymentKey })).class, 'UNSUPPORTED', deploymentKey);
	// eine Produkt-ID oder ein Produktname in der Position aendert nichts
	assert.equal(R.nexusMappingClass(position(LIDO, { productId: 97, productName: 'Aave v3', nexus: { productId: 97 } })).class, 'AMBIGUOUS');
	for (const extra of [{ productId: 97 }, { productId: 2 }, { nexusProductId: 449 }]) {
		assert.equal(parseCoverRequest({ action: 'details', deploymentKey: CORE.deploymentKey, ...extra }).code, 'PRODUCT_ID_NOT_ACCEPTED');
	}
});

/* -------------------------------------------------------------- Assets -- */

test('AAVE-ASSETS quote assets are ETH, USDC, cbBTC; a later purchase only USDC; DAI and unknown symbols are refused', () => {
	assert.deepEqual([...R.QUOTE_COVER_ASSETS], ['ETH', 'USDC', 'cbBTC']);
	assert.deepEqual([...R.PURCHASE_COVER_ASSETS], ['USDC']);
	assert.deepEqual([...R.PURCHASE_DEPLOYMENT_KEYS], ['aave-v3-ethereum-core']);
	for (const coverAsset of ['DAI', 'NXM', 'WETH', 'usdc', 'BTC', '']) {
		assert.equal(parseCoverRequest({ action: 'quote', deploymentKey: CORE.deploymentKey, coverAsset, amount: '1', periodDays: 30 }).code, 'ASSET_NOT_SUPPORTED', coverAsset);
	}
});

/* ---------------------------------------------------------- Engagement -- */

test('AAVE-EXPOSURE suggested exposure = supplied - debt in exact 8-decimal BigInt, floored at zero; floats and mismatched totals are invalid', () => {
	const e = computeAaveExposure(position());
	assert.deepEqual([e.status, e.calculationMethod, e.grossExposure, e.debt, e.suggestedExposure], ['OK', 'AAVE_NET_EXPOSURE_V1', '26000.62345678', '6000.00000001', '20000.62345677']);
	assert.deepEqual([...e.disclaimers], ['SUGGESTED_AMOUNT_ONLY', 'NOT_A_GUARANTEED_CLAIMABLE_AMOUNT', 'NEXUS_WORDING_GOVERNS']);
	// exakt, wo Gleitkomma rundet: 0.1 + 0.2 - 0.3
	const exact = computeAaveExposure(position(CORE, { supplied: [{ usdValue: '0.1' }, { usdValue: '0.2' }], borrowed: [{ usdValue: '0.3' }], totals: { suppliedUsd: '0.3', debtUsd: '0.3' } }));
	assert.equal(exact.suggestedExposure, '0');
	const big = computeAaveExposure(position(CORE, { supplied: [{ usdValue: '123456789012345678901.12345678' }], borrowed: [{ usdValue: '0.00000001' }], totals: { suppliedUsd: '123456789012345678901.12345678', debtUsd: '0.00000001' } }));
	assert.equal(big.suggestedExposure, '123456789012345678901.12345677');
	// Schulden ueber den Einlagen: kein negativer Vorschlag
	const under = computeAaveExposure(position(CORE, { supplied: [{ usdValue: '100' }], borrowed: [{ usdValue: '150.5' }], totals: { suppliedUsd: '100', debtUsd: '150.5' } }));
	assert.deepEqual([under.status, under.suggestedExposure, under.debt], ['OK', '0', '150.5']);
	for (const bad of [{ usdValue: 100 }, { usdValue: '1e3' }, { usdValue: '-1' }, { usdValue: '1.123456789' }, { usdValue: ' 1' }]) {
		assert.equal(computeAaveExposure(position(CORE, { supplied: [bad], totals: { suppliedUsd: '100', debtUsd: '6000.00000001' } })).status, 'INVALID', JSON.stringify(bad));
	}
	assert.equal(computeAaveExposure(position(CORE, { totals: { suppliedUsd: '26000.62345678', debtUsd: '0' } })).reason, 'TOTALS_MISMATCH', 'debt cannot be dropped');
	assert.equal(computeAaveExposure(position(CORE, { valueKind: 'USER_SUPPLIED' })).status, 'INVALID');
});

/* -------------------------------------------------------------- Quote -- */

test('AAVE-QUOTE amount bounded by suggested exposure and capacity, period 28..365, product only from the EXACT mapping', async () => {
	const pos = position();
	const model = await modelFor(pos);
	assert.equal(model.eligibility.status, 'AVAILABLE');
	const ok = checkQuoteRequest({ coverAsset: 'USDC', amount: '20000.623456', periodDays: 30 }, model, pos);
	assert.equal(ok.ok, true);
	assert.equal(ok.productId, 97);
	assert.equal(ok.amount, 20_000_623_456n);
	assert.deepEqual(checkQuoteRequest({ coverAsset: 'USDC', amount: '20000.623457', periodDays: 30 }, model, pos), { ok: false, code: 'AMOUNT_OUT_OF_RANGE', maxAmount: '20000.623456', limitedBy: 'EXPOSURE' });
	for (const periodDays of [27, 366]) assert.equal(checkQuoteRequest({ coverAsset: 'USDC', amount: '1', periodDays }, model, pos).code, 'PERIOD_OUT_OF_RANGE');
	for (const amount of ['0', '-1', '1e3', '1.0000001']) assert.equal(checkQuoteRequest({ coverAsset: 'USDC', amount, periodDays: 30 }, model, pos).ok, false, amount);
	// Lido/Prime: keine Quote, obwohl dasselbe Produkt im Katalog steht
	const lido = position(LIDO);
	assert.equal(checkQuoteRequest({ coverAsset: 'USDC', amount: '1', periodDays: 30 }, await modelFor(lido), lido).code, 'COVER_NOT_AVAILABLE');
});

test('AAVE-FRESH quote and capacity are usable strictly below 60 s; future timestamps are not fresh', () => {
	assert.equal(R.MAX_QUOTE_AGE_MS, 60_000);
	assert.equal(R.MAX_QUOTE_AGE_MS, QUOTE_TTL_MS);
	assert.equal(R.isFreshAt(NOW, NOW), true);
	assert.equal(R.isFreshAt(NOW, NOW + 59_999), true);
	assert.equal(R.isFreshAt(NOW, NOW + 60_000), false);
	assert.equal(R.isFreshAt(NOW + 1, NOW), false, 'not from the future');
	assert.equal(R.isFreshAt(null, NOW), false);
	const q = { quoteExpiresAt: new Date(NOW + 60_000).toISOString() };
	assert.equal(quoteFreshness(q, NOW + 59_999), 'FRESH');
	assert.equal(quoteFreshness(q, NOW + 60_000), 'STALE');
});

/* -------------------------------------------------------- Bereitschaft -- */

test('AAVE-READY with every technical condition met the decision is still BLOCKED, only by Terms, PoL and the external blockers', async () => {
	const r = R.evaluateAavePurchaseReadiness(await allTechnical());
	assert.equal(r.decision, 'BLOCKED');
	assert.equal(r.readyForPurchaseExecution, false);
	assert.deepEqual([...r.reasons], EXTERNAL_ONLY);
	assert.equal(r.terms, 'TERMS_BLOCKED');
	assert.equal(r.proofOfLoss, 'POL_BLOCKED');
	assert.deepEqual(R.READINESS_DECISIONS, ['READY_FOR_PURCHASE_EXECUTION', 'BLOCKED']);
});

test('AAVE-READY-REASONS every missing technical condition adds its own reason', async () => {
	const base = await allTechnical();
	const reasonsOf = (patch) => R.evaluateAavePurchaseReadiness({ ...base, ...patch }).reasons.filter((code) => !EXTERNAL_ONLY.includes(code));
	assert.deepEqual(reasonsOf({ sessionWallet: null }), ['WALLET_NOT_AUTHENTICATED']);
	assert.deepEqual(reasonsOf({ sessionWallet: OTHER }), ['WALLET_MISMATCH']);
	assert.deepEqual(reasonsOf({ sessionWallet: 'not-a-wallet' }), ['WALLET_NOT_AUTHENTICATED']);
	assert.ok(reasonsOf({ position: position(CORE, { chainId: 8453 }) }).includes('CHAIN_MISMATCH'));
	assert.ok(reasonsOf({ position: position(CORE, { protocolVersion: 'v2' }) }).includes('MARKET_NOT_SUPPORTED'));
	assert.ok(reasonsOf({ position: position(CORE, { deploymentKey: 'aave-v3-ethereum-horizon' }) }).includes('MARKET_NOT_SUPPORTED'));
	const lido = reasonsOf({ position: position(LIDO) });
	assert.ok(lido.includes('MARKET_NOT_IN_PURCHASE_SCOPE') && lido.includes('NEXUS_MAPPING_NOT_MATCHED'), lido.join());
	assert.ok(reasonsOf({ position: position(CORE, { totals: { suppliedUsd: '1', debtUsd: '0' } }) }).includes('EXPOSURE_INVALID'));
	const empty = position(CORE, { supplied: [{ usdValue: '5' }], borrowed: [{ usdValue: '5' }], totals: { suppliedUsd: '5', debtUsd: '5' } });
	assert.ok(reasonsOf({ position: empty }).includes('NO_SUGGESTED_EXPOSURE'));
	assert.ok(reasonsOf({ model: { ...base.model, eligibility: { status: 'UNAVAILABLE' } } }).includes('COVER_NOT_AVAILABLE'));
	assert.ok(reasonsOf({ model: { ...base.model, nexusMatch: { ...base.model.nexusMatch, productId: 2 } } }).includes('COVER_NOT_AVAILABLE'));
	// Kapazitaet
	assert.deepEqual(reasonsOf({ now: NOW + 59_999 }), []);
	assert.ok(reasonsOf({ now: NOW + 60_000 }).includes('CAPACITY_STALE'));
	assert.ok(reasonsOf({ model: { ...base.model, capacity: { ...base.model.capacity, fetchedAt: new Date(NOW + 5_000).toISOString() } } }).includes('CAPACITY_STALE'));
	assert.ok(reasonsOf({ model: { ...base.model, capacity: { ...base.model.capacity, fetchedAt: 'x' } } }).includes('CAPACITY_MISSING'));
	// Quote
	assert.ok(reasonsOf({ quote: null }).includes('QUOTE_MISSING'));
	assert.ok(reasonsOf({ quote: quote({ quoteFetchedAt: new Date(NOW - 59_000).toISOString(), quoteExpiresAt: new Date(NOW + 1_000).toISOString() }) }).includes('QUOTE_STALE'));
	assert.ok(reasonsOf({ quote: quote({ quoteExpiresAt: new Date(NOW + 120_000).toISOString() }) }).includes('QUOTE_STALE'), 'a quote may not claim a longer validity');
	assert.ok(reasonsOf({ quote: quote({ coverAsset: 'ETH', premiumAsset: 'ETH', coverAmount: '1' }) }).includes('PAYMENT_ASSET_NOT_SUPPORTED'));
	assert.ok(reasonsOf({ quote: quote({ coverAsset: 'DAI', premiumAsset: 'DAI' }) }).includes('PAYMENT_ASSET_NOT_SUPPORTED'));
	assert.ok(reasonsOf({ quote: quote({ premiumAsset: 'ETH' }) }).includes('PAYMENT_ASSET_NOT_SUPPORTED'));
	assert.ok(reasonsOf({ quote: quote({ coverAmount: '20000.623457' }) }).includes('QUOTE_OUT_OF_BOUNDS'));
	assert.deepEqual(reasonsOf({ quote: quote({ coverAmount: '20000.623456' }) }), []);
	assert.ok(reasonsOf({ quote: quote({ coverAmount: '0' }) }).includes('QUOTE_OUT_OF_BOUNDS'));
	assert.ok(reasonsOf({ quote: quote({ periodDays: 27 }) }).includes('QUOTE_PERIOD_INVALID'));
	// Allokation und Ausfuehrungszustand
	assert.deepEqual(reasonsOf({ allocation: null }), ['ALLOCATION_NOT_VALIDATED']);
	assert.deepEqual(reasonsOf({ allocation: { ok: false } }), ['ALLOCATION_NOT_VALIDATED']);
	assert.deepEqual(reasonsOf({ execution: null }), ['EXECUTION_STATE_NOT_CHECKED']);
	assert.deepEqual(reasonsOf({ execution: { pinsVerified: false, unresolvedAttempt: false, preSendFresh: true } }), ['CONTRACT_PINS_NOT_VERIFIED']);
	assert.deepEqual(reasonsOf({ execution: { pinsVerified: true, unresolvedAttempt: null, preSendFresh: true } }), ['UNRESOLVED_EXECUTION_ATTEMPT']);
	assert.deepEqual(reasonsOf({ execution: { pinsVerified: true, unresolvedAttempt: false, preSendFresh: false } }), ['PRE_SEND_STATE_STALE']);
});

test('AAVE-READY-NO-OVERRIDE the external blockers cannot be switched off by any input', async () => {
	const base = await allTechnical();
	for (const extra of [{ externalBlockers: [] }, { blockers: [] }, { terms: 'TERMS_READY' }, { proofOfLoss: 'POL_READY' }, { force: true }]) {
		const r = R.evaluateAavePurchaseReadiness({ ...base, ...extra });
		assert.equal(r.decision, 'BLOCKED');
		assert.ok(r.reasons.includes(`UNKNOWN_FIELD:${Object.keys(extra)[0]}`));
		for (const code of EXTERNAL_ONLY) assert.ok(r.reasons.includes(code), code);
	}
	assert.ok(Object.isFrozen(R.EXTERNAL_BLOCKERS) && R.EXTERNAL_BLOCKERS.every(Object.isFrozen));
	assert.equal(R.evaluateAavePurchaseReadiness(null).decision, 'BLOCKED');
});

/* --------------------------------------------------------- Terms / PoL -- */

test('AAVE-TERMS-POL Terms and proof of loss are BLOCKED while Nexus has not answered; unexpected PoL types are their own blocker', () => {
	const terms = R.termsReadiness();
	assert.equal(terms.status, 'TERMS_BLOCKED');
	assert.deepEqual([...terms.blockers], ['CR-TERMS-002']);
	assert.deepEqual({ ...terms.known }, { wordingCid: 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY', annexCid: null });
	const pol = R.polReadiness(['address']);
	assert.equal(pol.status, 'POL_BLOCKED');
	assert.deepEqual([...pol.blockers], ['CR-POL-002']);
	assert.deepEqual([...pol.reasons], []);
	assert.deepEqual([...pol.known.expectedInputTypes], ['address']);
	assert.deepEqual([...R.polReadiness(['address', 'csv']).reasons], ['POL_TYPES_UNEXPECTED']);
	assert.deepEqual([...R.polReadiness([]).reasons], ['POL_TYPES_UNEXPECTED']);
	assert.deepEqual([...R.polReadiness(null).reasons], ['POL_TYPES_UNKNOWN']);
});

test('AAVE-BLOCKERS-CRSF every external blocker is UNRESOLVED exactly while CRSF records it as missing evidence', () => {
	const controls = JSON.parse(readFileSync(new URL('../security/crsf/controls.json', import.meta.url), 'utf8'));
	const list = Array.isArray(controls) ? controls : controls.controls;
	const byId = new Map(list.map((c) => [c.id, c]));
	assert.deepEqual(R.EXTERNAL_BLOCKERS.map((b) => [b.id, b.area, b.status]), [
		['CR-TERMS-002', 'TERMS', 'UNRESOLVED'], ['CR-POL-002', 'PROOF_OF_LOSS', 'UNRESOLVED'], ['CR-PURCHASE-008/P3', 'WALLET_EXECUTION', 'UNRESOLVED']
	]);
	for (const id of ['CR-TERMS-002', 'CR-POL-002']) {
		const c = byId.get(id);
		assert.equal(c.security_status, 'MISSING_EVIDENCE', id);
		for (const p of c.properties) assert.deepEqual(c.property_coverage[p.id].satisfied_by, [], `${id} ${p.id}`);
	}
	assert.deepEqual(byId.get('CR-PURCHASE-008').property_coverage.P3.satisfied_by, [], 'CR-PURCHASE-008 P3');
});

test('AAVE-DETAILS the cover details show the readiness as BLOCKED with neutral reasons and no purchase wording', async () => {
	const pos = position();
	const model = await modelFor(pos);
	const d = coverDetails(model, pos, NOW);
	assert.deepEqual(d.readiness, { status: 'BLOCKED', reasons: ['NEXUS_TERMS_UNCONFIRMED', 'NEXUS_PROOF_OF_LOSS_UNCONFIRMED', 'WALLET_EXECUTION_NOT_AVAILABLE'] });
	assert.doesNotMatch(JSON.stringify(d.readiness), /Purchase|transaction|approve|buyCover|READY_FOR/i);
	const lido = position(LIDO);
	assert.deepEqual(coverDetails(await modelFor(lido), lido, NOW), { ok: true, available: false, status: 'AMBIGUOUS' });
});

/* ---------------------------------------------------------- Cover-Status -- */

const cover = (patch = {}) => ({ coverId: 7001, productId: 97, status: 'active', endsAt: new Date(NOW + 20 * DAY).toISOString(), asset: { id: 6, symbol: 'USDC' }, amount: '5000', ...patch });
const covers = (list, wallet = WALLET) => ({ wallet, covers: list });
const attributed = (patch = {}) => ({ deploymentKey: CORE.deploymentKey, coverId: 7001, productId: 97, ...patch });

test('AAVE-COVER only a confirmed attribution of an active, unexpired product-97 cover of this wallet is ACTIVE_COVER', () => {
	const status = (patch = {}) => R.aaveCoverStatus({ wallet: WALLET, position: position(), covers: covers([cover()]), validAttributions: [attributed()], now: NOW, ...patch });
	assert.deepEqual(status(), { state: 'ACTIVE_COVER', coverId: 7001, endsAt: cover().endsAt });
	// ohne Zuordnung kein Treffer, nur ein offener Hinweis
	assert.deepEqual(status({ validAttributions: [] }), { state: 'NO_ACTIVE_COVER', coverId: null, attributionOpen: true });
	assert.deepEqual(status({ validAttributions: [], covers: covers([]) }), { state: 'NO_ACTIVE_COVER', coverId: null, attributionOpen: false });
	// Zuordnung fuer einen anderen Markt, ein anderes Produkt oder ein anderes Cover
	assert.equal(status({ validAttributions: [attributed({ deploymentKey: LIDO.deploymentKey })] }).state, 'NO_ACTIVE_COVER');
	assert.equal(status({ validAttributions: [attributed({ productId: 449 })] }).state, 'NO_ACTIVE_COVER');
	assert.equal(status({ covers: covers([cover({ productId: 115 })]) }).state, 'NO_ACTIVE_COVER');
	assert.equal(status({ covers: covers([cover({ coverId: 7002 })]) }).state, 'NO_ACTIVE_COVER');
	// abgelaufen, auch wenn der zwischengespeicherte Status noch "active" sagt
	assert.equal(status({ covers: covers([cover({ endsAt: new Date(NOW - 1).toISOString() })]) }).state, 'NO_ACTIVE_COVER');
	assert.equal(status({ covers: covers([cover({ endsAt: new Date(NOW).toISOString() })]) }).state, 'NO_ACTIVE_COVER');
	for (const s of ['expired', 'superseded']) assert.equal(status({ covers: covers([cover({ status: s })]) }).state, 'NO_ACTIVE_COVER', s);
	assert.equal(status({ covers: covers([cover({ demo: true })]) }).state, 'NO_ACTIVE_COVER');
	// Wallet, Lesefehler, nicht unterstuetzt
	assert.equal(status({ wallet: OTHER }).state, 'UNKNOWN');
	assert.equal(status({ covers: covers([cover()], OTHER) }).state, 'UNKNOWN');
	assert.equal(status({ covers: null }).state, 'UNKNOWN');
	assert.equal(status({ validAttributions: null }).state, 'UNKNOWN');
	assert.equal(status({ position: position(CORE, { deploymentKey: 'aave-v3-ethereum-horizon' }) }).state, 'UNSUPPORTED');
	assert.equal(status({ position: position(CORE, { chainId: 42161 }) }).state, 'UNSUPPORTED');
	assert.deepEqual(R.COVER_STATES, ['ACTIVE_COVER', 'NO_ACTIVE_COVER', 'UNKNOWN', 'UNSUPPORTED']);
});

test('AAVE-MONITOR remaining days and the existing Telegram expiry thresholds work for an Aave cover', () => {
	assert.equal(R.coverDaysLeft(cover({ endsAt: new Date(NOW + 6.5 * DAY).toISOString() }), NOW), 7);
	assert.equal(R.coverDaysLeft(cover({ endsAt: new Date(NOW + DAY).toISOString() }), NOW), 1);
	assert.equal(R.coverDaysLeft(cover({ endsAt: new Date(NOW).toISOString() }), NOW), null);
	assert.equal(R.coverDaysLeft(cover({ endsAt: 'x' }), NOW), null);
	const aave = { ...cover(), productName: 'Aave v3', endsAt: new Date(NOW + 6.5 * DAY).toISOString() };
	assert.equal(dueThreshold(aave.endsAt, NOW), 7);
	assert.equal(dueThreshold(new Date(NOW + 20 * DAY).toISOString(), NOW), 30);
	assert.equal(dueThreshold(new Date(NOW - 1).toISOString(), NOW), null);
	const text = formatExpiryAlert(aave, 7, 'en');
	assert.match(text, /Aave v3/);
	assert.match(text, /7001/);
});

/* -------------------------------------------------------------- Matrix -- */

test('AAVE-MATRIX the support matrix is derived from the implementation', () => {
	const m = R.aaveSupportMatrix();
	assert.equal(m.nexusProductId, 97);
	const rows = m.markets.map((r) => [r.deploymentKey, r.class, r.nexusMapping, r.capacity, r.quote, [...r.quoteAssets].join('/'), [...r.purchaseAssets].join('/'), r.terms, r.proofOfLoss, r.purchaseExecution, r.coverMonitoring]);
	assert.deepEqual(rows, [
		['aave-v3-ethereum-core', 'SUPPORTED', 'MATCHED', 'YES', 'YES', 'ETH/USDC/cbBTC', 'USDC', 'BLOCKED_EXTERNAL', 'BLOCKED_EXTERNAL', 'NO', 'YES'],
		['aave-v3-ethereum-lido', 'SUPPORTED', 'AMBIGUOUS', 'NO', 'NO', '', '', 'NOT_APPLICABLE', 'NOT_APPLICABLE', 'NO', 'YES'],
		['aave-v3-ethereum-etherfi', 'SUPPORTED', 'AMBIGUOUS', 'NO', 'NO', '', '', 'NOT_APPLICABLE', 'NOT_APPLICABLE', 'NO', 'YES']
	]);
	const doc = readFileSync(new URL('../docs/aave-v3-ethereum-support.json', import.meta.url), 'utf8');
	assert.deepEqual(JSON.parse(doc), JSON.parse(JSON.stringify(m)), 'docs/aave-v3-ethereum-support.json matches the implementation');
});

/* ------------------------------------------------------------- statisch -- */

test('AAVE-STATIC the readiness module is pure: no network, wallet, storage, clock, purchase modules or transaction code', () => {
	const code = readFileSync(new URL('../src/aave-cover-readiness.mjs', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	assert.deepEqual([...code.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['./positions/aave-registry.mjs', './positions/nexus-mapping.mjs', './positions/exposure.mjs', './nexus-pinned.mjs']);
	assert.doesNotMatch(code, /purchase-|fetch\(|process\.env|Date\.now|new Date\(|\.request\(|eth_send|sendTransaction|sendRawTransaction|wallet_sendCalls|writeContract|signTypedData|personal_sign|buyCover|encodeFunctionData|approve\(/);
});
