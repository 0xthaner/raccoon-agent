/*
	AUDIT SA-L1 / SA-L2, 14.10.2026: Sitzungsautoritaet von Contract-Wallets (Safe).

	SA-L1  Eine Contract-Sitzung gilt 24 h (EOA weiter 7 Tage); die Art bestimmt
	       allein der erfolgreiche Pruefpfad am Server. "Telegram trennen" und
	       "ueberall abmelden" brauchen bei Contract-Wallets eine FRISCHE,
	       zweckgebundene, einmalige Bestaetigung ueber ERC-1271 - ein entfernter
	       Owner mit alter Sitzung kann beides nicht mehr.
	SA-L2  GET /api/dashboard verweigert widerrufene Sitzungen (Cookie und Bearer)
	       und faellt bei einem Pruef-Fehler geschlossen aus - ohne Datenzugriff.

	Echter Handler, echte HMAC-Tokens, echte SIWE-Pruefung, echter viem-ERC-1271-Pfad
	gegen einen simulierten Mainnet-RPC (viem `custom`). Kein Netz, keine Datenbank,
	nur Wegwerf-Schluessel ohne Guthaben.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicClient, custom, isAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';

process.env.APP_BASE_URL = 'https://coverraccoon.com';
process.env.DASHBOARD_SESSION_SECRET = 'safe-session-authority-secret-0123456789abcdef';
delete process.env.ALCHEMY_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;

const auth = await import('../src/dashboard-auth.mjs');
const linking = await import('../src/linking.mjs');
const { noContractCodeByQuorum, verifyWalletSiweAuthority } = await import('../src/contract-signature.mjs');

const SAFE = '0x5afe00000000000000000000000000000000a00a';
const OTHER_SAFE = '0x5afe00000000000000000000000000000000b00b';
const SAFE_CODE = '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e';
const SIG_OWNER_A = `0x${'a1'.repeat(65)}`;
const SIG_OWNER_B = `0x${'b2'.repeat(65)}`;
const MAGIC = `0x1626ba7e${'0'.repeat(56)}`;
const NOT_MAGIC = `0xffffffff${'0'.repeat(56)}`;
const EOA = privateKeyToAccount(generatePrivateKey());
const DAY = 24 * 60 * 60_000;

/* ---------------------------------------------------------------- Welt */

