/*
	Restaudit M1, 15.10.2026 - der taegliche Erinnerungslauf ist begrenzt und fair.

	Gegen den ECHTEN checkExpiryAlerts (Lebenszyklus, Ablaufwarnungen, Snoozes,
	Wochenuebersicht). Nur die Datenhaltung ist ersetzt: eine In-Memory-Welt mit
	derselben Keyset-Semantik wie public.alert_subscriptions_page (after exklusiv,
	through inklusiv, sortiert nach chat_id, wallet) und einer Kappung je Antwort
	wie PostgREST max_rows. Die SQL-Seite selbst prueft m1-wallet-limit-db.test.mjs
	gegen echten Postgres. Die Uhr ist steuerbar; jede Cover-Abfrage kostet Zeit.
*/
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'https://offline.invalid';
process.env.SUPABASE_SECRET_KEY ??= 'm1-alert-run-budget-test-not-a-key';

const { checkExpiryAlerts, ALERT_RUN_LIMITS, ALERT_RUN_BUDGET_EVENT } = await import('../src/alerts.mjs');

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-14T08:00:00Z'); // Mittwoch
const MONDAY = Date.parse('2026-10-12T08:00:00Z');
const wallet = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const chatOf = (n) => String(100000 + n);

/** Ein faelliges Cover (7-Tage-Schwelle) je Wallet. */
const dueCover = (n, now = NOW) => ({ coverId: 5000 + n, productId: 1, productName: 'Prod', status: 'active', endsAt: new Date(now + 5 * DAY).toISOString(), amount: '1', asset: { symbol: 'ETH' } });

