/*
	Erweitertes Sicherheitsaudit vom 14.10.2026: die vier LOW-Befunde.

	E-L1  abgelaufene Dashboard-Sitzungen (Cookie UND Bearer) werden abgelehnt,
	      bevor Datenbank oder RPC beruehrt werden.
	E-L2  der Telegram-Signaturtext nennt das Ziel (Chat), und dieses Ziel kommt
	      ausschliesslich aus der serverseitig gebundenen Chat-ID.
	E-L3  fremde Produktnamen sind begrenzt, jede Telegram-Nachricht bleibt unter
	      4096 Zeichen, und ein gescheiterter Versand haelt die weiteren Covers
	      desselben Abos nicht auf.
	E-L4  csp-report loggt nur Werte aus einer Allowlist, nie Zeilenumbrueche.

	Kein Netz, keine Datenbank, nur Wegwerf-Schluessel ohne Guthaben.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

process.env.DASHBOARD_SESSION_SECRET = 'extended-audit-low-secret-0123456789abcdef';
process.env.APP_BASE_URL = 'https://coverraccoon.com';

const auth = await import('../src/dashboard-auth.mjs');
const linking = await import('../src/linking.mjs');
const siwe = await import('../src/siwe-auth.mjs');
const requestQuery = await import('../src/request-query.mjs');
const { createAttributionsHandler } = await import('../api/position-attributions.mjs');
const { createPositionsHandler } = await import('../api/positions.mjs');
const { boundedDisplayText, telegramText, MAX_DISPLAY_NAME, TELEGRAM_TEXT_MAX } = await import('../src/display-text.mjs');
const { serializeChainCover } = await import('../src/cover-chain.mjs');
const { formatExpiryAlert, sendExpiryAlertsFor } = await import('../src/alerts.mjs');
const { cspLogFields } = await import('../api/csp-report.mjs');

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WEEK = 7 * 24 * 60 * 60_000;
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
function res() {
	return { statusCode: null, body: null, headers: {}, headersSent: false, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; this.code = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
}

/* ================================================================== E-L1 */

function expiredSession() {
	// Ausgestellt vor 7 Tagen + 1 Minute: alles stimmt, nur exp liegt in der Vergangenheit.
	return auth.createDashboardSession(A, Date.now() - WEEK - 60_000);
}

test('E-L1: an expired session token is structurally valid - correct HMAC, type, wallet, iat - only exp is past', () => {
	const token = expiredSession();
	const [payload, signature] = token.split('.');
	assert.equal(token.split('.').length, 2);
	assert.equal(signature, createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('base64url'), 'HMAC stimmt');
	const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
	assert.equal(data.type, 'session');
	assert.equal(data.wallet, A);
	assert.ok(Number.isFinite(data.iat));
	assert.ok(Number.isFinite(data.exp) && data.exp < Date.now(), 'exp liegt in der Vergangenheit');
	// Gegenprobe: dieselbe Konstruktion eine Minute vor Ablauf ist gueltig.
	assert.equal(auth.verifyDashboardSession(auth.createDashboardSession(A, Date.now() - WEEK + 60_000))?.wallet, A);
	assert.equal(auth.verifyDashboardSession(token), null);
});

