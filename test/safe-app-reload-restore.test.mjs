/*
	Safe-App-Reload (15.10.2026): Nach einem Neuladen von app.safe.global verlangte
	die Safe App eine neue Signatur, obwohl das partitionierte HttpOnly-Cookie der
	freigegebenen Test-Safe noch gueltig war. Ursache: bootstrap() startete im
	Safe-Kontext immer runSafeLogin; eine bestehende Sitzung wurde nie gefragt.

	Jetzt (startSafeApp): erst EIN GET /api/dashboard ohne Authorization (das Cookie
	schickt der Browser selbst). Nur bei 200, gueltigem Dashboard und GENAU derselben
	Safe-Adresse (Mainnet) wird es uebernommen - ohne Signatur. Alles andere faellt
	unveraendert auf runSafeLogin zurueck.

	A-F laufen gegen den ECHTEN Handler (api/dashboard.mjs) mit aktivem Experiment
	und einer simulierten Cookie-Ablage; H prueft danach, dass destruktive Aktionen
	weiter eine frische Safe-Signatur verlangen.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hashMessage, isAddress } from 'viem';
import { simChain, dualProviders, ownerSignature } from '../test-support/dual-rpc-sim.mjs';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';

process.env.APP_BASE_URL = 'https://coverraccoon.com';
process.env.DASHBOARD_SESSION_SECRET = 'safe-app-reload-restore-secret-0123456789abcdef';
const TEST_SAFE = '0x47ac11fd3b2a6e84ef360dcc6568cb25a0dabfb3';
const OTHER_SAFE = '0x5afe0000000000000000000000000000000c0c0c';
Object.assign(process.env, { SAFE_PARTITIONED_COOKIE_EXPERIMENT: 'true', VERCEL_ENV: 'production', SAFE_PARTITIONED_COOKIE_TEST_WALLET: TEST_SAFE });

const auth = await import('../src/dashboard-auth.mjs');
const cs = await import('../src/contract-signature.mjs');
const safeApp = await import('../web/src/safe-app.js');

/* ------------------------------------------------ Server + Cookie-Ablage */

function server() {
	const history = [{ from: 0n, owners: ['b2'], threshold: 1 }];
	const { providers } = dualProviders(simChain({ head: 20_000_000n, safes: { [TEST_SAFE]: { history }, [OTHER_SAFE]: { history } } }));
	const source = readFileSync(new URL('../api/dashboard.mjs', import.meta.url), 'utf8').replace(/^import [^;]*;\n/gm, '').replace('export default async function handler', 'async function handler');
	const challenges = new Map();
	const deps = {
		isAddress, queryParams, singleQueryValue, ...auth,
		verifyWalletSiweAuthority: (p) => cs.verifyWalletSiweAuthority(p, { providers }),
		verifyOnchainDashboardLoginApproval: (p) => cs.verifyOnchainDashboardLoginApproval(p, { providers }),
		noContractCodeByQuorum: (w) => cs.noContractCodeByQuorum(w, { providers }),
		isDeployedContract: async () => true,
		storeDashboardChallenge: async ({ nonce, wallet, expiresAt }) => { challenges.set(nonce, { wallet, expiresAt, used: false }); },
		consumeDashboardChallenge: async (nonce, wallet) => { const r = challenges.get(nonce); if (!r || r.used || r.wallet !== wallet.toLowerCase()) return false; r.used = true; return true; },
		isDashboardChallengeOpen: async () => true,
		getWalletCovers: async () => ({ covers: [] }), getWalletLinkStateByWallet: async () => ({ linked: false, link: null }),
		isDashboardSessionRevoked: async () => false, recordAgentEvent: async () => {}, consumeDashboardAccess: async () => null,
		getLanguage: async () => 'de', beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		revokeDashboardSessions: async () => Date.now(), unlinkWalletByWallet: async () => [], unlinkWalletFromAllChats: async () => [],
		enforceRateLimit: async () => true, enforceRateLimitFor: async () => true, requireJson: () => true, requireSameOrigin: () => true,
		recordSecurityEvent: async () => {}, securityFingerprint: () => 'fp',
		SECURITY_EVENT: { SIWE_SIGNATURE_INVALID: 'invalid', SIWE_REPLAY_BLOCKED: 'replay', ERC1271_RPC_DISAGREEMENT: 'disagreement', ACCESS_CODE_INVALID: 'access' },
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}
	};
	return new Function(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps));
}

