/**
 * Unerwartete Abfrageparameter (CRSF Phase 2D, CR-API-004 P1 in der praezisierten Fassung).
 *
 * Ein unerwarteter Parameter muss entweder abgewiesen werden (400) oder
 * nachweislich wirkungslos sein. "Wirkungslos" wird hier im VERHALTEN geprueft,
 * nicht im Quelltext: jeder echte Handler laeuft einmal ohne und dann mit
 * feindlichen Abfragen (fremde Wallet, admin, chat_id, role=service_role, debug,
 * Geheimnis im Query). Jede Abhaengigkeit schreibt ihre Aufrufe mit. Erwartet:
 * - gleiche Antwort (Status, Body, Header) und gleiche Aufrufe mit gleichen
 *   Argumenten - der Parameter waehlt weder Objekt noch Wallet noch Chat,
 * - ohne die echte Berechtigung (Header-Secret, Sitzung) macht kein Parameter die
 *   Anfrage berechtigt.
 * Die Inventur am Ende verlangt, dass JEDER Handler unter api/ hier eingeordnet ist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isAddress } from 'viem';
import { queryParams, queryKeys, singleQueryValue } from '../src/request-query.mjs';

const CRON = 'cron-secret-for-query-tests-0123456789';
const WEBHOOK = 'webhook-secret-for-query-tests-0123456789';
Object.assign(process.env, {
	APP_BASE_URL: 'https://coverraccoon.com',
	DASHBOARD_SESSION_SECRET: 'query-authority-test-secret-0123456789abcdef',
	TELEGRAM_WEBHOOK_SECRET: WEBHOOK
});
const auth = await import('../src/dashboard-auth.mjs');
const { siweOrigin } = await import('../src/siwe-auth.mjs');
const { isPrivateChatUpdate } = await import('../src/telegram-audit.mjs');
const { createPositionsHandler } = await import('../api/positions.mjs');
const { createAttributionsHandler } = await import('../api/position-attributions.mjs');
const { createNexusQuoteHandler } = await import('../api/nexus/quote.mjs');

const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);
const SECURITY_EVENT = { RATE_LIMIT_BLOCKED: 'rl', WEBHOOK_AUTH_FAILED: 'webhook', SIWE_SIGNATURE_INVALID: 'invalid', SIWE_REPLAY_BLOCKED: 'replay', ERC1271_RPC_DISAGREEMENT: 'disagreement', ACCESS_CODE_INVALID: 'access' };
const LINK_CODE = 'PendingLinkCode_0123456-';
const OTHER_CODE = 'OtherPendingCode_987654-';
// Fixed far-future expiry: the differential must not depend on the wall clock (this machine's clock jumps).
const EXPIRES = Date.UTC(2100, 0, 1);

/** Hostile queries, each tried on its own and all at once. */
const HOSTILE = [
	`wallet=${B}`, `address=${B}`, 'admin=1', 'chat_id=777', 'role=service_role', 'debug=1',
	`session=${B}`, `code=${OTHER_CODE}`, `secret=${WEBHOOK}`, `authorization=Bearer%20${CRON}`, `wallet=${A}&wallet=${B}`
];
const variants = (names = HOSTILE) => [...names.map((q) => `?${q}`), `?${names.join('&')}`];

const strip = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/^import [^;]*;\n/gm, '');
function compile(file, deps) {
	const source = strip(file).replace(/export default (async )?function handler/, '$1function handler').replace(/^export /gm, '');
	return new Function(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps));
}
/** JSON-safe copy of call arguments (functions and response objects become markers). */
const safe = (value) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'function' ? '[fn]' : v && typeof v === 'object' && typeof v.status === 'function' ? '[response]' : v)) ?? 'null');
function recorder() {
	const log = [];
	const fn = (name, impl = () => undefined) => (...args) => { log.push([name, ...args.map(safe)]); return impl(...args); };
	return { log, fn };
}
/** The real HTTP guards (src/http-security.mjs) with a recording rate-limit store. */
function httpSecurity(rec) {
	return new Function('createHmac', 'checkRateLimit', 'dashboardSecretConfigured', 'siweOrigin', 'recordSecurityEvent', 'SECURITY_EVENT',
		`${strip('src/http-security.mjs').replace(/^export /gm, '')}\nreturn { bodyTooLarge, enforceRateLimit, enforceRateLimitFor, requireJson, requireSameOrigin };`)(
		createHmac, rec.fn('checkRateLimit', async () => true), auth.dashboardSecretConfigured, siweOrigin, rec.fn('recordSecurityEvent', async () => {}), SECURITY_EVENT);
}
const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(n) { this.code = n; return this; }, json(b) { this.body = b; return this; }, end() { this.ended = true; return this; } });
const outcome = (res, rec) => ({ code: res.code, body: res.body ?? null, headers: res.headers, calls: rec.log });

