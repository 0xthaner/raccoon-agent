/**
 * Nexus P4H (20.10.2026): kurzlebige Ausfuehrungs-Sitzung ohne Senden (src/purchase-execution-session.mjs).
 *
 * P4F laeuft ECHT gegen die ECHTE Kette am Block 26230166 (test-support/purchase-pre-send-world.mjs,
 * Zwei-Anbieter-Mitschnitt); der Intent ist SYNTHETISCH, die buyCover-Bytes sind aus der verifizierten
 * ABI konstruiert (test-support/purchase-receipt-world.mjs), nie aus dem Builder. Nichts wird gesendet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi } from 'viem';
const S = await import('../src/purchase-execution-session.mjs');
const P = await import('../src/purchase-pre-send.mjs');
const I = await import('../src/purchase-intent.mjs');
const PW = await import('../test-support/purchase-pre-send-world.mjs');
const RW = await import('../test-support/purchase-receipt-world.mjs');
const loader = await import('../src/purchase-runtime-loader.mjs');

const { TS, STATE } = PW;
const ID = '0b9e6f1c-3d2a-4f5b-8c7d-1e2f3a4b5c6d';
const SESSION_ID = '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c';
const WALLET = RW.WALLET, OTHER = RW.OTHER;
const BROKER = '0xcb2b736652d2dbf7d72e4db880cf6b7d99507814';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const NOW = TS + 5, BUILT_AT = TS - 10, DEADLINE = TS + 110;
const intent = (patch = {}) => RW.intent({ id: ID, quoteFetchedAt: TS - 60, capacityFetchedAt: TS - 60, acknowledgedAt: TS - 50, expiresAt: TS + 550, ...patch });

const BUY_DATA = RW.calldata(WALLET);
const ERC20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const approveData = (spender = BROKER, amount = 3_030_584n) => encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [spender, amount] });
const buyTx = (patch = {}) => ({ kind: 'NEXUS_BUY_COVER', chainId: 1, to: BROKER, value: 0n, data: BUY_DATA, ...patch });
const approvalTx = (patch = {}) => ({ kind: 'USDC_APPROVAL', chainId: 1, to: USDC, value: 0n, data: approveData(), ...patch });

/** Zeile wie aus der festen Lesefunktion. */
function row(patch = {}, intentPatch = {}) {
	const i = intent(intentPatch);
	return {
		id: i.id, wallet: i.wallet, chain_id: i.chainId, deployment_key: i.deploymentKey, product_id: i.productId, product_type_id: i.productTypeId, cover_asset_id: i.coverAssetId,
		amount_raw: i.amountRaw, period_days: i.periodDays, quote_premium_raw: i.quotePremiumRaw, max_premium_raw: i.maxPremiumRaw, quote_fetched_at: i.quoteFetchedAt,
		capacity_fetched_at: i.capacityFetchedAt, wording_cid: i.wordingCid, annex_cid: i.annexCid, terms_version: 'coverraccoon.terms/1', terms_hash: i.termsHash,
		proof_of_loss_cid: i.proofOfLossCid, commission_ratio: i.commissionRatio, commission_destination: i.commissionDestination, pin_version: i.pinVersion,
		intent_hash: I.computePurchaseIntentHash(i), acknowledged_at: i.acknowledgedAt, expires_at: i.expiresAt, status: 'BUILT', calldata_hash: keccak256(BUY_DATA),
		built_at: BUILT_AT, build_deadline: DEADLINE, tx_hash: null, cover_id: null, ...patch
	};
}
function repository(r = row()) {
	const calls = [];
	return { calls, repository: { async loadIntentForExecution(id) { calls.push(id); return { status: 'found', intent: structuredClone(r) }; } } };
}
function readers(edit = () => {}, editB) {
	const a = PW.world(); edit(a);
	const b = structuredClone(a); editB?.(b);
	const calls = [];
	return { rpcA: PW.reader(a, calls), rpcB: PW.reader(b, calls), calls };
}
async function prepare({ r = row(), transaction = buyTx(), now = NOW, edit, editB, extra = {} } = {}) {
	const repo = repository(r);
	const rpc = readers(edit, editB);
	const res = await S.prepareExecutionSession({ repository: repo.repository, rpcA: rpc.rpcA, rpcB: rpc.rpcB, intentId: ID, transaction, now, sessionId: SESSION_ID, ...extra });
	return { res, repo, rpc };
}
/** Geladener Kauf + echtes P4F-Urteil fuer die reinen Tests von createExecutionSession. */
async function parts(r = row()) {
	const repo = repository(r);
	const loaded = await loader.loadPurchaseForExecution({ repository: repo.repository, intentId: ID, now: NOW });
	assert.equal(loaded.status, 'LOADED', JSON.stringify(loaded.errors));
	const rpc = readers();
	const p = loaded.purchase;
	const verdict = await P.verifyPurchasePreSend({ rpcA: rpc.rpcA, rpcB: rpc.rpcB, persistedIntent: p.intent, persistedIntentHash: p.intentHash, persistedCalldataHash: p.calldataHash,
		persistedStatus: p.status, persistedBuiltAt: p.builtAt, persistedBuildDeadline: p.buildDeadline, now: NOW });
	assert.equal(verdict.status, 'PRE_SEND_VERIFIED', JSON.stringify(verdict.errors));
	return { purchase: p, verdict };
}
const create = (base, patch = {}) => S.createExecutionSession({ purchase: base.purchase, preSendVerdict: base.verdict, transaction: buyTx(), now: NOW, sessionId: SESSION_ID, ...patch });

