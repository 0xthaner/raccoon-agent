/**
 * Nexus P4G (20.10.2026): Bestaetigung nur nach unabhaengiger Beleg-Pruefung (src/purchase-confirmation.mjs).
 *
 * Kein Test ersetzt den P4E-Pruefer durch eine Attrappe: jede Orchestrierung laeuft gegen den
 * ECHTEN verifyPurchaseReceipt ueber die KONSTRUIERTE Kette aus test-support/purchase-receipt-world.mjs
 * (SYNTHETISCH, kein Mainnet-Beleg). Ergebnisse von P4E werden nur ueber die Kette gesteuert.
 * Das Tor selbst (confirmableCoverId) wird zusaetzlich mit absichtlich widerspruechlichen
 * Ergebnissen geprueft, die P4E nie liefert.
 *
 * Das Repository ist eine Attrappe, die die P4D-Uebergaenge nachbildet und jeden Aufruf
 * protokolliert; gegen die echte P4D-Datenbank laeuft test/purchase-confirmation-db.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { keccak256, toHex } from 'viem';
const G = await import('../src/purchase-confirmation.mjs');
const R = await import('../src/purchase-receipt.mjs');
const I = await import('../src/purchase-intent.mjs');
const W = await import('../test-support/purchase-receipt-world.mjs');

const { WALLET, OTHER, TX_HASH, COVER_ID, BLOCK } = W;
const ID_A = W.intent().id;
const ID_B = '5d1c2b3a-4e5f-4a6b-9c7d-8e9f0a1b2c3d';

/** Gespeicherter SUBMITTED-Datensatz, wie ein Repository ihn aus P4D liefern wuerde. */
function record(patch = {}, intentPatch = {}) {
	const intent = W.intent(intentPatch);
	return { id: intent.id, status: 'SUBMITTED', late: false, intent, intentHash: I.computePurchaseIntentHash(intent), calldataHash: W.calldataHashFor(intent.wallet), txHash: TX_HASH, coverId: null, ...patch };
}

/** Attrappe des P4D-Repositorys: genau zwei Methoden, P4D-Semantik von markConfirmed, jedes Ereignis im Protokoll. */
function repository(rows, { onConfirm } = {}) {
	const store = new Map(rows.map((r) => [r.id, structuredClone(r)]));
	const log = [];
	const json = (r) => ({ id: r.id, wallet: r.intent.wallet, status: r.status, tx_hash: r.txHash, cover_id: r.coverId === null ? null : Number(r.coverId), late: r.late });
	const repo = {
		async loadIntentById(id) { log.push(['load', id]); const r = store.get(id); return r ? structuredClone(r) : null; },
		async markConfirmed(args) {
			log.push(['markConfirmed', structuredClone(args)]);
			if (onConfirm) return onConfirm(args, store);
			const r = store.get(args.id);
			if (!r) return { status: 'rejected', code: 'NOT_FOUND' };
			if ([...store.values()].some((o) => o.id !== r.id && o.coverId !== null && String(o.coverId) === String(args.coverId))) return { status: 'conflict', code: 'COVER_ID_TAKEN' };
			if (r.status === 'SUBMITTED' && r.txHash === args.txHash && r.coverId === null) { r.status = 'CONFIRMED'; r.coverId = String(args.coverId); return { status: 'confirmed', intent: json(r) }; }
			if (r.txHash !== args.txHash) return { status: 'rejected', code: 'TX_HASH_MISMATCH' };
			if (r.status === 'CONFIRMED' && String(r.coverId) === String(args.coverId)) return { status: 'existing', intent: json(r) };
			return { status: 'conflict', code: r.status === 'CONFIRMED' ? 'COVER_ID_MISMATCH' : 'NOT_SUBMITTED' };
		}
	};
	return { repo, store, log, writes: () => log.filter(([k]) => k === 'markConfirmed') };
}

/** Zwei unabhaengige Leser ueber die Welt; editB veraendert nur Leser B. */
function readers(edit = () => {}, { editB, world = {} } = {}) {
	const a = W.world(world);
	edit(a);
	const b = structuredClone(a);
	editB?.(b);
	const seen = [];
	return { rpcA: W.reader(a, seen), rpcB: W.reader(b, seen), seen };
}

async function confirm({ rows = [record()], edit, editB, world, intentId = ID_A, extra = {}, repo: given } = {}) {
	const db = given ?? repository(rows);
	const rpc = readers(edit, { editB, world });
	const r = await G.confirmVerifiedPurchase({ repository: db.repo, rpcA: rpc.rpcA, rpcB: rpc.rpcB, intentId, ...extra });
	return { r, db, seen: rpc.seen };
}

const unchanged = (db, id = ID_A) => {
	assert.deepEqual(db.writes(), [], 'no DB write');
	assert.equal(db.store.get(id).status, 'SUBMITTED');
	assert.equal(db.store.get(id).coverId, null);
};

/* ------------------------------------------------------------ positiv -- */

