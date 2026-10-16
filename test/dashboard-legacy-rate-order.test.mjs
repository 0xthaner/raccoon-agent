/**
 * F-2F-1 (CRSF Phase 2G, CR-RESOURCE-001 P1): auf den Aktionspfaden des
 * Dashboards greifen IP-, Wallet- und globale Schranke VOR jeder Provider-Arbeit.
 *
 * Provider-Arbeit entsteht dort nur fuer Alt-Sitzungen ohne `kind`:
 * freshAuthorityRequired -> noContractCodeByQuorum -> eth_getCode bei Alchemy
 * UND Infura. Echt laufen: der Handler api/dashboard.mjs, die Request-Schranken
 * aus src/http-security.mjs und noContractCodeByQuorum aus
 * src/contract-signature.mjs auf zwei Draht-Providern (offline, je ein
 * Anfragezaehler). Ersetzt sind nur der Zaehlerspeicher des Rate-Limiters (er
 * lehnt gezielt einen Schluessel ab) und die Datenbank (Spione fuer jede
 * zerstoerende Wirkung).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { isAddress } from 'viem';
import { wireProvider, rpcResult } from '../test-support/rpc-wire.mjs';

process.env.DASHBOARD_SESSION_SECRET = 'legacy-rate-order-secret-0123456789abcdef-01';
process.env.APP_BASE_URL = 'https://coverraccoon.com';
const auth = await import('../src/dashboard-auth.mjs');
const { siweOrigin } = await import('../src/siwe-auth.mjs');
const { queryParams, singleQueryValue } = await import('../src/request-query.mjs');
const { noContractCodeByQuorum } = await import('../src/contract-signature.mjs');

const WALLET = '0x' + 'a1'.repeat(20);
const SAFE_CODE = '0x608060405234801561001057600080fd5b50';
const strip = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/^import [^;]*;\n/gm, '');
const SECURITY_EVENT = new Proxy({}, { get: (_t, k) => String(k) });
const DESTRUCTIVE = ['storeDashboardChallenge', 'revokeDashboardSessions', 'unlinkWalletByWallet', 'unlinkWalletFromAllChats'];

/**
 * deny: Schluessel-Praefix (Scope), den der Limiter ablehnt; code: eth_getCode-Antwort beider Provider.
 */
function world({ deny = null, code = SAFE_CODE } = {}) {
	const limits = [];
	const calls = [];
	const spy = (name, value) => async () => { calls.push(name); return value; };
	const checkRateLimit = async (key) => { const scope = key.split(':')[0]; limits.push(scope); return scope !== deny; };
	const http = new Function('createHmac', 'checkRateLimit', 'dashboardSecretConfigured', 'siweOrigin', 'recordSecurityEvent', 'SECURITY_EVENT',
		`${strip('src/http-security.mjs').replace(/^export /gm, '')}\nreturn { enforceRateLimit, enforceRateLimitFor, requireJson, requireSameOrigin };`)(
		createHmac, checkRateLimit, auth.dashboardSecretConfigured, siweOrigin, async () => {}, SECURITY_EVENT);
	const alchemy = wireProvider(rpcResult(code));
	const infura = wireProvider(rpcResult(code), { url: 'https://mainnet.infura.io/v3/offline' });
	const deps = {
		isAddress, queryParams, singleQueryValue, ...auth, ...http,
		noContractCodeByQuorum: (wallet) => noContractCodeByQuorum(wallet, { providers: { alchemy: alchemy.client, infura: infura.client } }),
		verifyWalletSiweAuthority: async () => { calls.push('verifyWalletSiweAuthority'); return { result: 'INVALID_SIGNATURE', authority: null }; },
		verifyOnchainDashboardLoginApproval: async () => 'RPC_UNAVAILABLE', isDeployedContract: async () => false,
		getWalletCovers: async () => ({ covers: [] }), getWalletLinkStateByWallet: async () => ({ linked: false, link: null }),
		isDashboardSessionRevoked: async () => false, consumeDashboardChallenge: async () => false, isDashboardChallengeOpen: async () => false,
		storeDashboardChallenge: spy('storeDashboardChallenge'), revokeDashboardSessions: spy('revokeDashboardSessions', Date.now()),
		unlinkWalletByWallet: spy('unlinkWalletByWallet', []), unlinkWalletFromAllChats: spy('unlinkWalletFromAllChats', []),
		consumeDashboardAccess: async () => null, recordAgentEvent: async () => {}, getLanguage: async () => 'de',
		beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}, recordSecurityEvent: async () => {}, securityFingerprint: () => 'fp', SECURITY_EVENT
	};
	const source = strip('api/dashboard.mjs').replace(/export default async function handler/, 'async function handler').replace(/^export /gm, '');
	const handler = new Function(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps));
	const getCode = (p) => p.requests.filter((r) => r.method === 'eth_getCode').length;
	return {
		handler, limits, calls,
		counts: () => ({ alchemy: getCode(alchemy), infura: getCode(infura), destructive: calls.filter((c) => DESTRUCTIVE.includes(c)) })
	};
}

