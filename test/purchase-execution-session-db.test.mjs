/**
 * Nexus P4I (20.10.2026): dauerhafte, einmal nutzbare Ausfuehrungs-Sitzungen gegen die ECHTE Datenbank
 * (alle Migrationen, Wegwerf-Postgres) und den echten Helfer src/purchase-execution-session-db.mjs.
 *
 *   M1_DB_TEST_PG_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *   M1_DB_TEST_PG_MODULE=/pfad/zu/node_modules/pg/lib/index.js \
 *   node --test test/purchase-execution-session-db.test.mjs
 * Ohne diese Variablen wird PURCHASE-SESSION-DB uebersprungen (scripts/skip-policy.mjs, exakt mit Datei
 * und Name). Hash-Hoheit ohne Datenbank und statische Pruefungen: test/purchase-execution-session-store.test.mjs.
 *
 * Gleichzeitigkeit: test/purchase-execution-session-db-concurrency.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { keccak256 } from 'viem';
import { openPurchaseDb, rpcOn, freshWallet, hash32 } from '../test-support/purchase-intent-pg.mjs';
import { builtIntent, sessionFor, buyData, nowS, BROKER, USDC } from '../test-support/purchase-execution-session-pg.mjs';
const X = await import('../src/purchase-execution-session-db.mjs');
const S = await import('../src/purchase-execution-session.mjs');
const D = await import('../src/purchase-intent-db.mjs');

const skip = !process.env.M1_DB_TEST_PG_URL || !process.env.M1_DB_TEST_PG_MODULE ? 'M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE nicht gesetzt (Wegwerf-Postgres noetig)' : false;
const TABLE = 'public.cover_purchase_execution_sessions';
const FUNCTIONS = ['consume_cover_purchase_execution_session', 'create_cover_purchase_execution_session'];
const INTERNAL = ['cover_purchase_execution_session_json', 'cover_purchase_execution_sessions_guard'];
const IMMUTABLE = ['session_id', 'intent_id', 'session_hash', 'intent_hash', 'calldata_hash', 'wallet', 'chain_id', 'transaction_kind', 'target', 'value_raw', 'data', 'verified_block', 'verified_block_hash', 'created_at', 'expires_at'];

/* ---------------------------------------------------------- echte Datenbank -- */