function world({ owners = ['A', 'B'], codeError = null, callError = null, forge = null } = {}) {
	const state = { owners: new Set(owners), challenges: new Map(), revokedAt: new Map(), revokes: 0, unlinks: 0, covers: 0, linkStates: 0, revokedLookupError: false, deployed: new Set([SAFE, OTHER_SAFE]), contractCheckError: false, rpc: [], events: [] };
	// Die simulierte Safe akzeptiert nur Signaturen ihrer AKTUELLEN Owner (wie isValidSignature).
	// Zwei getrennte, ehrliche Provider (Alchemy, Infura) auf derselben Kette: ERC-1271
	// verlangt seit dem Dual-RPC-Konsens beide.
	const provider = (name) => createPublicClient({ chain: mainnet, transport: custom({ async request({ method, params }) {
		state.rpc.push(method);
		if (method === 'eth_chainId') return '0x1';
		if (method === 'eth_blockNumber') return '0x1312d00';
		if (method === 'eth_getBlockByNumber') return { number: params[0], hash: `0x${BigInt(params[0]).toString(16).padStart(64, '0')}` };
		if (method === 'eth_getCode') { if (codeError || state.contractCheckError) throw codeError ?? new Error('rpc'); return state.deployed.has(params[0].toLowerCase()) ? SAFE_CODE : '0x'; }
		if (method === 'eth_call') {
			if (callError) throw callError;
			const data = String(params[0].data).toLowerCase();
			const accepted = (state.owners.has('A') && data.includes(SIG_OWNER_A.slice(2))) || (state.owners.has('B') && data.includes(SIG_OWNER_B.slice(2)));
			// `forge`: genau dieser eine Provider ist kompromittiert und meldet immer "gueltig".
			return accepted || forge === name ? MAGIC : NOT_MAGIC;
		}
		throw new Error(`unexpected ${method}`);
	} }, { retryCount: 0 }) });
	const providers = { alchemy: provider('alchemy'), infura: provider('infura') };
	const source = readFileSync(new URL('../api/dashboard.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
	const deps = {
		isAddress, queryParams, singleQueryValue, ...auth,
		verifyWalletSiweAuthority: (params) => verifyWalletSiweAuthority(params, { providers }),
		noContractCodeByQuorum: (wallet) => noContractCodeByQuorum(wallet, { providers }),
		isDeployedContract: async (wallet) => { if (state.contractCheckError) throw new Error('rpc'); return state.deployed.has(wallet.toLowerCase()); },
		getWalletCovers: async () => { state.covers++; return { covers: [] }; },
		getWalletLinkStateByWallet: async () => { state.linkStates++; return { linked: true, link: null }; },
		storeDashboardChallenge: async ({ nonce, wallet, expiresAt }) => { state.challenges.set(nonce, { wallet: wallet.toLowerCase(), expiresAt, used: false }); },
		consumeDashboardChallenge: async (nonce, wallet) => { const row = state.challenges.get(nonce); if (!row || row.used || row.wallet !== wallet.toLowerCase() || row.expiresAt <= Date.now()) return false; row.used = true; return true; },
		isDashboardSessionRevoked: async (wallet, iat) => { if (state.revokedLookupError) throw new Error('db'); const cut = state.revokedAt.get(wallet.toLowerCase()); return cut != null && iat <= cut; },
		revokeDashboardSessions: async (wallet) => { state.revokes++; state.revokedAt.set(wallet.toLowerCase(), Date.now()); return Date.now(); },
		unlinkWalletByWallet: async () => { state.unlinks++; return [{ chat_id: '42' }]; },
		// META-AUDIT M-1: der Contract-Pfad trennt mit frischer Befugnis alle Chats (gleicher Zaehler).
		unlinkWalletFromAllChats: async () => { state.unlinks++; return [{ chat_id: '42' }]; },
		recordAgentEvent: async () => {}, consumeDashboardAccess: async () => null, getLanguage: async () => 'de',
		beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {},
		enforceRateLimit: async () => true, enforceRateLimitFor: async () => true, requireSameOrigin: () => true,
		requireJson: () => true, recordSecurityEvent: async (type) => { state.events.push(type); }, securityFingerprint: () => 'fp', SECURITY_EVENT: { ERC1271_RPC_DISAGREEMENT: 'security.erc1271_rpc_disagreement', SIWE_SIGNATURE_INVALID: 'security.siwe_signature_invalid', SIWE_REPLAY_BLOCKED: 'security.siwe_replay_blocked' }
	};
	const handler = new Function(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps));
	return { state, handler };
}

function res() {
	return { statusCode: null, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.body = b; return this; } };
}
async function call(handler, { method = 'GET', url = '/api/dashboard', headers = {}, body } = {}) {
	const r = res();
	await handler({ method, url, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body }, r);
	return r;
}
const cookie = (token) => ({ cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}` });
// Safe-App-Sitzung (15.10.2026): an die Stelle des Bearers tritt das partitionierte
// Safe-App-Cookie (nur Contract-Sitzungen); Authorization: Bearer wird nicht mehr gelesen.
const safeApp = (token) => ({ cookie: `__Host-raccoon_safeapp=${encodeURIComponent(token)}` });
const safeAppToken = (r) => { const c = [].concat(r.headers['set-cookie']).find((x) => x.startsWith('__Host-raccoon_safeapp=') && !x.includes('Max-Age=0')); return c ? decodeURIComponent(c.slice(c.indexOf('=') + 1, c.indexOf(';'))) : null; };
const payloadOf = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
const cookieToken = (r) => decodeURIComponent(String(r.headers['set-cookie']).split(';')[0].split('=').slice(1).join('='));

async function safeLogin(h, { sig = SIG_OWNER_A, headers = {}, body = {}, url = '/api/dashboard' } = {}) {
	const c = auth.createDashboardChallenge(SAFE, Date.now(), auth.DASHBOARD_CHALLENGE_TTL_CONTRACT_MS);
	const d = auth.verifyDashboardToken(c.token);
	h.state.challenges.set(d.nonce, { wallet: SAFE, expiresAt: d.exp, used: false });
	return call(h.handler, { method: 'POST', url, headers, body: { wallet: SAFE, token: c.token, signature: sig, ...body } });
}
async function eoaLogin(h) {
	const c = auth.createDashboardChallenge(EOA.address);
	const d = auth.verifyDashboardToken(c.token);
	h.state.challenges.set(d.nonce, { wallet: EOA.address.toLowerCase(), expiresAt: d.exp, used: false });
	return call(h.handler, { method: 'POST', body: { wallet: EOA.address, token: c.token, signature: await EOA.signMessage({ message: c.message }) } });
}
/** Holt eine Aktions-Challenge mit der gegebenen Sitzung und laesst Owner `sig` signieren. */
async function freshAuth(h, session, purpose) {
	const r = await call(h.handler, { method: 'POST', headers: cookie(session), body: { action: purpose } });
	assert.equal(r.statusCode, 200, JSON.stringify(r.body));
	return r.body;
}

/* ========================================================== SESSION TTL */

test('SA-L1 1: an EOA login still yields a 7-day session (cookie Max-Age and token exp)', async () => {
	const h = world();
	const r = await eoaLogin(h);
	assert.equal(r.statusCode, 200);
	const t = payloadOf(cookieToken(r));
	assert.equal(t.kind, 'eoa');
	assert.equal(t.exp - t.iat, 7 * DAY);
	assert.match(String(r.headers['set-cookie']), /Max-Age=604800;/);
	assert.deepEqual(h.state.rpc, [], 'EOA bleibt offline');
});

test('SA-L1 2/4: a deployed contract (Safe) login yields a 24-hour session - Strict cookie (WalletConnect) and Safe-App cookie alike, never a body token', async () => {
	const h = world();
	const r = await safeLogin(h, { headers: { 'x-dashboard-transport': 'partitioned-cookie' } });
	assert.equal(r.statusCode, 200);
	assert.equal(r.body.sessionToken, undefined);
	for (const token of [cookieToken(r), safeAppToken(r)]) {
		const t = payloadOf(token);
		assert.equal(t.kind, 'contract');
		assert.equal(t.exp - t.iat, DAY);
		assert.equal(auth.verifyDashboardSession(token).wallet, SAFE);
	}
	assert.match(String(r.headers['set-cookie']), /Max-Age=86400;/);
	const external = await safeLogin(h);
	assert.equal(payloadOf(cookieToken(external)).exp - payloadOf(cookieToken(external)).iat, DAY, 'externe Safe (Cookie-Weg) gleich');
});

test('SA-L1 3: the browser cannot obtain a 7-day contract session - body, query and header flags are ignored', async () => {
	const h = world();
	const r = await safeLogin(h, {
		url: '/api/dashboard?kind=eoa&ttl=604800000',
		headers: { 'x-session-kind': 'eoa', 'x-dashboard-transport': 'bearer', 'x-safe': '0' },
		body: { kind: 'eoa', sessionKind: 'eoa', ttlMs: 7 * DAY, isSafe: false }
	});
	assert.equal(r.statusCode, 200);
	assert.equal(r.body.sessionToken, undefined, 'auch auf x-dashboard-transport: bearer kein Token');
	assert.equal(payloadOf(cookieToken(r)).kind, 'contract');
	assert.equal(payloadOf(cookieToken(r)).exp - payloadOf(cookieToken(r)).iat, DAY);
	// Ein (HMAC-gueltiges) Token "contract" mit 7 Tagen wird nie akzeptiert.
	const forged = auth.createDashboardSession(SAFE, Date.now(), 'contract');
	const data = payloadOf(forged); data.exp = data.iat + 7 * DAY;
	const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
	const { createHmac } = await import('node:crypto');
	const resigned = `${payload}.${createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('base64url')}`;
	assert.equal(auth.verifyDashboardSession(resigned), null);
	assert.throws(() => auth.createDashboardSession(SAFE, Date.now(), 'safe'));
});

test('SA-L1 5: an undeployed address never gets a contract session; an EOA key stays an EOA session', async () => {
	const h = world();
	h.state.deployed.delete(SAFE);
	const r = await safeLogin(h);
	assert.equal(r.statusCode, 401, 'kein Code -> keine Contract-Anmeldung');
	assert.equal(r.headers['set-cookie'], undefined);
	h.state.deployed.add(EOA.address.toLowerCase()); // auch wenn die Adresse Code haette (z. B. 7702): Schluessel = eoa
	const e = await eoaLogin(h);
	assert.equal(payloadOf(cookieToken(e)).kind, 'eoa');
});

test('SA-L1: a contract session is refused after 24 hours', async () => {
	const h = world();
	const old = auth.createDashboardSession(SAFE, Date.now() - DAY - 60_000, 'contract');
	const r = await call(h.handler, { headers: cookie(old) });
	assert.equal(r.statusCode, 401);
	assert.equal(h.state.covers, 0);
});

/* ================================================= DESTRUCTIVE ACTIONS */

test('SA-L1 6: a Safe session alone cannot disconnect Telegram', async () => {
	const h = world();
	const session = auth.createDashboardSession(SAFE, Date.now(), 'contract');
	const r = await call(h.handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(session) });
	assert.equal(r.statusCode, 403);
	assert.equal(r.body.code, 'FRESH_SIGNATURE_REQUIRED');
	assert.equal(h.state.unlinks, 0);
});

test('SA-L1 7: a fresh valid Safe signature disconnects Telegram, exactly once', async () => {
	const h = world();
	const session = auth.createDashboardSession(SAFE, Date.now(), 'contract');
	const challenge = await freshAuth(h, session, 'telegram-disconnect');
	assert.equal(challenge.freshSignatureRequired, true);
	assert.match(challenge.message, /Disconnect Raccoon Agent Telegram cover notifications from this wallet\. This is not a transaction and does not authorize transfers, token approvals or purchases\./);
	assert.match(challenge.message, /Chain ID: 1\n/);
	assert.match(challenge.message, /- https:\/\/coverraccoon\.com\/telegram-disconnect$/);
	const r = await call(h.handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(session), body: { token: challenge.token, signature: SIG_OWNER_A } });
	assert.equal(r.statusCode, 200);
	assert.equal(h.state.unlinks, 1);
	// 14: Replay derselben Bestaetigung
	const again = await call(h.handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(session), body: { token: challenge.token, signature: SIG_OWNER_A } });
	assert.equal(again.statusCode, 409);
	assert.equal(h.state.unlinks, 1);
});

test('SA-L1 8: after owner A is removed, A\'s fresh signature is rejected by ERC-1271 - no destructive action', async () => {
	const h = world();
	const session = auth.createDashboardSession(SAFE, Date.now(), 'contract'); // A meldete sich als Owner an (T0)
	h.state.owners.delete('A'); // T1: A ist kein Owner mehr
	for (const [url, purpose] of [['/api/dashboard?telegram=1', 'telegram-disconnect'], ['/api/dashboard', 'session-revoke']]) {
		const challenge = await freshAuth(h, session, purpose);
		const r = await call(h.handler, { method: 'DELETE', url, headers: cookie(session), body: { token: challenge.token, signature: SIG_OWNER_A } });
		assert.equal(r.statusCode, 401, purpose);
		assert.equal(r.body.code, 'FRESH_SIGNATURE_INVALID');
	}
	assert.equal(h.state.unlinks, 0);
	assert.equal(h.state.revokes, 0);
	// A kann sich auch nicht neu anmelden.
	assert.equal((await safeLogin(h, { sig: SIG_OWNER_A })).statusCode, 401);
	// Owner B kann.
	const challenge = await freshAuth(h, session, 'telegram-disconnect');
	assert.equal((await call(h.handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(session), body: { token: challenge.token, signature: SIG_OWNER_B } })).statusCode, 200);
});

test('SA-L1 9: a Safe session alone cannot revoke all sessions - this device is signed out only', async () => {
	const h = world();
	const session = auth.createDashboardSession(SAFE, Date.now(), 'contract');
	const r = await call(h.handler, { method: 'DELETE', headers: safeApp(session) });
	assert.equal(r.statusCode, 200);
	assert.deepEqual(r.body, { ok: true, revoked: false, freshSignatureRequired: true });
	assert.equal(h.state.revokes, 0);
	assert.ok(String(r.headers['set-cookie']).includes('Max-Age=0'), 'Cookie dieses Geraets geloescht');
	// Andere Sitzungen der Safe gelten weiter.
	assert.equal((await call(h.handler, { headers: cookie(auth.createDashboardSession(SAFE, Date.now() - 1000, 'contract')) })).statusCode, 200);
});

test('SA-L1 10: a fresh valid Safe signature revokes all sessions of the Safe', async () => {
	const h = world();
	const session = auth.createDashboardSession(SAFE, Date.now() - 1000, 'contract');
	const challenge = await freshAuth(h, session, 'session-revoke');
	assert.match(challenge.message, /Sign out all CoverRaccoon dashboard sessions of this wallet on every device\. This is not a transaction/);
	const r = await call(h.handler, { method: 'DELETE', headers: cookie(session), body: { token: challenge.token, signature: SIG_OWNER_A } });
	assert.equal(r.statusCode, 200);
	assert.equal(h.state.revokes, 1);
	assert.equal((await call(h.handler, { headers: cookie(session) })).statusCode, 401, 'alte Sitzung danach widerrufen');
});

test('SA-L1 11: wrong purpose is rejected - a disconnect authorization never revokes sessions and vice versa', async () => {
	const h = world();
	const session = auth.createDashboardSession(SAFE, Date.now(), 'contract');
	const forTelegram = await freshAuth(h, session, 'telegram-disconnect');
	const forRevoke = await freshAuth(h, session, 'session-revoke');
	assert.equal((await call(h.handler, { method: 'DELETE', headers: cookie(session), body: { token: forTelegram.token, signature: SIG_OWNER_A } })).statusCode, 403);
	assert.equal((await call(h.handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(session), body: { token: forRevoke.token, signature: SIG_OWNER_A } })).statusCode, 403);
	// Auch kryptografisch verschieden: Statement und Resource unterscheiden sich.
	const a = auth.verifyActionChallenge(forTelegram.token, 'telegram-disconnect');
	const b = auth.verifyActionChallenge(forRevoke.token, 'session-revoke');
	assert.notEqual(auth.actionSiweExpectation(a).statement, auth.actionSiweExpectation(b).statement);
	assert.notEqual(auth.actionSiweExpectation(a).resource, auth.actionSiweExpectation(b).resource);
	// Eine echte EOA-Signatur ueber den Telegram-Trennen-Text passt nicht zur Revoke-Erwartung.
	const eoaSession = auth.createDashboardSession(EOA.address, Date.now(), 'eoa');
	const t = auth.createActionChallenge(EOA.address, 'telegram-disconnect');
	const r2 = auth.createActionChallenge(EOA.address, 'session-revoke');
	const sigOverTelegramText = await EOA.signMessage({ message: t.message });
	assert.notEqual((await verifyWalletSiweAuthority({ message: auth.actionMessage(r2.data), signature: sigOverTelegramText, expected: auth.actionSiweExpectation(r2.data) })).result, 'VALID');
	assert.ok(eoaSession);
	assert.equal(h.state.unlinks + h.state.revokes, 0);
});

test('SA-L1 12/13: a dashboard-login SIWE or a Telegram-link SIWE never authorizes a destructive action', async () => {
	const h = world();
	const session = auth.createDashboardSession(SAFE, Date.now(), 'contract');
	const login = auth.createDashboardChallenge(SAFE, Date.now(), auth.DASHBOARD_CHALLENGE_TTL_CONTRACT_MS);
	assert.equal((await call(h.handler, { method: 'DELETE', headers: cookie(session), body: { token: login.token, signature: SIG_OWNER_A } })).statusCode, 403, 'Login-Challenge ist keine Aktions-Challenge');
	assert.equal((await call(h.handler, { method: 'DELETE', headers: cookie(session), body: { token: session, signature: SIG_OWNER_A } })).statusCode, 403, 'Sitzungstoken ist keine Aktions-Challenge');
	// Signaturen ueber Login- bzw. Telegram-Link-Text gegen eine echte Aktions-Erwartung (EOA, offline).
	const action = auth.createActionChallenge(EOA.address, 'session-revoke');
	const loginChallenge = auth.createDashboardChallenge(EOA.address);
	const loginSig = await EOA.signMessage({ message: loginChallenge.message });
	const linkMessage = linking.signingMessage({ wallet: EOA.address, nonce: action.data.nonce, expiresAt: action.data.exp, code: 'X'.repeat(24), target: '@raccoon_user' });
	const linkSig = await EOA.signMessage({ message: linkMessage });
	for (const [message, signature] of [[loginChallenge.message, loginSig], [linkMessage, linkSig], [auth.actionMessage(action.data), loginSig], [auth.actionMessage(action.data), linkSig]]) {
		assert.notEqual((await verifyWalletSiweAuthority({ message, signature, expected: auth.actionSiweExpectation(action.data) })).result, 'VALID');
	}
	// Umgekehrt: eine Aktions-Signatur ist kein Login.
	const actionSig = await EOA.signMessage({ message: auth.actionMessage(action.data) });
	const loginData = auth.verifyDashboardToken(loginChallenge.token);
	assert.notEqual((await verifyWalletSiweAuthority({ message: auth.actionMessage(action.data), signature: actionSig, expected: auth.dashboardSiweExpectation(loginData) })).result, 'VALID');
	assert.equal(h.state.unlinks + h.state.revokes, 0);
});

test('SA-L1 15/16: an expired or foreign-wallet action challenge is rejected', async () => {
	const h = world();
	const session = auth.createDashboardSession(SAFE, Date.now(), 'contract');
	const expired = auth.createActionChallenge(SAFE, 'session-revoke', Date.now() - auth.ACTION_CHALLENGE_TTL_MS - 1000);
	assert.equal((await call(h.handler, { method: 'DELETE', headers: cookie(session), body: { token: expired.token, signature: SIG_OWNER_A } })).statusCode, 403);
	const foreign = auth.createActionChallenge(OTHER_SAFE, 'session-revoke');
	h.state.challenges.set(foreign.data.nonce, { wallet: OTHER_SAFE, expiresAt: foreign.data.exp, used: false });
	assert.equal((await call(h.handler, { method: 'DELETE', headers: cookie(session), body: { token: foreign.token, signature: SIG_OWNER_A } })).statusCode, 403);
	// Ein nur in der Datenbank abgelaufener Eintrag wird beim Verbrauch abgelehnt.
	const late = auth.createActionChallenge(SAFE, 'session-revoke');
	h.state.challenges.set(late.data.nonce, { wallet: SAFE, expiresAt: Date.now() - 1, used: false });
	assert.equal((await call(h.handler, { method: 'DELETE', headers: cookie(session), body: { token: late.token, signature: SIG_OWNER_A } })).statusCode, 409);
	assert.equal(h.state.revokes, 0);
});

test('SA-L1 17/18: RPC failure or an ERC-1271 "no" never performs the action; getCode outage is 503 and keeps the challenge', async () => {
	const down = world({ codeError: new Error('alchemy 503') });
	const session = auth.createDashboardSession(SAFE, Date.now(), 'contract');
	const challenge = await freshAuth(down, session, 'telegram-disconnect');
	const r = await call(down.handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(session), body: { token: challenge.token, signature: SIG_OWNER_A } });
	assert.equal(r.statusCode, 503);
	assert.equal(down.state.unlinks, 0);
	assert.equal([...down.state.challenges.values()].some((c) => c.used), false, 'nicht verbraucht - spaeter erneut moeglich');
	const callDown = world({ callError: new Error('socket hang up') });
	const c2 = await freshAuth(callDown, session, 'session-revoke');
	const r2 = await call(callDown.handler, { method: 'DELETE', headers: cookie(session), body: { token: c2.token, signature: SIG_OWNER_A } });
	assert.notEqual(r2.statusCode, 200);
	assert.equal(callDown.state.revokes, 0);
	const no = world({ owners: ['B'] });
	const c3 = await freshAuth(no, session, 'session-revoke');
	const r3 = await call(no.handler, { method: 'DELETE', headers: cookie(session), body: { token: c3.token, signature: `0x${'cc'.repeat(65)}` } });
	assert.equal(r3.statusCode, 401);
	assert.equal(no.state.revokes, 0);
});

test('SA-L1 19: EOA behaviour is unchanged - no challenge, no new signature, logout and disconnect work as before', async () => {
	const h = world();
	const session = auth.createDashboardSession(EOA.address, Date.now() - 1000, 'eoa');
	const ask = await call(h.handler, { method: 'POST', headers: cookie(session), body: { action: 'session-revoke' } });
	assert.deepEqual(ask.body, { ok: true, freshSignatureRequired: false });
	assert.equal(h.state.challenges.size, 0, 'keine Challenge fuer EOA');
	assert.equal((await call(h.handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(session) })).statusCode, 200);
	assert.equal(h.state.unlinks, 1);
	const out = await call(h.handler, { method: 'DELETE', headers: cookie(session) });
	assert.deepEqual([out.statusCode, out.body.ok], [200, true]);
	assert.equal(h.state.revokes, 1);
	assert.deepEqual(h.state.rpc, [], 'kein RPC fuer EOA');
});

test('SA-L1: sessions issued before this change (no kind) are decided server-side by getCode; an outage requires the fresh signature', async () => {
	const { createHmac } = await import('node:crypto');
	// Token im alten Format: HMAC-gueltig, aber ohne `kind`.
	const legacy = (wallet) => {
		const payload = Buffer.from(JSON.stringify({ type: 'session', wallet: wallet.toLowerCase(), iat: Date.now() - 1000, exp: Date.now() + 6 * DAY })).toString('base64url');
		return `${payload}.${createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('base64url')}`;
	};
	assert.equal(auth.verifyDashboardSession(legacy(SAFE)).kind, undefined);
	const h = world();
	assert.equal((await call(h.handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(legacy(SAFE)) })).statusCode, 403, 'alte Safe-Sitzung: Bestaetigung noetig');
	assert.equal((await call(h.handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(legacy(EOA.address)) })).statusCode, 200, 'alte EOA-Sitzung: wie bisher');
	h.state.contractCheckError = true;
	assert.equal((await call(h.handler, { method: 'POST', headers: cookie(legacy(EOA.address)), body: { action: 'telegram-disconnect' } })).body.freshSignatureRequired, true, 'getCode-Ausfall -> fail closed');
	assert.equal(h.state.unlinks, 1);
});

test('SA-L1: unknown actions, no session, conflicting or revoked sessions get no action challenge', async () => {
	const h = world();
	const session = auth.createDashboardSession(SAFE, Date.now(), 'contract');
	assert.equal((await call(h.handler, { method: 'POST', headers: cookie(session), body: { action: 'transfer' } })).statusCode, 400);
	assert.equal((await call(h.handler, { method: 'POST', body: { action: 'session-revoke' } })).statusCode, 401);
	assert.equal((await call(h.handler, { method: 'POST', headers: { cookie: `${cookie(session).cookie}; ${safeApp(auth.createDashboardSession(OTHER_SAFE, Date.now(), 'contract')).cookie}` }, body: { action: 'session-revoke' } })).statusCode, 401);
	h.state.revokedAt.set(SAFE, Date.now() + 1000);
	assert.equal((await call(h.handler, { method: 'POST', headers: cookie(session), body: { action: 'session-revoke' } })).statusCode, 401);
	assert.equal(h.state.challenges.size, 0);
});

/* =============================================================== SA-L2 */

test('SA-L2 20/23: GET /api/dashboard refuses a revoked COOKIE session with SESSION_REVOKED and reads nothing', async () => {
	const h = world();
	const token = auth.createDashboardSession(SAFE, Date.now() - 5000, 'contract');
	assert.ok(auth.verifyDashboardSession(token), 'strukturell gueltig, nicht abgelaufen');
	h.state.revokedAt.set(SAFE, Date.now() - 1000);
	const r = await call(h.handler, { headers: cookie(token) });
	assert.equal(r.statusCode, 401);
	assert.equal(r.body.code, 'SESSION_REVOKED');
	assert.deepEqual([h.state.covers, h.state.linkStates], [0, 0]);
});

test('SA-L2 21/23: GET /api/dashboard refuses a revoked SAFE-APP-COOKIE session with SESSION_REVOKED and reads nothing', async () => {
	const h = world();
	const token = auth.createDashboardSession(SAFE, Date.now() - 5000, 'contract');
	h.state.revokedAt.set(SAFE, Date.now() - 1000);
	const r = await call(h.handler, { headers: safeApp(token) });
	assert.equal(r.statusCode, 401);
	assert.equal(r.body.code, 'SESSION_REVOKED');
	assert.deepEqual([h.state.covers, h.state.linkStates], [0, 0]);
	// Gegenprobe: eine nach dem Widerruf ausgestellte Sitzung liest.
	assert.equal((await call(h.handler, { headers: safeApp(auth.createDashboardSession(SAFE, Date.now() + 5000, 'contract')) })).statusCode, 200);
});

test('SA-L2 22/23: a revocation lookup failure on GET /api/dashboard is 503 and reads nothing', async () => {
	const h = world();
	h.state.revokedLookupError = true;
	for (const headers of [cookie(auth.createDashboardSession(SAFE, Date.now(), 'contract')), cookie(auth.createDashboardSession(EOA.address, Date.now(), 'eoa')), safeApp(auth.createDashboardSession(SAFE, Date.now(), 'contract'))]) {
		const r = await call(h.handler, { headers });
		assert.equal(r.statusCode, 503);
		assert.equal(r.body.code, 'SESSION_CHECK_UNAVAILABLE');
	}
	assert.deepEqual([h.state.covers, h.state.linkStates], [0, 0]);
});

/* ======================================================= CLIENT / SAFE */

test('SA-L1 client: Safe App confirmation uses only off-chain signing; WalletConnect path uses only personal_sign for the session wallet', async () => {
	const { signSafeMessage } = await import('../web/src/safe-app.js');
	for (const settings of [undefined, {}, { offChainSigning: false }, { offChainSigning: 'true' }]) {
		let signed = 0;
		const sdk = { eth: { setSafeSettings: async () => settings }, txs: { signMessage: async () => { signed++; return { messageHash: '0x1' }; } }, safe: { getOffChainSignature: async () => '0x12' } };
		await assert.rejects(signSafeMessage({ sdk, message: 'm' }));
		assert.equal(signed, 0);
	}
	const main = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');
	const block = main.slice(main.indexOf('let safeContext = null;'), main.indexOf('async function endSession('));
	assert.deepEqual([...block.matchAll(/method: '([a-z_A-Z]+)'/g)].map((m) => m[1]), ['POST', 'personal_sign']);
	assert.doesNotMatch(block, /eth_sendTransaction|eth_signTypedData|wallet_sendCalls|txs\.send|eth_sign'/);
	assert.match(block, /keine Transaktion: keine Übertragung, keine Token-Freigabe\. Diese Aktion braucht eine Off-chain-Signatur/);
	assert.match(block, /not a transaction: no transfer, no token approval\. This action needs an off-chain signature/);
	assert.doesNotMatch(block, /keine Gasgebühr|no gas fee/, 'keine absolute Gas-Aussage fuer Safes');
	assert.match(block, /if \(konto !== expected \|\| normalizeAddress\(modal\.getAddress\(\)\) !== expected\)/, 'nur die angemeldete Wallet');
	assert.match(block, /if \(!confirm\(/, 'nie still im Hintergrund');
});

/* ===================================================== DUAL-RPC (14.10.2026) */

test('DUAL-RPC: ONE compromised provider can neither log in a removed owner nor authorize a destructive action', async () => {
	for (const forge of ['alchemy', 'infura']) {
		const h = world({ owners: ['B'], forge }); // A ist kein Owner; ein Provider luegt "gueltig"
		const login = await safeLogin(h, { sig: SIG_OWNER_A });
		assert.equal(login.statusCode, 401, `${forge}: Login`);
		assert.equal(login.headers['set-cookie'], undefined);
		const session = auth.createDashboardSession(SAFE, Date.now(), 'contract');
		for (const [url, purpose] of [['/api/dashboard?telegram=1', 'telegram-disconnect'], ['/api/dashboard', 'session-revoke']]) {
			const challenge = await freshAuth(h, session, purpose);
			const r = await call(h.handler, { method: 'DELETE', url, headers: cookie(session), body: { token: challenge.token, signature: SIG_OWNER_A } });
			assert.equal(r.statusCode, 401, `${forge}: ${purpose}`);
		}
		assert.equal(h.state.unlinks + h.state.revokes, 0);
		assert.ok(h.state.events.includes('security.erc1271_rpc_disagreement'), `${forge}: Widerspruch gemeldet`);
		assert.ok(!h.state.events.includes('security.siwe_signature_invalid'), 'nicht als gewoehnlicher Fehlversuch verbucht');
		// Ein echter Owner (B) kommt trotz luegendem Provider durch - beide sagen "gueltig".
		assert.equal((await safeLogin(h, { sig: SIG_OWNER_B })).statusCode, 200);
	}
});
