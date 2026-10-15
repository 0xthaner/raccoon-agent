/*
	Safe-App-Sitzung (15.10.2026): partitioniertes HttpOnly-Cookie statt JS-lesbarem Bearer.

	  __Host-raccoon_safeapp=<Contract-Sitzung>; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=None; Partitioned

	- Die Safe App fordert `x-dashboard-transport: partitioned-cookie` an. Nur fuer eine
	  serverseitig BEWIESENE Contract-Autoritaet setzt der Server dieses Cookie.
	- Es gibt KEIN Bearer-Token mehr: weder in der Antwort (auch nicht auf
	  `x-dashboard-transport: bearer`) noch wird `Authorization: Bearer` angenommen.
	- Nach einem Reload uebernimmt die Safe App eine bestehende Sitzung derselben Safe
	  (startSafeApp), ohne neue Challenge und ohne Signatur.

	Der "Browser" hier modelliert den Safe-iframe (Drittanbieter-Kontext): er speichert
	Cookies, schickt aber nur SameSite=None-Cookies mit - das Strict-Cookie nie. Damit
	belegen die Tests, dass die Safe App ausschliesslich ueber das partitionierte Cookie
	laeuft. Ob echte Browser es speichern und senden, belegen sie NICHT.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hashMessage, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { simChain, dualProviders, ownerSignature, executeSignMessageLib } from '../test-support/dual-rpc-sim.mjs';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';

process.env.APP_BASE_URL = 'https://coverraccoon.com';
process.env.DASHBOARD_SESSION_SECRET = 'safe-app-session-secret-0123456789abcdef-xyz';

const auth = await import('../src/dashboard-auth.mjs');
const cs = await import('../src/contract-signature.mjs');
const safeApp = await import('../web/src/safe-app.js');

const SAFE = '0x5afe0000000000000000000000000000000aa0aa';
const OTHER_SAFE = '0x5afe0000000000000000000000000000000bb0bb';
const EOA = privateKeyToAccount(`0x${'0b'.repeat(32)}`);
const SAFEAPP = '__Host-raccoon_safeapp';
const SAFEAPP_ATTRS = ['Path=/', 'Max-Age=86400', 'Secure', 'HttpOnly', 'SameSite=None', 'Partitioned'];

/* --------------------------------------------------------------- Server */