function legacyCookie() {
	const now = Date.now();
	const payload = Buffer.from(JSON.stringify({ type: 'session', wallet: WALLET, iat: now, exp: now + 3_600_000 })).toString('base64url');
	const token = `${payload}.${createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('base64url')}`;
	assert.equal(auth.verifyDashboardToken(token)?.kind, undefined, 'valid legacy session without kind');
	return `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`;
}
const kindCookie = (kind) => `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(WALLET, Date.now(), kind))}`;
const PATHS = {
	'POST action': { method: 'POST', url: '/api/dashboard', body: { action: 'session-revoke' } },
	'DELETE sign-out': { method: 'DELETE', url: '/api/dashboard' },
	'DELETE telegram': { method: 'DELETE', url: '/api/dashboard?telegram=1' }
};
async function send(w, path, cookie) {
	const { method, url, body } = PATHS[path];
	const r = { code: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
	await w.handler({ method, url, body, headers: { cookie, origin: 'https://coverraccoon.com', 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '198.51.100.31', ...(body ? { 'content-type': 'application/json' } : {}) } }, r);
	return r;
}
const IP_GATE = { 'POST action': 'dashboard-action', 'DELETE sign-out': 'dashboard-delete', 'DELETE telegram': 'dashboard-delete' };

/* ======================================================= blocked: zero provider work */

test('LEGACY-ORDER IP gate: a denied per-IP limit stops every legacy path before wallet/global gates, providers and any write', async () => {
	for (const path of Object.keys(PATHS)) {
		const w = world({ deny: IP_GATE[path] });
		const r = await send(w, path, legacyCookie());
		assert.equal(r.code, 429, path);
		assert.deepEqual(w.counts(), { alchemy: 0, infura: 0, destructive: [] }, path);
		assert.deepEqual(w.limits, [IP_GATE[path]], `${path}: nothing after the IP gate`);
	}
});

test('LEGACY-ORDER wallet gate: a denied per-wallet action limit stops every legacy path with 429 before any provider call or write', async () => {
	for (const path of Object.keys(PATHS)) {
		const w = world({ deny: 'dashboard-action-wallet' });
		const r = await send(w, path, legacyCookie());
		assert.equal(r.code, 429, path);
		assert.deepEqual(w.counts(), { alchemy: 0, infura: 0, destructive: [] }, `${path}: Alchemy 0, Infura 0, no write`);
		assert.deepEqual(w.limits, [IP_GATE[path], 'dashboard-action-wallet'], `${path}: global gate and providers not reached`);
	}
});

test('LEGACY-ORDER global gate: a denied global action budget stops every legacy path with 429 before any provider call or write', async () => {
	for (const path of Object.keys(PATHS)) {
		const w = world({ deny: 'dashboard-action-verify-global' });
		const r = await send(w, path, legacyCookie());
		assert.equal(r.code, 429, path);
		assert.deepEqual(w.counts(), { alchemy: 0, infura: 0, destructive: [] }, `${path}: Alchemy 0, Infura 0, no write`);
		assert.deepEqual(w.limits, [IP_GATE[path], 'dashboard-action-wallet', 'dashboard-action-verify-global'], path);
	}
});

/* ============================================= allowed: classification unchanged */

test('LEGACY-ALLOWED contract code: both providers are still asked once, and fresh authority is still required (nothing wallet-wide)', async () => {
	const post = world();
	const ask = await send(post, 'POST action', legacyCookie());
	assert.equal(ask.body.freshSignatureRequired, true);
	assert.deepEqual(post.counts(), { alchemy: 1, infura: 1, destructive: ['storeDashboardChallenge'] });
	assert.deepEqual(post.limits, ['dashboard-action', 'dashboard-action-wallet', 'dashboard-action-verify-global'], 'the wallet budget is charged once, not twice');
	const out = world();
	const signOut = await send(out, 'DELETE sign-out', legacyCookie());
	assert.deepEqual(signOut.body, { ok: true, revoked: false, freshSignatureRequired: true }, 'only this device signs out');
	assert.deepEqual(out.counts(), { alchemy: 1, infura: 1, destructive: [] });
	const tg = world();
	assert.equal((await send(tg, 'DELETE telegram', legacyCookie())).code, 403, 'Telegram disconnect still needs a fresh confirmation');
	assert.deepEqual(tg.counts(), { alchemy: 1, infura: 1, destructive: [] });
});

test('LEGACY-ALLOWED no code at both providers: legacy EOA behaviour unchanged (no fresh signature, server-side sign-out, single-chat unlink)', async () => {
	const post = world({ code: '0x' });
	assert.deepEqual((await send(post, 'POST action', legacyCookie())).body, { ok: true, freshSignatureRequired: false });
	assert.deepEqual(post.counts(), { alchemy: 1, infura: 1, destructive: [] });
	const out = world({ code: '0x' });
	assert.equal((await send(out, 'DELETE sign-out', legacyCookie())).code, 200);
	assert.deepEqual(out.counts(), { alchemy: 1, infura: 1, destructive: ['revokeDashboardSessions'] });
	const tg = world({ code: '0x' });
	assert.equal((await send(tg, 'DELETE telegram', legacyCookie())).code, 200);
	assert.deepEqual(tg.counts(), { alchemy: 1, infura: 1, destructive: ['unlinkWalletByWallet'] });
});

/* =================================================== typed sessions: unchanged */

test('TYPED-UNCHANGED: sessions with kind make no provider call and pass exactly the gates they passed before F-2F-1', async () => {
	const expected = {
		eoa: {
			'POST action': [['dashboard-action'], 200, []],
			'DELETE sign-out': [['dashboard-delete'], 200, ['revokeDashboardSessions']],
			'DELETE telegram': [['dashboard-delete'], 200, ['unlinkWalletByWallet']]
		},
		contract: {
			'POST action': [['dashboard-action', 'dashboard-action-wallet'], 200, ['storeDashboardChallenge']],
			'DELETE sign-out': [['dashboard-delete'], 200, []],
			'DELETE telegram': [['dashboard-delete'], 403, []]
		}
	};
	for (const [kind, paths] of Object.entries(expected)) {
		for (const [path, [limits, status, destructive]] of Object.entries(paths)) {
			const w = world();
			const r = await send(w, path, kindCookie(kind));
			assert.equal(r.code, status, `${kind} ${path}`);
			assert.deepEqual(w.limits, limits, `${kind} ${path}: gates`);
			assert.deepEqual(w.counts(), { alchemy: 0, infura: 0, destructive }, `${kind} ${path}: no provider lookup`);
		}
	}
	const contractSignOut = world();
	assert.deepEqual((await send(contractSignOut, 'DELETE sign-out', kindCookie('contract'))).body, { ok: true, revoked: false, freshSignatureRequired: true }, 'Safe: wallet-wide revoke still needs fresh authority');
});

test('TYPED-UNCHANGED: the new legacy gates never fire for a typed session, even when they would deny', async () => {
	for (const kind of ['eoa', 'contract']) {
		const w = world({ deny: 'dashboard-action-verify-global' });
		const r = await send(w, 'DELETE sign-out', kindCookie(kind));
		assert.equal(r.code, 200, `${kind}: sign-out is not subject to the legacy lookup budget`);
		assert.ok(!w.limits.includes('dashboard-action-verify-global'), kind);
	}
});