/* ------------------------------------------------------------ positiv -- */

test('P4H-SESSION a BUILT intent, a real PRE_SEND_VERIFIED verdict and independently decoded bytes give one short session; nothing is sent', async () => {
	const { res, repo, rpc } = await prepare();
	assert.equal(res.status, 'SESSION_CREATED', JSON.stringify(res.errors));
	assert.equal(res.ok, true);
	assert.equal(res.preSend.status, 'PRE_SEND_VERIFIED');
	assert.deepEqual(repo.calls, [ID]);
	assert.ok(rpc.calls.every((c) => P.PRE_SEND_READ_METHODS.includes(c.method)), 'only P4F read methods');
	const s = res.session;
	assert.deepEqual(Object.keys(s).sort(), ['calldataHash', 'chainId', 'createdAt', 'data', 'dataHash', 'executionSessionHash', 'expiresAt', 'intentHash', 'intentId', 'sessionId',
		'singleUse', 'singleUseEnforcement', 'to', 'toctou', 'transactionKind', 'value', 'verifiedAtBlock', 'verifiedAtBlockHash', 'wallet']);
	assert.equal(s.intentId, ID);
	assert.equal(s.intentHash, I.computePurchaseIntentHash(intent()));
	assert.equal(s.calldataHash, keccak256(BUY_DATA));
	assert.equal(s.dataHash, keccak256(BUY_DATA));
	assert.equal(s.wallet, WALLET);
	assert.equal(s.chainId, 1);
	assert.equal(s.transactionKind, 'NEXUS_BUY_COVER');
	assert.equal(s.to, BROKER);
	assert.equal(s.value, 0n);
	assert.equal(s.data, BUY_DATA);
	assert.equal(s.verifiedAtBlock, BigInt(STATE.block.number));
	assert.equal(s.verifiedAtBlockHash, STATE.block.hash);
	assert.equal(s.createdAt, NOW);
	assert.equal(s.expiresAt, NOW + 30);
	assert.equal(s.singleUse, true);
	assert.equal(s.singleUseEnforcement, 'MODEL_ONLY_NOT_PERSISTED');
	assert.equal(s.executionSessionHash, S.computeExecutionSessionHash(s));
	assert.ok(Object.isFrozen(res) && Object.isFrozen(s));
	for (const k of ['privateKey', 'signature', 'provider', 'walletClient', 'nonce', 'gas', 'from']) assert.ok(!(k in s), k);
	// die exakte USDC-Freigabe ebenso, an den Broker, genau maxPremium
	const approval = await prepare({ transaction: approvalTx() });
	assert.equal(approval.res.status, 'SESSION_CREATED', JSON.stringify(approval.res.errors));
	assert.equal(approval.res.session.to, USDC);
	assert.equal(approval.res.session.transactionKind, 'USDC_APPROVAL');
	assert.equal(approval.res.session.calldataHash, keccak256(BUY_DATA), 'bound to the persisted build');
	assert.notEqual(approval.res.session.executionSessionHash, s.executionSessionHash);
});

