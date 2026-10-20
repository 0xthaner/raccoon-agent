/**
 * Nexus P4F (20.10.2026): nur lesende Pre-Send-Pruefung (src/purchase-pre-send.mjs) und der
 * unabhaengige USDC-Pin.
 *
 * Kettenzustand ECHT: Mitschnitt an EINEM Block (fixtures/nexus/pre-send-state-26230166.json, zwei
 * Anbieter, jeder Zugriff per Block-Hash), Laufzeitcodes aus fixtures/nexus und fixtures/usdc.
 * Intent SYNTHETISCH (Test-CID, Test-Wallet): es gibt keine Transaktion, nur die Pruefung davor.
 * USDC-Quelle: fixtures/usdc (eigene Rekompilierung, Circle-Quelldateien v2.2.0). Kein Test braucht
 * ein Live-RPC; die Leser sind Attrappen mit request({ method, params }).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { keccak256, toHex, toFunctionSelector } from 'viem';
const P = await import('../src/purchase-pre-send.mjs');
const I = await import('../src/purchase-intent.mjs');

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const fixture = (path) => read(`test/fixtures/${path}`);
const STATE = JSON.parse(fixture('nexus/pre-send-state-26230166.json'));
const BUILDS = JSON.parse(fixture('usdc/usdc-builds.json')).builds;
const CODE = Object.fromEntries(Object.entries(STATE.codeFiles).map(([a, f]) => [a, fixture(f).trim()]));

const BROKER = '0xcb2b736652d2dbf7d72e4db880cf6b7d99507814';
const COVER = '0xcafeac0ff5da0a2777d915531bfa6b29d282ee62';
const COVER_IMPL = '0xcafeaff1a21418f530feb00c6baef07523979c05';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDC_IMPL = '0x43506849d7c04f9138d1a2050bbf3a0c054402dd';
const SLOT = {
	cover: keccak256(toHex('org.govblocks.proxy.implementation')),
	usdc: keccak256(toHex('org.zeppelinos.proxy.implementation')),
	usdcAdmin: keccak256(toHex('org.zeppelinos.proxy.admin')),
	eip1967: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
};

/* ------------------------------------------------ SYNTHETISCHER Intent -- */

const WALLET = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const TS = Number(BigInt(STATE.block.timestamp));
/** NUR TEST: CIDv0 der UTF-8-Bytes 'coverraccoon-p4c-test-fixture: not a Nexus proof-of-loss record'. Keine Proof-of-Loss-CID. */
const TEST_CID = 'QmQPWELjoGp6zqfrELz2xeafuPgtSBfvVF1pjX3DvuFsah';
const WORDING = 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY';
const intent = (patch = {}) => ({
	id: '0b9e6f1c-3d2a-4f5b-8c7d-1e2f3a4b5c6d', wallet: WALLET, chainId: 1, deploymentKey: 'aave-v3-ethereum-core', productId: 97, productTypeId: 0, coverAssetId: 6,
	amountRaw: '1000000000', periodDays: 30, quotePremiumRaw: '3000578', maxPremiumRaw: '3030584', quoteFetchedAt: TS - 60, capacityFetchedAt: TS - 60, wordingCid: WORDING,
	annexCid: null, termsHash: keccak256('0x01'), proofOfLossCid: TEST_CID, commissionRatio: 0, commissionDestination: I.ZERO_ADDRESS, pinVersion: I.PURCHASE_PIN_VERSION,
	acknowledgedAt: TS - 50, expiresAt: TS + 550, ...patch
});
const CALLDATA_HASH = keccak256(toHex('p4f-synthetic-calldata: stands for the stored P4C buyCover calldata hash'));
const BUILT_AT = TS - 10, DEADLINE = TS + 110, NOW = TS + 5;

/* -------------------------------------------- Kette aus dem Mitschnitt -- */

/** Die ECHTE Kette am Block 26230166, als veraenderbare Welt. */
function world() {
	return {
		chainId: STATE.chainId,
		head: STATE.block.number,
		blocks: { [STATE.block.number]: { ...STATE.block } },
		code: { ...CODE },
		storage: structuredClone(STATE.storage),
		allowance: STATE.allowance.value
	};
}
const at = () => ({ blockHash: STATE.block.hash });
/** Leser-Attrappe: antwortet nur fuer genau den Block-Hash der Welt; jeder andere Blockbezug ist ein Fehler. */
function reader(w, calls = []) {
	const bound = (tag) => tag && typeof tag === 'object' && Object.keys(tag).length === 1 && Object.values(w.blocks).some((b) => b.hash === tag.blockHash);
	return {
		async request({ method, params }) {
			calls.push({ method, params: structuredClone(params) });
			if (w.failOn === method) throw new Error('503 upstream');
			switch (method) {
				case 'eth_chainId': return w.chainId;
				case 'eth_blockNumber': return w.head;
				case 'eth_getBlockByNumber': return w.blocks[params[0]] ? { ...w.blocks[params[0]], transactions: [] } : null;
				case 'eth_getCode': if (!bound(params[1])) throw new Error('unbound read'); return w.code[params[0]] ?? '0x';
				case 'eth_getStorageAt': if (!bound(params[2])) throw new Error('unbound read'); return w.storage[params[0]]?.[params[1]] ?? `0x${'0'.repeat(64)}`;
				case 'eth_call': if (!bound(params[1])) throw new Error('unbound read');
					if (params[0].to === USDC && params[0].data.startsWith('0xdd62ed3e')) return w.allowance;
					throw new Error('execution reverted');
				default: throw new Error(`unexpected ${method}`);
			}
		}
	};
}
const args = (patch = {}) => ({
	rpcA: reader(world()), rpcB: reader(world()), persistedIntent: intent(), persistedIntentHash: I.computePurchaseIntentHash(intent()), persistedCalldataHash: CALLDATA_HASH,
	persistedStatus: 'BUILT', persistedBuiltAt: BUILT_AT, persistedBuildDeadline: DEADLINE, now: NOW, ...patch
});
/** Prueft mit veraenderter Welt (beide Leser gleich, oder nur B) und erwartet Status und Fehler. */
async function failsWith(status, errors, edit, { editB, patch } = {}) {
	const a = world(); edit?.(a);
	const b = structuredClone(a); editB?.(b);
	const r = await P.verifyPurchasePreSend(args({ rpcA: reader(a), rpcB: reader(b), ...patch }));
	assert.equal(r.status, status, JSON.stringify(r.errors));
	if (errors) assert.deepEqual(r.errors, errors);
	assert.equal(r.ok, false);
	assert.notEqual(r.status, 'PRE_SEND_VERIFIED');
	return r;
}

