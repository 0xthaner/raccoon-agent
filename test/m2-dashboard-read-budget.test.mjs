/*
	Restaudit M2, 16.10.2026 - der authentisierte Dashboard-Lesepfad ist begrenzt.

	Gegen den ECHTEN Handler (api/dashboard.mjs) und die ECHTE Rate-Limit-Logik aus
	src/http-security.mjs (HMAC-Schluessel, 429, Retry-After, Sicherheitsereignis).
	Ersetzt ist nur der Zaehler in der Datenbank (check_agent_rate_limit: jeder
	Aufruf zaehlt, erlaubt solange <= max) und der Cover-Provider, der jede echte
	Abfrage mitzaehlt. Jede "Instanz" ist eine frische Auswertung des Handlers mit
	eigenem In-Memory-Cache; alle teilen denselben Zaehler - wie Serverless-Instanzen
	hinter wechselnden IPs.
*/
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { simChain, dualProviders } from '../test-support/dual-rpc-sim.mjs';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';

process.env.APP_BASE_URL = 'https://coverraccoon.com';
process.env.DASHBOARD_SESSION_SECRET = 'm2-dashboard-read-budget-secret-0123456789abcdef';

const auth = await import('../src/dashboard-auth.mjs');
const cs = await import('../src/contract-signature.mjs');
const { siweOrigin } = await import('../src/siwe-auth.mjs');

const SECURITY_EVENT = { RATE_LIMIT_BLOCKED: 'security.rate_limit_blocked', SIWE_SIGNATURE_INVALID: 'invalid', SIWE_REPLAY_BLOCKED: 'replay', ERC1271_RPC_DISAGREEMENT: 'disagreement', ACCESS_CODE_INVALID: 'access' };
const strip = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/^import [^;]*;\n/gm, '');

/** Gemeinsamer Zaehler (= Datenbank) + Ereignisse + Provider-Zaehler. */
function backend() {
	const counts = new Map();
	const events = [];
	const providerCalls = [];
	const store = {
		counts, events, providerCalls, fail: new Set(), delayMs: 0,
		checkRateLimit: async (key, max) => { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return n <= max; },
		scopeCount: (scope) => [...counts].filter(([k]) => k.startsWith(`${scope}:`)).reduce((sum, [, n]) => sum + n, 0)
	};
	const httpSecurity = new Function('createHmac', 'checkRateLimit', 'dashboardSecretConfigured', 'siweOrigin', 'recordSecurityEvent', 'SECURITY_EVENT',
		`${strip('src/http-security.mjs').replace(/^export /gm, '')}\nreturn { enforceRateLimit, enforceRateLimitFor, requireJson, requireSameOrigin };`)(
		createHmac, store.checkRateLimit, auth.dashboardSecretConfigured, siweOrigin, async (type, meta) => { events.push({ type, ...meta }); }, SECURITY_EVENT);
	store.http = httpSecurity;
	return store;
}

const OWNER = privateKeyToAccount(`0x${'0b'.repeat(32)}`);
const SAFE = '0x5afe00000000000000000000000000000000d00d';
const chain = () => simChain({ head: 20_000_000n, safes: { [SAFE]: { history: [{ from: 0n, owners: ['b2'], threshold: 1 }] } } });

/** Eine Serverless-Instanz: frischer Handler (eigener Cache), gemeinsames Backend. */
function instance(be) {
	const { providers } = dualProviders(chain());
	const deps = {
		isAddress, queryParams, singleQueryValue, ...auth,
		verifyWalletSiweAuthority: (params) => cs.verifyWalletSiweAuthority(params, { providers }),
		verifyOnchainDashboardLoginApproval: (params) => cs.verifyOnchainDashboardLoginApproval(params, { providers }),
		noContractCodeByQuorum: (wallet) => cs.noContractCodeByQuorum(wallet, { providers }),
		isDeployedContract: async () => false,
		consumeDashboardChallenge: async () => true, isDashboardChallengeOpen: async () => true, storeDashboardChallenge: async () => {},
		getWalletCovers: async (wallet) => {
			be.providerCalls.push(wallet);
			if (be.delayMs) await new Promise((resolve) => setTimeout(resolve, be.delayMs));
			if (be.fail.has(wallet)) throw new Error('provider down: internal-detail');
			return { covers: [{ coverId: parseInt(wallet.slice(-4), 16), productId: 1, productName: `P-${wallet.slice(-4)}`, status: 'active', amount: '1', asset: { symbol: 'ETH' }, endsAt: '2027-01-01T00:00:00.000Z' }] };
		},
		getWalletLinkStateByWallet: async () => ({ linked: false, link: null }),
		isDashboardSessionRevoked: async () => false, recordAgentEvent: async () => {}, consumeDashboardAccess: async () => null,
		getLanguage: async () => 'de', beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		revokeDashboardSessions: async () => Date.now(), unlinkWalletByWallet: async () => [], unlinkWalletFromAllChats: async () => [],
		...be.http,
		recordSecurityEvent: async (type) => { be.events.push({ type }); }, securityFingerprint: () => 'fp', SECURITY_EVENT,
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}
	};
	const source = strip('api/dashboard.mjs').replace('export default async function handler', 'async function handler');
	return new Function(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps));
}