/* ---------------------------------------------------------------- P4F -- */

test('P4H-SESSION-PRESEND only a complete PRE_SEND_VERIFIED verdict with block, block hash and the pins creates a session', async () => {
	const base = await parts();
	assert.equal(create(base).status, 'SESSION_CREATED');
	const v = base.verdict;
	const forged = {
		'ok false': { ...v, ok: false }, 'status other': { ...v, status: 'RPC_DISAGREEMENT' }, 'ok true, RPC_DISAGREEMENT': { ...v, status: 'RPC_DISAGREEMENT', ok: true },
		'errors': { ...v, errors: ['X'] }, 'check missing': { ...v, checks: { ...v.checks, usdcImplementationCode: null } }, 'no checks': { ...v, checks: undefined },
		'block null': { ...v, verifiedAtBlock: null }, 'block zero': { ...v, verifiedAtBlock: 0n }, 'block number': { ...v, verifiedAtBlock: Number(v.verifiedAtBlock) },
		'block hash null': { ...v, verifiedAtBlockHash: null }, 'block hash short': { ...v, verifiedAtBlockHash: '0x1234' }, 'block hash upper': { ...v, verifiedAtBlockHash: v.verifiedAtBlockHash.toUpperCase() },
		'pins missing': { ...v, contractPins: null }, 'broker pin': { ...v, contractPins: { ...v.contractPins, brokerCodeHash: keccak256('0x01') } },
		'usdc impl pin': { ...v, contractPins: { ...v.contractPins, usdcImplementation: OTHER } }, 'none': null
	};
	for (const [name, verdict] of Object.entries(forged)) {
		const r = create(base, { preSendVerdict: verdict });
		assert.equal(r.status, 'PRE_SEND_NOT_VERIFIED', name);
		assert.equal(r.session, null);
	}
	// echte P4F-Ablehnungen ueber die Grenze: Uneinigkeit, Drift, Ausfall eines Lesers, Wrong chain
	const cases = {
		RPC_DISAGREEMENT: { editB: (w) => { w.blocks[STATE.block.number].hash = keccak256('0x09'); } },
		BROKER_DRIFT: { edit: (w) => { w.code[BROKER] = '0x00'; } },
		TEMPORARY_RPC_FAILURE: { editB: (w) => { w.failOn = 'eth_getCode'; } },
		WRONG_CHAIN: { edit: (w) => { w.chainId = '0x5'; } }
	};
	for (const [status, edits] of Object.entries(cases)) {
		const { res } = await prepare(edits);
		assert.equal(res.preSend.status, status);
		assert.equal(res.status, 'PRE_SEND_NOT_VERIFIED', status);
		assert.equal(res.session, null);
	}
});

/* ------------------------------------------------------------ Decoder -- */

