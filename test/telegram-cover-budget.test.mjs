/**
 * F-2I-1 (CRSF Phase 2J, CR-RESOURCE-007 P1): jede Cover-Abfrage aus Telegram -
 * Befehl /covers, Knopf "Meine Covers", KI-Absichten show_covers und
 * show_next_expiry - braucht VOR der ersten Provider-Abfrage je verbundener
 * Wallet einen Platz im Chat-Budget (telegram-cover-chat) und im globalen
 * Cover-Budget (dashboard-read-global). Alles oder nichts.
 *
 * Echt laufen: src/bot.mjs (handleUpdate, Befehle, Knoepfe, lokale
 * Absichtserkennung, KI-Budget), src/db.mjs (PostgREST, check_agent_rate_limit),
 * src/covers.mjs und src/cover-chain.mjs bis an den Draht. Jeder ausgehende
 * Aufruf laeuft ueber ein Attrappen-fetch: Supabase (verbundene Wallets, der
 * Rate-Limit-Zaehler mit gezielten Ablehnungen), Telegram, Alchemy-NFT-Index
 * (eine Abfrage = eine Cover-Abfrage), Nexus. Kein OpenAI-Schluessel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const SECRET = 'tg-cover-budget-secret-0123456789abcdef-01';
Object.assign(process.env, {
	TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_BOT_USERNAME: 'RaccoonAgentBot', TELEGRAM_WEBHOOK_SECRET: 'webhook-secret-for-tests',
	SUPABASE_URL: 'https://supabase.test.invalid', SUPABASE_SECRET_KEY: 'test-secret-key', DASHBOARD_SESSION_SECRET: SECRET,
	APP_BASE_URL: 'https://coverraccoon.com', ALCHEMY_API_KEY: 'test-alchemy-key', VERCEL: '1'
});
delete process.env.OPENAI_API_KEY;
delete process.env.DEMO_WALLET;

const CHAT = 4242;
const state = { wallets: [], trace: [], messages: [], limits: [], deny: null, allowance: {}, used: {} };
globalThis.fetch = async (url, options = {}) => {
	const u = new URL(String(url));
	if (u.host === 'supabase.test.invalid') {
		if (u.pathname === '/rest/v1/rpc/check_agent_rate_limit') {
			const body = JSON.parse(options.body);
			const scope = body.rate_key.split(':')[0];
			state.used[scope] = (state.used[scope] ?? 0) + 1;
			const admitted = scope !== state.deny && state.used[scope] <= (state.allowance[scope] ?? Infinity);
			state.limits.push({ scope, key: body.rate_key, max: body.max_requests, window: body.window_seconds, admitted });
			state.trace.push(`limit ${scope}`);
			return Response.json(admitted);
		}
		if (u.pathname.includes('/rpc/')) return Response.json(true);
		if ((options.method ?? 'GET') !== 'GET') return new Response(null, { status: 201 });
		if (u.pathname === '/rest/v1/monitored_wallets') return Response.json(state.wallets);
		if (u.pathname === '/rest/v1/user_preferences') return Response.json({ language: 'de' });
		return Response.json([]);
	}
	if (u.host === 'api.telegram.org') {
		if (u.pathname.endsWith('/sendMessage')) state.messages.push(JSON.parse(options.body).text);
		return Response.json({ ok: true, result: { message_id: 1 } });
	}
	if (u.host === 'eth-mainnet.g.alchemy.com' && u.pathname.includes('/nft/v3/')) { state.trace.push('PROVIDER cover lookup'); return Response.json({ ownedNfts: [], totalCount: 0 }); }
	if (u.host === 'api.nexusmutual.io') return Response.json([]);
	throw new Error(`unexpected outbound request to ${u.host}`);
};

const { handleUpdate } = await import('../src/bot.mjs');

let updateId = 1;
const from = { id: CHAT, is_bot: false, first_name: 'Test' };
const chat = { id: CHAT, type: 'private' };
const now = () => Math.floor(Date.now() / 1000);
const ENTRY = {
	command: () => ({ message: { message_id: 1, date: now(), chat, from, text: '/covers' } }),
	callback: () => ({ callback_query: { id: `q${updateId}`, from, data: 'show_covers', message: { message_id: 2, chat } } }),
	'ai-covers': () => ({ message: { message_id: 3, date: now(), chat, from, text: 'zeig meine covers' } }),
	'ai-expiry': () => ({ message: { message_id: 4, date: now(), chat, from, text: 'wann läuft mein nächstes cover ab?' } })
};
const AI_PREFIX = { command: [], callback: [], 'ai-covers': ['ai-privat', 'ai-gesamt'], 'ai-expiry': ['ai-privat', 'ai-gesamt'] };
const LIMIT_TEXT = /zu viele Cover-Abfragen/;
const wallet = (i) => ({ chat_id: String(CHAT), wallet: `0x${(i + 1).toString(16).padStart(40, '0')}`, label: `W${i + 1}`, is_primary: i === 0, linked_at: '2026-10-01T00:00:00Z' });

async function run(entry, n, { deny = null, allowance = {} } = {}) {
	Object.assign(state, { wallets: Array.from({ length: n }, (_, i) => wallet(i)), trace: [], messages: [], limits: [], deny, allowance, used: {} });
	await handleUpdate({ update_id: updateId++, ...ENTRY[entry]() });
	const lookups = state.trace.filter((t) => t === 'PROVIDER cover lookup').length;
	const first = state.trace.indexOf('PROVIDER cover lookup');
	const before = (first < 0 ? state.trace : state.trace.slice(0, first)).filter((t) => t.startsWith('limit ')).map((t) => t.slice(6));
	return { lookups, before, limits: state.limits, messages: state.messages };
}
const pairs = (n) => Array.from({ length: n }, () => ['telegram-cover-chat', 'dashboard-read-global']).flat();

for (const entry of Object.keys(ENTRY)) {
	for (const n of [1, 10]) {
		test(`TG-COVER-BUDGET ${entry} chat denied ${n}`, async () => {
			const r = await run(entry, n, { deny: 'telegram-cover-chat' });
			const label = `${entry} ${n}:`;
			assert.equal(r.lookups, 0, `${label} cover lookups ${r.lookups} with the chat budget denied`);
			assert.deepEqual(r.before, [...AI_PREFIX[entry], 'telegram-cover-chat'], `${label} limit order ${r.before}`);
			assert.ok(r.messages.some((m) => LIMIT_TEXT.test(m)), `${label} limit notice`);
		});

		test(`TG-COVER-BUDGET ${entry} global denied ${n}`, async () => {
			const r = await run(entry, n, { deny: 'dashboard-read-global' });
			const label = `${entry} ${n}:`;
			assert.equal(r.lookups, 0, `${label} cover lookups ${r.lookups} with the global budget denied`);
			assert.deepEqual(r.before, [...AI_PREFIX[entry], 'telegram-cover-chat', 'dashboard-read-global'], `${label} limit order ${r.before}`);
			assert.ok(r.messages.some((m) => LIMIT_TEXT.test(m)), `${label} limit notice`);
		});

		test(`TG-COVER-BUDGET ${entry} allowed ${n}`, async () => {
			const r = await run(entry, n);
			const label = `${entry} ${n}:`;
			assert.equal(r.lookups, n, `${label} cover lookups ${r.lookups}, expected one per linked wallet`);
			// Jede Wallet zieht genau einen Platz in beiden Budgets, alle VOR der ersten Abfrage.
			assert.deepEqual(r.before, [...AI_PREFIX[entry], ...pairs(n)], `${label} budget charged once per wallet before any lookup ${r.before}`);
			assert.ok(!r.messages.some((m) => LIMIT_TEXT.test(m)), `${label} no limit notice`);
			const cover = r.limits.filter((l) => !l.scope.startsWith('ai-'));
			assert.ok(cover.every((l) => l.scope === 'telegram-cover-chat' ? l.max === 30 && l.window === 600 : l.max === 300 && l.window === 600), `${label} budget sizes`);
		});
	}

	test(`TG-COVER-BUDGET ${entry} global exhausted mid-sequence`, async () => {
		const r = await run(entry, 10, { allowance: { 'dashboard-read-global': 3 } });
		const label = `${entry} 10:`;
		assert.equal(r.lookups, 0, `${label} cover lookups ${r.lookups} although the global budget ran out after 3 wallets`);
		assert.deepEqual(r.before, [...AI_PREFIX[entry], ...pairs(4)], `${label} stops at the first refusal ${r.before}`);
	});

	test(`TG-COVER-BUDGET ${entry} chat exhausted mid-sequence`, async () => {
		const r = await run(entry, 10, { allowance: { 'telegram-cover-chat': 5 } });
		const label = `${entry} 10:`;
		assert.equal(r.lookups, 0, `${label} cover lookups ${r.lookups} although the chat budget ran out after 5 wallets`);
		assert.deepEqual(r.before, [...AI_PREFIX[entry], ...pairs(5), 'telegram-cover-chat'], `${label} stops at the first refusal ${r.before}`);
	});
}

test('TG-COVER-BUDGET AI route still gated by the AI budget first', async () => {
	const r = await run('ai-covers', 10, { deny: 'ai-privat' });
	assert.equal(r.lookups, 0);
	assert.deepEqual(r.before, ['ai-privat']);
});

test('TG-COVER-BUDGET no linked wallet charges nothing', async () => {
	for (const entry of Object.keys(ENTRY)) {
		const r = await run(entry, 0);
		assert.equal(r.lookups, 0, entry);
		assert.deepEqual(r.before, AI_PREFIX[entry], entry);
	}
});

test('TG-COVER-BUDGET global key is the dashboard cover budget', async () => {
	const r = await run('command', 1);
	const global = r.limits.find((l) => l.scope === 'dashboard-read-global');
	// Derselbe Schluessel, den enforceRateLimitFor(response, 'dashboard-read-global', 'all', ...) im Dashboard zieht.
	assert.equal(global.key, `dashboard-read-global:${createHmac('sha256', SECRET).update('all').digest('hex')}`);
	const chatLimit = r.limits.find((l) => l.scope === 'telegram-cover-chat');
	assert.equal(chatLimit.key, `telegram-cover-chat:${createHmac('sha256', SECRET).update(String(CHAT)).digest('hex')}`);
	const dashboard = readFileSync(new URL('../api/dashboard.mjs', import.meta.url), 'utf8');
	assert.match(dashboard, /const DASHBOARD_READ_GLOBAL_LIMIT = Object\.freeze\(\{ max: 300, windowSeconds: 600 \}\);/);
	assert.match(dashboard, /const DASHBOARD_READ_WALLET_LIMIT = Object\.freeze\(\{ max: 30, windowSeconds: 600 \}\);/);
	assert.match(dashboard, /enforceRateLimitFor\(response, 'dashboard-read-global', 'all', DASHBOARD_READ_GLOBAL_LIMIT\.max, DASHBOARD_READ_GLOBAL_LIMIT\.windowSeconds\)/);
});

test('TG-COVER-BUDGET limiter failure fails closed', async () => {
	Object.assign(state, { wallets: [wallet(0)], trace: [], messages: [], limits: [], deny: null, allowance: {}, used: {} });
	const original = globalThis.fetch;
	globalThis.fetch = async (url, options) => (String(url).includes('/rpc/check_agent_rate_limit') ? new Response('boom', { status: 500 }) : original(url, options));
	try { await handleUpdate({ update_id: updateId++, ...ENTRY.command() }); } finally { globalThis.fetch = original; }
	assert.equal(state.trace.filter((t) => t === 'PROVIDER cover lookup').length, 0);
	assert.ok(state.messages.some((m) => LIMIT_TEXT.test(m)));
});