/** Runs `send(url)` for the plain URL and every hostile variant; all observations must be identical. */
async function assertQueryHasNoEffect(label, path, send, names) {
	const baseline = await send(path);
	assert.ok(baseline.code < 500, `${label}: baseline must succeed (${baseline.code})`);
	for (const q of variants(names)) assert.deepEqual(await send(`${path}${q}`), baseline, `${label} ${q}: the query changed the response or the work done`);
	return baseline;
}

/* ------------------------------------------------------------------ config */
function configCall(url) {
	const rec = recorder();
	const handler = compile('api/config.mjs', { ANMELDUNG_PAUSIERT: false, process: { env: { TELEGRAM_BOT_USERNAME: 'RaccoonAgentBot', REOWN_PROJECT_ID: 'public-project-id' } } });
	const res = response();
	handler({ method: 'GET', url, headers: {} }, res);
	return outcome(res, rec);
}
test('QUERY-IGNORED config: no query name or value changes the public configuration', async () => {
	const base = await assertQueryHasNoEffect('config', '/api/config', async (url) => configCall(url));
	assert.deepEqual(Object.keys(base.body).sort(), ['anmeldungPausiert', 'reownProjectId', 'telegramUsername']);
});

/* -------------------------------------------------------------- csp-report */
async function cspCall(url) {
	const rec = recorder();
	const http = httpSecurity(rec);
	const handler = compile('api/csp-report.mjs', { bodyTooLarge: http.bodyTooLarge, enforceRateLimit: http.enforceRateLimit, console: { log: rec.fn('log') } });
	const res = response();
	await handler({ method: 'POST', url, headers: { 'x-forwarded-for': '198.51.100.7' }, body: { 'csp-report': { 'effective-directive': 'script-src', 'blocked-uri': 'https://evil.example/x.js' } } }, res);
	return outcome(res, rec);
}
test('QUERY-IGNORED csp-report: the query never reaches the log line or the rate-limit key', async () => {
	const base = await assertQueryHasNoEffect('csp-report', '/api/csp-report', cspCall);
	assert.equal(base.code, 204);
	assert.deepEqual(base.calls.filter(([n]) => n === 'log'), [['log', 'csp-report richtlinie=script-src blockiert=https://evil.example']]);
});

/* ------------------------------------------------------------------ alerts */
function alertsHandler(rec) {
	return compile('api/alerts.mjs', {
		timingSafeEqual, Buffer,
		checkExpiryAlerts: rec.fn('checkExpiryAlerts', async () => ({ subscriptions: 1, sent: 0, summaries: 0, failed: 0, snoozes: 0, lookups: 0, budgetExhausted: null, continuation: false })),
		beginTelegramDelivery: rec.fn('beginTelegramDelivery', async () => null), finishTelegramDelivery: rec.fn('finishTelegramDelivery', async () => {}),
		purgeOldRecords: rec.fn('purgeOldRecords', async () => ({ agent_events: 0 })), alertOperatorCronFailure: rec.fn('alertOperatorCronFailure', async () => {}),
		telegramText: (t) => t, fetch: rec.fn('fetch', async () => Response.json({ ok: true, result: {} })),
		process: { env: { CRON_SECRET: CRON, TELEGRAM_BOT_TOKEN: 'offline-placeholder', APP_BASE_URL: 'https://coverraccoon.com' } },
		console: { error: rec.fn('console.error'), warn() {}, log() {} }
	});
}
async function alertsCall(url, headers = { authorization: `Bearer ${CRON}` }) {
	const rec = recorder();
	const res = response();
	await alertsHandler(rec)({ method: 'GET', url, headers }, res);
	return outcome(res, rec);
}
test('QUERY-IGNORED alerts: with the cron secret, no query changes the run (scope, chat, wallet, purge)', async () => {
	const base = await assertQueryHasNoEffect('alerts', '/api/alerts', (url) => alertsCall(url));
	assert.equal(base.code, 200);
	assert.deepEqual(base.calls.map(([n]) => n), ['checkExpiryAlerts', 'purgeOldRecords']);
});
test('QUERY-NOT-AUTHORITY alerts: without the header no query (secret, admin, role) authorizes the run', async () => {
	for (const q of variants()) {
		const r = await alertsCall(`/api/alerts${q}`, {});
		assert.equal(r.code, 401, q);
		assert.deepEqual(r.calls, [], `${q}: no work at all`);
	}
});

