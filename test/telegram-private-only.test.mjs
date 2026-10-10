/**
 * Nur private Chats (10.10.2026).
 *
 * Laedt den echten Webhook (api/telegram.mjs) und den echten Bot (src/bot.mjs).
 * Jeder ausgehende Aufruf - Supabase, Telegram, OpenAI, Nexus - laeuft ueber ein
 * Attrappen-fetch, das nur mitschreibt. Echte Zugangsdaten aus .env werden vor
 * dem Import ueberschrieben; das Netz wird nie beruehrt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SECRET = 'webhook-secret-for-tests';
Object.assign(process.env, {
	TELEGRAM_BOT_TOKEN: 'test-token',
	TELEGRAM_BOT_USERNAME: 'RaccoonAgentBot',
	TELEGRAM_WEBHOOK_SECRET: SECRET,
	SUPABASE_URL: 'https://supabase.test.invalid',
	SUPABASE_SECRET_KEY: 'test-secret-key',
	OPENAI_API_KEY: 'test-key',
	VERCEL: '1' // verhindert das lokale Long Polling beim Import von bot.mjs
});

const calls = [];
globalThis.fetch = async (url, options = {}) => {
	const u = new URL(String(url));
	calls.push({ host: u.host, path: u.pathname, method: options.method ?? 'GET' });
	if (u.host === 'api.telegram.org') return Response.json({ ok: true, result: { message_id: 1 } });
	if (u.host === 'supabase.test.invalid') {
		// Leere Datenbank: Selects liefern nichts, Schreibzugriffe gelingen.
		if (u.pathname.includes('/rpc/')) return Response.json(true);
		return (options.method ?? 'GET') === 'GET' ? Response.json([]) : new Response(null, { status: 201 });
	}
	throw new Error(`unexpected outbound request to ${u.host}`);
};

const { default: webhook } = await import('../api/telegram.mjs');
const { handleUpdate } = await import('../src/bot.mjs');
const { isPrivateChatUpdate } = await import('../src/telegram-audit.mjs');

function response() {
	return {
		statusCode: null, body: null,
		status(code) { this.statusCode = code; return this; },
		json(body) { this.body = body; return this; }
	};
}
const post = async (body, secret = SECRET) => {
	const res = response();
	await webhook({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, body }, res);
	return res;
};
const hosts = () => [...new Set(calls.map((c) => c.host))].sort();

const PRIVATE_USER = 4242;
const privateMessage = (text, extra = {}) => ({ message_id: 1, date: 1_760_000_000, chat: { id: PRIVATE_USER, type: 'private' }, from: { id: PRIVATE_USER, is_bot: false, first_name: 'Test' }, text, ...extra });

// Alles, was nicht ein privater 1:1-Chat ist. Texte zielen bewusst auf teure Pfade:
// Befehle, Verbindungsanfragen, Produktfragen mit Erwaehnung des Bots.
const NON_PRIVATE = {
	'group message with mention': { message: { message_id: 1, chat: { id: -100, type: 'group' }, from: { id: 7 }, text: '@RaccoonAgentBot Was ist bei Aave v4 gedeckt?' } },
	'group /start connect': { message: { message_id: 1, chat: { id: -100, type: 'group' }, from: { id: 7 }, text: '/start@RaccoonAgentBot connect' } },
	'supergroup message': { message: { message_id: 1, chat: { id: -1001, type: 'supergroup' }, from: { id: 7 }, text: '@RaccoonAgentBot /dashboard' } },
	'supergroup reply to bot': { message: { message_id: 2, chat: { id: -1001, type: 'supergroup' }, from: { id: 7 }, text: 'und Aave v3?', reply_to_message: { from: { is_bot: true, username: 'RaccoonAgentBot' } } } },
	'anonymous admin (sender_chat)': { message: { message_id: 1, chat: { id: -1001, type: 'supergroup' }, sender_chat: { id: -1001, type: 'supergroup' }, from: { id: 1087968824, is_bot: true }, text: '@RaccoonAgentBot hi' } },
	'channel_post': { channel_post: { message_id: 1, chat: { id: -1002, type: 'channel' }, sender_chat: { id: -1002, type: 'channel' }, text: '/start connect' } },
	'edited_channel_post': { edited_channel_post: { message_id: 1, chat: { id: -1002, type: 'channel' }, text: 'x' } },
	'message from a channel chat': { message: { message_id: 1, chat: { id: -1002, type: 'channel' }, text: '/start' } },
	'unknown chat type': { message: { message_id: 1, chat: { id: 55, type: 'forum_topic' }, from: { id: 55 }, text: '/start' } },
	'missing chat type': { message: { message_id: 1, chat: { id: 55 }, from: { id: 55 }, text: '/start' } },
	'missing chat': { message: { message_id: 1, from: { id: 55 }, text: '/start' } },
	'private chat, foreign sender': { message: privateMessage('/start connect', { from: { id: 999 } }) },
	'private chat with sender_chat': { message: privateMessage('/start', { sender_chat: { id: -1002, type: 'channel' } }) },
	'private chat, negative id': { message: privateMessage('/start', { chat: { id: -5, type: 'private' }, from: { id: -5 } }) },
	'private chat from a bot': { message: privateMessage('/start', { from: { id: PRIVATE_USER, is_bot: true } }) },
	'edited_message (private)': { edited_message: privateMessage('/start') },
	'my_chat_member (bot added to group)': { my_chat_member: { chat: { id: -100, type: 'group' }, from: { id: 7 }, new_chat_member: { status: 'member' } } },
	'callback from group message': { callback_query: { id: 'q', from: { id: 7 }, data: 'show_covers', message: { message_id: 3, chat: { id: -100, type: 'group' } } } },
	'inline callback without message': { callback_query: { id: 'q', from: { id: PRIVATE_USER }, data: 'show_covers', inline_message_id: 'abc' } },
	'message plus callback in one update': { message: privateMessage('/start'), callback_query: { id: 'q', from: { id: PRIVATE_USER }, data: 'x', message: { chat: { id: PRIVATE_USER, type: 'private' } } } },
	'empty update': {}
};

test.beforeEach(() => { calls.length = 0; });

/* ------------------------------------------- B-E: verwerfen, still ---- */