test('P4G-VERIFIED a real P4E VERIFIED_COVER_PURCHASE leads to exactly one markConfirmed with persisted txHash and verifier coverId', async () => {
	const { r, db, seen } = await confirm();
	assert.equal(r.status, 'CONFIRMED', JSON.stringify(r));
	assert.equal(r.ok, true);
	assert.equal(r.dbWrite, 'CONFIRMED');
	assert.equal(r.verifier.status, 'VERIFIED_COVER_PURCHASE');
	assert.equal(r.verifier.blockNumber, BLOCK.toString());
	assert.equal(r.coverId, COVER_ID.toString());
	assert.equal(r.txHash, TX_HASH);
	assert.deepEqual(db.writes(), [['markConfirmed', { id: ID_A, txHash: TX_HASH, coverId: '7001' }]]);
	assert.deepEqual(db.log[0], ['load', ID_A]);
	assert.equal(db.store.get(ID_A).status, 'CONFIRMED');
	// P4E lief wirklich: jede gelesene Methode ist eine P4E-Lesemethode, die Finalitaet wurde gefragt
	assert.ok(seen.length > 20 && seen.every((m) => R.READ_METHODS.includes(m)));
	assert.ok(seen.includes('eth_getTransactionReceipt') && seen.includes('eth_call'));
	assert.ok(Object.isFrozen(r) && Object.isFrozen(r.verifier));
});

test('P4G-FINALITY the documented P4E production policy (finalized and >= 64 confirmations) is fixed and not lowered', async () => {
	assert.deepEqual({ ...G.CONFIRMATION_POLICY }, { minConfirmations: 64, requireFinalized: true });
	assert.equal(G.CONFIRMATION_POLICY, R.PRODUCTION_CONFIRMATION_POLICY);
	assert.ok(Object.isFrozen(G.CONFIRMATION_POLICY));
	// genau 64 Bestaetigungen und finalisiert: bestaetigt
	assert.equal((await confirm({ edit: (w) => { w.head = BLOCK + 63n; w.finalized = BLOCK; } })).r.status, 'CONFIRMED');
	// 63 Bestaetigungen: nicht bestaetigt, wiederholbar
	const few = await confirm({ edit: (w) => { w.head = BLOCK + 62n; } });
	assert.equal(few.r.status, 'UNRESOLVED_RETRYABLE');
	assert.equal(few.r.verifier.status, 'INSUFFICIENT_CONFIRMATIONS');
	unchanged(few.db);
	// viele Bestaetigungen, aber nicht finalisiert: nicht bestaetigt
	const unfinal = await confirm({ edit: (w) => { w.finalized = BLOCK - 1n; } });
	assert.equal(unfinal.r.verifier.status, 'INSUFFICIENT_CONFIRMATIONS');
	assert.deepEqual([...unfinal.r.verifier.errors], ['NOT_FINALIZED']);
	unchanged(unfinal.db);
	// der Aufrufer kann die Politik nicht setzen
	for (const key of ['minConfirmations', 'requireFinalized', 'policy']) {
		const x = await confirm({ extra: { [key]: key === 'requireFinalized' ? false : 1 }, edit: (w) => { w.head = BLOCK + 2n; } });
		assert.equal(x.r.status, 'INVALID_INPUT', key);
		assert.deepEqual([...x.r.errors], [`CLIENT_FIELD:${key}`]);
	}
});

test('P4G-COVER-ID the confirmed coverId comes only from the verifier (the chain), never from the caller or the record', async () => {
	const other = 7_002n;
	const { r, db } = await confirm({ world: { coverId: other } });
	assert.equal(r.status, 'CONFIRMED');
	assert.equal(r.coverId, '7002');
	assert.deepEqual(db.writes(), [['markConfirmed', { id: ID_A, txHash: TX_HASH, coverId: '7002' }]]);
	for (const coverId of ['7001', 7001, 7001n, '7002']) {
		const x = await confirm({ extra: { coverId } });
		assert.equal(x.r.status, 'INVALID_INPUT');
		assert.deepEqual([...x.r.errors], ['CLIENT_FIELD:coverId']);
		assert.deepEqual(x.db.log, [], 'nothing loaded, nothing written');
		assert.deepEqual(x.seen, [], 'no chain read');
	}
});

test('P4G-TX-HASH the transaction verified and confirmed is the persisted tx_hash of this very row', async () => {
	const txB = W.txHashFor('B');
	const { r, db, seen } = await confirm({ rows: [record({ txHash: txB })], world: { txHash: txB } });
	assert.equal(r.status, 'CONFIRMED');
	assert.equal(r.txHash, txB);
	assert.deepEqual(db.writes(), [['markConfirmed', { id: ID_A, txHash: txB, coverId: '7001' }]]);
	assert.ok(seen.includes('eth_getTransactionByHash'));
	// gespeicherter tx_hash zeigt auf eine Transaktion, die die Kette nicht kennt: keine Bestaetigung
	const missing = await confirm({ rows: [record({ txHash: W.txHashFor('unknown') })] });
	assert.equal(missing.r.verifier.status, 'TX_NOT_FOUND');
	unchanged(missing.db);
	// fehlender oder kaputter tx_hash: keine Kette, keine Schreiboperation
	for (const txHash of [null, '0x1234', TX_HASH.toUpperCase()]) {
		const bad = await confirm({ rows: [record({ txHash })] });
		assert.equal(bad.r.status, 'PERSISTED_RECORD_INVALID', String(txHash));
		assert.ok(bad.r.errors.includes('RECORD_TX_HASH'));
		assert.deepEqual(bad.seen, []);
		assert.deepEqual(bad.db.writes(), []);
	}
});

