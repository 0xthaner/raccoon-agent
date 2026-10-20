/**
 * Nexus P4H (20.10.2026): serverseitiger Lader fuer die Ausfuehrungs-Vorbereitung (src/purchase-runtime-loader.mjs).
 *
 * Das Repository ist eine Attrappe der festen Lesefunktion (Antwortform wie
 * get_cover_purchase_intent_for_execution); gegen die echte Datenbank laeuft
 * test/purchase-runtime-loader-db.test.mjs. Der Intent ist SYNTHETISCH.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { keccak256, toHex } from 'viem';
const L = await import('../src/purchase-runtime-loader.mjs');
const I = await import('../src/purchase-intent.mjs');
const D = await import('../src/purchase-intent-db.mjs');

const T0 = 1_792_400_000;
const NOW = T0 + 60;
const ID = '0b9e6f1c-3d2a-4f5b-8c7d-1e2f3a4b5c6d';
const WALLET = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const TEST_CID = 'QmQPWELjoGp6zqfrELz2xeafuPgtSBfvVF1pjX3DvuFsah';
const intent = (patch = {}) => ({
	id: ID, wallet: WALLET, chainId: 1, deploymentKey: 'aave-v3-ethereum-core', productId: 97, productTypeId: 0, coverAssetId: 6,
	amountRaw: '1000000000', periodDays: 30, quotePremiumRaw: '3000578', maxPremiumRaw: '3030584', quoteFetchedAt: T0, capacityFetchedAt: T0,
	wordingCid: 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY', annexCid: null, termsHash: keccak256('0x01'), proofOfLossCid: TEST_CID,
	commissionRatio: 0, commissionDestination: I.ZERO_ADDRESS, pinVersion: I.PURCHASE_PIN_VERSION, acknowledgedAt: T0 + 10, expiresAt: T0 + 610, ...patch
});
const CALLDATA_HASH = keccak256(toHex('p4h: stands for the stored buyCover calldata hash'));

/** Zeile wie aus der festen Lesefunktion (snake_case, ganze Sekunden, Betraege als Text). */
function row(patch = {}, intentPatch = {}) {
	const i = intent(intentPatch);
	return {
		id: i.id, wallet: i.wallet, chain_id: i.chainId, deployment_key: i.deploymentKey, product_id: i.productId, product_type_id: i.productTypeId, cover_asset_id: i.coverAssetId,
		amount_raw: i.amountRaw, period_days: i.periodDays, quote_premium_raw: i.quotePremiumRaw, max_premium_raw: i.maxPremiumRaw, quote_fetched_at: i.quoteFetchedAt,
		capacity_fetched_at: i.capacityFetchedAt, wording_cid: i.wordingCid, annex_cid: i.annexCid, terms_version: 'coverraccoon.terms/1', terms_hash: i.termsHash,
		proof_of_loss_cid: i.proofOfLossCid, commission_ratio: i.commissionRatio, commission_destination: i.commissionDestination, pin_version: i.pinVersion,
		intent_hash: I.computePurchaseIntentHash(i), acknowledged_at: i.acknowledgedAt, expires_at: i.expiresAt, status: 'BUILT', calldata_hash: CALLDATA_HASH,
		built_at: NOW - 10, build_deadline: NOW + 110, tx_hash: null, cover_id: null, ...patch
	};
}
function repo(answer) {
	const calls = [];
	return { calls, repository: { async loadIntentForExecution(id) { calls.push(id); return typeof answer === 'function' ? answer(id) : structuredClone(answer); } } };
}
const found = (r) => ({ status: 'found', intent: r });
const load = async (answer, { now = NOW, extra = {}, intentId = ID } = {}) => {
	const r = repo(answer);
	return { res: await L.loadPurchaseForExecution({ repository: r.repository, intentId, now, ...extra }), calls: r.calls };
};