function server({ revokedAfter = null } = {}) {
	const history = [{ from: 0n, owners: ['b2'], threshold: 1 }];
	const chain = simChain({ head: 20_000_000n, safes: { [SAFE]: { history }, [OTHER_SAFE]: { history } } });
	const { providers } = dualProviders(chain);
	const challenges = new Map();
	const state = { revokedAt: revokedAfter, revokedWallets: [] };
	const source = readFileSync(new URL('../api/dashboard.mjs', import.meta.url), 'utf8').replace(/^import [^;]*;\n/gm, '').replace('export default async function handler', 'async function handler');
	const deps = {
		isAddress, queryParams, singleQueryValue, ...auth,
		verifyWalletSiweAuthority: (p) => cs.verifyWalletSiweAuthority(p, { providers }),
		verifyOnchainDashboardLoginApproval: (p) => cs.verifyOnchainDashboardLoginApproval(p, { providers }),
		noContractCodeByQuorum: (w) => cs.noContractCodeByQuorum(w, { providers }),
		isDeployedContract: async (w) => w.toLowerCase() !== EOA.address.toLowerCase(),
		storeDashboardChallenge: async ({ nonce, wallet, expiresAt }) => { challenges.set(nonce, { wallet, expiresAt, used: false }); },
		consumeDashboardChallenge: async (nonce, wallet) => { const r = challenges.get(nonce); if (!r || r.used || r.wallet !== wallet.toLowerCase()) return false; r.used = true; return true; },
		isDashboardChallengeOpen: async (nonce) => { const r = challenges.get(nonce); return Boolean(r && !r.used); },
		getWalletCovers: async () => ({ covers: [] }), getWalletLinkStateByWallet: async () => ({ linked: false, link: null }),
		isDashboardSessionRevoked: async (wallet, iat) => state.revokedAt !== null && iat <= state.revokedAt,
		recordAgentEvent: async () => {}, consumeDashboardAccess: async () => null,
		getLanguage: async () => 'de', beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		revokeDashboardSessions: async (wallet) => { state.revokedWallets.push(wallet); state.revokedAt = Date.now(); return state.revokedAt; },
		unlinkWalletByWallet: async () => [], unlinkWalletFromAllChats: async () => [],
		enforceRateLimit: async () => true, enforceRateLimitFor: async () => true, requireJson: () => true, requireSameOrigin: () => true,
		recordSecurityEvent: async () => {}, securityFingerprint: () => 'fp',
		SECURITY_EVENT: { SIWE_SIGNATURE_INVALID: 'invalid', SIWE_REPLAY_BLOCKED: 'replay', ERC1271_RPC_DISAGREEMENT: 'disagreement', ACCESS_CODE_INVALID: 'access' },
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}
	};
	const handler = new Function(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps));
	return { handler, chain, state };
}
const response = () => ({ headers: {}, status(n) { this.code = n; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, json(b) { this.body = b; return this; } });
async function raw(srv, req) { const res = response(); await srv.handler({ url: '/api/dashboard', ...req, headers: { 'content-type': 'application/json', ...(req.headers ?? {}) } }, res); return res; }
const setCookies = (res) => { const h = res.headers['set-cookie']; return h === undefined ? [] : Array.isArray(h) ? h : [h]; };
const tokensIn = (body) => { const out = []; const walk = (v) => { if (typeof v === 'string' && auth.verifyDashboardSession(v)) out.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); }; walk(body); return out; };

/** Browser im Safe-iframe: speichert Cookies, sendet nur SameSite=None (Drittanbieter-Kontext). */
function iframeBrowser(srv) {
	const jar = new Map();
	const log = [];
	const responses = [];
	const fetchFn = async (url, init = {}) => {
		const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
		log.push({ method: init.method ?? 'GET', url, headers: { ...headers } });
		const sendable = [...jar].filter(([, c]) => c.sameSiteNone).map(([k, c]) => `${k}=${c.value}`);
		if (sendable.length) headers.cookie = sendable.join('; ');
		const res = await raw(srv, { method: init.method ?? 'GET', url, headers, body: init.body ? JSON.parse(init.body) : undefined });
		responses.push(res);
		for (const c of setCookies(res)) {
			const [pair, ...attrs] = c.split(';').map((s) => s.trim());
			const name = pair.slice(0, pair.indexOf('='));
			if (attrs.includes('Max-Age=0')) jar.delete(name); else jar.set(name, { value: pair.slice(pair.indexOf('=') + 1), sameSiteNone: attrs.includes('SameSite=None'), attrs });
		}
		return { ok: res.code < 400, status: res.code, json: async () => res.body };
	};
	return { fetchFn, jar, log, responses };
}
function safeSdk(address, { onchain = false } = {}) {
	const state = { signRequests: 0, pending: null, proposals: [] };
	const sdk = {
		safe: { getInfo: async () => ({ safeAddress: address, chainId: 1, threshold: 1, owners: [] }), getOffChainSignature: async (h) => (state.pending?.hash === h ? state.pending.sig : '') },
		eth: { setSafeSettings: async ([r]) => ({ offChainSigning: !!r.offChainSigning }) },
		txs: { signMessage: async (message) => {
			state.signRequests++;
			const hash = hashMessage(message);
			if (onchain) { state.proposals.push(message); return { safeTxHash: `0x${'5a'.repeat(32)}` }; }
			state.pending = { hash, sig: ownerSignature(['b2'], hash) };
			return { messageHash: hash };
		} }
	};
	return { sdk, state, info: { safeAddress: address, chainId: 1, threshold: 1, owners: [] } };
}
const open = (b, s, extra = {}) => safeApp.startSafeApp({ sdk: s.sdk, info: s.info, fetchFn: b.fetchFn, waitFn: async () => {}, pollTimeoutMs: 1000, ...extra });

