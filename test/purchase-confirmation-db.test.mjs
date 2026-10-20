/**
 * Nexus P4G (20.10.2026): Bestaetigungs-Orchestrierung gegen die ECHTE P4D-Datenbank und den ECHTEN
 * P4E-Pruefer (src/purchase-confirmation.mjs). Die Kette ist die KONSTRUIERTE aus
 * test-support/purchase-receipt-world.mjs (SYNTHETISCH, kein Mainnet-Beleg).
 *
 * Nur gegen einen lokalen Wegwerf-Postgres:
 *   M1_DB_TEST_PG_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *   M1_DB_TEST_PG_MODULE=/pfad/zu/node_modules/pg/lib/index.js \
 *   node --test test/purchase-confirmation-db.test.mjs
 * Ohne diese Variablen wird der Test uebersprungen (scripts/skip-policy.mjs, exakt mit Datei und Name).
 *
 * Belegt: VERIFIED -> genau eine P4D-Bestaetigung (SUBMITTED -> CONFIRMED) mit der Cover-ID des Pruefers,
 * erneuter Aufruf ohne Schreiboperation; TX_FAILED, zu wenige Bestaetigungen und eine fremde
 * Transaktion veraendern die Zeile nicht; eine schon vergebene Cover-ID scheitert an der
 * P4D-Eindeutigkeit (DB_CONFIRMATION_CONFLICT), die Zeile bleibt SUBMITTED.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openPurchaseDb, rpcOn, intentFor, freshWallet } from '../test-support/purchase-intent-pg.mjs';
const G = await import('../src/purchase-confirmation.mjs');
const D = await import('../src/purchase-intent-db.mjs');
const I = await import('../src/purchase-intent.mjs');
const W = await import('../test-support/purchase-receipt-world.mjs');

const { WALLET, TX_HASH, COVER_ID, BLOCK } = W;

function readers(edit = () => {}, { world = {} } = {}) {
	const a = W.world(world);
	edit(a);
	const b = structuredClone(a);
	return { rpcA: W.reader(a), rpcB: W.reader(b) };
}


const skip = !process.env.M1_DB_TEST_PG_URL || !process.env.M1_DB_TEST_PG_MODULE ? 'M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE nicht gesetzt (Wegwerf-Postgres noetig)' : false;

test('PURCHASE-CONFIRMATION-DB', { skip, timeout: 600_000 }, async (t) => {
	const { sql, close } = await openPurchaseDb('p4g_confirmation');
	t.after(close);
	const client = rpcOn(sql);
	const hex = (b) => (b === null ? null : `0x${Buffer.from(b).toString('hex')}`);
	const secs = (d) => Math.floor(new Date(d).getTime() / 1000);
	/** NUR TEST: rekonstruiert den gespeicherten P4A-Intent aus der Zeile (ein spaeterer Laufzeit-Lader braucht eine feste Lesefunktion). */
	const loadIntentById = async (id) => {
		const { rows } = await sql.query('select * from public.cover_purchase_intents where id = $1', [id]);
		if (!rows.length) return null;
		const r = rows[0];
		return {
			id: r.id, status: r.status, late: r.late, intentHash: hex(r.intent_hash), calldataHash: hex(r.calldata_hash), txHash: r.tx_hash, coverId: r.cover_id,
			intent: {
				id: r.id, wallet: r.wallet, chainId: r.chain_id, deploymentKey: r.deployment_key, productId: r.product_id, productTypeId: r.product_type_id, coverAssetId: r.cover_asset_id,
				amountRaw: String(r.amount_raw), periodDays: r.period_days, quotePremiumRaw: String(r.quote_premium_raw), maxPremiumRaw: String(r.max_premium_raw),
				quoteFetchedAt: secs(r.quote_fetched_at), capacityFetchedAt: secs(r.capacity_fetched_at), wordingCid: r.wording_cid, annexCid: r.annex_cid, termsHash: hex(r.terms_hash),
				proofOfLossCid: r.proof_of_loss_cid, commissionRatio: r.commission_ratio, commissionDestination: r.commission_destination, pinVersion: r.pin_version,
				acknowledgedAt: secs(r.acknowledged_at), expiresAt: secs(r.expires_at)
			}
		};
	};
	const repo = { loadIntentById, markConfirmed: (args) => D.markConfirmed(client, args) };
	const snapshot = async (id) => (await sql.query('select status, cover_id, tx_hash, late, updated_at from public.cover_purchase_intents where id = $1', [id])).rows[0];
	const submit = async (wallet, txHash) => {
		const intent = intentFor(wallet);
		assert.equal((await D.createIntent(client, { intent, clientRequestId: randomUUID() })).status, 'created');
		assert.equal((await D.markBuilt(client, { intent, calldataHash: W.calldataHashFor(wallet) })).status, 'built');
		assert.equal((await D.markSubmitted(client, { id: intent.id, wallet, calldataHash: W.calldataHashFor(wallet), txHash, txNonce: 4 })).status, 'submitted');
		return intent.id;
	};
	const run = (intentId, worldOpts = {}, edit = () => {}) => {
		const rpc = readers(edit, { world: worldOpts });
		return G.confirmVerifiedPurchase({ repository: repo, rpcA: rpc.rpcA, rpcB: rpc.rpcB, intentId });
	};

	// positiv: echte Zeile, echter Pruefer, echte P4D-Funktion
	const a = await submit(WALLET, TX_HASH);
	const loaded = await loadIntentById(a);
	assert.equal(loaded.intentHash, I.computePurchaseIntentHash(loaded.intent), 'the reconstructed intent hashes to the stored intent_hash');
	const ok = await run(a);
	assert.equal(ok.status, 'CONFIRMED', JSON.stringify(ok));
	assert.equal(ok.dbWrite, 'CONFIRMED');
	const done = await snapshot(a);
	assert.equal(done.status, 'CONFIRMED');
	assert.equal(String(done.cover_id), '7001');
	assert.equal(done.tx_hash, TX_HASH);
	assert.equal(done.late, false);
	const again = await run(a);
	assert.equal(again.status, 'ALREADY_CONFIRMED');
	assert.deepEqual(await snapshot(a), done, 'idempotent: row untouched');

	// negativ: TX_FAILED, zu wenige Bestaetigungen, fremde Transaktion -> Zeile unveraendert
	const wb = freshWallet(), txB = W.txHashFor('db-B');
	const b = await submit(wb, txB);
	const before = await snapshot(b);
	for (const [label, edit, world] of [
		['TX_FAILED', (w) => { w.receipt.status = '0x0'; }, { buyer: wb, txHash: txB, coverId: 7002n }],
		['INSUFFICIENT_CONFIRMATIONS', (w) => { w.head = BLOCK + 5n; }, { buyer: wb, txHash: txB, coverId: 7002n }],
		['WRONG_SENDER', () => {}, { buyer: WALLET, txHash: txB, coverId: 7002n }]
	]) {
		const r = await run(b, world, edit);
		assert.equal(r.verifier.status, label);
		assert.notEqual(r.status, 'CONFIRMED');
		assert.deepEqual(await snapshot(b), before, `${label}: zero DB mutation`);
	}
	// dieselbe Cover-ID wie A: P4E bestaetigt die (konstruierte) Kette, P4D verweigert -> Konflikt, Zeile unveraendert
	const conflict = await run(b, { buyer: wb, txHash: txB, coverId: COVER_ID });
	assert.equal(conflict.status, 'DB_CONFIRMATION_CONFLICT');
	assert.deepEqual([...conflict.errors], ['DB:conflict:COVER_ID_TAKEN']);
	assert.deepEqual(await snapshot(b), before);
	// A's tx_hash kann B gar nicht tragen (P4D-Eindeutigkeit von tx_hash)
	assert.equal((await sql.query('select count(*)::int as n from public.cover_purchase_intents where tx_hash = $1', [TX_HASH])).rows[0].n, 1);
	// eigene Cover-ID: bestaetigt
	const okB = await run(b, { buyer: wb, txHash: txB, coverId: 7002n });
	assert.equal(okB.status, 'CONFIRMED');
	assert.equal(String((await snapshot(b)).cover_id), '7002');
});