test('PURCHASE-SESSION-DB', { skip, timeout: 600_000 }, async (t) => {
	const { sql, close } = await openPurchaseDb('p4i_session');
	t.after(close);
	const client = rpcOn(sql);
	const row = async (id) => (await sql.query(`select *, '0x' || encode(session_hash, 'hex') as sh, '0x' || encode(data, 'hex') as d from ${TABLE} where session_id = $1`, [id])).rows[0];
	const sqlError = async (statement, params = []) => { try { await sql.query(statement, params); return 'OK'; } catch (e) { return e.message; } };
	const created = async (opts) => {
		const built = await builtIntent(client);
		const session = sessionFor(built, opts);
		const res = await X.persistExecutionSession(client, { session });
		assert.equal(res.status, 'created', `${res.status}:${res.code}`);
		return { built, session, res };
	};
	const consume = (s, consumerRequestId = randomUUID(), patch = {}) => X.consumeExecutionSession(client, { sessionId: s.sessionId, sessionHash: s.executionSessionHash, intentId: s.intentId, consumerRequestId, ...patch });
	const rawCreate = (s, patch = {}) => client.rpc('create_cover_purchase_execution_session', {
		p_session_id: s.sessionId, p_intent_id: s.intentId, p_session_hash: s.executionSessionHash, p_intent_hash: s.intentHash, p_calldata_hash: s.calldataHash, p_wallet: s.wallet,
		p_chain_id: 1, p_transaction_kind: s.transactionKind, p_target: s.to, p_value_raw: '0', p_data: s.data, p_verified_block: s.verifiedAtBlock.toString(),
		p_verified_block_hash: s.verifiedAtBlockHash, p_expires_at: s.expiresAt, ...patch
	}).then((r) => r.data ?? r.error);

	await t.test('P4I-DB-CREATE a valid P4H session is stored with exactly its canonical fields and the recomputed hash; nothing else', async () => {
		const { built, session, res } = await created();
		assert.equal(res.sessionHash, S.computeExecutionSessionHash(session));
		const r = await row(session.sessionId);
		assert.equal(r.sh, res.sessionHash);
		assert.deepEqual({
			intent_id: r.intent_id, intent_hash: `0x${r.intent_hash.toString('hex')}`, calldata_hash: `0x${r.calldata_hash.toString('hex')}`, wallet: r.wallet, chain_id: r.chain_id,
			transaction_kind: r.transaction_kind, target: r.target, value_raw: r.value_raw, data: r.d, verified_block: r.verified_block, verified_block_hash: `0x${r.verified_block_hash.toString('hex')}`,
			expires_at: Math.floor(r.expires_at.getTime() / 1000), consumed_at: r.consumed_at, consumer_request_id: r.consumer_request_id, superseded_at: r.superseded_at
		}, {
			intent_id: built.intent.id, intent_hash: built.intentHash, calldata_hash: built.calldataHash, wallet: built.intent.wallet, chain_id: 1, transaction_kind: 'NEXUS_BUY_COVER', target: BROKER,
			value_raw: '0', data: built.data, verified_block: session.verifiedAtBlock.toString(), verified_block_hash: session.verifiedAtBlockHash, expires_at: session.expiresAt,
			consumed_at: null, consumer_request_id: null, superseded_at: null
		});
		assert.ok(r.expires_at > r.created_at && r.expires_at - r.created_at <= 30_000, 'at most 30 s from the database clock');
		assert.deepEqual(Object.keys(r).filter((k) => !['sh', 'd'].includes(k)).sort(), [...IMMUTABLE, 'consumed_at', 'consumer_request_id', 'superseded_at'].sort(), 'no key, signature, receipt, RPC answer, IP, user agent or metadata column');
		assert.equal(res.session.executionSessionHash, res.sessionHash);
		// gleiche Sitzung erneut: idempotent; gleiche id mit anderen Feldern: Konflikt; zweite offene Sitzung: Konflikt
		assert.equal((await X.persistExecutionSession(client, { session })).status, 'existing');
		const other = sessionFor(built, { sessionId: session.sessionId, verifiedAtBlock: session.verifiedAtBlock + 7n });
		assert.deepEqual(await X.persistExecutionSession(client, { session: other }), { status: 'conflict', code: 'SESSION_ID_REUSED' });
		assert.deepEqual(await X.persistExecutionSession(client, { session: sessionFor(built) }), { status: 'conflict', code: 'OPEN_SESSION_EXISTS' });
		assert.deepEqual(await X.persistExecutionSession(client, { session: sessionFor(built, { kind: 'USDC_APPROVAL' }) }), { status: 'conflict', code: 'OPEN_SESSION_EXISTS' }, 'one open session per intent, whatever the kind');
		assert.equal((await sql.query(`select count(*)::int as n from ${TABLE} where intent_id = $1`, [built.intent.id])).rows[0].n, 1);
	});

	await t.test('P4I-DB-HASH a stored session hash cannot be reused for other block, block hash, target, data, wallet or expiry', async () => {
		const { built, session } = await created();
		// am Helfer vorbei, mit dem gueltigen Hash und anderen Feldern: die Datenbank bindet den Hash an genau eine Sitzung
		for (const patch of [{ p_verified_block: '1' }, { p_verified_block_hash: hash32('b2') }, { p_data: `${built.data}00` }, { p_expires_at: session.expiresAt - 1 }]) {
			assert.equal((await rawCreate({ ...session, sessionId: randomUUID() }, patch)).status, 'conflict', Object.keys(patch)[0]);
		}
		assert.equal((await sql.query(`select count(*)::int as n from ${TABLE} where session_hash = $1`, [Buffer.from(session.executionSessionHash.slice(2), 'hex')])).rows[0].n, 1);
		const b2 = await builtIntent(client);
		assert.deepEqual(await rawCreate({ ...sessionFor(b2), executionSessionHash: session.executionSessionHash }), { status: 'conflict', code: 'SESSION_HASH_REUSED' }, 'one hash, one session');
		assert.deepEqual(await rawCreate(sessionFor(b2), { p_session_hash: 'nope' }), { status: 'rejected', code: 'HASH_FORMAT' });
		assert.deepEqual(await rawCreate(sessionFor(b2), { p_wallet: b2.intent.wallet.replace(/[a-f]/, 'A') }), { status: 'rejected', code: 'FORMAT' });
		assert.deepEqual(await rawCreate(sessionFor(b2), { p_target: USDC }), { status: 'rejected', code: 'SESSION_CONSTRAINT' }, 'buyCover only at the Broker');
		assert.deepEqual(await rawCreate(sessionFor(b2), { p_transaction_kind: 'USDC_APPROVAL' }), { status: 'rejected', code: 'SESSION_CONSTRAINT' }, 'approval only to USDC with the approve selector');
		assert.deepEqual(await rawCreate(sessionFor(b2), { p_value_raw: '1' }), { status: 'rejected', code: 'FIELD' });
		assert.deepEqual(await rawCreate(sessionFor(b2), { p_chain_id: 10 }), { status: 'rejected', code: 'FIELD' });
		assert.deepEqual(await rawCreate(sessionFor(b2), { p_verified_block: '0' }), { status: 'rejected', code: 'FIELD' });
		assert.equal((await sql.query(`select count(*)::int as n from ${TABLE} where intent_id = $1`, [b2.intent.id])).rows[0].n, 0);
		// beim Verbrauch: falscher erwarteter Hash
		assert.deepEqual(await consume(session, randomUUID(), { sessionHash: hash32('forged') }), { status: 'REJECTED', code: 'SESSION_MISMATCH', session: null });
		assert.equal((await row(session.sessionId)).consumed_at, null);
	});

	await t.test('P4I-DB-CREATE-INTENT creation fails closed unless the intent is exactly this BUILT row', async () => {
		const b = await builtIntent(client);
		const s = sessionFor(b);
		assert.deepEqual(await rawCreate(s, { p_intent_hash: hash32('other') }), { status: 'rejected', code: 'INTENT_HASH_MISMATCH' });
		assert.deepEqual(await rawCreate(s, { p_calldata_hash: hash32('other') }), { status: 'rejected', code: 'CALLDATA_HASH_MISMATCH' });
		assert.deepEqual(await rawCreate(s, { p_wallet: freshWallet() }), { status: 'rejected', code: 'WALLET_MISMATCH' });
		assert.deepEqual(await rawCreate(s, { p_intent_id: randomUUID() }), { status: 'rejected', code: 'INTENT_NOT_FOUND' });
		assert.deepEqual(await rawCreate(s, { p_expires_at: nowS() + 31 }), { status: 'rejected', code: 'SESSION_WINDOW' }, 'over 30 s');
		assert.deepEqual(await rawCreate(s, { p_expires_at: nowS() - 1 }), { status: 'rejected', code: 'SESSION_WINDOW' }, 'already expired');
		// OPEN (nicht gebaut)
		const open = (await import('../test-support/purchase-intent-pg.mjs')).intentFor(freshWallet());
		assert.equal((await D.createIntent(client, { intent: open, clientRequestId: randomUUID() })).status, 'created');
		const openSession = sessionFor({ intent: open, intentHash: (await import('../src/purchase-intent.mjs')).computePurchaseIntentHash(open), data: buyData('o'), calldataHash: keccak256(buyData('o')) });
		assert.deepEqual(await X.persistExecutionSession(client, { session: openSession }), { status: 'rejected', code: 'CALLDATA_HASH_MISMATCH' });
		// SUBMITTED und CANCELLED
		const sub = await builtIntent(client);
		assert.equal((await D.markSubmitted(client, { id: sub.intent.id, wallet: sub.intent.wallet, calldataHash: sub.calldataHash, txHash: hash32(`tx-${sub.intent.id}`), txNonce: 1 })).status, 'submitted');
		assert.deepEqual(await X.persistExecutionSession(client, { session: sessionFor(sub) }), { status: 'rejected', code: 'INTENT_NOT_BUILT' });
		const can = await builtIntent(client);
		assert.equal((await D.cancelIntent(client, { id: can.intent.id, wallet: can.intent.wallet })).status, 'cancelled');
		assert.deepEqual(await X.persistExecutionSession(client, { session: sessionFor(can) }), { status: 'rejected', code: 'INTENT_NOT_BUILT' });
		assert.equal((await X.persistExecutionSession(client, { session: s })).status, 'created', 'the exact row works');
	});

	await t.test('P4I-DB-CONSUME a session is consumed once; the same request gets the same record back, any other request ALREADY_CONSUMED', async () => {
		const { built, session } = await created();
		const key = randomUUID();
		const first = await consume(session, key);
		assert.equal(first.status, 'CONSUMED');
		assert.equal(first.session.executionSessionHash, session.executionSessionHash);
		for (const k of ['sessionId', 'intentId', 'intentHash', 'calldataHash', 'wallet', 'chainId', 'transactionKind', 'to', 'value', 'data', 'verifiedAtBlock', 'verifiedAtBlockHash', 'expiresAt']) {
			assert.deepEqual(first.session[k], session[k], `consumed fact ${k} is the persisted one, unchanged`);
		}
		assert.equal(first.session.consumerRequestId, key);
		const replay = await consume(session, key);
		assert.equal(replay.status, 'IDEMPOTENT_REPLAY', 'the same request gets the same consumed record');
		assert.deepEqual(replay.session, first.session);
		assert.deepEqual(await consume(session, randomUUID()), { status: 'ALREADY_CONSUMED', code: 'ALREADY_CONSUMED', session: null });
		const r = await row(session.sessionId);
		assert.equal(r.consumer_request_id, key);
		assert.ok(r.consumed_at >= r.created_at && r.consumed_at < r.expires_at);
		// falsche Kennungen
		const other = await created();
		assert.deepEqual(await consume(other.session, randomUUID(), { intentId: built.intent.id }), { status: 'REJECTED', code: 'SESSION_MISMATCH', session: null }, 'intent id must be the session\'s');
		assert.deepEqual(await consume(other.session, randomUUID(), { sessionId: randomUUID() }), { status: 'REJECTED', code: 'SESSION_MISMATCH', session: null });
		assert.equal((await row(other.session.sessionId)).consumed_at, null);
		// dieselbe Art nach dem Verbrauch: keine zweite Berechtigung; die andere Art schon
		assert.deepEqual(await X.persistExecutionSession(client, { session: sessionFor(built) }), { status: 'conflict', code: 'KIND_ALREADY_CONSUMED' });
		const approval = sessionFor(built, { kind: 'USDC_APPROVAL' });
		assert.equal((await X.persistExecutionSession(client, { session: approval })).status, 'created');
		assert.equal((await consume(approval)).status, 'CONSUMED');
		assert.deepEqual(await X.persistExecutionSession(client, { session: sessionFor(built, { kind: 'USDC_APPROVAL' }) }), { status: 'conflict', code: 'KIND_ALREADY_CONSUMED' });
	});

	// Grenzen in EINER Transaktion: now() ist dort fest; Intent und Sitzung relativ dazu angelegt (als Owner).
	async function atBoundary({ intentStatus = 'BUILT', deadline = `now() + interval '60 seconds'`, intentExpires = `now() + interval '5 minutes'`, expires, superseded = null }) {
		await sql.query('begin');
		try {
			const id = randomUUID(), wallet = freshWallet(), data = buyData(id), sid = randomUUID();
			const ih = Buffer.from(hash32(id).slice(2), 'hex'), ch = Buffer.from(keccak256(data).slice(2), 'hex');
			await sql.query(`insert into public.cover_purchase_intents (id, wallet, chain_id, deployment_key, product_id, product_type_id, cover_asset_id, amount_raw, period_days, quote_premium_raw, max_premium_raw,
				quote_fetched_at, capacity_fetched_at, wording_cid, annex_cid, terms_version, terms_hash, proof_of_loss_cid, commission_ratio, commission_destination, pin_version, intent_hash,
				acknowledged_at, expires_at, status, status_reason, calldata_hash, built_at, build_deadline, client_request_id, created_at, updated_at)
				values ($1, $2, 1, 'aave-v3-ethereum-core', 97, 0, 6, 1000000000, 30, 3000578, 3030584, now() - interval '5 minutes 10 seconds', now() - interval '5 minutes 10 seconds',
				'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY', null, 'coverraccoon.terms/1', $3, null, 0, '0x0000000000000000000000000000000000000000', 'nexus-pin-1:broker-v2.12.1:cover-v3.3.0', $4,
				now() - interval '5 minutes', ${intentExpires}, '${intentStatus}', ${intentStatus === 'EXPIRED' ? `'BUILD_DEADLINE_PASSED'` : 'null'}, $5, (${deadline}) - interval '100 seconds', ${deadline}, gen_random_uuid(), now() - interval '5 minutes', now())`,
			[id, wallet, Buffer.from(hash32('t').slice(2), 'hex'), ih, ch]);
			await sql.query(`insert into ${TABLE} (session_id, intent_id, session_hash, intent_hash, calldata_hash, wallet, chain_id, transaction_kind, target, value_raw, data, verified_block, verified_block_hash, created_at, expires_at, superseded_at)
				values ($1, $2, $3, $4, $5, $6, 1, 'NEXUS_BUY_COVER', $7, 0, $8, 1, $9, now() - interval '20 seconds', ${expires}, ${superseded ?? 'null'})`,
			[sid, id, Buffer.from(hash32(sid).slice(2), 'hex'), ih, ch, wallet, BROKER, Buffer.from(data.slice(2), 'hex'), Buffer.alloc(32, 7)]);
			return (await sql.query('select public.consume_cover_purchase_execution_session(p_session_id => $1, p_session_hash => $2, p_intent_id => $3, p_consumer_request_id => $4) as v', [sid, hash32(sid), id, randomUUID()])).rows[0].v;
		} finally {
			await sql.query('rollback');
		}
	}
	const code = (v) => (v.status === 'consumed' ? 'consumed' : `${v.status}:${v.code}`);

	await t.test('P4I-DB-EXPIRY the database refuses consumption from expires_at on (exactly now() is refused), without any cleanup job', async () => {
		assert.equal(code(await atBoundary({ expires: 'now()' })), 'rejected:EXPIRED', 'expires exactly now: refused');
		assert.equal(code(await atBoundary({ expires: `now() + interval '1 microsecond'` })), 'consumed', 'one microsecond left: consumable');
		assert.equal(code(await atBoundary({ expires: `now() - interval '1 second'`, superseded: 'now()' })), 'rejected:SUPERSEDED');
		// echte Uhr: eine Sitzung mit 2 s Laufzeit ist danach nicht mehr verbrauchbar; eine neue loest sie ab
		const { built, session } = await created({ ttl: 2 });
		while ((await sql.query('select now() >= to_timestamp($1) as x', [session.expiresAt])).rows[0].x === false) await new Promise((r) => setTimeout(r, 100));
		assert.deepEqual(await consume(session), { status: 'REJECTED', code: 'EXPIRED', session: null });
		const next = sessionFor(built);
		assert.equal((await X.persistExecutionSession(client, { session: next })).status, 'created', 'an expired open session does not block a new one');
		const old = await row(session.sessionId);
		assert.ok(old.superseded_at !== null && old.consumed_at === null, 'the expired session is superseded, never consumed');
		assert.deepEqual(await consume(session), { status: 'REJECTED', code: 'SUPERSEDED', session: null });
		assert.equal((await sql.query(`select count(*)::int as n from ${TABLE} where intent_id = $1 and consumed_at is null and superseded_at is null`, [built.intent.id])).rows[0].n, 1, 'one usable session');
		assert.equal((await consume(next)).status, 'CONSUMED');
	});

	await t.test('P4I-DB-INTENT-STATE consumption requires the intent still BUILT, without tx hash or cover id, before build_deadline and expiry', async () => {
		const sub = await created();
		const txHash = hash32(`tx-${sub.built.intent.id}`);
		assert.equal((await D.markSubmitted(client, { id: sub.built.intent.id, wallet: sub.built.intent.wallet, calldataHash: sub.built.calldataHash, txHash, txNonce: 1 })).status, 'submitted');
		assert.deepEqual(await consume(sub.session), { status: 'REJECTED', code: 'INTENT_NOT_ELIGIBLE', session: null }, 'SUBMITTED');
		const conf = await created();
		const tx2 = hash32(`tx-${conf.built.intent.id}`);
		await D.markSubmitted(client, { id: conf.built.intent.id, wallet: conf.built.intent.wallet, calldataHash: conf.built.calldataHash, txHash: tx2, txNonce: 1 });
		assert.equal((await D.markConfirmed(client, { id: conf.built.intent.id, txHash: tx2, coverId: 900_000 + (process.pid % 10_000) })).status, 'confirmed');
		assert.deepEqual(await consume(conf.session), { status: 'REJECTED', code: 'INTENT_NOT_ELIGIBLE', session: null }, 'CONFIRMED');
		const fail = await created();
		const tx3 = hash32(`tx-${fail.built.intent.id}`);
		await D.markSubmitted(client, { id: fail.built.intent.id, wallet: fail.built.intent.wallet, calldataHash: fail.built.calldataHash, txHash: tx3, txNonce: 1 });
		assert.equal((await D.markFailed(client, { id: fail.built.intent.id, txHash: tx3, reason: 'TX_DROPPED' })).status, 'failed');
		assert.deepEqual(await consume(fail.session), { status: 'REJECTED', code: 'INTENT_NOT_ELIGIBLE', session: null }, 'FAILED');
		const can = await created();
		assert.equal((await D.cancelIntent(client, { id: can.built.intent.id, wallet: can.built.intent.wallet })).status, 'cancelled');
		assert.deepEqual(await consume(can.session), { status: 'REJECTED', code: 'INTENT_NOT_ELIGIBLE', session: null }, 'CANCELLED');
		for (const s of [sub, conf, fail, can]) assert.equal((await row(s.session.sessionId)).consumed_at, null);
		// Zeiten des Intents, auch wenn die Sitzung selbst noch laeuft (Zeile am Anlegen vorbei)
		assert.equal(code(await atBoundary({ deadline: 'now()', expires: `now() + interval '5 seconds'` })), 'rejected:INTENT_NOT_ELIGIBLE', 'build_deadline reached');
		assert.equal(code(await atBoundary({ deadline: `now() - interval '1 second'`, intentExpires: `now()`, expires: `now() + interval '5 seconds'` })), 'rejected:INTENT_NOT_ELIGIBLE', 'intent expired');
		assert.equal(code(await atBoundary({ intentStatus: 'EXPIRED', deadline: `now() - interval '1 second'`, expires: `now() + interval '5 seconds'` })), 'rejected:INTENT_NOT_ELIGIBLE', 'EXPIRED');
		assert.equal(code(await atBoundary({ deadline: `now() + interval '1 microsecond'`, expires: `now() + interval '1 microsecond'` })), 'consumed', 'the positive control at the same bounds');
	});

	await t.test('P4I-DB-IMMUTABLE after insert only consumed_at and consumer_request_id change, once; nothing is cleared, extended or deleted', async () => {
		const { session } = await created({ ttl: 10 });
		const before = await row(session.sessionId);
		const changes = {
			session_id: `'${randomUUID()}'`, intent_id: `'${randomUUID()}'`, session_hash: `'\\x${'11'.repeat(32)}'`, intent_hash: `'\\x${'12'.repeat(32)}'`, calldata_hash: `'\\x${'13'.repeat(32)}'`,
			wallet: `'${freshWallet()}'`, chain_id: '1', transaction_kind: `'USDC_APPROVAL'`, target: `'${freshWallet()}'`, value_raw: '0', data: `data || '\\x00'::bytea`,
			verified_block: 'verified_block + 1', verified_block_hash: `'\\x${'14'.repeat(32)}'`, created_at: `created_at - interval '1 second'`, expires_at: `expires_at + interval '5 seconds'`
		};
		for (const [col, value] of Object.entries(changes)) {
			if (['chain_id', 'value_raw'].includes(col)) continue;
			assert.notEqual(await sqlError(`update ${TABLE} set ${col} = ${value} where session_id = $1`, [session.sessionId]), 'OK', `${col} must not change`);
		}
		assert.match(await sqlError(`update ${TABLE} set target = $2 where session_id = $1`, [session.sessionId, freshWallet()]), /target is immutable|violates check constraint/);
		assert.match(await sqlError(`update ${TABLE} set expires_at = expires_at + interval '5 seconds' where session_id = $1`, [session.sessionId]), /expires_at is immutable/, 'no extension');
		assert.match(await sqlError(`update ${TABLE} set wallet = $2 where session_id = $1`, [session.sessionId, freshWallet()]), /wallet is immutable/);
		assert.match(await sqlError(`update ${TABLE} set verified_block = verified_block + 1 where session_id = $1`, [session.sessionId]), /verified_block is immutable/);
		assert.match(await sqlError(`update ${TABLE} set verified_block_hash = $2 where session_id = $1`, [session.sessionId, Buffer.alloc(32, 9)]), /verified_block_hash is immutable/);
		assert.deepEqual(await row(session.sessionId), before, 'unchanged');
		const key = randomUUID();
		assert.equal((await consume(session, key)).status, 'CONSUMED');
		assert.match(await sqlError(`update ${TABLE} set consumed_at = null, consumer_request_id = null where session_id = $1`, [session.sessionId]), /consumed_at is set once/, 'never cleared');
		assert.match(await sqlError(`update ${TABLE} set consumed_at = consumed_at + interval '1 millisecond' where session_id = $1`, [session.sessionId]), /consumed_at is set once/);
		assert.match(await sqlError(`update ${TABLE} set consumer_request_id = $2 where session_id = $1`, [session.sessionId, randomUUID()]), /consumer_request_id is set once/);
		assert.equal((await row(session.sessionId)).consumer_request_id, key);
		assert.match(await sqlError(`delete from ${TABLE} where session_id = $1`, [session.sessionId]), /rows are never deleted/, 'even the owner cannot delete');
		assert.match(await sqlError(`truncate ${TABLE}`), /rows are never deleted/, 'even the owner cannot truncate');
		assert.ok(await row(session.sessionId));
	});

	const asRole = async (role, statement, params = []) => { await sql.query('begin'); try { await sql.query(`set local role ${role}`); await sql.query(statement, params); return 'OK'; } catch (e) { return e.code ?? e.message; } finally { await sql.query('rollback'); } };
	const fns = async () => (await sql.query(`select p.oid, p.proname, p.prosecdef, p.prosrc, p.proconfig, p.oid::regprocedure::text as sig, p.proargtypes::regtype[]::text[] as argtypes from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '%cover_purchase_execution_session%'`)).rows;
	const nullArgs = (fn) => fn.argtypes.map((x) => `null::${x}`).join(', ');

	await t.test('P4I-DB-PRIVILEGES RLS on, no direct table access for anyone (service_role included); service_role executes only the two functions; no delete path', async () => {
		const { session } = await created();
		assert.equal((await sql.query(`select relrowsecurity from pg_class where oid = '${TABLE}'::regclass`)).rows[0].relrowsecurity, true);
		for (const role of ['anon', 'authenticated', 'service_role']) {
			for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) assert.equal((await sql.query(`select has_table_privilege($1, '${TABLE}', $2) as x`, [role, p])).rows[0].x, false, `${role} ${p}`);
			assert.equal(await asRole(role, `select * from ${TABLE}`), '42501', `${role} select`);
			assert.equal(await asRole(role, `insert into ${TABLE} default values`), '42501', `${role} insert`);
			assert.equal(await asRole(role, `update ${TABLE} set consumed_at = null`), '42501', `${role} update`);
			assert.equal(await asRole(role, `delete from ${TABLE}`), '42501', `${role} delete`);
		}
		const all = await fns();
		assert.deepEqual(all.map((f) => f.proname).sort(), [...FUNCTIONS, ...INTERNAL].sort(), 'no further function (no delete helper, no generic update)');
		for (const fn of all) {
			for (const role of ['anon', 'authenticated']) {
				assert.equal((await sql.query(`select has_function_privilege($1, $2::oid, 'EXECUTE') as x`, [role, fn.oid])).rows[0].x, false, `${role} ${fn.sig}`);
				assert.equal(await asRole(role, `select public.${fn.proname}(${nullArgs(fn)})`), '42501', `${role} calling ${fn.sig}`);
			}
			const publicExec = (await sql.query(`select exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as x from pg_proc p where p.oid = $1`, [fn.oid])).rows[0].x;
			assert.equal(publicExec, false, `PUBLIC ${fn.sig}`);
			assert.ok((fn.proconfig ?? []).includes('search_path=public, pg_temp'), `${fn.proname} pins search_path`);
			assert.doesNotMatch(fn.prosrc, /\bexecute\b|format\s*\(|\bdelete\s+from\b|\btruncate\s+(table\s+)?(public\.)?[a-z_]/i, `${fn.proname}: no dynamic SQL, no delete`);
		}
		const callable = [];
		for (const fn of all) if ((await sql.query(`select has_function_privilege('service_role', $1::oid, 'EXECUTE') as x`, [fn.oid])).rows[0].x) callable.push(fn.proname);
		assert.deepEqual(callable.sort(), FUNCTIONS);
		for (const helper of INTERNAL) assert.equal(await asRole('service_role', `select public.${helper}(${nullArgs(all.find((f) => f.proname === helper))})`), '42501', helper);
		assert.deepEqual(all.filter((f) => f.prosecdef).map((f) => f.proname).sort(), FUNCTIONS, 'definer only where it writes');
		assert.equal(await asRole('service_role', `select public.consume_cover_purchase_execution_session($1, $2, $3, $4)`, [session.sessionId, session.executionSessionHash, session.intentId, randomUUID()]), 'OK', 'service_role reaches the function');
		const triggers = (await sql.query(`select tgname from pg_trigger where tgrelid = '${TABLE}'::regclass and not tgisinternal order by tgname`)).rows.map((x) => x.tgname);
		assert.deepEqual(triggers, ['cover_purchase_execution_sessions_guard', 'cover_purchase_execution_sessions_no_truncate']);
		assert.match(await sqlError(`delete from ${TABLE} where session_id = $1`, [session.sessionId]), /rows are never deleted/);
	});
});