const response = () => ({ headers: {}, status(n) { this.code = n; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, json(b) { this.body = b; return this; } });
let ipCounter = 0;
const freshIp = () => `198.51.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
const wallet = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const eoaCookie = (w) => ({ cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(w, Date.now(), 'eoa'))}` });
const safeCookie = (w) => ({ cookie: `${auth.SAFEAPP_COOKIE}=${encodeURIComponent(auth.createDashboardSession(w, Date.now(), 'contract'))}` });
async function read(handler, headers = {}, { ip = freshIp(), url = '/api/dashboard' } = {}) {
	const res = response();
	await handler({ method: 'GET', url, headers: { 'x-forwarded-for': ip, ...headers } }, res);
	return res;
}

/* ================================================================ A / B */

test('A: a normal authenticated dashboard GET works and makes exactly one provider lookup', async () => {
	const be = backend();
	const res = await read(instance(be), eoaCookie(wallet(1)));
	assert.equal(res.code, 200, JSON.stringify(res.body));
	assert.equal(res.body.wallet, wallet(1));
	assert.equal(res.body.covers.length, 1);
	assert.deepEqual(be.providerCalls, [wallet(1)]);
	assert.equal(be.scopeCount('dashboard-read-wallet'), 1);
	assert.equal(be.scopeCount('dashboard-read-global'), 1);
});

test('B: without a session the request fails before any provider work or read budget', async () => {
	const be = backend();
	for (const headers of [{}, { cookie: `${auth.SESSION_COOKIE}=garbage` }]) {
		const res = await read(instance(be), headers);
		assert.equal(res.code, 401);
	}
	assert.deepEqual(be.providerCalls, []);
	assert.equal(be.scopeCount('dashboard-read-wallet') + be.scopeCount('dashboard-read-global'), 0);
});

/* ============================================================ C / E / L */

for (const [label, cookieFor, w] of [['EOA', eoaCookie, wallet(2)], ['Safe (Q)', safeCookie, SAFE]]) {
	test(`C + E + L (${label}): the per-wallet budget (30 / 10 min) blocks lookup 31 BEFORE the provider - also with a new IP and a new instance each time`, async () => {
		const be = backend();
		for (let i = 0; i < 30; i++) assert.equal((await read(instance(be), cookieFor(w))).code, 200, `Abfrage ${i + 1}`);
		const denied = await read(instance(be), cookieFor(w));
		assert.equal(denied.code, 429);
		assert.equal(denied.headers['retry-after'], '600', 'L: Retry-After');
		assert.deepEqual(Object.keys(denied.body).sort(), ['error', 'ok']);
		assert.doesNotMatch(JSON.stringify(denied.body), /dashboard-read|0x|\d{2,}/, 'keine Schluessel, Zaehler oder Wallets');
		assert.equal(be.providerCalls.length, 30, 'keine 31. Provider-Abfrage');
		const blocked = be.events.filter((e) => e.type === SECURITY_EVENT.RATE_LIMIT_BLOCKED);
		assert.deepEqual(blocked.map((e) => e.scope), ['dashboard-read-wallet']);
		assert.match(blocked[0].fingerprint, /^[0-9a-f]{12}$/, 'nur HMAC-Fingerprint');
		assert.doesNotMatch(JSON.stringify(blocked), new RegExp(w.slice(2), 'i'), 'keine rohe Wallet');
		assert.equal(be.scopeCount('dashboard-read-global'), 30, 'abgelehnte Wallet verbraucht kein globales Budget');
	});
}

