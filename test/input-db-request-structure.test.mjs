/**
 * CRSF Phase 2N, CR-INPUT-004 P1 ("runtime builds no SQL strings from input").
 *
 * Die Laufzeit spricht die Datenbank nur ueber src/db.mjs (supabase-js ->
 * PostgREST). Hier laeuft der ECHTE Modulcode mit dem ECHTEN supabase-js; nur
 * fetch zeichnet jede Anfrage auf. Fuer jeden exportierten Helfer mit Eingaben:
 *
 *   - derselbe Aufruf mit harmlosem und mit feindseligem Wert ergibt dieselbe
 *     Anfrage (Methode, Tabelle/Funktion, Parameter-Schluessel, Operatoren,
 *     select/order/limit/on_conflict, Body-Schluessel) - der Wert besetzt nur
 *     Wert-Stellen und aendert nie die Struktur;
 *   - jeder Filter ist `<spalte>=<op>.<wert>` mit einem Operator aus der festen
 *     Menge eq/gt/lt/lte/like/is, nie `or`/`and`/`not`/`in`, und der Wert nach
 *     dem Operator ist exakt die Eingabe (bzw. ihr fester Rahmen wie
 *     `unlinked:<chat>:%`);
 *   - RPC-Argumente gehen als benannte JSON-Werte im Body, nie in der URL.
 *
 * Die LIKE-Muster (`unlinked:<chat>:%`) bekommen nur Telegram-Chat-IDs: positive
 * ganze Zahlen aus einem gepruefen privaten Update oder eine per
 * isTelegramLinkRow gepruefte Link-Zeile. Beides ist hier mit Platzhalter-
 * Zeichen gegengeprueft.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ADVERSARIAL } from '../test-support/adversarial-values.mjs';

const HOST = 'input-db-structure.invalid';
Object.assign(process.env, { SUPABASE_URL: `https://${HOST}`, SUPABASE_SECRET_KEY: 'input-db-structure-not-a-key' });

let requests = [];
globalThis.fetch = async (input, init = {}) => {
	const url = new URL(typeof input === 'string' ? input : input.url);
	if (url.hostname !== HOST) throw new Error(`unexpected fetch ${url.hostname}`);
	const method = (init.method ?? 'GET').toUpperCase();
	const path = url.pathname.replace('/rest/v1/', '');
	const body = init.body ? JSON.parse(init.body) : null;
	requests.push({ method, path, params: [...url.searchParams], body, prefer: new Headers(init.headers).get('prefer') ?? '' });
	if (path === 'rpc/check_agent_rate_limit') return Response.json(true);
	if (path === 'rpc/revoke_dashboard_sessions_atomic') return Response.json(body.requested_cutoff);
	if (path === 'rpc/consume_wallet_link_v2') return Response.json({ status: 'invalid' });
	if (path === 'rpc/upsert_position_attribution_limited') return Response.json({ status: 'limit' });
	return Response.json([]);
};

const db = await import('../src/db.mjs');
const { isPrivateChatUpdate, authenticPrivateMessage } = await import('../src/telegram-audit.mjs');
const { isTelegramLinkRow } = await import('../src/linking.mjs');

const WALLET = '0x' + 'ab'.repeat(20);
const BENIGN = 'benign0value';

/** Jeder Helfer mit Eingabe `v` (alle Eingabe-Stellen gleichzeitig). */
const CALLS = {
	createPendingLink: (v) => db.createPendingLink({ code: v, chatId: v, nonce: v, expiresAt: 0 }),
	getPendingLink: (v) => db.getPendingLink(v),
	consumePendingLink: (v) => db.consumePendingLink(v, v),
	createDashboardAccess: (v) => db.createDashboardAccess({ code: v, wallet: v, expiresAt: 0 }),
	consumeDashboardAccess: (v) => db.consumeDashboardAccess(v),
	storeDashboardChallenge: (v) => db.storeDashboardChallenge({ nonce: v, wallet: v, expiresAt: 0 }),
	consumeDashboardChallenge: (v) => db.consumeDashboardChallenge(v, v),
	isDashboardChallengeOpen: (v) => db.isDashboardChallengeOpen(v, v),
	checkRateLimit: (v) => db.checkRateLimit(v, 5, 60),
	getWalletLink: (v) => db.getWalletLink(v),
	getWalletLinkByWallet: (v) => db.getWalletLinkByWallet(v),
	getWalletLinkStateByWallet: (v) => db.getWalletLinkStateByWallet(v),
	getMonitoredWallets: (v) => db.getMonitoredWallets(v),
	renameMonitoredWallet: (v) => db.renameMonitoredWallet(v, v, v),
	setPrimaryWallet: (v) => db.setPrimaryWallet(v, v),
	setWalletAlertSettings: (v) => db.setWalletAlertSettings(v, v, { thresholds: [1, 7], weeklySummary: true }),
	unlinkWallet: (v) => db.unlinkWallet(v),
	rememberUnlinkedWallet: (v) => db.rememberUnlinkedWallet(v, v),
	getRememberedWallet: (v) => db.getRememberedWallet(v),
	getRememberedWallets: (v) => db.getRememberedWallets(v),
	forgetRememberedWallet: (v) => db.forgetRememberedWallet(v),
	unlinkWalletByWallet: (v) => db.unlinkWalletByWallet(v),
	unlinkWalletFromAllChats: (v) => db.unlinkWalletFromAllChats(v),
	revokeDashboardSessions: (v) => db.revokeDashboardSessions(v, 1_700_000_000_000),
	isDashboardSessionRevoked: (v) => db.isDashboardSessionRevoked(v, 1),
	getLanguage: (v) => db.getLanguage(v),
	setLanguage: (v) => db.setLanguage(v, 'en'),
	listAlertSubscriptionsPage: (v) => db.listAlertSubscriptionsPage({ after: [v, v], through: [v, v], limit: 5 }),
	getAlertSubscription: (v) => db.getAlertSubscription(v, v),
	saveAlertRunCursor: (v) => db.saveAlertRunCursor([v, v]),
	snoozeLinkedCoverAlert: (v) => db.snoozeLinkedCoverAlert(v, v, v, 0),
	snoozeCoverAlert: (v) => db.snoozeCoverAlert(v, v, v, 0),
	rescheduleSnooze: (v) => db.rescheduleSnooze(v, v, v, 0),
	clearSnooze: (v) => db.clearSnooze(v, v, v),
	getCoverSnapshots: (v) => db.getCoverSnapshots(v, v),
	saveCoverSnapshot: (v) => db.saveCoverSnapshot(v, v, { coverId: v, productId: v, productName: v, status: v, amount: v, asset: { symbol: v, id: v }, originalCoverId: v, latestCoverId: v, purchaseTx: v, analysis: v }),
	recordAgentEvent: (v) => db.recordAgentEvent({ chatId: v, wallet: v, eventType: v, source: v, command: v, coverId: v, metadata: { note: v } }),
	beginTelegramDelivery: (v) => db.beginTelegramDelivery(v, v, { note: v }),
	finishTelegramDelivery: (v) => db.finishTelegramDelivery(v, { messageId: v, errorCode: v, errorMessage: v }),
	recordRenewalEvent: (v) => db.recordRenewalEvent({ wallet: WALLET, coverId: '7', status: 'quoted', amount: v, maxPremium: v, assetSymbol: v, errorCode: v, errorMessage: v, metadata: { note: v } }),
	wasWeeklySummarySent: (v) => db.wasWeeklySummarySent(v, v),
	recordWeeklySummary: (v) => db.recordWeeklySummary(v, v),
	wasAlertSent: (v) => db.wasAlertSent(v, v, 0, 1),
	recordAlertSent: (v) => db.recordAlertSent(v, v, 0, 1),
	getChatProductContext: (v) => db.getChatProductContext(v),
	saveChatProductContext: (v) => db.saveChatProductContext(v, [97]),
	listPositionAttributions: (v) => db.listPositionAttributions(v),
	upsertPositionAttribution: (v) => db.upsertPositionAttribution({ wallet: v, protocolKey: v, protocolVersion: v, deploymentKey: v, productId: v, coverId: v, now: 0 }),
	deletePositionAttribution: (v) => db.deletePositionAttribution(v, v, v),
	deleteStalePositionAttribution: (v) => db.deleteStalePositionAttribution(v, v, v, v)
};
/** Ohne Eingabe aus einer Anfrage: feste Abfragen (Zeit/Grenzen sind Zahlen aus dem Code). */
const NO_INPUT = ['claimTelegramUpdate', 'getAlertRunCursor', 'listDueSnoozesPage', 'purgeOldRecords'];
const FILTER_OPERATORS = new Set(['eq', 'gt', 'lt', 'lte', 'like', 'is']);
const STRUCTURAL = new Set(['select', 'order', 'limit', 'on_conflict', 'columns']);
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const RANDOM = /^(unlinked_[A-Za-z0-9_-]{24}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

async function record(name, v) {
	requests = [];
	await CALLS[name](v).catch(() => {});
	return requests;
}
/** Die festen Rahmen, in denen eine Eingabe als Wert vorkommt. */
const FRAMES = ['X', 'unlinked:X:%', 'unlinked:X:X', 'dashboard:X', 'revoked:X'];
/** Rahmen des harmlosen Werts (z. B. `unlinked:<V>:%`), Zeit/Zufall als Klasse, sonst null (Konstante). */
function template(value) {
	if (typeof value !== 'string') return null;
	if (TIME.test(value)) return { cls: TIME };
	if (RANDOM.test(value)) return { cls: RANDOM };
	const frame = FRAMES.find((f) => value === f.replaceAll('X', BENIGN));
	return frame ? { frame } : null;
}
/** Jede Rahmen-Stelle einzeln mit der Eingabe oder ihrer Kleinschreibung (Helfer normalisieren nur Wallets). */
const fill = (frame, v) => frame.split('X').reduce((acc, part, i) => i === 0 ? [part] : acc.flatMap((a) => [...new Set([v, v.toLowerCase()])].map((x) => a + x + part)), []);
/** Anfrage als vergleichbare Struktur: Filter in [spalte, operator, wert] zerlegt. */
const raw = (reqs) => reqs.map((r) => ({
	method: r.method, path: r.path, prefer: r.prefer,
	params: r.params.map(([k, value]) => STRUCTURAL.has(k) ? [k, value] : [k, value.slice(0, value.indexOf('.')), value.slice(value.indexOf('.') + 1)]),
	body: r.body
}));
/**
 * Gleiche Struktur wie die harmlose Anfrage. Wo dort der harmlose Wert stand (ganz
 * oder im festen Rahmen), muss jetzt GENAU die feindselige Eingabe stehen (bzw.
 * kleingeschrieben, wo der Helfer normalisiert); jede andere Stelle bleibt gleich.
 */
function sameStructure(benign, got, v, at = '$') {
	if (typeof benign === 'string') {
		const t = template(benign);
		if (t?.cls) return assert.match(String(got), t.cls, `${at}: value class`);
		if (t?.frame) return assert.ok(fill(t.frame, v).includes(got), `${at}: ${JSON.stringify(got)} is not the input in its fixed frame ${t.frame}`);
		return assert.equal(got, benign, `${at}: constant changed`);
	}
	if (Array.isArray(benign)) {
		assert.ok(Array.isArray(got) && got.length === benign.length, `${at}: length`);
		return benign.forEach((x, i) => sameStructure(x, got[i], v, `${at}[${i}]`));
	}
	if (benign && typeof benign === 'object') {
		assert.deepEqual(Object.keys(got ?? {}).sort(), Object.keys(benign).sort(), `${at}: keys`);
		for (const k of Object.keys(benign)) sameStructure(benign[k], got[k], v, `${at}.${k}`);
		return;
	}
	assert.deepEqual(got, benign, `${at}: scalar`);
}
const inputSlots = (value) => typeof value === 'string' ? (template(value)?.frame ? 1 : 0)
	: value && typeof value === 'object' ? Object.values(value).reduce((n, x) => n + inputSlots(x), 0) : 0;
/** Filter-Grammatik: nur feste Spalten-Schluessel und Operatoren aus der festen Menge. */
function grammar(reqs, label) {
	for (const r of reqs) {
		assert.match(r.path, /^(rpc\/)?[a-z_0-9]+$/, `${label}: table/function name`);
		for (const [k, raw] of r.params) {
			if (STRUCTURAL.has(k)) continue;
			assert.match(k, /^[a-z_]+$/, `${label}: value reached PostgREST expression syntax (filter key ${k})`);
			assert.ok(!['or', 'and', 'not'].includes(k), `${label}: value reached PostgREST expression syntax (logical filter ${k}=${raw})`);
			const op = raw.slice(0, raw.indexOf('.'));
			assert.ok(FILTER_OPERATORS.has(op), `${label}: value reached PostgREST expression syntax (operator ${op} in ${k}=${raw})`);
			if (op === 'is') assert.equal(raw, 'is.null', `${label}: is-filter carries a value`);
		}
		if (r.path.startsWith('rpc/')) assert.equal(r.params.length, 0, `${label}: RPC arguments in the URL`);
	}
}

test('INPUT-DB every exported src/db.mjs helper is covered (with input) or listed as input-free', () => {
	const exported = Object.entries(db).filter(([, f]) => typeof f === 'function').map(([n]) => n).sort();
	assert.deepEqual(exported, [...Object.keys(CALLS), ...NO_INPUT].sort());
});

for (const name of Object.keys(CALLS)) {
	test(`INPUT-DB ${name}: adversarial values occupy value slots only (structure, operators, values)`, async () => {
		const benign = await record(name, BENIGN);
		assert.ok(benign.length > 0, `${name}: no request recorded`);
		grammar(benign, name);
		const expected = raw(benign);
		assert.ok(inputSlots(expected) > 0, `${name}: input not found in any value slot`);
		for (const v of ADVERSARIAL) {
			const got = await record(name, v);
			grammar(got, `${name}(${JSON.stringify(v)})`);
			try { sameStructure(expected, raw(got), v); } catch (error) {
				assert.fail(`${name}(${JSON.stringify(v)}): value reached PostgREST expression syntax (request structure changed): ${error.message}`);
			}
		}
	});
}

test('INPUT-DB input-free helpers send fixed requests (no request-derived text)', async () => {
	for (const call of [() => db.getAlertRunCursor(), () => db.listDueSnoozesPage(0, 5), () => db.purgeOldRecords({ now: 0 }), () => db.claimTelegramUpdate(5)]) {
		requests = [];
		await call().catch(() => {});
		grammar(requests, 'input-free');
	}
	assert.equal(await db.claimTelegramUpdate('5; drop'), false, 'non-integer update id rejected before any request');
});

test('INPUT-DB long input (10 000 chars) stays one value', async () => {
	const long = "x'".repeat(5_000);
	const got = await record('getPendingLink', long);
	sameStructure(raw(await record('getPendingLink', BENIGN)), raw(got), long);
});

test('INPUT-DB LIKE patterns: only digit chat ids reach them (Telegram update and link-row checks)', () => {
	for (const id of ['1%', '1_', '*', '1\\', '%', '-1', '0', 1.5, -5, 0, '12']) {
		const update = { update_id: 1, message: { chat: { id, type: 'private' }, from: { id }, text: '/start' } };
		assert.equal(isPrivateChatUpdate(update), false, `chat id ${JSON.stringify(id)} accepted`);
		const callback = { update_id: 1, callback_query: { id: 'q', from: { id }, message: { chat: { id, type: 'private' } }, data: 'x' } };
		assert.equal(isPrivateChatUpdate(callback), false, `callback chat id ${JSON.stringify(id)} accepted`);
		// Zweite Pruefung im Nachrichtenpfad: nur ganze Zahlen (ohne Platzhalter-Zeichen).
		if (!Number.isSafeInteger(id)) assert.equal(authenticPrivateMessage({ chat: { id, type: 'private' }, from: { id } }), false, `message chat id ${JSON.stringify(id)} accepted`);
		if (typeof id === 'string' && id !== '12') assert.equal(isTelegramLinkRow({ chat_id: id }), false, `link row chat ${id} accepted`);
	}
	assert.equal(isPrivateChatUpdate({ update_id: 1, message: { chat: { id: 12, type: 'private' }, from: { id: 12 }, text: '/start' } }), true);
	assert.equal(isTelegramLinkRow({ chat_id: '12' }), true);
	assert.equal(isTelegramLinkRow({ chat_id: 'unlinked:1:%' }), false);
	assert.equal(isTelegramLinkRow({ chat_id: 'dashboard:x' }), false);
});

/* Statischer Zusatz (nicht der Beweis): nur src/db.mjs spricht die Datenbank. */
function sources(dir) {
	return readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? sources(p) : p.endsWith('.mjs') ? [p] : []; });
}
test('INPUT-DB static: only src/db.mjs creates a database client; no expression builders on input', () => {
	const root = new URL('..', import.meta.url).pathname;
	for (const file of [...sources(join(root, 'src')), ...sources(join(root, 'api'))]) {
		const text = readFileSync(file, 'utf8');
		const rel = file.slice(root.length);
		if (rel === 'src/db.mjs') continue;
		assert.doesNotMatch(text, /@supabase\/|\/rest\/v1|from 'pg'|postgres:\/\//, `${rel} talks to the database directly`);
	}
	const text = readFileSync(join(root, 'src/db.mjs'), 'utf8');
	assert.doesNotMatch(text, /\.(or|filter|not|in|textSearch|contains|containedBy|overlaps|ilike|likeAnyOf|likeAllOf|rangeGt|rangeLt)\(\s*['"`]/, 'expression builder in src/db.mjs');
	for (const [, method, arg] of text.matchAll(/\.(from|rpc|order|eq|lt|lte|gt|like|is)\(([^,)]*)/g)) {
		assert.ok(/^'[a-z_0-9]+'$/.test(arg.trim()) || (method === 'from' && arg === 'table') || (method === 'lt' && arg === 'column'), `.${method}(${arg}) is not a literal identifier`);
	}
});
