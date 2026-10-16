/*
	Restaudit L3, 16.10.2026 - "Morgen erinnern" (callback `renew_later`) schreibt
	nur fuer Wallets, die JETZT mit genau diesem Chat verknuepft sind, und nur
	fuer Cover, die fuer diesen Chat und diese Wallet schon gesehen wurden.

	callback_data stellt der Telegram-Client zusammen; ein veraenderter Client kann
	beliebige Daten senden. Authentifiziert ist nur das Update selbst (Webhook-
	Secret) und damit Chat und Absender. Bisher landete die Wallet aus dem Knopf
	ungeprueft in alert_snoozes.

	Laeuft gegen den ECHTEN Bot (src/bot.mjs, handleUpdate) und den echten
	Supabase-Client: jeder Datenbankaufruf geht per fetch an eine In-Memory-
	PostgREST-Attrappe, jeder Telegram-Aufruf wird nur mitgeschrieben.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakePostgrest } from '../test-support/fake-postgrest.mjs';

Object.assign(process.env, {
	TELEGRAM_BOT_TOKEN: 'test-token',
	TELEGRAM_BOT_USERNAME: 'RaccoonAgentBot',
	SUPABASE_URL: 'https://supabase.test.invalid',
	SUPABASE_SECRET_KEY: 'test-secret-key',
	OPENAI_API_KEY: 'test-key',
	VERCEL: '1' // kein lokales Long Polling beim Import von bot.mjs
});

const CHAT_A = '1001';
const CHAT_B = '2002';
const W_A = '0x' + 'a1'.repeat(20); // nur Chat A
const W_B = '0x' + 'b2'.repeat(20); // nur Chat B
const W_SHARED = '0x' + 'c3'.repeat(20); // beiden Chats verknuepft (erlaubt)
const W_FREE = '0x' + 'd4'.repeat(20); // niemandem verknuepft

function world() {
	return fakePostgrest({
		monitored_wallets: [
			{ chat_id: CHAT_A, wallet: W_A, is_primary: true, alerts_enabled: true, linked_at: '2026-10-01T00:00:00Z' },
			{ chat_id: CHAT_A, wallet: W_SHARED, is_primary: false, alerts_enabled: true, linked_at: '2026-10-02T00:00:00Z' },
			{ chat_id: CHAT_B, wallet: W_B, is_primary: true, alerts_enabled: true, linked_at: '2026-10-01T00:00:00Z' },
			{ chat_id: CHAT_B, wallet: W_SHARED, is_primary: false, alerts_enabled: true, linked_at: '2026-10-02T00:00:00Z' }
		],
		cover_snapshots: [
			{ chat_id: CHAT_A, wallet: W_A, cover_id: '501', status: 'active' },
			{ chat_id: CHAT_B, wallet: W_B, cover_id: '601', status: 'active' },
			{ chat_id: CHAT_A, wallet: W_SHARED, cover_id: '701', status: 'active' },
			{ chat_id: CHAT_B, wallet: W_SHARED, cover_id: '702', status: 'active' },
			// Gleiche Wallet und Cover-ID wie in Chat A, aber nie in Chat B gesehen: zaehlt fuer B nicht.
			{ chat_id: CHAT_B, wallet: W_A, cover_id: '501', status: 'active' }
		],
		alert_snoozes: [],
		user_preferences: [{ chat_id: CHAT_A, language: 'en' }, { chat_id: CHAT_B, language: 'en' }]
	});
}

/* ------------------------------------------- PostgREST ueber fetch, im Speicher -- */