test('the budget key is the SESSION wallet: a query wallet never changes whose budget is used', async () => {
	const be = backend();
	for (let i = 0; i < 30; i++) await read(instance(be), eoaCookie(wallet(3)));
	// GET mit ?wallet= ist der Challenge-Pfad, kein Datenpfad; und ein fremder Body zaehlt im GET nicht.
	const res = await read(instance(be), eoaCookie(wallet(3)), { url: `/api/dashboard?foo=${wallet(4)}` });
	assert.equal(res.code, 429);
	assert.equal(be.providerCalls.filter((x) => x === wallet(4)).length, 0);
});

/* ================================================================ D / F */

test('D + F: the global budget (300 / 10 min) caps lookups across many wallets and IPs, BEFORE the provider', async () => {
	const be = backend();
	for (let i = 0; i < 300; i++) assert.equal((await read(instance(be), eoaCookie(wallet(1000 + i)))).code, 200);
	const denied = await read(instance(be), eoaCookie(wallet(5000)));
	assert.equal(denied.code, 429);
	assert.equal(denied.headers['retry-after'], '600');
	assert.equal(be.providerCalls.length, 300);
	assert.ok(!be.providerCalls.includes(wallet(5000)));
	assert.equal(be.events.at(-1).scope, 'dashboard-read-global');
});

/* ======================================================== G / H / I / J */

test('G: a cache hit for the same wallet makes no further provider call and consumes no budget', async () => {
	const be = backend();
	const handler = instance(be);
	for (let i = 0; i < 5; i++) assert.equal((await read(handler, eoaCookie(wallet(6)))).code, 200);
	assert.equal(be.providerCalls.length, 1);
	assert.equal(be.scopeCount('dashboard-read-wallet'), 1);
});

test('G2 + L3: a still-valid cache entry is served even when the budget is exhausted (no provider work)', async () => {
	const be = backend();
	const warm = instance(be);
	assert.equal((await read(warm, eoaCookie(wallet(7)))).code, 200);
	for (let i = 0; i < 29; i++) await read(instance(be), eoaCookie(wallet(7)));
	assert.equal((await read(instance(be), eoaCookie(wallet(7)))).code, 429, 'kalte Instanz: Budget leer');
	const cached = await read(warm, eoaCookie(wallet(7)));
	assert.equal(cached.code, 200, 'warme Instanz: Cache-Treffer');
	assert.equal(be.providerCalls.length, 30);
});

test('H: the cache never serves wallet A data to wallet B (EOA and Safe)', async () => {
	const be = backend();
	const handler = instance(be);
	const a = await read(handler, eoaCookie(wallet(0xaaaa)));
	const b = await read(handler, eoaCookie(wallet(0xbbbb)));
	const s = await read(handler, safeCookie(SAFE));
	assert.equal(a.body.covers[0].coverId, 0xaaaa);
	assert.equal(b.body.covers[0].coverId, 0xbbbb);
	assert.equal(b.body.wallet, wallet(0xbbbb));
	assert.equal(s.body.covers[0].productName, `P-${SAFE.slice(-4)}`);
	assert.deepEqual(be.providerCalls, [wallet(0xaaaa), wallet(0xbbbb), SAFE]);
});

test('I: an expired cache entry (TTL 20 s) triggers a fresh, budgeted provider lookup', async (t) => {
	mock.timers.enable({ apis: ['Date'], now: Date.now() });
	t.after(() => mock.timers.reset());
	const be = backend();
	const handler = instance(be);
	await read(handler, eoaCookie(wallet(8)));
	mock.timers.tick(19_999);
	await read(handler, eoaCookie(wallet(8)));
	assert.equal(be.providerCalls.length, 1, 'noch gueltig');
	mock.timers.tick(2);
	await read(handler, eoaCookie(wallet(8)));
	assert.equal(be.providerCalls.length, 2, 'abgelaufen: neue Abfrage');
	assert.equal(be.scopeCount('dashboard-read-wallet'), 2);
});

test('J: a provider failure is never cached; the next request retries and gets fresh data', async () => {
	const be = backend();
	const handler = instance(be);
	be.fail.add(wallet(9));
	await assert.rejects(read(handler, eoaCookie(wallet(9))), /provider down/);
	be.fail.delete(wallet(9));
	const res = await read(handler, eoaCookie(wallet(9)));
	assert.equal(res.code, 200);
	assert.equal(res.body.covers.length, 1);
	assert.equal(be.providerCalls.length, 2, 'Fehler nicht gecacht');
});