test('E-L1: the central resolver rejects an expired COOKIE session', () => {
	const r = auth.resolveDashboardSession({ headers: { cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(expiredSession())}` } });
	assert.deepEqual(r, { conflict: false, session: null });
});

// Safe-App-Sitzung (15.10.2026): der Bearer ist entfernt; die Safe App traegt ihre
// Contract-Sitzung (24 h) im partitionierten Safe-App-Cookie.
function expiredSafeAppCookie() {
	return `__Host-raccoon_safeapp=${encodeURIComponent(auth.createDashboardSession(A, Date.now() - auth.SESSION_TTL_CONTRACT_MS - 60_000, 'contract'))}`;
}

test('E-L1: the central resolver rejects an expired SAFE-APP-COOKIE session (and ignores any bearer)', () => {
	assert.deepEqual(auth.resolveDashboardSession({ headers: { cookie: expiredSafeAppCookie() } }), { conflict: false, session: null });
	// Gegenprobe: dieselbe Konstruktion eine Minute vor Ablauf ist gueltig.
	const live = `__Host-raccoon_safeapp=${encodeURIComponent(auth.createDashboardSession(A, Date.now() - auth.SESSION_TTL_CONTRACT_MS + 60_000, 'contract'))}`;
	assert.equal(auth.resolveDashboardSession({ headers: { cookie: live } }).session?.wallet, A);
	assert.deepEqual(auth.resolveDashboardSession({ headers: { authorization: `Bearer ${auth.createDashboardSession(A, Date.now(), 'contract')}` } }), { conflict: false, session: null });
});

test('E-L1: protected endpoints stop at 401 for an expired Strict cookie and Safe-App cookie - no revocation, DB or RPC call', async () => {
	for (const headers of [{ cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(expiredSession())}` }, { cookie: expiredSafeAppCookie() }]) {
		const calls = [];
		const touch = (name) => async () => { calls.push(name); throw new Error(`${name} must not run`); };
		const attributions = createAttributionsHandler({
			getPositions: touch('positions'), getCovers: touch('covers'), listRows: touch('list'), upsertRow: touch('upsert'), deleteRow: touch('delete'),
			isRevoked: touch('revoked'), rateLimit: async () => true, rateLimitFor: async () => true
		});
		for (const method of ['GET', 'POST', 'DELETE']) {
			const r = res();
			await attributions({ method, url: '/api/position-attributions', headers: { ...headers, ...(method === 'GET' ? {} : { 'content-type': 'application/json', origin: 'https://coverraccoon.com' }) }, body: { deploymentKey: 'aave-v3-ethereum-core', coverId: 1 } }, r);
			assert.equal(r.statusCode, 401, `${Object.keys(headers)[0]} ${method}`);
			assert.equal(r.body.code, 'NO_SESSION');
		}
		const positions = createPositionsHandler({ getPositions: touch('positions'), isRevoked: touch('revoked'), rateLimit: async () => true, rateLimitFor: async () => true });
		const r = res();
		await positions({ method: 'GET', url: '/api/positions', headers }, r);
		assert.equal(r.statusCode, 401);
		assert.deepEqual(calls, [], 'kein nachgelagerter Aufruf');
	}
});

/* ================================================================== E-L2 */

const CHAT_A = '5550001111';
const CHAT_B = '5550002222';
const CHATS = {
	[CHAT_A]: { id: Number(CHAT_A), type: 'private', username: 'alice_owner', first_name: 'Alice' },
	[CHAT_B]: { id: Number(CHAT_B), type: 'private', username: 'bob_attacker', first_name: 'Bob' }
};
const CODE_A = 'AliceLinkCode_0123456789';
const NONCE = 'ab'.repeat(16);

function loadHandler(source, deps) {
	const body = source.replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
	return new Function(...Object.keys(deps), `${body}\nreturn handler;`)(...Object.values(deps));
}

function linkWorld() {
	const pending = { [CODE_A]: { code: CODE_A, chat_id: CHAT_A, nonce: NONCE, expires_at: Date.now() + 540_000, used_at: null } };
	const state = { getChat: [], consumed: [], notified: [] };
	// Echte telegramTarget-Logik; nur der Telegram-Aufruf ist ersetzt und protokolliert.
	const telegramTarget = (chatId) => linking.telegramTarget(chatId, {
		token: 'offline-placeholder',
		fetchImpl: async (url) => { const id = new URL(url).searchParams.get('chat_id'); state.getChat.push(id); return { json: async () => ({ ok: true, result: CHATS[id] }) }; }
	});
	const common = {
		isAddress: (v) => /^0x[0-9a-fA-F]{40}$/.test(v), ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {},
		getPendingLink: async (code) => pending[code] ?? null,
		isTelegramLinkCode: linking.isTelegramLinkCode, isTelegramLinkRow: linking.isTelegramLinkRow,
		signingMessage: linking.signingMessage, telegramTarget
	};
	const get = loadHandler(read('api/link.mjs'), { ...common, enforceRateLimit: async () => true, queryParams: requestQuery.queryParams, singleQueryValue: requestQuery.singleQueryValue });
	const verify = loadHandler(read('api/link/verify.mjs'), {
		...common, requireSameOrigin: () => true, requireJson: () => true, enforceRateLimit: async () => true, enforceRateLimitFor: async () => true,
		linkSiweExpectation: linking.linkSiweExpectation,
		verifyWalletSiweSignature: (params) => siwe.verifyExpectedSiweSignature(params),
		consumePendingLink: async (code, wallet) => { const row = pending[code]; if (!row || row.used_at) return null; row.used_at = Date.now(); state.consumed.push([code, wallet]); return row.chat_id; },
		recordSecurityEvent: async () => {}, SECURITY_EVENT: {}, securityFingerprint: () => 'fp',
		getLanguage: async () => 'en', newDashboardAccess: async () => ({ code: 'access' }),
		process: { env: { TELEGRAM_BOT_TOKEN: 'offline-placeholder', APP_BASE_URL: 'https://coverraccoon.com' } },
		fetch: async (url, init) => { state.notified.push(JSON.parse(init.body).chat_id); return { ok: true }; }
	});
	return { pending, state, get, verify };
}

