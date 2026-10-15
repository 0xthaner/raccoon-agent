/*
	PRODUKTIONS-EXPERIMENT (15.10.2026), NUR fuer EINE freigegebene, leere Test-Safe:
	partitioniertes HttpOnly-Cookie statt des JS-lesbaren Safe-Bearers.

	  __Host-raccoon_safeapp=<dieselbe Contract-Sitzung>; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=None; Partitioned

	Aktiv NUR, wenn ALLE drei gelten:
	  SAFE_PARTITIONED_COOKIE_EXPERIMENT === 'true'
	  VERCEL_ENV === 'production'
	  die serverseitig bewiesene Contract-Wallet === SAFE_PARTITIONED_COOKIE_TEST_WALLET
	    (genau eine Adresse, 0x + 40 Hex; keine Liste, kein Platzhalter, kein Praefix)
	Sonst exakt das heutige Verhalten - hier byteweise gegen das Produktionsformat
	geprueft (feste Uhr). Der Bearer aller anderen Safes bleibt unveraendert.

	Diese Tests belegen das SERVER-Verhalten, nicht die Browser-Unterstuetzung.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hashMessage, isAddress, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { simChain, dualProviders, ownerSignature } from '../test-support/dual-rpc-sim.mjs';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';

process.env.APP_BASE_URL = 'https://coverraccoon.com';
process.env.DASHBOARD_SESSION_SECRET = 'safe-cookie-allowlist-secret-0123456789abcdef';
for (const k of ['SAFE_PARTITIONED_COOKIE_EXPERIMENT', 'SAFE_PARTITIONED_COOKIE_TEST_WALLET', 'VERCEL_ENV']) delete process.env[k];

const auth = await import('../src/dashboard-auth.mjs');
const cs = await import('../src/contract-signature.mjs');

const EOA = privateKeyToAccount(`0x${'09'.repeat(32)}`);
const TEST_SAFE = '0x5afe00000000000000000000000000000000f00f';
const CUSTOMER_SAFE = '0x5afe0000000000000000000000000000000c0c0c';
const SAFEAPP = '__Host-raccoon_safeapp';
const NOW = 1_800_000_000_000;

const KEYS = ['SAFE_PARTITIONED_COOKIE_EXPERIMENT', 'SAFE_PARTITIONED_COOKIE_TEST_WALLET', 'VERCEL_ENV'];
function withEnv(env, fn) {
	const before = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
	for (const k of KEYS) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
	const restore = () => { for (const k of KEYS) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } };
	return Promise.resolve().then(fn).finally(restore);
}
const ON = { SAFE_PARTITIONED_COOKIE_EXPERIMENT: 'true', VERCEL_ENV: 'production', SAFE_PARTITIONED_COOKIE_TEST_WALLET: TEST_SAFE };

function server({ revoked = () => false } = {}) {
	const history = [{ from: 0n, owners: ['b2'], threshold: 1 }];
	const { providers } = dualProviders(simChain({ head: 20_000_000n, safes: { [TEST_SAFE]: { history }, [CUSTOMER_SAFE]: { history } } }));
	const effects = { revokedWallets: [] };
	const source = readFileSync(new URL('../api/dashboard.mjs', import.meta.url), 'utf8').replace(/^import [^;]*;\n/gm, '').replace('export default async function handler', 'async function handler');
	const deps = {
		isAddress, queryParams, singleQueryValue, ...auth,
		verifyWalletSiweAuthority: (p) => cs.verifyWalletSiweAuthority(p, { providers }),
		verifyOnchainDashboardLoginApproval: (p) => cs.verifyOnchainDashboardLoginApproval(p, { providers }),
		noContractCodeByQuorum: (w) => cs.noContractCodeByQuorum(w, { providers }),
		isDeployedContract: async () => false,
		consumeDashboardChallenge: async () => true, isDashboardChallengeOpen: async () => true, storeDashboardChallenge: async () => {},
		getWalletCovers: async () => ({ covers: [] }), getWalletLinkStateByWallet: async () => ({ linked: false, link: null }),
		isDashboardSessionRevoked: async (wallet, iat) => revoked(wallet, iat), recordAgentEvent: async () => {}, consumeDashboardAccess: async () => null,
		getLanguage: async () => 'de', beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		revokeDashboardSessions: async (wallet) => { effects.revokedWallets.push(wallet); return Date.now(); },
		unlinkWalletByWallet: async () => [], unlinkWalletFromAllChats: async () => [],
		enforceRateLimit: async () => true, enforceRateLimitFor: async () => true, requireJson: () => true, requireSameOrigin: () => true,
		recordSecurityEvent: async () => {}, securityFingerprint: () => 'fp',
		SECURITY_EVENT: { SIWE_SIGNATURE_INVALID: 'invalid', SIWE_REPLAY_BLOCKED: 'replay', ERC1271_RPC_DISAGREEMENT: 'disagreement', ACCESS_CODE_INVALID: 'access' },
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}
	};
	return { handler: new Function(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps)), effects };
}
const response = () => ({ headers: {}, status(n) { this.code = n; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, json(b) { this.body = b; return this; } });
async function call(srv, req) { const res = response(); await srv.handler({ url: '/api/dashboard', ...req, headers: { 'content-type': 'application/json', ...(req.headers ?? {}) } }, res); return res; }
const cookies = (res) => { const h = res.headers['set-cookie']; return h === undefined ? [] : Array.isArray(h) ? h : [h]; };
const safeAppCookie = (res) => cookies(res).find((c) => c.startsWith(`${SAFEAPP}=`)) ?? null;
const valueOf = (c) => decodeURIComponent(c.slice(c.indexOf('=') + 1, c.indexOf(';')));
const tokensIn = (body) => { const out = []; const walk = (v) => { if (typeof v === 'string' && auth.verifyDashboardSession(v)) out.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); }; walk(body); return out; };

async function login(srv, wallet, transport) {
	const isSafe = wallet !== EOA.address;
	const real = Date.now; Date.now = () => NOW;
	try {
		const ch = auth.createDashboardChallenge(wallet, NOW, isSafe ? auth.DASHBOARD_CHALLENGE_TTL_CONTRACT_MS : auth.DASHBOARD_CHALLENGE_TTL_EOA_MS);
		const signature = isSafe ? ownerSignature(['b2'], hashMessage(ch.message)) : await EOA.signMessage({ message: ch.message });
		return await call(srv, { method: 'POST', headers: transport ? { 'x-dashboard-transport': transport } : {}, body: { wallet, token: ch.token, signature } });
	} finally { Date.now = real; }
}
/** Heutiges Produktionsverhalten, byteweise. */
function assertProductionLogin(res, wallet, kind, transport, label) {
	assert.equal(res.code, 200, `${label}: ${JSON.stringify(res.body)}`);
	assert.equal(res.headers['set-cookie'], auth.sessionCookieHeader(wallet, NOW, kind), `${label}: genau das Strict-Cookie`);
	const bearer = kind === 'contract' && transport === 'bearer' ? auth.createDashboardSession(wallet, NOW, 'contract') : undefined;
	assert.equal(res.body.sessionToken, bearer, `${label}: Bearer wie heute`);
}

