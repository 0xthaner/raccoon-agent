/*
	Nexus P4D (19.10.2026): Einmal-Nutzung der Kauf-Intents unter ECHTER Gleichzeitigkeit.

	Jedes Szenario laeuft auf 40 EIGENEN Postgres-Verbindungen. Jede steht in einer
	offenen Transaktion an einer Schranke (geteilte Advisory-Sperre); freigegeben
	wird erst, wenn die Datenbank 40 gleichzeitig wartende Verbindungen meldet.
	Der Test prueft das selbst (waiting === 40, 40 verschiedene Backend-PIDs) -
	eine einzelne, seriell wiederverwendete Verbindung besteht ihn nicht. Der
	Observer des CRSF-Runners zaehlt die Ueberlappung zusaetzlich unabhaengig.

	Gegen den echten Helfer (src/purchase-intent-db.mjs) und die echte Migration.
	Nur mit einem Wegwerf-Postgres, sonst sichtbar uebersprungen (wie M1-DB).
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { openPurchaseDb, rpcOn, race, freshWallet, intentFor, hash32 } from '../test-support/purchase-intent-pg.mjs';

const skip = !process.env.M1_DB_TEST_PG_URL || !process.env.M1_DB_TEST_PG_MODULE ? 'M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE nicht gesetzt (Wegwerf-Postgres noetig)' : false;
const H = await import('../src/purchase-intent-db.mjs');
const N = 40;

const tally = (results) => results.reduce((m, r) => { const k = r.code ? `${r.status}:${r.code}` : r.status; m[k] = (m[k] ?? 0) + 1; return m; }, {});

test('PURCHASE-DB-CONC', { skip, timeout: 600_000 }, async (t) => {
	const db = await openPurchaseDb('p4dc');
	t.after(() => db.close());
	const { sql, connect } = db;
	const client = rpcOn(sql);
	const row = async (id) => (await sql.query(`select *, encode(calldata_hash, 'hex') as ch from public.cover_purchase_intents where id = $1`, [id])).rows[0];
	let overlap = 0;

	/** Rennen mit Nachweis: 40 gleichzeitig wartende, verschiedene Verbindungen. */
	async function contend(fn) {
		const { waiting, results } = await race(connect, N, async (c, i, conn) => {
			const pid = (await conn.query('select pg_backend_pid() as pid')).rows[0].pid;
			return { pid, value: await fn(c, i) };
		});
		assert.equal(waiting, N, `the database reported ${waiting} simultaneously waiting connections, not ${N}`);
		assert.equal(new Set(results.map((r) => r.pid)).size, N, 'distinct backends');
		overlap += waiting - 1;
		return results.map((r) => r.value);
	}
	async function opened() {
		const wallet = freshWallet();
		const intent = intentFor(wallet);
		assert.equal((await H.createIntent(client, { intent, clientRequestId: crypto.randomUUID() })).status, 'created');
		return { wallet, intent, id: intent.id };
	}
	async function built() {
		const o = await opened();
		const calldataHash = hash32(`calldata-${o.id}`);
		assert.equal((await H.markBuilt(client, { intent: o.intent, calldataHash })).status, 'built');
		return { ...o, calldataHash };
	}
	async function submitted() {
		const o = await built();
		const txHash = hash32(`tx-${o.id}`);
		assert.equal((await H.markSubmitted(client, { id: o.id, wallet: o.wallet, calldataHash: o.calldataHash, txHash, txNonce: 4 })).status, 'submitted');
		return { ...o, txHash };
	}
	let coverSeq = 500_000 + (process.pid % 1000) * 1000;

	await t.test('P4D-CONC-A 40 concurrent creates for one wallet leave exactly one active intent', async () => {
		const wallet = freshWallet();
		const results = await contend((c) => H.createIntent(c, { intent: intentFor(wallet), clientRequestId: crypto.randomUUID() }));
		assert.deepEqual(tally(results), { created: 1, 'conflict:ACTIVE_INTENT_EXISTS': N - 1 });
		const active = await sql.query(`select count(*)::int as n from public.cover_purchase_intents where wallet = $1 and status in ('OPEN', 'BUILT', 'SUBMITTED')`, [wallet]);
		assert.equal(active.rows[0].n, 1);
	});

	await t.test('P4D-CONC-A2 concurrent retries with one idempotency key: one row, identical retries get it back, a changed payload is refused (no last write wins)', async () => {
		const wallet = freshWallet();
		const key = crypto.randomUUID();
		const a = intentFor(wallet), b = { ...a, amountRaw: '2000000000' };
		const results = await contend((c, i) => H.createIntent(c, { intent: i % 2 ? b : a, clientRequestId: key }));
		const t1 = tally(results);
		assert.equal(t1.created, 1);
		assert.equal((t1.existing ?? 0) + (t1['conflict:IDEMPOTENCY_KEY_REUSED'] ?? 0), N - 1);
		assert.equal(t1.existing, N / 2 - 1, 'only the retries with the winning payload are idempotent');
		assert.equal(t1['conflict:IDEMPOTENCY_KEY_REUSED'], N / 2);
		const stored = await sql.query(`select amount_raw from public.cover_purchase_intents where wallet = $1`, [wallet]);
		assert.equal(stored.rows.length, 1);
		const winner = results.findIndex((r) => r.status === 'created');
		assert.equal(stored.rows[0].amount_raw, winner % 2 ? '2000000000' : '1000000000', 'the stored payload is the winner\'s');
		results.forEach((r, i) => { if (r.status === 'existing') assert.equal(i % 2, winner % 2, 'only identical payloads are idempotent'); });
	});

	await t.test('P4D-CONC-B 40 concurrent builds with different calldata: exactly one build, its calldata hash is the bound one', async () => {
		const o = await opened();
		const results = await contend((c, i) => H.markBuilt(c, { intent: o.intent, calldataHash: hash32(`calldata-${i}-${o.id}`) }));
		assert.deepEqual(tally(results), { built: 1, 'conflict:CALLDATA_ALREADY_SET': N - 1 });
		const winner = results.find((r) => r.status === 'built');
		assert.equal(`0x${(await row(o.id)).ch}`, winner.intent.calldata_hash);
	});

	await t.test('P4D-CONC-C 40 concurrent submits with different tx hashes: exactly one tx hash is recorded', async () => {
		const o = await built();
		const results = await contend((c, i) => H.markSubmitted(c, { id: o.id, wallet: o.wallet, calldataHash: o.calldataHash, txHash: hash32(`tx-${i}-${o.id}`), txNonce: i }));
		assert.deepEqual(tally(results), { submitted: 1, 'conflict:TX_HASH_ALREADY_SET': N - 1 });
		const r = await row(o.id);
		assert.equal(r.status, 'SUBMITTED');
		assert.equal(r.tx_hash, results.find((x) => x.status === 'submitted').intent.tx_hash);
	});

	await t.test('P4D-CONC-D one tx hash submitted concurrently for 40 different intents has exactly one owner', async () => {
		const intents = [];
		for (let i = 0; i < N; i++) intents.push(await built());
		const shared = hash32(`shared-${intents[0].id}`);
		const results = await contend((c, i) => H.markSubmitted(c, { id: intents[i].id, wallet: intents[i].wallet, calldataHash: intents[i].calldataHash, txHash: shared, txNonce: 9 }));
		assert.deepEqual(tally(results), { submitted: 1, 'conflict:TX_HASH_TAKEN': N - 1 });
		assert.equal((await sql.query('select count(*)::int as n from public.cover_purchase_intents where tx_hash = $1', [shared])).rows[0].n, 1);
	});

	await t.test('P4D-CONC-E 40 concurrent identical confirmations are idempotent: one transition, one cover id', async () => {
		const o = await submitted();
		const cover = ++coverSeq;
		const results = await contend((c) => H.markConfirmed(c, { id: o.id, txHash: o.txHash, coverId: cover }));
		assert.deepEqual(tally(results), { confirmed: 1, existing: N - 1 });
		const r = await row(o.id);
		assert.deepEqual([r.status, Number(r.cover_id)], ['CONFIRMED', cover]);
	});

	await t.test('P4D-CONC-F a concurrent mix of late and normal confirmations assigns at most one cover id per intent and each cover id to one intent', async () => {
		const f1 = await submitted(), f2 = await submitted(), s3 = await submitted();
		await H.markFailed(client, { id: f1.id, txHash: f1.txHash, reason: 'TX_DROPPED' });
		await H.markFailed(client, { id: f2.id, txHash: f2.txHash, reason: 'TX_REVERTED' });
		const contested = ++coverSeq, other = ++coverSeq;
		const results = await contend((c, i) => {
			switch (i % 5) {
				case 0: return H.markLateConfirmed(c, { id: f1.id, txHash: f1.txHash, calldataHash: f1.calldataHash, coverId: contested });
				case 1: return H.markLateConfirmed(c, { id: f2.id, txHash: f2.txHash, calldataHash: f2.calldataHash, coverId: contested });
				case 2: return H.markConfirmed(c, { id: s3.id, txHash: s3.txHash, coverId: contested });
				case 3: return H.markLateConfirmed(c, { id: f1.id, txHash: f1.txHash, calldataHash: f1.calldataHash, coverId: other + i });
				default: return H.markConfirmed(c, { id: f1.id, txHash: f1.txHash, coverId: contested });
			}
		});
		const rows = (await sql.query('select id, status, cover_id, late from public.cover_purchase_intents where id = any($1)', [[f1.id, f2.id, s3.id]])).rows;
		assert.equal(rows.filter((r) => Number(r.cover_id) === contested).length, 1, 'the contested cover id has exactly one owner');
		for (const r of rows) {
			const wins = results.filter((x) => x.status === 'confirmed' && x.intent.id === r.id);
			assert.ok(wins.length <= 1, `intent ${r.id} confirmed ${wins.length} times`);
			if (r.cover_id !== null) assert.equal(Number(r.cover_id), Number(wins[0].intent.cover_id));
		}
		for (const r of rows.filter((x) => x.id !== s3.id && x.status === 'CONFIRMED')) assert.equal(r.late, true, 'a FAILED intent is confirmed only through the late path');
		assert.ok(results.every((x) => x.status !== 'existing' || x.intent.cover_id !== null));
		assert.equal(results.filter((x) => x.status === 'confirmed').length, rows.filter((r) => r.status === 'CONFIRMED').length);
	});

	await t.test('P4D-CONC overlap was observed in the database', () => {
		assert.ok(overlap > 0, `overlap_events ${overlap}`);
	});
});
