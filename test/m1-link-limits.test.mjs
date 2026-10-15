/*
	Restaudit M1, 15.10.2026 - Link-Codes und Wallet-Limit, JavaScript-Seite.

	D/E/F: newLinkRequest gegen eine Rate-Limit-Attrappe mit derselben Semantik wie
	public.check_agent_rate_limit (jeder Aufruf zaehlt, erlaubt solange <= max).
	Geprueft wird, dass je Chat und global begrenzt wird und dass bei Ablehnung
	NICHTS angelegt wird - die Pruefungen liegen vor jedem Schreiben.
	A/B/C laufen gegen echten Postgres in m1-wallet-limit-db.test.mjs; hier: was
	Endpunkt und Bot aus dem Ergebnis der Datenbank machen.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { fakePostgrest } from '../test-support/fake-postgrest.mjs';

process.env.SUPABASE_URL ??= 'https://offline.invalid';
process.env.SUPABASE_SECRET_KEY ??= 'm1-link-limits-test-not-a-key';
process.env.DASHBOARD_SESSION_SECRET = 'm1-link-limits-secret-0123456789abcdef-0123';
process.env.APP_BASE_URL = 'https://coverraccoon.com';

const linking = await import('../src/linking.mjs');
const db = await import('../src/db.mjs');
const { telegramSiweMessage, telegramExpectation, verifyExpectedSiweSignature } = await import('../src/siwe-auth.mjs');
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** Wie check_agent_rate_limit: Zaehler je Schluessel, erlaubt solange <= max. */
function rateLimiter(log) {
	const counts = new Map();
	return async (key, max) => { log.push(`gate:${key.split(':')[0]}`); const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return n <= max; };
}
function harness() {
	const log = [];
	const created = [];
	const events = [];
	const deps = {
		gate: rateLimiter(log),
		create: async (row) => { log.push('create'); created.push(row); },
		record: async (type, meta) => { events.push({ type, ...meta }); }
	};
	return { log, created, events, link: (chatId) => linking.newLinkRequest(chatId, deps) };
}

/* ============================================================ D / E / F */

test('D: link codes are rate-limited per chat (10 / 10 min); other chats are unaffected', async () => {
	const h = harness();
	assert.deepEqual(linking.LINK_CODE_CHAT_LIMIT, { max: 10, windowSeconds: 600 });
	for (let i = 0; i < linking.LINK_CODE_CHAT_LIMIT.max; i++) assert.ok(await h.link(111), `Code ${i + 1}`);
	assert.equal(await h.link(111), null, 'elfter Code abgelehnt');
	assert.equal(await h.link(111), null);
	assert.ok(await h.link(222), 'anderer Chat');
	assert.equal(h.created.filter((r) => String(r.chatId) === '111').length, 10);
	assert.deepEqual(h.events.map((e) => e.scope), ['link-code-chat', 'link-code-chat']);
	assert.doesNotMatch(JSON.stringify(h.events), /111/, 'Chat-ID nur als Fingerprint');
});

test('E: link codes are rate-limited globally (300 / 10 min) across many chats', async () => {
	const h = harness();
	assert.deepEqual(linking.LINK_CODE_GLOBAL_LIMIT, { max: 300, windowSeconds: 600 });
	for (let i = 0; i < 300; i++) assert.ok(await h.link(1000 + i));
	assert.equal(await h.link(5000), null, 'globale Grenze');
	assert.equal(h.created.length, 300);
	assert.equal(h.events.at(-1).scope, 'link-code-global');
});

test('F: both limits are checked BEFORE any write; a rejected request writes nothing; no secret -> nothing at all', async () => {
	const h = harness();
	await h.link(333);
	assert.deepEqual(h.log, ['gate:link-code-chat', 'gate:link-code-global', 'create']);
	for (let i = 0; i < 10; i++) await h.link(333);
	const tail = h.log.slice(-1);
	assert.deepEqual(tail, ['gate:link-code-chat'], 'abgelehnt: kein create, auch kein globaler Zaehler');
	assert.equal(h.created.length, 10);

	const before = process.env.DASHBOARD_SESSION_SECRET;
	delete process.env.DASHBOARD_SESSION_SECRET;
	try {
		const n = harness();
		await assert.rejects(n.link(444), /Security configuration missing/);
		assert.deepEqual(n.log, [], 'ohne Secret weder Zaehler noch Schreiben');
	} finally { process.env.DASHBOARD_SESSION_SECRET = before; }
});