/** Browser-Fetch an die eigene Origin: schickt gespeicherte Cookies mit, speichert Set-Cookie. Zeichnet jede Anfrage auf. */
function browser(handler) {
	const jar = new Map();
	const log = [];
	const fetchFn = async (url, init = {}) => {
		const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
		log.push({ method: init.method ?? 'GET', url, authorization: headers.authorization ?? null, hasSignal: Boolean(init.signal) });
		if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
		const res = { headers: {}, status(n) { this.code = n; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, json(b) { this.body = b; return this; } };
		await handler({ method: init.method ?? 'GET', url, headers, body: init.body ? JSON.parse(init.body) : undefined }, res);
		const set = res.headers['set-cookie'];
		for (const c of set === undefined ? [] : Array.isArray(set) ? set : [set]) {
			const [pair] = c.split(';'); const i = pair.indexOf('='); const name = pair.slice(0, i); const value = pair.slice(i + 1);
			if (/Max-Age=0/.test(c)) jar.delete(name); else jar.set(name, value);
		}
		return { ok: res.code < 400, status: res.code, json: async () => res.body };
	};
	return { fetchFn, jar, log };
}

/** Safe{Wallet}-Modell: off-chain-Signatur der Owner b2; zaehlt Signaturanfragen. */
function safeSdk(address) {
	const state = { signRequests: 0, pending: null };
	const sdk = {
		safe: { getInfo: async () => ({ safeAddress: address, chainId: 1, threshold: 1, owners: [] }), getOffChainSignature: async (h) => (state.pending?.hash === h ? state.pending.sig : '') },
		eth: { setSafeSettings: async ([r]) => ({ offChainSigning: !!r.offChainSigning }) },
		txs: { signMessage: async (message) => { state.signRequests++; const hash = hashMessage(message); state.pending = { hash, sig: ownerSignature(['b2'], hash) }; return { messageHash: hash }; } }
	};
	return { sdk, state, info: { safeAddress: address, chainId: 1, threshold: 1, owners: [] } };
}

async function firstLogin(b) {
	const s = safeSdk(TEST_SAFE);
	const out = await safeApp.startSafeApp({ sdk: s.sdk, info: s.info, fetchFn: b.fetchFn, waitFn: async () => {}, pollTimeoutMs: 1000 });
	assert.equal(out.restored, false);
	assert.equal(s.state.signRequests, 1);
	assert.ok(b.jar.has('__Host-raccoon_safeapp'), 'Experiment-Cookie gesetzt');
	return s;
}
const stub = (respond) => { const calls = []; return { calls, fetchFn: async (url, init = {}) => { calls.push({ url, init }); return respond(url, init); } }; };

/* ============================================================== A */

test('A after a reload the same Safe is restored from the partitioned cookie: dashboard returned, NO runSafeLogin, NO signature request', async () => {
	const b = browser(server());
	await firstLogin(b);
	// "Reload": neue Seite, neues SDK, kein Token im Speicher - nur die Cookie-Ablage bleibt.
	const s = safeSdk(TEST_SAFE.toUpperCase().replace('0X', '0x'));
	b.log.length = 0;
	const states = [];
	const out = await safeApp.startSafeApp({ sdk: s.sdk, info: s.info, fetchFn: b.fetchFn, onState: (st) => states.push(st), waitFn: async () => {}, pollTimeoutMs: 1000 });
	assert.equal(out.restored, true);
	assert.equal(out.sessionToken, null, 'kein Token im Speicher');
	assert.equal(out.dashboard.wallet, TEST_SAFE);
	assert.equal(s.state.signRequests, 0, 'keine Signaturanfrage');
	assert.deepEqual(b.log.map((r) => `${r.method} ${r.url}`), ['GET /api/dashboard'], 'genau ein Lese-Aufruf, keine Challenge, kein Login');
	assert.equal(b.log[0].authorization, null, 'ohne Authorization');
	assert.equal(b.log[0].hasSignal, true, 'mit Zeitlimit');
	assert.ok(states.includes('AUTHENTICATED'));
	assert.equal(states.includes('CHALLENGE_CREATED'), false);
});

/* ========================================================== B-F */

async function assertFallsBack(fetchFn, label, { timeoutMs } = {}) {
	const s = safeSdk(TEST_SAFE);
	let loginCalls = 0;
	const out = await safeApp.startSafeApp({
		sdk: s.sdk, info: s.info, fetchFn, restoreTimeoutMs: timeoutMs,
		runLogin: async (args) => { loginCalls++; assert.equal(args.info.safeAddress, TEST_SAFE); return { sessionToken: 'login-token', dashboard: { ok: true, wallet: TEST_SAFE, via: 'login' } }; }
	});
	assert.equal(loginCalls, 1, `${label}: runSafeLogin genau einmal`);
	assert.equal(out.restored, false, label);
	assert.equal(out.dashboard.via, 'login', `${label}: nur das Login-Dashboard, nie das abgelehnte`);
}

test('B 401 (no/expired/revoked session) falls back to runSafeLogin', async () => {
	const b = browser(server()); // leere Cookie-Ablage -> echter Handler antwortet 401
	await assertFallsBack(b.fetchFn, '401');
	const restoreCall = b.log[0];
	assert.equal(`${restoreCall.method} ${restoreCall.url}`, 'GET /api/dashboard');
});

test('B other non-200 statuses fall back', async () => {
	for (const status of [403, 409, 429, 500, 503, 302, 204]) {
		await assertFallsBack(stub(async () => ({ ok: status < 400, status, json: async () => ({ ok: true, wallet: TEST_SAFE, covers: [] }) })).fetchFn, `status ${status}`);
	}
});

test('C a session of a DIFFERENT Safe is never rendered: falls back to runSafeLogin', async () => {
	const b = browser(server());
	await firstLogin(b);
	// Nutzer wechselt in Safe{Wallet} auf eine andere Safe; das Cookie gehoert noch zur Test-Safe.
	const other = safeSdk(OTHER_SAFE);
	let loginCalls = 0;
	const out = await safeApp.startSafeApp({ sdk: other.sdk, info: other.info, fetchFn: b.fetchFn, runLogin: async () => { loginCalls++; return { sessionToken: null, dashboard: { ok: true, wallet: OTHER_SAFE, via: 'login' } }; } });
	assert.equal(loginCalls, 1);
	assert.equal(out.restored, false);
	assert.notEqual(out.dashboard.wallet, TEST_SAFE, 'keine Daten der anderen Safe');
	// und direkt: fremde Wallet in einer 200-Antwort
	for (const wallet of [OTHER_SAFE, `${TEST_SAFE}0`, TEST_SAFE.slice(0, -1), '', null, 42]) {
		await assertFallsBack(stub(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, wallet, covers: [] }) })).fetchFn, `wallet ${String(wallet)}`);
	}
});

