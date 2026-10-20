/*
	Nexus P4D (19.10.2026): Kauf-Intents gegen ECHTEN Postgres - Unveraenderlichkeit,
	Uebergaenge, Idempotenz, Hash-Hoheit, Ablaufgrenzen, Rechte, kein DELETE.

	Gegen den echten Helfer (src/purchase-intent-db.mjs) und die echte Migration.
	Laeuft nur mit einem Wegwerf-Postgres, sonst sichtbar uebersprungen:

	  M1_DB_TEST_PG_URL=postgres://postgres@127.0.0.1:54329/postgres \
	  M1_DB_TEST_PG_MODULE=/pfad/zu/node_modules/pg/lib/index.js \
	  node --test test/purchase-intent-db.test.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { openPurchaseDb, rpcOn, freshWallet, intentFor, hash32, TEST_CID } from '../test-support/purchase-intent-pg.mjs';

const skip = !process.env.M1_DB_TEST_PG_URL || !process.env.M1_DB_TEST_PG_MODULE ? 'M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE nicht gesetzt (Wegwerf-Postgres noetig)' : false;
const H = await import('../src/purchase-intent-db.mjs');
const I = await import('../src/purchase-intent.mjs');

const FUNCTIONS = ['create_cover_purchase_intent', 'mark_cover_purchase_intent_built', 'mark_cover_purchase_intent_submitted', 'mark_cover_purchase_intent_confirmed', 'mark_cover_purchase_intent_failed', 'mark_cover_purchase_intent_late_confirmed', 'cancel_cover_purchase_intent', 'expire_cover_purchase_intent'];
const INTERNAL = ['cover_purchase_intents_guard', 'cover_purchase_intent_json'];

test('PURCHASE-DB', { skip, timeout: 600_000 }, async (t) => {
	const db = await openPurchaseDb('p4d');
	t.after(() => db.close());
	const { sql } = db;
	const client = rpcOn(sql);
	const row = async (id) => (await sql.query('select *, encode(intent_hash, \'hex\') as ih, encode(calldata_hash, \'hex\') as ch from public.cover_purchase_intents where id = $1', [id])).rows[0];
	const sqlState = async (statement, params = []) => { try { await sql.query(statement, params); return 'OK'; } catch (e) { return e.code ?? e.message; } };
	const sqlError = async (statement, params = []) => { try { await sql.query(statement, params); return 'OK'; } catch (e) { return e.message; } };
	async function open(patch = {}) {
		const wallet = freshWallet();
		const intent = intentFor(wallet, patch);
		const r = await H.createIntent(client, { intent, clientRequestId: crypto.randomUUID() });
		assert.equal(r.status, 'created', JSON.stringify(r));
		return { wallet, intent, id: intent.id };
	}
	async function built(patch) {
		const o = await open(patch);
		const calldataHash = hash32(`calldata-${o.id}`);
		assert.equal((await H.markBuilt(client, { intent: o.intent, calldataHash })).status, 'built');
		return { ...o, calldataHash };
	}
	async function submitted(patch) {
		const o = await built(patch);
		const txHash = hash32(`tx-${o.id}`);
		assert.equal((await H.markSubmitted(client, { id: o.id, wallet: o.wallet, calldataHash: o.calldataHash, txHash, txNonce: 7 })).status, 'submitted');
		return { ...o, txHash };
	}
	let coverSeq = 900_000 + (process.pid % 1000) * 1000;
	const nextCover = () => ++coverSeq;

	/* ------------------------------------------------------- Anlegen, Idempotenz -- */

	await t.test('P4D-CREATE a created intent is OPEN with the server-computed P4A hash; retries are idempotent, a reused key with other data is refused', async () => {
		const wallet = freshWallet();
		const intent = intentFor(wallet);
		const key = crypto.randomUUID();
		const first = await H.createIntent(client, { intent, clientRequestId: key });
		assert.equal(first.status, 'created');
		const stored = await row(intent.id);
		assert.equal(`0x${stored.ih}`, I.computePurchaseIntentHash(intent));
		assert.deepEqual([stored.status, stored.calldata_hash, stored.tx_hash, stored.cover_id, stored.late, stored.terms_version], ['OPEN', null, null, null, false, 'coverraccoon.terms/1']);
		assert.equal((await H.createIntent(client, { intent, clientRequestId: key })).status, 'existing');
		assert.deepEqual(await H.createIntent(client, { intent: { ...intent, amountRaw: '2000000000' }, clientRequestId: key }), { status: 'conflict', code: 'IDEMPOTENCY_KEY_REUSED' });
		assert.deepEqual(await H.createIntent(client, { intent: { ...intent, periodDays: 31 }, clientRequestId: key }), { status: 'conflict', code: 'IDEMPOTENCY_KEY_REUSED' });
		assert.deepEqual(await H.createIntent(client, { intent: intentFor(wallet), clientRequestId: crypto.randomUUID() }), { status: 'conflict', code: 'ACTIVE_INTENT_EXISTS' }, 'one active intent per wallet');
		assert.equal((await H.createIntent(client, { intent: intentFor(freshWallet()), clientRequestId: key })).status, 'created', 'the key is per wallet');
		assert.equal(Number((await sql.query('select count(*) from public.cover_purchase_intents where wallet = $1', [wallet])).rows[0].count), 1);
	});

	await t.test('P4D-ACTIVE a wallet with a BUILT or SUBMITTED intent cannot open a second one; a terminal intent frees the wallet', async () => {
		const s = await submitted();
		assert.deepEqual(await H.createIntent(client, { intent: intentFor(s.wallet), clientRequestId: crypto.randomUUID() }), { status: 'conflict', code: 'ACTIVE_INTENT_EXISTS' }, 'SUBMITTED stays active');
		const b = await built();
		assert.deepEqual(await H.createIntent(client, { intent: intentFor(b.wallet), clientRequestId: crypto.randomUUID() }), { status: 'conflict', code: 'ACTIVE_INTENT_EXISTS' }, 'BUILT is active');
		await H.cancelIntent(client, { id: b.id, wallet: b.wallet });
		assert.equal((await H.createIntent(client, { intent: intentFor(b.wallet), clientRequestId: crypto.randomUUID() })).status, 'created');
	});

	await t.test('P4D-IDEMPOTENCY a key stays bound after its intent ended: never a second row for the same key', async () => {
		const wallet = freshWallet(), key = crypto.randomUUID();
		const intent = intentFor(wallet);
		assert.equal((await H.createIntent(client, { intent, clientRequestId: key })).status, 'created');
		await H.cancelIntent(client, { id: intent.id, wallet });
		const again = await H.createIntent(client, { intent, clientRequestId: key });
		assert.deepEqual([again.status, again.intent?.status], ['existing', 'CANCELLED'], 'the identical retry returns the ended intent, it does not reopen it');
		assert.deepEqual(await H.createIntent(client, { intent: intentFor(wallet), clientRequestId: key }), { status: 'conflict', code: 'IDEMPOTENCY_KEY_REUSED' });
		assert.equal((await sql.query('select count(*)::int as n from public.cover_purchase_intents where wallet = $1', [wallet])).rows[0].n, 1);
	});

	await t.test('P4D-BUILD only an OPEN intent is built: a cancelled one is refused', async () => {
		const o = await open();
		await H.cancelIntent(client, { id: o.id, wallet: o.wallet });
		assert.deepEqual(await H.markBuilt(client, { intent: o.intent, calldataHash: hash32('c') }), { status: 'conflict', code: 'NOT_OPEN' });
		assert.equal((await row(o.id)).status, 'CANCELLED');
	});

	await t.test('P4D-CREATE invalid intents and caller-chosen hashes never reach the table', async () => {
		assert.deepEqual(await H.createIntent(client, { intent: { ...intentFor(freshWallet()), commissionRatio: 1000 }, clientRequestId: crypto.randomUUID() }), { status: 'rejected', code: 'INVALID_INTENT' });
		assert.deepEqual(await H.createIntent(client, { intent: { ...intentFor(freshWallet()), intentHash: hash32('x') }, clientRequestId: crypto.randomUUID() }), { status: 'rejected', code: 'INVALID_INTENT' }, 'a supplied hash is an unknown field');
		// direkt an der Funktion vorbei am Helfer: die Spaltenregeln greifen trotzdem
		const wallet = freshWallet();
		const call = (over) => sql.query(`select public.create_cover_purchase_intent(p_id => $1, p_wallet => $2, p_chain_id => 1, p_deployment_key => 'aave-v3-ethereum-core', p_product_id => $3, p_product_type_id => 0, p_cover_asset_id => 6::smallint, p_amount_raw => $4, p_period_days => 30::smallint, p_quote_premium_raw => 3000578, p_max_premium_raw => 3030584, p_quote_fetched_at => now() - interval '10 seconds', p_capacity_fetched_at => now() - interval '10 seconds', p_wording_cid => 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY', p_annex_cid => null, p_terms_version => 'coverraccoon.terms/1', p_terms_hash => $5, p_proof_of_loss_cid => null, p_commission_ratio => $6::smallint, p_commission_destination => '0x0000000000000000000000000000000000000000', p_pin_version => 'nexus-pin-1:broker-v2.12.1:cover-v3.3.0', p_intent_hash => $7, p_acknowledged_at => now() - interval '5 seconds', p_expires_at => $8::timestamptz, p_client_request_id => $9) as v`,
			[crypto.randomUUID(), over.wallet ?? wallet, over.product ?? 97, over.amount ?? '1000', hash32('t'), over.commission ?? 0, over.hash ?? hash32(crypto.randomUUID()), over.expires ?? new Date(Date.now() + 300_000).toISOString(), crypto.randomUUID()]).then((r) => r.rows[0].v);
		assert.deepEqual(await call({ product: 98 }), { status: 'rejected', code: 'INVALID_INTENT' });
		assert.deepEqual(await call({ amount: '0' }), { status: 'rejected', code: 'INVALID_INTENT' });
		assert.deepEqual(await call({ amount: '79228162514264337593543950336' }), { status: 'rejected', code: 'INVALID_INTENT' }, 'above uint96');
		assert.deepEqual(await call({ commission: 1000 }), { status: 'rejected', code: 'INVALID_INTENT' });
		assert.deepEqual(await call({ wallet: '0xABCDEF0000000000000000000000000000000001' }), { status: 'rejected', code: 'INVALID_INTENT' }, 'lowercase only');
		assert.deepEqual(await call({ expires: new Date(Date.now() + 16 * 60_000).toISOString() }), { status: 'rejected', code: 'INVALID_INTENT' }, 'at most 15 minutes');
		assert.deepEqual(await call({ expires: new Date(Date.now() - 1000).toISOString() }), { status: 'rejected', code: 'INVALID_INTENT' }, 'never already expired');
		assert.deepEqual(await call({ hash: '0x1234' }), { status: 'rejected', code: 'HASH_FORMAT' });
	});

	await t.test('P4D-HASH tampered intent data cannot reuse a valid hash: the hash is recomputed from the stored data', async () => {
		const o = await open();
		const tampered = { ...o.intent, amountRaw: '5000000000' };
		assert.deepEqual(await H.markBuilt(client, { intent: tampered, calldataHash: hash32('c') }), { status: 'rejected', code: 'INTENT_HASH_MISMATCH' });
		assert.equal((await row(o.id)).status, 'OPEN');
		const wallet = freshWallet();
		const a = intentFor(wallet);
		await H.createIntent(client, { intent: { ...a, maxPremiumRaw: '9999999' }, clientRequestId: crypto.randomUUID() });
		assert.equal(`0x${(await row(a.id)).ih}`, I.computePurchaseIntentHash({ ...a, maxPremiumRaw: '9999999' }), 'the stored hash belongs to the stored data');
		assert.notEqual(`0x${(await row(a.id)).ih}`, I.computePurchaseIntentHash(a));
	});

	/* ---------------------------------------------------------- Uebergaenge -- */

	await t.test('P4D-FLOW build, submit and confirm each happen once; exact retries are idempotent, different values conflict', async () => {
		const o = await open();
		const c1 = hash32('c1'), c2 = hash32('c2'), tx1 = hash32(`tx1-${o.id}`), tx2 = hash32(`tx2-${o.id}`);
		const b = await H.markBuilt(client, { intent: o.intent, calldataHash: c1 });
		assert.equal(b.status, 'built');
		const r1 = await row(o.id);
		assert.equal(r1.build_deadline - r1.built_at, 120_000, 'build_deadline = built_at + 120 s');
		assert.ok(r1.build_deadline <= r1.expires_at);
		assert.equal((await H.markBuilt(client, { intent: o.intent, calldataHash: c1 })).status, 'existing');
		assert.deepEqual(await H.markBuilt(client, { intent: o.intent, calldataHash: c2 }), { status: 'conflict', code: 'CALLDATA_ALREADY_SET' });
		assert.deepEqual(await H.markSubmitted(client, { id: o.id, wallet: o.wallet, calldataHash: c2, txHash: tx1, txNonce: 1 }), { status: 'rejected', code: 'CALLDATA_MISMATCH' }, 'submit binds the stored calldata hash');
		assert.deepEqual(await H.markSubmitted(client, { id: o.id, wallet: freshWallet(), calldataHash: c1, txHash: tx1, txNonce: 1 }), { status: 'rejected', code: 'NOT_FOUND' });
		assert.equal((await H.markSubmitted(client, { id: o.id, wallet: o.wallet, calldataHash: c1, txHash: tx1, txNonce: 1 })).status, 'submitted');
		assert.equal((await H.markSubmitted(client, { id: o.id, wallet: o.wallet, calldataHash: c1, txHash: tx1, txNonce: 1 })).status, 'existing');
		assert.deepEqual(await H.markSubmitted(client, { id: o.id, wallet: o.wallet, calldataHash: c1, txHash: tx2, txNonce: 1 }), { status: 'conflict', code: 'TX_HASH_ALREADY_SET' });
		assert.deepEqual(await H.markBuilt(client, { intent: o.intent, calldataHash: c1 }), { status: 'conflict', code: 'NOT_OPEN' }, 'no second build');
		const cover = nextCover();
		assert.deepEqual(await H.markConfirmed(client, { id: o.id, txHash: tx2, coverId: cover }), { status: 'rejected', code: 'TX_HASH_MISMATCH' });
		assert.equal((await H.markConfirmed(client, { id: o.id, txHash: tx1, coverId: cover })).status, 'confirmed');
		assert.equal((await H.markConfirmed(client, { id: o.id, txHash: tx1, coverId: cover })).status, 'existing');
		assert.deepEqual(await H.markConfirmed(client, { id: o.id, txHash: tx1, coverId: nextCover() }), { status: 'conflict', code: 'COVER_ID_MISMATCH' });
		const final = await row(o.id);
		assert.deepEqual([final.status, final.ch, final.tx_hash, Number(final.tx_nonce), Number(final.cover_id), final.late], ['CONFIRMED', c1.slice(2), tx1, 1, cover, false]);
	});

	await t.test('P4D-UNIQUE a tx hash and a cover id belong to one intent only', async () => {
		const a = await submitted(), b = await built();
		assert.deepEqual(await H.markSubmitted(client, { id: b.id, wallet: b.wallet, calldataHash: b.calldataHash, txHash: a.txHash, txNonce: 3 }), { status: 'conflict', code: 'TX_HASH_TAKEN' });
		const cover = nextCover();
		assert.equal((await H.markConfirmed(client, { id: a.id, txHash: a.txHash, coverId: cover })).status, 'confirmed');
		const c = await submitted();
		assert.deepEqual(await H.markConfirmed(client, { id: c.id, txHash: c.txHash, coverId: cover }), { status: 'conflict', code: 'COVER_ID_TAKEN' });
	});

	await t.test('P4D-LATE FAILED keeps the transaction evidence; only the same transaction can confirm late, once', async () => {
		const o = await submitted();
		assert.equal((await H.markFailed(client, { id: o.id, txHash: o.txHash, reason: 'TX_DROPPED' })).status, 'failed');
		const f = await row(o.id);
		assert.deepEqual([f.status, f.status_reason, f.tx_hash, Number(f.tx_nonce), `0x${f.ch}`], ['FAILED', 'TX_DROPPED', o.txHash, 7, o.calldataHash]);
		assert.equal((await H.markFailed(client, { id: o.id, txHash: o.txHash, reason: 'TX_DROPPED' })).status, 'existing');
		assert.deepEqual(await H.markConfirmed(client, { id: o.id, txHash: o.txHash, coverId: nextCover() }), { status: 'conflict', code: 'NOT_SUBMITTED' }, 'normal confirmation does not reopen FAILED');
		assert.deepEqual(await H.markLateConfirmed(client, { id: o.id, txHash: hash32('other-tx'), calldataHash: o.calldataHash, coverId: nextCover() }), { status: 'rejected', code: 'TX_HASH_MISMATCH' });
		assert.deepEqual(await H.markLateConfirmed(client, { id: o.id, txHash: o.txHash, calldataHash: hash32('other-calldata'), coverId: nextCover() }), { status: 'rejected', code: 'CALLDATA_MISMATCH' });
		const cover = nextCover();
		assert.equal((await H.markLateConfirmed(client, { id: o.id, txHash: o.txHash, calldataHash: o.calldataHash, coverId: cover })).status, 'confirmed');
		const l = await row(o.id);
		assert.deepEqual([l.status, l.late, l.status_reason, Number(l.cover_id), l.tx_hash], ['CONFIRMED', true, 'LATE_CONFIRMATION', cover, o.txHash]);
		assert.equal((await H.markLateConfirmed(client, { id: o.id, txHash: o.txHash, calldataHash: o.calldataHash, coverId: cover })).status, 'existing');
		assert.deepEqual(await H.markLateConfirmed(client, { id: o.id, txHash: o.txHash, calldataHash: o.calldataHash, coverId: nextCover() }), { status: 'conflict', code: 'NOT_FAILED' });
	});

	await t.test('P4D-LATE expired, cancelled and confirmed intents are never reopened', async () => {
		const cancelled = await built();
		assert.equal((await H.cancelIntent(client, { id: cancelled.id, wallet: cancelled.wallet })).status, 'cancelled');
		const c = await row(cancelled.id);
		assert.deepEqual([c.status, c.status_reason, `0x${c.ch}`, c.built_at !== null], ['CANCELLED', 'USER_CANCELLED', cancelled.calldataHash, true], 'cancel keeps the build evidence');
		for (const r of [
			await H.markLateConfirmed(client, { id: cancelled.id, txHash: hash32('x'), calldataHash: cancelled.calldataHash, coverId: nextCover() }),
			await H.markSubmitted(client, { id: cancelled.id, wallet: cancelled.wallet, calldataHash: cancelled.calldataHash, txHash: hash32(`late-${cancelled.id}`), txNonce: 1 }),
			await H.markConfirmed(client, { id: cancelled.id, txHash: hash32('x'), coverId: nextCover() })
		]) assert.ok(!['confirmed', 'submitted', 'existing'].includes(r.status), JSON.stringify(r));
		assert.equal((await row(cancelled.id)).status, 'CANCELLED');
		const done = await submitted();
		assert.deepEqual(await H.cancelIntent(client, { id: done.id, wallet: done.wallet }), { status: 'conflict', code: 'NOT_CANCELLABLE' }, 'SUBMITTED is never cancelled');
		assert.deepEqual(await H.expireIntent(client, { id: done.id }), { status: 'conflict', code: 'NOT_EXPIRABLE' }, 'SUBMITTED never expires');
		// direkt am Helfer vorbei: der Trigger laesst keinen verbotenen Uebergang zu
		const illegal = [
			[`update public.cover_purchase_intents set status = 'OPEN' where id = $1`, cancelled.id],
			[`update public.cover_purchase_intents set status = 'EXPIRED', status_reason = 'INTENT_EXPIRED' where id = $1`, done.id],
			[`update public.cover_purchase_intents set status = 'CONFIRMED', cover_id = 777 where id = $1`, cancelled.id]
		];
		for (const [statement, id] of illegal) assert.notEqual(await sqlState(statement, [id]), 'OK', statement);
		const failed = await submitted();
		await H.markFailed(client, { id: failed.id, txHash: failed.txHash, reason: 'TX_REVERTED' });
		assert.match(await sqlError(`update public.cover_purchase_intents set status = 'CONFIRMED', cover_id = 778, status_reason = null where id = $1`, [failed.id]), /illegal transition FAILED -> CONFIRMED/, 'FAILED -> CONFIRMED only with late');
		const reopen = await open();
		await H.cancelIntent(client, { id: reopen.id, wallet: reopen.wallet });
		assert.match(await sqlError(`update public.cover_purchase_intents set status = 'OPEN', status_reason = null where id = $1`, [reopen.id]), /illegal transition CANCELLED -> OPEN/, 'a terminal intent is never reopened');
		const fresh = await open();
		assert.match(await sqlError(`update public.cover_purchase_intents set status = 'SUBMITTED', calldata_hash = $2, built_at = now(), build_deadline = now() + interval '60 seconds', tx_hash = $3, tx_nonce = 1 where id = $1`, [fresh.id, Buffer.alloc(32, 1), hash32(`skip-${fresh.id}`)]), /illegal transition OPEN -> SUBMITTED/);
	});

	/* ---------------------------------------------------------- Unveraenderlich -- */

	await t.test('P4D-IMMUTABLE every security-critical field and every once-set value is fixed after it is written', async () => {
		const o = await submitted();
		const attempts = {
			wallet: `wallet = '${freshWallet()}'`, product_id: 'product_id = 98', amount_raw: 'amount_raw = 2000000000', period_days: 'period_days = 31',
			quote_premium_raw: 'quote_premium_raw = 1', max_premium_raw: 'max_premium_raw = 9999999', terms_hash: `terms_hash = '\\x${'11'.repeat(32)}'::bytea`,
			proof_of_loss_cid: `proof_of_loss_cid = 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY'`, commission_ratio: 'commission_ratio = 1', commission_destination: `commission_destination = '0x00000000000000000000000000000000000000ff'`,
			pin_version: `pin_version = 'nexus-pin-2:x'`, intent_hash: `intent_hash = '\\x${'22'.repeat(32)}'::bytea`, expires_at: `expires_at = expires_at + interval '1 minute'`,
			client_request_id: `client_request_id = '${crypto.randomUUID()}'`, acknowledged_at: `acknowledged_at = acknowledged_at - interval '1 second'`, created_at: `created_at = created_at - interval '1 second'`,
			calldata_hash: `calldata_hash = '\\x${'33'.repeat(32)}'::bytea`, built_at: 'built_at = built_at - interval \'1 second\'', tx_hash: `tx_hash = '${hash32('other')}'`, tx_nonce: 'tx_nonce = 8',
			terms_version: `terms_version = 'coverraccoon.terms/2'`, chain_id: 'chain_id = 10', cover_asset_id: 'cover_asset_id = 0'
		};
		for (const [field, set] of Object.entries(attempts)) {
			const message = await sqlError(`update public.cover_purchase_intents set ${set} where id = $1`, [o.id]);
			assert.match(message, new RegExp(`${field} is (immutable|set once)`), `${field}: ${message}`);
		}
		// unveraenderte Werte erneut zu schreiben ist erlaubt (no-op); Commission bleibt 0
		assert.equal((await row(o.id)).amount_raw, '1000000000');
		assert.match(await sqlError(`update public.cover_purchase_intents set calldata_hash = null where id = $1`, [o.id]), /calldata_hash is set once/, 'never cleared');
		assert.match(await sqlError(`update public.cover_purchase_intents set tx_hash = null, tx_nonce = null where id = $1`, [o.id]), /tx_hash is set once/);
		const cover = nextCover();
		await H.markConfirmed(client, { id: o.id, txHash: o.txHash, coverId: cover });
		assert.match(await sqlError(`update public.cover_purchase_intents set cover_id = $2 where id = $1`, [o.id, nextCover()]), /cover_id is set once/);
		const l = await submitted();
		await H.markFailed(client, { id: l.id, txHash: l.txHash, reason: 'TX_REVERTED' });
		await H.markLateConfirmed(client, { id: l.id, txHash: l.txHash, calldataHash: l.calldataHash, coverId: nextCover() });
		assert.match(await sqlError(`update public.cover_purchase_intents set late = false where id = $1`, [l.id]), /late is never cleared/);
	});

	/* -------------------------------------------------------------- Ablauf -- */

	// Grenzen in EINER Transaktion: now() ist dort fest, die Zeile wird relativ dazu angelegt.
	async function atBoundary(fields, call) {
		await sql.query('begin');
		try {
			const id = crypto.randomUUID();
			const wallet = freshWallet();
			await sql.query(`insert into public.cover_purchase_intents (id, wallet, chain_id, deployment_key, product_id, product_type_id, cover_asset_id, amount_raw, period_days, quote_premium_raw, max_premium_raw,
				quote_fetched_at, capacity_fetched_at, wording_cid, annex_cid, terms_version, terms_hash, proof_of_loss_cid, commission_ratio, commission_destination, pin_version, intent_hash,
				acknowledged_at, expires_at, status, calldata_hash, built_at, build_deadline, client_request_id, created_at, updated_at)
				values ($1, $2, 1, 'aave-v3-ethereum-core', 97, 0, 6, 1000000000, 30, 3000578, 3030584, now() - interval '5 minutes 10 seconds', now() - interval '5 minutes 10 seconds',
				'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY', null, 'coverraccoon.terms/1', $3, null, 0, '0x0000000000000000000000000000000000000000', 'nexus-pin-1:broker-v2.12.1:cover-v3.3.0', $4,
				now() - interval '5 minutes', ${fields.expires}, '${fields.status}', ${fields.status === 'BUILT' ? `$5, now() - interval '60 seconds', ${fields.deadline}` : 'null, null, null'}, gen_random_uuid(), now() - interval '5 minutes', now())`,
			[id, wallet, Buffer.from(hash32('t').slice(2), 'hex'), Buffer.from(hash32(id).slice(2), 'hex'), ...(fields.status === 'BUILT' ? [Buffer.from(hash32(`c-${id}`).slice(2), 'hex')] : [])]);
			return (await sql.query(call.statement, call.params({ id, wallet, intentHash: hash32(id), calldataHash: hash32(`c-${id}`) }))).rows[0].v;
		} finally {
			await sql.query('rollback');
		}
	}
	const build = { statement: 'select public.mark_cover_purchase_intent_built(p_id => $1, p_wallet => $2, p_intent_hash => $3, p_calldata_hash => $4) as v', params: (x) => [x.id, x.wallet, x.intentHash, hash32('new-calldata')] };
	const submit = { statement: 'select public.mark_cover_purchase_intent_submitted(p_id => $1, p_wallet => $2, p_calldata_hash => $3, p_tx_hash => $4, p_tx_nonce => 0) as v', params: (x) => [x.id, x.wallet, x.calldataHash, hash32(`tx-${x.id}`)] };

	await t.test('P4D-EXPIRY usable only while now() < expires_at and now() < build_deadline (both bounds exclusive)', async () => {
		assert.deepEqual(await atBoundary({ status: 'OPEN', expires: 'now()' }, build), { status: 'rejected', code: 'EXPIRED' }, 'expires exactly now: not buildable');
		assert.equal((await atBoundary({ status: 'OPEN', expires: `now() + interval '120 seconds'` }, build)).status, 'built', 'a full 120 s build window left: buildable');
		assert.deepEqual(await atBoundary({ status: 'OPEN', expires: `now() + interval '119.999999 seconds'` }, build), { status: 'rejected', code: 'BUILD_WINDOW_TOO_SHORT' }, 'the build window never extends past expiry');
		assert.deepEqual(await atBoundary({ status: 'BUILT', expires: `now() + interval '5 minutes'`, deadline: 'now()' }, submit), { status: 'rejected', code: 'BUILD_DEADLINE_PASSED' }, 'deadline exactly now: not submittable');
		assert.equal((await atBoundary({ status: 'BUILT', expires: `now() + interval '5 minutes'`, deadline: `now() + interval '1 microsecond'` }, submit)).status, 'submitted');
		assert.deepEqual(await atBoundary({ status: 'BUILT', expires: 'now()', deadline: 'now()' }, submit), { status: 'rejected', code: 'EXPIRED' });
	});

	await t.test('P4D-EXPIRY no cleanup needed: a stale active intent is expired when its wallet creates a new one; SUBMITTED stays observable', async () => {
		const wallet = freshWallet();
		await sql.query(`insert into public.cover_purchase_intents (id, wallet, chain_id, deployment_key, product_id, product_type_id, cover_asset_id, amount_raw, period_days, quote_premium_raw, max_premium_raw,
			quote_fetched_at, capacity_fetched_at, wording_cid, terms_version, terms_hash, commission_ratio, commission_destination, pin_version, intent_hash, acknowledged_at, expires_at, client_request_id, created_at, updated_at)
			values ($1, $2, 1, 'aave-v3-ethereum-core', 97, 0, 6, 1, 30, 1, 1, now() - interval '20 minutes', now() - interval '20 minutes', 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY', 'coverraccoon.terms/1', $3, 0,
			'0x0000000000000000000000000000000000000000', 'nexus-pin-1:broker-v2.12.1:cover-v3.3.0', $4, now() - interval '20 minutes', now() - interval '6 minutes', gen_random_uuid(), now() - interval '20 minutes', now())`,
		[crypto.randomUUID(), wallet, Buffer.alloc(32, 5), Buffer.alloc(32, 6)]);
		const fresh = intentFor(wallet);
		assert.equal((await H.createIntent(client, { intent: fresh, clientRequestId: crypto.randomUUID() })).status, 'created');
		assert.deepEqual((await sql.query(`select status, status_reason from public.cover_purchase_intents where wallet = $1 order by created_at`, [wallet])).rows, [{ status: 'EXPIRED', status_reason: 'INTENT_EXPIRED' }, { status: 'OPEN', status_reason: null }]);
		const o = await open();
		assert.deepEqual(await H.expireIntent(client, { id: o.id }), { status: 'rejected', code: 'NOT_EXPIRED' });
	});

	/* ------------------------------------------------------- Rechte, kein DELETE -- */

	const asRole = async (role, statement) => { await sql.query('begin'); try { await sql.query(`set local role ${role}`); await sql.query(statement); return 'OK'; } catch (e) { return e.code ?? e.message; } finally { await sql.query('rollback'); } };
	const fns = async () => (await sql.query(`select p.oid, p.proname, p.prosecdef, p.prosrc, p.proconfig, p.oid::regprocedure::text as sig, p.proargtypes::regtype[]::text[] as argtypes from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like '%cover_purchase_intent%')`)).rows;
	const nullArgs = (fn) => fn.argtypes.map((x) => `null::${x}`).join(', ');

	await t.test('P4D-RLS anon and authenticated have no direct access; service_role only reads the table and calls the eight functions', async () => {
		assert.equal((await sql.query(`select relrowsecurity from pg_class where oid = 'public.cover_purchase_intents'::regclass`)).rows[0].relrowsecurity, true);
		for (const role of ['anon', 'authenticated']) {
			for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) assert.equal((await sql.query(`select has_table_privilege($1, 'public.cover_purchase_intents', $2) as x`, [role, p])).rows[0].x, false, `${role} ${p}`);
			assert.equal(await asRole(role, 'select * from public.cover_purchase_intents'), '42501');
			assert.equal(await asRole(role, 'insert into public.cover_purchase_intents default values'), '42501');
			assert.equal(await asRole(role, `update public.cover_purchase_intents set status = 'CANCELLED'`), '42501');
			assert.equal(await asRole(role, 'delete from public.cover_purchase_intents'), '42501');
			for (const fn of await fns()) assert.equal(await asRole(role, `select public.${fn.proname}(${nullArgs(fn)})`), '42501', `${role} ${fn.sig}`);
		}
		assert.equal(await asRole('service_role', 'select count(*) from public.cover_purchase_intents'), 'OK');
		for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) assert.equal((await sql.query(`select has_table_privilege('service_role', 'public.cover_purchase_intents', $1) as x`, [p])).rows[0].x, false, `service_role ${p}`);
		assert.equal(await asRole('service_role', `update public.cover_purchase_intents set status = 'CANCELLED'`), '42501');
		assert.equal(await asRole('service_role', 'delete from public.cover_purchase_intents'), '42501');
		const callable = [];
		for (const fn of await fns()) if ((await sql.query(`select has_function_privilege('service_role', $1::oid, 'EXECUTE') as x`, [fn.oid])).rows[0].x) callable.push(fn.proname);
		assert.deepEqual(callable.sort(), [...FUNCTIONS].sort());
		for (const helper of INTERNAL) { const fn = (await fns()).find((f) => f.proname === helper); assert.equal(await asRole('service_role', `select public.${helper}(${nullArgs(fn)})`), '42501', helper); }
	});

	await t.test('P4D-DEFINER the writing functions are SECURITY DEFINER with a pinned search_path and no dynamic SQL; no delete path exists', async () => {
		const all = await fns();
		assert.deepEqual(all.map((f) => f.proname).sort(), [...FUNCTIONS, ...INTERNAL].sort(), 'no further function on the table (no delete helper)');
		assert.deepEqual(all.filter((f) => f.prosecdef).map((f) => f.proname).sort(), [...FUNCTIONS].sort());
		for (const fn of all) {
			assert.ok((fn.proconfig ?? []).includes('search_path=public, pg_temp'), `${fn.proname} pins search_path`);
			assert.doesNotMatch(fn.prosrc, /\bexecute\b|format\s*\(|\bdelete\s+from\b|\btruncate\b/i, `${fn.proname}: no dynamic SQL, no delete`);
		}
		const o = await open();
		assert.match(await sqlError('delete from public.cover_purchase_intents where id = $1', [o.id]), /rows are never deleted/, 'even the owner cannot delete');
		assert.ok(await row(o.id));
		const triggers = (await sql.query(`select tgname, tgtype from pg_trigger where tgrelid = 'public.cover_purchase_intents'::regclass and not tgisinternal`)).rows;
		assert.deepEqual(triggers.map((x) => x.tgname), ['cover_purchase_intents_guard']);
	});

	await t.test('P4D-STATE status reasons are fixed codes; free text is refused', async () => {
		const o = await open();
		assert.deepEqual(await H.cancelIntent(client, { id: o.id, wallet: o.wallet, reason: 'USER_CANCELLED' }).then((r) => r.status), 'cancelled');
		await assert.rejects(H.cancelIntent(client, { id: o.id, wallet: o.wallet, reason: 'because I said so' }), /REASON/);
		const r = await sql.query(`select public.mark_cover_purchase_intent_failed(p_id => $1, p_tx_hash => $2, p_reason => 'stack trace: Error at x') as v`, [o.id, hash32('t')]);
		assert.deepEqual(r.rows[0].v, { status: 'rejected', code: 'REASON' });
		assert.notEqual(await sqlState(`update public.cover_purchase_intents set status_reason = 'free text' where id = $1`, [o.id]), 'OK');
		assert.equal(TEST_CID.length, 46);
	});
});

