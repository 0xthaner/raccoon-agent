/*
	META-AUDIT M-1 (15.10.2026): veraltete Telegram-Befugnis ueber eine Safe.

	Szenario: Safe S hat die Owner A und B. Chat A wurde verknuepft, solange A
	Owner war; Chat B gehoert Owner B. Dann wird A als Owner entfernt.

	Erwartung:
	- Chat A darf sich selbst abmelden (nur Chat A, nur Benachrichtigungen),
	  aber KEINE wallet-weite Wirkung ausloesen: keine Dashboard-Sitzung der Safe
	  widerrufen, Chat B nicht beruehren, die Safe nicht global trennen.
	- Owner B kann Chat A mit FRISCHER, aktueller Safe-Befugnis (ERC-1271, beide
	  Provider) entfernen.

	Die Safe-Pruefung laeuft ueber den echten Code (SIWE, Dual-RPC-Konsens) gegen
	eine simulierte Safe; an der Befugnisgrenze wird nichts als VALID eingesetzt.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hashMessage, isAddress } from 'viem';
import { simChain, dualProviders, ownerSignature } from '../test-support/dual-rpc-sim.mjs';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';
import { fakePostgrest } from '../test-support/fake-postgrest.mjs';

process.env.APP_BASE_URL = 'https://coverraccoon.com';
process.env.DASHBOARD_SESSION_SECRET = 'telegram-stale-authority-secret-0123456789abcdef';
delete process.env.TELEGRAM_BOT_TOKEN;

const auth = await import('../src/dashboard-auth.mjs');
const { verifyWalletSiweAuthority, noContractCodeByQuorum } = await import('../src/contract-signature.mjs');

const SAFE = '0x5afe00000000000000000000000000000000a00a';
const EOA = '0x1111111111111111111111111111111111111111';
const CHAT_A = '1001'; // gehoert dem entfernten Owner A
const CHAT_B = '2002'; // gehoert dem aktuellen Owner B
const HEAD = 20_000_000n;

/* Kette: A wurde VOR dem gemeinsamen Pruefblock entfernt; B ist Owner. */
const chain = () => simChain({ head: HEAD, safes: { [SAFE]: { history: [
	{ from: 0n, owners: ['a1', 'b2'], threshold: 1 },
	{ from: HEAD - 100n, owners: ['b2'], threshold: 1 }
] } } });

/* In-Memory-Abbild der Tabellen mit denselben Schluesseln wie die Datenbank. */
function store() {
	const s = {
		monitored: [
			{ chat_id: CHAT_A, wallet: SAFE, is_primary: true, alerts_enabled: true },
			{ chat_id: CHAT_B, wallet: SAFE, is_primary: true, alerts_enabled: true },
			{ chat_id: CHAT_A, wallet: EOA, is_primary: false, alerts_enabled: true }
		],
		remembered: [],
		revoked: [],
		attributions: [{ wallet: SAFE, deployment_key: 'aave-v3-ethereum-core', cover_id: 1 }],
		sent: []
	};
	const helpers = {
		getMonitoredWallets: async (chatId) => s.monitored.filter((r) => r.chat_id === String(chatId)).map((r) => ({ ...r })),
		unlinkWallet: async (chatId) => { const n = s.monitored.length; s.monitored = s.monitored.filter((r) => r.chat_id !== String(chatId)); return s.monitored.length < n; },
		rememberUnlinkedWallet: async (chatId, wallet) => { if (!s.remembered.some((r) => r.chat_id === String(chatId) && r.wallet === wallet)) s.remembered.push({ chat_id: String(chatId), wallet }); },
		getRememberedWallets: async (chatId) => s.remembered.filter((r) => r.chat_id === String(chatId)).map((r) => r.wallet),
		forgetRememberedWallet: async (chatId) => { s.remembered = s.remembered.filter((r) => r.chat_id !== String(chatId)); },
		revokeDashboardSessions: async (wallet) => { s.revoked.push(wallet.toLowerCase()); return Date.now(); },
		// Wie src/db.mjs auf 4f55789: nur bei GENAU einem Chat.
		unlinkWalletByWallet: async (wallet) => {
			const matches = s.monitored.filter((r) => r.wallet === wallet.toLowerCase());
			if (matches.length !== 1) return [];
			s.monitored = s.monitored.filter((r) => r !== matches[0]);
			return [{ chat_id: matches[0].chat_id }];
		},
		unlinkWalletFromAllChats: async (wallet) => {
			const matches = s.monitored.filter((r) => r.wallet === wallet.toLowerCase());
			s.monitored = s.monitored.filter((r) => r.wallet !== wallet.toLowerCase());
			return matches.map((r) => ({ chat_id: r.chat_id }));
		}
	};
	const reminderChats = (wallet) => s.monitored.filter((r) => r.wallet === wallet && r.alerts_enabled).map((r) => r.chat_id).sort();
	return { s, helpers, reminderChats };
}