/* ============================================================== A */

test('A Safe App login: partitioned HttpOnly cookie set, NO sessionToken, no token anywhere in JSON; later requests work via the cookie only', async () => {
	const srv = server(); const b = iframeBrowser(srv); const s = safeSdk(SAFE);
	const out = await open(b, s);
	assert.equal(out.restored, false);
	assert.equal(s.state.signRequests, 1);
	const issued = (c) => c.startsWith(`${SAFEAPP}=`) && !c.includes('Max-Age=0');
	const login = b.responses.find((r) => setCookies(r).some(issued));
	assert.ok(login, 'Safe-App-Cookie gesetzt');
	const cookie = setCookies(login).find(issued);
	assert.deepEqual(cookie.split(';').slice(1).map((a) => a.trim()), SAFEAPP_ATTRS);
	assert.equal(/domain=/i.test(cookie), false);
	const session = auth.verifyDashboardSession(decodeURIComponent(cookie.slice(SAFEAPP.length + 1, cookie.indexOf(';'))));
	assert.equal(session.kind, 'contract');
	assert.equal(session.wallet, SAFE);
	assert.equal(session.exp - session.iat, auth.SESSION_TTL_CONTRACT_MS);
	assert.equal(login.body.sessionToken, undefined);
	for (const r of b.responses) assert.deepEqual(tokensIn(r.body), [], 'kein Sitzungstoken in irgendeinem JSON');
	assert.equal('sessionToken' in out, false, 'Frontend-Ergebnis traegt kein Token');
	assert.equal(JSON.stringify(out).includes(session.wallet) && tokensIn(out).length, 0);
	const read = await b.fetchFn('/api/dashboard');
	assert.equal(read.status, 200, 'naechster Aufruf nur mit dem partitionierten Cookie');
});

/* =========================================================== B / C */

for (const [label, fresh] of [['B reload', false], ['C hard reload (new SDK, no in-memory state)', true]]) {
	test(`${label}: the existing session of the same Safe is restored - one GET, no challenge, no signature`, async () => {
		const srv = server(); const b = iframeBrowser(srv);
		await open(b, safeSdk(SAFE));
		const s = fresh ? safeSdk(SAFE.toUpperCase().replace('0X', '0x')) : safeSdk(SAFE);
		b.log.length = 0;
		const out = await open(b, s);
		assert.equal(out.restored, true);
		assert.equal(out.dashboard.wallet, SAFE);
		assert.equal(s.state.signRequests, 0);
		assert.deepEqual(b.log.map((r) => `${r.method} ${r.url}`), ['GET /api/dashboard']);
		assert.equal(b.log[0].headers.authorization, undefined);
	});
}

/* ======================================================= D / E / F / G */

test('D a different Safe: the old session is never rendered, a new login with signature follows', async () => {
	const srv = server(); const b = iframeBrowser(srv);
	await open(b, safeSdk(SAFE));
	const other = safeSdk(OTHER_SAFE);
	const out = await open(b, other);
	assert.equal(out.restored, false);
	assert.equal(out.dashboard.wallet, OTHER_SAFE);
	assert.equal(other.state.signRequests, 1);
});

test('E an expired session requires a new login', async () => {
	const srv = server(); const b = iframeBrowser(srv);
	const old = auth.createDashboardSession(SAFE, Date.now() - auth.SESSION_TTL_CONTRACT_MS - 1000, 'contract');
	b.jar.set(SAFEAPP, { value: encodeURIComponent(old), sameSiteNone: true, attrs: [] });
	const s = safeSdk(SAFE);
	const out = await open(b, s);
	assert.equal(out.restored, false);
	assert.equal(s.state.signRequests, 1);
});