test('P4G-CALLDATA the persisted calldata_hash is what P4E compares against keccak256(tx.input)', async () => {
	// gespeicherter Hash eines anderen Builds: P4E meldet CALLDATA_HASH_MISMATCH, nichts wird geschrieben
	const wrong = await confirm({ rows: [record({ calldataHash: keccak256(toHex('another build')) })] });
	assert.equal(wrong.r.status, 'NOT_VERIFIED');
	assert.equal(wrong.r.verifier.status, 'CALLDATA_HASH_MISMATCH');
	unchanged(wrong.db);
	// fehlender oder kaputter Hash: keine Kette
	for (const calldataHash of [null, '0xabc', W.calldataHashFor().toUpperCase()]) {
		const bad = await confirm({ rows: [record({ calldataHash })] });
		assert.equal(bad.r.status, 'PERSISTED_RECORD_INVALID');
		assert.ok(bad.r.errors.includes('RECORD_CALLDATA_HASH'));
		assert.deepEqual(bad.seen, []);
		assert.deepEqual(bad.db.writes(), []);
	}
	// ein Aufrufer-Hash, der zur Kette passen wuerde, wird trotzdem abgelehnt
	const caller = await confirm({ rows: [record({ calldataHash: keccak256(toHex('another build')) })], extra: { calldataHash: W.calldataHashFor() } });
	assert.equal(caller.r.status, 'INVALID_INPUT');
	assert.deepEqual(caller.db.log, []);
});

/* ------------------------------------------------------------- Status -- */

test('P4G-STATUS only SUBMITTED enters verification; every other persisted status is refused without chain or DB write', async () => {
	const shapes = {
		OPEN: { txHash: null, calldataHash: null }, BUILT: { txHash: null }, FAILED: {}, EXPIRED: { txHash: null }, CANCELLED: { txHash: null }
	};
	for (const [status, patch] of Object.entries(shapes)) {
		const { r, db, seen } = await confirm({ rows: [record({ status, ...patch })] });
		assert.equal(r.status, 'INVALID_STATUS', status);
		assert.deepEqual([...r.errors], [`STATUS:${status}`]);
		assert.deepEqual(seen, [], `${status}: no chain read`);
		assert.deepEqual(db.writes(), [], `${status}: no write`);
		assert.equal(db.store.get(ID_A).status, status);
	}
	// FAILED mit einer Transaktion, die die Kette als gueltigen Kauf zeigt: der normale Pfad bestaetigt NIE spaet
	const late = await confirm({ rows: [record({ status: 'FAILED' })] });
	assert.equal(late.r.status, 'INVALID_STATUS');
	// spaet bestaetigt ist kein exakter normaler Endzustand
	const lateDone = await confirm({ rows: [record({ status: 'CONFIRMED', coverId: '7001', late: true })] });
	assert.equal(lateDone.r.status, 'INVALID_STATUS');
	assert.deepEqual([...lateDone.r.errors], ['CONFIRMED_NOT_EXACT']);
	for (const status of ['READY', 'submitted', '', null]) {
		const odd = await confirm({ rows: [record({ status })] });
		assert.equal(odd.r.status, 'PERSISTED_RECORD_INVALID', String(status));
		assert.deepEqual(odd.seen, []);
	}
	// SUBMITTED mit schon gesetzter Cover-ID ist inkonsistent
	const half = await confirm({ rows: [record({ coverId: '7001' })] });
	assert.equal(half.r.status, 'PERSISTED_RECORD_INVALID');
	assert.ok(half.r.errors.includes('RECORD_NOT_PENDING'));
	assert.equal((await confirm({ rows: [] })).r.status, 'INTENT_NOT_FOUND');
});

/* -------------------------------------------------------- Aufrufer-Felder -- */