function world({ subscriptions = [], snoozes = [], serverCap = Infinity, cursor = null, failWallets = [], lookupMs = 0, startAt = NOW } = {}) {
	const rows = subscriptions.map((s) => ({ alert_thresholds: [30, 14, 7, 3, 1, 0], weekly_summary: false, label: 'W', language: 'de', ...s }))
		.sort((a, b) => (a.chat_id === b.chat_id ? (a.wallet < b.wallet ? -1 : 1) : a.chat_id < b.chat_id ? -1 : 1));
	const cmp = (row, key) => (row.chat_id === key[0] ? (row.wallet === key[1] ? 0 : row.wallet < key[1] ? -1 : 1) : row.chat_id < key[0] ? -1 : 1);
	const state = { cursor, cursorWrites: [], pages: 0, snoozePages: 0, snoozes: snoozes.map((z) => ({ ...z })), sentAlerts: new Set(), snapshots: new Map(), summaries: new Set(), lookups: [], messages: [], events: [], clock: startAt };
	const store = {
		subscriptionsPage: async ({ after, through, limit }) => {
			state.pages++;
			return rows.filter((r) => (!after || cmp(r, after) > 0) && (!through || cmp(r, through) <= 0)).slice(0, Math.min(limit, 200, serverCap)).map((r) => ({ ...r }));
		},
		loadCursor: async () => state.cursor,
		saveCursor: async (c) => { state.cursor = c; state.cursorWrites.push(c); },
		dueSnoozesPage: async (now, limit) => {
			state.snoozePages++;
			return state.snoozes.filter((z) => Date.parse(z.remind_at) <= now)
				.sort((a, b) => a.remind_at.localeCompare(b.remind_at) || a.chat_id.localeCompare(b.chat_id) || a.wallet.localeCompare(b.wallet) || a.cover_id.localeCompare(b.cover_id))
				.slice(0, Math.min(limit, serverCap)).map((z) => ({ ...z }));
		},
		subscriptionFor: async (chatId, w) => { const r = rows.find((x) => x.chat_id === chatId && x.wallet === w); return r ? { ...r } : null; },
		clearSnooze: async (chatId, w, coverId) => { state.snoozes = state.snoozes.filter((z) => !(z.chat_id === chatId && z.wallet === w && z.cover_id === String(coverId))); },
		rescheduleSnooze: async (chatId, w, coverId, at) => { for (const z of state.snoozes) if (z.chat_id === chatId && z.wallet === w && z.cover_id === String(coverId)) z.remind_at = new Date(at).toISOString(); },
		getCoverSnapshots: async (chatId, w) => state.snapshots.get(`${chatId}:${w}`) ?? [],
		saveCoverSnapshot: async (chatId, w, cover) => { const list = state.snapshots.get(`${chatId}:${w}`) ?? []; state.snapshots.set(`${chatId}:${w}`, [...list.filter((s) => s.cover_id !== String(cover.coverId)), { cover_id: String(cover.coverId), product_id: String(cover.productId), status: cover.status, ends_at: cover.endsAt, amount: cover.amount }]); },
		recordRenewalEvent: async () => {},
		wasSent: async (chatId, coverId, endsAt, t) => state.sentAlerts.has(`${chatId}:${coverId}:${t}`),
		recordSent: async (chatId, coverId, endsAt, t) => { state.sentAlerts.add(`${chatId}:${coverId}:${t}`); },
		newAccess: async () => ({ code: 'access' }),
		wasWeeklySummarySent: async (chatId, week) => state.summaries.has(`${chatId}:${week}`),
		recordWeeklySummary: async (chatId, week) => { state.summaries.add(`${chatId}:${week}`); }
	};
	const run = (options = {}) => checkExpiryAlerts({
		sendMessage: async (chatId, text, opts) => { state.messages.push({ chatId: String(chatId), kind: opts?._messageKind, text }); },
		dashboardUrl: '',
		now: options.now ?? NOW,
		logger: { error() {}, warn() {} },
		loadAttributions: options.loadAttributions ?? (async () => []),
		loadPositions: options.loadPositions ?? (async () => null),
		lookupCovers: async (w) => {
			state.lookups.push(w);
			state.clock += lookupMs;
			if (failWallets.includes(w)) throw new Error('provider exploded: secret-internal-detail');
			const n = parseInt(w.slice(2), 16);
			return { covers: [dueCover(n, options.now ?? NOW)] };
		},
		store,
		limits: { ...ALERT_RUN_LIMITS, ...options.limits },
		clock: () => state.clock,
		recordEvent: async (event) => { state.events.push(event); }
	});
	return { state, run, rows, store };
}
const subs = (count, { perChat = 1, weekly = false } = {}) => Array.from({ length: count }, (_, i) => ({ chat_id: chatOf(Math.floor(i / perChat)), wallet: wallet(i + 1), weekly_summary: weekly }));
const alertedWallets = (state) => state.messages.filter((m) => m.kind === 'expiry_alert').map((m) => m.text.match(/Cover: #(\d+)/)[1]).map((id) => wallet(Number(id) - 5000));

/* ============================================================ G / H */

test('G: more than one page of subscriptions is processed completely, once each, in key order - even if the server caps every response below the page size', async () => {
	// 180 liegt unter dem Standardbudget (250 Abfragen - 50 Reserve = 200 Abos).
	const w = world({ subscriptions: subs(180), serverCap: 30 });
	const result = await w.run();
	assert.deepEqual(w.state.lookups, w.rows.map((r) => r.wallet), 'jede Zeile genau einmal, in Schluesselreihenfolge');
	assert.equal(result.subscriptions, 180);
	assert.equal(result.sent, 180);
	assert.ok(w.state.pages >= 7, `mehrere Seiten (${w.state.pages})`);
	assert.equal(result.budgetExhausted, null);
	assert.deepEqual(w.state.events, []);
});

test('H: more than one page of due snoozes is processed completely; not-yet-due snoozes stay', async () => {
	const subscriptions = subs(120);
	const snoozes = subscriptions.map((s, i) => ({ chat_id: s.chat_id, wallet: s.wallet, cover_id: String(5000 + i + 1), remind_at: new Date(NOW - (i + 1) * 60_000).toISOString() }));
	snoozes.push({ chat_id: chatOf(0), wallet: wallet(1), cover_id: '5001', remind_at: new Date(NOW + DAY).toISOString() });
	const w = world({ subscriptions, snoozes: snoozes.slice(0, 120).concat(snoozes.slice(120)).map((z, i) => (i === 120 ? { ...z, cover_id: '9999' } : z)) });
	const result = await w.run({ limits: { snoozePageSize: 50, maxSnoozes: 500 } });
	assert.equal(w.state.messages.filter((m) => m.kind === 'snoozed_alert').length, 120);
	assert.equal(w.state.snoozes.length, 1, 'nur der noch nicht faellige bleibt');
	assert.ok(w.state.snoozePages >= 3);
	assert.equal(result.snoozes, 120);
});

/* ===================================================== I / J / K / M */

test('I + M: the run stops at the subscription budget, saves the continuation point and records ONE bounded event', async () => {
	const w = world({ subscriptions: subs(60) });
	const result = await w.run({ limits: { maxSubscriptions: 25 } });
	assert.equal(w.state.lookups.length, 25);
	assert.equal(result.subscriptions, 25);
	assert.equal(result.budgetExhausted, 'subscriptions');
	assert.equal(result.continuation, true);
	assert.deepEqual(w.state.cursor, [w.rows[24].chat_id, w.rows[24].wallet]);
	assert.equal(w.state.events.length, 1, 'genau ein Ereignis');
	const [event] = w.state.events;
	assert.equal(event.eventType, ALERT_RUN_BUDGET_EVENT);
	assert.equal(event.eventType, 'alerts.run_budget_exhausted');
	assert.deepEqual(Object.keys(event.metadata).sort(), ['budget', 'budgets', 'continuation', 'lookups', 'snoozes', 'subscriptions']);
	assert.equal(event.metadata.budget, 'subscriptions');
	assert.equal(event.chatId ?? null, null);
	assert.equal(event.wallet ?? null, null);
	const serialized = JSON.stringify(event);
	assert.doesNotMatch(serialized, /0x[0-9a-f]{6}|100\d{3}|secret|provider/i, 'keine Wallet, keine Chat-ID, kein Fehlertext');
});

test('J: the run stops at the cover/RPC lookup budget and keeps the snooze reserve for due snoozes', async () => {
	const subscriptions = subs(80);
	const snoozes = [{ chat_id: chatOf(79), wallet: wallet(80), cover_id: '5080', remind_at: new Date(NOW - DAY).toISOString() }];
	const w = world({ subscriptions, snoozes });
	const result = await w.run({ limits: { maxCoverLookups: 30, snoozeLookupReserve: 5 } });
	assert.equal(result.subscriptions, 25, 'Abos: 30 - 5 Reserve');
	assert.equal(w.state.lookups.length, 26, '25 Abos + 1 Snooze aus der Reserve, nie mehr als das Budget');
	assert.ok(w.state.lookups.length <= 30);
	assert.equal(result.budgetExhausted, 'cover_lookups');
	assert.equal(w.state.messages.filter((m) => m.kind === 'snoozed_alert').length, 1, 'der Snooze kommt trotzdem dran');
	assert.equal(w.state.events.length, 1);
});

test('J2: optional position lookups count against the same budget; past it they are skipped and the alert still goes out', async () => {
	const w = world({ subscriptions: subs(3) });
	let positionCalls = 0;
	const result = await w.run({
		limits: { maxCoverLookups: 5, snoozeLookupReserve: 0 },
		loadAttributions: async (x) => [{ cover_id: 5000 + parseInt(x.slice(2), 16) }],
		loadPositions: async () => { positionCalls++; return null; }
	});
	// Abo 1: Cover + Position (2), Abo 2: Cover + Position (4), Abo 3: Cover (5), Position uebers Budget.
	assert.equal(positionCalls, 2);
	assert.equal(w.state.lookups.length, 3);
	assert.equal(result.lookups, 5, 'nie mehr als das Budget');
	assert.equal(alertedWallets(w.state).length, 3, 'alle drei Warnungen gehen raus');
	assert.equal(result.budgetExhausted, 'cover_lookups');
});

test('K: the run stops at the time budget (checked before every unit of work)', async () => {
	const w = world({ subscriptions: subs(100), lookupMs: 1000 });
	const result = await w.run({ limits: { maxRunMs: 45_000, snoozePhaseMs: 10_000, summaryPhaseMs: 5_000 } });
	assert.equal(result.subscriptions, 30, '30 s Abo-Phase bei 1 s je Abfrage');
	assert.equal(result.budgetExhausted, 'time');
	assert.equal(result.continuation, true);
	assert.equal(w.state.events.length, 1);
	assert.equal(w.state.events[0].metadata.budget, 'time');
});

/* ================================================================== L */

test('L: one failing wallet (and one failing snooze) does not abort the rest; nothing internal leaks to users', async () => {
	const subscriptions = subs(5);
	const snoozes = [
		{ chat_id: chatOf(1), wallet: wallet(2), cover_id: '5002', remind_at: new Date(NOW - 2 * DAY).toISOString() },
		{ chat_id: chatOf(3), wallet: wallet(4), cover_id: '5004', remind_at: new Date(NOW - DAY).toISOString() }
	];
	const w = world({ subscriptions, snoozes, failWallets: [wallet(2)] });
	const result = await w.run();
	assert.deepEqual(alertedWallets(w.state), [wallet(1), wallet(3), wallet(4), wallet(5)]);
	assert.equal(result.failed, 2, 'Abo + Snooze derselben kaputten Wallet');
	assert.equal(w.state.messages.filter((m) => m.kind === 'snoozed_alert').length, 1, 'der gesunde Snooze kommt');
	const failedSnooze = w.state.snoozes.find((z) => z.wallet === wallet(2));
	assert.ok(failedSnooze && Date.parse(failedSnooze.remind_at) > NOW, 'gescheiterter Snooze nach hinten, nicht geloescht');
	for (const m of w.state.messages) assert.doesNotMatch(m.text, /provider|secret-internal/);
});

test('L3: a weekly summary that cannot be delivered to one chat (bot blocked) does not abort the run or the other summaries', async () => {
	const w = world({ subscriptions: subs(3, { weekly: true }), startAt: MONDAY });
	const messages = [];
	const result = await checkExpiryAlerts({
		sendMessage: async (chatId, text, opts) => { if (opts?._messageKind === 'weekly_summary' && String(chatId) === chatOf(0)) throw new Error('Forbidden: bot was blocked by the user'); messages.push([String(chatId), opts?._messageKind]); },
		dashboardUrl: '', now: MONDAY, logger: { error() {}, warn() {} }, loadAttributions: async () => [], loadPositions: async () => null,
		lookupCovers: async (x) => ({ covers: [dueCover(parseInt(x.slice(2), 16), MONDAY)] }), store: w.store, clock: () => MONDAY, recordEvent: async () => {}
	});
	assert.deepEqual(messages.filter((m) => m[1] === 'weekly_summary').map((m) => m[0]), [chatOf(1), chatOf(2)]);
	assert.equal(result.summaries, 2);
	assert.equal(result.failed, 1);
});

test('L2: global failures still fail the run - a page read or the cursor read throwing rejects checkExpiryAlerts', async () => {
	const w = world({ subscriptions: subs(3) });
	await assert.rejects(checkExpiryAlerts({ sendMessage: async () => {}, dashboardUrl: '', now: NOW, logger: { error() {}, warn() {} }, lookupCovers: async () => ({ covers: [] }), recordEvent: async () => {},
		store: { ...w.store, subscriptionsPage: async () => { throw new Error('db down'); } } }), /db down/);
	await assert.rejects(checkExpiryAlerts({ sendMessage: async () => {}, dashboardUrl: '', now: NOW, logger: { error() {}, warn() {} }, lookupCovers: async () => ({ covers: [] }), recordEvent: async () => {},
		store: { ...w.store, loadCursor: async () => { throw new Error('db down'); } } }), /db down/);
	await assert.rejects(checkExpiryAlerts({ sendMessage: async () => {}, dashboardUrl: '', now: NOW, logger: { error() {}, warn() {} }, lookupCovers: async () => ({ covers: [] }), recordEvent: async () => {},
		store: { ...w.store, dueSnoozesPage: async () => { throw new Error('db down'); } } }), /db down/);
});

/* ================================================================== N */

test('N: consecutive budget-limited runs rotate through ALL rows - nothing is starved after the cutoff', async () => {
	const w = world({ subscriptions: subs(10) });
	const covered = new Set();
	const perRun = [];
	for (let i = 0; i < 3; i++) {
		w.state.lookups = [];
		w.state.sentAlerts.clear();
		await w.run({ limits: { maxSubscriptions: 4 } });
		perRun.push(w.state.lookups.map((x) => parseInt(x.slice(2), 16)));
		w.state.lookups.forEach((x) => covered.add(x));
	}
	assert.deepEqual(perRun, [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 1, 2]], 'fortsetzen, am Ende von vorn');
	assert.equal(covered.size, 10, 'jede Zeile kam dran');
});

test('N2: a complete run after a cut-off run resets the continuation point; failing snoozes move behind healthy ones', async () => {
	const w = world({ subscriptions: subs(6) });
	await w.run({ limits: { maxSubscriptions: 4 } });
	assert.deepEqual(w.state.cursor, [w.rows[3].chat_id, w.rows[3].wallet]);
	w.state.lookups = [];
	await w.run();
	assert.deepEqual(w.state.lookups.map((x) => parseInt(x.slice(2), 16)), [5, 6, 1, 2, 3, 4], 'voller Umlauf ab dem Cursor');
	assert.equal(w.state.cursor, null, 'durchgelaufen: wieder von vorn');

	const junk = Array.from({ length: 8 }, (_, i) => ({ chat_id: chatOf(0), wallet: wallet(1), cover_id: String(9000 + i), remind_at: new Date(NOW - 10 * DAY).toISOString() }));
	const good = { chat_id: chatOf(1), wallet: wallet(2), cover_id: '5002', remind_at: new Date(NOW - DAY).toISOString() };
	const s = world({ subscriptions: subs(2), snoozes: [...junk, good], failWallets: [wallet(1)] });
	await s.run({ limits: { maxSnoozes: 5 } });
	assert.equal(s.state.messages.filter((m) => m.kind === 'snoozed_alert').length, 0, 'Lauf 1: nur kaputte Snoozes');
	await s.run({ now: NOW + DAY, limits: { maxSnoozes: 5 } });
	assert.equal(s.state.messages.filter((m) => m.kind === 'snoozed_alert').length, 1, 'Lauf 2: der gesunde kommt vor den verschobenen kaputten');
});

/* ================================================================== O */

test('O: a normal small run behaves as before - same alerts, lifecycle, snooze, weekly summary; no cursor write, no event', async () => {
	const subscriptions = [
		{ chat_id: chatOf(1), wallet: wallet(1), weekly_summary: true, language: 'en' },
		{ chat_id: chatOf(1), wallet: wallet(2), weekly_summary: true, language: 'en' },
		{ chat_id: chatOf(2), wallet: wallet(3), weekly_summary: false, language: 'de' }
	];
	const snoozes = [{ chat_id: chatOf(2), wallet: wallet(3), cover_id: '5003', remind_at: new Date(MONDAY - 60_000).toISOString() }];
	const w = world({ subscriptions, snoozes, startAt: MONDAY });
	w.state.sentAlerts.add(`${chatOf(1)}:5002:7`); // schon gewarnt
	const result = await w.run({ now: MONDAY });
	assert.deepEqual(w.state.messages.map((m) => [m.chatId, m.kind]), [
		[chatOf(1), 'expiry_alert'],
		[chatOf(2), 'expiry_alert'],
		[chatOf(2), 'snoozed_alert'],
		[chatOf(1), 'weekly_summary']
	]);
	assert.match(w.state.messages[0].text, /Cover expiry reminder/);
	assert.match(w.state.messages[1].text, /Cover-Ablaufwarnung/);
	assert.match(w.state.messages[3].text, /2 wallet\(s\) monitored/);
	assert.deepEqual(result, { subscriptions: 3, sent: 3, summaries: 1, failed: 0, snoozes: 1, lookups: 3, budgetExhausted: null, continuation: false });
	assert.deepEqual(w.state.cursorWrites, [], 'kein Cursor-Schreiben im Normalfall');
	assert.deepEqual(w.state.events, []);
	assert.equal(w.state.lookups.length, 3, 'Snooze nutzt das Ergebnis der Abo-Abfrage');
});

test('weekly summary after a cut-off run: only chats completely processed in this run get one', async () => {
	const w = world({ subscriptions: subs(9, { perChat: 3, weekly: true }), startAt: MONDAY });
	await w.run({ now: MONDAY, limits: { maxSubscriptions: 5 } });
	assert.deepEqual(w.state.messages.filter((m) => m.kind === 'weekly_summary').map((m) => m.chatId), [chatOf(0)], 'Chat 1 ist angeschnitten');
});

/* ======================================================= Cron-Endpunkt */

import { readFileSync } from 'node:fs';
function loadCron(deps) {
	const body = readFileSync(new URL('../api/alerts.mjs', import.meta.url), 'utf8').replace(/^import [^;]*;\n/gm, '').replace('export default async function handler', 'async function handler');
	return new Function(...Object.keys(deps), `${body}\nreturn handler;`)(...Object.values(deps));
}
const cronResponse = () => ({ status(n) { this.code = n; return this; }, json(b) { this.body = b; return this; } });

for (const scenario of ['missing-telegram', 'budget', 'db-failure']) {
	test(`cron endpoint: ${scenario}`, async () => {
		const alerts = [];
		let runs = 0;
		const handler = loadCron({
			timingSafeEqual: (a, b) => a.equals(b), Buffer,
			checkExpiryAlerts: async () => { runs++; if (scenario === 'db-failure') throw new Error('db down'); return { subscriptions: 500, sent: 3, summaries: 0, failed: 0, snoozes: 0, lookups: 200, budgetExhausted: 'subscriptions', continuation: true }; },
			beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {}, purgeOldRecords: async () => ({ agent_events: 0 }),
			alertOperatorCronFailure: async (reason) => { alerts.push(reason); }, telegramText: (t) => t,
			process: { env: { CRON_SECRET: 'cron-secret-for-test', TELEGRAM_BOT_TOKEN: scenario === 'missing-telegram' ? '' : 'offline-placeholder', APP_BASE_URL: 'https://coverraccoon.com' } },
			console: { error() {}, warn() {}, log() {} }
		});
		const res = cronResponse();
		await handler({ method: 'GET', headers: { authorization: 'Bearer cron-secret-for-test' } }, res);
		if (scenario === 'missing-telegram') {
			assert.equal(res.code, 500);
			assert.equal(runs, 0, 'kein Lauf ohne Konfiguration');
			assert.deepEqual(alerts, ['expiry-alert-config']);
		} else if (scenario === 'db-failure') {
			assert.equal(res.code, 500);
			assert.deepEqual(alerts, ['expiry-alert-run']);
			assert.equal(JSON.stringify(res.body).includes('db down'), false);
		} else {
			assert.equal(res.code, 200);
			assert.equal(res.body.budgetExhausted, 'subscriptions', 'Budget-Ende steht im Ergebnis');
			assert.equal(res.body.continuation, true);
		}
	});
}
