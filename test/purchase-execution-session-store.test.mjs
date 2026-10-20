/**
 * Nexus P4I (20.10.2026): Sitzungsspeicher src/purchase-execution-session-db.mjs ohne Datenbank -
 * Hash-Hoheit (der Hash wird neu berechnet, nie uebernommen), die Form einer echten P4H-Sitzung,
 * nur Kennungen beim Verbrauch, kein Wallet-, Sende- oder Signierpfad und keine Laufzeit-Reichweite.
 * Laeuft immer; die Datenbank-Tests stehen in test/purchase-execution-session-db.test.mjs und
 * test/purchase-execution-session-db-concurrency.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { keccak256, encodeFunctionData, parseAbi } from 'viem';
import { freshWallet, hash32 } from '../test-support/purchase-intent-pg.mjs';
import { sessionFor, buyData, BROKER, USDC } from '../test-support/purchase-execution-session-pg.mjs';
const X = await import('../src/purchase-execution-session-db.mjs');
const S = await import('../src/purchase-execution-session.mjs');

const FUNCTIONS = ['consume_cover_purchase_execution_session', 'create_cover_purchase_execution_session'];
const MIGRATION = 'supabase/migrations/20261020140000_cover_purchase_execution_sessions.sql';
const MODULE = 'src/purchase-execution-session-db.mjs';

/** Client, der jeden Aufruf mitschreibt (ohne Datenbank). */
function recorder(answer = () => ({ status: 'rejected', code: 'TEST' })) {
	const calls = [];
	return { calls, client: { async rpc(name, args) { calls.push({ name, args }); return { data: answer(name, args), error: null }; } } };
}

/* ------------------------------------------------- Hash-Hoheit ohne Datenbank -- */

test('P4I-HASH-AUTHORITY the helper recomputes the P4H session hash and persists only that value; a tampered field with the old hash is refused before any call', async () => {
	const built = { intent: { id: randomUUID(), wallet: freshWallet() }, intentHash: hash32('ih'), data: buyData('x'), calldataHash: keccak256(buyData('x')) };
	const s = sessionFor(built);
	const r = recorder();
	await X.persistExecutionSession(r.client, { session: s });
	assert.equal(r.calls.length, 1);
	assert.equal(r.calls[0].name, 'create_cover_purchase_execution_session');
	assert.equal(r.calls[0].args.p_session_hash, S.computeExecutionSessionHash(s));
	assert.equal(r.calls[0].args.p_session_hash, s.executionSessionHash);
	assert.deepEqual(Object.keys(r.calls[0].args).sort(), ['p_calldata_hash', 'p_chain_id', 'p_data', 'p_expires_at', 'p_intent_hash', 'p_intent_id', 'p_session_hash', 'p_session_id', 'p_target', 'p_transaction_kind', 'p_value_raw', 'p_verified_block', 'p_verified_block_hash', 'p_wallet']);
	const tampered = {
		verifiedAtBlock: s.verifiedAtBlock + 1n, verifiedAtBlockHash: hash32('other-block'), to: USDC, wallet: freshWallet(), expiresAt: s.expiresAt - 1, intentHash: hash32('other-intent'),
		sessionId: randomUUID(), intentId: randomUUID(), transactionKind: 'USDC_APPROVAL'
	};
	for (const [k, v] of Object.entries(tampered)) {
		const q = recorder();
		assert.deepEqual(await X.persistExecutionSession(q.client, { session: { ...s, [k]: v } }), { status: 'rejected', code: 'TAMPERED' }, k);
		assert.equal(q.calls.length, 0, k);
	}
	// data: neue Bytes mit passendem dataHash, aber altem Sitzungs-Hash
	const data = `${s.data}00`;
	for (const patch of [{ data, dataHash: keccak256(data), calldataHash: keccak256(data) }, { executionSessionHash: hash32('forged') }]) {
		const q = recorder();
		assert.deepEqual(await X.persistExecutionSession(q.client, { session: { ...s, ...patch } }), { status: 'rejected', code: 'TAMPERED' }, Object.keys(patch).join());
		assert.equal(q.calls.length, 0);
	}
	// Form: fehlende/zusaetzliche Felder, Bytes ohne passenden dataHash, buyCover ohne calldata-Bindung, Fenster > 30 s
	const shapes = [
		[{ ...s, extra: 1 }, 'SESSION_SHAPE'], [(({ toctou, ...rest }) => rest)(s), 'SESSION_SHAPE'], [{ ...s, data: `${s.data}00` }, 'DATA'], [{ ...s, calldataHash: hash32('c') }, 'CALLDATA_HASH_MISMATCH'],
		[{ ...s, expiresAt: s.createdAt + 31 }, 'WINDOW'], [{ ...s, value: 1n }, 'FIELD'], [{ ...s, chainId: 10 }, 'FIELD'], [{ ...s, wallet: `0xAB${s.wallet.slice(4).toUpperCase()}` }, 'ADDRESS'],
		[{ ...s, verifiedAtBlock: 0n }, 'BLOCK'], [{ ...s, verifiedAtBlock: 5 }, 'BLOCK'], [{ ...s, singleUse: false }, 'SINGLE_USE'], [null, 'SESSION_SHAPE']
	];
	for (const [session, code] of shapes) {
		const q = recorder();
		assert.deepEqual(await X.persistExecutionSession(q.client, { session }), { status: 'rejected', code }, code);
		assert.equal(q.calls.length, 0);
	}
});