/* ------------------------------------------- statisch, ohne Postgres -- */

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const walk = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).flatMap((n) => (n === 'node_modules' || n === 'dist' || n.startsWith('.') ? [] : statSync(new URL(`../${dir}/${n}`, import.meta.url)).isDirectory() ? walk(`${dir}/${n}`) : /\.(m?js|cjs|ts|tsx|jsx|html|svelte|vue)$/.test(n) ? [`${dir}/${n}`] : []));
const P4D_FILES = ['src/purchase-intent-db.mjs', 'supabase/migrations/20261019120000_cover_purchase_intents.sql', 'test-support/purchase-intent-pg.mjs'];

test('P4D-IMPORT no runtime code imports the purchase-intent DB helper; only the P4D tests do', () => {
	const runtime = [...walk('src'), ...walk('api'), ...walk('web'), ...walk('scripts')].filter((f) => f !== 'src/purchase-intent-db.mjs');
	assert.ok(runtime.includes('src/bot.mjs') && runtime.includes('src/db.mjs') && runtime.some((f) => f.startsWith('api/')) && runtime.some((f) => f.startsWith('web/src/')));
	for (const file of runtime) assert.doesNotMatch(read(file), /purchase-intent-db(\.mjs)?['"`]|cover_purchase_intent/, file);
	const importing = /(?:from\s*|import\s*\(\s*)['"`][^'"`]*purchase-intent-db\.mjs/;
	assert.deepEqual([...walk('src'), ...walk('test'), ...walk('test-support')].filter((f) => importing.test(read(f))).sort(), ['test/purchase-confirmation-db.test.mjs', 'test/purchase-intent-db-concurrency.test.mjs', 'test/purchase-intent-db.test.mjs']);
});

test('P4D-NOROUTE there is no purchase route, page or wallet call for intents', () => {
	const routes = walk('api');
	assert.ok(routes.length > 0);
	assert.deepEqual(routes.filter((f) => /purchase|buy|intent/i.test(f)), []);
	const vercel = JSON.parse(read('vercel.json'));
	assert.doesNotMatch(JSON.stringify(vercel), /purchase|buy|intent/i);
	for (const file of [...walk('web/src'), 'web/index.html']) assert.doesNotMatch(read(file), /cover_purchase_intent|purchase-intent|\/api\/(purchase|nexus\/buy)/i, file);
});

test('P4D-NOEXEC the P4D persistence code contains no transaction execution, wallet, network or generic write path', () => {
	for (const file of P4D_FILES) {
		const text = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--).*$/gm, '');
		assert.doesNotMatch(text, /eth_sendTransaction|eth_sendRawTransaction|wallet_sendCalls|sendTransaction|writeContract|signTransaction|WalletConnect|walletconnect|safe-global|execTransaction|encodeFunctionData|buyCover|\.approve\(|fetch\(|https?:\/\//, file);
	}
	const helper = read('src/purchase-intent-db.mjs');
	assert.deepEqual([...helper.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)].map((m) => m[1]).sort(), ['CANCEL_REASONS', 'FAILURE_REASONS', 'TERMS_VERSION', 'cancelIntent', 'createIntent', 'expireIntent', 'markBuilt', 'markConfirmed', 'markFailed', 'markLateConfirmed', 'markSubmitted']);
	assert.doesNotMatch(helper, /updateIntent|executeSql|genericRpc|\.from\(|\.query\(|process\.env/);
	assert.deepEqual([...helper.matchAll(/call\(client, '([a-z_]+)'/g)].map((m) => m[1]).sort(), [...FUNCTIONS].sort(), 'each helper calls exactly one fixed function');
	// einzig erlaubt: `grant execute on function ... to service_role`; kein EXECUTE als dynamisches SQL, kein Schreibrecht auf die Tabelle
	const migration = read('supabase/migrations/20261019120000_cover_purchase_intents.sql');
	assert.doesNotMatch(migration.replace(/^grant execute on function public\.[a-z_]+\([^)]*\) to service_role;$/gm, '').replace(/^for each row execute function public\.cover_purchase_intents_guard\(\);$/m, ''), /\bexecute\b|grant\s+(insert|update|delete|truncate|all)/i);
	assert.equal(migration.match(/^grant execute on function public\.[a-z_]+\([^)]*\) to service_role;$/gm).length, FUNCTIONS.length);
});

test('P4D-TERMS the stored terms version is the P4B terms binding', () => {
	// gelesen, nicht importiert: P4B-IMPORT erlaubt den Import nur den P4B-Tests
	const terms = read('src/purchase-terms.mjs');
	const domain = terms.match(/^export const TERMS_DOMAIN = '([^']+)';$/m)[1], version = terms.match(/^export const TERMS_HASH_VERSION = (\d+);$/m)[1];
	assert.equal(H.TERMS_VERSION, `${domain}/${version}`);
});