/* ================================================================== K */

test('K: concurrent same-wallet reads in one instance share ONE provider call and ONE budget unit; failure clears the in-flight entry', async () => {
	const be = backend();
	be.delayMs = 30;
	const handler = instance(be);
	const results = await Promise.all(Array.from({ length: 6 }, () => read(handler, eoaCookie(wallet(10)))));
	assert.deepEqual(results.map((r) => r.code), [200, 200, 200, 200, 200, 200]);
	assert.equal(be.providerCalls.length, 1);
	assert.equal(be.scopeCount('dashboard-read-wallet'), 1);

	be.fail.add(wallet(11));
	const failing = await Promise.allSettled(Array.from({ length: 3 }, () => read(handler, eoaCookie(wallet(11)))));
	assert.deepEqual(failing.map((r) => r.status), ['rejected', 'rejected', 'rejected']);
	be.fail.delete(wallet(11));
	assert.equal((await read(handler, eoaCookie(wallet(11)))).code, 200, 'nach dem Fehler kein haengender Eintrag');
	assert.equal(be.providerCalls.filter((x) => x === wallet(11)).length, 2);
});

test('L2: a request that joined a lookup which was then denied also gets 429 + Retry-After, without its own lookup', async () => {
	const be = backend();
	for (let i = 0; i < 30; i++) await read(instance(be), eoaCookie(wallet(12)));
	const handler = instance(be);
	const results = await Promise.all(Array.from({ length: 3 }, () => read(handler, eoaCookie(wallet(12)))));
	assert.deepEqual(results.map((r) => r.code), [429, 429, 429]);
	for (const r of results) assert.equal(r.headers['retry-after'], '600');
	assert.equal(be.providerCalls.length, 30);
	assert.equal(be.scopeCount('dashboard-read-wallet'), 31, 'nur EINE weitere Budget-Anfrage fuer alle drei');
});

/* ================================================================ M / N / O */

async function login(handler, ip = freshIp()) {
	const challenge = auth.createDashboardChallenge(OWNER.address);
	const signature = await OWNER.signMessage({ message: challenge.message });
	const res = response();
	await handler({ method: 'POST', url: '/api/dashboard', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: { wallet: OWNER.address, token: challenge.token, signature } }, res);
	return res;
}

test('M + N: login still works and returns data; it uses the unchanged login budgets, not the read budgets - even when the read budget is exhausted', async () => {
	const be = backend();
	const w = OWNER.address.toLowerCase();
	for (let i = 0; i < 30; i++) await read(instance(be), eoaCookie(w));
	assert.equal((await read(instance(be), eoaCookie(w))).code, 429);
	const res = await login(instance(be));
	assert.equal(res.code, 200, JSON.stringify(res.body));
	assert.equal(res.body.covers.length, 1);
	assert.match(String(res.headers['set-cookie']), /__Host-raccoon_dashboard=/);
	assert.equal(be.scopeCount('dashboard-read-wallet'), 31, 'Login zaehlt nicht ins Lese-Budget');
	for (const scope of ['dashboard-login', 'dashboard-login-wallet', 'dashboard-login-global']) assert.equal(be.scopeCount(scope), 1, scope);
	// N: die Login-Grenzen selbst sind unveraendert (10 je Wallet in 10 Minuten).
	for (let i = 0; i < 9; i++) assert.equal((await login(instance(be))).code, 200, `Login ${i + 2}`);
	assert.equal((await login(instance(be))).code, 429, 'elfter Login derselben Wallet');
});

test('O: logout (DELETE) is unchanged and does not touch the read budgets or the provider', async () => {
	const be = backend();
	const res = response();
	await instance(be)({ method: 'DELETE', url: '/api/dashboard', headers: { 'x-forwarded-for': freshIp(), origin: 'https://coverraccoon.com', ...eoaCookie(wallet(13)) } }, res);
	assert.equal(res.code, 200, JSON.stringify(res.body));
	assert.equal(be.scopeCount('dashboard-read-wallet') + be.scopeCount('dashboard-read-global'), 0);
	assert.deepEqual(be.providerCalls, []);
});