test('P4H-SESSION-DECODE the bytes are decoded independently and checked field by field; buyCover must match the persisted calldata hash', async () => {
	const base = await parts();
	// andere Bytes als gebaut: Hash passt nicht
	const other = RW.calldata(OTHER);
	assert.equal(create(base, { transaction: buyTx({ data: other }) }).status, 'CALLDATA_HASH_MISMATCH');
	// gespeicherter Hash gehoert zu Bytes, die nicht zum Intent passen (Owner): der Decoder lehnt ab
	const bad = await parts(row({ calldata_hash: keccak256(other) }));
	const r = create(bad, { transaction: buyTx({ data: other }) });
	assert.equal(r.status, 'TRANSACTION_REJECTED');
	assert.ok(r.errors.includes('OWNER'), String(r.errors));
	// Ziel, value, Kette, Art, Zusatzfelder
	const shapes = {
		target: buyTx({ to: USDC }), value: buyTx({ value: 1n }), chain: buyTx({ chainId: 5 }), 'kind swapped': buyTx({ kind: 'USDC_APPROVAL' }), 'kind unknown': buyTx({ kind: 'SEND' }),
		'builder calldataHash': { ...buyTx(), calldataHash: keccak256(BUY_DATA) }, 'builder productionReady': { ...buyTx(), productionReady: false }, 'builder blockers': { ...buyTx(), blockers: [] },
		gas: { ...buyTx(), gas: 1n }, from: { ...buyTx(), from: WALLET }, none: null
	};
	for (const [name, transaction] of Object.entries(shapes)) {
		const x = create(base, { transaction });
		assert.notEqual(x.status, 'SESSION_CREATED', name);
		assert.equal(x.session, null, name);
	}
	// Freigabe: Spender, Betrag, unbegrenzt, Ziel
	for (const [name, transaction] of Object.entries({
		spender: approvalTx({ data: approveData(OTHER) }), amount: approvalTx({ data: approveData(BROKER, 3_030_585n) }),
		unlimited: approvalTx({ data: approveData(BROKER, 2n ** 256n - 1n) }), target: approvalTx({ to: BROKER })
	})) {
		const x = create(base, { transaction });
		assert.equal(x.status, 'TRANSACTION_REJECTED', name);
	}
	// angehaengte Bytes: nicht kanonisch
	const tail = `${BUY_DATA}00`;
	const t = await parts(row({ calldata_hash: keccak256(tail) }));
	assert.equal(create(t, { transaction: buyTx({ data: tail }) }).status, 'TRANSACTION_REJECTED');
});

/* --------------------------------------------------------------- Hash -- */

test('P4H-SESSION-HASH the session hash is a fixed ABI encoding under a versioned domain; every bound field changes it', async () => {
	const base = await parts();
	const s = create(base).session;
	assert.equal(create(base).session.executionSessionHash, s.executionSessionHash, 'deterministic');
	assert.equal(S.EXECUTION_SESSION_DOMAIN, 'coverraccoon.execution-session');
	assert.equal(S.EXECUTION_SESSION_VERSION, 1);
	const own = keccak256(encodeAbiParameters(
		['string', 'uint8', 'bytes16', 'bytes16', 'bytes32', 'bytes32', 'address', 'uint256', 'uint8', 'address', 'uint256', 'bytes', 'uint256', 'bytes32', 'uint64'].map((type) => ({ type })),
		['coverraccoon.execution-session', 1, `0x${SESSION_ID.replaceAll('-', '')}`, `0x${ID.replaceAll('-', '')}`, s.intentHash, s.calldataHash, WALLET, 1n, 2, BROKER, 0n, BUY_DATA,
			BigInt(STATE.block.number), STATE.block.hash, BigInt(s.expiresAt)]));
	assert.equal(s.executionSessionHash, own, 'independent re-encoding');
	const changed = {
		sessionId: '4f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c', intentId: '5d1c2b3a-4e5f-4a6b-9c7d-8e9f0a1b2c3d', intentHash: keccak256('0x01'), calldataHash: keccak256('0x02'),
		wallet: OTHER, chainId: 5, transactionKind: 'USDC_APPROVAL', to: USDC, value: 1n, data: `${BUY_DATA}00`, verifiedAtBlock: s.verifiedAtBlock + 1n,
		verifiedAtBlockHash: keccak256('0x03'), expiresAt: s.expiresAt - 1
	};
	const seen = new Set([s.executionSessionHash]);
	for (const [key, value] of Object.entries(changed)) {
		const h = S.computeExecutionSessionHash({ ...s, [key]: value });
		assert.ok(!seen.has(h), key);
		seen.add(h);
	}
	// Felder ausserhalb der Bindung (createdAt, dataHash, toctou) aendern den Hash nicht: sie sind abgeleitet
	assert.equal(S.computeExecutionSessionHash({ ...s, createdAt: 1 }), s.executionSessionHash);
	assert.doesNotMatch(read('src/purchase-execution-session.mjs'), /JSON\.stringify/);
});

