/**
 * CRSF Phase 2M, CR-RESOURCE-001 P1 ("dashboard login/action limits before
 * verification"): auf jedem Anmelde- und Bestaetigungspfad des Dashboards greifen
 * IP-, Schluessel- und globale Schranke VOR der teuren Arbeit - Signaturpruefung
 * (offline ECDSA, sonst ERC-1271 ueber Alchemy UND Infura), Lesen des
 * Challenge-Zustands, Nonce-Verbrauch und Sitzungsausgabe.
 *
 *   Login (Signatur)         dashboard-login -> dashboard-login-wallet -> dashboard-login-global
 *   Login (On-chain-Freigabe) dashboard-onchain -> dashboard-onchain-nonce -> dashboard-onchain-wallet -> dashboard-onchain-global
 *   Frische Bestaetigung      dashboard-delete -> dashboard-action-verify -> dashboard-action-verify-global
 *     (DELETE ueberall abmelden und DELETE ?telegram=1 einer Contract-Sitzung)
 *
 * Die Aktionspfade mit Provider-Arbeit fuer Alt-Sitzungen deckt
 * test/dashboard-legacy-rate-order.test.mjs (F-2F-1).
 *
 * Echt laufen: api/dashboard.mjs, src/http-security.mjs, src/dashboard-auth.mjs
 * und die echten Pruefungen verifyWalletSiweAuthority /
 * verifyOnchainDashboardLoginApproval auf zwei offline Draht-Providern.
 * Ersetzt sind nur der Zaehlerspeicher des Rate-Limiters und die Datenbank
 * (Spione fuer Challenge-Zustand, Verbrauch, Widerruf, Trennen).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { guards, loadHandler, providers, response, firstIndex, SECURITY_EVENT } from '../test-support/rate-order-world.mjs';

process.env.DASHBOARD_SESSION_SECRET = 'auth-rate-order-secret-0123456789abcdef-012';
process.env.APP_BASE_URL = 'https://coverraccoon.com';
delete process.env.TELEGRAM_BOT_TOKEN;
const auth = await import('../src/dashboard-auth.mjs');
const { siweOrigin } = await import('../src/siwe-auth.mjs');
const { queryParams, singleQueryValue } = await import('../src/request-query.mjs');
const signatures = await import('../src/contract-signature.mjs');

// Oeffentliche, unbefuellte Offline-Schluessel; nie von Anwendungscode importiert.
const OWNER = privateKeyToAccount(`0x${'05'.repeat(32)}`);
const STRANGER = privateKeyToAccount(`0x${'06'.repeat(32)}`);
const WALLET = OWNER.address;

function world({ deny = null, open = true } = {}) {
	const trace = [];
	const g = guards({ deny, dashboardSecretConfigured: auth.dashboardSecretConfigured, siweOrigin, trace });
	const rpc = providers({ trace });
	const db = (name, value) => async () => { trace.push(`DB ${name}`); return value; };
	const deps = {
		isAddress, queryParams, singleQueryValue, ...auth, ...g,
		verifyWalletSiweAuthority: (params) => { trace.push('VERIFY signature'); return signatures.verifyWalletSiweAuthority(params, { providers: rpc.clients }); },
		verifyOnchainDashboardLoginApproval: (params) => { trace.push('VERIFY onchain'); return signatures.verifyOnchainDashboardLoginApproval(params, { providers: rpc.clients }); },
		noContractCodeByQuorum: (wallet) => signatures.noContractCodeByQuorum(wallet, { providers: rpc.clients }),
		isDeployedContract: async () => false,
		getWalletCovers: async () => ({ covers: [] }), getWalletLinkStateByWallet: async () => ({ linked: false, link: null }),
		isDashboardSessionRevoked: async () => false,
		isDashboardChallengeOpen: db('challenge-open', open), consumeDashboardChallenge: db('consume', true),
		storeDashboardChallenge: db('store'), revokeDashboardSessions: db('revoke', Date.now()),
		unlinkWalletByWallet: db('unlink', []), unlinkWalletFromAllChats: db('unlink', []),
		consumeDashboardAccess: async () => null, recordAgentEvent: async () => {}, getLanguage: async () => 'de',
		beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}, recordSecurityEvent: async () => {}, securityFingerprint: () => 'fp', SECURITY_EVENT
	};
	return { handler: loadHandler('api/dashboard.mjs', deps), trace, limits: g.limits, sizes: g.sizes, rpc };
}

const cookieIssued = (r) => [].concat(r.headers['set-cookie'] ?? []).some((c) => c.startsWith(`${auth.SESSION_COOKIE}=`) && !c.includes('Max-Age=0'));
function work(w, r) {
	const rpc = w.rpc.count();
	return { verify: w.trace.filter((t) => t.startsWith('VERIFY')).length, rpc: rpc.alchemy + rpc.infura, db: w.trace.filter((t) => t.startsWith('DB ')).map((t) => t.slice(3)), session: cookieIssued(r) };
}
const NONE = { verify: 0, rpc: 0, db: [], session: false };

async function send(w, { method, url = '/api/dashboard', body, cookie }) {
	const r = response();
	const headers = { origin: 'https://coverraccoon.com', 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '198.51.100.41', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
	await w.handler({ method, url, body, headers }, r);
	return r;
}

/* ------------------------------------------------------------ paths */
async function login(w, signer = STRANGER) {
	const challenge = auth.createDashboardChallenge(WALLET);
	const signature = await signer.signMessage({ message: challenge.message });
	return send(w, { method: 'POST', body: { wallet: WALLET, token: challenge.token, signature } });
}
async function onchain(w) {
	const challenge = auth.createDashboardChallenge(WALLET, Date.now(), auth.DASHBOARD_CHALLENGE_TTL_CONTRACT_MS);
	return send(w, { method: 'POST', body: { wallet: WALLET, token: challenge.token, approval: 'onchain' } });
}
const contractCookie = () => `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(WALLET, Date.now(), 'contract'))}`;
async function fresh(w, purpose, signer = STRANGER) {
	const action = auth.createActionChallenge(WALLET, purpose);
	const signature = await signer.signMessage({ message: action.message });
	return send(w, { method: 'DELETE', url: purpose === 'telegram-disconnect' ? '/api/dashboard?telegram=1' : '/api/dashboard', body: { token: action.token, signature }, cookie: contractCookie() });
}

