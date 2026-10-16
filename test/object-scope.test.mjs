/**
 * Objekt-Autorisierung der Lesepfade (CRSF Phase 2C, CR-API-001 P1/P2).
 *
 * Gegen den ECHTEN Dashboard-Handler (api/dashboard.mjs, Ladeweise wie
 * m2-dashboard-read-budget.test.mjs) und den ECHTEN Positions-Handler. Sitzung =
 * Wallet A. Jeder clientseitige Hinweis auf Wallet B (Header, Query, Body, ein
 * zweites, nicht autoritatives Cookie) darf NICHTS daran aendern, wessen Daten
 * gelesen werden: Provider-, Link-Status- und Positionsabfragen sehen nur A, die
 * Antwort nennt B nie.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { isAddress } from 'viem';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';

process.env.APP_BASE_URL = 'https://coverraccoon.com';
process.env.DASHBOARD_SESSION_SECRET = 'object-scope-test-secret-0123456789abcdef-0123';

const auth = await import('../src/dashboard-auth.mjs');
const { siweOrigin } = await import('../src/siwe-auth.mjs');
const { createPositionsHandler } = await import('../api/positions.mjs');

const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);
const SECURITY_EVENT = { RATE_LIMIT_BLOCKED: 'rl', SIWE_SIGNATURE_INVALID: 'invalid', SIWE_REPLAY_BLOCKED: 'replay', ERC1271_RPC_DISAGREEMENT: 'disagreement', ACCESS_CODE_INVALID: 'access' };
const strip = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/^import [^;]*;\n/gm, '');

function dashboardHandler(seen) {
	const http = new Function('createHmac', 'checkRateLimit', 'dashboardSecretConfigured', 'siweOrigin', 'recordSecurityEvent', 'SECURITY_EVENT',
		`${strip('src/http-security.mjs').replace(/^export /gm, '')}\nreturn { enforceRateLimit, enforceRateLimitFor, requireJson, requireSameOrigin };`)(
		createHmac, async () => true, auth.dashboardSecretConfigured, siweOrigin, async () => {}, SECURITY_EVENT);
	const deps = {
		isAddress, queryParams, singleQueryValue, ...auth,
		verifyWalletSiweAuthority: async () => ({ result: 'INVALID_SIGNATURE', authority: null }),
		verifyOnchainDashboardLoginApproval: async () => 'RPC_UNAVAILABLE', noContractCodeByQuorum: async () => true, isDeployedContract: async () => false,
		consumeDashboardChallenge: async () => false, isDashboardChallengeOpen: async () => false, storeDashboardChallenge: async () => {},
		getWalletCovers: async (wallet) => { seen.covers.push(wallet); return { covers: [] }; },
		getWalletLinkStateByWallet: async (wallet) => { seen.linkState.push(wallet); return { linked: false, link: null }; },
		isDashboardSessionRevoked: async (wallet) => { seen.revocation.push(wallet); return false; },
		recordAgentEvent: async () => {}, consumeDashboardAccess: async () => null, getLanguage: async () => 'de',
		beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {}, revokeDashboardSessions: async () => Date.now(),
		unlinkWalletByWallet: async () => [], unlinkWalletFromAllChats: async () => [], ...http,
		recordSecurityEvent: async () => {}, securityFingerprint: () => 'fp', SECURITY_EVENT, ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}
	};
	const source = strip('api/dashboard.mjs').replace('export default async function handler', 'async function handler');
	return new Function(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps));
}
const response = () => ({ headers: {}, status(n) { this.code = n; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, json(b) { this.body = b; return this; } });
const sessionCookie = (w) => `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(w, Date.now(), 'eoa'))}`;
const HINTS = { 'x-wallet': B, 'x-dashboard-wallet': B, 'x-session-wallet': B, 'x-forwarded-user': B };

test('SCOPE-DASHBOARD: the session wallet alone decides whose dashboard is read (control: A gets A)', async () => {
	const seen = { covers: [], linkState: [], revocation: [] };
	const res = response();
	await dashboardHandler(seen)({ method: 'GET', url: '/api/dashboard', headers: { 'x-forwarded-for': '198.51.100.1', cookie: sessionCookie(A) } }, res);
	assert.equal(res.code, 200, JSON.stringify(res.body));
	assert.equal(res.body.wallet, A);
	assert.deepEqual(seen.covers, [A]);
	assert.deepEqual(seen.linkState, [A]);
});

test('SCOPE-DASHBOARD: identity hints for wallet B in headers, query or body never retarget the read', async () => {
	const variants = {
		headers: { url: '/api/dashboard', headers: HINTS },
		'query foo=B': { url: `/api/dashboard?foo=${B}`, headers: {} },
		'body wallet B': { url: '/api/dashboard', headers: {}, body: { wallet: B, session: B } },
		'all at once': { url: `/api/dashboard?foo=${B}`, headers: HINTS, body: { wallet: B } }
	};
	for (const [label, v] of Object.entries(variants)) {
		const seen = { covers: [], linkState: [], revocation: [] };
		const res = response();
		await dashboardHandler(seen)({ method: 'GET', url: v.url, headers: { 'x-forwarded-for': '198.51.100.2', cookie: sessionCookie(A), ...v.headers }, body: v.body }, res);
		assert.equal(res.code, 200, `${label}: ${JSON.stringify(res.body)}`);
		assert.equal(res.body.wallet, A, label);
		assert.deepEqual([...seen.covers, ...seen.linkState, ...seen.revocation].filter((w) => w.toLowerCase() === B), [], `${label}: no lookup for B`);
		assert.doesNotMatch(JSON.stringify(res.body), new RegExp(B.slice(2), 'i'), `${label}: B never appears in the response`);
	}
});

test('SCOPE-DASHBOARD: a valid session of B in a non-authority place (Bearer, foreign cookie name) does not grant B', async () => {
	const seen = { covers: [], linkState: [], revocation: [] };
	const tokenB = auth.createDashboardSession(B, Date.now(), 'eoa');
	const res = response();
	await dashboardHandler(seen)({ method: 'GET', url: '/api/dashboard', headers: { 'x-forwarded-for': '198.51.100.3', cookie: `${sessionCookie(A)}; raccoon_dashboard=${encodeURIComponent(tokenB)}`, authorization: `Bearer ${tokenB}` } }, res);
	assert.equal(res.code, 200);
	assert.equal(res.body.wallet, A);
	assert.deepEqual(seen.covers, [A]);
});

function positionsHandler(calls) {
	return createPositionsHandler({
		getPositions: async (wallet) => { calls.push(wallet); return { ok: true, wallet, complete: true, positions: [], checkedDeployments: [] }; },
		isRevoked: async () => false, rateLimit: async () => true, rateLimitFor: async () => true
	});
}
const posResponse = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.code = n; return this; }, json(b) { this.body = b; return this; } });

test('SCOPE-POSITIONS: positions are read for the session wallet only, whatever the client claims', async () => {
	const calls = [];
	const h = positionsHandler(calls);
	const ok = posResponse();
	await h({ method: 'GET', url: '/api/positions', headers: { cookie: sessionCookie(A), ...HINTS }, body: { wallet: B } }, ok);
	assert.equal(ok.code, 200);
	assert.equal(ok.body.wallet, A);
	for (const url of [`/api/positions?wallet=${B}`, `/api/positions?Wallet=${B}`, `/api/positions?foo=${B}`]) {
		const r = posResponse();
		await h({ method: 'GET', url, headers: { cookie: sessionCookie(A) } }, r);
		assert.equal(r.code, 400, url);
	}
	assert.deepEqual(calls, [A], 'exactly one lookup, for A');
});

test('SCOPE-POSITIONS: without a session nothing is read, even with a wallet hint', async () => {
	const calls = [];
	const r = posResponse();
	await positionsHandler(calls)({ method: 'GET', url: '/api/positions', headers: HINTS }, r);
	assert.equal(r.code, 401);
	assert.deepEqual(calls, []);
});
