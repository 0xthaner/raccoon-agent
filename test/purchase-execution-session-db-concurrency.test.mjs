/*
	Nexus P4I (20.10.2026): Einmal-Nutzung der Ausfuehrungs-Sitzungen unter ECHTER Gleichzeitigkeit.

	Jedes Szenario laeuft auf 40 EIGENEN Postgres-Verbindungen (40 verschiedene
	Backend-PIDs). Alle warten an einer Schranke (geteilte Advisory-Sperre), die
	erst freigegeben wird, wenn die Datenbank 40 gleichzeitig wartende
	Verbindungen dieser Datenbank meldet; danach ruft jede Verbindung die Funktion
	ohne offene Transaktion auf (eigene Transaktion je Aufruf, wie ueber
	PostgREST). Der Test prueft die Ueberlappung selbst (waiting === 40, 40 PIDs,
	mehrere gleichzeitig laufende Aufrufe); eine einzelne, seriell
	wiederverwendete Verbindung oder ein Lauf ohne Schranke besteht ihn nicht. Der
	Observer des CRSF-Runners zaehlt die Ueberlappung zusaetzlich unabhaengig.

	Gegen den echten Helfer (src/purchase-execution-session-db.mjs) und die echte
	Migration. Nur mit einem Wegwerf-Postgres, sonst sichtbar uebersprungen.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openPurchaseDb, rpcOn } from '../test-support/purchase-intent-pg.mjs';
import { builtIntent, sessionFor, raceAuto } from '../test-support/purchase-execution-session-pg.mjs';

const skip = !process.env.M1_DB_TEST_PG_URL || !process.env.M1_DB_TEST_PG_MODULE ? 'M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE nicht gesetzt (Wegwerf-Postgres noetig)' : false;
const X = await import('../src/purchase-execution-session-db.mjs');
const N = 40;
const TABLE = 'public.cover_purchase_execution_sessions';

const tally = (results) => results.reduce((m, r) => { const k = r.code && r.status !== 'ALREADY_CONSUMED' ? `${r.status}:${r.code}` : r.status; m[k] = (m[k] ?? 0) + 1; return m; }, {});

test('PURCHASE-SESSION-DB-CONC', { skip, timeout: 600_000 }, async (t) => {
	const db = await openPurchaseDb('p4i_conc');
	t.after(() => db.close());
	const { sql, connect } = db;
	const client = rpcOn(sql);
	let overlap = 0;
	const stats = [];

	/** Rennen mit Nachweis: 40 gleichzeitig wartende, verschiedene Verbindungen, ueberlappende Aufrufe. */
	async function contend(name, fn) {
		const { waiting, pids, maxInFlight, results } = await raceAuto(connect, N, fn);
		assert.equal(waiting, N, `the database reported ${waiting} simultaneously waiting connections, not ${N}`);
		assert.equal(new Set(pids).size, N, 'distinct backends');
		assert.ok(maxInFlight >= 2, `calls overlapped (max in flight ${maxInFlight})`);
		overlap += waiting - 1;
		stats.push({ name, waiting, pids: new Set(pids).size, maxInFlight });
		return results;
	}
	async function created(opts) {
		const built = await builtIntent(client);
		const session = sessionFor(built, opts);
		assert.equal((await X.persistExecutionSession(client, { session })).status, 'created');
		return { built, session };
	}
	const consumeWith = (c, s, consumerRequestId) => X.consumeExecutionSession(c, { sessionId: s.sessionId, sessionHash: s.executionSessionHash, intentId: s.intentId, consumerRequestId });
	const row = async (id) => (await sql.query(`select * from ${TABLE} where session_id = $1`, [id])).rows[0];

	await t.test('P4I-CONC-CONSUME 40 concurrent consumers with different request ids: exactly one CONSUMED, 39 ALREADY_CONSUMED', async () => {
		const { session } = await created();
		const keys = Array.from({ length: N }, () => randomUUID());
		const results = await contend('consume', (c, i) => consumeWith(c, session, keys[i]));
		assert.deepEqual(tally(results), { CONSUMED: 1, ALREADY_CONSUMED: N - 1 });
		const winner = results.findIndex((r) => r.status === 'CONSUMED');
		const r = await row(session.sessionId);
		assert.equal(r.consumer_request_id, keys[winner], 'the stored request id is the winner\'s');
		assert.ok(r.consumed_at < r.expires_at);
		assert.equal(results[winner].session.executionSessionHash, session.executionSessionHash);
	});

	await t.test('P4I-CONC-SAME-REQUEST 40 concurrent retries of one request: one consumption, every retry gets the same record back', async () => {
		const { session } = await created();
		const key = randomUUID();
		const results = await contend('same-request', (c) => consumeWith(c, session, key));
		assert.deepEqual(tally(results), { CONSUMED: 1, IDEMPOTENT_REPLAY: N - 1 });
		const first = results.find((r) => r.status === 'CONSUMED').session;
		for (const r of results) assert.deepEqual(r.session, first, 'identical consumed record');
		assert.equal((await row(session.sessionId)).consumer_request_id, key);
	});

	await t.test('P4I-CONC-MIXED-REQUESTS 20 retries of request A and 20 other requests: one winner; only the winner\'s own retries replay', async () => {
		const { session } = await created();
		const a = randomUUID();
		const keys = Array.from({ length: N }, (_, i) => (i % 2 ? randomUUID() : a));
		const results = await contend('mixed-requests', (c, i) => consumeWith(c, session, keys[i]));
		const t1 = tally(results);
		assert.equal(t1.CONSUMED, 1);
		const winner = results.findIndex((r) => r.status === 'CONSUMED');
		const winnerKey = keys[winner];
		results.forEach((r, i) => {
			if (i === winner) return;
			if (keys[i] === winnerKey) assert.equal(r.status, 'IDEMPOTENT_REPLAY', `retry ${i} of the winning request`);
			else assert.equal(r.status, 'ALREADY_CONSUMED', `request ${i} is another request`);
		});
		assert.equal((await row(session.sessionId)).consumer_request_id, winnerKey);
	});

	await t.test('P4I-CONC-CREATE 40 concurrent sessions for one intent: exactly one is stored', async () => {
		const built = await builtIntent(client);
		const sessions = Array.from({ length: N }, () => sessionFor(built));
		const results = await contend('create', (c, i) => X.persistExecutionSession(c, { session: sessions[i] }));
		assert.deepEqual(tally(results), { created: 1, 'conflict:OPEN_SESSION_EXISTS': N - 1 });
		assert.equal((await sql.query(`select count(*)::int as n from ${TABLE} where intent_id = $1`, [built.intent.id])).rows[0].n, 1);
	});

	await t.test('P4I-CONC-SUPERSEDE 40 concurrent replacements of an expired session: one new session, the old one superseded once, never usable', async () => {
		const { built, session } = await created({ ttl: 1 });
		while ((await sql.query('select now() >= to_timestamp($1) as x', [session.expiresAt])).rows[0].x === false) await new Promise((r) => setTimeout(r, 50));
		const sessions = Array.from({ length: N }, () => sessionFor(built));
		const results = await contend('supersede', (c, i) => X.persistExecutionSession(c, { session: sessions[i] }));
		assert.deepEqual(tally(results), { created: 1, 'conflict:OPEN_SESSION_EXISTS': N - 1 });
		const rows = (await sql.query(`select session_id, consumed_at, superseded_at from ${TABLE} where intent_id = $1`, [built.intent.id])).rows;
		assert.equal(rows.length, 2);
		assert.equal(rows.filter((r) => r.consumed_at === null && r.superseded_at === null).length, 1, 'one usable session');
		assert.notEqual(rows.find((r) => r.session_id === session.sessionId).superseded_at, null);
	});

	await t.test('P4I-CONC-CONSUME-KINDS consumption of competing sessions of one intent and kind: one consumed session per kind', async () => {
		// eine offene Sitzung je Intent; nach dem Verbrauch duerfen konkurrierende neue Sitzungen derselben Art nicht entstehen
		const { built, session } = await created();
		const results = await contend('consume-vs-create', (c, i) => (i % 2 ? consumeWith(c, session, randomUUID()) : X.persistExecutionSession(c, { session: sessionFor(built) })));
		const consumed = results.filter((r) => r.status === 'CONSUMED').length;
		assert.equal(consumed, 1);
		const stored = (await sql.query(`select count(*)::int as n from ${TABLE} where intent_id = $1 and transaction_kind = 'NEXUS_BUY_COVER' and consumed_at is not null`, [built.intent.id])).rows[0].n;
		assert.equal(stored, 1);
		assert.equal((await sql.query(`select count(*)::int as n from ${TABLE} where intent_id = $1 and consumed_at is null and superseded_at is null`, [built.intent.id])).rows[0].n, 0, 'no new open session of the consumed kind');
	});

	await t.test('P4I-CONC-EXPIRY consumers racing the expiry: never a consumption at or after expires_at, at most one winner', async () => {
		// a) eine Sitzung, 40 Verbraucher verteilt um den Ablaufzeitpunkt
		const one = await created({ ttl: 2 });
		const deadlineMs = one.session.expiresAt * 1000;
		const at = (i) => deadlineMs + (i - N / 2) * 5;
		const results = await contend('expiry-one', async (c, i) => { await new Promise((r) => setTimeout(r, Math.max(0, at(i) - Date.now()))); return consumeWith(c, one.session, randomUUID()); });
		const t1 = tally(results);
		assert.ok((t1.CONSUMED ?? 0) <= 1, JSON.stringify(t1));
		assert.deepEqual(Object.keys(t1).filter((k) => !['CONSUMED', 'ALREADY_CONSUMED', 'REJECTED:EXPIRED'].includes(k)), [], JSON.stringify(t1));
		const r1 = await row(one.session.sessionId);
		if (r1.consumed_at !== null) assert.ok(r1.consumed_at < r1.expires_at);
		// b) 40 Sitzungen mit demselben Ablauf, je ein Verbraucher kurz vor oder nach dem Ablauf
		const many = [];
		const target = Math.floor(Date.now() / 1000) + 3;
		for (let i = 0; i < N; i++) {
			const built = await builtIntent(client);
			const now = target - 2;
			const session = sessionFor(built, { now, ttl: 2 });
			assert.equal((await X.persistExecutionSession(client, { session })).status, 'created');
			many.push(session);
		}
		const spread = await contend('expiry-many', async (c, i) => { await new Promise((r) => setTimeout(r, Math.max(0, target * 1000 + (i - N / 2) * 10 - Date.now()))); return consumeWith(c, many[i], randomUUID()); });
		const t2 = tally(spread);
		assert.deepEqual(Object.keys(t2).filter((k) => !['CONSUMED', 'REJECTED:EXPIRED'].includes(k)), [], JSON.stringify(t2));
		for (const s of many) {
			const r = await row(s.sessionId);
			if (r.consumed_at !== null) assert.ok(r.consumed_at < r.expires_at, 'consumed strictly before expiry');
		}
		t.diagnostic(`expiry race: one session ${JSON.stringify(t1)}; forty sessions ${JSON.stringify(t2)}`);
	});

	await t.test('P4I-CONC overlap was observed in the database', () => {
		assert.equal(stats.length, 8);
		assert.ok(overlap >= stats.length * (N - 1), `overlap_events ${overlap}`);
		t.diagnostic(`CONCURRENCY_CONNECTIONS ${N} per race, OVERLAP_EVENTS ${overlap}, races ${JSON.stringify(stats)}`);
	});
});