test('P4G-CLIENT only intentId identifies the record; every caller-supplied fact, receipt, log or verdict is refused before any read', async () => {
	const verified = (await confirm()).r;
	const fields = {
		txHash: TX_HASH, wallet: WALLET, calldataHash: W.calldataHashFor(), coverId: '7001', receipt: { status: '0x1', logs: [] }, logs: [], from: WALLET, to: OTHER,
		data: '0x', value: '0x0', status: 'SUBMITTED', blockHash: keccak256('0x01'), blockNumber: '0x1', verdict: verified.verifier, result: verified, verification: verified,
		intent: W.intent(), record: record(), now: 1
	};
	for (const [key, value] of Object.entries(fields)) {
		const { r, db, seen } = await confirm({ extra: { [key]: value } });
		assert.equal(r.status, 'INVALID_INPUT', key);
		assert.deepEqual([...r.errors], [`CLIENT_FIELD:${key}`], key);
		assert.deepEqual(db.log, [], `${key}: nothing loaded or written`);
		assert.deepEqual(seen, [], `${key}: no chain read`);
	}
	for (const intentId of [undefined, null, 'not-a-uuid', ID_A.toUpperCase(), 7]) {
		const db = repository([record()]);
		const rpc = readers();
		const r = await G.confirmVerifiedPurchase({ repository: db.repo, rpcA: rpc.rpcA, rpcB: rpc.rpcB, intentId });
		assert.equal(r.status, 'INVALID_INPUT', String(intentId));
		assert.ok(r.errors.includes('INTENT_ID'));
		assert.deepEqual(db.log, []);
	}
	assert.equal((await G.confirmVerifiedPurchase(null)).status, 'INVALID_INPUT');
	assert.equal((await G.confirmVerifiedPurchase([])).status, 'INVALID_INPUT');
});

test('P4G-REPOSITORY the repository is exactly loadIntentById + markConfirmed; no generic DB surface, no extra record facts', async () => {
	const base = repository([record()]);
	for (const extra of ['query', 'update', 'from', 'rpc', 'executeSql', 'markFailed', 'markLateConfirmed', 'call']) {
		const repo = { ...base.repo, [extra]: async () => { throw new Error('must not be called'); } };
		const rpc = readers();
		const r = await G.confirmVerifiedPurchase({ repository: repo, rpcA: rpc.rpcA, rpcB: rpc.rpcB, intentId: ID_A });
		assert.equal(r.status, 'INVALID_INPUT', extra);
		assert.deepEqual([...r.errors], ['REPOSITORY_NOT_NARROW']);
		assert.deepEqual(base.log, []);
	}
	for (const repo of [null, {}, { loadIntentById: base.repo.loadIntentById }, { loadIntentById: 1, markConfirmed: base.repo.markConfirmed }]) {
		const rpc = readers();
		assert.equal((await G.confirmVerifiedPurchase({ repository: repo, rpcA: rpc.rpcA, rpcB: rpc.rpcB, intentId: ID_A })).status, 'INVALID_INPUT');
	}
	// ein Datensatz mit Zusatzfeldern (z. B. Beleg oder Logs aus fremder Quelle) wird nicht verwendet
	for (const key of ['receipt', 'logs', 'blockHash', 'verdict']) {
		const { r, db, seen } = await confirm({ rows: [{ ...record(), [key]: 'x' }] });
		assert.equal(r.status, 'PERSISTED_RECORD_INVALID', key);
		assert.deepEqual([...r.errors], [`RECORD_FIELD:${key}`]);
		assert.deepEqual(seen, []);
		assert.deepEqual(db.writes(), []);
	}
	// Ladefehler: nichts geschrieben, wiederholbar
	const down = { loadIntentById: async () => { throw new Error('db down'); }, markConfirmed: async () => { throw new Error('must not be called'); } };
	const rpc = readers();
	const r = await G.confirmVerifiedPurchase({ repository: down, rpcA: rpc.rpcA, rpcB: rpc.rpcB, intentId: ID_A });
	assert.equal(r.status, 'DB_UNAVAILABLE');
	assert.equal(r.retryable, true);
	assert.deepEqual(rpc.seen, []);
});

test('P4G-RECORD the record must belong to the requested intent: id, intent id and recomputed intent hash', async () => {
	const cases = [
		[{ ...record(), id: ID_B }, 'RECORD_ID'],
		[{ ...record(), intent: W.intent({ id: ID_B }), intentHash: I.computePurchaseIntentHash(W.intent({ id: ID_B })) }, 'RECORD_INTENT_ID'],
		[{ ...record(), intentHash: keccak256('0x99') }, 'RECORD_INTENT_HASH'],
		[{ ...record(), intent: { ...W.intent(), amountRaw: '0' } }, 'RECORD_INTENT'],
		[record({}, { proofOfLossCid: null }), 'RECORD_WITHOUT_PROOF_OF_LOSS'],
		[{ ...record(), late: 'no' }, 'RECORD_LATE']
	];
	for (const [row, code] of cases) {
		const db = repository([]);
		db.store.set(ID_A, row);
		const { r, seen } = await confirm({ repo: db });
		assert.equal(r.status, 'PERSISTED_RECORD_INVALID', code);
		assert.ok(r.errors.includes(code), `${code}: ${r.errors}`);
		assert.deepEqual(seen, [], code);
		assert.deepEqual(db.writes(), [], code);
	}
});

/* ------------------------------------------------- nicht bestaetigt -- */

