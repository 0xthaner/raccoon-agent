/**
 * CRSF Phase 2M, CR-RESOURCE-001 P4 ("positions/attribution lookups limited
 * before provider calls"), Pfad GET /api/positions. Den Attributionspfad deckt
 * test/attribution-cover-budget.test.mjs (F-2H-1).
 *
 *   positions-read (IP) -> Sitzung/Widerruf -> positions-wallet -> positions-global
 *   -> Cache (60 s, Fehlschlag 15 s) / laufende Abfrage derselben Wallet
 *   -> positions-lookup-global (nur vor einer echten Kette-Abfrage) -> RPC
 *
 * Echt laufen: createPositionsHandler (api/positions.mjs) mit den echten
 * Schranken aus src/http-security.mjs, der echten Sitzungsaufloesung
 * (src/dashboard-auth.mjs) und dem echten getWalletPositions (Cache,
 * Zusammenlegen, Zulassung) aus src/positions/index.mjs; die Kette ist der
 * offline Aave-Client (test-support/aave-fake-client.mjs, zaehlt jeden Aufruf).
 * Ersetzt: Zaehlerspeicher, Widerruf (nie widerrufen), Nexus-Katalog (Zaehler).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { guards, response, SECURITY_EVENT } from '../test-support/rate-order-world.mjs';
import { aaveClient, CATALOG } from '../test-support/aave-fake-client.mjs';

Object.assign(process.env, { SUPABASE_URL: 'https://supabase.test.invalid', SUPABASE_SECRET_KEY: 'test-secret-key', DASHBOARD_SESSION_SECRET: 'positions-rate-order-secret-0123456789abc-01', APP_BASE_URL: 'https://coverraccoon.com' });
void SECURITY_EVENT;
const auth = await import('../src/dashboard-auth.mjs');
const { siweOrigin } = await import('../src/siwe-auth.mjs');
const { createPositionsHandler } = await import('../api/positions.mjs');
const positions = await import('../src/positions/index.mjs');

const WALLET = '0x' + 'd4'.repeat(20);
const GATES = ['positions-read', 'positions-wallet', 'positions-global'];

function world({ deny = null, fail = false } = {}) {
	const trace = [];
	const g = guards({ deny, dashboardSecretConfigured: auth.dashboardSecretConfigured, siweOrigin, trace });
	const client = aaveClient({ fail });
	let catalog = 0;
	const handler = createPositionsHandler({
		getPositions: (wallet, options) => positions.getWalletPositions(wallet, { ...options, client, catalogLoader: async () => { catalog++; return CATALOG; } }),
		isRevoked: async () => false, rateLimit: g.enforceRateLimit, rateLimitFor: g.enforceRateLimitFor
	});
	return { handler, trace, limits: g.limits, sizes: g.sizes, provider: () => client.calls, catalog: () => catalog };
}
const cookie = () => `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(WALLET, Date.now(), 'eoa'))}`;
async function get(w) {
	const r = response();
	await w.handler({ method: 'GET', url: '/api/positions', headers: { cookie: cookie(), 'x-forwarded-for': '198.51.100.71' } }, r);
	return r;
}
/** Waermt den Cache mit einer zugelassenen Abfrage (vollstaendig oder - bei fail - Fehlschlag). */
async function warm({ fail = false } = {}) {
	const w = world({ fail });
	const r = await get(w);
	assert.equal(r.code, 200);
	assert.equal(r.body.complete, !fail);
}
const CACHES = {
	cold: async () => {},
	warm: async () => warm(),
	'failure-cached': async () => warm({ fail: true })
};

for (const [state, prepare] of Object.entries(CACHES)) {
	for (const [i, gate] of GATES.entries()) {
		test(`POSITIONS-ORDER ${state} cache denied at ${gate}`, async () => {
			positions._test.reset();
			await prepare();
			const w = world({ deny: gate });
			const r = await get(w);
			assert.equal(w.provider(), 0, `positions ${state}: provider calls ${w.provider()} after a denied ${gate}`);
			assert.equal(r.code, 429, `positions ${state}: status (a cached value must not bypass ${gate})`);
			assert.equal(r.body?.positions, undefined, `positions ${state}: no data`);
			assert.deepEqual(w.limits, GATES.slice(0, i + 1), `positions ${state}: gates after ${gate}`);
		});
	}
}

test('POSITIONS-ORDER cold cache, provider budget denied: 429, no chain call, no catalog', async () => {
	positions._test.reset();
	const w = world({ deny: 'positions-lookup-global' });
	const r = await get(w);
	assert.equal(w.provider(), 0, `positions cold: provider calls ${w.provider()} after a denied positions-lookup-global`);
	assert.equal(w.catalog(), 0);
	assert.equal(r.code, 429);
	assert.deepEqual(w.limits, [...GATES, 'positions-lookup-global']);
	assert.equal(positions._test.cacheSize(), 0, 'nothing cached');
});

test('POSITIONS-ORDER cold cache admitted: every gate, then the provider budget, then exactly one chain lookup', async () => {
	positions._test.reset();
	const w = world();
	const r = await get(w);
	assert.equal(r.code, 200);
	assert.ok(w.provider() > 0);
	assert.equal(w.catalog(), 1);
	assert.deepEqual(w.limits, [...GATES, 'positions-lookup-global']);
	assert.equal(r.body.positions.length, 1);
});

test('POSITIONS-ORDER warm cache: served without provider budget or chain call (cache semantics unchanged)', async () => {
	positions._test.reset();
	await warm();
	const w = world({ deny: 'positions-lookup-global' });
	const r = await get(w);
	assert.equal(r.code, 200);
	assert.equal(w.provider(), 0);
	assert.deepEqual(w.limits, GATES, 'provider budget not consulted on a cache hit');
});

test('POSITIONS-ORDER failure-cached: incomplete result served for 15 s without a new chain call', async () => {
	positions._test.reset();
	await warm({ fail: true });
	const w = world({ deny: 'positions-lookup-global' });
	const r = await get(w);
	assert.equal(r.code, 200);
	assert.equal(r.body.complete, false);
	assert.equal(w.provider(), 0);
	assert.deepEqual(w.limits, GATES);
});

test('POSITIONS-ORDER merging: two concurrent cold requests for one wallet charge the provider budget once and make one lookup', async () => {
	positions._test.reset();
	const w = world();
	const [a, b] = await Promise.all([get(w), get(w)]);
	assert.deepEqual([a.code, b.code], [200, 200]);
	assert.equal(w.limits.filter((s) => s === 'positions-lookup-global').length, 1);
	assert.equal(w.catalog(), 1, 'one lookup');
});

test('POSITIONS-ORDER merging with the provider budget denied: no chain call; the joined request gets 503, not data', async () => {
	positions._test.reset();
	const w = world({ deny: 'positions-lookup-global' });
	const [a, b] = await Promise.all([get(w), get(w)]);
	assert.equal(w.provider(), 0, `positions merged: provider calls ${w.provider()} after a denied positions-lookup-global`);
	assert.deepEqual([a.code, b.code].sort(), [429, 503]);
});

test('POSITIONS-ORDER budget sizes are the documented ones (per 600 s)', async () => {
	positions._test.reset();
	const w = world();
	await get(w);
	assert.deepEqual(w.sizes, { 'positions-read': [60, 600], 'positions-wallet': [30, 600], 'positions-global': [1200, 600], 'positions-lookup-global': [200, 600] });
});
