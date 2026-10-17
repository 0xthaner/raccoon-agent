/**
 * F-2H-1 (CRSF Phase 2I, CR-RESOURCE-001 P4): vor JEDER Cover-Abfrage von
 * /api/position-attributions greifen IP-, Wallet- und das globale Cover-Budget
 * (dashboard-read-global) - unabhaengig davon, ob die Positionen kalt, warm oder
 * als Fehler im Cache liegen.
 *
 * Echt laufen: der Handler api/position-attributions.mjs, die Request-Schranken
 * aus src/http-security.mjs, getWalletPositions mit seinem echten Cache und
 * getWalletCovers (src/covers.mjs -> cover-chain.mjs) bis an den Draht.
 * Ersetzt sind nur der Zaehlerspeicher des Rate-Limiters (er lehnt gezielt einen
 * Schluessel ab), die Aave-RPC (Attrappe mit Zaehler), die Draehte zu Alchemy-NFT,
 * Nexus und der getCovers-RPC (Zaehler) und die Datenbank (Spione).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { aaveClient, CATALOG } from '../test-support/aave-fake-client.mjs';

process.env.DASHBOARD_SESSION_SECRET = 'attrib-cover-budget-secret-0123456789abcdef';
process.env.APP_BASE_URL = 'https://coverraccoon.com';
delete process.env.DEMO_WALLET;
const auth = await import('../src/dashboard-auth.mjs');
const { siweOrigin } = await import('../src/siwe-auth.mjs');
const positions = await import('../src/positions/index.mjs');
const { getWalletCovers } = await import('../src/covers.mjs');
const { COVER_NFT, _test: coverChain } = await import('../src/cover-chain.mjs');
const { createAttributionsHandler } = await import('../api/position-attributions.mjs');

const WALLET = '0x' + 'a1'.repeat(20);
const CORE = 'aave-v3-ethereum-core';
const strip = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/^import [^;]*;\n/gm, '');
const SECURITY_EVENT = new Proxy({}, { get: (_t, k) => String(k) });
const NOW = Date.parse('2026-10-17T10:00:00Z');
let clock = NOW;

/** Draht: Alchemy-NFT-Index und Nexus-Produktliste (fetch), getCovers (readContract). Ein Cover #1, Produkt 97, aktiv. */
function coverWire() {
	const calls = { alchemyNft: 0, nexus: 0, getCovers: 0 };
	const fetchImpl = async (url) => {
		const u = String(url);
		if (u.includes('/nft/v3/')) { calls.alchemyNft++; return { ok: true, status: 200, json: async () => ({ ownedNfts: [{ contractAddress: COVER_NFT, tokenId: '1' }], totalCount: 1 }) }; }
		if (u.includes('nexusmutual')) { calls.nexus++; return { ok: true, status: 200, json: async () => [{ id: 97, name: 'Aave v3' }] }; }
		throw new Error(`unexpected fetch ${u}`);
	};
	const start = BigInt(Math.floor(Date.now() / 1000) - 86_400);
	const client = { readContract: async ({ functionName }) => { assert.equal(functionName, 'getCovers'); calls.getCovers++; return [{ coverId: 1n, productId: 97n, coverAsset: 6n, amount: 10_000_000_000n, start, period: 90n * 86_400n, gracePeriod: 30n * 86_400n, originalCoverId: 0n, latestCoverId: 0n }]; } };
	return { calls, getCovers: (wallet) => getWalletCovers(wallet, { apiKey: 'test-key', fetchImpl, client }) };
}