test('E-L2 A: the consent text for a link of chat A names chat A, and the page shows the same detail', async () => {
	const { get, state } = linkWorld();
	const signer = privateKeyToAccount(generatePrivateKey());
	const info = res();
	await get({ method: 'GET', url: `/api/link?code=${CODE_A}`, headers: {} }, info);
	assert.equal(info.body.telegram.target, '@alice_owner');
	const r = res();
	await get({ method: 'GET', url: `/api/link?code=${CODE_A}&wallet=${signer.address}`, headers: {} }, r);
	assert.equal(r.statusCode, 200);
	assert.match(r.body.message, /for Telegram @alice_owner\. This does not authorize/);
	assert.equal(siwe.checkSiweMessage(r.body.message, linking.linkSiweExpectation({ wallet: signer.address, nonce: NONCE, expiresAt: Date.now() + 540_000, code: CODE_A, target: '@alice_owner' })) !== 'STATEMENT_MISMATCH', true);
	assert.deepEqual([...new Set(state.getChat)], [CHAT_A], 'nur die gebundene Chat-ID wird nachgeschlagen');
});

test('E-L2 B: the browser cannot substitute chat B - query, body and header values are ignored', async () => {
	const { get, verify, state, pending } = linkWorld();
	const signer = privateKeyToAccount(generatePrivateKey());
	const r = res();
	await get({ method: 'GET', url: `/api/link?code=${CODE_A}&wallet=${signer.address}&target=%40bob_attacker&chat_id=${CHAT_B}&telegram=bob`, headers: { 'x-telegram-target': '@bob_attacker' } }, r);
	assert.match(r.body.message, /for Telegram @alice_owner\./);
	assert.doesNotMatch(r.body.message, /bob/);
	// Eine Signatur ueber einen Text mit Chat-B-Kennung passt nicht - auch nicht, wenn der Body sie mitliefert.
	const forged = linking.signingMessage({ wallet: signer.address, nonce: NONCE, expiresAt: pending[CODE_A].expires_at, code: CODE_A, target: '@bob_attacker' });
	const forgedSignature = await signer.signMessage({ message: forged });
	const v = res();
	await verify({ method: 'POST', body: { code: CODE_A, wallet: signer.address, signature: forgedSignature, target: '@bob_attacker', chatId: CHAT_B, message: forged }, headers: { 'x-telegram-target': '@bob_attacker' } }, v);
	assert.equal(v.statusCode, 401);
	assert.deepEqual(state.consumed, [], 'nichts verbraucht');
	assert.deepEqual(state.notified, []);
	assert.ok(state.getChat.every((id) => id === CHAT_A));
});

test('E-L2 F: a correct signature activates the link only for the server-bound chat; C: replay is refused', async () => {
	const { get, verify, state } = linkWorld();
	const signer = privateKeyToAccount(generatePrivateKey());
	const r = res();
	await get({ method: 'GET', url: `/api/link?code=${CODE_A}&wallet=${signer.address}`, headers: {} }, r);
	const signature = await signer.signMessage({ message: r.body.message });
	const ok = res();
	await verify({ method: 'POST', body: { code: CODE_A, wallet: signer.address, signature, chatId: CHAT_B }, headers: {} }, ok);
	assert.equal(ok.statusCode, 200);
	assert.deepEqual(state.consumed, [[CODE_A, signer.address]]);
	assert.deepEqual(state.notified, [CHAT_A], 'Bestaetigung nur an den gebundenen Chat');
	const again = res();
	await verify({ method: 'POST', body: { code: CODE_A, wallet: signer.address, signature }, headers: {} }, again);
	assert.equal(again.statusCode, 410, 'verbrauchter Link');
	assert.equal(state.consumed.length, 1);
});