/* ---------------------------------------------------------------- telegram */
const update = { update_id: 4711, message: { message_id: 1, date: 1_760_000_000, chat: { id: 4242, type: 'private' }, from: { id: 4242, is_bot: false, first_name: 'T' }, text: '/start' } };
async function telegramCall(url, headers = { 'x-telegram-bot-api-secret-token': WEBHOOK }) {
	const rec = recorder();
	const http = httpSecurity(rec);
	const handler = compile('api/telegram.mjs', {
		timingSafeEqual, Buffer, handleUpdate: rec.fn('handleUpdate', async () => {}), claimTelegramUpdate: rec.fn('claimTelegramUpdate', async () => true),
		bodyTooLarge: http.bodyTooLarge, recordSecurityEvent: rec.fn('recordSecurityEvent', async () => {}), securityFingerprint: () => 'fp', SECURITY_EVENT, isPrivateChatUpdate
	});
	const res = response();
	await handler({ method: 'POST', url, headers, body: structuredClone(update) }, res);
	return outcome(res, rec);
}
test('QUERY-IGNORED telegram: with the webhook secret, no query changes which update or chat is processed', async () => {
	const base = await assertQueryHasNoEffect('telegram', '/api/telegram', (url) => telegramCall(url));
	assert.deepEqual(base.calls.map(([n]) => n), ['claimTelegramUpdate', 'handleUpdate']);
	assert.equal(base.calls[1][1].message.chat.id, 4242);
});
test('QUERY-NOT-AUTHORITY telegram: the webhook secret in the query (or any other parameter) never authenticates', async () => {
	for (const q of variants()) {
		const r = await telegramCall(`/api/telegram${q}`, {});
		assert.equal(r.code, 401, q);
		assert.deepEqual(r.calls.map(([n]) => n), ['recordSecurityEvent'], `${q}: only the security event, no claim, no bot`);
	}
});

/* ------------------------------------------------------------- link/verify */
function verifyHandler(rec) {
	const http = httpSecurity(rec);
	return compile('api/link/verify.mjs', {
		isAddress, MAX_WALLETS_PER_CHAT: 5, ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}, ...http,
		consumePendingLink: rec.fn('consumePendingLink', async () => ({ status: 'linked', chatId: '123' })),
		getPendingLink: rec.fn('getPendingLink', async () => ({ chat_id: '123', nonce: 'ab'.repeat(16), expires_at: EXPIRES, kind: 'telegram' })),
		getLanguage: rec.fn('getLanguage', async () => 'en'),
		isTelegramLinkCode: (c) => typeof c === 'string' && /^[A-Za-z0-9_-]{24}$/.test(c), isTelegramLinkRow: () => true,
		linkSiweExpectation: rec.fn('linkSiweExpectation', (p) => ({ wallet: p.wallet, code: p.code })),
		newDashboardAccess: async () => null, signingMessage: rec.fn('signingMessage', (p) => `link ${p.wallet} ${p.code} ${p.target}`),
		telegramTarget: rec.fn('telegramTarget', async () => ({ target: '@raccoon_user' })),
		verifyWalletSiweSignature: rec.fn('verifyWalletSiweSignature', async () => 'VALID'),
		recordSecurityEvent: rec.fn('recordSecurityEvent', async () => {}), securityFingerprint: () => 'fp', SECURITY_EVENT,
		process: { env: { TELEGRAM_BOT_TOKEN: 'offline-placeholder', APP_BASE_URL: '' } },
		fetch: rec.fn('fetch', async () => ({ ok: true }))
	});
}
const sameOriginJson = { 'content-type': 'application/json', origin: 'https://coverraccoon.com', 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '198.51.100.9' };
async function verifyCall(url, body = { code: LINK_CODE, wallet: A, signature: '0xsig' }) {
	const rec = recorder();
	const res = response();
	await verifyHandler(rec)({ method: 'POST', url, headers: sameOriginJson, body }, res);
	return outcome(res, rec);
}
test('QUERY-IGNORED link/verify: code and wallet come from the signed body only; ?wallet=<foreign> or ?code= never retarget the link', async () => {
	const base = await assertQueryHasNoEffect('link/verify', '/api/link/verify', (url) => verifyCall(url));
	assert.equal(base.code, 200);
	assert.deepEqual(base.calls.filter(([n]) => n === 'consumePendingLink'), [['consumePendingLink', LINK_CODE, A]]);
	assert.doesNotMatch(JSON.stringify(base.calls), new RegExp(`${B.slice(2)}|${OTHER_CODE}|777`, 'i'));
});
test('QUERY-NOT-AUTHORITY link/verify: a request whose code, wallet and signature sit only in the query links nothing', async () => {
	const r = await verifyCall(`/api/link/verify?code=${LINK_CODE}&wallet=${A}&signature=0xsig`, {});
	assert.equal(r.code, 410);
	assert.deepEqual(r.calls.filter(([n]) => ['getPendingLink', 'verifyWalletSiweSignature', 'consumePendingLink'].includes(n)), []);
});