/** Eine Welt je Anfrage; der Positions-Cache (Modulzustand) bleibt zwischen Anfragen bestehen. */
function world({ deny = null, aave = aaveClient(), rows = [] } = {}) {
	const limits = [];
	const writes = [];
	const checkRateLimit = async (key, max, window) => { const scope = key.split(':')[0]; limits.push(scope === 'dashboard-read-global' ? `${scope}/${max}/${window}` : scope); return scope !== deny; };
	const http = new Function('createHmac', 'checkRateLimit', 'dashboardSecretConfigured', 'siweOrigin', 'recordSecurityEvent', 'SECURITY_EVENT',
		`${strip('src/http-security.mjs').replace(/^export /gm, '')}\nreturn { enforceRateLimit, enforceRateLimitFor, requireJson, requireSameOrigin };`)(
		createHmac, checkRateLimit, auth.dashboardSecretConfigured, siweOrigin, async () => {}, SECURITY_EVENT);
	const wire = coverWire();
	coverChain.resetProductCache();
	const handler = createAttributionsHandler({
		getPositions: (wallet, options) => positions.getWalletPositions(wallet, { ...options, client: aave, catalogLoader: async () => CATALOG, now: () => clock }),
		getCovers: wire.getCovers,
		listRows: async () => rows.map((row) => ({ ...row })),
		upsertRow: async (relation) => { writes.push('upsert'); return { status: 'inserted', row: { deployment_key: relation.deploymentKey, product_id: relation.productId, cover_id: relation.coverId, source: 'user_confirmed', confirmed_at: new Date(relation.now).toISOString() } }; },
		deleteRow: async () => { writes.push('delete'); return 1; },
		deleteStaleRow: async () => { writes.push('deleteStale'); return 1; },
		isRevoked: async () => false,
		rateLimit: http.enforceRateLimit, rateLimitFor: http.enforceRateLimitFor, sameOrigin: http.requireSameOrigin, json: http.requireJson, now: () => clock
	});
	return { handler, limits, writes, wire, aave };
}