test('F a revoked session requires a new login (copied old cookie stays invalid)', async () => {
	const srv = server(); const b = iframeBrowser(srv);
	await open(b, safeSdk(SAFE));
	const copied = b.jar.get(SAFEAPP).value;
	srv.state.revokedAt = Date.now() + 1;
	const s = safeSdk(SAFE);
	const out = await open(b, s);
	assert.equal(out.restored, false);
	assert.equal(s.state.signRequests, 1);
	const reuse = await raw(srv, { method: 'GET', headers: { cookie: `${SAFEAPP}=${copied}` } });
	assert.equal(reuse.code, 401);
	assert.equal(reuse.body.code, 'SESSION_REVOKED');
});

test('G malformed or forged Safe-App cookies are rejected', async () => {
	const srv = server();
	const good = auth.createDashboardSession(SAFE, Date.now(), 'contract');
	for (const value of ['garbage', `${good.slice(0, -3)}abc`, encodeURIComponent(auth.createDashboardChallenge(SAFE).token), '%E0%A4%A']) {
		assert.equal((await raw(srv, { method: 'GET', headers: { cookie: `${SAFEAPP}=${value}` } })).code, 401, value.slice(0, 12));
	}
	const b = iframeBrowser(srv); b.jar.set(SAFEAPP, { value: 'garbage', sameSiteNone: true, attrs: [] });
	const s = safeSdk(SAFE);
	assert.equal((await open(b, s)).restored, false);
	assert.equal(s.state.signRequests, 1);
});

/* ============================================================ H / I */

