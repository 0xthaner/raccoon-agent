/**
 * Nexus P4J (20.10.2026): das Protokoll des spaeteren Wallet-Schritts, ohne Datenbank und ohne Wallet -
 * Zustaende und Uebergaenge (gleich dem Trigger der Migration), Einordnung der Wallet-Ergebnisse,
 * Wiederaufnahme je Zustand, Absturzfenster, Freigabe vs. buyCover, Nonce nur als Nachweis, Bindung
 * SIWE-Wallet = Intent-Wallet = Sitzungs-Wallet = from, unveraenderliche Adapter-Anfrage, und die
 * statischen Grenzen: keine Wallet-, Sende- oder Signiermethode, keine Laufzeit-Reichweite, keine Route.
 * Laeuft immer; die Datenbank-Tests stehen in test/purchase-execution-attempt-db*.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
const P = await import('../src/purchase-execution-protocol.mjs');
const A = await import('../src/purchase-execution-attempt-db.mjs');

const MIGRATION = 'supabase/migrations/20261020160000_cover_purchase_execution_attempts.sql';
const MODULES = ['src/purchase-execution-protocol.mjs', 'src/purchase-execution-attempt-db.mjs'];
const FUNCTIONS = ['bind_cover_purchase_execution_attempt_tx_hash', 'mark_cover_purchase_execution_attempt_uncertain', 'open_cover_purchase_execution_attempt',
	'reconcile_cover_purchase_execution_attempt_no_tx', 'reject_cover_purchase_execution_attempt', 'settle_cover_purchase_approval_attempt', 'start_cover_purchase_execution_attempt',
	'submit_cover_purchase_execution_attempt'];
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const walk = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).flatMap((n) => (n === 'node_modules' || n === 'dist' || n.startsWith('.') ? [] : statSync(new URL(`../${dir}/${n}`, import.meta.url)).isDirectory() ? walk(`${dir}/${n}`) : /\.(m?js|cjs|ts|tsx|jsx|html|svelte|vue)$/.test(n) ? [`${dir}/${n}`] : []));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--).*$/gm, '');
const H = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const W1 = '0x00000000000000000000000000000000000000a1';
const BROKER = '0xcb2b736652d2dbf7d72e4db880cf6b7d99507814';

test('P4J-STATES the attempt state machine is forward-only and identical to the migration trigger', () => {
	assert.deepEqual([...P.ATTEMPT_STATES].sort(), Object.keys(P.TRANSITIONS).sort());
	const trigger = strip(read(MIGRATION));
	const block = trigger.slice(trigger.indexOf('if new.state is distinct from old.state then'), trigger.indexOf('illegal transition'));
	const fromDb = {};
	for (const m of block.matchAll(/old\.state = '([A-Z_]+)' and new\.state (?:= '([A-Z_]+)'|in \(([^)]*)\))/g)) (fromDb[m[1]] ??= []).push(...(m[2] ? [m[2]] : m[3].split(',').map((x) => x.trim().replaceAll("'", ''))));
	for (const s of P.ATTEMPT_STATES) assert.deepEqual([...(fromDb[s] ?? [])].sort(), [...P.TRANSITIONS[s]].sort(), `transitions from ${s}`);
	const check = trigger.match(/state text not null check \(state in \(([^)]*)\)\)/)[1].split(',').map((x) => x.trim().replaceAll("'", ''));
	assert.deepEqual(check.sort(), [...P.ATTEMPT_STATES].sort());
	// nichts fuehrt zurueck nach AUTHORIZED oder WALLET_REQUEST_STARTED ausser dem einen Write-ahead
	for (const from of P.ATTEMPT_STATES) {
		assert.equal(P.canTransition(from, 'AUTHORIZED'), false, `${from} -> AUTHORIZED`);
		assert.equal(P.canTransition(from, 'WALLET_REQUEST_STARTED'), from === 'AUTHORIZED', `${from} -> WALLET_REQUEST_STARTED`);
	}
	assert.equal(P.canTransition('UNCERTAIN', 'WALLET_REQUEST_STARTED'), false);
	assert.deepEqual([...P.HOLDING_STATES].sort(), ['TX_HASH_OBSERVED', 'UNCERTAIN', 'WALLET_REQUEST_STARTED']);
	assert.match(trigger, new RegExp(`where state in \\(${P.HOLDING_STATES.map((s) => `'${s}'`).join(', ')}\\)`), 'the wallet-busy index covers exactly the holding states');
});

test('P4J-OUTCOME only a well-formed tx hash or the explicit rejection 4001 are unambiguous; a timeout is UNCERTAIN, never "no broadcast" and never "success"', () => {
	const h = H(1);
	assert.deepEqual({ ...P.classifyWalletOutcome({ type: 'TX_HASH', txHash: h }) }, { next: 'TX_HASH_OBSERVED', txHash: h, source: 'WALLET_RESPONSE' });
	assert.deepEqual({ ...P.classifyWalletOutcome({ type: 'REJECTED', code: 4001 }) }, { next: 'ABORTED_NO_TX', reason: 'WALLET_REJECTED' });
	for (const r of [{ type: 'TIMEOUT' }, { type: 'NETWORK_ERROR' }, { type: 'PROVIDER_ERROR', code: -32603 }, { type: 'REJECTED', code: 4100 }, { type: 'REJECTED', code: 5000 },
		{ type: 'REJECTED', code: 4001, txHash: h }, { type: 'TX_HASH', txHash: 'pending' }, { type: 'TX_HASH', txHash: h.toUpperCase() }, { type: 'SAFE_TX_PROPOSED', safeTxHash: h }, null, undefined, {}]) {
		assert.equal(P.classifyWalletOutcome(r).next, 'UNCERTAIN', JSON.stringify(r));
	}
	assert.equal(P.classifyWalletOutcome({ type: 'TIMEOUT' }).reason, 'TIMEOUT');
});

test('P4J-RECOVERY UNCERTAIN and a started request require chain reconciliation; no state but the verified approval allows a new session; nothing retries blindly', () => {
	for (const s of ['UNCERTAIN', 'WALLET_REQUEST_STARTED']) {
		const p = P.recoveryFor(s);
		assert.deepEqual([p.retrySameAttempt, p.chainReconciliationRequired, p.newSessionAllowed, p.newIntentAllowed, p.terminal], [false, true, false, false, false], s);
	}
	assert.deepEqual([P.recoveryFor('AUTHORIZED').retrySameAttempt, P.recoveryFor('AUTHORIZED').newIntentAllowed], [true, false]);
	assert.deepEqual(P.ATTEMPT_STATES.filter((s) => P.recoveryFor(s).retrySameAttempt), ['AUTHORIZED'], 'only before the write-ahead');
	assert.deepEqual(P.ATTEMPT_STATES.filter((s) => P.recoveryFor(s).newSessionAllowed), ['APPROVAL_VERIFIED']);
	assert.deepEqual(P.ATTEMPT_STATES.filter((s) => P.recoveryFor(s).newIntentAllowed).sort(), ['ABORTED_NO_TX', 'APPROVAL_FAILED']);
	assert.deepEqual(P.ATTEMPT_STATES.filter((s) => P.recoveryFor(s).terminal).sort(), ['ABORTED_NO_TX', 'APPROVAL_FAILED', 'APPROVAL_VERIFIED', 'SUBMITTED']);
	for (const s of P.HOLDING_STATES) assert.equal(P.recoveryFor(s).newIntentAllowed || P.recoveryFor(s).newSessionAllowed || P.recoveryFor(s).terminal, false, s);
	assert.throws(() => P.recoveryFor('RETRY'), /STATE/);
});

test('P4J-PURCHASE-EFFECT only a buyCover tx hash leads to P4D SUBMITTED; approval never submits or confirms; a rejection never marks FAILED', () => {
	for (const kind of P.TRANSACTION_KINDS) {
		for (const state of P.ATTEMPT_STATES) {
			const e = P.purchaseEffect({ kind, state });
			assert.equal(e, kind === 'NEXUS_BUY_COVER' && state === 'TX_HASH_OBSERVED' ? 'MARK_SUBMITTED' : 'NONE', `${kind} ${state}`);
			assert.ok(!['MARK_FAILED', 'MARK_CONFIRMED'].includes(e));
		}
	}
	assert.throws(() => P.purchaseEffect({ kind: 'ERC20_TRANSFER', state: 'TX_HASH_OBSERVED' }), /ATTEMPT/);
});

test('P4J-RECONCILE the nonce is evidence, never authorization; no transaction is recorded only after the quiet period and finality depth', () => {
	const base = { startedAtBlock: 100n, walletNonceAtStart: 7, quietPeriodElapsed: false, scannedToBlock: 101n, matches: [] };
	assert.equal(P.reconciliationDecision({ ...base, walletNonceNow: 7 }).decision, 'KEEP_UNCERTAIN', 'unchanged nonce proves nothing');
	assert.equal(P.reconciliationDecision({ ...base, walletNonceNow: 8 }).decision, 'KEEP_UNCERTAIN', 'advanced nonce proves nothing');
	assert.equal(P.reconciliationDecision({ ...base, walletNonceNow: 7, scannedToBlock: 100n + 64n }).decision, 'KEEP_UNCERTAIN', 'depth without the quiet period');
	assert.equal(P.reconciliationDecision({ ...base, walletNonceNow: 7, quietPeriodElapsed: true, scannedToBlock: 163n }).decision, 'KEEP_UNCERTAIN', 'quiet period without depth');
	assert.equal(P.reconciliationDecision({ ...base, walletNonceNow: 7, quietPeriodElapsed: true, scannedToBlock: 164n }).decision, 'RECORD_NO_TX');
	assert.deepEqual({ ...P.reconciliationDecision({ ...base, walletNonceNow: 8, matches: [H(5)] }) }, { decision: 'BIND_TX', txHash: H(5), source: 'CHAIN_RECONCILIATION' });
	assert.equal(P.reconciliationDecision({ ...base, walletNonceNow: 9, quietPeriodElapsed: true, scannedToBlock: 999n, matches: [H(5), H(6)] }).decision, 'OPERATOR_REQUIRED');
	assert.equal(P.RECONCILIATION_QUIET_SECONDS, 1800);
	assert.match(read(MIGRATION), /now\(\) >= a\.wallet_request_started_at \+ interval '30 minutes'/, 'the database checks the same quiet period');
	assert.match(P.WALLET_MODELS.EOA_INJECTED.nonce, /never authorization/);
});

test('P4J-REPLACEMENT a replacement transaction never replaces the first binding', () => {
	assert.equal(P.classifyReplacement({ boundTxHash: H(1), observedTxHash: H(1) }), 'SAME_TRANSACTION');
	assert.equal(P.classifyReplacement({ boundTxHash: H(1), observedTxHash: H(2) }), 'REPLACEMENT_SUSPECTED_KEEP_FIRST_BINDING');
	assert.throws(() => P.classifyReplacement({ boundTxHash: null, observedTxHash: H(2) }), /TX_HASH/);
	assert.ok(P.RESIDUAL_AMBIGUITY.some((x) => /replace/.test(x) && /TX_REPLACED/.test(x)));
});

const session = Object.freeze({ wallet: W1, chainId: 1, to: BROKER, value: 0n, data: '0x7c59cac4' + '00'.repeat(32) });

test('P4J-SIWE-BINDING SIWE wallet == intent wallet == session wallet == from; no arbitrary from; the adapter may not alter any field', () => {
	const attemptId = randomUUID();
	const ok = P.buildWalletRequest({ session, attemptId, siweWallet: W1, intentWallet: W1 });
	assert.equal(ok.ok, true);
	assert.deepEqual({ ...ok.request }, { chainId: 1, from: W1, to: BROKER, value: 0n, data: session.data, executionAttemptId: attemptId });
	assert.deepEqual(Object.keys(ok.request).sort(), [...P.WALLET_REQUEST_FIELDS].sort());
	const other = '0x00000000000000000000000000000000000000b2';
	assert.equal(P.buildWalletRequest({ session, attemptId, siweWallet: other, intentWallet: W1 }).code, 'WALLET_MISMATCH');
	assert.equal(P.buildWalletRequest({ session, attemptId, siweWallet: W1, intentWallet: other }).code, 'WALLET_MISMATCH');
	assert.equal(P.buildWalletRequest({ session: { ...session, wallet: other }, attemptId, siweWallet: W1, intentWallet: W1 }).code, 'WALLET_MISMATCH');
	assert.equal(P.buildWalletRequest({ session, attemptId, siweWallet: W1.toUpperCase().replace('0X', '0x'), intentWallet: W1 }).code, 'WALLET_FORMAT');
	assert.equal(P.buildWalletRequest({ session: { ...session, chainId: 10 }, attemptId, siweWallet: W1, intentWallet: W1 }).code, 'SESSION_FIELDS');
	assert.equal(P.buildWalletRequest({ session: { ...session, value: 1n }, attemptId, siweWallet: W1, intentWallet: W1 }).code, 'SESSION_FIELDS');
	assert.equal(P.buildWalletRequest({ session, attemptId: 'x', siweWallet: W1, intentWallet: W1 }).code, 'ATTEMPT_ID');
	const req = ok.request;
	assert.equal(P.checkAdapterRequest(req, { ...req }), 'UNCHANGED');
	for (const [k, v] of [['chainId', 10], ['from', other], ['to', other], ['value', 1n], ['data', '0x095ea7b3'], ['executionAttemptId', randomUUID()]]) {
		assert.equal(P.checkAdapterRequest(req, { ...req, [k]: v }), 'ADAPTER_ALTERED', k);
	}
	for (const extra of ['gas', 'nonce', 'maxFeePerGas', 'accessList']) assert.equal(P.checkAdapterRequest(req, { ...req, [extra]: 1 }), 'ADAPTER_ALTERED', extra);
	const { data, ...missing } = req;
	assert.equal(P.checkAdapterRequest(req, missing), 'ADAPTER_ALTERED');
});

test('P4J-OBSERVED-TX a hash is bound from the chain only for a transaction with exactly the requested from, to, value, data and chain', () => {
	const req = P.buildWalletRequest({ session, attemptId: randomUUID(), siweWallet: W1, intentWallet: W1 }).request;
	const tx = { hash: H(9), from: W1, to: BROKER, value: 0n, input: session.data, chainId: 1 };
	assert.deepEqual({ ...P.verifyObservedTransaction({ request: req, tx }) }, { ok: true, txHash: H(9) });
	assert.equal(P.verifyObservedTransaction({ request: req, tx: { ...tx, from: W1.toUpperCase().replace('0X', '0x') } }).ok, true, 'the checksum case of an RPC answer is normalised');
	for (const [k, v, code] of [['from', '0x00000000000000000000000000000000000000c3', 'FROM'], ['to', W1, 'TO'], ['value', 1n, 'VALUE'], ['input', '0x095ea7b3', 'DATA'], ['chainId', 10, 'CHAIN'], ['hash', 'x', 'TX']]) {
		assert.equal(P.verifyObservedTransaction({ request: req, tx: { ...tx, [k]: v } }).code, code, k);
	}
});

test('P4J-SEQUENCE no approval when the allowance suffices; otherwise approval first, independently verified, then a fresh buyCover', () => {
	assert.deepEqual([...P.planAuthorities({ allowanceRaw: 3_030_584n, requiredRaw: 3_030_584n })], ['NEXUS_BUY_COVER']);
	assert.deepEqual([...P.planAuthorities({ allowanceRaw: 3_030_583n, requiredRaw: 3_030_584n })], ['USDC_APPROVAL', 'NEXUS_BUY_COVER']);
	assert.throws(() => P.planAuthorities({ allowanceRaw: 1, requiredRaw: 2n }), /AMOUNTS/);
	const ok = { receiptStatus: 'success', allowanceRaw: 3_030_584n, requiredRaw: 3_030_584n, verifiedAtBlock: 101n, minedAtBlock: 100n };
	assert.equal(P.assessApproval(ok).outcome, 'VERIFIED');
	assert.equal(P.assessApproval({ ...ok, receiptStatus: 'reverted' }).outcome, 'FAILED');
	assert.equal(P.assessApproval({ ...ok, allowanceRaw: 3_030_583n }).outcome, 'FAILED');
	assert.equal(P.assessApproval({ ...ok, verifiedAtBlock: 99n }).outcome, 'PENDING', 'a read before mining verifies nothing');
	const sql = strip(read(MIGRATION));
	assert.match(sql, /s\.verified_block >= a\.approval_verified_block/, 'the buyCover session must be verified from the approval check on');
	assert.match(sql, /if p_allowance_raw < needed then return jsonb_build_object\('status', 'rejected', 'code', 'ALLOWANCE_INSUFFICIENT'\)/);
	assert.match(sql, /if saved\.transaction_kind <> 'NEXUS_BUY_COVER' then return jsonb_build_object\('status', 'rejected', 'code', 'NOT_A_PURCHASE'\)/);
});

test('P4J-CRASH every crash window names the authoritative state, a safe retry, the new-session rule and whether the chain must be read', () => {
	assert.deepEqual(P.CRASH_WINDOWS.map((c) => c.id), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
	for (const c of P.CRASH_WINDOWS) for (const k of ['window', 'authoritative', 'safeRetry', 'newSession', 'chainLookup', 'operator']) assert.ok(Object.hasOwn(c, k), `${c.id} ${k}`);
	const byId = Object.fromEntries(P.CRASH_WINDOWS.map((c) => [c.id, c]));
	assert.equal(byId.C1.chainLookup, false);
	assert.equal(byId.C2.chainLookup, true);
	assert.equal(byId.C3.chainLookup, true);
	assert.match(byId.C2.safeRetry, /not called again/);
	assert.match(byId.C4.safeRetry, /never from the caller/);
	assert.match(byId.C6.newSession, /only NEXUS_BUY_COVER and only after APPROVAL_VERIFIED/);
});

test('P4J-WALLET-MODELS EOA, WalletConnect and Safe are modelled, none implemented; a Safe proposal hash is never a chain hash', () => {
	assert.deepEqual(Object.keys(P.WALLET_MODELS).sort(), ['EOA_INJECTED', 'SAFE_ERC1271', 'WALLETCONNECT']);
	for (const m of Object.values(P.WALLET_MODELS)) { assert.equal(m.implemented, false); assert.match(m.nonce, /evidence/); assert.match(m.duplicateProtection, /write-ahead/); }
	assert.match(P.WALLET_MODELS.SAFE_ERC1271.authority, /ERC-1271/);
	assert.match(P.WALLET_MODELS.SAFE_ERC1271.txHash, /never bound/);
	assert.equal(P.GUARANTEES.exactlyOnce, 'NOT_CLAIMED');
	assert.match(P.GUARANTEES.dbAuthorization, /^AT_MOST_ONCE/);
	assert.match(P.GUARANTEES.chainTransaction, /^DETERMINED_BY_CHAIN/);
	assert.ok(P.RESIDUAL_AMBIGUITY.some((x) => /frontend JavaScript/.test(x) && /not impossible/.test(x)), 'wallet display stays the last line');
});

/** Client, der jeden Aufruf mitschreibt (ohne Datenbank). */
function recorder(answer) {
	const calls = [];
	return { calls, client: { async rpc(name, args) { calls.push({ name, args }); return { data: answer(name, args), error: null }; } } };
}
const rowFor = (args, patch = {}) => ({ attempt_id: args.p_attempt_id, session_id: args.p_session_id ?? randomUUID(), intent_id: args.p_intent_id ?? randomUUID(), wallet: W1, transaction_kind: 'NEXUS_BUY_COVER',
	consumer_request_id: args.p_consumer_request_id, state: 'AUTHORIZED', abort_reason: null, tx_hash: null, tx_hash_source: null, approval_verified_block: null, created_at: 1, wallet_request_started_at: null, settled_at: null, ...patch });