/* Die echten Bot-Funktionen (Quelltext von src/bot.mjs) mit injizierten Abhaengigkeiten. */
function loadBot(helpers, providers) {
	const source = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
	const start = source.indexOf('async function unlinkTelegramFor(');
	const end = source.indexOf('async function confirmWalletUnlink(');
	const deps = {
		...helpers,
		noContractCodeByQuorum: (wallet) => noContractCodeByQuorum(wallet, { providers }),
		sendMessage: async (chatId, text) => { helpers.__sent?.push([String(chatId), text]); },
		navigationKeyboard: () => ({})
	};
	return new Function(...Object.keys(deps), `${source.slice(start, end)}\nreturn { unlinkTelegramFor, unlinkWalletFor };`)(...Object.values(deps));
}

/* Der echte Dashboard-Handler mit echter SIWE- und Dual-RPC-Pruefung. */
function loadDashboard(helpers, providers, state) {
	const source = readFileSync(new URL('../api/dashboard.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
	const challenges = new Map();
	const deps = {
		isAddress, queryParams, singleQueryValue, ...auth,
		verifyWalletSiweAuthority: (params) => verifyWalletSiweAuthority(params, { providers }),
		noContractCodeByQuorum: (wallet) => noContractCodeByQuorum(wallet, { providers }),
		isDeployedContract: async () => true,
		getWalletCovers: async () => ({ covers: [] }), getWalletLinkStateByWallet: async () => ({ linked: true, link: null }),
		storeDashboardChallenge: async ({ nonce, wallet, expiresAt }) => { challenges.set(nonce, { wallet: wallet.toLowerCase(), expiresAt, used: false }); },
		consumeDashboardChallenge: async (nonce, wallet) => { const row = challenges.get(nonce); if (!row || row.used || row.wallet !== wallet.toLowerCase() || row.expiresAt <= Date.now()) return false; row.used = true; return true; },
		isDashboardSessionRevoked: async () => false, recordAgentEvent: async () => {}, consumeDashboardAccess: async () => null,
		getLanguage: async () => 'de', beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}, enforceRateLimit: async () => true, enforceRateLimitFor: async () => true,
		requireSameOrigin: () => true, requireJson: () => true,
		recordSecurityEvent: async (type) => { state.events.push(type); }, securityFingerprint: () => 'fp',
		SECURITY_EVENT: { ERC1271_RPC_DISAGREEMENT: 'security.erc1271_rpc_disagreement', SIWE_SIGNATURE_INVALID: 'security.siwe_signature_invalid', SIWE_REPLAY_BLOCKED: 'security.siwe_replay_blocked' },
		...helpers // injizierte (echte) Helfer gewinnen gegen die Attrappen oben
	};
	return new Function(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps));
}
const res = () => ({ statusCode: null, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.body = b; return this; } });
async function call(handler, { method = 'GET', url = '/api/dashboard', headers = {}, body } = {}) {
	const r = res();
	await handler({ method, url, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body }, r);
	return r;
}
const cookie = (wallet) => ({ cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(wallet, Date.now(), 'contract'))}` });

/** Owner B holt eine Aktions-Challenge und laesst sie von `owners` der Safe signieren. */
async function freshSafeAuthorization(handler, purpose, owners) {
	const ask = await call(handler, { method: 'POST', headers: cookie(SAFE), body: { action: purpose } });
	assert.equal(ask.statusCode, 200, JSON.stringify(ask.body));
	assert.equal(ask.body.freshSignatureRequired, true);
	return { token: ask.body.token, signature: ownerSignature(owners, hashMessage(ask.body.message)), message: ask.body.message };
}

/* ====================================================== Reproduktion M-1 */

test('M-1 (Telegram): the removed owner\'s chat triggers "fully disconnect" - no wallet-wide effect on the Safe', async () => {
	const { s, helpers, reminderChats } = store();
	const { providers } = dualProviders(chain());
	const bot = loadBot(helpers, providers);
	await bot.unlinkWalletFor(CHAT_A, 'de');
	assert.ok(!s.revoked.includes(SAFE), 'T1: keine Dashboard-Sitzung der Safe widerrufen');
	assert.deepEqual(reminderChats(SAFE), [CHAT_B], 'T2/T3/T6: Chat B bleibt, nur Chat A ist weg');
	assert.equal(s.attributions.length, 1, 'T16: App-Zuordnungen unberuehrt');
});

test('M-1 (Dashboard): current owner B with fresh ERC-1271 authority removes the stale chat A', async () => {
	const { helpers, reminderChats } = store();
	const { providers } = dualProviders(chain());
	const state = { events: [] };
	const handler = loadDashboard(helpers, providers, state);
	const authz = await freshSafeAuthorization(handler, 'telegram-disconnect', ['b2']);
	const r = await call(handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(SAFE), body: { token: authz.token, signature: authz.signature } });
	assert.equal(r.statusCode, 200, JSON.stringify(r.body));
	assert.deepEqual(reminderChats(SAFE), [], 'T7: alle Telegram-Chats der Safe getrennt, auch der veraltete Chat A');
});

/* ============================================ T1-T16 mit den ECHTEN DB-Helfern */

const db = await import('../src/db.mjs');
const OTHER_SAFE = '0x5afe00000000000000000000000000000000b00b';

/** Echte Tabellenzeilen; die echten Helfer aus src/db.mjs laufen dagegen. */
function world({ providerA = {}, providerB = {} } = {}) {
	const row = (chat_id, wallet, is_primary) => ({ chat_id, wallet, label: 'W', is_primary, alerts_enabled: true, alert_thresholds: [7, 3, 1], weekly_summary: false, linked_at: '2026-10-01T00:00:00Z' });
	const client = fakePostgrest({
		monitored_wallets: [row(CHAT_A, SAFE, true), row(CHAT_A, EOA, false), row(CHAT_B, SAFE, true)],
		wallet_links: [{ chat_id: CHAT_A, wallet: SAFE, alerts_enabled: true }, { chat_id: CHAT_B, wallet: SAFE, alerts_enabled: true }],
		pending_links: [],
		user_preferences: [{ chat_id: CHAT_A, language: 'de' }, { chat_id: CHAT_B, language: 'en' }],
		position_cover_attributions: [{ wallet: SAFE, deployment_key: 'aave-v3-ethereum-core', cover_id: 1, source: 'user_confirmed' }]
	});
	const revokedAt = new Map();
	const revokes = [];
	const helpers = {
		getMonitoredWallets: (chatId) => db.getMonitoredWallets(chatId, { client }),
		unlinkWallet: (chatId) => db.unlinkWallet(chatId, { client }),
		rememberUnlinkedWallet: (chatId, wallet) => db.rememberUnlinkedWallet(chatId, wallet, { client }),
		getRememberedWallets: (chatId) => db.getRememberedWallets(chatId, { client }),
		forgetRememberedWallet: (chatId) => db.forgetRememberedWallet(chatId, { client }),
		unlinkWalletByWallet: (wallet) => db.unlinkWalletByWallet(wallet, { client }),
		unlinkWalletFromAllChats: (wallet) => db.unlinkWalletFromAllChats(wallet, { client }),
		revokeDashboardSessions: async (wallet) => { const now = Date.now(); revokes.push(wallet.toLowerCase()); revokedAt.set(wallet.toLowerCase(), now); return now; },
		isDashboardSessionRevoked: async (wallet, iat) => { const cut = revokedAt.get(wallet.toLowerCase()); return cut != null && iat <= cut; }
	};
	const { providers } = dualProviders(chain(), providerA, providerB);
	const subs = async () => (await db.listAlertSubscriptions({ client })).map((s) => `${s.chat_id}:${s.wallet}`).sort();
	return { client, helpers, providers, revokes, subs, state: { events: [] } };
}
const timeout = () => { throw new Error('The request took too long to respond.'); };

test('T1/T2/T3/T6/T15/T16: removed owner A\'s chat "fully disconnects" - only chat A is affected, nothing wallet-wide', async () => {
	const w = world();
	const sessionBefore = auth.createDashboardSession(SAFE, Date.now() - 1000, 'contract');
	await loadBot(w.helpers, w.providers).unlinkWalletFor(CHAT_A, 'de');
	assert.ok(!w.revokes.includes(SAFE), 'T1: keine Safe-Sitzung widerrufen');
	assert.deepEqual(await w.subs(), [`${CHAT_B}:${SAFE}`], 'T2/T3/T6: nur Chat B bleibt - Safe nicht global getrennt, Chat B unberuehrt');
	assert.deepEqual(w.client.rows('wallet_links').map((r) => r.chat_id), [CHAT_B], 'Chat B behaelt seine Primaer-Verknuepfung');
	assert.equal(w.client.rows('position_cover_attributions').length, 1, 'T16: App-Zuordnungen unveraendert');
	const handler = loadDashboard(w.helpers, w.providers, w.state);
	assert.equal((await call(handler, { headers: { cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(sessionBefore)}` } })).statusCode, 200, 'T15: bestehende Safe-Sitzung liest weiter');
	assert.ok(w.revokes.includes(EOA), 'T14: die EOA desselben Chats wird wie bisher wallet-weit abgemeldet');
});