const cookie = `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(WALLET, Date.now(), 'eoa'))}`;
const STORED = { wallet: WALLET, protocol_key: 'aave', protocol_version: 'v3', deployment_key: CORE, product_id: 97, cover_id: 1, source: 'user_confirmed', confirmed_at: '2026-10-16T10:00:00.000Z' };
async function call(method, w) {
	const r = { statusCode: null, body: null, headers: {}, headersSent: false, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
	const headers = method === 'GET' ? { cookie, 'x-forwarded-for': '198.51.100.61' } : { cookie, origin: 'https://coverraccoon.com', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': '50', 'x-forwarded-for': '198.51.100.61' };
	await w.handler({ method, url: '/api/position-attributions', headers, body: method === 'GET' ? undefined : { deploymentKey: CORE, coverId: 1 } }, r);
	return r;
}

const COVER_BUDGET = 'dashboard-read-global/300/600';
const PREFIX = { POST: ['attributions-write', 'attributions-write-wallet'], GET: ['attributions-read', 'attributions-wallet'] };
const CACHES = ['cold', 'warm', 'failure'];

/** Bringt den Positions-Cache in den gewuenschten Zustand (ohne Cover-Abfrage). */
async function primePositions(cache) {
	positions._test.reset();
	clock += 3_600_000;
	if (cache === 'cold') return;
	const primed = await positions.getWalletPositions(WALLET, { client: aaveClient({ fail: cache === 'failure' }), catalogLoader: async () => CATALOG, now: () => clock });
	assert.equal(primed.complete, cache === 'warm');
}
const rowsFor = (method) => (method === 'GET' ? [STORED] : []);
const zero = (wire) => wire.calls.alchemyNft + wire.calls.nexus + wire.calls.getCovers;

for (const method of ['POST', 'GET']) {
	for (const cache of CACHES) test(`ATTRIB-COVER-BUDGET ${method} denied ${cache}`, async () => {
		{
			await primePositions(cache);
			const w = world({ deny: 'dashboard-read-global', rows: rowsFor(method) });
			const r = await call(method, w);
			const label = `${method} ${cache}:`;
			assert.equal(r.statusCode, 429, `${label} status ${r.statusCode}`);
			assert.equal(r.headers['retry-after'], '600', `${label} retry-after`);
			assert.deepEqual(w.wire.calls, { alchemyNft: 0, nexus: 0, getCovers: 0 }, `${label} cover provider reached ${JSON.stringify(w.wire.calls)}`);
			assert.deepEqual(w.writes, [], `${label} attribution mutated ${w.writes}`);
			// Gleiche Schranke an gleicher Stelle: nur die Positions-Schranke haengt am Cache.
			assert.deepEqual(w.limits, [...PREFIX[method], ...(cache === 'cold' ? ['positions-lookup-global'] : []), COVER_BUDGET], `${label} limit order ${w.limits}`);
			assert.equal(w.aave.calls > 0, cache === 'cold', `${label} positions RPC only on a cold cache`);
		}
	});

	for (const cache of CACHES) test(`ATTRIB-COVER-BUDGET ${method} allowed ${cache}`, async () => {
		{
			await primePositions(cache);
			const w = world({ rows: rowsFor(method) });
			const r = await call(method, w);
			const label = `${method} ${cache}:`;
			assert.deepEqual(w.wire.calls, { alchemyNft: 1, nexus: 1, getCovers: 1 }, `${label} one cover lookup ${JSON.stringify(w.wire.calls)}`);
			assert.deepEqual(w.limits, [...PREFIX[method], ...(cache === 'cold' ? ['positions-lookup-global'] : []), COVER_BUDGET], `${label} cover budget charged exactly once ${w.limits}`);
			if (cache === 'failure') {
				// Positionen unbekannt: wie bisher nichts schreiben, nichts loeschen, nichts als gueltig zeigen.
				assert.deepEqual(w.writes, [], label);
				if (method === 'POST') assert.deepEqual([r.statusCode, r.body.code], [503, 'POSITION_LOOKUP_UNAVAILABLE'], label);
				else assert.deepEqual([r.statusCode, r.body.attributions, r.body.pending], [200, [], 1], label);
			} else if (method === 'POST') {
				assert.deepEqual([r.statusCode, r.body.attribution.deploymentKey, r.body.attribution.coverId, r.body.attribution.productId], [200, CORE, 1, 97], label);
				assert.deepEqual(w.writes, ['upsert'], label);
			} else {
				assert.deepEqual([r.statusCode, r.body.attributions.map((a) => [a.deploymentKey, a.coverId]), r.body.pending, r.body.removed], [200, [[CORE, 1]], 0, 0], label);
				assert.deepEqual(w.writes, [], label);
			}
			assert.equal(w.aave.calls > 0, cache === 'cold', `${label} positions cache still used`);
		}
	});
}

test('ATTRIB-COVER-BUDGET positions budget still first on a cold cache', async () => {
	await primePositions('cold');
	const w = world({ deny: 'positions-lookup-global' });
	const r = await call('POST', w);
	assert.equal(r.statusCode, 429);
	assert.equal(w.aave.calls, 0);
	assert.equal(zero(w.wire), 0);
	assert.deepEqual(w.limits, [...PREFIX.POST, 'positions-lookup-global'], 'no cover budget charged when nothing is looked up');
});

test('ATTRIB-COVER-BUDGET no lookup paths charge no cover budget', async () => {
	await primePositions('warm');
	const get = world({ rows: [] });
	const g = await call('GET', get);
	assert.deepEqual([g.statusCode, g.body.attributions], [200, []]);
	assert.deepEqual(get.limits, PREFIX.GET);
	const del = world();
	const d = await call('DELETE', del);
	assert.deepEqual([d.statusCode, d.body.deleted], [200, true]);
	assert.deepEqual(del.limits, PREFIX.POST);
	assert.equal(zero(get.wire) + zero(del.wire), 0);
});

test('ATTRIB-COVER-BUDGET same budget as the dashboard read path', () => {
	// Kanonisches Budget aus Restaudit M2: gleicher Scope, gleiche Grenze, gleiches Fenster.
	const dashboard = readFileSync(new URL('../api/dashboard.mjs', import.meta.url), 'utf8');
	assert.match(dashboard, /const DASHBOARD_READ_GLOBAL_LIMIT = Object\.freeze\(\{ max: 300, windowSeconds: 600 \}\);/);
	assert.match(dashboard, /enforceRateLimitFor\(response, 'dashboard-read-global', 'all', DASHBOARD_READ_GLOBAL_LIMIT\.max, DASHBOARD_READ_GLOBAL_LIMIT\.windowSeconds\)/);
});

/*
	CRSF Phase 2M (CR-RESOURCE-001 P4): auch die IP- und Wallet-Schranke des
	Attributionspfads stoppen jede Anfrage vor jeder Provider-Arbeit (Positionen
	UND Covers), in jedem Cache-Zustand.
*/
for (const method of ['POST', 'GET']) {
	for (const cache of CACHES) for (const [i, gate] of PREFIX[method].entries()) test(`ATTRIB-ORDER ${method} ${cache} denied at ${gate}`, async () => {
		await primePositions(cache);
		const w = world({ deny: gate, rows: rowsFor(method) });
		const r = await call(method, w);
		const label = `${method} ${cache}:`;
		assert.equal(w.aave.calls + zero(w.wire), 0, `${label} provider calls ${w.aave.calls + zero(w.wire)} after a denied ${gate}`);
		assert.equal(r.statusCode, 429, `${label} status`);
		assert.deepEqual(w.writes, [], `${label} attribution mutated`);
		assert.deepEqual(w.limits, PREFIX[method].slice(0, i + 1), `${label} gates after ${gate}`);
	});
}
