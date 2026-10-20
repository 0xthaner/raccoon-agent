/**
 * Nexus P4J (20.10.2026): dauerhafte Ausfuehrungsversuche gegen einen echten Wegwerf-Postgres - alle
 * Migrationen, der echte Helfer src/purchase-execution-attempt-db.mjs, echte P4D-Intents und echte
 * P4I-Sitzungen. Es gibt keinen Wallet-Aufruf: die Tests melden nur, was ein spaeterer Wallet-Schritt
 * ueber seinen Versuch melden wuerde (Ablehnung, Timeout, tx_hash).
 *
 * Laeuft nur mit M1_DB_TEST_PG_URL (lokal, 127.0.0.1) und M1_DB_TEST_PG_MODULE (pg). Ohne diese
 * Variablen wird PURCHASE-ATTEMPT-DB uebersprungen (scripts/skip-policy.mjs, exakt mit Datei und Name).
 * Das reine Protokoll und die statischen Pruefungen: test/purchase-execution-protocol.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { keccak256 } from 'viem';
import { openPurchaseDb, rpcOn, freshWallet, intentFor } from '../test-support/purchase-intent-pg.mjs';
import { builtIntent, buyData, nowS } from '../test-support/purchase-execution-session-pg.mjs';
import { authorized, consumedSession, txHashFor } from '../test-support/purchase-execution-attempt-pg.mjs';
import { computePurchaseIntentHash } from '../src/purchase-intent.mjs';
const A = await import('../src/purchase-execution-attempt-db.mjs');
const D = await import('../src/purchase-intent-db.mjs');
const X = await import('../src/purchase-execution-session-db.mjs');

const skip = !process.env.M1_DB_TEST_PG_URL || !process.env.M1_DB_TEST_PG_MODULE ? 'M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE nicht gesetzt (Wegwerf-Postgres noetig)' : false;
const TABLE = 'public.cover_purchase_execution_attempts';
const FUNCTIONS = ['bind_cover_purchase_execution_attempt_tx_hash', 'mark_cover_purchase_execution_attempt_uncertain', 'open_cover_purchase_execution_attempt',
	'reconcile_cover_purchase_execution_attempt_no_tx', 'reject_cover_purchase_execution_attempt', 'settle_cover_purchase_approval_attempt', 'start_cover_purchase_execution_attempt',
	'submit_cover_purchase_execution_attempt'];
const INTERNAL = ['cover_purchase_execution_attempt_json', 'cover_purchase_execution_attempts_guard'];

test('PURCHASE-ATTEMPT-DB', { skip, timeout: 600_000 }, async (t) => {
	const db = await openPurchaseDb('p4j_attempt');
	t.after(() => db.close());
	const { sql } = db;
	const client = rpcOn(sql);
	const row = async (id) => (await sql.query(`select * from ${TABLE} where attempt_id = $1`, [id])).rows[0];
	const intentRow = async (id) => (await sql.query('select status, tx_hash, cover_id from public.cover_purchase_intents where id = $1', [id])).rows[0];
	const sqlError = async (statement, params = []) => { try { await sql.query(statement, params); return 'OK'; } catch (e) { return e.message; } };
	const ids = (a) => ({ attemptId: a.attemptId, consumerRequestId: a.key });
	const start = (a) => A.startWalletRequest(client, ids(a));
	const bind = (a, txHash, source = 'WALLET_RESPONSE') => A.bindTransactionHash(client, { ...ids(a), txHash, source });
	const waitPast = async (seconds) => { while ((await sql.query('select now() >= to_timestamp($1) as x', [seconds])).rows[0].x === false) await new Promise((r) => setTimeout(r, 50)); };
	/** Ein zweiter BUILT-Intent fuer eine bestimmte Wallet (builtIntent nimmt immer eine frische). */
	async function builtFor(wallet) {
		const intent = intentFor(wallet);
		assert.equal((await D.createIntent(client, { intent, clientRequestId: randomUUID() })).status, 'created');
		const data = buyData(intent.id);
		const calldataHash = keccak256(data);
		assert.equal((await D.markBuilt(client, { intent, calldataHash })).status, 'built');
		return { intent, data, calldataHash, intentHash: computePurchaseIntentHash(intent) };
	}
	/** Ein Versuch, direkt als Owner eingefuegt (nur fuer die 30-Minuten-Ruhezeit, die kein Test abwartet). */
	async function startedLongAgo(state) {
		const built = await builtIntent(client);
		const { session, key } = await consumedSession(client, built);
		const attemptId = randomUUID();
		await sql.query(`insert into ${TABLE} (attempt_id, session_id, intent_id, wallet, transaction_kind, consumer_request_id, state, created_at, wallet_request_started_at)
			values ($1, $2, $3, $4, 'NEXUS_BUY_COVER', $5, $6, now() - interval '61 minutes', now() - interval '60 minutes')`, [attemptId, session.sessionId, built.intent.id, built.intent.wallet, key, state]);
		return { built, session, key, attemptId };
	}

	await t.test('P4J-DB-OPEN consume -> one AUTHORIZED attempt per session; the same request gets it back, any other request is refused', async () => {
		const a = await authorized(client);
		assert.equal(a.attempt.state, 'AUTHORIZED');
		assert.equal(a.attempt.sessionId, a.session.sessionId);
		assert.equal(a.attempt.intentId, a.built.intent.id);
		assert.equal(a.attempt.wallet, a.built.intent.wallet);
		assert.equal(a.attempt.transactionKind, 'NEXUS_BUY_COVER');
		// Browser wiederholt dieselbe Anfrage mit einer neuen Versuchs-Kennung: derselbe Versuch, keine zweite Berechtigung
		const again = await A.openExecutionAttempt(client, { attemptId: randomUUID(), sessionId: a.session.sessionId, consumerRequestId: a.key });
		assert.equal(again.status, 'EXISTING');
		assert.equal(again.attempt.attemptId, a.attemptId);
		// eine andere Anfrage (zweiter Tab) erhaelt nichts
		assert.deepEqual(await A.openExecutionAttempt(client, { attemptId: randomUUID(), sessionId: a.session.sessionId, consumerRequestId: randomUUID() }), { status: 'REJECTED', code: 'REQUEST_MISMATCH', attempt: null });
		assert.equal((await sql.query(`select count(*)::int as n from ${TABLE} where session_id = $1`, [a.session.sessionId])).rows[0].n, 1);
		// nicht verbrauchte Sitzung, unbekannte Sitzung, abgelaufene Sitzung
		const b = await builtIntent(client);
		const { sessionFor } = await import('../test-support/purchase-execution-session-pg.mjs');
		const open = sessionFor(b);
		assert.equal((await X.persistExecutionSession(client, { session: open })).status, 'created');
		assert.equal((await A.openExecutionAttempt(client, { attemptId: randomUUID(), sessionId: open.sessionId, consumerRequestId: randomUUID() })).code, 'SESSION_NOT_CONSUMED');
		assert.equal((await A.openExecutionAttempt(client, { attemptId: randomUUID(), sessionId: randomUUID(), consumerRequestId: randomUUID() })).code, 'SESSION_NOT_FOUND');
		const short = await consumedSession(client, await builtIntent(client), { ttl: 4 });
		await waitPast(short.session.expiresAt);
		assert.equal((await A.openExecutionAttempt(client, { attemptId: randomUUID(), sessionId: short.session.sessionId, consumerRequestId: short.key })).code, 'SESSION_EXPIRED');
		// zwei Versuche derselben Kennung fuer verschiedene Sitzungen: ATTEMPT_ID_REUSED
		const c = await consumedSession(client, await builtIntent(client));
		assert.equal((await A.openExecutionAttempt(client, { attemptId: a.attemptId, sessionId: c.session.sessionId, consumerRequestId: c.key })).code, 'ATTEMPT_ID_REUSED');
	});

	await t.test('P4J-DB-START the write-ahead is won exactly once; a duplicate browser request gets ALREADY_STARTED and must not call the wallet', async () => {
		const a = await authorized(client);
		const first = await start(a);
		assert.equal(first.status, 'WALLET_REQUEST_PERMITTED');
		assert.equal(first.attempt.state, 'WALLET_REQUEST_STARTED');
		assert.ok(first.attempt.walletRequestStartedAt >= first.attempt.createdAt);
		const dup = await start(a);
		assert.equal(dup.status, 'ALREADY_STARTED', 'same request again: no second permission');
		assert.equal(dup.attempt.state, 'WALLET_REQUEST_STARTED');
		assert.deepEqual(await A.startWalletRequest(client, { attemptId: a.attemptId, consumerRequestId: randomUUID() }), { status: 'REJECTED', code: 'REQUEST_MISMATCH', attempt: null });
		// nach Ablauf der Sitzung kein Start (der Versuch bleibt AUTHORIZED: es gab nie einen Wallet-Aufruf)
		const late = await authorized(client, { ttl: 4 });
		await waitPast(late.session.expiresAt);
		assert.deepEqual(await start(late), { status: 'REJECTED', code: 'WINDOW_CLOSED', attempt: null });
		assert.equal((await row(late.attemptId)).state, 'AUTHORIZED');
		// Intent nicht mehr BUILT: kein Start
		const gone = await authorized(client);
		assert.equal((await D.cancelIntent(client, { id: gone.built.intent.id, wallet: gone.built.intent.wallet })).status, 'cancelled');
		assert.equal((await start(gone)).code, 'WINDOW_CLOSED');
	});

	await t.test('P4J-DB-REJECT an explicit wallet rejection before any tx_hash ends the attempt; the purchase is neither FAILED nor SUBMITTED and cannot restart', async () => {
		const a = await authorized(client);
		assert.equal((await A.recordWalletRejection(client, ids(a))).status, 'CONFLICT', 'nothing to reject before the write-ahead');
		await start(a);
		const r = await A.recordWalletRejection(client, ids(a));
		assert.equal(r.status, 'RECORDED');
		assert.equal(r.attempt.state, 'ABORTED_NO_TX');
		assert.equal(r.attempt.abortReason, 'WALLET_REJECTED');
		assert.equal((await A.recordWalletRejection(client, ids(a))).status, 'EXISTING');
		assert.deepEqual(await intentRow(a.built.intent.id), { status: 'BUILT', tx_hash: null, cover_id: null }, 'the purchase is untouched');
		assert.equal((await start(a)).status, 'ALREADY_STARTED', 'the same attempt never calls the wallet again');
		assert.equal((await bind(a, txHashFor('after-reject'))).code, 'STATE');
		// keine zweite Sitzung derselben Art fuer diesen Intent (P4I) - eine neue Berechtigung heisst neuer Intent
		const { sessionFor } = await import('../test-support/purchase-execution-session-pg.mjs');
		assert.deepEqual(await X.persistExecutionSession(client, { session: sessionFor(a.built) }), { status: 'conflict', code: 'KIND_ALREADY_CONSUMED' });
		// die Wallet ist nicht belegt: abbrechen, neuer Intent, neuer Versuch startet
		assert.equal((await D.cancelIntent(client, { id: a.built.intent.id, wallet: a.built.intent.wallet })).status, 'cancelled');
		const next = await authorized(client, { built: await builtFor(a.built.intent.wallet) });
		assert.equal((await start(next)).status, 'WALLET_REQUEST_PERMITTED');
	});

	await t.test('P4J-DB-UNCERTAIN a timeout before any tx_hash is UNCERTAIN: no restart, no new execution for the wallet, only chain reconciliation', async () => {
		const a = await authorized(client);
		await start(a);
		const u = await A.recordWalletUncertain(client, ids(a));
		assert.equal(u.status, 'RECORDED');
		assert.equal(u.attempt.state, 'UNCERTAIN');
		assert.equal((await A.recordWalletUncertain(client, ids(a))).status, 'EXISTING');
		assert.equal((await start(a)).status, 'ALREADY_STARTED', 'UNCERTAIN cannot restart');
		assert.equal((await A.recordWalletRejection(client, ids(a))).code, 'STATE', 'a late "rejection" does not resolve UNCERTAIN');
		assert.equal((await bind(a, txHashFor('late-wallet'))).code, 'STATE', 'a wallet response after UNCERTAIN is not trusted');
		assert.deepEqual(await intentRow(a.built.intent.id), { status: 'BUILT', tx_hash: null, cover_id: null });
		// Intent abbrechen und einen neuen anlegen: die Wallet bleibt belegt, kein zweiter Wallet-Aufruf
		assert.equal((await D.cancelIntent(client, { id: a.built.intent.id, wallet: a.built.intent.wallet })).status, 'cancelled');
		const next = await authorized(client, { built: await builtFor(a.built.intent.wallet) });
		assert.deepEqual(await start(next), { status: 'REJECTED', code: 'WALLET_BUSY', attempt: null });
		assert.equal((await row(next.attemptId)).state, 'AUTHORIZED');
		// Abgleich: Fund auf der Kette bindet
		const found = await bind(a, txHashFor(`found-${a.attemptId}`), 'CHAIN_RECONCILIATION');
		assert.equal(found.status, 'BOUND');
		assert.equal(found.attempt.txHashSource, 'CHAIN_RECONCILIATION');
	});

	await t.test('P4J-DB-TXHASH a tx_hash is bound to attempt, session, intent and kind; the same hash is idempotent, another is a conflict, another intent cannot take it', async () => {
		const a = await authorized(client);
		await start(a);
		const h = txHashFor(`bind-${a.attemptId}`);
		const b = await bind(a, h);
		assert.equal(b.status, 'BOUND');
		assert.equal(b.attempt.state, 'TX_HASH_OBSERVED');
		const r = await row(a.attemptId);
		assert.deepEqual([r.tx_hash, r.session_id, r.intent_id, r.transaction_kind, r.wallet, r.tx_hash_source], [h, a.session.sessionId, a.built.intent.id, 'NEXUS_BUY_COVER', a.built.intent.wallet, 'WALLET_RESPONSE']);
		assert.equal((await bind(a, h)).status, 'EXISTING');
		const other = await bind(a, txHashFor(`replacement-${a.attemptId}`));
		assert.equal(other.code, 'TX_HASH_CONFLICT', 'a replacement or substituted hash never replaces the first binding');
		assert.equal((await row(a.attemptId)).tx_hash, h);
		const c = await authorized(client);
		await start(c);
		assert.equal((await bind(c, h)).code, 'TX_HASH_TAKEN', 'cross-intent hash refused');
		assert.equal((await row(c.attemptId)).tx_hash, null);
		assert.equal((await A.bindTransactionHash(client, { attemptId: a.attemptId, consumerRequestId: randomUUID(), txHash: txHashFor('x'), source: 'WALLET_RESPONSE' })).code, 'ATTEMPT_NOT_FOUND', 'other request');
		await assert.rejects(A.bindTransactionHash(client, { ...ids(a), txHash: 'not-a-hash', source: 'WALLET_RESPONSE' }), /TX_HASH/);
		await assert.rejects(A.bindTransactionHash(client, { ...ids(a), txHash: h, source: 'WALLET_RESPONSE', intentId: randomUUID() }), /CLIENT_FIELD/);
	});

	await t.test('P4J-DB-SUBMIT only a buyCover attempt moves the intent to SUBMITTED, with the bound hash and never one from the caller', async () => {
		const a = await authorized(client);
		await start(a);
		assert.equal((await A.submitPurchaseAttempt(client, { ...ids(a), intentId: a.built.intent.id, txNonce: 7 })).code, 'STATE', 'no submission before a hash is bound');
		const h = txHashFor(`submit-${a.attemptId}`);
		await bind(a, h);
		assert.equal((await A.submitPurchaseAttempt(client, { ...ids(a), intentId: (await builtIntent(client)).intent.id, txNonce: 7 })).code, 'INTENT_MISMATCH');
		await assert.rejects(A.submitPurchaseAttempt(client, { ...ids(a), intentId: a.built.intent.id, txNonce: 7, txHash: txHashFor('substitute') }), /CLIENT_FIELD:txHash/);
		const s = await A.submitPurchaseAttempt(client, { ...ids(a), intentId: a.built.intent.id, txNonce: 7 });
		assert.equal(s.status, 'SUBMITTED');
		assert.equal(s.attempt.state, 'SUBMITTED');
		assert.deepEqual(await intentRow(a.built.intent.id), { status: 'SUBMITTED', tx_hash: h, cover_id: null });
		assert.equal((await A.submitPurchaseAttempt(client, { ...ids(a), intentId: a.built.intent.id, txNonce: 7 })).status, 'EXISTING');
		// verlorene Antwort: der Browser wiederholt dieselbe Anfrage und liest den Zustand
		const replay = await start(a);
		assert.equal(replay.status, 'ALREADY_STARTED');
		assert.deepEqual([replay.attempt.state, replay.attempt.txHash], ['SUBMITTED', h]);
		// die Wallet ist nach SUBMITTED wieder frei (die Transaktion liegt bei P4D/P4E)
		assert.equal((await sql.query(`select count(*)::int as n from ${TABLE} where wallet = $1 and state in ('WALLET_REQUEST_STARTED', 'UNCERTAIN', 'TX_HASH_OBSERVED')`, [a.built.intent.wallet])).rows[0].n, 0);
	});

	await t.test('P4J-DB-APPROVAL approval and buyCover are separate authorities: approval never submits or confirms the purchase; buyCover needs a verified approval and a fresh pre-send', async () => {
		const built = await builtIntent(client);
		const ap = await authorized(client, { built, kind: 'USDC_APPROVAL' });
		await start(ap);
		const h = txHashFor(`approval-${ap.attemptId}`);
		assert.equal((await bind(ap, h)).status, 'BOUND');
		assert.equal((await A.submitPurchaseAttempt(client, { ...ids(ap), intentId: built.intent.id, txNonce: 3 })).code, 'NOT_A_PURCHASE');
		assert.deepEqual(await intentRow(built.intent.id), { status: 'BUILT', tx_hash: null, cover_id: null }, 'an approval hash is never the purchase hash');
		// die Freigabe-Wirkung wird unabhaengig nachgeprueft: zu wenig Allowance gilt nicht
		assert.equal((await A.settleApprovalAttempt(client, { ...ids(ap), outcome: 'VERIFIED', verifiedAtBlock: 30_000_000n, allowanceRaw: 3_030_583n })).code, 'ALLOWANCE_INSUFFICIENT');
		const v = await A.settleApprovalAttempt(client, { ...ids(ap), outcome: 'VERIFIED', verifiedAtBlock: 30_000_000n, allowanceRaw: 3_030_584n });
		assert.equal(v.status, 'SETTLED');
		assert.equal(v.attempt.state, 'APPROVAL_VERIFIED');
		assert.equal(v.attempt.approvalVerifiedBlock, 30_000_000n);
		assert.equal((await A.settleApprovalAttempt(client, { ...ids(ap), outcome: 'FAILED' })).code, 'ALREADY_SETTLED');
		assert.deepEqual(await intentRow(built.intent.id), { status: 'BUILT', tx_hash: null, cover_id: null }, 'a verified approval is not a purchase: neither SUBMITTED nor CONFIRMED');
		// eine buyCover-Sitzung, die VOR der Freigabe-Pruefung verifiziert wurde, gilt nicht
		const stale = await consumedSession(client, built, { verifiedAtBlock: 29_999_999n });
		assert.deepEqual(await A.openExecutionAttempt(client, { attemptId: randomUUID(), sessionId: stale.session.sessionId, consumerRequestId: stale.key }), { status: 'REJECTED', code: 'APPROVAL_NOT_VERIFIED', attempt: null });
		// frische Vorpruefung nach der Freigabe: neuer Intent derselben Wallet (die Art ist fuer den alten verbraucht)
		assert.equal((await D.cancelIntent(client, { id: built.intent.id, wallet: built.intent.wallet })).status, 'cancelled');
		const b2 = await builtFor(built.intent.wallet);
		const ap2 = await authorized(client, { built: b2, kind: 'USDC_APPROVAL' });
		await start(ap2);
		await bind(ap2, txHashFor(`approval2-${ap2.attemptId}`));
		const unverified = await consumedSession(client, b2, { verifiedAtBlock: 30_000_010n });
		assert.equal((await A.openExecutionAttempt(client, { attemptId: randomUUID(), sessionId: unverified.session.sessionId, consumerRequestId: unverified.key })).code, 'APPROVAL_NOT_VERIFIED', 'approval not verified yet');
		// nach der Pruefung genuegt das nicht mehr: die Art ist verbraucht - also dritter Intent, Freigabe, Pruefung, frische buyCover-Sitzung
		assert.equal((await A.settleApprovalAttempt(client, { ...ids(ap2), outcome: 'VERIFIED', verifiedAtBlock: 30_000_020n, allowanceRaw: 5_000_000n })).status, 'SETTLED');
		assert.equal((await D.cancelIntent(client, { id: b2.intent.id, wallet: b2.intent.wallet })).status, 'cancelled');
		const b3 = await builtFor(built.intent.wallet);
		const ap3 = await authorized(client, { built: b3, kind: 'USDC_APPROVAL' });
		await start(ap3);
		await bind(ap3, txHashFor(`approval3-${ap3.attemptId}`));
		assert.equal((await A.settleApprovalAttempt(client, { ...ids(ap3), outcome: 'VERIFIED', verifiedAtBlock: 30_000_030n, allowanceRaw: 3_030_584n })).status, 'SETTLED');
		const buy = await authorized(client, { built: b3, verifiedAtBlock: 30_000_031n });
		assert.equal(buy.attempt.transactionKind, 'NEXUS_BUY_COVER');
		assert.equal((await start(buy)).status, 'WALLET_REQUEST_PERMITTED');
		const bh = txHashFor(`buy-${buy.attemptId}`);
		await bind(buy, bh);
		assert.equal((await A.submitPurchaseAttempt(client, { ...ids(buy), intentId: b3.intent.id, txNonce: 4 })).status, 'SUBMITTED');
		assert.deepEqual(await intentRow(b3.intent.id), { status: 'SUBMITTED', tx_hash: bh, cover_id: null }, 'only the buyCover hash');
		// keine Freigabe nach einem verbrauchten buyCover
		const b4 = await builtIntent(client);
		await consumedSession(client, b4);
		const lateApproval = await consumedSession(client, b4, { kind: 'USDC_APPROVAL' });
		assert.equal((await A.openExecutionAttempt(client, { attemptId: randomUUID(), sessionId: lateApproval.session.sessionId, consumerRequestId: lateApproval.key })).code, 'PURCHASE_ALREADY_AUTHORIZED');
		// gescheiterte Freigabe: beendet, Kauf unberuehrt
		const b5 = await builtIntent(client);
		const ap5 = await authorized(client, { built: b5, kind: 'USDC_APPROVAL' });
		await start(ap5);
		await bind(ap5, txHashFor(`approval5-${ap5.attemptId}`));
		assert.equal((await A.settleApprovalAttempt(client, { ...ids(ap5), outcome: 'FAILED' })).attempt.state, 'APPROVAL_FAILED');
		assert.deepEqual(await intentRow(b5.intent.id), { status: 'BUILT', tx_hash: null, cover_id: null });
		assert.equal((await A.settleApprovalAttempt(client, { ...ids(buy), outcome: 'FAILED' })).code, 'NOT_AN_APPROVAL');
	});

	await t.test('P4J-DB-RECONCILE RECONCILED_NO_TX only after the 30-minute quiet period and with evidence; a found transaction binds instead', async () => {
		const recent = await authorized(client);
		await start(recent);
		assert.equal((await A.reconcileNoTransaction(client, { ...ids(recent), scannedToBlock: 30_000_100n, walletNonce: 5 })).code, 'QUIET_PERIOD');
		await A.recordWalletUncertain(client, ids(recent));
		assert.equal((await A.reconcileNoTransaction(client, { ...ids(recent), scannedToBlock: 30_000_100n, walletNonce: 5 })).code, 'QUIET_PERIOD', 'UNCERTAIN alone is no evidence');
		for (const state of ['WALLET_REQUEST_STARTED', 'UNCERTAIN']) {
			const old = await startedLongAgo(state);
			const r = await A.reconcileNoTransaction(client, { attemptId: old.attemptId, consumerRequestId: old.key, scannedToBlock: 30_000_200n, walletNonce: 9 });
			assert.equal(r.status, 'RECORDED', state);
			assert.deepEqual([r.attempt.state, r.attempt.abortReason], ['ABORTED_NO_TX', 'RECONCILED_NO_TX']);
			const saved = await row(old.attemptId);
			assert.deepEqual([saved.reconciled_to_block, saved.reconciled_wallet_nonce], ['30000200', '9']);
			assert.deepEqual(await intentRow(old.built.intent.id), { status: 'BUILT', tx_hash: null, cover_id: null }, 'not FAILED');
		}
		const crashed = await startedLongAgo('WALLET_REQUEST_STARTED');
		const h = txHashFor(`reconciled-${crashed.attemptId}`);
		assert.equal((await A.bindTransactionHash(client, { attemptId: crashed.attemptId, consumerRequestId: crashed.key, txHash: h, source: 'CHAIN_RECONCILIATION' })).status, 'BOUND');
		assert.equal((await A.reconcileNoTransaction(client, { attemptId: crashed.attemptId, consumerRequestId: crashed.key, scannedToBlock: 30_000_300n, walletNonce: 9 })).code, 'STATE', 'a bound hash is never "no transaction"');
	});

	await t.test('P4J-DB-CRASH the six crash windows recover without a second wallet request', async () => {
		// C1: Verbrauch gespeichert, Absturz vor dem Versuch -> dieselbe Anfrage erhaelt die Sitzung zurueck, Versuch, Start
		const built = await builtIntent(client);
		const { session, key } = await consumedSession(client, built);
		const replay = await X.consumeExecutionSession(client, { sessionId: session.sessionId, sessionHash: session.executionSessionHash, intentId: session.intentId, consumerRequestId: key });
		assert.equal(replay.status, 'IDEMPOTENT_REPLAY');
		const c1 = { attemptId: randomUUID(), key };
		assert.equal((await A.openExecutionAttempt(client, { attemptId: c1.attemptId, sessionId: session.sessionId, consumerRequestId: key })).status, 'CREATED');
		assert.equal((await start(c1)).status, 'WALLET_REQUEST_PERMITTED');
		// C2: Wallet-Aufruf gestartet, Absturz ohne Antwort -> kein zweiter Start, Wallet belegt
		assert.equal((await start(c1)).status, 'ALREADY_STARTED');
		assert.equal((await D.cancelIntent(client, { id: built.intent.id, wallet: built.intent.wallet })).status, 'cancelled');
		const other = await authorized(client, { built: await builtFor(built.intent.wallet) });
		assert.equal((await start(other)).code, 'WALLET_BUSY');
		// C3: gesendet, Absturz vor dem Speichern des Hashes -> Abgleich findet ihn und bindet
		const h3 = txHashFor(`c3-${c1.attemptId}`);
		assert.equal((await bind(c1, h3, 'CHAIN_RECONCILIATION')).status, 'BOUND');
		// C4: Hash gespeichert, Absturz vor P4D SUBMITTED -> erneut einreichen (der Hash kommt vom Versuch)
		const c4 = await authorized(client);
		await start(c4);
		const h4 = txHashFor(`c4-${c4.attemptId}`);
		await bind(c4, h4);
		assert.equal((await intentRow(c4.built.intent.id)).status, 'BUILT');
		assert.equal((await A.submitPurchaseAttempt(client, { ...ids(c4), intentId: c4.built.intent.id, txNonce: 1 })).status, 'SUBMITTED');
		// C5: SUBMITTED gespeichert, Antwort verloren -> dieselbe Anfrage liest den Zustand, nichts wird erneut gesendet
		assert.equal((await A.submitPurchaseAttempt(client, { ...ids(c4), intentId: c4.built.intent.id, txNonce: 1 })).status, 'EXISTING');
		const read5 = await start(c4);
		assert.deepEqual([read5.status, read5.attempt.state, read5.attempt.txHash], ['ALREADY_STARTED', 'SUBMITTED', h4]);
		// C6: Freigabe gemined, Browser zu -> Freigabe nachpruefen, dann frische buyCover-Sitzung
		const b6 = await builtIntent(client);
		const ap = await authorized(client, { built: b6, kind: 'USDC_APPROVAL' });
		await start(ap);
		await bind(ap, txHashFor(`c6-${ap.attemptId}`), 'CHAIN_RECONCILIATION');
		assert.equal((await A.settleApprovalAttempt(client, { ...ids(ap), outcome: 'VERIFIED', verifiedAtBlock: 30_000_400n, allowanceRaw: 3_030_584n })).status, 'SETTLED');
		const buy = await authorized(client, { built: b6, verifiedAtBlock: 30_000_401n });
		assert.equal((await start(buy)).status, 'WALLET_REQUEST_PERMITTED');
	});

	await t.test('P4J-DB-IMMUTABLE no backward transition, tx_hash never cleared or changed, bindings and kind fixed, nothing deleted', async () => {
		const a = await authorized(client);
		await start(a);
		await A.recordWalletUncertain(client, ids(a));
		assert.match(await sqlError(`update ${TABLE} set state = 'WALLET_REQUEST_STARTED' where attempt_id = $1`, [a.attemptId]), /illegal transition UNCERTAIN -> WALLET_REQUEST_STARTED/, 'UNCERTAIN never goes back to a startable state');
		assert.match(await sqlError(`update ${TABLE} set state = 'AUTHORIZED', wallet_request_started_at = null where attempt_id = $1`, [a.attemptId]), /wallet_request_started_at is set once|illegal transition/);
		assert.match(await sqlError(`update ${TABLE} set wallet_request_started_at = wallet_request_started_at - interval '1 hour' where attempt_id = $1`, [a.attemptId]), /wallet_request_started_at is set once/, 'the write-ahead time cannot be moved back past the quiet period');
		const h = txHashFor(`imm-${a.attemptId}`);
		await bind(a, h, 'CHAIN_RECONCILIATION');
		assert.match(await sqlError(`update ${TABLE} set tx_hash = $2 where attempt_id = $1`, [a.attemptId, txHashFor('other')]), /tx_hash is set once/);
		assert.match(await sqlError(`update ${TABLE} set tx_hash = null, tx_hash_source = null where attempt_id = $1`, [a.attemptId]), /tx_hash is set once/, 'never cleared');
		assert.match(await sqlError(`update ${TABLE} set state = 'UNCERTAIN' where attempt_id = $1`, [a.attemptId]), /illegal transition TX_HASH_OBSERVED -> UNCERTAIN/);
		assert.match(await sqlError(`update ${TABLE} set transaction_kind = 'USDC_APPROVAL' where attempt_id = $1`, [a.attemptId]), /transaction_kind is immutable/);
		assert.match(await sqlError(`update ${TABLE} set session_id = $2 where attempt_id = $1`, [a.attemptId, randomUUID()]), /session_id is immutable/);
		assert.match(await sqlError(`update ${TABLE} set intent_id = (select id from public.cover_purchase_intents where id <> $2 limit 1) where attempt_id = $1`, [a.attemptId, a.built.intent.id]), /intent_id is immutable/);
		assert.match(await sqlError(`update ${TABLE} set wallet = $2 where attempt_id = $1`, [a.attemptId, freshWallet()]), /wallet is immutable/);
		assert.match(await sqlError(`update ${TABLE} set consumer_request_id = $2 where attempt_id = $1`, [a.attemptId, randomUUID()]), /consumer_request_id is immutable/);
		const s = await authorized(client);
		await start(s);
		await bind(s, txHashFor(`imm2-${s.attemptId}`));
		await A.submitPurchaseAttempt(client, { ...ids(s), intentId: s.built.intent.id, txNonce: 2 });
		assert.match(await sqlError(`update ${TABLE} set state = 'TX_HASH_OBSERVED', settled_at = null where attempt_id = $1`, [s.attemptId]), /settled_at is set once|illegal transition/);
		const r = await authorized(client);
		await start(r);
		await A.recordWalletRejection(client, ids(r));
		assert.match(await sqlError(`update ${TABLE} set state = 'UNCERTAIN', abort_reason = null, settled_at = null where attempt_id = $1`, [r.attemptId]), /abort_reason is set once|illegal transition/);
		assert.match(await sqlError(`delete from ${TABLE} where attempt_id = $1`, [a.attemptId]), /rows are never deleted/, 'even the owner cannot delete');
		assert.match(await sqlError(`truncate ${TABLE}`), /rows are never deleted/, 'even the owner cannot truncate');
		assert.equal((await row(a.attemptId)).tx_hash, h);
	});

	const asRole = async (role, statement, params = []) => { await sql.query('begin'); try { await sql.query(`set local role ${role}`); await sql.query(statement, params); return 'OK'; } catch (e) { return e.code ?? e.message; } finally { await sql.query('rollback'); } };
	const fns = async () => (await sql.query(`select p.oid, p.proname, p.prosecdef, p.prosrc, p.proconfig, p.oid::regprocedure::text as sig, p.proargtypes::regtype[]::text[] as argtypes from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like '%cover_purchase_execution_attempt%' or p.proname = 'settle_cover_purchase_approval_attempt')`)).rows;
	const nullArgs = (fn) => fn.argtypes.map((x) => `null::${x}`).join(', ');

	await t.test('P4J-DB-PRIVILEGES RLS on, no direct table access for anyone (service_role included); service_role executes only the eight functions; no generic update, no delete path', async () => {
		const a = await authorized(client);
		assert.equal((await sql.query(`select relrowsecurity from pg_class where oid = '${TABLE}'::regclass`)).rows[0].relrowsecurity, true);
		for (const role of ['anon', 'authenticated', 'service_role']) {
			for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) assert.equal((await sql.query(`select has_table_privilege($1, '${TABLE}', $2) as x`, [role, p])).rows[0].x, false, `${role} ${p}`);
			assert.equal(await asRole(role, `select * from ${TABLE}`), '42501', `${role} select`);
			assert.equal(await asRole(role, `update ${TABLE} set state = 'AUTHORIZED'`), '42501', `${role} update`);
			assert.equal(await asRole(role, `delete from ${TABLE}`), '42501', `${role} delete`);
		}
		const all = await fns();
		assert.deepEqual(all.map((f) => f.proname).sort(), [...FUNCTIONS, ...INTERNAL].sort(), 'no further function (no generic update, no delete helper)');
		for (const fn of all) {
			for (const role of ['anon', 'authenticated']) {
				assert.equal((await sql.query(`select has_function_privilege($1, $2::oid, 'EXECUTE') as x`, [role, fn.oid])).rows[0].x, false, `${role} ${fn.sig}`);
				assert.equal(await asRole(role, `select public.${fn.proname}(${nullArgs(fn)})`), '42501', `${role} calling ${fn.sig}`);
			}
			assert.ok((fn.proconfig ?? []).includes('search_path=public, pg_temp'), `${fn.proname} pins search_path`);
			assert.doesNotMatch(fn.prosrc, /\bexecute\b|format\s*\(|\bdelete\s+from\b|\btruncate\s+(table\s+)?(public\.)?[a-z_]/i, `${fn.proname}: no dynamic SQL, no delete`);
		}
		const callable = [];
		for (const fn of all) if ((await sql.query(`select has_function_privilege('service_role', $1::oid, 'EXECUTE') as x`, [fn.oid])).rows[0].x) callable.push(fn.proname);
		assert.deepEqual(callable.sort(), FUNCTIONS);
		assert.deepEqual(all.filter((f) => f.prosecdef).map((f) => f.proname).sort(), FUNCTIONS, 'definer only where it writes');
		assert.equal(await asRole('service_role', 'select public.start_cover_purchase_execution_attempt($1, $2)', [a.attemptId, a.key]), 'OK', 'service_role reaches the function');
		const triggers = (await sql.query(`select tgname from pg_trigger where tgrelid = '${TABLE}'::regclass and not tgisinternal order by tgname`)).rows.map((x) => x.tgname);
		assert.deepEqual(triggers, ['cover_purchase_execution_attempts_guard', 'cover_purchase_execution_attempts_no_truncate']);
		// P4D und P4I bekommen keinen neuen Trigger
		const others = (await sql.query(`select c.relname || '.' || g.tgname as t from pg_trigger g join pg_class c on c.oid = g.tgrelid where c.relname in ('cover_purchase_intents', 'cover_purchase_execution_sessions') and not g.tgisinternal order by 1`)).rows.map((x) => x.t);
		assert.deepEqual(others, ['cover_purchase_execution_sessions.cover_purchase_execution_sessions_guard', 'cover_purchase_execution_sessions.cover_purchase_execution_sessions_no_truncate', 'cover_purchase_intents.cover_purchase_intents_guard']);
	});

	t.diagnostic(`attempt DB checks at ${nowS()}`);
});