const PATHS = {
	'login signature': { run: (w) => login(w), gates: ['dashboard-login', 'dashboard-login-wallet', 'dashboard-login-global'] },
	'login onchain': { run: (w) => onchain(w), gates: ['dashboard-onchain', 'dashboard-onchain-nonce', 'dashboard-onchain-wallet', 'dashboard-onchain-global'] },
	'fresh session-revoke': { run: (w) => fresh(w, 'session-revoke'), gates: ['dashboard-delete', 'dashboard-action-verify', 'dashboard-action-verify-global'] },
	'fresh telegram-disconnect': { run: (w) => fresh(w, 'telegram-disconnect'), gates: ['dashboard-delete', 'dashboard-action-verify', 'dashboard-action-verify-global'] }
};

/* =========================================== blocked: zero expensive work */

for (const [label, path] of Object.entries(PATHS)) {
	for (const [i, gate] of path.gates.entries()) {
		test(`AUTH-ORDER ${label} denied at ${gate}`, async () => {
			const w = world({ deny: gate });
			const r = await path.run(w);
			assert.deepEqual(work(w, r), NONE, `${label}: expensive work after a denied ${gate}`);
			assert.equal(r.code, 429, `${label}: status`);
			assert.deepEqual(w.limits.filter((s) => s.startsWith('dashboard')), path.gates.slice(0, i + 1), `${label}: gates after ${gate}`);
		});
	}
}

/* ============================== allowed: every gate first, result unchanged */

for (const [label, path] of Object.entries(PATHS)) {
	test(`AUTH-ORDER ${label} admitted: all gates before the first verification or state read`, async () => {
		const w = world();
		await path.run(w);
		const firstWork = Math.min(...['VERIFY', 'RPC', 'DB'].map((p) => firstIndex(w.trace, p)).filter((i) => i >= 0));
		const before = w.trace.slice(0, firstWork).filter((t) => t.startsWith('limit dashboard')).map((t) => t.slice(6));
		assert.deepEqual(before, path.gates, `${label}: gates before the first expensive step: ${before}`);
	});
}

