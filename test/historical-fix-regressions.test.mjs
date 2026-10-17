/**
 * CRSF Phase 2Q, CR-VERIFY-003: Verhaltenstests fuer historische Sicherheitskorrekturen,
 * deren bisherige Regressionstests nur den Quelltext lesen (oder gar nicht anschlugen).
 *
 * Jeder Test fuehrt den ECHTEN Code aus (Handler per loadHandler mit eingesetzten
 * Abhaengigkeiten, Module direkt) und prueft genau die Invariante, die die
 * jeweilige Korrektur hergestellt hat. Die Zuordnung Korrektur -> Test -> Mutation
 * steht in security/crsf/fix-register.json.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isAddress } from 'viem';
import { loadHandler, guards, strip, SECURITY_EVENT } from '../test-support/rate-order-world.mjs';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';

process.env.APP_BASE_URL = 'https://coverraccoon.com';
const SECRET = 'historical-fix-regressions-secret-0123456789abcdef';
process.env.DASHBOARD_SESSION_SECRET = SECRET;

// Datenbankantworten fuer src/db.mjs (echtes supabase-js, gefaelschtes Netz).
let dbAnswer = () => [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
	const url = String(input);
	if (url.startsWith(process.env.SUPABASE_URL ?? 'https://example.invalid')) return Response.json(dbAnswer(url, init));
	return realFetch(input, init);
};
const db = await import('../src/db.mjs');
const auth = await import('../src/dashboard-auth.mjs');
const { siweOrigin } = await import('../src/siwe-auth.mjs');

const WALLET = '0x' + 'ab'.repeat(20);
const response = () => ({
	headers: {}, logs: [],
	status(n) { this.code = n; return this; },
	setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
	json(b) { this.body = b; return this; },
	end() { this.ended = true; return this; }
});
const withEnv = (vars, fn) => {
	const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
	for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
	try { return fn(); } finally { for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};
const sign = (data) => {
	const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
	return `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
};

/** Der echte api/dashboard.mjs mit gezaehlten Abhaengigkeiten. */
function dashboard(overrides = {}) {
	const calls = { consume: 0, covers: 0, events: [] };
	const g = guards({ dashboardSecretConfigured: auth.dashboardSecretConfigured, siweOrigin });
	const deps = {
		isAddress, queryParams, singleQueryValue, ...auth,
		verifyWalletSiweAuthority: async () => ({ result: 'INVALID_SIGNATURE' }),
		verifyOnchainDashboardLoginApproval: async () => ({ result: 'INVALID_SIGNATURE' }),
		noContractCodeByQuorum: async () => true, isDeployedContract: async () => false,
		consumeDashboardChallenge: async () => true, isDashboardChallengeOpen: async () => true, storeDashboardChallenge: async () => {},
		getWalletCovers: async () => { calls.covers++; return { covers: [] }; },
		getWalletLinkStateByWallet: async () => ({ linked: false, link: null }),
		isDashboardSessionRevoked: async () => false,
		recordAgentEvent: async (e) => { calls.events.push(e.eventType); },
		consumeDashboardAccess: async () => { calls.consume++; return WALLET; },
		getLanguage: async () => 'de', beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		revokeDashboardSessions: async () => Date.now(), unlinkWalletByWallet: async () => [], unlinkWalletFromAllChats: async () => [],
		...g,
		recordSecurityEvent: async () => {}, securityFingerprint: () => 'fp', SECURITY_EVENT,
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {},
		...overrides
	};
	return { handler: loadHandler('api/dashboard.mjs', deps), calls };
}
const sessionCookie = () => `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(WALLET))}`;

test('HIST AGENT-SEC-A1 the rate-limit identity never falls back to the Telegram webhook secret', async () => {
	let counted = 0;
	const http = new Function('createHmac', 'checkRateLimit', 'dashboardSecretConfigured', 'siweOrigin', 'recordSecurityEvent', 'SECURITY_EVENT',
		`${strip('src/http-security.mjs').replace(/^export /gm, '')}\nreturn { enforceRateLimit };`)(
		createHmac, async () => { counted++; return true; }, auth.dashboardSecretConfigured, siweOrigin, async () => {}, SECURITY_EVENT);
	const res = response();
	const allowed = await withEnv({ DASHBOARD_SESSION_SECRET: undefined, TELEGRAM_WEBHOOK_SECRET: 'telegram-webhook-secret-0123456789abcdef' },
		() => http.enforceRateLimit({ headers: { 'x-forwarded-for': '203.0.113.7' } }, res, 'dashboard-read', 10, 600));
	assert.equal(allowed, false, 'without the dashboard secret the limiter must fail closed');
	assert.equal(res.code, 503, 'fail closed with 503, not a key derived from the webhook secret');
	assert.equal(counted, 0, 'no counter key was derived');
});