/* ---------------------------------------------------------- Gueltig -- */

test('P4F-VALID the real chain state at one block matches every pin; verdict PRE_SEND_VERIFIED, nothing executed', async () => {
	const calls = [];
	const r = await P.verifyPurchasePreSend(args({ rpcA: reader(world(), calls), rpcB: reader(world(), calls), observeAllowance: true }));
	assert.equal(r.status, 'PRE_SEND_VERIFIED', JSON.stringify(r.errors));
	assert.equal(r.ok, true);
	assert.deepEqual(r.errors, []);
	assert.deepEqual(Object.keys(r.checks), [...P.PRE_SEND_CHECKS]);
	assert.ok(Object.values(r.checks).every((v) => v === true));
	assert.equal(r.verifiedAtBlock, 26_230_166n);
	assert.equal(r.verifiedAtBlockHash, STATE.block.hash);
	assert.deepEqual(r.contractPins, {
		brokerCodeHash: P.PRE_SEND_PINS.brokerCodeHash, coverProxyCodeHash: P.PRE_SEND_PINS.coverProxyCodeHash, coverImplementation: COVER_IMPL,
		coverImplementationCodeHash: P.PRE_SEND_PINS.coverImplementationCodeHash, usdcProxyCodeHash: P.USDC_PIN.proxyCodeHash, usdcImplementation: USDC_IMPL,
		usdcImplementationCodeHash: P.USDC_PIN.implementationCodeHash
	});
	assert.equal(r.currentAllowance, '0', 'observation only');
	assert.ok(Object.isFrozen(r) && Object.isFrozen(r.checks) && Object.isFrozen(r.contractPins));
	assert.ok(calls.every((c) => P.PRE_SEND_READ_METHODS.includes(c.method)));
	assert.ok(!('readyToSend' in r) && !P.PRE_SEND_STATUSES.includes('READY_TO_SEND'));
	// die Pins der Pruefung sind genau die, die der Intent-Hash bindet (P4A) und der Beleg-Pruefer nutzt (P4E)
	for (const k of ['broker', 'brokerCodeHash', 'coverProxy', 'coverImplementation', 'coverImplementationCodeHash']) assert.equal(P.PRE_SEND_PINS[k], I.PURCHASE_PINS[k], k);
	const RECEIPT = read('src/purchase-receipt.mjs');
	assert.ok(RECEIPT.includes(`coverProxyCodeHash: '${P.PRE_SEND_PINS.coverProxyCodeHash}'`) && RECEIPT.includes(`coverImplementationSlot: '${P.PRE_SEND_PINS.coverImplementationSlot}'`));
	assert.ok(RECEIPT.includes(`usdc: '${P.USDC_PIN.proxy}'`));
});

/* ---------------------------------------------------- Status / Zeit -- */

