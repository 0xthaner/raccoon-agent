/*
	Nexus P4J (20.10.2026): Ausfuehrungsversuche unter ECHTER Gleichzeitigkeit.

	Jedes Szenario laeuft auf 40 EIGENEN Postgres-Verbindungen (40 verschiedene
	Backend-PIDs) hinter der Schranke aus test-support/purchase-execution-session-pg.mjs:
	freigegeben erst, wenn die Datenbank 40 gleichzeitig wartende Verbindungen
	meldet; danach ruft jede Verbindung die Funktion ohne offene Transaktion auf.
	Der Test prueft die Ueberlappung selbst (waiting === 40, 40 PIDs, mehrere
	gleichzeitig laufende Aufrufe); der Observer des CRSF-Runners zaehlt sie
	zusaetzlich unabhaengig.

	Geprueft wird die Einmal-Eigenschaft des Protokolls: genau ein Gewinner des
	Write-ahead (nur er duerfte die Wallet rufen), genau ein Versuch je Sitzung,
	genau ein gebundener tx_hash je Versuch und je Hash, genau eine Einreichung,
	genau ein Wallet-Ergebnis.

	Gegen den echten Helfer (src/purchase-execution-attempt-db.mjs) und die echte
	Migration. Nur mit einem Wegwerf-Postgres, sonst sichtbar uebersprungen.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openPurchaseDb, rpcOn } from '../test-support/purchase-intent-pg.mjs';
import { raceAuto } from '../test-support/purchase-execution-session-pg.mjs';
import { authorized, consumedSession, txHashFor } from '../test-support/purchase-execution-attempt-pg.mjs';
import { builtIntent } from '../test-support/purchase-execution-session-pg.mjs';

const skip = !process.env.M1_DB_TEST_PG_URL || !process.env.M1_DB_TEST_PG_MODULE ? 'M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE nicht gesetzt (Wegwerf-Postgres noetig)' : false;
const A = await import('../src/purchase-execution-attempt-db.mjs');
const N = 40;
const TABLE = 'public.cover_purchase_execution_attempts';

const tally = (results) => results.reduce((m, r) => { const k = r.code ? `${r.status}:${r.code}` : r.status; m[k] = (m[k] ?? 0) + 1; return m; }, {});

test('PURCHASE-ATTEMPT-DB-CONC', { skip, timeout: 600_000 }, async (t) => {
	const db = await openPurchaseDb('p4j_conc');
	t.after(() => db.close());
	const { sql, connect } = db;
	const client = rpcOn(sql);
	let overlap = 0;
	const stats = [];
	const ids = (a) => ({ attemptId: a.attemptId, consumerRequestId: a.key });
	const row = async (id) => (await sql.query(`select * from ${TABLE} where attempt_id = $1`, [id])).rows[0];

	async function contend(name, fn) {
		const { waiting, pids, maxInFlight, results } = await raceAuto(connect, N, fn);
		assert.equal(waiting, N, `the database reported ${waiting} simultaneously waiting connections, not ${N}`);
		assert.equal(new Set(pids).size, N, 'distinct backends');
		assert.ok(maxInFlight >= 2, `calls overlapped (max in flight ${maxInFlight})`);
		overlap += waiting - 1;
		stats.push({ name, waiting, pids: new Set(pids).size, maxInFlight });
		return results;
	}

	await t.test('P4J-CONC-START 40 concurrent starts of one attempt (two tabs, retries): exactly one WALLET_REQUEST_PERMITTED', async () => {
		const a = await authorized(client);
		const results = await contend('start', (c) => A.startWalletRequest(c, ids(a)));
		assert.deepEqual(tally(results), { WALLET_REQUEST_PERMITTED: 1, 'ALREADY_STARTED:ALREADY_STARTED': N - 1 });
		const r = await row(a.attemptId);
		assert.equal(r.state, 'WALLET_REQUEST_STARTED');
		const winner = results.find((x) => x.status === 'WALLET_REQUEST_PERMITTED').attempt;
		const stored = (await sql.query(`select extract(epoch from wallet_request_started_at)::float8 as e from ${TABLE} where attempt_id = $1`, [a.attemptId])).rows[0].e;
		assert.equal(stored, winner.walletRequestStartedAt, 'the stored write-ahead is the winner\'s');
	});

	await t.test('P4J-CONC-OPEN 40 concurrent opens for one consumed session with fresh attempt ids: exactly one attempt', async () => {
		const { session, key } = await consumedSession(client, await builtIntent(client));
		const proposed = Array.from({ length: N }, () => randomUUID());
		const results = await contend('open', (c, i) => A.openExecutionAttempt(c, { attemptId: proposed[i], sessionId: session.sessionId, consumerRequestId: key }));
		assert.deepEqual(tally(results), { CREATED: 1, EXISTING: N - 1 });
		const ids_ = new Set(results.map((x) => x.attempt.attemptId));
		assert.equal(ids_.size, 1, 'every caller got the same attempt');
		assert.equal((await sql.query(`select count(*)::int as n from ${TABLE} where session_id = $1`, [session.sessionId])).rows[0].n, 1);
	});

	await t.test('P4J-CONC-BIND 40 concurrent different tx hashes for one attempt: exactly one is bound, the rest conflict', async () => {
		const a = await authorized(client);
		await A.startWalletRequest(client, ids(a));
		const hashes = Array.from({ length: N }, (_, i) => txHashFor(`race-${a.attemptId}-${i}`));
		const results = await contend('bind', (c, i) => A.bindTransactionHash(c, { ...ids(a), txHash: hashes[i], source: 'WALLET_RESPONSE' }));
		assert.deepEqual(tally(results), { BOUND: 1, 'CONFLICT:TX_HASH_CONFLICT': N - 1 });
		assert.equal((await row(a.attemptId)).tx_hash, hashes[results.findIndex((x) => x.status === 'BOUND')]);
	});

	await t.test('P4J-CONC-TXHASH-CROSS one tx hash raced onto 40 attempts of 40 intents: exactly one binds it', async () => {
		const attempts = [];
		for (let i = 0; i < N; i++) { const a = await authorized(client); await A.startWalletRequest(client, ids(a)); attempts.push(a); }
		const h = txHashFor(`cross-${attempts[0].attemptId}`);
		const results = await contend('txhash-cross', (c, i) => A.bindTransactionHash(c, { ...ids(attempts[i]), txHash: h, source: 'WALLET_RESPONSE' }));
		const t1 = tally(results);
		assert.equal(t1.BOUND, 1, JSON.stringify(t1));
		assert.equal(t1['CONFLICT:TX_HASH_TAKEN'], N - 1, JSON.stringify(t1));
		assert.equal((await sql.query(`select count(*)::int as n from ${TABLE} where tx_hash = $1`, [h])).rows[0].n, 1);
	});

	await t.test('P4J-CONC-OUTCOME 40 concurrent conflicting wallet outcomes (rejection, timeout, tx hash): exactly one is recorded', async () => {
		const a = await authorized(client);
		await A.startWalletRequest(client, ids(a));
		const h = txHashFor(`outcome-${a.attemptId}`);
		const results = await contend('outcome', (c, i) => (i % 3 === 0 ? A.recordWalletRejection(c, ids(a)) : i % 3 === 1 ? A.recordWalletUncertain(c, ids(a)) : A.bindTransactionHash(c, { ...ids(a), txHash: h, source: 'WALLET_RESPONSE' })));
		const r = await row(a.attemptId);
		const first = results.filter((x) => x.status === 'RECORDED' || x.status === 'BOUND');
		assert.equal(first.length, 1, `one transition out of WALLET_REQUEST_STARTED: ${JSON.stringify(tally(results))}`);
		assert.ok(['ABORTED_NO_TX', 'UNCERTAIN', 'TX_HASH_OBSERVED'].includes(r.state));
		if (r.state === 'ABORTED_NO_TX') assert.equal(r.tx_hash, null);
		t.diagnostic(`outcome race: ${JSON.stringify(tally(results))} -> ${r.state}`);
	});

	await t.test('P4J-CONC-SUBMIT 40 concurrent submissions of one bound buyCover attempt: the intent becomes SUBMITTED once, with the bound hash', async () => {
		const a = await authorized(client);
		await A.startWalletRequest(client, ids(a));
		const h = txHashFor(`submit-${a.attemptId}`);
		await A.bindTransactionHash(client, { ...ids(a), txHash: h, source: 'WALLET_RESPONSE' });
		const results = await contend('submit', (c) => A.submitPurchaseAttempt(c, { ...ids(a), intentId: a.built.intent.id, txNonce: 11 }));
		assert.deepEqual(tally(results), { SUBMITTED: 1, EXISTING: N - 1 });
		const i = (await sql.query('select status, tx_hash from public.cover_purchase_intents where id = $1', [a.built.intent.id])).rows[0];
		assert.deepEqual(i, { status: 'SUBMITTED', tx_hash: h });
	});

	await t.test('P4J-CONC overlap was observed in the database', () => {
		assert.equal(stats.length, 6);
		assert.ok(overlap >= stats.length * (N - 1), `overlap_events ${overlap}`);
		t.diagnostic(`CONCURRENCY_CONNECTIONS ${N} per race, OVERLAP_EVENTS ${overlap}, races ${JSON.stringify(stats)}`);
	});
});