test('P4J-HELPER-INPUT each operation calls one fixed function with exactly its arguments; caller facts are refused before any call; only the write-ahead winner is permitted', async () => {
	const id = randomUUID(), key = randomUUID(), sid = randomUUID(), iid = randomUUID();
	const rec = recorder((name, args) => ({ status: name === 'start_cover_purchase_execution_attempt' ? 'started' : 'created', attempt: rowFor(args, { state: 'WALLET_REQUEST_STARTED', wallet_request_started_at: 2 }) }));
	assert.equal((await A.startWalletRequest(rec.client, { attemptId: id, consumerRequestId: key })).status, 'WALLET_REQUEST_PERMITTED');
	assert.deepEqual(rec.calls, [{ name: 'start_cover_purchase_execution_attempt', args: { p_attempt_id: id, p_consumer_request_id: key } }]);
	const replay = recorder((n, args) => ({ status: 'not_started', code: 'ALREADY_STARTED', attempt: rowFor(args, { state: 'UNCERTAIN', wallet_request_started_at: 2 }) }));
	assert.equal((await A.startWalletRequest(replay.client, { attemptId: id, consumerRequestId: key })).status, 'ALREADY_STARTED');
	const busy = recorder(() => ({ status: 'rejected', code: 'WALLET_BUSY' }));
	assert.deepEqual(await A.startWalletRequest(busy.client, { attemptId: id, consumerRequestId: key }), { status: 'REJECTED', code: 'WALLET_BUSY', attempt: null });
	// eine Antwortzeile fuer einen anderen Versuch oder eine andere Anfrage ist ein Fehler, kein Ergebnis
	const foreign = recorder((n, args) => ({ status: 'started', attempt: rowFor({ ...args, p_attempt_id: randomUUID() }, { state: 'WALLET_REQUEST_STARTED' }) }));
	await assert.rejects(A.startWalletRequest(foreign.client, { attemptId: id, consumerRequestId: key }), /attempt row attempt_id/);
	const extraCol = recorder((n, args) => ({ status: 'started', attempt: { ...rowFor(args), signature: '0x' } }));
	await assert.rejects(A.startWalletRequest(extraCol.client, { attemptId: id, consumerRequestId: key }), /attempt row shape/);
	// feste Argumente je Operation
	const all = recorder((name, args) => ({ status: 'existing', attempt: rowFor(args) }));
	await A.openExecutionAttempt(all.client, { attemptId: id, sessionId: sid, consumerRequestId: key }).catch(() => {});
	await A.recordWalletRejection(all.client, { attemptId: id, consumerRequestId: key });
	await A.recordWalletUncertain(all.client, { attemptId: id, consumerRequestId: key });
	await A.bindTransactionHash(all.client, { attemptId: id, consumerRequestId: key, txHash: H(3), source: 'WALLET_RESPONSE' });
	await A.reconcileNoTransaction(all.client, { attemptId: id, consumerRequestId: key, scannedToBlock: 5n, walletNonce: 1 });
	await A.submitPurchaseAttempt(all.client, { attemptId: id, consumerRequestId: key, intentId: iid, txNonce: 1 }).catch(() => {});
	await A.settleApprovalAttempt(all.client, { attemptId: id, consumerRequestId: key, outcome: 'VERIFIED', verifiedAtBlock: 5n, allowanceRaw: 9n });
	assert.deepEqual(all.calls.map((c) => [c.name, Object.keys(c.args).sort()]), [
		['open_cover_purchase_execution_attempt', ['p_attempt_id', 'p_consumer_request_id', 'p_session_id']],
		['reject_cover_purchase_execution_attempt', ['p_attempt_id', 'p_consumer_request_id']],
		['mark_cover_purchase_execution_attempt_uncertain', ['p_attempt_id', 'p_consumer_request_id']],
		['bind_cover_purchase_execution_attempt_tx_hash', ['p_attempt_id', 'p_consumer_request_id', 'p_source', 'p_tx_hash']],
		['reconcile_cover_purchase_execution_attempt_no_tx', ['p_attempt_id', 'p_consumer_request_id', 'p_scanned_to_block', 'p_wallet_nonce']],
		['submit_cover_purchase_execution_attempt', ['p_attempt_id', 'p_consumer_request_id', 'p_intent_id', 'p_tx_nonce']],
		['settle_cover_purchase_approval_attempt', ['p_allowance_raw', 'p_attempt_id', 'p_consumer_request_id', 'p_outcome', 'p_verified_block']]
	]);
	assert.deepEqual(all.calls.find((c) => c.name === 'settle_cover_purchase_approval_attempt').args, { p_attempt_id: id, p_consumer_request_id: key, p_outcome: 'VERIFIED', p_verified_block: '5', p_allowance_raw: '9' });
	// Eingaben, die nie zur Datenbank gehen
	const none = recorder(() => { throw new Error('must not be called'); });
	for (const [fn, input, err] of [
		[A.submitPurchaseAttempt, { attemptId: id, consumerRequestId: key, intentId: iid, txNonce: 1, txHash: H(4) }, /CLIENT_FIELD:txHash/],
		[A.startWalletRequest, { attemptId: id, consumerRequestId: key, state: 'AUTHORIZED' }, /CLIENT_FIELD:state/],
		[A.openExecutionAttempt, { attemptId: id, sessionId: sid, consumerRequestId: key, wallet: W1 }, /CLIENT_FIELD:wallet/],
		[A.openExecutionAttempt, { attemptId: 'x', sessionId: sid, consumerRequestId: key }, /ATTEMPT_ID/],
		[A.bindTransactionHash, { attemptId: id, consumerRequestId: key, txHash: H(4), source: 'BROWSER' }, /SOURCE/],
		[A.bindTransactionHash, { attemptId: id, consumerRequestId: key, txHash: H(4).toUpperCase(), source: 'WALLET_RESPONSE' }, /TX_HASH/],
		[A.reconcileNoTransaction, { attemptId: id, consumerRequestId: key, scannedToBlock: 5, walletNonce: 1 }, /BLOCK/],
		[A.settleApprovalAttempt, { attemptId: id, consumerRequestId: key, outcome: 'VERIFIED', verifiedAtBlock: 5n, allowanceRaw: -1n }, /ALLOWANCE/],
		[A.settleApprovalAttempt, { attemptId: id, consumerRequestId: key, outcome: 'CONFIRMED' }, /OUTCOME/]
	]) await assert.rejects(fn(none.client, input), err, JSON.stringify(Object.keys(input)));
	assert.equal(none.calls.length, 0);
});