test('P4F-STATUS only BUILT is eligible; every other persisted status is refused', async () => {
	for (const s of ['OPEN', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED']) await failsWith('INVALID_STATUS', [`STATUS_${s}`], undefined, { patch: { persistedStatus: s } });
	for (const s of ['built', 'READY', '', null, undefined]) await failsWith('INVALID_STATUS', ['UNKNOWN_STATUS'], undefined, { patch: { persistedStatus: s } });
});

test('P4F-EXPIRY expires_at and build_deadline are exclusive P4D boundaries and are never extended', async () => {
	const exp = intent().expiresAt;
	await failsWith('INTENT_EXPIRED', ['INTENT_EXPIRED'], undefined, { patch: { now: exp } });
	await failsWith('INTENT_EXPIRED', ['INTENT_EXPIRED'], undefined, { patch: { now: exp + 1 } });
	await failsWith('BUILD_DEADLINE_EXPIRED', ['BUILD_DEADLINE_EXPIRED'], undefined, { patch: { now: DEADLINE } });
	await failsWith('BUILD_DEADLINE_EXPIRED', ['BUILD_DEADLINE_EXPIRED'], undefined, { patch: { now: DEADLINE + 1 } });
	// eine Sekunde davor gilt (der Block ist dann noch frisch genug)
	const ok = await P.verifyPurchasePreSend(args({ now: DEADLINE - 1 }));
	assert.equal(ok.status, 'PRE_SEND_VERIFIED', JSON.stringify(ok.errors));
	// das Bau-Fenster entspricht P4D: deadline > built_at, hoechstens 120 s, nie nach expires_at
	await failsWith('INVALID_INTENT', ['BUILD_WINDOW'], undefined, { patch: { persistedBuildDeadline: BUILT_AT } });
	await failsWith('INVALID_INTENT', ['BUILD_WINDOW'], undefined, { patch: { persistedBuildDeadline: BUILT_AT + 121 } });
	await failsWith('INVALID_INTENT', ['BUILD_WINDOW'], undefined, { patch: { persistedBuiltAt: exp - 60, persistedBuildDeadline: exp + 1, now: exp - 50 } });
	for (const bad of [null, '1792455600', 1.5, 0, -1]) {
		await failsWith('INVALID_INTENT', ['BUILD_TIMES'], undefined, { patch: { persistedBuiltAt: bad } });
		await failsWith('INVALID_INTENT', ['BUILD_TIMES'], undefined, { patch: { persistedBuildDeadline: bad } });
	}
	for (const now of [null, '1', 1.5, 0]) await failsWith('INVALID_INPUT', ['NOW'], undefined, { patch: { now } });
});

/* ------------------------------------------------- Intent-Integritaet -- */

test('P4F-INTENT the intent hash is recomputed with P4A and must equal the persisted one; the calldata hash must be bytes32', async () => {
	await failsWith('INVALID_INTENT', ['INTENT_HASH_MISMATCH'], undefined, { patch: { persistedIntentHash: I.computePurchaseIntentHash(intent({ amountRaw: '1000000001' })) } });
	// gespeicherter Hash passt zu einem anderen Intent als dem gespeicherten
	await failsWith('INVALID_INTENT', ['INTENT_HASH_MISMATCH'], undefined, { patch: { persistedIntent: intent({ maxPremiumRaw: '3030585' }) } });
	for (const h of [null, 'x', I.computePurchaseIntentHash(intent()).toUpperCase().replace('0X', '0x'), I.computePurchaseIntentHash(intent()).slice(0, 65)]) await failsWith('INVALID_INTENT', ['PERSISTED_INTENT_HASH'], undefined, { patch: { persistedIntentHash: h } });
	for (const h of [null, '0x1234', CALLDATA_HASH.toUpperCase().replace('0X', '0x'), `${CALLDATA_HASH} `]) await failsWith('INVALID_INTENT', ['PERSISTED_CALLDATA_HASH'], undefined, { patch: { persistedCalldataHash: h } });
	await failsWith('INVALID_INTENT', ['INTENT_WITHOUT_PROOF_OF_LOSS'], undefined, { patch: { persistedIntent: intent({ proofOfLossCid: null }) } });
	const bad = await failsWith('INVALID_INTENT', undefined, undefined, { patch: { persistedIntent: intent({ chainId: 10 }) } });
	assert.ok(bad.errors.includes('CHAIN'));
});

test('P4F-CLIENT a browser intent hash, calldata hash, status, deadline or transaction is refused and never read', async () => {
	const touched = [];
	const CLAIMS = ['intentHash', 'calldataHash', 'status', 'buildDeadline', 'expiresAt', 'to', 'data', 'value', 'spender', 'abi', 'selector', 'transaction', 'pins'];
	const input = args();
	for (const key of CLAIMS) Object.defineProperty(input, key, { enumerable: true, get() { touched.push(key); return '0x'; } });
	const r = await P.verifyPurchasePreSend(input);
	assert.equal(r.status, 'INVALID_INPUT');
	assert.deepEqual(r.errors, CLAIMS.map((k) => `CLIENT_FIELD:${k}`));
	assert.deepEqual(touched, []);
	for (const v of [null, [], 'x']) assert.equal((await P.verifyPurchasePreSend(v)).status, 'INVALID_INPUT');
	await failsWith('INVALID_INPUT', ['RPC_READERS'], undefined, { patch: { rpcB: { send() {} } } });
	await failsWith('INVALID_INPUT', ['OBSERVE_ALLOWANCE'], undefined, { patch: { observeAllowance: 'yes' } });
});

/* ------------------------------------------------------------ Kette -- */

test('P4F-CHAIN a chain other than Ethereum mainnet is refused', async () => {
	for (const id of ['0xa', '0x89', '0x2105', '0xaa36a7', '0x01']) await failsWith('WRONG_CHAIN', ['WRONG_CHAIN'], (w) => { w.chainId = id; });
});

test('P4F-INDEPENDENT the same reader object twice is not two readers', async () => {
	const one = reader(world());
	const r = await P.verifyPurchasePreSend(args({ rpcA: one, rpcB: one }));
	assert.equal(r.status, 'RPC_NOT_INDEPENDENT');
	assert.equal(r.ok, false);
	assert.equal(r.verifiedAtBlock, null);
});

test('P4F-TWO-RPC disagreement on chain, head, block hash, code or storage fails closed without majority', async () => {
	await failsWith('RPC_DISAGREEMENT', ['RPC_DISAGREEMENT:eth_chainId'], undefined, { editB: (w) => { w.chainId = '0xa'; } });
	await failsWith('RPC_DISAGREEMENT', ['BLOCK_HASH'], undefined, { editB: (w) => { w.blocks[w.head].hash = keccak256('0x0b'); } });
	await failsWith('RPC_DISAGREEMENT', ['BLOCK_HASH'], undefined, { editB: (w) => { w.blocks[w.head].timestamp = toHex(TS + 1); } });
	await failsWith('RPC_DISAGREEMENT', ['BLOCK_MISSING'], undefined, { editB: (w) => { delete w.blocks[w.head]; } });
	// zu weit auseinanderliegende Koepfe meinen nicht dieselbe Kette
	await failsWith('RPC_DISAGREEMENT', ['HEAD_SKEW'], undefined, { editB: (w) => { w.head = toHex(BigInt(w.head) + 9n); } });
	for (const [what, edit] of [
		['eth_getCode', (w) => { w.code[BROKER] = `${w.code[BROKER]}00`; }],
		['eth_getCode', (w) => { w.code[USDC_IMPL] = '0x'; }],
		['eth_getStorageAt', (w) => { w.storage[COVER][SLOT.cover] = `0x${'0'.repeat(24)}${'1'.repeat(40)}`; }],
		['eth_getStorageAt', (w) => { w.storage[USDC][SLOT.usdc] = `0x${'0'.repeat(24)}${'2'.repeat(40)}`; }]
	]) await failsWith('RPC_DISAGREEMENT', [`RPC_DISAGREEMENT:${what}`], undefined, { editB: edit });
	// beide Seiten einzeln: eine Abweichung bei A zaehlt genauso
	const a = world(); a.code[COVER] = '0x00';
	const r = await P.verifyPurchasePreSend(args({ rpcA: reader(a), rpcB: reader(world()) }));
	assert.equal(r.status, 'RPC_DISAGREEMENT');
});

test('P4F-RPC-ERROR a reader failure is a temporary failure, never verified', async () => {
	for (const method of ['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt']) {
		for (const side of ['A', 'B']) {
			const a = world(), b = world();
			(side === 'A' ? a : b).failOn = method;
			const r = await P.verifyPurchasePreSend(args({ rpcA: reader(a), rpcB: reader(b) }));
			assert.equal(r.status, 'TEMPORARY_RPC_FAILURE', `${side} ${method}`);
			assert.deepEqual(r.errors, [`RPC_${side}_FAILED:${method}`]);
			assert.equal(r.ok, false);
		}
	}
	// eine Antwort, die nicht einmal eine Zahl ist, ist kein Kopf
	await failsWith('RPC_DISAGREEMENT', ['MALFORMED:head'], (w) => { w.head = 'latest'; });
	// ein Leser, der synchron wirft, ist ebenso kein Ergebnis
	const r = await P.verifyPurchasePreSend(args({ rpcB: { request() { throw new TypeError('boom'); } } }));
	assert.equal(r.status, 'TEMPORARY_RPC_FAILURE');
	// die Beobachtung der Freigabe entscheidet nichts: faellt sie aus, bleibt das Urteil, der Wert ist null
	const b = world(); b.failOn = 'eth_call';
	const obs = await P.verifyPurchasePreSend(args({ rpcB: reader(b), observeAllowance: true }));
	assert.equal(obs.status, 'PRE_SEND_VERIFIED');
	assert.equal(obs.currentAllowance, null);
});

test('P4F-BLOCK all code and storage reads happen at one agreed block, bound by its hash', async () => {
	const calls = [];
	const a = world(), b = world();
	// B ist einen Block weiter; gewaehlt wird der kleinere Kopf, den beide kennen
	const next = toHex(BigInt(STATE.block.number) + 1n);
	b.head = next; b.blocks[next] = { number: next, hash: keccak256('0x0c'), timestamp: toHex(TS + 12) };
	const r = await P.verifyPurchasePreSend(args({ rpcA: reader(a, calls), rpcB: reader(b, calls), observeAllowance: true }));
	assert.equal(r.status, 'PRE_SEND_VERIFIED', JSON.stringify(r.errors));
	assert.equal(r.verifiedAtBlock, BigInt(STATE.block.number));
	const blockReads = calls.filter((c) => c.method === 'eth_getBlockByNumber');
	assert.deepEqual([...new Set(blockReads.map((c) => c.params[0]))], [STATE.block.number]);
	const stateReads = calls.filter((c) => ['eth_getCode', 'eth_getStorageAt', 'eth_call'].includes(c.method));
	assert.equal(stateReads.length, 2 * 8, 'five code reads, two slots and one allowance per reader');
	for (const c of stateReads) assert.deepEqual(c.params.at(-1), at(), `${c.method} must read the agreed block hash`);
	// gelesen werden genau die gepinnten Adressen und Slots
	assert.deepEqual([...new Set(calls.filter((c) => c.method === 'eth_getCode').map((c) => c.params[0]))].sort(), [BROKER, COVER, COVER_IMPL, USDC, USDC_IMPL].sort());
	assert.deepEqual(calls.filter((c) => c.method === 'eth_getStorageAt').map((c) => `${c.params[0]}:${c.params[1]}`).sort(), [`${COVER}:${SLOT.cover}`, `${COVER}:${SLOT.cover}`, `${USDC}:${SLOT.usdc}`, `${USDC}:${SLOT.usdc}`].sort());
	// ein veralteter oder aus der Zukunft stammender Block ist keine aktuelle Sicht
	await failsWith('STALE_CHAIN_VIEW', ['BLOCK_TOO_OLD'], undefined, { patch: { now: TS + 121, persistedBuiltAt: TS + 20, persistedBuildDeadline: TS + 130 } });
	await failsWith('STALE_CHAIN_VIEW', ['BLOCK_IN_FUTURE'], undefined, { patch: { now: TS - 121, persistedBuiltAt: TS - 130, persistedBuildDeadline: TS - 20 } });
});

/* ------------------------------------------------------------- Pins -- */

test('P4F-BROKER a changed or missing CoverBroker runtime is BROKER_DRIFT', async () => {
	await failsWith('BROKER_DRIFT', ['BROKER_DRIFT'], (w) => { w.code[BROKER] = `${w.code[BROKER].slice(0, -2)}00`; });
	await failsWith('BROKER_DRIFT', ['BROKER_DRIFT'], (w) => { w.code[BROKER] = '0x'; });
	await failsWith('BROKER_DRIFT', ['BROKER_DRIFT'], (w) => { w.code[BROKER] = w.code[COVER_IMPL]; });
});

test('P4F-COVER-PROXY a changed Cover proxy runtime is COVER_PROXY_DRIFT', async () => {
	await failsWith('COVER_PROXY_DRIFT', ['COVER_PROXY_DRIFT'], (w) => { w.code[COVER] = `${w.code[COVER]}00`; });
	await failsWith('COVER_PROXY_DRIFT', ['COVER_PROXY_DRIFT'], (w) => { w.code[COVER] = w.code[USDC]; });
});

test('P4F-COVER-IMPL the legacy govblocks slot (not EIP-1967) must name the pinned implementation with the pinned runtime', async () => {
	assert.equal(P.PRE_SEND_PINS.coverImplementationSlot, SLOT.cover);
	assert.notEqual(P.PRE_SEND_PINS.coverImplementationSlot, SLOT.eip1967);
	// am Mitschnitt: der EIP-1967-Slot ist leer, der govblocks-Slot traegt die Implementierung
	assert.equal(STATE.storage[COVER][SLOT.eip1967], `0x${'0'.repeat(64)}`);
	assert.equal(STATE.storage[COVER][SLOT.cover], `0x${'0'.repeat(24)}${COVER_IMPL.slice(2)}`);
	const other = '0xcafeaff1a21418f530feb00c6baef07523979c06';
	await failsWith('COVER_IMPLEMENTATION_DRIFT', ['IMPLEMENTATION_ADDRESS'], (w) => { w.storage[COVER][SLOT.cover] = `0x${'0'.repeat(24)}${other.slice(2)}`; w.code[other] = w.code[COVER_IMPL]; });
	// ein Wort mit Muell in den oberen Bytes ist keine Adresse
	await failsWith('COVER_IMPLEMENTATION_DRIFT', ['IMPLEMENTATION_ADDRESS'], (w) => { w.storage[COVER][SLOT.cover] = `0x${'0'.repeat(23)}1${COVER_IMPL.slice(2)}`; });
	// ein Proxy, der auf EIP-1967 umgestellt waere, faellt ebenso durch
	await failsWith('COVER_IMPLEMENTATION_DRIFT', ['IMPLEMENTATION_ADDRESS'], (w) => { w.storage[COVER][SLOT.eip1967] = w.storage[COVER][SLOT.cover]; delete w.storage[COVER][SLOT.cover]; });
	await failsWith('COVER_IMPLEMENTATION_DRIFT', ['IMPLEMENTATION_CODE'], (w) => { w.code[COVER_IMPL] = `${w.code[COVER_IMPL].slice(0, -2)}00`; });
	await failsWith('COVER_IMPLEMENTATION_DRIFT', ['IMPLEMENTATION_CODE'], (w) => { w.code[COVER_IMPL] = '0x'; });
});

test('P4F-USDC a changed USDC proxy runtime, implementation address or implementation runtime is USDC_DRIFT', async () => {
	await failsWith('USDC_DRIFT', ['USDC_PROXY_CODE'], (w) => { w.code[USDC] = `${w.code[USDC]}00`; });
	const next = '0x43506849d7c04f9138d1a2050bbf3a0c054402de';
	await failsWith('USDC_DRIFT', ['USDC_IMPLEMENTATION_ADDRESS'], (w) => { w.storage[USDC][SLOT.usdc] = `0x${'0'.repeat(24)}${next.slice(2)}`; w.code[next] = w.code[USDC_IMPL]; });
	await failsWith('USDC_DRIFT', ['USDC_IMPLEMENTATION_ADDRESS'], (w) => { w.storage[USDC][SLOT.usdc] = `0x${'0'.repeat(64)}`; });
	// nicht der EIP-1967-Slot und nicht der Admin-Slot
	await failsWith('USDC_DRIFT', ['USDC_IMPLEMENTATION_ADDRESS'], (w) => { w.storage[USDC][SLOT.eip1967] = w.storage[USDC][SLOT.usdc]; delete w.storage[USDC][SLOT.usdc]; });
	await failsWith('USDC_DRIFT', ['USDC_IMPLEMENTATION_CODE'], (w) => { w.code[USDC_IMPL] = `${w.code[USDC_IMPL].slice(0, -2)}00`; });
	await failsWith('USDC_DRIFT', ['USDC_IMPLEMENTATION_CODE'], (w) => { w.code[USDC_IMPL] = '0x'; });
});

test('P4F-USDC-UNRESOLVED a USDC pin counts only when status, addresses, slot and both runtime hashes are present', () => {
	assert.equal(P.usdcPinState(P.USDC_PIN), 'PINNED');
	assert.equal(P.PRE_SEND_PINS.usdc, P.USDC_PIN);
	for (const patch of [{ status: 'UNRESOLVED' }, { status: undefined }, { proxy: undefined }, { implementation: 'unknown' }, { implementationCodeHash: null }, { proxyCodeHash: '0x12' }, { implementationSlot: '' }]) {
		assert.equal(P.usdcPinState({ ...P.USDC_PIN, ...patch }), 'USDC_PIN_UNRESOLVED', JSON.stringify(patch));
	}
	assert.equal(P.usdcPinState(null), 'USDC_PIN_UNRESOLVED');
	assert.ok(P.PRE_SEND_STATUSES.includes('USDC_PIN_UNRESOLVED'));
});

/* --------------------------------------------------- USDC-Quelle (P4F) -- */

const trailerStart = (hex) => (hex.length - 2) / 2 - 2 - parseInt(hex.slice(-4), 16);
/** Index der Bytes, in denen sich zwei Laufzeitcodes unterscheiden. */
function differingBytes(a, b) {
	const x = a.slice(2), y = b.slice(2), out = [];
	for (let i = 0; i < x.length / 2; i++) if (x.substr(i * 2, 2) !== y.substr(i * 2, 2)) out.push(i);
	return out;
}

test('P4F-USDC-SOURCE proxy and implementation are pinned from deployed code and our own recompilation, not from a label', () => {
	const proxy = fixture('usdc/runtime-usdc-proxy-a0b86991.hex').trim(), impl = fixture('usdc/runtime-usdc-impl-43506849.hex').trim();
	assert.equal(P.USDC_PIN.proxy, USDC);
	assert.equal(keccak256(proxy), P.USDC_PIN.proxyCodeHash);
	assert.equal(P.USDC_PIN.implementationSlot, SLOT.usdc);
	assert.equal(P.USDC_PIN.implementation, USDC_IMPL);
	assert.equal(keccak256(impl), P.USDC_PIN.implementationCodeHash);
	// der Mitschnitt zeigt dieselben Werte am Pre-Send-Block
	assert.equal(STATE.codeHash[USDC], P.USDC_PIN.proxyCodeHash);
	assert.equal(STATE.codeHash[USDC_IMPL], P.USDC_PIN.implementationCodeHash);
	assert.equal(STATE.storage[USDC][SLOT.usdc], `0x${'0'.repeat(24)}${USDC_IMPL.slice(2)}`);
	assert.equal(STATE.storage[USDC][SLOT.eip1967], `0x${'0'.repeat(64)}`, 'not an EIP-1967 proxy');
	// Proxy-Architektur aus dem Code: der zeppelinos-Implementierungs- und Admin-Slot stehen als PUSH32 im Laufzeitcode
	assert.ok(proxy.includes(`7f${SLOT.usdc.slice(2)}`) && proxy.includes(`7f${SLOT.usdcAdmin.slice(2)}`));
	assert.ok(!proxy.includes(SLOT.eip1967.slice(2)));
	// eigene Rekompilierung: gleiche Laenge, jedes Byte gleich ausser dem 32-Byte-Metadaten-Hash im CBOR-Trailer
	for (const [build, deployed, contract, solc] of [[BUILDS.find((b) => b.role === 'implementation'), impl, 'FiatTokenV2_2', '0.6.12+commit.27d51765'], [BUILDS.find((b) => b.role === 'proxy'), proxy, 'FiatTokenProxy', '0.4.24+commit.e67f0147']]) {
		assert.equal(build.contract, contract);
		assert.equal(build.compiler.solc, solc);
		assert.equal(build.runtime.length, deployed.length, contract);
		const diff = differingBytes(build.runtime, deployed);
		const start = trailerStart(deployed);
		assert.equal(diff.length, 32, contract);
		assert.ok(diff.every((i) => i > start), `${contract}: differences only inside the metadata trailer`);
		assert.equal(diff.at(-1) - diff[0], 31, `${contract}: one contiguous 32-byte hash`);
		assert.equal(trailerStart(build.runtime), start);
		assert.equal(build.match, 'PARTIAL_METADATA_HASH_ONLY');
	}
	const v22 = BUILDS.find((b) => b.role === 'implementation');
	assert.deepEqual([v22.tag, v22.commit, v22.compiler.runs, v22.compiler.evmVersion], ['v2.2.0', '405efc100c016ed1a437063b6274b4e24ea7b8b1', 10_000_000, 'istanbul']);
	// die mitgelieferten Circle-Quelldateien sind genau die rekompilierten
	for (const [file, key] of [['FiatTokenV2_2.sol', 'contracts/v2/FiatTokenV2_2.sol'], ['FiatTokenV1.sol', 'contracts/v1/FiatTokenV1.sol'], ['Pausable.sol', 'contracts/v1/Pausable.sol']]) {
		assert.equal(keccak256(toHex(fixture(`usdc/${file}`))), v22.sourceKeccak256[key], file);
	}
	// Name, Symbol, Dezimalen und Version am Pin (eth_call nur lesend)
	assert.match(STATE.usdcViews['symbol()'], /55534443(0){56}$/);
	assert.equal(BigInt(STATE.usdcViews['decimals()']), 6n);
	assert.match(STATE.usdcViews['version()'], /0132(00){31}$/, 'version() = "2"');
});

test('P4F-USDC-APPROVE approve(address,uint256) in the pinned FiatTokenV2_2 overwrites the allowance with the exact amount, returns true, needs no zero-first step', () => {
	assert.equal(toFunctionSelector('approve(address,uint256)'), '0x095ea7b3');
	const impl = fixture('usdc/runtime-usdc-impl-43506849.hex').trim();
	const dispatched = new Set([...impl.slice(2).matchAll(/63([0-9a-f]{8})14(?:61[0-9a-f]{4}|62[0-9a-f]{6})57/g)].map((m) => m[1]));
	assert.ok(dispatched.has('095ea7b3') && dispatched.has('dd62ed3e'), 'the deployed implementation dispatches approve and allowance');
	const v22 = fixture('usdc/FiatTokenV2_2.sol'), v1 = fixture('usdc/FiatTokenV1.sol'), pausable = fixture('usdc/Pausable.sol');
	// V2_2 approve: nur whenNotPaused (keine Blacklist-Modifier mehr), ruft _approve(msg.sender, spender, value), gibt true zurueck
	const approve = /function approve\(address spender, uint256 value\)\s*external\s*override\s*whenNotPaused\s*returns \(bool\)\s*\{\s*_approve\(msg\.sender, spender, value\);\s*return true;\s*\}/;
	assert.match(v22, approve);
	assert.equal(v22.match(/function approve\(/g).length, 1);
	// _approve (V1, von V2_2 nicht ueberschrieben): Null-Adressen verboten, Wert wird UEBERSCHRIEBEN, kein Null-zuerst
	assert.doesNotMatch(v22, /function _approve\(/);
	const body = /function _approve\(\s*address owner,\s*address spender,\s*uint256 value\s*\) internal override \{([\s\S]*?)\n {4}\}/.exec(v1)[1];
	assert.match(body, /require\(owner != address\(0\), "ERC20: approve from the zero address"\);/);
	assert.match(body, /require\(spender != address\(0\), "ERC20: approve to the zero address"\);/);
	assert.match(body, /allowed\[owner\]\[spender\] = value;/);
	assert.match(body, /emit Approval\(owner, spender, value\);/);
	assert.doesNotMatch(body, /allowed\[owner\]\[spender\] == 0|value == 0|\+|add\(/, 'no zero-first requirement, no accumulation');
	// Revert nur bei Pause (und Null-Adressen); das Ziel der P4C-Freigabe ist der Broker, nie die Null-Adresse
	assert.match(pausable, /modifier whenNotPaused\(\) \{\s*require\(!paused, "Pausable: paused"\);/);
	assert.notEqual(P.PRE_SEND_PINS.broker, I.ZERO_ADDRESS);
	// die Politik bleibt: kein permit, kein permit2, keine unbegrenzte Freigabe in der Pruefung
	assert.doesNotMatch(strip(read('src/purchase-pre-send.mjs')), /permit|maxUint256|MAX_UINT|2n \*\* 256n|0xf{64}|approve/i);
});

/* ------------------------------------------------- Determinismus etc. -- */

test('P4F-DETERMINISTIC repeated verification of a fixed chain state gives identical results and never touches inputs', async () => {
	const input = args({ observeAllowance: true });
	const intentBefore = structuredClone(input.persistedIntent);
	const first = await P.verifyPurchasePreSend(input);
	const second = await P.verifyPurchasePreSend(input);
	const plain = (r) => JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? `${v}n` : v));
	assert.equal(plain(first), plain(second));
	assert.deepEqual(input.persistedIntent, intentBefore);
	assert.equal(first.status, 'PRE_SEND_VERIFIED');
});

test('P4F-TOCTOU the verdict states the residual time-of-check risk and never claims it is eliminated', async () => {
	const r = await P.verifyPurchasePreSend(args());
	assert.equal(r.toctou, P.TOCTOU_RESIDUAL);
	assert.match(P.TOCTOU_RESIDUAL, /^NOT eliminated: /);
	assert.match(P.TOCTOU_RESIDUAL, /proxy upgrade/);
	assert.match(P.TOCTOU_RESIDUAL, /immediately before the wallet request/);
	assert.match(P.TOCTOU_RESIDUAL, /bind verifiedAtBlock\/verifiedAtBlockHash to the transaction session/);
	assert.match(P.TOCTOU_RESIDUAL, /P4E receipt verifier/);
	const doc = read('src/purchase-pre-send.mjs');
	assert.match(doc, /RESTRISIKO \(TOCTOU\), NICHT beseitigt/);
	assert.doesNotMatch(doc, /(?<!NICHT |NOT )\b(eliminiert|beseitigt|ausgeschlossen|eliminated|eliminates|prevented|prevents|guaranteed|guarantees)\b/i);
	assert.doesNotMatch(doc, /READY_TO_SEND|readyToSend|productionReady/);
});

/* ------------------------------------------------------ Statik / Import -- */

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
function walk(dir) {
	const out = [];
	for (const name of readdirSync(new URL(`../${dir}`, import.meta.url))) {
		if (name === 'node_modules' || name.startsWith('.') || name === 'dist') continue;
		const path = `${dir}/${name}`;
		if (statSync(new URL(`../${path}`, import.meta.url)).isDirectory()) out.push(...walk(path));
		else if (/\.(m?js|cjs|ts|tsx|jsx|html|svelte|vue)$/.test(name)) out.push(path);
	}
	return out;
}

test('P4F-STATIC the pre-send verifier has no send, sign, wallet, network, DB-mutation or environment surface and uses only read methods', () => {
	const full = read('src/purchase-pre-send.mjs');
	const source = strip(full);
	assert.deepEqual([...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]).sort(), ['./nexus-pinned.mjs', './purchase-intent.mjs', 'viem']);
	// auch in Kommentaren nicht
	assert.doesNotMatch(full, /eth_sendTransaction|eth_sendRawTransaction|wallet_sendCalls|wallet_sendTransaction|sendTransaction|sendRawTransaction|writeContract|createWalletClient|signTransaction|personal_sign|eth_sign\b|signTypedData|signMessage|walletconnect|safe-global|execTransaction/i);
	assert.doesNotMatch(source, /\.approve\(|\.buyCover\(|buyCover|095ea7b3|7c59cac4|functionName|encodeFunctionData|purchase-tx-builder|purchase-tx-decode|build(ExactUsdcApproval|NexusBuyCover)/);
	assert.doesNotMatch(source, /markSubmitted|markConfirmed|markBuilt|markFailed|cancelIntent|expireIntent|createIntent|purchase-intent-db|\.rpc\(|\.from\(|\binsert\b|\bupdate\b|\bdelete\b|supabase/i);
	assert.doesNotMatch(source, /\bimport\s*\(|require\s*\(|fetch\s*\(|XMLHttpRequest|WebSocket|https?:|createPublicClient|process\.|node:|Date\.now|new Date|Math\.random|globalThis|localStorage/);
	assert.equal(source.match(/\.request\(/g).length, 1);
	assert.match(source, /if \(!PRE_SEND_READ_METHODS\.includes\(method\)\) throw/);
	assert.deepEqual([...P.PRE_SEND_READ_METHODS].sort(), ['eth_blockNumber', 'eth_call', 'eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt']);
	// eth_call nur fuer die eine Beobachtung allowance(owner, Broker)
	assert.equal(source.match(/'eth_call'/g).length, 2, 'the method list and the one allowance read');
	assert.ok(Object.isFrozen(P.PRE_SEND_READ_METHODS) && Object.isFrozen(P.PRE_SEND_PINS) && Object.isFrozen(P.USDC_PIN) && Object.isFrozen(P.PRE_SEND_STATUSES));
	assert.equal(P.PRE_SEND_CHECKS.length, 17);
});

test('P4F-IMPORT only test/purchase-pre-send.test.mjs imports the pre-send verifier; no API route exists', () => {
	const MODULE = 'src/purchase-pre-send.mjs';
	// P4H (20.10.2026): die unerreichbare Ausfuehrungs-Sitzung (P4H-SESSION-IMPORT) ruft den Pruefer fuer genau den geladenen Intent.
	const SESSION = 'src/purchase-execution-session.mjs';
	const runtime = [...walk('src'), ...walk('api'), ...walk('web'), ...walk('scripts')].filter((f) => f !== MODULE && f !== SESSION && !f.startsWith('web/dist'));
	assert.ok(runtime.includes('src/bot.mjs') && runtime.some((f) => f.startsWith('api/')) && runtime.some((f) => f.startsWith('web/src/')) && runtime.some((f) => /^src\/agent-/.test(f)));
	for (const file of runtime) assert.doesNotMatch(read(file), /purchase-pre-send(\.mjs)?['"`]|verifyPurchasePreSend/, file);
	const importing = /(?:from\s*|import\s*\(\s*)['"`][^'"`]*purchase-pre-send\.mjs/;
	assert.deepEqual([...walk('src'), ...walk('api'), ...walk('test'), ...walk('test-support')].filter((f) => importing.test(read(f))).sort(), [SESSION, 'test/purchase-execution-session.test.mjs', 'test/purchase-pre-send.test.mjs']);
	assert.deepEqual(walk('api').filter((f) => /pre-?send|receipt|purchase|buy|intent/i.test(f)), [], 'no pre-send or purchase route');
	// der Pre-Send-Pruefer verbindet den Beleg-Pruefer nicht mit markConfirmed (Orchestrierung bleibt offen)
	assert.doesNotMatch(read(MODULE), /verifyPurchaseReceipt|purchase-receipt/);
});