/* ---------------------------------------------------------------- TTL -- */

test('P4H-SESSION-TTL the session lives at most 30 s and never past build_deadline or expires_at; without a window there is no session', async () => {
	assert.equal(S.SESSION_TTL_SECONDS, 30);
	const base = await parts();
	assert.equal(create(base).session.expiresAt, NOW + 30);
	// Deadline naeher als 30 s
	const nearDeadline = create(base, { now: DEADLINE - 10 });
	assert.equal(nearDeadline.status, 'SESSION_CREATED');
	assert.equal(nearDeadline.session.expiresAt, DEADLINE);
	// expires_at naeher als Deadline und 30 s
	const nearExpiry = await parts(row({ built_at: TS - 100, build_deadline: TS + 15 }, { expiresAt: TS + 15 }));
	const e = create(nearExpiry);
	assert.equal(e.status, 'SESSION_CREATED', JSON.stringify(e.errors));
	assert.equal(e.session.expiresAt, TS + 15);
	// kein positives Fenster: an der Deadline und danach keine Sitzung
	for (const now of [DEADLINE, DEADLINE + 1]) {
		const x = create(base, { now });
		assert.equal(x.status, 'PURCHASE_REJECTED');
		assert.ok(x.errors.includes('BUILD_DEADLINE_EXPIRED'));
	}
	const expired = create(nearExpiry, { now: TS + 15 });
	assert.ok(expired.errors.includes('INTENT_EXPIRED'));
	// Verlaengerung ist nicht moeglich: expiresAt ist gebunden, eine Aenderung macht die Sitzung ungueltig
	const s = create(base).session;
	assert.equal(S.checkSessionUse({ session: { ...s, expiresAt: s.expiresAt + 60 }, now: NOW, consumed: new Set() }), 'TAMPERED');
});

/* ---------------------------------------------------- Aufrufer, Einmal -- */

test('P4H-SESSION-CLIENT the caller cannot inject wallet, transaction fields, hashes, block or block hash', async () => {
	const fields = { wallet: WALLET, txHash: keccak256('0x01'), calldataHash: keccak256(BUY_DATA), intentHash: keccak256('0x02'), status: 'BUILT', to: BROKER, data: BUY_DATA, value: 0n,
		abi: [], selector: '0x7c59cac4', spender: BROKER, amount: '1', period: 30, coverId: 1, verifiedAtBlock: 1n, verifiedAtBlockHash: keccak256('0x03'), sessionHash: keccak256('0x04'),
		preSendVerdict: {}, purchase: {}, expiresAt: NOW + 999 };
	for (const [key, value] of Object.entries(fields)) {
		const { res, repo, rpc } = await prepare({ extra: { [key]: value } });
		assert.equal(res.status, 'INVALID_INPUT', key);
		assert.deepEqual([...res.errors], [`CLIENT_FIELD:${key}`]);
		assert.deepEqual(repo.calls, [], `${key}: nothing loaded`);
		assert.deepEqual(rpc.calls, [], `${key}: no chain read`);
	}
	const base = await parts();
	// auch der reine Schritt nimmt keine Kopie an, selbst eine plausible, die sonst eine Sitzung ergaebe
	const plausible = { wallet: OTHER, to: USDC, data: RW.calldata(OTHER), value: 0n, chainId: 1, calldataHash: keccak256(RW.calldata(OTHER)), intentHash: keccak256('0x02'),
		verifiedAtBlock: base.verdict.verifiedAtBlock + 1n, verifiedAtBlockHash: keccak256('0x03'), expiresAt: NOW + 999, executionSessionHash: keccak256('0x04'), intentId: ID, status: 'BUILT' };
	for (const [key, value] of Object.entries(plausible)) {
		const x = create(base, { [key]: value });
		assert.equal(x.status, 'INVALID_INPUT', key);
		assert.deepEqual([...x.errors], [`CLIENT_FIELD:${key}`]);
	}
	for (const sessionId of [undefined, 'x', SESSION_ID.toUpperCase(), '3f2a1b0c-9d8e-1f7a-8b6c-5d4e3f2a1b0c']) assert.equal(create(base, { sessionId }).status, 'INVALID_INPUT');
	// ein veraendertes Kauf-Modell wird neu geprueft, nicht uebernommen
	for (const patch of [{ status: 'SUBMITTED' }, { calldataHash: keccak256('0x07') }, { intent: { ...base.purchase.intent, wallet: OTHER } }, { buildDeadline: DEADLINE + 1000 }]) {
		const x = create({ ...base, purchase: { ...base.purchase, ...patch } });
		assert.notEqual(x.status, 'SESSION_CREATED', JSON.stringify(Object.keys(patch)));
	}
});