test('P4J-NOEXEC no wallet, send, sign or permission method and no generic database path in the P4J code', () => {
	for (const file of [...MODULES, MIGRATION, 'test-support/purchase-execution-attempt-pg.mjs']) {
		const full = read(file);
		assert.doesNotMatch(full, /eth_sendTransaction|eth_sendRawTransaction|wallet_sendCalls|sendTransaction|writeContract|createWalletClient|signTransaction|wallet_requestPermissions|personal_sign|signTypedData|eth_sign\b|approve\(|buyCover\(/i, file);
	}
	for (const file of MODULES) {
		const source = strip(read(file));
		assert.doesNotMatch(source, /executeSql|genericRpc|updateAttempt|\.from\(|\.query\(|process\.env|fetch\(|https?:\/\/|\.request\(|privateKey|encodeFunctionData|purchase-tx-builder|window\.|ethereum/, file);
	}
	assert.deepEqual([...strip(read(MODULES[0])).matchAll(/^import .*$/gm)], [], 'the protocol imports nothing');
	const helper = strip(read(MODULES[1]));
	assert.deepEqual([...helper.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['./purchase-execution-protocol.mjs']);
	assert.deepEqual([...helper.matchAll(/call\(client, '([a-z_]+)'/g)].map((m) => m[1]).sort(), FUNCTIONS, 'each operation calls exactly one fixed function');
	assert.equal(helper.match(/client\.rpc\(/g).length, 1, 'one rpc site, fixed names only');
	assert.deepEqual(Object.keys(A).sort(), ['bindTransactionHash', 'openExecutionAttempt', 'reconcileNoTransaction', 'recordWalletRejection', 'recordWalletUncertain', 'settleApprovalAttempt', 'startWalletRequest', 'submitPurchaseAttempt']);
	const migration = strip(read(MIGRATION));
	assert.doesNotMatch(migration.replace(/^grant execute on function public\.[a-z_]+\([^)]*\) to service_role;$/gm, '').replace(/^for each (row|statement) execute function public\.cover_purchase_execution_attempts_guard\(\);$/gm, ''), /\bexecute\b|grant\s+(select|insert|update|delete|truncate|all)|\bdelete\s+from\b|\bformat\s*\(/i);
	assert.equal(migration.match(/^grant execute on function public\.[a-z_]+\([^)]*\) to service_role;$/gm).length, FUNCTIONS.length);
	assert.doesNotMatch(migration, /create trigger [a-z_]+\s+before [a-z ]+ on public\.cover_purchase_(intents|execution_sessions)\b/, 'no new trigger on the P4D or P4I tables');
	assert.doesNotMatch(migration, /create or replace function public\.(create|consume)_cover_purchase_execution_session|create or replace function public\.(mark|cancel|expire|create)_cover_purchase_intent/, 'no P4D or P4I function replaced');
});

test('P4J-IMPORT no runtime code reaches the protocol or the attempt store; no purchase, execution or wallet route exists', () => {
	const runtime = [...walk('src'), ...walk('api'), ...walk('web'), ...walk('scripts')].filter((f) => !MODULES.includes(f) && !f.startsWith('web/dist'));
	assert.ok(runtime.includes('src/bot.mjs') && runtime.some((f) => f.startsWith('api/')) && runtime.some((f) => f.startsWith('web/src/')) && runtime.some((f) => /^src\/agent-/.test(f)));
	for (const file of runtime) assert.doesNotMatch(read(file), /purchase-execution-(protocol|attempt-db)(\.mjs)?['"`]|cover_purchase_execution_attempt|startWalletRequest|requestTransaction/, file);
	const importing = /(?:from\s*|import\s*\(\s*)['"`][^'"`]*purchase-execution-(protocol|attempt-db)\.mjs/;
	assert.deepEqual([...walk('src'), ...walk('api'), ...walk('test'), ...walk('test-support')].filter((f) => importing.test(read(f))).sort(),
		['src/purchase-execution-attempt-db.mjs', 'test-support/purchase-execution-attempt-pg.mjs', 'test/purchase-execution-attempt-db-concurrency.test.mjs', 'test/purchase-execution-attempt-db.test.mjs', 'test/purchase-execution-protocol.test.mjs']);
	assert.deepEqual(walk('api').filter((f) => /purchase|buy|wallet|execution|session|intent|confirm|attempt/i.test(f)), []);
	for (const route of ['api/purchase', 'api/execution', 'api/wallet', 'api/nexus/buy', 'api/attempt']) assert.ok(!walk('api').some((f) => f.startsWith(route)), route);
	assert.doesNotMatch(JSON.stringify(JSON.parse(read('vercel.json'))), /purchase|buy|execution|session|intent|attempt/i, 'no route, rewrite or cron');
});