test('P4I-P4H-SHAPE a genuine P4H createExecutionSession result is accepted unchanged and its hash recomputed', async () => {
	const PW = await import('../test-support/purchase-pre-send-world.mjs');
	const RW = await import('../test-support/purchase-receipt-world.mjs');
	const I = await import('../src/purchase-intent.mjs');
	const { TS } = PW;
	const id = '0b9e6f1c-3d2a-4f5b-8c7d-1e2f3a4b5c6d';
	const i = RW.intent({ id, quoteFetchedAt: TS - 20, capacityFetchedAt: TS - 20, acknowledgedAt: TS - 15, expiresAt: TS + 550 });
	const data = RW.calldata(RW.WALLET);
	const row = {
		id: i.id, wallet: i.wallet, chain_id: i.chainId, deployment_key: i.deploymentKey, product_id: i.productId, product_type_id: i.productTypeId, cover_asset_id: i.coverAssetId,
		amount_raw: i.amountRaw, period_days: i.periodDays, quote_premium_raw: i.quotePremiumRaw, max_premium_raw: i.maxPremiumRaw, quote_fetched_at: i.quoteFetchedAt,
		capacity_fetched_at: i.capacityFetchedAt, wording_cid: i.wordingCid, annex_cid: i.annexCid, terms_version: 'coverraccoon.terms/1', terms_hash: i.termsHash,
		proof_of_loss_cid: i.proofOfLossCid, commission_ratio: i.commissionRatio, commission_destination: i.commissionDestination, pin_version: i.pinVersion,
		intent_hash: I.computePurchaseIntentHash(i), acknowledged_at: i.acknowledgedAt, expires_at: i.expiresAt, status: 'BUILT', calldata_hash: keccak256(data),
		built_at: TS - 10, build_deadline: TS + 110, tx_hash: null, cover_id: null
	};
	const repository = { async loadIntentForExecution() { return { status: 'found', intent: structuredClone(row) }; } };
	const w = PW.world();
	const res = await S.prepareExecutionSession({ repository, rpcA: PW.reader(w), rpcB: PW.reader(structuredClone(w)), intentId: id, now: TS + 5, sessionId: '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c',
		transaction: { kind: 'NEXUS_BUY_COVER', chainId: 1, to: BROKER, value: 0n, data } });
	assert.equal(res.status, 'SESSION_CREATED', JSON.stringify(res.errors));
	const r = recorder();
	await X.persistExecutionSession(r.client, { session: res.session });
	assert.equal(r.calls.length, 1, 'a genuine P4H session passes the helper');
	assert.equal(r.calls[0].args.p_session_hash, res.session.executionSessionHash);
	assert.equal(r.calls[0].args.p_verified_block, res.session.verifiedAtBlock.toString());
	assert.equal(r.calls[0].args.p_expires_at, res.session.expiresAt);
	const approve = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
	const ap = await S.prepareExecutionSession({ repository, rpcA: PW.reader(w), rpcB: PW.reader(structuredClone(w)), intentId: id, now: TS + 5, sessionId: '4f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c',
		transaction: { kind: 'USDC_APPROVAL', chainId: 1, to: USDC, value: 0n, data: encodeFunctionData({ abi: approve, functionName: 'approve', args: [BROKER, BigInt(i.maxPremiumRaw)] }) } });
	assert.equal(ap.status, 'SESSION_CREATED', JSON.stringify(ap.errors));
	const q = recorder();
	await X.persistExecutionSession(q.client, { session: ap.session });
	assert.equal(q.calls.length, 1);
	assert.equal(q.calls[0].args.p_transaction_kind, 'USDC_APPROVAL');
});

test('P4I-CONSUME-INPUT the consumer supplies only identifiers and the idempotency key; transaction facts from the caller are refused before any call', async () => {
	const ok = { sessionId: randomUUID(), sessionHash: hash32('s'), intentId: randomUUID(), consumerRequestId: randomUUID() };
	const r = recorder(() => ({ status: 'rejected', code: 'SESSION_MISMATCH' }));
	assert.deepEqual(await X.consumeExecutionSession(r.client, ok), { status: 'REJECTED', code: 'SESSION_MISMATCH', session: null });
	assert.deepEqual(r.calls, [{ name: 'consume_cover_purchase_execution_session', args: { p_session_id: ok.sessionId, p_session_hash: ok.sessionHash, p_intent_id: ok.intentId, p_consumer_request_id: ok.consumerRequestId } }]);
	for (const extra of ['wallet', 'target', 'to', 'data', 'value', 'block', 'blockHash', 'verifiedAtBlock', 'verifiedAtBlockHash', 'intentHash', 'calldataHash', 'status', 'expiresAt', 'transactionKind']) {
		const q = recorder();
		assert.equal((await X.consumeExecutionSession(q.client, { ...ok, [extra]: '0x00' })).code, 'INPUT_SHAPE', extra);
		assert.equal(q.calls.length, 0, extra);
	}
	for (const [k, v] of [['sessionId', 'x'], ['intentId', 5], ['consumerRequestId', null], ['sessionHash', hash32('s').toUpperCase()]]) {
		const q = recorder();
		assert.equal((await X.consumeExecutionSession(q.client, { ...ok, [k]: v })).status, 'REJECTED', k);
		assert.equal(q.calls.length, 0, k);
	}
	const { consumerRequestId, ...noKey } = ok;
	assert.equal((await X.consumeExecutionSession(recorder().client, noKey)).code, 'INPUT_SHAPE', 'the idempotency key is required');
});