test('HIST AGENT-SEC-A3 challenges and sessions without the server-side iat (old message schema) are rejected', () => {
	const now = Date.now();
	const challenge = { type: 'challenge', wallet: WALLET, nonce: 'a'.repeat(32), rid: 'b'.repeat(32), exp: now + 60_000 };
	const session = { type: 'session', wallet: WALLET, exp: now + 60_000 };
	assert.equal(auth.verifyDashboardToken(sign(challenge)), null, 'legacy challenge without iat accepted');
	assert.equal(auth.verifyDashboardToken(sign(session)), null, 'legacy session without iat accepted');
	// Gegenprobe: dieselben Tokens MIT iat sind gueltig - der Test ist nicht taub.
	assert.ok(auth.verifyDashboardToken(sign({ ...challenge, iat: now })));
	assert.ok(auth.verifyDashboardToken(sign({ ...session, iat: now })));
});

test('HIST AUDIT SA-L2 an unverifiable revocation check serves no data (503), the provider is never asked', async () => {
	const { handler, calls } = dashboard({ isDashboardSessionRevoked: async () => { throw new Error('db down'); } });
	const res = response();
	await handler({ method: 'GET', url: '/api/dashboard', headers: { cookie: sessionCookie(), 'x-forwarded-for': '203.0.113.8' }, query: {} }, res);
	assert.equal(res.code, 503, 'revocation check failure must fail closed');
	assert.equal(res.body.code, 'SESSION_CHECK_UNAVAILABLE');
	assert.equal(calls.covers, 0, 'no cover data was loaded for an unverifiable session');
	assert.equal('covers' in res.body, false);
});

test('HIST AGENT-AUTH-002 GET ?access= never consumes the one-time code and points to POST', async () => {
	const { handler, calls } = dashboard();
	const res = response();
	await handler({ method: 'GET', url: '/api/dashboard?access=AccessCode0123456789abcdefgh', headers: { 'x-forwarded-for': '203.0.113.9' }, query: { access: 'AccessCode0123456789abcdefgh' } }, res);
	assert.equal(res.code, 405);
	assert.equal(res.body.code, 'ACCESS_REDEEM_VIA_POST');
	assert.equal(calls.consume, 0, 'GET consumed the access code');
	assert.deepEqual(calls.events, [], 'GET wrote an event');
});