let pg = world();
const writes = [];
const answers = [];
globalThis.fetch = async (url, options = {}) => {
	const u = new URL(String(url));
	const method = (options.method ?? 'GET').toUpperCase();
	if (u.host === 'api.telegram.org') {
		const body = options.body ? JSON.parse(options.body) : null;
		if (u.pathname.endsWith('/answerCallbackQuery')) answers.push(body);
		return Response.json({ ok: true, result: { message_id: 1 } });
	}
	if (u.host !== 'supabase.test.invalid') throw new Error(`unexpected outbound request to ${u.host}`);
	if (u.pathname.startsWith('/rest/v1/rpc/')) return Response.json(null);
	const name = u.pathname.replace('/rest/v1/', '');
	const headers = new Headers(options.headers);
	const prefer = headers.get('prefer') ?? '';
	const body = options.body ? JSON.parse(options.body) : null;
	let q = pg.from(name);
	if (method === 'GET') q = q.select(u.searchParams.get('select') ?? '*');
	else if (method === 'DELETE') q = q.delete();
	else if (method === 'PATCH') q = q.update(body);
	else if (method === 'POST') q = prefer.includes('resolution=merge-duplicates') ? q.upsert(body) : q.insert(body);
	else throw new Error(`unsupported method ${method}`);
	if (method !== 'GET') writes.push({ method, table: name, body });
	if (method !== 'GET' && prefer.includes('return=representation')) q = q.select(u.searchParams.get('select') ?? '*');
	for (const [key, raw] of u.searchParams) {
		if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(key)) continue;
		const [operator, ...rest] = raw.split('.');
		const val = rest.join('.');
		if (operator === 'eq') q = q.eq(key, val);
		else if (operator === 'is') q = q.is(key, val === 'null' ? null : val);
		else if (operator === 'in') q = q.in(key, val.replace(/^\(|\)$/g, '').split(','));
		else if (operator === 'like') q = q.like(key, val.replace(/\*/g, '%'));
		else if (operator === 'lt') q = q.lt(key, val);
		else throw new Error(`unsupported filter ${key}=${raw}`);
	}
	if (u.searchParams.has('limit')) q = q.limit(Number(u.searchParams.get('limit')));
	const { data, error } = await q;
	if (error) return Response.json({ message: error.message }, { status: 400 });
	if (method === 'GET') return Response.json(data);
	return data ? Response.json(data, { status: 201 }) : new Response(null, { status: 201 });
};

const { handleUpdate } = await import('../src/bot.mjs');
const db = await import('../src/db.mjs');

let updateId = 1;
async function click(chatId, data, { from = chatId } = {}) {
	await handleUpdate({ update_id: updateId++, callback_query: { id: `q${updateId}`, from: { id: Number(from), is_bot: false, first_name: 'T' }, data, message: { message_id: 7, chat: { id: Number(chatId), type: 'private' } } } });
}
const snoozes = () => pg.rows('alert_snoozes').map(({ chat_id, wallet, cover_id }) => `${chat_id}|${wallet}|${cover_id}`).sort();
const snoozeWrites = () => writes.filter((w) => w.table === 'alert_snoozes');
const lastAnswer = () => answers.at(-1)?.text;
const OK = 'Okay, I will remind you tomorrow.';
const DENIED = 'This reminder no longer applies to this chat.';

test.beforeEach(() => { pg = world(); writes.length = 0; answers.length = 0; });

/* ----------------------------------------------------- erlaubte Faelle -- */

test('L3: a linked chat snoozes its own cover; the reminder is due at the next daily run', async () => {
	await click(CHAT_A, `renew_later:501:${W_A}`);
	assert.deepEqual(snoozes(), [`${CHAT_A}|${W_A}|501`]);
	assert.equal(lastAnswer(), OK);
	const remindAt = Date.parse(pg.rows('alert_snoozes')[0].remind_at);
	const next = new Date(); next.setUTCDate(next.getUTCDate() + 1); next.setUTCHours(7, 55, 0, 0);
	assert.equal(remindAt, next.getTime());
});

test('L3: the legacy button without wallet uses the chat\'s current primary wallet', async () => {
	await click(CHAT_A, 'renew_later:501');
	assert.deepEqual(snoozes(), [`${CHAT_A}|${W_A}|501`]);
	assert.equal(lastAnswer(), OK);
});

test('L3: a mixed-case wallet in the button is normalised, not duplicated', async () => {
	await click(CHAT_A, `renew_later:501:${W_A.toUpperCase().replace('0X', '0x')}`);
	await click(CHAT_A, `renew_later:501:${W_A}`);
	assert.deepEqual(snoozes(), [`${CHAT_A}|${W_A}|501`]);
});

test('L3-E: a wallet linked to two chats - each chat snoozes only for itself and only its own covers', async () => {
	await click(CHAT_A, `renew_later:701:${W_SHARED}`);
	await click(CHAT_B, `renew_later:702:${W_SHARED}`);
	assert.deepEqual(snoozes(), [`${CHAT_A}|${W_SHARED}|701`, `${CHAT_B}|${W_SHARED}|702`]);
	writes.length = 0;
	await click(CHAT_A, `renew_later:702:${W_SHARED}`); // Cover nur in Chat B gesehen
	assert.deepEqual(snoozeWrites(), []);
	assert.equal(lastAnswer(), DENIED);
});

/* ---------------------------------------------------- abgelehnte Faelle -- */

