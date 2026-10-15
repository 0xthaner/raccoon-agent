/*
	META-AUDIT M-3, Modus B (15.10.2026): ONCHAIN_SAFE_MESSAGE_APPROVAL - NUR fuer
	den Dashboard-Login.

	Safe{Wallet} kann eine Signaturanfrage in seine Standard-On-chain-Bestaetigung
	umwandeln (SignMessageLib.signMessage per DelegateCall, value 0, Ziel von Safe
	gewaehlt; ReviewSignMessageOnChain.tsx, safe-wallet-monorepo @dab2bd9). Dann
	gibt es keine Signatur: die Safe App bekommt { safeTxHash } statt messageHash,
	WalletConnect bekommt '0x' (safe-wallet-provider/index.ts). Bisher blieb der
	Login dort haengen, obwohl die Owner Gas bezahlt hatten.

	Modus B: der Browser meldet nur "Safe hat on-chain gestartet" und fragt den
	Server read-only ab - ohne Signatur, ohne Hash. Der Server rekonstruiert die
	gespeicherte Dashboard-Challenge, berechnet hashMessage(dashboardMessage)
	selbst, setzt die LEERE ERC-1271-Signatur selbst und verlangt VALID von BEIDEN
	Providern am gemeinsamen Block. Erst dann: Nonce atomar verbrauchen, 24-h-
	Contract-Sitzung. Modus B erzeugt ausschliesslich eine Dashboard-Sitzung.

	Gegen die ECHTEN Handler (api/dashboard.mjs, api/link/verify.mjs) und die
	echte Dual-RPC-Pruefung auf der simulierten Kette (test-support/dual-rpc-sim.mjs).
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hashMessage, isAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { simChain, dualProviders, ownerSignature, executeSignMessageLib } from '../test-support/dual-rpc-sim.mjs';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';

process.env.APP_BASE_URL = 'https://coverraccoon.com';
process.env.DASHBOARD_SESSION_SECRET = 'onchain-safe-login-secret-0123456789abcdef';
delete process.env.TELEGRAM_BOT_TOKEN;

const auth = await import('../src/dashboard-auth.mjs');
const linking = await import('../src/linking.mjs');
const cs = await import('../src/contract-signature.mjs');
const { runSafeLogin } = await import('../web/src/safe-app.js');
const { guardedChallengeSignSubmit, eoaLoginTexts } = await import('../web/src/eoa-login.js');
const onchainLogin = await import('../web/src/onchain-login.js').catch(() => ({}));

const SAFE = '0x5afe00000000000000000000000000000000a00a';
const OTHER_SAFE = '0x5afe00000000000000000000000000000000b00b';
const SIGN_MESSAGE_LIB = '0xd53cd0ab83d845ac265be939c57f53ad838012c9'; // Safe v1.4.1 (safe-deployments); nur Kennzeichnung im Modell
const HEAD = 20_000_000n;
const DAY = 24 * 60 * 60_000;
const texts = eoaLoginTexts('de');

function freshChain() {
	return simChain({ head: HEAD, safes: {
		[SAFE]: { history: [{ from: 0n, owners: ['b2'], threshold: 1 }] },
		[OTHER_SAFE]: { history: [{ from: 0n, owners: ['b2'], threshold: 1 }] }
	} });
}

/* ------------------------------------------------------- Safe{Wallet}-Modell */

/*
	Entscheidung wie useSafeWalletProvider / useCustomAppCommunicator (@dab2bd9):
	off-chain nur, wenn die Safe es unterstuetzt UND der Nutzer-Schalter "Always use
	on-chain signatures" aus ist; sonst SignMessageOnChainFlow -> Vorschlag einer
	SignMessageLib-Transaktion, die die Owner ausfuehren. Gezaehlt wird, was Safe
	erzeugt und was CoverRaccoon anfragt.
*/
function safeWallet(chain, { onchain }) {
	const state = { signRequests: 0, proposals: [], appTxRequests: 0, settings: { offChainSigning: true }, pending: null };
	const sign = (message) => {
		state.signRequests++;
		if (onchain) {
			state.proposals.push({ to: SIGN_MESSAGE_LIB, value: '0', operation: 1, data: hashMessage(message), message });
			return null;
		}
		return ownerSignature(['b2'], hashMessage(message));
	};
	const sdk = {
		safe: {
			getInfo: async () => ({ safeAddress: SAFE, chainId: 1, threshold: 1, owners: [], isReadOnly: false }),
			getOffChainSignature: async (hash) => (state.pending?.hash === hash ? state.pending.signature : '')
		},
		eth: { setSafeSettings: async ([requested]) => { state.settings = { ...state.settings, offChainSigning: !!requested.offChainSigning }; return { ...state.settings }; } },
		txs: {
			signMessage: async (message) => {
				const signature = sign(message);
				if (!signature) return { safeTxHash: `0x${'5a'.repeat(32)}` };
				state.pending = { hash: hashMessage(message), signature };
				return { messageHash: hashMessage(message) };
			},
			send: async () => { state.appTxRequests++; throw new Error('CoverRaccoon darf keine Transaktion anfragen'); },
			signTypedMessage: async () => { state.appTxRequests++; throw new Error('kein Typed Data'); }
		}
	};
	const walletConnect = { request: async ({ method, params }) => {
		if (method !== 'personal_sign') { state.appTxRequests++; throw new Error(`unexpected ${method}`); }
		return sign(params[0]) ?? '0x';
	} };
	/** Die Owner fuehren den von Safe erzeugten Vorschlag aus (nicht CoverRaccoon). */
	const execute = () => { for (const p of state.proposals.splice(0)) executeSignMessageLib(chain, SAFE, p.message); };
	return { state, sdk, walletConnect, execute };
}