/* ------------------------------------------------------ statisch, Reichweite -- */

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const walk = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).flatMap((n) => (n === 'node_modules' || n === 'dist' || n.startsWith('.') ? [] : statSync(new URL(`../${dir}/${n}`, import.meta.url)).isDirectory() ? walk(`${dir}/${n}`) : /\.(m?js|cjs|ts|tsx|jsx|html|svelte|vue)$/.test(n) ? [`${dir}/${n}`] : []));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--).*$/gm, '');

test('P4I-NOEXEC no wallet, send or sign method and no generic database path in the P4I code', () => {
	for (const file of [MODULE, MIGRATION, 'test-support/purchase-execution-session-pg.mjs']) {
		const full = read(file);
		assert.doesNotMatch(full, /eth_sendTransaction|eth_sendRawTransaction|wallet_sendCalls|sendTransaction|writeContract|createWalletClient|signTransaction|personal_sign|signTypedData|eth_sign\b|WalletConnect|approve\(|buyCover\(/i, file);
	}
	const source = strip(read(MODULE));
	assert.doesNotMatch(source, /updateSession|executeSql|genericRpc|\.from\(|\.query\(|process\.env|fetch\(|https?:\/\/|\.request\(|privateKey|encodeFunctionData|purchase-tx-builder/);
	assert.deepEqual([...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['viem', './purchase-execution-session.mjs']);
	assert.deepEqual([...source.matchAll(/call\(client, '([a-z_]+)'/g)].map((m) => m[1]).sort(), FUNCTIONS, 'each operation calls exactly one fixed function');
	assert.equal(source.match(/client\.rpc\(/g).length, 1, 'one rpc site, fixed names only');
	assert.deepEqual(Object.keys(X).sort(), ['CONSUME_STATUSES', 'SINGLE_USE_ENFORCEMENT', 'consumeExecutionSession', 'persistExecutionSession']);
	assert.equal(X.SINGLE_USE_ENFORCEMENT, 'PERSISTED_DB_COMPARE_AND_SET');
	const migration = strip(read(MIGRATION));
	assert.doesNotMatch(migration.replace(/^grant execute on function public\.[a-z_]+\([^)]*\) to service_role;$/gm, '').replace(/^for each (row|statement) execute function public\.cover_purchase_execution_sessions_guard\(\);$/gm, ''), /\bexecute\b|grant\s+(select|insert|update|delete|truncate|all)|\bdelete\s+from\b|\bformat\s*\(/i);
	assert.equal(migration.match(/^grant execute on function public\.[a-z_]+\([^)]*\) to service_role;$/gm).length, FUNCTIONS.length);
});

test('P4I-IMPORT no runtime code reaches the session store; no purchase, execution or wallet route exists', () => {
	const runtime = [...walk('src'), ...walk('api'), ...walk('web'), ...walk('scripts')].filter((f) => f !== MODULE && !f.startsWith('web/dist'));
	assert.ok(runtime.includes('src/bot.mjs') && runtime.some((f) => f.startsWith('api/')) && runtime.some((f) => f.startsWith('web/src/')) && runtime.some((f) => /^src\/agent-/.test(f)));
	for (const file of runtime) assert.doesNotMatch(read(file), /purchase-execution-session-db(\.mjs)?['"`]|cover_purchase_execution_session|persistExecutionSession|consumeExecutionSession/, file);
	const importing = /(?:from\s*|import\s*\(\s*)['"`][^'"`]*purchase-execution-session-db\.mjs/;
	assert.deepEqual([...walk('src'), ...walk('api'), ...walk('test'), ...walk('test-support')].filter((f) => importing.test(read(f))).sort(),
		['test-support/purchase-execution-attempt-pg.mjs', 'test/purchase-execution-attempt-db.test.mjs', 'test/purchase-execution-session-db-concurrency.test.mjs', 'test/purchase-execution-session-db.test.mjs', 'test/purchase-execution-session-store.test.mjs']);
	assert.deepEqual(walk('api').filter((f) => /purchase|buy|wallet|execution|session|intent|confirm/i.test(f)), []);
	for (const route of ['api/purchase', 'api/execution', 'api/wallet', 'api/nexus/buy']) assert.ok(!walk('api').some((f) => f.startsWith(route)), route);
	const vercel = JSON.parse(read('vercel.json'));
	assert.doesNotMatch(JSON.stringify(vercel), /purchase|buy|execution|session|intent/i, 'no route, rewrite or cron');
});