test('T4/T5: chat A can unlink only itself and then gets no reminders - via "Telegram trennen" and later "fully disconnect"', async () => {
	const w = world();
	const bot = loadBot(w.helpers, w.providers);
	await bot.unlinkTelegramFor(CHAT_A, 'de');
	assert.deepEqual(await w.subs(), [`${CHAT_B}:${SAFE}`], 'T5: keine Erinnerung mehr an Chat A');
	assert.deepEqual((await db.getRememberedWallets(CHAT_A, { client: w.client })).sort(), [EOA, SAFE].sort(), 'Chat A merkt sich nur seine eigenen Wallets');
	// Spaeter (Owner A ist laengst entfernt): die gemerkte Safe gibt KEINE Befugnis.
	await bot.unlinkWalletFor(CHAT_A, 'de');
	assert.ok(!w.revokes.includes(SAFE), 'gemerkte Safe: kein Widerruf');
	assert.deepEqual(await db.getRememberedWallets(CHAT_A, { client: w.client }), [], 'Merkzeilen von Chat A geloescht');
	assert.deepEqual(await w.subs(), [`${CHAT_B}:${SAFE}`]);
});

test('T7 (+T5/T6): current owner B with fresh dual-RPC ERC-1271 authority removes ALL chats of the Safe incl. stale chat A; other wallets stay', async () => {
	const w = world();
	const handler = loadDashboard(w.helpers, w.providers, w.state);
	const authz = await freshSafeAuthorization(handler, 'telegram-disconnect', ['b2']);
	const r = await call(handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(SAFE), body: { token: authz.token, signature: authz.signature } });
	assert.equal(r.statusCode, 200);
	assert.equal(r.body.disconnected, true);
	assert.deepEqual(await w.subs(), [`${CHAT_A}:${EOA}`], 'Safe aus beiden Chats; die EOA in Chat A bleibt');
	assert.deepEqual(w.client.rows('wallet_links').map((r2) => `${r2.chat_id}:${r2.wallet}`), [`${CHAT_A}:${EOA}`], 'Chat A: Primaer-Wallet neu ausgerichtet, Chat B: keine Verknuepfung mehr');
	assert.deepEqual(w.client.rows('pending_links').filter((p) => p.chat_id.startsWith('unlinked:')), [], 'keine Merkzeilen fuer entfernte Chats');
	assert.equal(w.revokes.length, 0, 'Telegram trennen widerruft keine Sitzungen');
	// T9: dieselbe Bestaetigung noch einmal -> 409
	const again = await call(handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(SAFE), body: { token: authz.token, signature: authz.signature } });
	assert.equal(again.statusCode, 409);
});

