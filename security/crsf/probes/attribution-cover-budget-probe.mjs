/*
	CRSF evidence probe EV-PROBE-ATTRIB-COVERS (finding F-2H-1, CRSF Phase 2H).

	Question: does POST /api/position-attributions reach the cover provider
	lookup (getWalletCovers: Alchemy NFT index, Nexus, getCovers RPC) when every
	GLOBAL budget is exhausted?

	Real code: api/position-attributions.mjs (createAttributionsHandler), the
	request guards of src/http-security.mjs (enforceRateLimit[For]), the session
	check of src/dashboard-auth.mjs and getWalletPositions of
	src/positions/index.mjs with its real in-memory cache. Stubs: the limiter
	store (records keys; admits per-IP and per-wallet keys, denies every global
	key in the second step), the chain client for positions (answers nothing,
	so the market read is UNAVAILABLE and cached for FAILURE_TTL_MS like any
	failed lookup), the cover lookup (a counter) and the database rows.
	Offline, no keys. Prints one JSON line.

	Exit 0 only while the recorded defect is observed (with all global budgets
	denied, a request still reaches the cover provider) AND the control behaves
	normally (with positions NOT cached, the denied global positions budget
	stops the request before any provider work). Once fixed this probe exits 1
	and the VIOLATION record in evidence.json must be revisited.
*/
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

process.env.DASHBOARD_SESSION_SECRET = 'crsf-probe-attrib-covers-secret-0123456789ab';
process.env.APP_BASE_URL = 'https://coverraccoon.com';
const auth = await import('../../../src/dashboard-auth.mjs');
const { siweOrigin } = await import('../../../src/siwe-auth.mjs');
const positions = await import('../../../src/positions/index.mjs');
const { createAttributionsHandler } = await import('../../../api/position-attributions.mjs');

const WALLET = '0x' + 'a1'.repeat(20);
const strip = (file) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8').replace(/^import [^;]*;\n/gm, '');
const SECURITY_EVENT = new Proxy({}, { get: (_t, k) => String(k) });
const silentClient = { getBlockNumber: async () => { throw new Error('offline probe'); } };

function world(denyGlobal) {
	const trace = [];
	const checkRateLimit = async (key) => { const scope = key.split(':')[0]; const admitted = !(denyGlobal && /-global$/.test(scope)); trace.push(`limit ${scope} ${admitted ? 'admit' : 'DENY'}`); return admitted; };
	const http = new Function('createHmac', 'checkRateLimit', 'dashboardSecretConfigured', 'siweOrigin', 'recordSecurityEvent', 'SECURITY_EVENT',
		`${strip('src/http-security.mjs').replace(/^export /gm, '')}\nreturn { enforceRateLimit, enforceRateLimitFor, requireJson, requireSameOrigin };`)(
		createHmac, checkRateLimit, auth.dashboardSecretConfigured, siweOrigin, async () => {}, SECURITY_EVENT);
	const handler = createAttributionsHandler({
		getPositions: (wallet, options) => { trace.push('positions'); return positions.getWalletPositions(wallet, { ...options, client: silentClient }); },
		getCovers: async () => { trace.push('PROVIDER covers'); return { covers: [] }; },
		listRows: async () => [], upsertRow: async () => { trace.push('DB upsert'); return null; }, deleteRow: async () => 0, deleteStaleRow: async () => 0,
		isRevoked: async () => false, rateLimit: http.enforceRateLimit, rateLimitFor: http.enforceRateLimitFor, sameOrigin: http.requireSameOrigin, json: http.requireJson
	});
	return { handler, trace };
}
const cookie = `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(WALLET, Date.now(), 'eoa'))}`;
async function post(denyGlobal) {
	const w = world(denyGlobal);
	const r = { code: null, headersSent: false, setHeader() {}, status(c) { this.code = c; return this; }, json() { this.headersSent = true; return this; } };
	await w.handler({ method: 'POST', url: '/api/position-attributions', body: { deploymentKey: 'aave-v3-ethereum-core', coverId: 1 },
		headers: { cookie, origin: 'https://coverraccoon.com', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': '50', 'x-forwarded-for': '198.51.100.41' } }, r);
	return { status: r.code, trace: w.trace, cover_provider_reached: w.trace.includes('PROVIDER covers'), global_denied: w.trace.some((t) => /-global DENY$/.test(t)) };
}

positions._test.reset();
const observation = { question: 'F-2H-1', steps: {} };
observation.steps.control_cold_cache_global_denied = await post(true);
observation.steps.prime_cache_all_admitted = await post(false);
observation.steps.warm_cache_global_denied = await post(true);
const s = observation.steps;
observation.controls_ok = !s.control_cold_cache_global_denied.cover_provider_reached && s.control_cold_cache_global_denied.status === 429 && s.prime_cache_all_admitted.cover_provider_reached;
observation.cover_lookup_without_global_budget = s.warm_cache_global_denied.cover_provider_reached && !s.warm_cache_global_denied.global_denied;
process.stdout.write(JSON.stringify(observation) + '\n');
process.exitCode = observation.controls_ok && observation.cover_lookup_without_global_budget ? 0 : 1;