test('AUTH-ORDER login signature admitted, owner key: verified offline (no RPC), nonce consumed once, session issued', async () => {
	const w = world();
	const r = await login(w, OWNER);
	assert.equal(r.code, 200);
	assert.deepEqual(work(w, r), { verify: 1, rpc: 0, db: ['consume'], session: true });
});

test('AUTH-ORDER login signature admitted, foreign key: ERC-1271 asked at both providers, fails closed, nothing consumed', async () => {
	const w = world();
	const r = await login(w, STRANGER);
	assert.equal(r.code, 401);
	const c = w.rpc.count();
	assert.ok(c.alchemy > 0 && c.infura > 0, `providers ${JSON.stringify(c)}`);
	assert.deepEqual({ ...work(w, r), rpc: 'n' }, { verify: 1, rpc: 'n', db: [], session: false });
});

test('AUTH-ORDER login onchain admitted: open challenge read, both providers asked, providers down -> 503, nothing consumed', async () => {
	const w = world();
	const r = await onchain(w);
	assert.equal(r.code, 503);
	const c = w.rpc.count();
	assert.ok(c.alchemy > 0 && c.infura > 0, `providers ${JSON.stringify(c)}`);
	assert.deepEqual({ ...work(w, r), rpc: 'n' }, { verify: 1, rpc: 'n', db: ['challenge-open'], session: false });
});

test('AUTH-ORDER login onchain admitted, challenge closed: 409 before any provider', async () => {
	const w = world({ open: false });
	const r = await onchain(w);
	assert.equal(r.code, 409);
	assert.deepEqual(work(w, r), { verify: 0, rpc: 0, db: ['challenge-open'], session: false });
});

test('AUTH-ORDER fresh authority admitted, owner key: verified, consumed once, then the action runs', async () => {
	const revoke = world();
	const r1 = await fresh(revoke, 'session-revoke', OWNER);
	assert.equal(r1.code, 200);
	assert.deepEqual(work(revoke, r1), { verify: 1, rpc: 0, db: ['consume', 'revoke'], session: false });
	const tg = world();
	const r2 = await fresh(tg, 'telegram-disconnect', OWNER);
	assert.equal(r2.code, 200);
	assert.deepEqual(work(tg, r2), { verify: 1, rpc: 0, db: ['consume', 'unlink'], session: false });
});

test('AUTH-ORDER fresh authority admitted, foreign key: both providers asked, fails closed, nothing consumed or changed', async () => {
	for (const purpose of ['session-revoke', 'telegram-disconnect']) {
		const w = world();
		const r = await fresh(w, purpose, STRANGER);
		assert.notEqual(r.code, 200, purpose);
		const c = w.rpc.count();
		assert.ok(c.alchemy > 0 && c.infura > 0, `${purpose}: providers ${JSON.stringify(c)}`);
		assert.deepEqual({ ...work(w, r), rpc: 'n' }, { verify: 1, rpc: 'n', db: [], session: false }, purpose);
	}
});

test('AUTH-ORDER budget sizes are the documented ones (per 600 s)', async () => {
	const sizes = {};
	for (const run of [(w) => login(w, OWNER), onchain, (w) => fresh(w, 'session-revoke', OWNER)]) {
		const w = world();
		await run(w);
		Object.assign(sizes, w.sizes);
	}
	assert.deepEqual(sizes, {
		'dashboard-login': [10, 600], 'dashboard-login-wallet': [10, 600], 'dashboard-login-global': [200, 600],
		'dashboard-onchain': [60, 600], 'dashboard-onchain-nonce': [45, 600], 'dashboard-onchain-wallet': [90, 600], 'dashboard-onchain-global': [600, 600],
		'dashboard-delete': [10, 600], 'dashboard-action-verify': [10, 600], 'dashboard-action-verify-global': [100, 600]
	});
});