test('L3-A/B/C/D: foreign, unlinked, unknown or swapped wallet/cover combinations write nothing', async () => {
	const cases = {
		'A: wallet linked only to chat B': `renew_later:601:${W_B}`,
		'B: wallet linked to nobody': `renew_later:501:${W_FREE}`,
		'C: own wallet, nonexistent cover': `renew_later:999999:${W_A}`,
		'D: own wallet, cover of another wallet': `renew_later:601:${W_A}`,
		'D: own wallet, cover of a shared wallet': `renew_later:701:${W_A}`
	};
	for (const [label, data] of Object.entries(cases)) {
		await click(CHAT_A, data);
		assert.equal(lastAnswer(), DENIED, label);
	}
	await click(CHAT_B, `renew_later:501:${W_A}`); // Snapshot in B vorhanden, Wallet aber nicht mit B verknuepft
	assert.equal(lastAnswer(), DENIED, 'B: snapshot alone is no authority');
	assert.deepEqual(snoozeWrites(), [], 'kein Schreibzugriff auf alert_snoozes');
	assert.deepEqual(snoozes(), []);
	assert.deepEqual(writes.filter((w) => w.table !== 'agent_events'), [], 'abgelehnt: ueberhaupt kein Schreiben ausser dem Ereignisprotokoll');
});

test('L3-F: a wallet unlinked after the button was sent cannot be snoozed', async () => {
	await db.unlinkWallet(CHAT_A, { client: pg });
	writes.length = 0;
	await click(CHAT_A, `renew_later:501:${W_A}`);
	await click(CHAT_A, 'renew_later:501');
	assert.deepEqual(snoozeWrites(), []);
	assert.deepEqual(snoozes(), []);
	assert.equal(lastAnswer(), DENIED);
});

test('L3-G: replaying an old button after unlink writes nothing - not even an update of the old snooze', async () => {
	await click(CHAT_A, `renew_later:501:${W_A}`);
	assert.equal(snoozeWrites().length, 1);
	await db.unlinkWallet(CHAT_A, { client: pg });
	writes.length = 0;
	for (let i = 0; i < 3; i++) await click(CHAT_A, `renew_later:501:${W_A}`);
	assert.deepEqual(snoozeWrites(), []);
	assert.equal(lastAnswer(), DENIED);
});

test('L3: malformed or tampered callback data is rejected without any write', async () => {
	for (const data of [
		`renew_later:0501:${W_A}`, `renew_later:501:${W_A}:extra`, `renew_later:501:${W_A.slice(0, -1)}`,
		'renew_later:-1', 'renew_later:', `renew_later::${W_A}`, `renew_later:501:${W_A} `, ` renew_later:501:${W_A}`,
		`renew_later:${'9'.repeat(21)}:${W_A}`, `RENEW_LATER:501:${W_A}`, `renew_later:501;${W_A}`, `renew_later:1e3:${W_A}`,
		`renew_later:501:${W_A}\n`, 'renew_later:501:0x', `renew_later:５０１:${W_A}`
	]) {
		await click(CHAT_A, data);
	}
	assert.deepEqual(snoozeWrites(), []);
	assert.deepEqual(answers, [], 'kein Knopf-Treffer, keine Bestaetigung');
});

test('L3: a callback from a foreign sender in the chat writes nothing', async () => {
	await click(CHAT_A, `renew_later:501:${W_A}`, { from: CHAT_B });
	assert.deepEqual(writes, []);
	assert.deepEqual(answers, []);
});

/* --------------------------------------------- Datenbank-Helfer direkt -- */

test('L3: snoozeLinkedCoverAlert checks link and cover before it writes, and returns the reason', async () => {
	const at = Date.parse('2026-10-17T07:55:00Z');
	assert.equal(await db.snoozeLinkedCoverAlert(CHAT_A, W_B, '601', at, { client: pg }), 'not_linked');
	assert.equal(await db.snoozeLinkedCoverAlert(CHAT_A, W_FREE, '501', at, { client: pg }), 'not_linked');
	assert.equal(await db.snoozeLinkedCoverAlert(CHAT_A, W_A, '502', at, { client: pg }), 'unknown_cover');
	assert.equal(pg.rows('alert_snoozes').length, 0);
	assert.equal(await db.snoozeLinkedCoverAlert(Number(CHAT_A), W_A.toUpperCase().replace('0X', '0x'), 501, at, { client: pg }), 'snoozed');
	assert.deepEqual(pg.rows('alert_snoozes').map(({ chat_id, wallet, cover_id, remind_at }) => [chat_id, wallet, cover_id, remind_at]), [[CHAT_A, W_A, '501', '2026-10-17T07:55:00.000Z']]);
});