test('P4G-RETRYABLE infrastructure uncertainty leaves SUBMITTED unchanged and is retryable; FAILED is never written', async () => {
	const cases = {
		TEMPORARY_RPC_FAILURE: { editB: (w) => { w.fail = { eth_getTransactionReceipt: true }; } },
		RPC_DISAGREEMENT: { editB: (w) => { w.receipt.logs = w.receipt.logs.slice(1); } },
		INSUFFICIENT_CONFIRMATIONS: { edit: (w) => { w.head = BLOCK + 1n; } },
		TX_NOT_FOUND: { edit: (w) => { w.tx = null; w.receipt = null; } },
		RECEIPT_NOT_FOUND: { edit: (w) => { w.receipt = null; } },
		BLOCK_HASH_MISMATCH: { edit: (w) => { w.blocks[toHex(BLOCK)].hash = keccak256(toHex('reorged block')); } }
	};
	for (const [status, edits] of Object.entries(cases)) {
		const { r, db } = await confirm(edits);
		assert.equal(r.verifier.status, status, `${status}: ${r.verifier.errors}`);
		assert.equal(r.status, 'UNRESOLVED_RETRYABLE', status);
		assert.equal(r.retryable, true);
		assert.equal(r.ok, false);
		assert.equal(r.coverId, null);
		assert.equal(r.dbWrite, 'NONE');
		unchanged(db);
		assert.ok(G.RETRYABLE_VERIFIER_STATUSES.includes(status));
	}
	// Ausfall eines Lesers auf jeder Stufe: nie eine Bestaetigung mit nur einem Leser
	for (const method of R.READ_METHODS) {
		const { r, db } = await confirm({ editB: (w) => { w.fail = { [method]: true }; } });
		assert.equal(r.status, 'UNRESOLVED_RETRYABLE', method);
		unchanged(db);
	}
	// der Pruefer selbst wirft (unerwartet): wiederholbar, keine Schreiboperation
	const thrower = { request: async () => { throw new Error('boom'); } };
	const db = repository([record()]);
	const r = await G.confirmVerifiedPurchase({ repository: db.repo, rpcA: thrower, rpcB: { request: thrower.request }, intentId: ID_A });
	assert.equal(r.status, 'UNRESOLVED_RETRYABLE');
	unchanged(db);
});