/* ======================================================== Bot-Anzeige */

const bot = read('src/bot.mjs');
const LINK_LIMIT_TEXT = new Function(`${bot.slice(bot.indexOf('const LINK_LIMIT_TEXT'), bot.indexOf('async function walletSettingsKeyboard('))}\nreturn LINK_LIMIT_TEXT;`)();

test('bot: a rate-limited /start connect shows a clear, non-sensitive message and no link', async () => {
	const sent = [];
	const source = bot.slice(bot.indexOf('async function handleMessage('), bot.indexOf('async function handleCallbackQuery('));
	const { authenticPrivateMessage } = await import('../src/telegram-audit.mjs');
	const deps = {
		authenticPrivateMessage, handleGroupMessage: async () => {}, commandOf: () => '/start', recordAgentEvent: async () => {}, telegramTimingMetadata: () => ({}),
		startCodeOf: () => null, getLanguage: async () => 'en', getWalletLink: async () => null, greeting: () => 'hello', navigationKeyboard: () => ({}),
		sendMessage: async (chatId, text, options) => { sent.push({ text, options }); }, ANMELDUNG_PAUSIERT: false, appBaseUrl: 'https://coverraccoon.com',
		newLinkRequest: async () => null, LINK_LIMIT_TEXT
	};
	const handle = new Function(...Object.keys(deps), `${source}\nreturn handleMessage;`)(...Object.values(deps));
	await handle({ chat: { id: 123, type: 'private' }, from: { id: 123 }, text: '/start connect' });
	assert.equal(sent.at(-1).text, LINK_LIMIT_TEXT.en);
	assert.doesNotMatch(JSON.stringify(sent), /\/link\?code=/);
	for (const text of Object.values(LINK_LIMIT_TEXT)) assert.doesNotMatch(text, /0x|chat|\d{3,}/i);
});

test('bot: wallet settings offer no new link code once the chat has MAX_WALLETS_PER_CHAT wallets', async () => {
	assert.equal(db.MAX_WALLETS_PER_CHAT, 10);
	const source = bot.slice(bot.indexOf('async function walletSettingsKeyboard('), bot.indexOf('\n}\n', bot.indexOf('async function walletSettingsKeyboard(')) + 3);
	let links = 0;
	const make = (count) => new Function('getMonitoredWallets', 'ANMELDUNG_PAUSIERT', 'MAX_WALLETS_PER_CHAT', 'newLinkRequest', 'appBaseUrl', `${source}\nreturn walletSettingsKeyboard;`)(
		async () => Array.from({ length: count }, (_, i) => ({ is_primary: i === 0, label: `W${i}`, wallet: `0x${String(i).padStart(40, '0')}` })), false, db.MAX_WALLETS_PER_CHAT,
		async () => { links++; return { code: 'c' }; }, 'https://coverraccoon.com');
	assert.equal((await make(9)('1', 'de')).inline_keyboard.length, 10, '9 Wallets + Hinzufuegen');
	assert.equal(links, 1);
	assert.equal((await make(10)('1', 'de')).inline_keyboard.length, 10, 'voll: kein Hinzufuegen');
	assert.equal(links, 1, 'kein Code fuer einen vollen Chat');
});

/* ================================================== Verify-Endpunkt */

function loadVerify(deps) {
	const body = read('api/link/verify.mjs').replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
	return new Function(...Object.keys(deps), `${body}\nreturn handler;`)(...Object.values(deps));
}
const response = () => ({ headers: {}, status(n) { this.code = n; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.body = b; return this; } });