/* --------------------------------------------------------- echte Handler */

const res = () => ({ statusCode: null, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, json(b) { this.body = b; return this; } });
const strip = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^import [^;]*;\n/gm, '').replace('export default async function handler', 'async function handler');
const load = (path, deps) => new Function(...Object.keys(deps), `${strip(path)}\nreturn handler;`)(...Object.values(deps));

function server({ chain = freshChain(), alchemy = {}, infura = {}, limits = {} } = {}) {
	const { providers, logs } = dualProviders(chain, alchemy, infura);
	const challenges = new Map();
	const events = [];
	const rateCalls = [];
	const revokedAt = { value: null };
	const limited = async (response, scope) => {
		rateCalls.push(scope);
		if (limits[scope] === 0) { response.status(429).json({ ok: false, error: 'Too many requests. Please try again later.' }); return false; }
		return true;
	};
	const db = {
		storeDashboardChallenge: async ({ nonce, wallet, expiresAt }) => { challenges.set(nonce, { wallet: wallet.toLowerCase(), expiresAt, used: false }); },
		consumeDashboardChallenge: async (nonce, wallet) => { const row = challenges.get(nonce); if (!row || row.used || row.wallet !== wallet.toLowerCase() || row.expiresAt <= Date.now()) return false; row.used = true; return true; },
		isDashboardChallengeOpen: async (nonce, wallet) => { const row = challenges.get(nonce); return Boolean(row && !row.used && row.wallet === wallet.toLowerCase() && row.expiresAt > Date.now()); }
	};
	const shared = {
		isAddress, queryParams, singleQueryValue,
		verifyWalletSiweAuthority: (params) => cs.verifyWalletSiweAuthority(params, { providers }),
		verifyWalletSiweSignature: (params) => cs.verifyWalletSiweSignature(params, { providers }),
		noContractCodeByQuorum: (wallet) => cs.noContractCodeByQuorum(wallet, { providers }),
		verifyOnchainDashboardLoginApproval: (params) => cs.verifyOnchainDashboardLoginApproval(params, { providers }),
		isDeployedContract: async (wallet) => (await cs.noContractCodeByQuorum(wallet, { providers })) === false,
		enforceRateLimit: async (request, response, scope) => limited(response, scope),
		enforceRateLimitFor: async (response, scope) => limited(response, scope),
		recordSecurityEvent: async (type) => { events.push(type); }, securityFingerprint: () => 'fp',
		SECURITY_EVENT: { ERC1271_RPC_DISAGREEMENT: 'disagreement', SIWE_SIGNATURE_INVALID: 'invalid', SIWE_REPLAY_BLOCKED: 'replay', ACCESS_CODE_INVALID: 'access', LINK_SIGNATURE_INVALID: 'link-invalid', LINK_REPLAY_BLOCKED: 'link-replay' },
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}, requireSameOrigin: () => true, requireJson: () => true
	};
	const dashboard = load('../api/dashboard.mjs', {
		...auth, ...shared, ...db,
		getWalletCovers: async () => ({ covers: [] }), getWalletLinkStateByWallet: async () => ({ linked: false, link: null }),
		isDashboardSessionRevoked: async (wallet, iat) => revokedAt.value !== null && iat <= revokedAt.value, recordAgentEvent: async () => {}, consumeDashboardAccess: async () => null,
		getLanguage: async () => 'de', beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		revokeDashboardSessions: async () => { revokedAt.value = Date.now(); return revokedAt.value; },
		unlinkWalletByWallet: async () => [{ chat_id: '1' }], unlinkWalletFromAllChats: async () => [{ chat_id: '1' }]
	});
	const LINK_CODE = 'SafeLinkCodeForM3_012345';
	const linkRow = { code: LINK_CODE, chat_id: '123456789', nonce: 'ab'.repeat(16), expires_at: Date.now() + 540_000, used_at: null };
	const linked = [];
	const linkVerify = load('../api/link/verify.mjs', {
		...shared,
		getPendingLink: async (code) => (code === LINK_CODE ? linkRow : null),
		consumePendingLink: async (code, wallet) => { linked.push(wallet); return { status: 'linked', chatId: linkRow.chat_id }; },
		getLanguage: async () => 'de', newDashboardAccess: async () => 'x',
		isTelegramLinkCode: linking.isTelegramLinkCode, isTelegramLinkRow: linking.isTelegramLinkRow,
		linkSiweExpectation: linking.linkSiweExpectation, signingMessage: linking.signingMessage,
		telegramTarget: async () => ({ username: 'owner_b', name: 'B', target: '@owner_b' })
	});
	const linkMessage = (wallet) => linking.signingMessage({ wallet, nonce: linkRow.nonce, expiresAt: linkRow.expires_at, code: LINK_CODE, target: '@owner_b' });
	return { chain, dashboard, linkVerify, linkMessage, LINK_CODE, linked, challenges, events, logs, rateCalls, revokedAt };
}