test('HIST AGENT-SEC-A2 redeeming a Telegram access code yields no session: no cookie, only the expected wallet', async () => {
	const { handler, calls } = dashboard();
	const res = response();
	await handler({ method: 'POST', url: '/api/dashboard', headers: { origin: 'https://coverraccoon.com', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' }, body: { access: 'AccessCode0123456789abcdefgh' } }, res);
	assert.equal(calls.consume, 1);
	assert.equal(res.code, 200);
	assert.deepEqual(res.body, { ok: false, code: 'WALLET_SIGNATURE_REQUIRED', wallet: WALLET });
	assert.equal(res.headers['set-cookie'], undefined, 'the access code issued a session cookie');
});

test('HIST 062201c a wallet linked to several chats exposes no chat-specific metadata', async () => {
	const row = (chat) => ({ chat_id: chat, wallet: WALLET, alerts_enabled: true, label: `label-${chat}`, is_primary: true, alert_thresholds: [7], weekly_summary: false });
	dbAnswer = () => [row('101'), row('202')];
	assert.deepEqual(await db.getWalletLinkStateByWallet(WALLET), { linked: true, link: null }, 'several chats: an arbitrary chat label/settings leaked');
	dbAnswer = () => [row('101')];
	assert.deepEqual(await db.getWalletLinkStateByWallet(WALLET), { linked: true, link: row('101') });
	dbAnswer = () => [];
});

test('HIST AGENT-IR-002 a forged webhook call is recorded as a security event with a fingerprint, never the raw IP or token', async () => {
	const events = [];
	const handler = loadHandler('api/telegram.mjs', {
		timingSafeEqual, handleUpdate: async () => { throw new Error('must not run'); }, claimTelegramUpdate: async () => true,
		bodyTooLarge: () => false, isPrivateChatUpdate: () => true, SECURITY_EVENT,
		recordSecurityEvent: async (type, meta) => { events.push({ type, ...meta }); },
		securityFingerprint: (value) => createHmac('sha256', 'fp').update(String(value)).digest('hex').slice(0, 16)
	});
	const res = response();
	await withEnv({ TELEGRAM_WEBHOOK_SECRET: 'the-real-webhook-secret-0123456789' }, () =>
		handler({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'forged-token', 'x-forwarded-for': '198.51.100.23, 10.0.0.1' }, body: { update_id: 1 } }, res));
	assert.equal(res.code, 401);
	assert.equal(events.length, 1, 'webhook authentication failure was not recorded');
	assert.equal(events[0].type, 'WEBHOOK_AUTH_FAILED');
	const stored = JSON.stringify(events[0]);
	assert.equal(stored.includes('198.51.100.23'), false, 'raw IP stored');
	assert.equal(stored.includes('forged-token'), false, 'token stored');
});

function alertsHandler({ run, purge, alerts }) {
	return loadHandler('api/alerts.mjs', {
		timingSafeEqual, checkExpiryAlerts: run, purgeOldRecords: purge,
		beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		alertOperatorCronFailure: async (kind) => { alerts.push(kind); }, telegramText: (t) => t
	});
}
const cronEnv = { CRON_SECRET: 'cron-secret-0123456789abcdef', TELEGRAM_BOT_TOKEN: '123:test-token' };
const cronRequest = { method: 'GET', headers: { authorization: 'Bearer cron-secret-0123456789abcdef' } };

test('HIST AGENT-IR-001 a failed reminder run alerts the operator once with a generic id and answers a generic 500', async () => {
	const alerts = [];
	const handler = alertsHandler({ run: async () => { throw new Error('connection to db.internal failed: password=hunter2'); }, purge: async () => ({}), alerts });
	const res = response();
	await withEnv(cronEnv, () => handler(cronRequest, res));
	assert.equal(res.code, 500);
	assert.deepEqual(res.body, { ok: false });
	assert.deepEqual(alerts, ['expiry-alert-run'], 'the operator was not alerted about the failed run');
});

test('HIST AGENT-API-003 the cron answer carries no internal database error text', async () => {
	const alerts = [];
	const handler = alertsHandler({ run: async () => ({ sent: 1 }), purge: async () => ({ agent_events: 'fehler: permission denied for relation agent_events (role service_x)', sent_alerts: 3 }), alerts });
	const res = response();
	await withEnv(cronEnv, () => handler(cronRequest, res));
	assert.equal(res.code, 200);
	assert.deepEqual(res.body.bereinigt, { agent_events: 'fehler', sent_alerts: 3 });
	assert.equal(JSON.stringify(res.body).includes('permission denied'), false, 'raw database error leaked');
	assert.deepEqual(alerts, ['purge']);
});

test('HIST AGENT-API-002 csp-report is rate limited before anything is parsed or logged', async () => {
	const logged = [];
	const original = console.log;
	console.log = (...args) => { logged.push(args.join(' ')); };
	try {
		const g = guards({ deny: 'csp-report', dashboardSecretConfigured: auth.dashboardSecretConfigured, siweOrigin });
		const handler = loadHandler('api/csp-report.mjs', { bodyTooLarge: () => false, enforceRateLimit: g.enforceRateLimit });
		const res = response();
		await handler({ method: 'POST', headers: { 'x-forwarded-for': '203.0.113.11' }, body: { 'csp-report': { 'effective-directive': 'script-src', 'blocked-uri': 'eval' } } }, res);
		assert.equal(res.code, 429, 'csp-report has no rate limit');
		assert.deepEqual(g.limits, ['csp-report']);
		assert.deepEqual(logged, [], 'a rate-limited report was still logged');
	} finally { console.log = original; }
});

test('HIST AGENT-SEC-A6 /api/config delivers a Telegram bot name only in Telegram format', async () => {
	const { default: config } = await import('../api/config.mjs');
	const ask = (name) => withEnv({ TELEGRAM_BOT_USERNAME: name }, () => { const res = response(); config({}, res); return res.body.telegramUsername; });
	assert.equal(ask('@Raccoon_Agent_Bot'), 'Raccoon_Agent_Bot');
	for (const bad of ['evil.example/x', 'bot?start=1', 'a', 'x'.repeat(33), 'name with space', 'javascript:alert(1)', 'bot#frag']) {
		assert.equal(ask(bad), '', `${JSON.stringify(bad)} delivered as Telegram bot name`);
	}
});

test('HIST d18c95b csp-report logs only directive and blocked origin - never the page address or referrer with link codes', async () => {
	const logged = [];
	const original = console.log;
	console.log = (...args) => { logged.push(args.join(' ')); };
	try {
		const g = guards({ dashboardSecretConfigured: auth.dashboardSecretConfigured, siweOrigin });
		const handler = loadHandler('api/csp-report.mjs', { bodyTooLarge: () => false, enforceRateLimit: g.enforceRateLimit });
		const report = {
			'effective-directive': 'script-src-elem', 'blocked-uri': 'https://evil.example/x.js?wallet=0xabc',
			'document-uri': 'https://coverraccoon.com/?code=SecretLinkCode0123456789', referrer: 'https://coverraccoon.com/?access=SecretAccessCode0123'
		};
		const res = response();
		await handler({ method: 'POST', headers: { 'x-forwarded-for': '203.0.113.12' }, body: { 'csp-report': report } }, res);
		assert.equal(res.code, 204);
		assert.deepEqual(logged, ['csp-report richtlinie=script-src-elem blockiert=https://evil.example']);
		assert.equal(logged.join('\n').includes('Secret'), false, 'a link or access code reached the log');
	} finally { console.log = original; }
});

test('HIST AGENT-SAFE-1 the challenge lifetime is decided by the server alone - client hints never lengthen it', async () => {
	const { handler } = dashboard({ isDeployedContract: async () => false });
	const hints = { wallet: WALLET, multisig: '1', contract: 'true', kind: 'contract', ttl: '1800000', safe: '1' };
	const url = `/api/dashboard?${new URLSearchParams(hints)}`;
	const res = response();
	await handler({ method: 'GET', url, headers: { 'x-forwarded-for': '203.0.113.13', 'x-wallet-kind': 'contract' }, query: hints }, res);
	assert.equal(res.code, 200, JSON.stringify(res.body));
	const challenge = auth.verifyDashboardToken(res.body.token);
	assert.ok(challenge.exp - challenge.iat <= auth.DASHBOARD_CHALLENGE_TTL_EOA_MS, `an EOA got a ${challenge.exp - challenge.iat} ms challenge from client hints`);
});

test('HIST AGENT-SAFE-2 a strict cookie and a Safe-App cookie for different wallets fail closed (401, cookies cleared, no data)', async () => {
	const other = '0x' + 'cd'.repeat(20);
	const strict = `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(WALLET))}`;
	const safeApp = `${auth.SAFEAPP_COOKIE}=${encodeURIComponent(auth.createDashboardSession(other, Date.now(), 'contract'))}`;
	assert.equal(auth.resolveDashboardSession({ headers: { cookie: safeApp } }).session?.wallet, other, 'control: the Safe-App cookie alone is a valid session');
	const { handler, calls } = dashboard();
	const res = response();
	await handler({ method: 'GET', url: '/api/dashboard', headers: { cookie: `${strict}; ${safeApp}`, 'x-forwarded-for': '203.0.113.14' }, query: {} }, res);
	assert.equal(res.code, 401, `conflicting sessions served data as ${JSON.stringify(res.body)?.slice(0, 120)}`);
	assert.equal(res.body.code, 'NO_SESSION');
	assert.ok(res.headers['set-cookie'], 'cookies not cleared');
	assert.equal(calls.covers, 0);
});

test('HIST HARD-004 an already-revoked session cannot sign out (revoke) the newer sessions of its wallet', async () => {
	const signOut = async (revoked) => {
		const revokes = [];
		const { handler } = dashboard({ isDashboardSessionRevoked: async () => revoked, revokeDashboardSessions: async (wallet) => { revokes.push(wallet); return Date.now(); } });
		const res = response();
		await handler({ method: 'DELETE', url: '/api/dashboard', headers: { cookie: sessionCookie(), origin: 'https://coverraccoon.com', 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '203.0.113.15' }, query: {}, body: undefined }, res);
		return { res, revokes };
	};
	const control = await signOut(false);
	assert.deepEqual(control.revokes, [WALLET], `control: a live session signs out wallet-wide (${control.res.code} ${JSON.stringify(control.res.body)})`);
	const stale = await signOut(true);
	assert.deepEqual(stale.revokes, [], 'a revoked session moved the wallet cutoff and signed out newer sessions');
	assert.equal(stale.res.code, 200);
	assert.ok(stale.res.headers['set-cookie'], 'the stale cookie is cleared');
});