test('P4H-LOAD an exact persisted BUILT row loads into the canonical model with a recomputed intent hash', async () => {
	const { res, calls } = await load(found(row()));
	assert.equal(res.status, 'LOADED', JSON.stringify(res.errors));
	assert.equal(res.ok, true);
	assert.deepEqual(calls, [ID]);
	const p = res.purchase;
	assert.deepEqual(Object.keys(p).sort(), ['buildDeadline', 'builtAt', 'calldataHash', 'coverId', 'expiresAt', 'intent', 'intentHash', 'intentId', 'status', 'txHash']);
	assert.deepEqual({ ...p.intent }, intent());
	assert.equal(p.intentHash, I.computePurchaseIntentHash(intent()));
	assert.equal(p.calldataHash, CALLDATA_HASH);
	assert.equal(p.status, 'BUILT');
	assert.equal(p.builtAt, NOW - 10);
	assert.equal(p.buildDeadline, NOW + 110);
	assert.equal(p.expiresAt, T0 + 610);
	assert.equal(p.txHash, null);
	assert.equal(p.coverId, null);
	assert.ok(Object.isFrozen(res) && Object.isFrozen(p) && Object.isFrozen(p.intent));
	assert.equal(L.EXPECTED_TERMS_VERSION, D.TERMS_VERSION);
});