async function call(handler, url, init = {}) {
	const r = res();
	const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
	await handler({ method: init.method ?? 'GET', url, headers, body: init.body }, r);
	return r;
}
/** Der vom Server gesetzte, unveraenderte Safe-App-Cookie-Wert (fuer Folgeanfragen). */
function safeAppCookieFrom(headers) {
	const c = [].concat(headers['set-cookie'] ?? []).find((x) => x.startsWith('__Host-raccoon_safeapp=') && !x.includes('Max-Age=0'));
	return c ? c.slice(0, c.indexOf(';')) : null;
}
/** Die vom Server gesetzte Safe-App-Sitzung (partitioniertes Cookie) aus den Antwort-Headern. */
function safeAppSessionFrom(headersList) {
	for (const headers of headersList) {
		for (const c of [].concat(headers['set-cookie'] ?? [])) {
			if (c.startsWith('__Host-raccoon_safeapp=') && !c.includes('Max-Age=0')) return auth.verifyDashboardSession(decodeURIComponent(c.slice(c.indexOf('=') + 1, c.indexOf(';'))));
		}
	}
	return null;
}
function fetchVia(handler) {
	return async (url, init = {}) => {
		const r = await call(handler, url, { ...init, body: init.body ? JSON.parse(init.body) : undefined });
		return { ok: r.statusCode < 400, status: r.statusCode, headers: r.headers, json: async () => r.body };
	};
}
const getChallenge = async (srv, wallet = SAFE) => (await call(srv.dashboard, `/api/dashboard?wallet=${wallet}`)).body;
const postOnchain = (srv, body) => call(srv.dashboard, '/api/dashboard', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard-transport': 'partitioned-cookie' }, body });
const rpcCalls = (srv) => srv.logs.alchemy.length + srv.logs.infura.length;
function sessionOf(r) {
	const cookie = String(r.headers['set-cookie'] ?? '');
	const raw = r.body?.sessionToken ?? decodeURIComponent((cookie.match(new RegExp(`${auth.SESSION_COOKIE}=([^;]+)`)) ?? [])[1] ?? '');
	return raw ? auth.verifyDashboardToken(raw) : null;
}
const challengeOf = (srv, token) => srv.challenges.get(auth.verifyDashboardToken(token).nonce);

/* ================================================ 1: Baseline / Ablauf */

test('1 Safe App, on-chain path: Safe creates only its SignMessageLib proposal; after the owners execute it, the login completes', async () => {
	const srv = server();
	const wallet = safeWallet(srv.chain, { onchain: true });
	const states = [];
	let waits = 0;
	const seen = [];
	const base = fetchVia(srv.dashboard);
	const result = await runSafeLogin({
		sdk: wallet.sdk, info: await wallet.sdk.safe.getInfo(), fetchFn: async (u, i) => { const r = await base(u, i); seen.push(r.headers); return r; }, onState: (s) => states.push(s),
		pollIntervalMs: 1, pollTimeoutMs: 60_000,
		waitFn: async () => { if (++waits === 2) wallet.execute(); }
	});
	assert.equal(wallet.state.signRequests, 1, 'genau eine Signaturanfrage');
	assert.equal(wallet.state.appTxRequests, 0, 'CoverRaccoon fragt keine Transaktion an');
	assert.ok(states.includes('ONCHAIN_APPROVAL_PENDING'));
	assert.ok(states.includes('AUTHENTICATED'));
	// Safe-App-Sitzung: kein Token im Ergebnis, die Sitzung steckt im partitionierten Cookie.
	assert.equal('sessionToken' in result, false);
	const session = safeAppSessionFrom(seen);
	assert.equal(session.kind, 'contract');
	assert.equal(session.exp - session.iat, DAY);
});

test('1 WalletConnect, on-chain path: personal_sign returns 0x, the client switches to read-only polling and logs in after execution', async () => {
	const srv = server();
	const wallet = safeWallet(srv.chain, { onchain: true });
	const posts = [];
	const fetchFn = fetchVia(srv.dashboard);
	const spy = async (url, init = {}) => { if (init.method === 'POST') posts.push(JSON.parse(init.body)); return fetchFn(url, init); };
	let waits = 0;
	const result = await guardedChallengeSignSubmit({
		texts,
		getChallenge: () => spy(`/api/dashboard?wallet=${SAFE}`).then((r) => r.json()),
		sign: (m) => wallet.walletConnect.request({ method: 'personal_sign', params: [m, SAFE] }),
		submit: (challenge, signature) => onchainLogin.submitDashboardLogin({ wallet: SAFE, token: challenge.token, signature, fetchFn: spy, intervalMs: 1, timeoutMs: 60_000, waitFn: async () => { if (++waits === 2) wallet.execute(); } })
	});
	assert.equal(result.ok, true);
	assert.equal(wallet.state.appTxRequests, 0);
	for (const body of posts) {
		assert.equal(body.signature, undefined, 'der Browser sendet nie 0x als Signatur');
		assert.deepEqual(Object.keys(body).sort(), ['approval', 'token', 'wallet']);
	}
	assert.ok(posts.length >= 2, 'mindestens eine PENDING-Abfrage, dann der Login');
});

/* ======================================== 2: Off-chain-Safe unveraendert */

test('2 off-chain Safe login (Safe App and WalletConnect) is unchanged: one signature, mode A, 24 h contract session', async () => {
	const srv = server();
	const wallet = safeWallet(srv.chain, { onchain: false });
	const fetchFn = fetchVia(srv.dashboard);
	const seen = [];
	const app = await runSafeLogin({ sdk: wallet.sdk, info: await wallet.sdk.safe.getInfo(), fetchFn: async (u, i) => { const r = await fetchFn(u, i); seen.push(r.headers); return r; }, waitFn: async () => {}, pollTimeoutMs: 1000 });
	assert.equal('sessionToken' in app, false);
	assert.equal(safeAppSessionFrom(seen).kind, 'contract');
	const posts = [];
	const spy = async (url, init = {}) => { if (init.method === 'POST') posts.push(JSON.parse(init.body)); return fetchFn(url, init); };
	const wc = await guardedChallengeSignSubmit({
		texts,
		getChallenge: () => spy(`/api/dashboard?wallet=${SAFE}`).then((r) => r.json()),
		sign: (m) => wallet.walletConnect.request({ method: 'personal_sign', params: [m, SAFE] }),
		submit: (challenge, signature) => onchainLogin.submitDashboardLogin({ wallet: SAFE, token: challenge.token, signature, fetchFn: spy })
	});
	assert.equal(wc.ok, true);
	assert.equal(posts.length, 1);
	assert.equal(posts[0].approval, undefined);
	assert.match(posts[0].signature, /^0x[0-9a-f]{130}$/);
	assert.equal(wallet.state.proposals.length, 0);
});

/* ====================================== 3/4: PENDING, dann CONFIRMED */

test('3 on-chain Safe before execution: 202 ONCHAIN_APPROVAL_PENDING, challenge NOT consumed, no session', async () => {
	const srv = server();
	const { token } = await getChallenge(srv);
	const r = await postOnchain(srv, { wallet: SAFE, token, approval: 'onchain' });
	assert.equal(r.statusCode, 202);
	assert.equal(r.body.code, 'ONCHAIN_APPROVAL_PENDING');
	assert.equal(sessionOf(r), null);
	assert.equal(r.headers['set-cookie'], undefined);
	assert.equal(challengeOf(srv, token).used, false);
});

test('4 after the exact challenge was executed on-chain and BOTH providers say VALID: challenge consumed, 24 h contract session', async () => {
	const srv = server();
	const { token, message } = await getChallenge(srv);
	executeSignMessageLib(srv.chain, SAFE, message);
	const r = await postOnchain(srv, { wallet: SAFE, token, approval: 'onchain' });
	assert.equal(r.statusCode, 200, JSON.stringify(r.body));
	const session = sessionOf(r);
	assert.equal(session.wallet, SAFE);
	assert.equal(session.kind, 'contract');
	assert.equal(session.exp - session.iat, DAY);
	assert.equal(challengeOf(srv, token).used, true);
	// beide Provider haben isValidSignature(hash, 0x) am selben Block gelesen
	const ethCalls = (log) => log.filter((e) => e.method === 'eth_call');
	assert.equal(ethCalls(srv.logs.alchemy).length, 1);
	assert.equal(ethCalls(srv.logs.infura).length, 1);
	assert.deepEqual(ethCalls(srv.logs.alchemy)[0].params[1], ethCalls(srv.logs.infura)[0].params[1]);
});

/* ============================================= 5-8: falsche Eingaben */

test('5 an on-chain approval of a DIFFERENT message (other nonce, other text) never logs in', async () => {
	const srv = server();
	const first = await getChallenge(srv);
	const second = await getChallenge(srv);
	executeSignMessageLib(srv.chain, SAFE, first.message);
	executeSignMessageLib(srv.chain, SAFE, `${second.message}\n`);
	executeSignMessageLib(srv.chain, SAFE, 'coverraccoon.com wants you to sign in');
	const r = await postOnchain(srv, { wallet: SAFE, token: second.token, approval: 'onchain' });
	assert.equal(r.statusCode, 202);
	assert.equal(sessionOf(r), null);
	assert.equal(challengeOf(srv, second.token).used, false);
});

test('6 wrong wallet: body wallet differs from the challenge, or the approval sits on another Safe -> no login', async () => {
	const srv = server();
	const { token, message } = await getChallenge(srv);
	executeSignMessageLib(srv.chain, SAFE, message);
	const wrongBody = await postOnchain(srv, { wallet: OTHER_SAFE, token, approval: 'onchain' });
	assert.equal(wrongBody.statusCode, 401);
	assert.equal(sessionOf(wrongBody), null);
	const other = await getChallenge(srv, OTHER_SAFE);
	executeSignMessageLib(srv.chain, SAFE, other.message); // die FALSCHE Safe gibt die Nachricht der anderen frei
	const r = await postOnchain(srv, { wallet: OTHER_SAFE, token: other.token, approval: 'onchain' });
	assert.equal(r.statusCode, 202);
	assert.equal(sessionOf(r), null);
});

test('7 expired challenge -> no login, no RPC', async () => {
	const srv = server();
	const old = auth.createDashboardChallenge(SAFE, Date.now() - auth.DASHBOARD_CHALLENGE_TTL_CONTRACT_MS - 1000, auth.DASHBOARD_CHALLENGE_TTL_CONTRACT_MS);
	const data = JSON.parse(Buffer.from(old.token.split('.')[0], 'base64url').toString());
	srv.challenges.set(data.nonce, { wallet: SAFE, expiresAt: data.exp, used: false });
	executeSignMessageLib(srv.chain, SAFE, old.message);
	const r = await postOnchain(srv, { wallet: SAFE, token: old.token, approval: 'onchain' });
	assert.equal(r.statusCode, 401);
	assert.equal(sessionOf(r), null);
	assert.equal(rpcCalls(srv), 0, 'abgelaufenes Token: kein RPC');
	// Token noch gueltig, Zeile aber abgelaufen (Uhrversatz) -> ebenfalls nichts
	const live = await getChallenge(srv);
	challengeOf(srv, live.token).expiresAt = Date.now() - 1;
	executeSignMessageLib(srv.chain, SAFE, live.message);
	const r2 = await postOnchain(srv, { wallet: SAFE, token: live.token, approval: 'onchain' });
	assert.notEqual(r2.statusCode, 200);
	assert.equal(sessionOf(r2), null);
});

test('8 an already consumed challenge -> 409, no second session (consume happens BEFORE the session is issued)', async () => {
	const srv = server();
	const { token, message } = await getChallenge(srv);
	executeSignMessageLib(srv.chain, SAFE, message);
	assert.equal((await postOnchain(srv, { wallet: SAFE, token, approval: 'onchain' })).statusCode, 200);
	const again = await postOnchain(srv, { wallet: SAFE, token, approval: 'onchain' });
	assert.equal(again.statusCode, 409);
	assert.equal(sessionOf(again), null);
	assert.equal(again.headers['set-cookie'], undefined);
	// Wettlauf: Zeile wird zwischen Lese-Pruefung und Verbrauch von jemand anderem verbraucht
	const race = server();
	const c = await getChallenge(race);
	executeSignMessageLib(race.chain, SAFE, c.message);
	const realConsume = race.challenges.get.bind(race.challenges);
	let reads = 0;
	race.challenges.get = (nonce) => { const row = realConsume(nonce); if (row && ++reads === 2) row.used = true; return row; };
	const lost = await postOnchain(race, { wallet: SAFE, token: c.token, approval: 'onchain' });
	assert.equal(lost.statusCode, 409);
	assert.equal(sessionOf(lost), null);
	assert.equal(lost.headers['set-cookie'], undefined);
});

/* ========================================== 9-11: Dual-RPC-Konsens */

const notApproved = () => { const e = new Error('execution reverted: Hash not approved'); e.code = 3; e.data = '0x'; throw e; };

test('9 only ONE provider sees the approval -> no login (disagreement -> 401 + security event; outage of the other -> 503)', async () => {
	for (const side of ['alchemy', 'infura']) {
		const srv = server(side === 'alchemy' ? { alchemy: { behave: { eth_call: notApproved } } } : { infura: { behave: { eth_call: notApproved } } });
		const { token, message } = await getChallenge(srv);
		executeSignMessageLib(srv.chain, SAFE, message);
		const r = await postOnchain(srv, { wallet: SAFE, token, approval: 'onchain' });
		assert.equal(r.statusCode, 401, side);
		assert.equal(sessionOf(r), null);
		assert.deepEqual(srv.events, ['disagreement']);
		assert.equal(challengeOf(srv, token).used, false);
	}
	const down = server({ infura: { behave: { eth_call: () => { throw new Error('timeout'); } } } });
	const c = await getChallenge(down);
	executeSignMessageLib(down.chain, SAFE, c.message);
	const r = await postOnchain(down, { wallet: SAFE, token: c.token, approval: 'onchain' });
	assert.equal(r.statusCode, 503);
	assert.equal(sessionOf(r), null);
});

test('10 provider disagreement on the common block (different block hash) -> no login + security event', async () => {
	const srv = server({ infura: { behave: { eth_getBlockByNumber: (params) => ({ number: params[0], hash: `0x${'ab'.repeat(32)}` }) } } });
	const { token, message } = await getChallenge(srv);
	executeSignMessageLib(srv.chain, SAFE, message);
	const r = await postOnchain(srv, { wallet: SAFE, token, approval: 'onchain' });
	assert.equal(r.statusCode, 401);
	assert.equal(sessionOf(r), null);
	assert.deepEqual(srv.events, ['disagreement']);
});

test('11 RPC outage -> 503, challenge stays open, no session', async () => {
	const srv = server({ alchemy: { behave: { eth_blockNumber: () => { throw new Error('down'); } } } });
	const { token, message } = await getChallenge(srv);
	executeSignMessageLib(srv.chain, SAFE, message);
	const r = await postOnchain(srv, { wallet: SAFE, token, approval: 'onchain' });
	assert.equal(r.statusCode, 503);
	assert.equal(sessionOf(r), null);
	assert.equal(challengeOf(srv, token).used, false);
	assert.deepEqual(srv.events, []);
});

/* ================================== 12-14: Modus-Grenzen am Browser */

test('12 an EOA cannot use mode B', async () => {
	const srv = server();
	const eoa = privateKeyToAccount(generatePrivateKey());
	const { token } = await getChallenge(srv, eoa.address);
	const r = await postOnchain(srv, { wallet: eoa.address, token, approval: 'onchain' });
	assert.equal(r.statusCode, 400);
	assert.equal(r.body.code, 'ONCHAIN_APPROVAL_CONTRACT_ONLY');
	assert.equal(sessionOf(r), null);
	assert.equal(challengeOf(srv, token).used, false);
});

test('13 the browser cannot supply a hash, message, target or any extra field in mode B', async () => {
	const srv = server();
	const { token } = await getChallenge(srv);
	const fake = 'coverraccoon.com wants you to sign in (attacker text)';
	executeSignMessageLib(srv.chain, SAFE, fake);
	const before = rpcCalls(srv); // der Challenge-GET hat getCode gelesen
	for (const extra of [{ messageHash: hashMessage(fake) }, { hash: hashMessage(fake) }, { message: fake }, { to: SIGN_MESSAGE_LIB }, { data: '0x' }, { gas: '0x1' }]) {
		const r = await postOnchain(srv, { wallet: SAFE, token, approval: 'onchain', ...extra });
		assert.equal(r.statusCode, 400, JSON.stringify(extra));
		assert.equal(sessionOf(r), null);
	}
	assert.equal(rpcCalls(srv), before, 'kein RPC fuer einen unzulaessigen Body');
	for (const approval of ['ONCHAIN', 'offchain', true, 1, '']) {
		assert.equal((await postOnchain(srv, { wallet: SAFE, token, approval })).statusCode, 400, String(approval));
	}
});

test('14 the browser cannot use 0x as an ordinary signature - not in mode A, and mode B refuses a signature field', async () => {
	const srv = server();
	const { token, message } = await getChallenge(srv);
	executeSignMessageLib(srv.chain, SAFE, message);
	const modeA = await call(srv.dashboard, '/api/dashboard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { wallet: SAFE, token, signature: '0x' } });
	assert.equal(modeA.statusCode, 401);
	assert.equal(sessionOf(modeA), null);
	for (const signature of ['0x', '', ownerSignature(['b2'], hashMessage(message))]) {
		const r = await postOnchain(srv, { wallet: SAFE, token, approval: 'onchain', signature });
		assert.equal(r.statusCode, 400);
		assert.equal(sessionOf(r), null);
	}
	assert.equal(challengeOf(srv, token).used, false);
	// der Client-Helfer schickt '0x' nie als Signatur
	const posts = [];
	await onchainLogin.submitDashboardLogin({ wallet: SAFE, token, signature: '0x', fetchFn: async (url, init) => { posts.push(JSON.parse(init.body)); return { status: 200, ok: true, json: async () => ({ ok: true }) }; } });
	assert.equal(posts[0].signature, undefined);
	assert.equal(posts[0].approval, 'onchain');
});

/* ========================== 15-17: Modus B ist KEIN allgemeines Primitive */

async function contractSessionCookie(srv) {
	const { token, message } = await getChallenge(srv);
	executeSignMessageLib(srv.chain, SAFE, message);
	const r = await postOnchain(srv, { wallet: SAFE, token, approval: 'onchain' });
	assert.equal(r.statusCode, 200);
	return { cookie: safeAppCookieFrom(r.headers), token };
}

for (const [purpose, url] of [['session-revoke', '/api/dashboard'], ['telegram-disconnect', '/api/dashboard?telegram=1']]) {
	test(`15/16 ${purpose}: neither a mode-B login token, nor an on-chain approval, nor approval:"onchain" authorizes it`, async () => {
		const srv = server();
		const { cookie, token: loginToken } = await contractSessionCookie(srv);
		const headers = { 'content-type': 'application/json', cookie };
		// (a) der verbrauchte Login-Token als "Bestaetigung"
		const a = await call(srv.dashboard, url, { method: 'DELETE', headers, body: { token: loginToken, signature: '0x' } });
		// (b) echte Aktions-Challenge, on-chain freigegeben, ohne Signatur / mit 0x / im Modus-B-Format
		const ask = await call(srv.dashboard, '/api/dashboard', { method: 'POST', headers, body: { action: purpose } });
		assert.equal(ask.body.freshSignatureRequired, true);
		executeSignMessageLib(srv.chain, SAFE, ask.body.message);
		const b1 = await call(srv.dashboard, url, { method: 'DELETE', headers, body: { token: ask.body.token } });
		const b2 = await call(srv.dashboard, url, { method: 'DELETE', headers, body: { token: ask.body.token, signature: '0x' } });
		const b3 = await call(srv.dashboard, url, { method: 'DELETE', headers, body: { token: ask.body.token, approval: 'onchain' } });
		// (c) die Aktions-Challenge im Modus-B-Login-Endpunkt
		const c = await postOnchain(srv, { wallet: SAFE, token: ask.body.token, approval: 'onchain' });
		for (const r of [a, b1, b2, b3]) {
			assert.ok([400, 401, 403].includes(r.statusCode), `${purpose}: ${r.statusCode} ${JSON.stringify(r.body)}`);
			assert.notEqual(r.body.ok, true);
		}
		assert.equal(c.statusCode, 401);
		assert.equal(sessionOf(c), null);
		assert.equal(srv.revokedAt.value, null, 'nichts widerrufen');
		// die Aktions-Challenge ist weiter offen - nur eine echte, aktuelle Owner-Signatur verbraucht sie
		assert.equal(challengeOf(srv, ask.body.token).used, false);
	});
}

test('17 Telegram link: an on-chain approval of the link message does not link (0x stays INVALID_SIGNATURE_FORMAT, mode B has no link entry)', async () => {
	const srv = server();
	const message = srv.linkMessage(SAFE);
	executeSignMessageLib(srv.chain, SAFE, message);
	for (const body of [{ code: srv.LINK_CODE, wallet: SAFE, signature: '0x' }, { code: srv.LINK_CODE, wallet: SAFE, approval: 'onchain' }]) {
		const r = await call(srv.linkVerify, '/api/link/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
		assert.ok(r.statusCode >= 400, JSON.stringify(r.body));
	}
	assert.deepEqual(srv.linked, []);
	assert.equal(srv.logs.alchemy.filter((e) => e.method === 'eth_call').length, 0, 'kein ERC-1271-Aufruf mit leerer Signatur');
	// eine Login-Challenge ist ebenfalls kein Telegram-Link
	const { token } = await getChallenge(srv);
	const r = await call(srv.linkVerify, '/api/link/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { code: token, wallet: SAFE, approval: 'onchain' } });
	assert.ok(r.statusCode >= 400);
	assert.deepEqual(srv.linked, []);
});

/* ================================================ 18: Owner-Wechsel */

test('18 owner change after the on-chain approval: the approval still yields ONLY the 24 h dashboard login; destructive actions need a CURRENT owner signature', async () => {
	const srv = server();
	const { token, message } = await getChallenge(srv);
	executeSignMessageLib(srv.chain, SAFE, message);
	// Owner b2 wird nach der Ausfuehrung entfernt, c3 kommt hinzu
	srv.chain.safes[SAFE].history.push({ from: srv.chain.head + 1n, owners: ['c3'], threshold: 1 });
	srv.chain.head += 3n;
	// Dokumentiertes Restverhalten: die Freigabe bleibt in signedMessages -> Login (nur Lesen, 24 h)
	const login = await postOnchain(srv, { wallet: SAFE, token, approval: 'onchain' });
	assert.equal(login.statusCode, 200);
	assert.equal(sessionOf(login).kind, 'contract');
	assert.equal(sessionOf(login).exp - sessionOf(login).iat, DAY);
	const headers = { 'content-type': 'application/json', cookie: safeAppCookieFrom(login.headers) };
	// destruktiv: der entfernte Owner b2 kann nicht bestaetigen ...
	const ask = await call(srv.dashboard, '/api/dashboard', { method: 'POST', headers, body: { action: 'session-revoke' } });
	const stale = await call(srv.dashboard, '/api/dashboard', { method: 'DELETE', headers, body: { token: ask.body.token, signature: ownerSignature(['b2'], hashMessage(ask.body.message)) } });
	assert.equal(stale.statusCode, 401);
	assert.equal(srv.revokedAt.value, null);
	// ... nur der aktuelle Owner c3
	const fresh = await call(srv.dashboard, '/api/dashboard', { method: 'DELETE', headers, body: { token: ask.body.token, signature: ownerSignature(['c3'], hashMessage(ask.body.message)) } });
	assert.equal(fresh.statusCode, 200, JSON.stringify(fresh.body));
	assert.notEqual(srv.revokedAt.value, null);
});

/* ======================================= Budgets (M-2) und Primitive */

test('M-2: per-nonce poll budget and the global budget sit BEFORE any RPC in mode B', async () => {
	for (const scope of ['dashboard-onchain-nonce', 'dashboard-onchain-global']) {
		const srv = server({ limits: { [scope]: 0 } });
		const { token, message } = await getChallenge(srv);
		executeSignMessageLib(srv.chain, SAFE, message);
		const before = rpcCalls(srv);
		const r = await postOnchain(srv, { wallet: SAFE, token, approval: 'onchain' });
		assert.equal(r.statusCode, 429, scope);
		assert.equal(rpcCalls(srv), before, `${scope}: kein RPC`);
		assert.equal(sessionOf(r), null);
	}
});

test('the mode-B verifier only accepts a dashboard login challenge for its own wallet', async () => {
	const { providers } = dualProviders(freshChain());
	const login = auth.verifyDashboardToken(auth.createDashboardChallenge(SAFE, Date.now(), auth.DASHBOARD_CHALLENGE_TTL_CONTRACT_MS).token);
	const action = auth.createActionChallenge(SAFE, 'session-revoke').data;
	assert.equal(await cs.verifyOnchainDashboardLoginApproval({ challenge: action, wallet: SAFE }, { providers }), 'INVALID_CHALLENGE');
	assert.equal(await cs.verifyOnchainDashboardLoginApproval({ challenge: login, wallet: OTHER_SAFE }, { providers }), 'INVALID_CHALLENGE');
	assert.equal(await cs.verifyOnchainDashboardLoginApproval({ challenge: { ...login, type: 'session' }, wallet: SAFE }, { providers }), 'INVALID_CHALLENGE');
	assert.equal(await cs.verifyOnchainDashboardLoginApproval({ challenge: login, wallet: SAFE }, { providers }), 'PENDING');
});

test('a Safe without fallback handler never logs in through mode B (stays pending)', async () => {
	const chain = freshChain();
	chain.safes[SAFE].noFallbackHandler = true;
	const srv = server({ chain });
	const { token, message } = await getChallenge(srv);
	executeSignMessageLib(srv.chain, SAFE, message);
	const r = await postOnchain(srv, { wallet: SAFE, token, approval: 'onchain' });
	assert.equal(r.statusCode, 202);
	assert.equal(sessionOf(r), null);
});

test('15/16 client: signSafeMessage for a fresh confirmation never accepts the on-chain path - it rejects (only the login opts in)', async () => {
	const { signSafeMessage, ONCHAIN_APPROVAL } = await import('../web/src/safe-app.js');
	const wallet = safeWallet(freshChain(), { onchain: true });
	const states = [];
	await assert.rejects(signSafeMessage({ sdk: wallet.sdk, message: 'action message', onState: (s, d) => states.push([s, d?.reason]), waitFn: async () => {}, pollTimeoutMs: 1 }), /Message-Hash/);
	assert.deepEqual(states.at(-1), ['REJECTED', 'no-message-hash']);
	// nur mit ausdruecklicher Zustimmung (Login) kommt der Marker zurueck - nie eine Signatur
	assert.equal(await signSafeMessage({ sdk: wallet.sdk, message: 'login', waitFn: async () => {}, pollTimeoutMs: 1, allowOnchainApproval: true }), ONCHAIN_APPROVAL);
	// ein safeTxHash in falscher Form wird nie als On-chain-Freigabe gedeutet
	const odd = { ...wallet.sdk, txs: { signMessage: async () => ({ safeTxHash: '0x1234' }) } };
	await assert.rejects(signSafeMessage({ sdk: odd, message: 'login', waitFn: async () => {}, pollTimeoutMs: 1, allowOnchainApproval: true }));
});