test('H the Safe App frontend requests only the partitioned-cookie transport - never bearer, never an Authorization header', async () => {
	for (const onchain of [false, true]) {
		const srv = server(); const b = iframeBrowser(srv); const s = safeSdk(SAFE, { onchain });
		let waits = 0;
		await open(b, s, { waitFn: async () => { if (onchain && ++waits === 1) { for (const m of s.state.proposals.splice(0)) executeSignMessageLib(srv.chain, SAFE, m); } } });
		const posts = b.log.filter((r) => r.method === 'POST');
		assert.ok(posts.length >= 1);
		for (const r of posts) assert.equal(r.headers['x-dashboard-transport'], 'partitioned-cookie', onchain ? 'Modus B' : 'Modus A');
		for (const r of b.log) assert.equal(r.headers.authorization, undefined);
	}
	const main = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');
	const safe = readFileSync(new URL('../web/src/safe-app.js', import.meta.url), 'utf8');
	assert.equal(/Bearer \$\{|['"]bearer['"]|safeSession|sessionToken/.test(main), false, 'main.js baut kein Bearer und haelt kein Token');
	assert.equal(/['"]bearer['"]|\.sessionToken\b|['"]?[Aa]uthorization['"]?\s*:/.test(safe), false, 'safe-app.js fordert kein Bearer an und liest kein Token');
});

test('I a malicious frontend asking for "bearer" (any spelling, any login mode) never receives a session token, and a bearer is never accepted', async () => {
	for (const transport of ['bearer', 'Bearer', 'BEARER', ' bearer', undefined, 'partitioned-cookie']) {
		const srv = server();
		const ch = (await raw(srv, { method: 'GET', url: `/api/dashboard?wallet=${SAFE}` })).body;
		const res = await raw(srv, { method: 'POST', headers: transport === undefined ? {} : { 'x-dashboard-transport': transport }, body: { wallet: SAFE, token: ch.token, signature: ownerSignature(['b2'], hashMessage(ch.message)) } });
		assert.equal(res.code, 200, `${transport}: ${JSON.stringify(res.body)}`);
		assert.equal(res.body.sessionToken, undefined, String(transport));
		assert.deepEqual(tokensIn(res.body), [], String(transport));
	}
	// Modus B (On-chain-Freigabe) mit "bearer"
	const srv = server();
	const ch = await raw(srv, { method: 'GET', url: `/api/dashboard?wallet=${SAFE}` });
	executeSignMessageLib(srv.chain, SAFE, ch.body.message);
	const onchain = await raw(srv, { method: 'POST', headers: { 'x-dashboard-transport': 'bearer' }, body: { wallet: SAFE, token: ch.body.token, approval: 'onchain' } });
	assert.equal(onchain.code, 200);
	assert.equal(onchain.body.sessionToken, undefined);
	// Authorization: Bearer wird nicht mehr angenommen - auch nicht mit einem gueltigen Sitzungstoken
	const valid = auth.createDashboardSession(SAFE, Date.now(), 'contract');
	assert.equal((await raw(srv, { method: 'GET', headers: { authorization: `Bearer ${valid}` } })).code, 401);
	assert.equal(typeof auth.readBearerToken, 'undefined', 'kein Bearer-Leser mehr');
});

/* ================================================================ J */

test('J an EOA never receives the Safe-App cookie, and an EOA session under that name is rejected', async () => {
	const srv = server();
	for (const transport of ['partitioned-cookie', 'bearer', undefined]) {
		const ch = (await raw(srv, { method: 'GET', url: `/api/dashboard?wallet=${EOA.address}` })).body;
		const res = await raw(srv, { method: 'POST', headers: transport ? { 'x-dashboard-transport': transport } : {}, body: { wallet: EOA.address, token: ch.token, signature: await EOA.signMessage({ message: ch.message }) } });
		assert.equal(res.code, 200);
		assert.equal(setCookies(res).some((c) => c.startsWith(`${SAFEAPP}=`)), false, String(transport));
		assert.equal(res.headers['set-cookie'].startsWith?.('__Host-raccoon_dashboard=') ?? false, true);
		assert.equal(res.body.sessionToken, undefined);
	}
	const eoa = auth.createDashboardSession(EOA.address, Date.now(), 'eoa');
	assert.equal((await raw(srv, { method: 'GET', headers: { cookie: `${SAFEAPP}=${encodeURIComponent(eoa)}` } })).code, 401);
});

/* ============================================================ K / L */

test('K a restored session alone never authorizes destructive actions - fresh Safe authority stays required', async () => {
	const srv = server(); const b = iframeBrowser(srv);
	await open(b, safeSdk(SAFE));
	const s = safeSdk(SAFE);
	assert.equal((await open(b, s)).restored, true);
	const ask = await (await b.fetchFn('/api/dashboard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'session-revoke' }) })).json();
	assert.equal(ask.freshSignatureRequired, true);
	const disconnect = await b.fetchFn('/api/dashboard?telegram=1', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
	assert.equal(disconnect.status, 403);
	const revokeAll = await b.fetchFn('/api/dashboard', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
	assert.equal((await revokeAll.json()).revoked, false);
	assert.deepEqual(srv.state.revokedWallets, [], 'kein walletweiter Widerruf ohne frische Bestaetigung');
	assert.equal(s.state.signRequests, 0);
});

test('L logout clears the Safe-App cookie (and the dashboard cookie); afterwards a new login is required', async () => {
	const srv = server(); const b = iframeBrowser(srv);
	await open(b, safeSdk(SAFE));
	const logout = await b.fetchFn('/api/dashboard', { method: 'DELETE' });
	assert.equal(logout.status, 200);
	const cleared = setCookies(b.responses.at(-1));
	assert.ok(cleared.includes(`${SAFEAPP}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None; Partitioned`));
	assert.ok(cleared.some((c) => c.startsWith('__Host-raccoon_dashboard=; ')));
	assert.equal(b.jar.has(SAFEAPP), false);
	const s = safeSdk(SAFE);
	assert.equal((await open(b, s)).restored, false);
	assert.equal(s.state.signRequests, 1);
});

test('L an EOA logout keeps its exact behaviour and also clears a stray Safe-App cookie name (harmless)', async () => {
	const srv = server();
	const eoa = auth.createDashboardSession(EOA.address, Date.now(), 'eoa');
	const res = await raw(srv, { method: 'DELETE', headers: { cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(eoa)}` } });
	assert.equal(res.code, 200);
	assert.deepEqual(res.headers['set-cookie'], auth.CLEAR_SESSION_COOKIES);
	assert.deepEqual(srv.state.revokedWallets, [EOA.address.toLowerCase()]);
});