/* ============================================ 1/2/6: unveraendert */

test('1 a NON-allowlisted (customer) Safe with the experiment fully on behaves exactly as production - bearer included', () => withEnv(ON, async () => {
	for (const transport of [undefined, 'bearer']) assertProductionLogin(await login(server(), CUSTOMER_SAFE, transport), CUSTOMER_SAFE, 'contract', transport, `customer ${transport}`);
}));

test('2 an EOA is unchanged - even if the allowlist were (mis)configured to the EOA address', async () => {
	for (const env of [ON, { ...ON, SAFE_PARTITIONED_COOKIE_TEST_WALLET: EOA.address }]) {
		await withEnv(env, async () => {
			for (const transport of [undefined, 'bearer']) assertProductionLogin(await login(server(), EOA.address, transport), EOA.address, 'eoa', transport, `eoa ${transport}`);
		});
	}
});

test('6 without the full activation (flag missing/not exactly "true", not production) the test Safe gets today\'s production behaviour', async () => {
	for (const env of [
		{ ...ON, SAFE_PARTITIONED_COOKIE_EXPERIMENT: undefined },
		{ ...ON, SAFE_PARTITIONED_COOKIE_EXPERIMENT: 'TRUE' },
		{ ...ON, SAFE_PARTITIONED_COOKIE_EXPERIMENT: '1' },
		{ ...ON, VERCEL_ENV: 'preview' },
		{ ...ON, VERCEL_ENV: undefined },
		{ ...ON, SAFE_PARTITIONED_COOKIE_TEST_WALLET: undefined }
	]) {
		await withEnv(env, async () => assertProductionLogin(await login(server(), TEST_SAFE, 'bearer'), TEST_SAFE, 'contract', 'bearer', JSON.stringify(env)));
	}
});