test('P4H-SESSION-USE single use is modelled honestly (not persisted): tampered, expired and consumed sessions are not usable', async () => {
	assert.equal(S.SINGLE_USE_ENFORCEMENT, 'MODEL_ONLY_NOT_PERSISTED');
	const s = create(await parts()).session;
	const consumed = new Set();
	assert.equal(S.checkSessionUse({ session: s, now: NOW, consumed }), 'USABLE');
	consumed.add(s.executionSessionHash);
	assert.equal(S.checkSessionUse({ session: s, now: NOW, consumed }), 'CONSUMED');
	assert.equal(S.checkSessionUse({ session: s, now: s.expiresAt, consumed: new Set() }), 'EXPIRED');
	for (const patch of [{ data: `${BUY_DATA}00` }, { to: USDC }, { wallet: OTHER }, { verifiedAtBlockHash: keccak256('0x05') }, { executionSessionHash: keccak256('0x06') }]) {
		assert.equal(S.checkSessionUse({ session: { ...s, ...patch }, now: NOW, consumed: new Set() }), 'TAMPERED', Object.keys(patch)[0]);
	}
	assert.equal(S.checkSessionUse({ session: s, now: NOW, consumed: [] }), 'INVALID_INPUT');
	assert.match(read('src/purchase-execution-session.mjs'), /KEINE Durchsetzung/);
});

test('P4H-SESSION-TOCTOU the residual time-of-check risk is stated, never described as eliminated', async () => {
	const s = create(await parts()).session;
	assert.equal(s.toctou, S.TOCTOU_RESIDUAL);
	assert.match(S.TOCTOU_RESIDUAL, /^NOT eliminated:/);
	assert.match(S.TOCTOU_RESIDUAL, /verifiedAtBlock/);
	assert.match(S.TOCTOU_RESIDUAL, /P4E re-checks/);
	for (const file of ['src/purchase-execution-session.mjs', 'src/purchase-runtime-loader.mjs']) assert.doesNotMatch(read(file), /safe to send|guaranteed|protected from upgrade|garantiert|sicher zu senden/i, file);
});

/* ----------------------------------------------- statisch, Reichweite -- */

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const walk = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).flatMap((n) => (n === 'node_modules' || n === 'dist' || n.startsWith('.') ? [] : statSync(new URL(`../${dir}/${n}`, import.meta.url)).isDirectory() ? walk(`${dir}/${n}`) : /\.(m?js|cjs|ts|tsx|jsx|html|svelte|vue)$/.test(n) ? [`${dir}/${n}`] : []));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const MODULE = 'src/purchase-execution-session.mjs';