/* ------------------------------------- endpoints that reject every query */
const sessionCookie = (w) => `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(w, Date.now(), 'eoa'))}`;
test('QUERY-REJECTED positions and position-attributions: any query -> 400 before rate limit, session or lookup', async () => {
	for (const q of variants()) {
		const rec = recorder();
		const deps = { getPositions: rec.fn('getPositions', async () => ({ ok: true, positions: [] })), isRevoked: rec.fn('isRevoked', async () => false), rateLimit: rec.fn('rateLimit', async () => true), rateLimitFor: rec.fn('rateLimitFor', async () => true) };
		const pos = response();
		await createPositionsHandler(deps)({ method: 'GET', url: `/api/positions${q}`, headers: { cookie: sessionCookie(A) } }, pos);
		assert.equal(pos.code, 400, `positions ${q}`);
		const attr = response();
		await createAttributionsHandler({ ...deps, getCovers: rec.fn('getCovers'), listRows: rec.fn('listRows', async () => []), upsertRow: rec.fn('upsertRow'), deleteRow: rec.fn('deleteRow'), deleteStaleRow: rec.fn('deleteStaleRow') })({ method: 'GET', url: `/api/position-attributions${q}`, headers: { cookie: sessionCookie(A) } }, attr);
		assert.equal(attr.code, 400, `position-attributions ${q}`);
		assert.deepEqual(rec.log, [], `${q}: nothing ran`);
	}
});
test('QUERY-REJECTED nexus/quote: any query -> 400 before origin check, rate limit, session, lookup or Nexus', async () => {
	for (const q of variants()) {
		const rec = recorder();
		const res = response();
		await createNexusQuoteHandler({
			getPositions: rec.fn('getPositions'), isRevoked: rec.fn('isRevoked'), readModel: rec.fn('readModel'), quote: rec.fn('quote'),
			rateLimit: rec.fn('rateLimit', async () => true), rateLimitFor: rec.fn('rateLimitFor', async () => true), resolveSession: rec.fn('resolveSession'),
			sameOrigin: rec.fn('sameOrigin', () => true), json: rec.fn('json', () => true)
		})({ method: 'POST', url: `/api/nexus/quote${q}`, body: { action: 'details', deploymentKey: 'aave-v3-ethereum-core' }, headers: { cookie: sessionCookie(A), 'content-type': 'application/json' } }, res);
		assert.equal(res.code, 400, `nexus/quote ${q}`);
		assert.equal(res.body.code, 'QUERY_NOT_ALLOWED');
		assert.deepEqual(rec.log, [], `${q}: nothing ran`);
	}
});