/* ========================================== 3/4/7: freigegebene Safe */

test('3/4/7 the allowlisted Safe (Safe-App flow) gets the partitioned cookie with exact attributes, NO bearer, and the value never in JSON', () => withEnv(ON, async () => {
	const res = await login(server(), TEST_SAFE, 'bearer');
	assert.equal(res.code, 200);
	const cookie = safeAppCookie(res);
	assert.ok(cookie, 'Safe-App-Cookie gesetzt');
	assert.deepEqual(cookie.split(';').slice(1).map((a) => a.trim()), ['Path=/', 'Max-Age=86400', 'Secure', 'HttpOnly', 'SameSite=None', 'Partitioned']);
	assert.equal(/domain=/i.test(cookie), false);
	assert.ok(cookies(res).includes(auth.sessionCookieHeader(TEST_SAFE, NOW, 'contract')), 'Strict-Cookie unveraendert daneben');
	const session = auth.verifyDashboardSession(valueOf(cookie));
	assert.equal(session.wallet, TEST_SAFE);
	assert.equal(session.kind, 'contract');
	assert.equal(session.iat, NOW, 'dasselbe Token, keine neue Laufzeit');
	assert.equal(session.exp - session.iat, auth.SESSION_TTL_CONTRACT_MS);
	assert.equal(res.body.sessionToken, undefined, 'kein Bearer fuer die Test-Safe');
	assert.deepEqual(tokensIn(res.body), []);
	assert.equal(JSON.stringify(res.body).includes(valueOf(cookie)), false);
}));

test('3 the allowlisted Safe without the Safe-App flow (no bearer request, e.g. WalletConnect) keeps the plain production cookie', () => withEnv(ON, async () => {
	assertProductionLogin(await login(server(), TEST_SAFE, undefined), TEST_SAFE, 'contract', undefined, 'test safe, no transport');
}));

test('3 checksummed allowlist configuration matches the same address (address identity, not string tricks)', () => withEnv({ ...ON, SAFE_PARTITIONED_COOKIE_TEST_WALLET: getAddress(TEST_SAFE) }, async () => {
	assert.ok(safeAppCookie(await login(server(), TEST_SAFE, 'bearer')));
}));

/* ======================================================= 5: falsche */

test('5 wrong configuration can never pull a customer Safe in: prefix, suffix, list, wildcard, whitespace, empty', async () => {
	for (const value of [TEST_SAFE.slice(0, -1), `${TEST_SAFE}0`, `${TEST_SAFE},${CUSTOMER_SAFE}`, `${CUSTOMER_SAFE},${TEST_SAFE}`, '*', '0x*', ` ${TEST_SAFE}`, `${TEST_SAFE}\n`, '', 'all']) {
		await withEnv({ ...ON, SAFE_PARTITIONED_COOKIE_TEST_WALLET: value }, async () => {
			for (const wallet of [TEST_SAFE, CUSTOMER_SAFE]) {
				assertProductionLogin(await login(server(), wallet, 'bearer'), wallet, 'contract', 'bearer', `${JSON.stringify(value)} ${wallet}`);
			}
		});
	}
});