for (const [name, update] of Object.entries(NON_PRIVATE)) {
	test(`webhook ignores ${name}: 200, no database, AI, Nexus or Telegram call`, async () => {
		const res = await post({ update_id: 10, ...update });
		assert.equal(res.statusCode, 200);
		assert.deepEqual(res.body, { ok: true });
		assert.deepEqual(calls, [], `no outbound request at all, got ${JSON.stringify(hosts())}`);
		assert.equal(isPrivateChatUpdate({ update_id: 10, ...update }), false);
	});

	test(`polling path (handleUpdate) ignores ${name}`, async () => {
		await handleUpdate({ update_id: 11, ...update });
		assert.deepEqual(calls, []);
	});
}

test('non-object bodies never reach the bot', async () => {
	for (const body of [{ update_id: 10, message: null }, { update_id: 10, message: 'text' }]) {
		const res = await post(body);
		assert.equal(res.statusCode, 200);
		assert.deepEqual(calls, []);
	}
	assert.equal(isPrivateChatUpdate([]), false);
	assert.equal(isPrivateChatUpdate(null), false);
	await handleUpdate(undefined);
	assert.deepEqual(calls, []);
});

/* ------------------------------------------- H: Webhook-Auth bleibt ---- */

test('H: authentication still comes first and still records the security event', async () => {
	const res = await post({ update_id: 12, ...NON_PRIVATE['group message with mention'] }, 'wrong-secret');
	assert.equal(res.statusCode, 401);
	assert.deepEqual(hosts(), ['supabase.test.invalid'], 'security event is still written for forged group updates');
	calls.length = 0;
	const missing = response();
	await webhook({ method: 'POST', headers: {}, body: { update_id: 12, message: privateMessage('/start') } }, missing);
	assert.equal(missing.statusCode, 401);
	const get = response();
	await webhook({ method: 'GET', headers: {}, body: {} }, get);
	assert.equal(get.statusCode, 405);
	const bad = await post({ update_id: -1, message: privateMessage('/start') });
	assert.equal(bad.statusCode, 400);
});

/* -------------------------------------- A/F: privat funktioniert weiter ---- */