/* -------------------- endpoints with declared parameters: extra names ignored */
function dashboardHandler(rec) {
	const http = httpSecurity(rec);
	const deps = {
		isAddress, queryParams, singleQueryValue, ...auth,
		verifyWalletSiweAuthority: async () => ({ result: 'INVALID_SIGNATURE', authority: null }),
		verifyOnchainDashboardLoginApproval: async () => 'RPC_UNAVAILABLE', noContractCodeByQuorum: async () => true, isDeployedContract: async () => false,
		consumeDashboardChallenge: async () => false, isDashboardChallengeOpen: async () => false, storeDashboardChallenge: async () => {},
		getWalletCovers: rec.fn('getWalletCovers', async () => ({ covers: [] })), getWalletLinkStateByWallet: rec.fn('getWalletLinkStateByWallet', async () => ({ linked: false, link: null })),
		isDashboardSessionRevoked: rec.fn('isDashboardSessionRevoked', async () => false),
		recordAgentEvent: async () => {}, consumeDashboardAccess: rec.fn('consumeDashboardAccess', async () => null), getLanguage: async () => 'de',
		beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {}, revokeDashboardSessions: rec.fn('revokeDashboardSessions', async () => Date.now()),
		unlinkWalletByWallet: rec.fn('unlinkWalletByWallet', async () => []), unlinkWalletFromAllChats: rec.fn('unlinkWalletFromAllChats', async () => []), ...http,
		recordSecurityEvent: async () => {}, securityFingerprint: () => 'fp', SECURITY_EVENT, ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}
	};
	const source = strip('api/dashboard.mjs').replace('export default async function handler', 'async function handler');
	return new Function(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps));
}
const UNDECLARED_FOR_DASHBOARD = HOSTILE.filter((q) => !/^(wallet|code)=/.test(q));
const COOKIE_A = sessionCookie(A);
test('QUERY-IGNORED dashboard (declared: access, wallet, telegram): undeclared names never change whose dashboard is read', async () => {
	const base = await assertQueryHasNoEffect('dashboard', '/api/dashboard', async (url) => {
		const rec = recorder();
		const res = response();
		await dashboardHandler(rec)({ method: 'GET', url, headers: { 'x-forwarded-for': '198.51.100.11', cookie: COOKIE_A } }, res);
		const o = outcome(res, rec);
		delete o.body.checkedAt; // wall-clock timestamp of the response
		return o;
	}, UNDECLARED_FOR_DASHBOARD);
	assert.equal(base.body.wallet, A);
});

/* ---------------------------------------------------------------- inventory */
const CLASSIFICATION = {
	'api/alerts.mjs': 'IGNORED', 'api/config.mjs': 'IGNORED', 'api/csp-report.mjs': 'IGNORED', 'api/telegram.mjs': 'IGNORED', 'api/link/verify.mjs': 'IGNORED',
	'api/positions.mjs': 'REJECTED', 'api/position-attributions.mjs': 'REJECTED', 'api/nexus/quote.mjs': 'REJECTED',
	// Declared single-value parameters (duplicates -> '' per CR-API-004 P2); undeclared names are tested above (dashboard) or ignored by construction of the same reader (link).
	'api/dashboard.mjs': 'DECLARED', 'api/link.mjs': 'DECLARED'
};
const walk = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).flatMap((f) => (statSync(new URL(`../${dir}/${f}`, import.meta.url)).isDirectory() ? walk(`${dir}/${f}`) : f.endsWith('.mjs') ? [`${dir}/${f}`] : []));
test('QUERY-INVENTORY: every API handler is classified - a new endpoint fails here until its query behaviour is tested', () => {
	assert.deepEqual(walk('api').sort(), Object.keys(CLASSIFICATION).sort());
});

test('QUERY-IGNORED link (declared: code, wallet): undeclared names change neither the pending link read nor the message', async () => {
	const run = async (url) => {
		const rec = recorder();
		const http = httpSecurity(rec);
		const handler = compile('api/link.mjs', {
			isAddress, queryParams, singleQueryValue, ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}, enforceRateLimit: http.enforceRateLimit, enforceRateLimitFor: http.enforceRateLimitFor,
			getPendingLink: rec.fn('getPendingLink', async () => ({ chat_id: '123', nonce: 'ab'.repeat(16), expires_at: EXPIRES })),
			isTelegramLinkCode: (c) => typeof c === 'string' && /^[A-Za-z0-9_-]{24}$/.test(c), isTelegramLinkRow: () => true,
			signingMessage: (p) => `link ${p.wallet} ${p.code} ${p.target} ${p.nonce}`, telegramTarget: rec.fn('telegramTarget', async () => ({ target: '@raccoon_user' }))
		});
		const res = response();
		await handler({ method: 'GET', url, headers: { 'x-forwarded-for': '198.51.100.12' } }, res);
		return outcome(res, rec);
	};
	const declared = `?code=${LINK_CODE}&wallet=${A}`;
	const base = await run(`/api/link${declared}`);
	assert.equal(base.code, 200);
	for (const extra of ['admin=1', 'chat_id=777', 'role=service_role', 'debug=1', `session=${B}`, `address=${B}`]) assert.deepEqual(await run(`/api/link${declared}&${extra}`), base, extra);
	assert.ok(queryKeys(queryParams({ url: `/api/link${declared}&admin=1` })).includes('admin'), 'control: the extra name really reaches the parser');
});