test('P4G-NOT-VERIFIED every mismatch, failure or policy violation proven by P4E leaves SUBMITTED unchanged', async () => {
	const cases = {
		TX_FAILED: { edit: (w) => { w.receipt.status = '0x0'; } },
		WRONG_SENDER: { edit: (w) => { w.tx.from = OTHER; w.receipt.from = OTHER; } },
		RECEIPT_MISMATCH: { edit: (w) => { w.receipt.to = OTHER; } },
		CALLDATA_POLICY_MISMATCH: { rows: [record({ calldataHash: W.calldataHashFor(OTHER) })], edit: (w) => { w.tx.input = W.calldata(OTHER); } },
		COVERBOUGHT_MISSING: { edit: (w) => { w.receipt.logs = w.receipt.logs.filter((l, i) => i !== 3); } },
		POL_METADATA_MISMATCH: { edit: (w) => { w.covers[COVER_ID].metadata = 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY'; } },
		PROXY_DRIFT_AT_EXECUTION: { edit: (w) => { w.slot = `0x${'0'.repeat(24)}${'1'.repeat(40)}`; } },
		WRONG_CHAIN: { edit: (w) => { w.chainId = '0x5'; } }
	};
	for (const [status, edits] of Object.entries(cases)) {
		const { r, db } = await confirm(edits);
		assert.equal(r.verifier.status, status, `${status}: ${r.verifier.errors}`);
		assert.equal(r.verifier.ok, false);
		assert.equal(r.status, 'NOT_VERIFIED', status);
		assert.equal(r.retryable, false);
		assert.equal(r.coverId, null);
		unchanged(db);
	}
	// derselbe Leser zweimal: P4E lehnt ab, P4G bestaetigt nicht
	const db = repository([record()]);
	const one = W.reader(W.world());
	const r = await G.confirmVerifiedPurchase({ repository: db.repo, rpcA: one, rpcB: one, intentId: ID_A });
	assert.equal(r.status, 'NOT_VERIFIED');
	assert.deepEqual([...r.verifier.errors], ['RPC_NOT_INDEPENDENT']);
	unchanged(db);
});

test('P4G-GATE only ok === true AND VERIFIED_COVER_PURCHASE AND all checks AND a positive coverId may confirm', async () => {
	const intent = W.intent();
	const rpc = readers();
	const real = await R.verifyPurchaseReceipt({ rpcA: rpc.rpcA, rpcB: rpc.rpcB, intent, txHash: TX_HASH, calldataHash: W.calldataHashFor(), ...G.CONFIRMATION_POLICY });
	assert.equal(real.status, 'VERIFIED_COVER_PURCHASE');
	assert.equal(G.confirmableCoverId(real), COVER_ID);
	const checks = (patch) => ({ ...real.checks, ...patch });
	const forged = {
		'ok false, status VERIFIED': { ...real, ok: false },
		'ok true, other status': { ...real, status: 'TX_FAILED' },
		'ok "true"': { ...real, ok: 'true' },
		'status lowercase': { ...real, status: 'verified_cover_purchase' },
		'errors present': { ...real, errors: ['X'] },
		'errors missing': { ...real, errors: undefined },
		'one check not passed': { ...real, checks: checks({ tokenFlow: false }) },
		'receipt check not passed': { ...real, checks: checks({ receipt: false }) },
		'confirmations check not passed': { ...real, checks: checks({ confirmations: false }) },
		'one check missing': { ...real, checks: checks({ metadata: undefined }) },
		'checks missing': { ...real, checks: undefined },
		'coverId zero': { ...real, coverId: 0n },
		'coverId negative': { ...real, coverId: -1n },
		'coverId number': { ...real, coverId: 7001 },
		'coverId string': { ...real, coverId: '7001' },
		'no block hash': { ...real, blockHash: null },
		'no block number': { ...real, blockNumber: null }
	};
	for (const [name, verdict] of Object.entries(forged)) assert.equal(G.confirmableCoverId(verdict), null, name);
	for (const v of [null, undefined, 1, 'VERIFIED_COVER_PURCHASE', []]) assert.equal(G.confirmableCoverId(v), null);
	assert.deepEqual(R.REQUIRED_CHECKS.filter((c) => real.checks[c] !== true), []);
});

/* ------------------------------------------------------- Datenbank -- */

test('P4G-DB-CONFLICT an unexpected confirmation result fails closed as DB_CONFIRMATION_CONFLICT', async () => {
	const row = (patch = {}) => ({ id: ID_A, wallet: WALLET, status: 'CONFIRMED', tx_hash: TX_HASH, cover_id: 7001, late: false, ...patch });
	const answers = {
		'cover id taken': { status: 'conflict', code: 'COVER_ID_TAKEN' },
		'cover id mismatch': { status: 'conflict', code: 'COVER_ID_MISMATCH' },
		'not submitted': { status: 'conflict', code: 'NOT_SUBMITTED' },
		'tx hash mismatch': { status: 'rejected', code: 'TX_HASH_MISMATCH' },
		'confirmed, other cover': { status: 'confirmed', intent: row({ cover_id: 7002 }) },
		'confirmed, other tx': { status: 'confirmed', intent: row({ tx_hash: W.txHashFor('B') }) },
		'confirmed, other id': { status: 'confirmed', intent: row({ id: ID_B }) },
		'confirmed, not CONFIRMED': { status: 'confirmed', intent: row({ status: 'SUBMITTED' }) },
		'confirmed, late': { status: 'confirmed', intent: row({ late: true }) },
		'confirmed, no row': { status: 'confirmed' },
		'unknown status': { status: 'ok', intent: row() },
		'nothing': null
	};
	for (const [name, answer] of Object.entries(answers)) {
		const db = repository([record()], { onConfirm: () => answer });
		const { r } = await confirm({ repo: db });
		assert.equal(r.status, 'DB_CONFIRMATION_CONFLICT', name);
		assert.equal(r.ok, false, name);
		assert.equal(r.coverId, null, name);
		assert.equal(db.writes().length, 1);
	}
	const db = repository([record()], { onConfirm: () => { throw new Error('connection reset'); } });
	const { r } = await confirm({ repo: db });
	assert.equal(r.status, 'DB_UNAVAILABLE');
	assert.equal(r.ok, false);
	assert.equal(r.retryable, true);
});

test('P4G-IDEMPOTENT an exact existing confirmation is accepted; an exact CONFIRMED row is reported without chain or write', async () => {
	// markConfirmed meldet "existing" (paralleler Lauf hat schon bestaetigt): exakt gleich -> akzeptiert
	const db = repository([record()], { onConfirm: (args) => ({ status: 'existing', intent: { id: ID_A, wallet: WALLET, status: 'CONFIRMED', tx_hash: args.txHash, cover_id: 7001, late: false } }) });
	const { r } = await confirm({ repo: db });
	assert.equal(r.status, 'CONFIRMED');
	assert.equal(r.dbWrite, 'EXISTING');
	// zweiter Aufruf nach echter Bestaetigung: aus dem Datensatz, ohne Kette, ohne Schreiboperation
	const first = await confirm();
	assert.equal(first.r.status, 'CONFIRMED');
	const rpc = readers();
	const again = await G.confirmVerifiedPurchase({ repository: first.db.repo, rpcA: rpc.rpcA, rpcB: rpc.rpcB, intentId: ID_A });
	assert.equal(again.status, 'ALREADY_CONFIRMED');
	assert.equal(again.ok, true);
	assert.equal(again.coverId, '7001');
	assert.equal(again.txHash, TX_HASH);
	assert.equal(again.dbWrite, 'NONE');
	assert.equal(again.verifier, null);
	assert.deepEqual(rpc.seen, []);
	assert.equal(first.db.writes().length, 1);
	// CONFIRMED ohne stimmige Cover-ID oder tx_hash ist kein exakter Endzustand
	for (const patch of [{ coverId: null }, { coverId: '0' }, { txHash: null }]) {
		const x = await confirm({ rows: [record({ status: 'CONFIRMED', coverId: '7001', ...patch })] });
		assert.equal(x.r.status, 'INVALID_STATUS', JSON.stringify(patch));
	}
});

test('P4G-CROSS-INTENT the transaction of one intent never confirms another intent', async () => {
	// B (Kaeufer OTHER) zeigt auf die Transaktion von A (Kaeufer WALLET): P4E meldet WRONG_SENDER
	const intentB = W.intent({ id: ID_B, wallet: OTHER });
	const rowB = { id: ID_B, status: 'SUBMITTED', late: false, intent: intentB, intentHash: I.computePurchaseIntentHash(intentB), calldataHash: W.calldataHashFor(OTHER), txHash: TX_HASH, coverId: null };
	const { r, db } = await confirm({ rows: [record(), rowB], intentId: ID_B });
	assert.equal(r.verifier.status, 'WRONG_SENDER');
	assert.equal(r.status, 'NOT_VERIFIED');
	unchanged(db, ID_B);
	unchanged(db, ID_A);
	// B mit A's calldata_hash und A's Transaktion: ebenso keine Bestaetigung
	const sameHash = await confirm({ rows: [{ ...rowB, calldataHash: W.calldataHashFor(WALLET) }], intentId: ID_B });
	assert.notEqual(sameHash.r.status, 'CONFIRMED');
	assert.deepEqual(sameHash.db.writes(), []);
	// das Repository liefert fuer B den Datensatz von A: abgelehnt, bevor gelesen wird
	const swapped = repository([]);
	swapped.store.set(ID_B, record());
	const s = await confirm({ repo: swapped, intentId: ID_B });
	assert.equal(s.r.status, 'PERSISTED_RECORD_INVALID');
	assert.ok(s.r.errors.includes('RECORD_ID'));
	assert.deepEqual(s.seen, []);
	// gleiche Cover-ID schon bei einem anderen Intent: die P4D-Eindeutigkeit gewinnt, Konflikt
	const intentC = W.intent({ id: ID_B });
	const taken = repository([{ ...record(), id: ID_B, intent: intentC, intentHash: I.computePurchaseIntentHash(intentC), status: 'CONFIRMED', coverId: '7001', txHash: W.txHashFor('C') }, record()]);
	const t = await confirm({ repo: taken });
	assert.equal(t.r.status, 'DB_CONFIRMATION_CONFLICT');
	assert.equal(taken.store.get(ID_A).status, 'SUBMITTED');
});

test('P4G-NO-CACHE every attempt runs a fresh verification; a reorg after an earlier VERIFIED result is not confirmed', async () => {
	const first = await confirm();
	assert.equal(first.r.status, 'CONFIRMED');
	// gleicher Intent, wieder SUBMITTED (neue Datenbank), die Kette zeigt jetzt einen anderen Block: keine Bestaetigung
	const second = await confirm({ edit: (w) => { w.blocks[toHex(BLOCK)].hash = keccak256(toHex('reorged block')); } });
	assert.equal(second.r.verifier.status, 'BLOCK_HASH_MISMATCH');
	assert.equal(second.r.status, 'UNRESOLVED_RETRYABLE');
	unchanged(second.db);
	assert.ok(second.seen.includes('eth_getTransactionReceipt'), 'chain read again');
	// dieselben Leser, zweimal hintereinander: zweimal vollstaendig gelesen
	const db = repository([record()], { onConfirm: () => ({ status: 'conflict', code: 'NOT_SUBMITTED' }) });
	const rpc = readers();
	await G.confirmVerifiedPurchase({ repository: db.repo, rpcA: rpc.rpcA, rpcB: rpc.rpcB, intentId: ID_A });
	const n = rpc.seen.length;
	await G.confirmVerifiedPurchase({ repository: db.repo, rpcA: rpc.rpcA, rpcB: rpc.rpcB, intentId: ID_A });
	assert.equal(rpc.seen.length, 2 * n);
});

/* ----------------------------------------------- statisch, Reichweite -- */

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const walk = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).flatMap((n) => (n === 'node_modules' || n === 'dist' || n.startsWith('.') ? [] : statSync(new URL(`../${dir}/${n}`, import.meta.url)).isDirectory() ? walk(`${dir}/${n}`) : /\.(m?js|cjs|ts|tsx|jsx|html|svelte|vue)$/.test(n) ? [`${dir}/${n}`] : []));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const MODULE = 'src/purchase-confirmation.mjs';

test('P4G-STATIC the orchestration has no wallet, send, sign, builder, generic DB, FAILED or environment surface', () => {
	const full = read(MODULE);
	const source = strip(full);
	assert.doesNotMatch(full, /eth_sendTransaction|eth_sendRawTransaction|wallet_sendCalls|sendTransaction|writeContract|createWalletClient|signTransaction|personal_sign|signTypedData|eth_sign|WalletConnect|walletconnect/i);
	assert.doesNotMatch(source, /approve|buyCover|encodeFunctionData|7c59cac4|095ea7b3|productionReady/);
	assert.doesNotMatch(source, /markFailed|markLateConfirmed|late_confirmed|\.rpc\(|\.from\(|\.query\(|\.update\(|executeSql|\bsql\b|process\.env|fetch\(|createClient|supabase/i);
	assert.doesNotMatch(source, /new Map|WeakMap|cache/i, 'no stored verifier results');
	assert.deepEqual([...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['./purchase-intent.mjs', './purchase-receipt.mjs']);
	assert.doesNotMatch(source, /import\(/);
	assert.equal(source.match(/verifyPurchaseReceipt\(/g).length, 1, 'exactly one verifier call');
	assert.equal(source.match(/repository\.markConfirmed\(/g).length, 1, 'exactly one write');
	assert.equal(source.match(/repository\.\w+\(/g).length, 2, 'only load and markConfirmed');
	// die Politik steht fest im Modul, ohne Parameter
	assert.match(source, /minConfirmations: CONFIRMATION_POLICY\.minConfirmations, requireFinalized: CONFIRMATION_POLICY\.requireFinalized/);
	assert.match(source, /export const CONFIRMATION_POLICY = PRODUCTION_CONFIRMATION_POLICY;/);
	assert.deepEqual(Object.keys(G).sort(), ['CONFIRMATION_POLICY', 'CONFIRMATION_STATUSES', 'RETRYABLE_VERIFIER_STATUSES', 'confirmVerifiedPurchase', 'confirmableCoverId']);
	assert.ok(!G.CONFIRMATION_STATUSES.includes('FAILED') && !G.CONFIRMATION_STATUSES.includes('READY_TO_SEND'));
	assert.ok(Object.isFrozen(G.CONFIRMATION_STATUSES) && Object.isFrozen(G.RETRYABLE_VERIFIER_STATUSES));
});

test('P4G-IMPORT only the two P4G tests import the orchestration; no route, cron or command reaches it', () => {
	const runtime = [...walk('src'), ...walk('api'), ...walk('web'), ...walk('scripts')].filter((f) => f !== MODULE && !f.startsWith('web/dist'));
	assert.ok(runtime.includes('src/bot.mjs') && runtime.some((f) => f.startsWith('api/')) && runtime.some((f) => f.startsWith('web/src/')) && runtime.some((f) => /^src\/agent-/.test(f)));
	for (const file of runtime) assert.doesNotMatch(read(file), /purchase-confirmation(\.mjs)?['"`]|confirmVerifiedPurchase|confirmableCoverId/, file);
	const importing = /(?:from\s*|import\s*\(\s*)['"`][^'"`]*purchase-confirmation\.mjs/;
	assert.deepEqual([...walk('src'), ...walk('api'), ...walk('test'), ...walk('test-support')].filter((f) => importing.test(read(f))).sort(), ['test/purchase-confirmation-db.test.mjs', 'test/purchase-confirmation.test.mjs']);
	assert.deepEqual(walk('api').filter((f) => /confirm|receipt|purchase|buy|intent/i.test(f)), [], 'no confirmation or purchase route');
	const vercel = read('vercel.json');
	assert.doesNotMatch(vercel, /confirm|receipt|purchase|buy|intent/i, 'no route or cron');
});

test('P4G-P4C-MODEL the builder stays offline-only and never production-ready; external controls are separated, not deleted', async () => {
	const B = await import('../src/purchase-tx-builder.mjs');
	assert.equal(B.BUILDER_CAPABILITY, 'OFFLINE_ONLY');
	assert.equal(B.USDC_PIN_STATUS, 'BUILDER_ADDRESS_ONLY_PIN_EXTERNAL_P4F');
	assert.deepEqual({ ...B.EXTERNAL_REQUIRED_CONTROLS }, { USDC_PIN: 'SATISFIED_BY_P4F', PRE_SEND_CHAIN_VALIDATION: 'SATISFIED_BY_P4F', RECEIPT_BEFORE_CONFIRMATION: 'SATISFIED_BY_P4G', WALLET_ORCHESTRATION: 'UNRESOLVED', TERMS: 'UNRESOLVED', PROOF_OF_LOSS: 'UNRESOLVED' });
	assert.ok(Object.isFrozen(B.EXTERNAL_REQUIRED_CONTROLS));
	assert.deepEqual([...B.PRODUCTION_BLOCKERS], ['PROOF_OF_LOSS_UNRESOLVED', 'NEXUS_TEXTS_UNCONFIRMED', 'WALLET_ORCHESTRATION_UNRESOLVED']);
	const quote = { premiumRaw: '3000578', quoteTotalCoverAmountRaw: '1000192871', allocations: [{ poolId: '2', coverAmountInAsset: '1000192871' }] };
	for (const r of [B.buildNexusBuyCover({ intent: W.intent(), quote }), B.buildExactUsdcApproval({ intent: W.intent() })]) {
		assert.equal(r.ok, true, JSON.stringify(r.errors));
		assert.equal(r.tx.productionReady, false);
		assert.deepEqual([...r.tx.blockers], [...B.PRODUCTION_BLOCKERS]);
	}
	// Geschichte bleibt nachvollziehbar: die frueheren Blocker stehen dokumentiert im Builder
	const doc = read('src/purchase-tx-builder.mjs');
	assert.match(doc, /USDC_IMPLEMENTATION_NOT_PINNED/);
	assert.match(doc, /NO_PRE_SEND_CHAIN_VALIDATION/);
	assert.match(doc, /ADDRESS_ONLY_IMPLEMENTATION_NOT_PINNED/);
});