test('T8: the removed owner\'s (or a stranger\'s) signature cannot remove chat A - ERC-1271 says no', async () => {
	for (const owners of [['a1'], ['c3']]) {
		const w = world();
		const handler = loadDashboard(w.helpers, w.providers, w.state);
		const authz = await freshSafeAuthorization(handler, 'telegram-disconnect', owners);
		const r = await call(handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(SAFE), body: { token: authz.token, signature: authz.signature } });
		assert.equal(r.statusCode, 401, owners.join());
		assert.deepEqual(await w.subs(), [`${CHAT_A}:${EOA}`, `${CHAT_A}:${SAFE}`, `${CHAT_B}:${SAFE}`].sort());
	}
});

test('T9: an expired action challenge cannot remove chat A', async () => {
	const w = world();
	const handler = loadDashboard(w.helpers, w.providers, w.state);
	const expired = auth.createActionChallenge(SAFE, 'telegram-disconnect', Date.now() - auth.ACTION_CHALLENGE_TTL_MS - 1000);
	const r = await call(handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(SAFE), body: { token: expired.token, signature: ownerSignature(['b2'], hashMessage(expired.message)) } });
	assert.equal(r.statusCode, 403);
	assert.equal((await w.subs()).length, 3);
});

test('T10: wrong-purpose authorizations cannot remove chat A (session-revoke, dashboard login, Telegram-link text)', async () => {
	const w = world();
	const handler = loadDashboard(w.helpers, w.providers, w.state);
	const revoke = await freshSafeAuthorization(handler, 'session-revoke', ['b2']);
	assert.equal((await call(handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(SAFE), body: { token: revoke.token, signature: revoke.signature } })).statusCode, 403, 'session-revoke');
	const login = auth.createDashboardChallenge(SAFE, Date.now(), auth.DASHBOARD_CHALLENGE_TTL_CONTRACT_MS);
	assert.equal((await call(handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(SAFE), body: { token: login.token, signature: ownerSignature(['b2'], hashMessage(login.message)) } })).statusCode, 403, 'Login-Challenge');
	// Echte Aktions-Challenge, aber die Owner-Signatur gilt dem Login- bzw. einem Telegram-Link-Text.
	const tg = await freshSafeAuthorization(handler, 'telegram-disconnect', ['b2']);
	const { signingMessage } = await import('../src/linking.mjs');
	const linkText = signingMessage({ wallet: SAFE, nonce: 'ab'.repeat(16), expiresAt: Date.now() + 540_000, code: 'X'.repeat(24), target: '@owner_b' });
	for (const text of [login.message, linkText]) {
		const r = await call(handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(SAFE), body: { token: tg.token, signature: ownerSignature(['b2'], hashMessage(text)) } });
		assert.equal(r.statusCode, 401);
	}
	assert.equal((await w.subs()).length, 3);
});