test('E-L2: without a confirmed Telegram target there is no text to sign and nothing is consumed (fail closed)', async () => {
	const { pending } = linkWorld();
	const signer = privateKeyToAccount(generatePrivateKey());
	const consumed = [];
	for (const telegramTarget of [async () => null, (chatId) => linking.telegramTarget(chatId, { token: 'x', fetchImpl: async () => { throw new Error('telegram down'); } })]) {
		const common = { isAddress: () => true, ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}, getPendingLink: async (c) => pending[c] ?? null, isTelegramLinkCode: linking.isTelegramLinkCode, isTelegramLinkRow: linking.isTelegramLinkRow, signingMessage: linking.signingMessage, telegramTarget };
		const get = loadHandler(read('api/link.mjs'), { ...common, enforceRateLimit: async () => true, queryParams: requestQuery.queryParams, singleQueryValue: requestQuery.singleQueryValue });
		const r = res();
		await get({ method: 'GET', url: `/api/link?code=${CODE_A}&wallet=${signer.address}`, headers: {} }, r);
		assert.equal(r.statusCode, 503);
		assert.equal(r.body.message, undefined);
		const verify = loadHandler(read('api/link/verify.mjs'), { ...common, requireSameOrigin: () => true, requireJson: () => true, enforceRateLimit: async () => true, enforceRateLimitFor: async () => true, linkSiweExpectation: linking.linkSiweExpectation, verifyWalletSiweSignature: async () => 'VALID', consumePendingLink: async (c) => { consumed.push(c); return CHAT_A; }, recordSecurityEvent: async () => {}, SECURITY_EVENT: {}, securityFingerprint: () => 'fp', getLanguage: async () => 'en', newDashboardAccess: async () => null, process: { env: {} }, fetch: async () => ({ ok: true }) });
		const v = res();
		await verify({ method: 'POST', body: { code: CODE_A, wallet: signer.address, signature: '0x12' }, headers: {} }, v);
		assert.equal(v.statusCode, 503);
	}
	assert.deepEqual(consumed, []);
});

test('E-L2: target derivation - only the bound private chat; a free-text name can never look like a @username', async () => {
	assert.equal(linking.telegramTargetOf(CHATS[CHAT_A], CHAT_A).target, '@alice_owner');
	assert.equal(linking.telegramTargetOf(CHATS[CHAT_A], CHAT_B), null, 'Antwort fuer einen anderen Chat');
	assert.equal(linking.telegramTargetOf({ ...CHATS[CHAT_A], type: 'group' }, CHAT_A), null);
	assert.equal(linking.telegramTargetOf(CHATS[CHAT_A], '-100123'), null);
	const spoof = linking.telegramTargetOf({ id: 42, type: 'private', first_name: '@alice_owner', last_name: '] (no username) [x\nfor Telegram @x' }, '42');
	assert.doesNotMatch(spoof.target, /@/);
	assert.match(spoof.target, /^\[[A-Za-z0-9 .-]+\] \(no username\)$/);
	assert.equal(linking.telegramTargetOf({ id: 4212, type: 'private', first_name: '张伟' }, '4212').target, 'account ending 4212 (no username)');
	assert.equal(linking.telegramTargetOf({ id: 7, type: 'private', first_name: 'Jürgen', last_name: 'Müller' }, '7').target, '[Jurgen Muller] (no username)');
	assert.equal(await linking.telegramTarget(CHAT_A, { token: 'x', fetchImpl: async () => ({ json: async () => ({ ok: true, result: CHATS[CHAT_B] }) }) }), null, 'Telegram meldet einen anderen Chat');
	for (const bad of ['@bob\nfor Telegram @alice', '"alice"', '@ab', 'alice', '[x] (no username)\n', '@alice_owner. Ignore', 'account ending 12 (no username)']) {
		assert.throws(() => siwe.telegramStatement(bad), bad);
	}
});