test('P4H-LOAD-STATUS only BUILT without tx_hash and cover_id is loadable', async () => {
	assert.equal((await load({ status: 'rejected', code: 'NOT_FOUND' })).res.status, 'NOT_FOUND');
	for (const status of ['OPEN', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED', 'built', null]) {
		const { res } = await load(found(row({ status })));
		assert.equal(res.status, 'INVALID_STATUS', String(status));
		assert.equal(res.purchase, null);
	}
	const tx = await load(found(row({ tx_hash: keccak256('0x02') })));
	assert.equal(tx.res.status, 'PERSISTED_RECORD_INVALID');
	assert.deepEqual([...tx.res.errors], ['TX_HASH_ALREADY_SET']);
	const cover = await load(found(row({ cover_id: 7001 })));
	assert.deepEqual([...cover.res.errors], ['COVER_ID_ALREADY_SET']);
});

test('P4H-LOAD-HASH the stored intent hash must equal the P4A recomputation; the calldata hash must be bytes32', async () => {
	const cases = [
		[row({ intent_hash: keccak256('0x99') }), 'INTENT_HASH_MISMATCH'],
		[row({ intent_hash: 'abc' }), 'INTENT_HASH_FORMAT'],
		[row({ intent_hash: I.computePurchaseIntentHash(intent()).toUpperCase() }), 'INTENT_HASH_FORMAT'],
		[row({ amount_raw: '1000000001' }), 'INTENT_HASH_MISMATCH'],
		[row({ max_premium_raw: '3030585' }), 'INTENT_HASH_MISMATCH'],
		[row({ calldata_hash: null }), 'CALLDATA_HASH_FORMAT'],
		[row({ calldata_hash: '0x1234' }), 'CALLDATA_HASH_FORMAT'],
		[row({ calldata_hash: CALLDATA_HASH.toUpperCase() }), 'CALLDATA_HASH_FORMAT'],
		[row({}, { proofOfLossCid: null }), 'INTENT_WITHOUT_PROOF_OF_LOSS'],
		[row({ terms_version: 'coverraccoon.terms/2' }), 'TERMS_VERSION'],
		[row({ id: '5d1c2b3a-4e5f-4a6b-9c7d-8e9f0a1b2c3d' }), 'ROW_ID'],
		[row({ built_at: null }), 'BUILD_TIMES'],
		[row({ build_deadline: NOW + 200 }), 'BUILD_WINDOW'],
		[row({ build_deadline: NOW - 20 }), 'BUILD_WINDOW'],
		// innerhalb von 120 s, aber nach expires_at: die Deadline darf den Intent nie ueberleben
		[row({ built_at: T0 + 550, build_deadline: T0 + 611 }), 'BUILD_WINDOW']
	];
	for (const [r, code] of cases) {
		const { res } = await load(found(r));
		assert.equal(res.ok, false, code);
		assert.ok(res.errors.includes(code), `${code}: ${res.errors}`);
	}
	// zusaetzliche oder fehlende Spalten: nichts wird repariert
	const extra = await load(found({ ...row(), client_request_id: ID }));
	assert.deepEqual([...extra.res.errors], ['ROW_FIELD:client_request_id']);
	const short = row();
	delete short.tx_hash;
	assert.deepEqual([...(await load(found(short))).res.errors], ['ROW_MISSING:tx_hash']);
	for (const answer of [null, {}, { status: 'found' }, { status: 'ok', intent: row() }, { status: 'rejected', code: 'OTHER' }]) {
		assert.equal((await load(answer)).res.status, 'PERSISTED_RECORD_INVALID');
	}
});

test('P4H-LOAD-EXPIRY expires_at and build_deadline are exclusive bounds; no extension', async () => {
	const r = row();
	assert.equal((await load(found(r), { now: r.build_deadline - 1 })).res.status, 'LOADED');
	assert.equal((await load(found(r), { now: r.build_deadline })).res.status, 'BUILD_DEADLINE_EXPIRED');
	assert.equal((await load(found(r), { now: r.build_deadline + 100 })).res.status, 'BUILD_DEADLINE_EXPIRED');
	// Deadline gleich expires_at: expires_at zuerst
	const tight = row({ built_at: T0 + 500, build_deadline: T0 + 610 });
	assert.equal((await load(found(tight), { now: T0 + 609 })).res.status, 'LOADED');
	assert.equal((await load(found(tight), { now: T0 + 610 })).res.status, 'INTENT_EXPIRED');
	for (const now of [0, -1, 1.5, '1792400060', null]) assert.equal((await load(found(row()), { now })).res.status, 'INVALID_INPUT');
});

test('P4H-LOAD-CLIENT only intentId (and the server clock) are inputs; every caller copy is refused before any read', async () => {
	const fields = { wallet: WALLET, txHash: keccak256('0x01'), calldataHash: CALLDATA_HASH, intentHash: keccak256('0x02'), status: 'BUILT', to: WALLET, data: '0x', value: 0n,
		abi: [], selector: '0x7c59cac4', spender: WALLET, amount: '1', period: 30, coverId: 1, verifiedAtBlock: 1n, verifiedAtBlockHash: keccak256('0x03'), sessionHash: keccak256('0x04'),
		intent: intent(), purchase: {}, buildDeadline: NOW + 1000, expiresAt: NOW + 1000 };
	for (const [key, value] of Object.entries(fields)) {
		const { res, calls } = await load(found(row()), { extra: { [key]: value } });
		assert.equal(res.status, 'INVALID_INPUT', key);
		assert.deepEqual([...res.errors], [`CLIENT_FIELD:${key}`]);
		assert.deepEqual(calls, [], `${key}: no read`);
	}
	for (const intentId of [undefined, null, 'x', ID.toUpperCase()]) {
		const r = repo(found(row()));
		assert.equal((await L.loadPurchaseForExecution({ repository: r.repository, intentId, now: NOW })).status, 'INVALID_INPUT', String(intentId));
		assert.deepEqual(r.calls, []);
	}
	// das Repository ist genau eine Lesemethode
	for (const extra of ['query', 'from', 'rpc', 'update', 'markBuilt']) {
		const r = repo(found(row()));
		const res = await L.loadPurchaseForExecution({ repository: { ...r.repository, [extra]: () => {} }, intentId: ID, now: NOW });
		assert.deepEqual([...res.errors], ['REPOSITORY_NOT_NARROW'], extra);
	}
	const down = await L.loadPurchaseForExecution({ repository: { loadIntentForExecution: async () => { throw new Error('db down'); } }, intentId: ID, now: NOW });
	assert.equal(down.status, 'DB_UNAVAILABLE');
});

test('P4H-RECHECK a loaded model is re-validated in full at every later step; edits and the clock are not trusted', async () => {
	const { res } = await load(found(row()));
	assert.equal(L.recheckPurchase(res.purchase, NOW).ok, true);
	assert.equal(L.recheckPurchase(res.purchase, NOW + 110).status, 'BUILD_DEADLINE_EXPIRED');
	const edits = {
		intent: { ...res.purchase.intent, amountRaw: '2000000000' }, intentHash: keccak256('0x05'), calldataHash: 'x', status: 'SUBMITTED', txHash: keccak256('0x06'),
		coverId: 1, buildDeadline: NOW + 5000, expiresAt: T0 + 9999, intentId: '5d1c2b3a-4e5f-4a6b-9c7d-8e9f0a1b2c3d'
	};
	for (const [key, value] of Object.entries(edits)) assert.equal(L.recheckPurchase({ ...res.purchase, [key]: value }, NOW).ok, false, key);
	assert.equal(L.recheckPurchase({ ...res.purchase, verifiedAtBlock: 1n }, NOW).ok, false);
	assert.equal(L.recheckPurchase(null, NOW).ok, false);
});

/* ----------------------------------------------- statisch, Reichweite -- */

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const walk = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).flatMap((n) => (n === 'node_modules' || n === 'dist' || n.startsWith('.') ? [] : statSync(new URL(`../${dir}/${n}`, import.meta.url)).isDirectory() ? walk(`${dir}/${n}`) : /\.(m?js|cjs|ts|tsx|jsx|html|svelte|vue)$/.test(n) ? [`${dir}/${n}`] : []));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('P4H-LOADER-STATIC the loader reads only through its one repository method; no write, wallet, network or environment', () => {
	const full = read('src/purchase-runtime-loader.mjs');
	const source = strip(full);
	assert.doesNotMatch(full, /eth_sendTransaction|eth_sendRawTransaction|wallet_sendCalls|sendTransaction|writeContract|createWalletClient|signTransaction|personal_sign|signTypedData/);
	assert.doesNotMatch(source, /approve\(|buyCover|markBuilt|markSubmitted|markConfirmed|markFailed|\.rpc\(|\.from\(|\.query\(|\.update\(|process\.env|fetch\(|cover_purchase_intent|Date\.now|new Date/);
	assert.deepEqual([...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['./purchase-intent.mjs']);
	assert.equal(source.match(/repository\.\w+\(/g).length, 1);
	assert.deepEqual(Object.keys(L).sort(), ['EXPECTED_TERMS_VERSION', 'LOADER_STATUSES', 'loadPurchaseForExecution', 'recheckPurchase']);
	// der P4D-Helfer ruft genau die feste Lesefunktion
	assert.match(read('src/purchase-intent-db.mjs'), /export async function loadIntentForExecution\(client, \{ id \}\) \{\n\treturn call\(client, 'get_cover_purchase_intent_for_execution', \{ p_id: wantId\(id\) \}\);\n\}/);
});

test('P4H-LOADER-IMPORT only tests and the unreachable session module import the loader; no route exists', () => {
	const MODULES = ['src/purchase-runtime-loader.mjs', 'src/purchase-execution-session.mjs'];
	const runtime = [...walk('src'), ...walk('api'), ...walk('web'), ...walk('scripts')].filter((f) => !MODULES.includes(f) && !f.startsWith('web/dist'));
	assert.ok(runtime.includes('src/bot.mjs') && runtime.some((f) => f.startsWith('api/')) && runtime.some((f) => f.startsWith('web/src/')));
	for (const file of runtime) assert.doesNotMatch(read(file), /purchase-runtime-loader(\.mjs)?['"`]|loadPurchaseForExecution/, file);
	const importing = /(?:from\s*|import\s*\(\s*)['"`][^'"`]*purchase-runtime-loader\.mjs/;
	assert.deepEqual([...walk('src'), ...walk('api'), ...walk('test'), ...walk('test-support')].filter((f) => importing.test(read(f))).sort(),
		['src/purchase-execution-session.mjs', 'test/purchase-execution-session.test.mjs', 'test/purchase-runtime-loader-db.test.mjs', 'test/purchase-runtime-loader.test.mjs']);
});