test('5 the Safe-App cookie is only accepted for the allowlisted Safe: a cookie for another Safe, an EOA token under that name, or after the allowlist moved, is ignored', () => withEnv(ON, async () => {
	const srv = server();
	const asCookie = (token) => ({ cookie: `${SAFEAPP}=${encodeURIComponent(token)}` });
	const ok = await call(srv, { method: 'GET', headers: asCookie(auth.createDashboardSession(TEST_SAFE, Date.now(), 'contract')) });
	assert.equal(ok.code, 200, '6: das Cookie authentisiert einen lesenden Aufruf');
	assert.equal(ok.body.wallet, TEST_SAFE);
	for (const token of [auth.createDashboardSession(CUSTOMER_SAFE, Date.now(), 'contract'), auth.createDashboardSession(EOA.address, Date.now(), 'eoa')]) {
		assert.equal((await call(srv, { method: 'GET', headers: asCookie(token) })).code, 401);
	}
	await withEnv({ ...ON, SAFE_PARTITIONED_COOKIE_TEST_WALLET: CUSTOMER_SAFE }, async () => {
		assert.equal((await call(srv, { method: 'GET', headers: asCookie(auth.createDashboardSession(TEST_SAFE, Date.now(), 'contract')) })).code, 401);
	});
	await withEnv({ ...ON, SAFE_PARTITIONED_COOKIE_EXPERIMENT: undefined }, async () => {
		assert.equal((await call(srv, { method: 'GET', headers: asCookie(auth.createDashboardSession(TEST_SAFE, Date.now(), 'contract')) })).code, 401, 'Flag aus: Cookie wirkungslos');
	});
}));

test('5 conflicting credentials fail closed (Safe-App cookie for the test Safe + bearer/Strict cookie of another wallet)', () => withEnv(ON, async () => {
	const srv = server();
	const mine = encodeURIComponent(auth.createDashboardSession(TEST_SAFE, Date.now(), 'contract'));
	const other = auth.createDashboardSession(CUSTOMER_SAFE, Date.now(), 'contract');
	assert.equal((await call(srv, { method: 'GET', headers: { cookie: `${SAFEAPP}=${mine}`, authorization: `Bearer ${other}` } })).code, 401);
	assert.equal((await call(srv, { method: 'GET', headers: { cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(other)}; ${SAFEAPP}=${mine}` } })).code, 401);
}));

/* ==================================== 8: Widerruf, Ablauf, Destruktiv */

test('8 revoked and expired sessions are rejected through the Safe-App cookie', () => withEnv(ON, async () => {
	const revoked = await call(server({ revoked: () => true }), { method: 'GET', headers: { cookie: `${SAFEAPP}=${encodeURIComponent(auth.createDashboardSession(TEST_SAFE, Date.now(), 'contract'))}` } });
	assert.equal(revoked.code, 401);
	assert.equal(revoked.body.code, 'SESSION_REVOKED');
	const old = auth.createDashboardSession(TEST_SAFE, Date.now() - auth.SESSION_TTL_CONTRACT_MS - 1000, 'contract');
	assert.equal((await call(server(), { method: 'GET', headers: { cookie: `${SAFEAPP}=${encodeURIComponent(old)}` } })).code, 401);
}));

test('8 destructive actions with only the Safe-App cookie still need fresh Safe authority; logout clears the Safe-App cookie', () => withEnv(ON, async () => {
	const srv = server();
	const cookie = `${SAFEAPP}=${encodeURIComponent(auth.createDashboardSession(TEST_SAFE, Date.now(), 'contract'))}`;
	assert.equal((await call(srv, { method: 'POST', headers: { cookie }, body: { action: 'session-revoke' } })).body.freshSignatureRequired, true);
	const disconnect = await call(srv, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: { cookie }, body: {} });
	assert.equal(disconnect.code, 403);
	const logout = await call(srv, { method: 'DELETE', headers: { cookie }, body: {} });
	assert.equal(logout.body.revoked, false);
	assert.deepEqual(srv.effects.revokedWallets, []);
	assert.ok(cookies(logout).includes(`${SAFEAPP}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None; Partitioned`));
}));

test('8 a normal user\'s logout with the experiment ON clears exactly the production cookie list (no extra header)', () => withEnv(ON, async () => {
	for (const token of [auth.createDashboardSession(EOA.address, Date.now(), 'eoa'), auth.createDashboardSession(CUSTOMER_SAFE, Date.now(), 'contract')]) {
		const logout = await call(server(), { method: 'DELETE', headers: { cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}` } });
		assert.deepEqual(logout.headers['set-cookie'], auth.CLEAR_SESSION_COOKIES);
	}
}));