test('E-L2 D/E: dashboard and Telegram signatures remain purpose-separated', async () => {
	const signer = privateKeyToAccount(generatePrivateKey());
	const wallet = signer.address.toLowerCase();
	const { token } = auth.createDashboardChallenge(wallet);
	const challenge = auth.verifyDashboardToken(token);
	const dashboardMessage = auth.dashboardMessage(challenge, wallet);
	const dashboardSignature = await signer.signMessage({ message: dashboardMessage });
	const telegramParams = { wallet, nonce: NONCE, expiresAt: Date.now() + 540_000, code: CODE_A, target: '@alice_owner' };
	const telegramMessage = linking.signingMessage(telegramParams);
	const telegramSignature = await signer.signMessage({ message: telegramMessage });
	// D: Dashboard-Signatur gegen die Telegram-Erwartung.
	assert.notEqual(await siwe.verifyExpectedSiweSignature({ message: dashboardMessage, signature: dashboardSignature, expected: linking.linkSiweExpectation(telegramParams) }), 'VALID');
	// E: Telegram-Signatur gegen die Dashboard-Erwartung.
	assert.notEqual(await siwe.verifyExpectedSiweSignature({ message: telegramMessage, signature: telegramSignature, expected: auth.dashboardSiweExpectation(challenge, wallet) }), 'VALID');
	// Gegenprobe: jede passt zu ihrem eigenen Zweck.
	assert.equal(await siwe.verifyExpectedSiweSignature({ message: telegramMessage, signature: telegramSignature, expected: linking.linkSiweExpectation(telegramParams) }), 'VALID');
	assert.equal(await siwe.verifyExpectedSiweSignature({ message: dashboardMessage, signature: dashboardSignature, expected: auth.dashboardSiweExpectation(challenge, wallet) }), 'VALID');
});

/* ================================================================== E-L3 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-14T08:00:00Z');
const chainRaw = (coverId, extra = {}) => ({ coverId, coverAsset: 1, start: Math.floor((NOW - 30 * DAY) / 1000), period: 33 * 24 * 3600, gracePeriod: 0, latestCoverId: 0, originalCoverId: 0, productId: 97, amount: 1_000_000n, ...extra });

test('E-L3 1/2: a 5000-character upstream product name is bounded and the reminder stays within 4096 characters', () => {
	const hostile = `${'X'.repeat(4990)}\n/start‮<b>`;
	const cover = serializeChainCover(chainRaw(1), hostile, NOW);
	assert.ok(Array.from(cover.productName).length <= MAX_DISPLAY_NAME, `name ${cover.productName.length}`);
	assert.doesNotMatch(cover.productName, /[\n\r\t‮]/);
	for (const language of ['de', 'en', 'zh']) {
		const text = formatExpiryAlert({ ...cover, productName: hostile }, 3, language, null);
		assert.ok(text.length <= TELEGRAM_TEXT_MAX, `${language}: ${text.length}`);
		assert.doesNotMatch(text, /X{200}/);
	}
	assert.equal(boundedDisplayText('Aave v3'), 'Aave v3', 'normale Namen bleiben');
	assert.equal(boundedDisplayText('  \n\t '), null);
	assert.equal(boundedDisplayText(42), null);
	assert.equal(serializeChainCover(chainRaw(2), undefined, NOW).productName, null);
	assert.equal(serializeChainCover(chainRaw(3), 'Aave v3', NOW).productId, 97, 'IDs unveraendert');
});

test('E-L3 2: the last barrier keeps every Telegram text within 4096 characters without splitting a surrogate pair', () => {
	assert.equal(telegramText('kurz'), 'kurz');
	const long = telegramText('😀'.repeat(5000));
	assert.ok(long.length <= TELEGRAM_TEXT_MAX);
	assert.doesNotMatch(long, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'kein halbes Surrogatpaar');
	assert.match(read('api/alerts.mjs'), /text: telegramText\(text\)/);
});

test('E-L3 3/4/5: a failed send for one cover does not suppress the next; only the successful one is marked sent', async () => {
	const subscription = { chat_id: '777', wallet: A, language: 'de', alert_thresholds: [7] };
	const due = (coverId) => ({ coverId, productId: 97, productName: 'Aave v3', status: 'active', amount: '1', asset: { symbol: 'USDC' }, endsAt: new Date(NOW + 3 * DAY).toISOString() });
	const result = { wallet: A, covers: [due(11), due(12), due(13)] };
	const attempts = [];
	const marked = [];
	const errors = [];
	const counts = await sendExpiryAlertsFor(subscription, result, {
		sendMessage: async (chatId, text, options) => { attempts.push(text.match(/Cover #(\d+)/)?.[1] ?? text); assert.equal(options.parse_mode, undefined, 'kein parse_mode'); if (attempts.length === 1) throw new Error('Bad Request: message is too long'); },
		now: NOW, logger: { error: (...args) => errors.push(args.join(' ')) },
		loadAttributions: async () => [], loadPositions: async () => null,
		wasSent: async () => false, recordSent: async (chatId, coverId) => { marked.push(coverId); }, newAccess: async () => ({ code: 'c' })
	});
	assert.equal(attempts.length, 3, 'alle drei Covers versucht');
	assert.deepEqual(marked, [12, 13], 'das gescheiterte Cover 11 ist NICHT als gesendet vermerkt');
	assert.deepEqual(counts, { sent: 2, failed: 1 });
	assert.equal(errors.length, 1);
	assert.match(errors[0], /Cover 11/);
});

test('E-L3 6: reminders stay plain text - no parse_mode anywhere in the cron path, markup in names stays literal', () => {
	for (const file of ['api/alerts.mjs', 'src/alerts.mjs', 'src/display-text.mjs']) assert.doesNotMatch(read(file), /parse_mode\s*:|['"`]parse_mode['"`]/, file);
	const text = formatExpiryAlert({ coverId: 1, productId: 97, productName: '<b>Aave</b> *x* [y](z)', status: 'active', amount: '1', asset: { symbol: 'USDC' }, endsAt: new Date(NOW + DAY).toISOString() }, 1, 'en', null);
	assert.match(text, /<b>Aave<\/b> \*x\* \[y\]\(z\)/);
});

/* ================================================================== E-L4 */