test('D malformed or incomplete 200 responses fall back', async () => {
	for (const [label, json] of [
		['json throws', async () => { throw new SyntaxError('bad json'); }],
		['null', async () => null],
		['ok false', async () => ({ ok: false, wallet: TEST_SAFE })],
		['ok missing', async () => ({ wallet: TEST_SAFE })],
		['wallet missing', async () => ({ ok: true })],
		['string body', async () => 'ok'],
		['array body', async () => [TEST_SAFE]]
	]) {
		await assertFallsBack(stub(async () => ({ ok: true, status: 200, json })).fetchFn, label);
	}
	await assertFallsBack(stub(async () => undefined).fetchFn, 'undefined response');
});

test('E network errors fall back', async () => {
	await assertFallsBack(stub(async () => { throw new TypeError('Failed to fetch'); }).fetchFn, 'TypeError');
	await assertFallsBack(stub(async () => { throw new DOMException('aborted', 'AbortError'); }).fetchFn, 'AbortError');
});

test('F a hanging request times out and falls back (the request is aborted)', async () => {
	let aborted = false;
	const hanging = stub((url, init) => new Promise(() => { init.signal?.addEventListener('abort', () => { aborted = true; }); }));
	const started = Date.now();
	await assertFallsBack(hanging.fetchFn, 'timeout', { timeoutMs: 50 });
	assert.ok(Date.now() - started < 2000, 'kein Haengenbleiben');
	assert.equal(aborted, true, 'Anfrage abgebrochen');
});

test('F the restore check is skipped (straight to runSafeLogin) for a non-mainnet Safe or an unusable address', async () => {
	for (const info of [{ safeAddress: TEST_SAFE, chainId: 137 }, { safeAddress: 'not-an-address', chainId: 1 }, { chainId: 1 }]) {
		const probe = stub(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, wallet: TEST_SAFE }) }));
		let loginCalls = 0;
		await safeApp.startSafeApp({ sdk: {}, info, fetchFn: probe.fetchFn, runLogin: async () => { loginCalls++; return { sessionToken: null, dashboard: {} }; } });
		assert.equal(loginCalls, 1, JSON.stringify(info));
		assert.equal(probe.calls.length, 0, `${JSON.stringify(info)}: kein Wiederherstellungs-Aufruf`);
	}
});

/* ============================================================== G */

test('G normal (non-Safe) bootstrap is unchanged: the restore helper is only used in the Safe-App branch', () => {
	// Quelltext-Waechter (Evidenzklasse C): main.js ist ohne Browser nicht ausfuehrbar.
	const main = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');
	const boot = main.slice(main.indexOf('async function bootstrap()'), main.indexOf('const dashboardRestorePromise = bootstrap();'));
	assert.match(boot, /if \(ctx\) return runSafeAppLogin\(ctx\);\n[\s\S]*return restoreDashboard\(\);\n\}/);
	assert.equal((main.match(/startSafeApp\(/g) ?? []).length, 1);
	const safeBranch = main.slice(main.indexOf('async function runSafeAppLogin('), main.indexOf('async function bootstrap()'));
	assert.ok(safeBranch.includes('startSafeApp('), 'nur im Safe-Zweig');
	assert.equal(main.slice(main.indexOf('async function restoreDashboard()'), main.indexOf('async function runSafeAppLogin(')).includes('startSafeApp'), false);
});

/* ============================================================== H */

test('H after a restored session, destructive actions still require fresh Safe authority (no signature, no action)', async () => {
	const b = browser(server());
	await firstLogin(b);
	const s = safeSdk(TEST_SAFE);
	assert.equal((await safeApp.startSafeApp({ sdk: s.sdk, info: s.info, fetchFn: b.fetchFn })).restored, true);
	const ask = await (await b.fetchFn('/api/dashboard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'session-revoke' }) })).json();
	assert.equal(ask.freshSignatureRequired, true);
	const disconnect = await b.fetchFn('/api/dashboard?telegram=1', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
	assert.equal(disconnect.status, 403);
	assert.equal((await disconnect.json()).code, 'FRESH_SIGNATURE_REQUIRED');
	assert.equal(s.state.signRequests, 0);
});