test('A: a private update passes the guard into dedupe and the bot', async () => {
	assert.equal(isPrivateChatUpdate({ update_id: 1, message: privateMessage('/start') }), true);
	assert.equal(isPrivateChatUpdate({ update_id: 1, callback_query: { id: 'q', from: { id: PRIVATE_USER }, data: 'lang:de', message: { message_id: 3, chat: { id: PRIVATE_USER, type: 'private' }, from: { id: 1, is_bot: true } } } }), true);
	const res = await post({ update_id: 13, message: privateMessage('/start') });
	assert.equal(res.statusCode, 200);
	assert.ok(calls.some((c) => c.host === 'supabase.test.invalid'), 'update dedupe and bot state are reached');
	assert.ok(calls.some((c) => c.host === 'api.telegram.org' && c.path.endsWith('/sendMessage')), 'the private chat gets an answer');
});

test('F: private /start and /start connect still reach the reply and connect flow', async () => {
	await handleUpdate({ update_id: 14, message: privateMessage('/start') });
	assert.ok(calls.some((c) => c.host === 'api.telegram.org' && c.path.endsWith('/sendMessage')), '/start answers (language prompt for a new chat)');
	calls.length = 0;
	await handleUpdate({ update_id: 15, message: privateMessage('/start connect') });
	assert.ok(calls.some((c) => c.host === 'api.telegram.org' && c.path.endsWith('/sendMessage')), '/start connect answers');
	assert.ok(calls.every((c) => c.host === 'api.telegram.org' || c.host === 'supabase.test.invalid'), 'no AI or Nexus for commands');
});

/* -------------------------------- I und Reihenfolge: Quelltext-Grenzen ---- */

test('I: no group handler, group prompt or group module remains reachable', async () => {
	const bot = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
	const knowledge = await import('../src/agent-knowledge.mjs');
	assert.equal(knowledge.answerGroupQuestion, undefined);
	assert.equal(bot.includes('handleGroupMessage'), false);
	assert.equal(bot.includes('answerGroupQuestion'), false);
	assert.equal(bot.includes('group-chat.mjs'), false);
	await assert.rejects(import('../src/group-chat.mjs'));
	// Der einzige KI-Antwortpfad haengt hinter dem privaten Handler.
	assert.equal((bot.match(/answerProductQuestion\(/g) ?? []).length, 1);
	const handleMessage = bot.slice(bot.indexOf('async function handleMessage('), bot.indexOf('async function handleCallbackQuery('));
	assert.ok(handleMessage.indexOf("message.chat.type !== 'private') return;") < handleMessage.indexOf('handleNaturalLanguage('));
	const handleUpdateSource = bot.slice(bot.indexOf('export async function handleUpdate('));
	assert.ok(handleUpdateSource.indexOf('isPrivateChatUpdate(update)') < handleUpdateSource.indexOf('handleCallbackQuery('));
});

test('webhook order: auth, size, update id, private-only guard, then dedupe and bot', () => {
	const api = readFileSync(new URL('../api/telegram.mjs', import.meta.url), 'utf8');
	const at = (needle) => { const i = api.indexOf(needle); assert.ok(i >= 0, needle); return i; };
	assert.ok(at('validSecret(request.headers') < at('bodyTooLarge(request, 1_000_000)'));
	assert.ok(at('bodyTooLarge(request, 1_000_000)') < at('Number.isSafeInteger(request.body?.update_id)'));
	assert.ok(at('Number.isSafeInteger(request.body?.update_id)') < at('isPrivateChatUpdate(request.body)'));
	assert.ok(at('isPrivateChatUpdate(request.body)') < at('claimTelegramUpdate(request.body.update_id)'));
	assert.ok(at('claimTelegramUpdate(request.body.update_id)') < at('handleUpdate(request.body)'));
});

test('local polling still only asks Telegram for messages and button clicks', () => {
	const bot = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
	assert.match(bot, /allowed_updates: \['message', 'callback_query'\]/);
});

test('privacy page describes private-only operation and claims no group support', () => {
	const html = readFileSync(new URL('../web/datenschutz.html', import.meta.url), 'utf8');
	assert.match(html, /Der Bot arbeitet nur in privaten 1:1-Chats\./);
	assert.match(html, /Nachrichten aus Gruppen, Supergruppen und Kanälen verarbeitet er nicht/);
	assert.doesNotMatch(html, /@Erwähnung|In Gruppen reagiert|Gruppen-Antworten/);
});

test('bot pauses are off: sign-in and answers are live', async () => {
	const { ANMELDUNG_PAUSIERT, AGENT_ANTWORTEN_PAUSIERT } = await import('../src/pause.mjs');
	assert.equal(ANMELDUNG_PAUSIERT, false);
	assert.equal(AGENT_ANTWORTEN_PAUSIERT, false);
});