test('E-L4: csp-report logs only allow-listed directive values; everything else becomes "?"', () => {
	const cases = [
		['script-src', 'script-src'],
		['style-src-elem', 'style-src-elem'],
		['SCRIPT-SRC', '?'],
		['script-src\ncsp-report richtlinie=fake blockiert=https://ok', '?'],
		['script-src\r\nfake', '?'],
		['script-src\tfake', '?'],
		['a'.repeat(41), '?'],
		["script-src'", '?'],
		['"script-src"', '?'],
		['script-src;', '?'],
		['script src', '?'],
		['script-src\u0000', '?'],
		['script-src\u2028x', '?'],
		[42, '?'],
		[undefined, '?']
	];
	for (const [value, expected] of cases) assert.equal(cspLogFields({ 'effective-directive': value }).richtlinie, expected, JSON.stringify(value));
	assert.equal(cspLogFields({ effectiveDirective: 'img-src' }).richtlinie, 'img-src');
	assert.equal(cspLogFields({ 'violated-directive': 'connect-src\nx' }).richtlinie, '?');
});

test('E-L4: the blocked URI is logged only as an origin or a CSP keyword, never with control characters', () => {
	assert.equal(cspLogFields({ 'blocked-uri': 'https://evil.example/path?secret=1' }).blockiert, 'https://evil.example');
	assert.equal(cspLogFields({ 'blocked-uri': 'inline' }).blockiert, 'inline');
	assert.equal(cspLogFields({ blockedURL: 'eval' }).blockiert, 'eval');
	for (const bad of ['inline\nFAKE LINE', 'javascript:alert(1)', 'data:text/html,x', '\r\n', 'x'.repeat(3000), 'https://a.example/\u2028x', 42]) {
		const { blockiert } = cspLogFields({ 'blocked-uri': bad });
		assert.doesNotMatch(String(blockiert), /[\u0000-\u001f\u007f\u2028\u2029]/, JSON.stringify(bad).slice(0, 30));
	}
	assert.equal(cspLogFields({ 'blocked-uri': 'inline\nFAKE LINE' }).blockiert, '?');
	for (const [field, value] of Object.entries(cspLogFields({ 'effective-directive': 'x\ny', 'blocked-uri': 'y\nz' }))) assert.doesNotMatch(value, /\n/, field);
});