test('T11: an authorization for another wallet cannot remove chat A', async () => {
	const w = world();
	const handler = loadDashboard(w.helpers, w.providers, w.state);
	const foreign = auth.createActionChallenge(OTHER_SAFE, 'telegram-disconnect');
	const r = await call(handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(SAFE), body: { token: foreign.token, signature: ownerSignature(['b2'], hashMessage(foreign.message)) } });
	assert.equal(r.statusCode, 403);
	assert.equal((await w.subs()).length, 3);
});

test('T12: ONE malicious provider forging ERC-1271 success cannot authorize removing chat A', async () => {
	const forge = { behave: { eth_call: () => `0x1626ba7e${'0'.repeat(56)}` } };
	for (const which of ['A', 'B']) {
		const w = world(which === 'A' ? { providerA: forge } : { providerB: forge });
		const handler = loadDashboard(w.helpers, w.providers, w.state);
		const authz = await freshSafeAuthorization(handler, 'telegram-disconnect', ['c3']); // kein Owner
		const r = await call(handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(SAFE), body: { token: authz.token, signature: authz.signature } });
		assert.equal(r.statusCode, 401, which);
		assert.equal((await w.subs()).length, 3);
		assert.ok(w.state.events.includes('security.erc1271_rpc_disagreement'));
	}
});

