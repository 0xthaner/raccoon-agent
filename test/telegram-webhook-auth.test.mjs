/**
 * Telegram-Webhook: Echtheit und Wiederholungsschutz (CRSF Phase 2B,
 * CR-TELEGRAM-001 P1/P3, CR-API-002 P2/P3).
 *
 * Laedt den echten Webhook (api/telegram.mjs) und den echten Bot. Jeder
 * ausgehende Aufruf laeuft ueber ein mitschreibendes Attrappen-fetch. Die
 * Tabelle telegram_updates wird wie in Postgres nachgebildet: update_id ist
 * Primaerschluessel, ein zweites Insert derselben ID scheitert mit 23505 (so
 * wie die Migration 20260813200000 die Tabelle anlegt). Kein Netz, keine
 * echten Zugangsdaten.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const SECRET = 'webhook-secret-for-tests-0123456789';
Object.assign(process.env, {
	TELEGRAM_BOT_TOKEN: 'test-token',
	TELEGRAM_BOT_USERNAME: 'RaccoonAgentBot',
	TELEGRAM_WEBHOOK_SECRET: SECRET,
	SUPABASE_URL: 'https://supabase.test.invalid',
	SUPABASE_SECRET_KEY: 'test-secret-key',
	OPENAI_API_KEY: 'test-key',
	VERCEL: '1'
});

const calls = [];
const claimed = new Set();
globalThis.fetch = async (url, options = {}) => {
	const u = new URL(String(url));
	const method = (options.method ?? 'GET').toUpperCase();
	calls.push({ host: u.host, path: u.pathname, method });
	if (u.host === 'api.telegram.org') return Response.json({ ok: true, result: { message_id: 1 } });
	if (u.host === 'supabase.test.invalid') {
		if (u.pathname.endsWith('/telegram_updates') && method === 'POST') {
			const row = JSON.parse(options.body);
			if (claimed.has(String(row.update_id))) return Response.json({ code: '23505', message: 'duplicate key value violates unique constraint "telegram_updates_pkey"', details: null, hint: null }, { status: 409 });
			claimed.add(String(row.update_id));
			return new Response(null, { status: 201 });
		}
		if (u.pathname.includes('/rpc/')) return Response.json(true);
		return method === 'GET' ? Response.json([]) : new Response(null, { status: 201 });
	}
	throw new Error(`unexpected outbound request to ${u.host}`);
};

const { default: webhook } = await import('../api/telegram.mjs');

const USER = 4242;
const privateUpdate = (updateId, text = '/start') => ({ update_id: updateId, message: { message_id: 1, date: 1_760_000_000, chat: { id: USER, type: 'private' }, from: { id: USER, is_bot: false, first_name: 'Test' }, text } });
async function deliver(body, headers = { 'x-telegram-bot-api-secret-token': SECRET }) {
	const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
	await webhook({ method: 'POST', headers, body }, res);
	return res;
}
const botReplies = () => calls.filter((c) => c.host === 'api.telegram.org').length;
const claims = () => calls.filter((c) => c.path.endsWith('/telegram_updates') && c.method === 'POST').length;
const onlySecurityEvent = (label) => {
	assert.equal(botReplies(), 0, `${label}: no bot reply`);
	assert.equal(claims(), 0, `${label}: no replay claim`);
	assert.ok(calls.every((c) => c.host === 'supabase.test.invalid' && !c.path.includes('telegram_updates')), `${label}: only the security event may be written`);
};

test.beforeEach(() => { calls.length = 0; process.env.TELEGRAM_WEBHOOK_SECRET = SECRET; });

test('WEBHOOK-AUTH: the correct secret reaches dedupe and the bot', async () => {
	const res = await deliver(privateUpdate(500));
	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body, { ok: true });
	assert.equal(claims(), 1, 'update id claimed');
	assert.ok(botReplies() >= 1, 'the bot answered');
});

test('WEBHOOK-AUTH: missing, empty or wrong secrets are rejected before dedupe and the bot', async () => {
	const sameLength = `${SECRET.slice(0, -1)}X`;
	const cases = {
		'no header': {},
		'empty header': { 'x-telegram-bot-api-secret-token': '' },
		'wrong secret, same length': { 'x-telegram-bot-api-secret-token': sameLength },
		'wrong secret, other length': { 'x-telegram-bot-api-secret-token': 'nope' },
		'secret with trailing space': { 'x-telegram-bot-api-secret-token': `${SECRET} ` },
		'non-string header': { 'x-telegram-bot-api-secret-token': [SECRET] }
	};
	let id = 600;
	for (const [label, headers] of Object.entries(cases)) {
		calls.length = 0;
		const res = await deliver(privateUpdate(id++), headers);
		assert.equal(res.statusCode, 401, label);
		onlySecurityEvent(label);
	}
});

test('WEBHOOK-AUTH: an unconfigured webhook secret fails closed', async () => {
	let id = 700;
	for (const configured of [undefined, '', '   ']) {
		for (const header of [undefined, '', '   ', SECRET]) {
			calls.length = 0;
			if (configured === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET; else process.env.TELEGRAM_WEBHOOK_SECRET = configured;
			const res = await deliver(privateUpdate(id++), header === undefined ? {} : { 'x-telegram-bot-api-secret-token': header });
			const label = `secret=${JSON.stringify(configured)} header=${JSON.stringify(header)}`;
			assert.equal(res.statusCode, 401, label);
			onlySecurityEvent(label);
		}
	}
});

test('WEBHOOK-REPLAY: the same update_id is processed once; a redelivery reaches neither the bot nor any reply', async () => {
	const first = await deliver(privateUpdate(800));
	assert.equal(first.statusCode, 200);
	assert.deepEqual(first.body, { ok: true });
	const repliesAfterFirst = botReplies();
	assert.ok(repliesAfterFirst >= 1, 'first delivery answered');
	for (let i = 0; i < 3; i++) {
		const again = await deliver(privateUpdate(800));
		assert.equal(again.statusCode, 200, 'redelivery is acknowledged so Telegram stops retrying');
		assert.deepEqual(again.body, { ok: true, duplicate: true });
	}
	assert.equal(botReplies(), repliesAfterFirst, 'no second answer for a redelivered update');
	const next = await deliver(privateUpdate(801));
	assert.deepEqual(next.body, { ok: true }, 'a new update id is processed normally');
	assert.ok(botReplies() > repliesAfterFirst, 'the new update is answered');
});