for (const outcome of ['linked', 'wallet_limit', 'invalid']) {
	test(`verify endpoint maps the DB outcome "${outcome}" - limit: 409 WALLET_LIMIT + bot notice, no "linked" message`, async () => {
		const signer = privateKeyToAccount(`0x${'07'.repeat(32)}`);
		const expiresAt = Date.now() + 599_000;
		const nonce = 'ab'.repeat(16);
		const code = 'PendingLinkCode_0123456-';
		const signature = await signer.signMessage({ message: telegramSiweMessage({ wallet: signer.address, nonce, expiresAt, issuedAt: expiresAt - 600_000, code, target: '@raccoon_user' }) });
		const telegram = [];
		const events = [];
		const handler = loadVerify({
			ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}, requireSameOrigin: () => true, requireJson: () => true,
			enforceRateLimit: async () => true, enforceRateLimitFor: async () => true, isTelegramLinkCode: linking.isTelegramLinkCode, isTelegramLinkRow: linking.isTelegramLinkRow,
			getPendingLink: async () => ({ chat_id: '123', nonce, expires_at: expiresAt }), telegramTarget: async () => ({ target: '@raccoon_user' }), isAddress: () => true,
			linkSiweExpectation: (p) => telegramExpectation({ ...p, issuedAt: p.expiresAt - 600_000 }), signingMessage: (p) => telegramSiweMessage({ ...p, issuedAt: p.expiresAt - 600_000 }),
			verifyWalletSiweSignature: verifyExpectedSiweSignature,
			consumePendingLink: async () => (outcome === 'invalid' ? { status: 'invalid', chatId: null } : { status: outcome, chatId: '123' }),
			MAX_WALLETS_PER_CHAT: db.MAX_WALLETS_PER_CHAT, newDashboardAccess: async () => ({ code: 'a' }),
			recordSecurityEvent: async (type) => { events.push(type); }, SECURITY_EVENT: { SIWE_REPLAY_BLOCKED: 'replay' }, securityFingerprint: () => 'fp',
			getLanguage: async () => 'en', process: { env: { TELEGRAM_BOT_TOKEN: 'offline-placeholder', APP_BASE_URL: '' } },
			fetch: async (url, init) => { telegram.push(JSON.parse(init.body)); return { ok: true }; }
		});
		const res = response();
		await handler({ method: 'POST', body: { code, wallet: signer.address, signature }, headers: {} }, res);
		if (outcome === 'linked') {
			assert.equal(res.code, 200);
			assert.match(telegram[0].text, /Everything is set up/);
		} else if (outcome === 'wallet_limit') {
			assert.equal(res.code, 409);
			assert.equal(res.body.code, 'WALLET_LIMIT');
			assert.equal(telegram.length, 1);
			assert.equal(telegram[0].chat_id, '123');
			assert.match(telegram[0].text, /already monitors 10 wallets/);
			assert.doesNotMatch(telegram[0].text, /0x/, 'keine Wallet-Adresse');
			assert.deepEqual(events, [], 'Limit ist kein Replay');
		} else {
			assert.equal(res.code, 409);
			assert.equal(telegram.length, 0);
			assert.deepEqual(events, ['replay']);
		}
		assert.equal(res.headers['set-cookie'], undefined);
	});
}

/* ===================================================== consumePendingLink */

test('consumePendingLink calls the limited DB function and maps its result; only a real link touches anything else', async () => {
	for (const [rpcResult, expected, deletes] of [
		[{ status: 'linked', chat_id: '77' }, { status: 'linked', chatId: '77' }, 1],
		[{ status: 'wallet_limit', chat_id: '77' }, { status: 'wallet_limit', chatId: '77' }, 0],
		[{ status: 'invalid' }, { status: 'invalid', chatId: null }, 0],
		[null, { status: 'invalid', chatId: null }, 0]
	]) {
		const client = fakePostgrest({ pending_links: [{ code: 'x', chat_id: 'unlinked:77:0xabc' }] });
		const calls = [];
		client.rpc = async (name, args) => { calls.push([name, args]); return { data: rpcResult, error: null }; };
		assert.deepEqual(await db.consumePendingLink('code', '0xABC', { client }), expected);
		assert.deepEqual(calls, [['consume_wallet_link_v2', { link_code: 'code', linked_wallet: '0xabc' }]]);
		assert.equal(client.rows('pending_links').length, 1 - deletes);
	}
});

test('the DB limit and the JS constant are the same number (texts must not lie)', () => {
	const sql = read('supabase/migrations/20261015200000_m1_wallet_limit_alert_budget.sql');
	assert.equal(Number(/max_wallets constant integer := (\d+);/.exec(sql)[1]), db.MAX_WALLETS_PER_CHAT);
});