test('T13: a dual-RPC outage fails closed - nothing removed, nothing revoked', async () => {
	const w = world({ providerB: { behave: { eth_getCode: timeout } } });
	const handler = loadDashboard(w.helpers, w.providers, w.state);
	const authz = await freshSafeAuthorization(handler, 'telegram-disconnect', ['b2']);
	const r = await call(handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: cookie(SAFE), body: { token: authz.token, signature: authz.signature } });
	assert.equal(r.statusCode, 503);
	assert.equal((await w.subs()).length, 3);
	// Bot bei Ausfall: kein Widerruf - auch nicht fuer die EOA (fail closed), nur chat-lokal.
	await loadBot(w.helpers, w.providers).unlinkWalletFor(CHAT_A, 'de');
	assert.deepEqual(w.revokes, []);
	assert.deepEqual(await w.subs(), [`${CHAT_B}:${SAFE}`]);
});

test('T14: EOA behaviour (documented) - dashboard "Telegram trennen" still only for exactly one chat, no new signature; bot revokes EOA sessions', async () => {
	const w = world();
	const handler = loadDashboard(w.helpers, w.providers, w.state);
	const eoaCookie = { cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(EOA, Date.now(), 'eoa'))}` };
	const r = await call(handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: eoaCookie });
	assert.equal(r.statusCode, 200);
	assert.deepEqual(await w.subs(), [`${CHAT_A}:${SAFE}`, `${CHAT_B}:${SAFE}`], 'EOA nur in Chat A -> getrennt, ohne Signatur');
	// EOA in zwei Chats: wie bisher keine Wirkung vom Dashboard (Trennung im jeweiligen Chat).
	await w.client.from('monitored_wallets').insert([{ chat_id: CHAT_A, wallet: EOA, is_primary: false, alerts_enabled: true }, { chat_id: CHAT_B, wallet: EOA, is_primary: false, alerts_enabled: true }]);
	const twice = await call(handler, { method: 'DELETE', url: '/api/dashboard?telegram=1', headers: eoaCookie });
	assert.equal(twice.body.disconnected, false);
	assert.equal((await w.subs()).filter((s) => s.endsWith(EOA)).length, 2);
});

test('M-1: no Telegram code path reaches revokeDashboardSessions without the EOA quorum', () => {
	const source = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
	const calls = [...source.matchAll(/revokeDashboardSessions\(/g)].length;
	assert.equal(calls, 1, 'genau eine Aufrufstelle');
	assert.match(source, /const revokable = walletAddresses\.filter\(\(_, i\) => allowed\[i\]\);\n\tconst chatOnly = walletAddresses\.length - revokable\.length;\n\tawait Promise\.all\(revokable\.map\(\(item\) => revokeDashboardSessions\(item\)\)\);/);
});
