/*
	CRSF evidence probe EV-PROBE-ATTRIB-COVERS (finding F-2H-1).

	Question: does /api/position-attributions reach the cover provider lookup
	(getWalletCovers: Alchemy NFT index, Nexus, getCovers RPC) without the
	global cover budget, depending on the positions cache?

	Real code: api/position-attributions.mjs (createAttributionsHandler), the
	request guards of src/http-security.mjs (enforceRateLimit[For]), the session
	check of src/dashboard-auth.mjs and getWalletPositions of
	src/positions/index.mjs with its real in-memory cache. Stubs: the limiter
	store (records keys; denies the keys matching the step's pattern), the Aave
	chain client (test-support/aave-fake-client.mjs, counts calls), the cover
	lookup (a counter) and the database rows. Offline, no keys. Prints one JSON
	line.

	History: in CRSF Phase 2H this probe reproduced the defect (recorded as a
	VIOLATION of CR-RESOURCE-001 P4): with cached positions a POST reached the
	cover provider with every global budget denied. Fixed in Phase 2I; since
	then it is a regression proof and exits 0 only when
	- cold positions cache + denied global cover budget: no cover provider work (429);
	- warm positions cache + denied global cover budget: no cover provider work (429);
	- with every budget admitting, the request still reaches the cover provider;
	- the positions cache still works (the warm request makes no positions RPC).
	A reintroduced bypass makes it exit 1 and the evidence FAIL.
*/
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

process.env.DASHBOARD_SESSION_SECRET = 'crsf-probe-attrib-covers-secret-0123456789ab';
process.env.APP_BASE_URL = 'https://coverraccoon.com';
const auth = await import('../../../src/dashboard-auth.mjs');
const { siweOrigin } = await import('../../../src/siwe-auth.mjs');
const positions = await import('../../../src/positions/index.mjs');
const { aaveClient, CATALOG } = await import('../../../test-support/aave-fake-client.mjs');
const { createAttributionsHandler } = await import('../../../api/position-attributions.mjs');

const WALLET = '0x' + 'a1'.repeat(20);
const strip = (file) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8').replace(/^import [^;]*;\n/gm, '');
const SECURITY_EVENT = new Proxy({}, { get: (_t, k) => String(k) });
const aave = aaveClient();

function world(deny) {
	const trace = [];
	const checkRateLimit = async (key) => { const scope = key.split(':')[0]; const admitted = !deny.test(scope); trace.push(`limit ${scope} ${admitted ? 'admit' : 'DENY'}`); return admitted; };
	const http = new Function('createHmac', 'checkRateLimit', 'dashboardSecretConfigured', 'siweOrigin', 'recordSecurityEvent', 'SECURITY_EVENT',
		`${strip('src/http-security.mjs').replace(/^export /gm, '')}\nreturn { enforceRateLimit, enforceRateLimitFor, requireJson, requireSameOrigin };`)(
		createHmac, checkRateLimit, auth.dashboardSecretConfigured, siweOrigin, async () => {}, SECURITY_EVENT);
	const handler = createAttributionsHandler({
		getPositions: (wallet, options) => { trace.push('positions'); return positions.getWalletPositions(wallet, { ...options, client: aave, catalogLoader: async () => CATALOG }); },
		getCovers: async (wallet) => { trace.push('PROVIDER covers'); return { wallet, covers: [{ coverId: 1, productId: 97, status: 'active' }] }; },
		listRows: async () => [], upsertRow: async (relation) => { trace.push('DB upsert'); return { status: 'inserted', row: { deployment_key: relation.deploymentKey, product_id: relation.productId, cover_id: relation.coverId, source: 'user_confirmed', confirmed_at: 'x' } }; }, deleteRow: async () => 0, deleteStaleRow: async () => 0,
		isRevoked: async () => false, rateLimit: http.enforceRateLimit, rateLimitFor: http.enforceRateLimitFor, sameOrigin: http.requireSameOrigin, json: http.requireJson
	});
	return { handler, trace };
}
const cookie = `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(WALLET, Date.now(), 'eoa'))}`;
async function post(deny) {
	const w = world(deny);
	const rpcBefore = aave.calls;
	const r = { code: null, headersSent: false, setHeader() {}, status(c) { this.code = c; return this; }, json() { this.headersSent = true; return this; } };
	await w.handler({ method: 'POST', url: '/api/position-attributions', body: { deploymentKey: 'aave-v3-ethereum-core', coverId: 1 },
		headers: { cookie, origin: 'https://coverraccoon.com', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': '50', 'x-forwarded-for': '198.51.100.41' } }, r);
	return { status: r.code, trace: w.trace, cover_provider_reached: w.trace.includes('PROVIDER covers'), global_denied: w.trace.some((t) => /-global DENY$/.test(t)), positions_rpc: aave.calls - rpcBefore };
}

const ADMIT_ALL = /^$/;
const COVER_BUDGET = /^dashboard-read-global$/;
const ALL_GLOBAL = /-global$/;
positions._test.reset();
const observation = { question: 'F-2H-1', steps: {} };
const s = observation.steps;
s.cold_cache_cover_budget_denied = await post(COVER_BUDGET);
positions._test.reset();
s.cold_cache_all_global_denied = await post(ALL_GLOBAL);
positions._test.reset();
s.prime_cache_all_admitted = await post(ADMIT_ALL);
s.warm_cache_cover_budget_denied = await post(COVER_BUDGET);
s.warm_cache_all_global_denied = await post(ALL_GLOBAL);
const blocked = (step) => !step.cover_provider_reached && step.status === 429;
observation.cold_cache_denied_reaches_no_provider = blocked(s.cold_cache_cover_budget_denied) && blocked(s.cold_cache_all_global_denied);
observation.warm_cache_denied_reaches_no_provider = blocked(s.warm_cache_cover_budget_denied) && blocked(s.warm_cache_all_global_denied);
observation.allowed_reaches_provider = s.prime_cache_all_admitted.cover_provider_reached && s.prime_cache_all_admitted.status === 200;
observation.cache_functional = s.prime_cache_all_admitted.positions_rpc > 0 && s.warm_cache_cover_budget_denied.positions_rpc === 0 && s.warm_cache_all_global_denied.positions_rpc === 0;
process.stdout.write(JSON.stringify(observation) + '\n');
process.exitCode = observation.cold_cache_denied_reaches_no_provider && observation.warm_cache_denied_reaches_no_provider && observation.allowed_reaches_provider && observation.cache_functional ? 0 : 1;