test('P4H-SESSION-STATIC no wallet, send, sign, provider or builder surface; the decoder and P4F are the only judges', () => {
	const full = read(MODULE);
	const source = strip(full);
	assert.doesNotMatch(full, /eth_sendTransaction|eth_sendRawTransaction|wallet_sendCalls|sendTransaction|writeContract|createWalletClient|signTransaction|personal_sign|signTypedData|eth_sign\b|WalletConnect/i);
	assert.doesNotMatch(source, /approve\(|buyCover\(|encodeFunctionData|purchase-tx-builder|buildNexusBuyCover|buildExactUsdcApproval|\.request\(|process\.env|fetch\(|Date\.now|new Date|randomUUID|Math\.random|JSON\.stringify|privateKey|\.rpc\(/);
	assert.deepEqual([...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['viem', './purchase-tx-decode.mjs', './purchase-pre-send.mjs', './purchase-runtime-loader.mjs']);
	assert.match(source, /^import \{ encodeAbiParameters, keccak256 \} from 'viem';$/m);
	assert.equal(source.match(/verifyPurchasePreSend\(/g).length, 1);
	assert.equal(source.match(/decodeNexusBuyCover\(/g).length, 1);
	assert.equal(source.match(/decodeUsdcApproval\(/g).length, 1);
	assert.deepEqual(Object.keys(S).sort(), ['EXECUTION_SESSION_DOMAIN', 'EXECUTION_SESSION_VERSION', 'SESSION_STATUSES', 'SESSION_TTL_SECONDS', 'SINGLE_USE_ENFORCEMENT', 'TOCTOU_RESIDUAL', 'TRANSACTION_KINDS',
		'checkSessionUse', 'computeExecutionSessionHash', 'createExecutionSession', 'prepareExecutionSession']);
	assert.ok(!S.SESSION_STATUSES.includes('READY_TO_SEND'));
});

test('P4H-SESSION-IMPORT only the P4H tests import the session module; no purchase, wallet or execution route exists', () => {
	const runtime = [...walk('src'), ...walk('api'), ...walk('web'), ...walk('scripts')].filter((f) => f !== MODULE && !f.startsWith('web/dist'));
	assert.ok(runtime.includes('src/bot.mjs') && runtime.some((f) => f.startsWith('api/')) && runtime.some((f) => f.startsWith('web/src/')) && runtime.some((f) => /^src\/agent-/.test(f)));
	for (const file of runtime) assert.doesNotMatch(read(file), /purchase-execution-session(\.mjs)?['"`]|prepareExecutionSession|createExecutionSession/, file);
	const importing = /(?:from\s*|import\s*\(\s*)['"`][^'"`]*purchase-execution-session\.mjs/;
	assert.deepEqual([...walk('src'), ...walk('api'), ...walk('test'), ...walk('test-support')].filter((f) => importing.test(read(f))).sort(), ['test/purchase-execution-session.test.mjs']);
	assert.deepEqual(walk('api').filter((f) => /purchase|buy|wallet|execution|session|intent|confirm/i.test(f)), []);
	const vercel = JSON.parse(read('vercel.json'));
	assert.doesNotMatch(JSON.stringify({ crons: vercel.crons ?? [], rewrites: vercel.rewrites ?? [] }), /purchase|buy|wallet|execution|intent|confirm/i, 'no route or cron');
});

test('P4H-P4C-MODEL the builder stays never production-ready; loader and session binding are listed, wallet orchestration stays unresolved', async () => {
	const B = await import('../src/purchase-tx-builder.mjs');
	assert.equal(B.EXTERNAL_REQUIRED_CONTROLS.RUNTIME_LOADER, 'SATISFIED_BY_P4H');
	assert.equal(B.EXTERNAL_REQUIRED_CONTROLS.EXECUTION_SESSION_BINDING, 'SATISFIED_BY_P4H');
	for (const k of ['WALLET_ORCHESTRATION', 'TERMS', 'PROOF_OF_LOSS']) assert.equal(B.EXTERNAL_REQUIRED_CONTROLS[k], 'UNRESOLVED', k);
	assert.ok(B.PRODUCTION_BLOCKERS.includes('WALLET_ORCHESTRATION_UNRESOLVED'));
	const quote = { premiumRaw: '3000578', quoteTotalCoverAmountRaw: '1000192871', allocations: [{ poolId: '2', coverAmountInAsset: '1000192871' }] };
	for (const r of [B.buildNexusBuyCover({ intent: intent(), quote }), B.buildExactUsdcApproval({ intent: intent() })]) {
		assert.equal(r.ok, true);
		assert.equal(r.tx.productionReady, false);
	}
	// unabhaengig: die konstruierten Test-Bytes sind dieselben, die der Builder fuer diesen Intent erzeugt
	assert.equal(B.buildNexusBuyCover({ intent: intent(), quote }).tx.data, BUY_DATA);
});
