/**
 * Nexus P4E (19.10.2026): unabhaengige, nur lesende Beleg-Pruefung (src/purchase-receipt.mjs).
 *
 * Zwei Welten, beide offline:
 * - SYNTHETISCH / KONSTRUIERT: ein Kauf, wie ihn CoverRaccoon erzeugen wuerde, gebaut aus der
 *   verifizierten ABI (Ereignis- und View-Signaturen aus Cover v3.3.0 / CoverNFT, Broker v2.12.1)
 *   und den echten, gepinnten Laufzeit-Bytecodes. Er ist KEIN Mainnet-Beleg und belegt nur das
 *   Verhalten des Pruefers (E3), nie eine echte Ausfuehrung.
 * - ECHT, NEGATIV: Beleg und Zustand der Mainnet-Transaktion aus Block 26219867, am 19.10.2026
 *   nur lesend von zwei unabhaengigen Anbietern mitgeschnitten (fixtures/nexus/
 *   buycover-receipt-26219867.json). Fremder Kauf mit Kommission 1000 und leerem ipfsData:
 *   strukturelles Beispiel, NIE ein positiver CoverRaccoon-Beleg.
 * Kein Test braucht ein Live-RPC; die Leser sind Attrappen mit request({ method, params }).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, keccak256, pad, parseAbi, toEventSelector, toFunctionSelector, toHex } from 'viem';
const R = await import('../src/purchase-receipt.mjs');
const I = await import('../src/purchase-intent.mjs');

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const runtime = (name) => read(`test/fixtures/nexus/${name}`).trim();
const CODE = { broker: runtime('runtime-coverbroker-cb2b7366.hex'), proxy: runtime('runtime-cover-proxy-cafeac0f.hex'), implementation: runtime('runtime-cover-impl-cafeaff1.hex') };

const WALLET = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const OTHER = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359';
const BROKER = '0xcb2b736652d2dbf7d72e4db880cf6b7d99507814';
const COVER = '0xcafeac0ff5da0a2777d915531bfa6b29d282ee62';
const IMPL = '0xcafeaff1a21418f530feb00c6baef07523979c05';
const NFT = '0xcafeaca76be547f14d0220482667b42d8e7bc3eb';
const POOL = '0xcafea91714e55756c125b509274ede9bc91697cb';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ZERO = I.ZERO_ADDRESS;
const T0 = 1_792_400_000;
/** NUR TEST: CIDv0 der UTF-8-Bytes 'coverraccoon-p4c-test-fixture: not a Nexus proof-of-loss record'. Keine Proof-of-Loss-CID. */
const TEST_CID = 'QmQPWELjoGp6zqfrELz2xeafuPgtSBfvVF1pjX3DvuFsah';
const OTHER_CID = 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY';
const intent = (patch = {}) => ({
	id: '0b9e6f1c-3d2a-4f5b-8c7d-1e2f3a4b5c6d', wallet: WALLET, chainId: 1, deploymentKey: 'aave-v3-ethereum-core', productId: 97, productTypeId: 0, coverAssetId: 6,
	amountRaw: '1000000000', periodDays: 30, quotePremiumRaw: '3000578', maxPremiumRaw: '3030584', quoteFetchedAt: T0, capacityFetchedAt: T0, wordingCid: OTHER_CID,
	annexCid: null, termsHash: keccak256('0x01'), proofOfLossCid: TEST_CID, commissionRatio: 0, commissionDestination: ZERO, pinVersion: I.PURCHASE_PIN_VERSION,
	acknowledgedAt: T0 + 10, expiresAt: T0 + 610, ...patch
});

/* Test-eigene ABI aus den Quellsignaturen; nicht aus dem Builder oder Decoder. */
const SOL = parseAbi([
	'struct BuyCoverParams { uint256 coverId; address owner; uint24 productId; uint8 coverAsset; uint96 amount; uint32 period; uint256 maxPremiumInAsset; uint8 paymentAsset; uint16 commissionRatio; address commissionDestination; string ipfsData; }',
	'struct PoolAllocationRequest { uint256 poolId; uint256 coverAmountInAsset; }',
	'function buyCover(BuyCoverParams params, PoolAllocationRequest[] poolAllocationRequests) payable returns (uint256)'
]);
const PARAMS = { coverId: 0n, owner: WALLET, productId: 97, coverAsset: 6, amount: 1_000_000_000n, period: 2_592_000, maxPremiumInAsset: 3_030_584n, paymentAsset: 6, commissionRatio: 0, commissionDestination: ZERO, ipfsData: TEST_CID };
const ALLOC = [{ poolId: 2n, coverAmountInAsset: 1_000_192_871n }];
const calldata = (patch = {}, alloc = ALLOC) => encodeFunctionData({ abi: SOL, functionName: 'buyCover', args: [{ ...PARAMS, ...patch }, alloc] });
const STORED_CALLDATA_HASH = keccak256(calldata());

/* ------------------------------------------------- SYNTHETISCHE Welt -- */

const SYNTHETIC = 'SYNTHETIC / CONSTRUCTED from the verified ABI - not a mainnet receipt';
const q = (n) => toHex(BigInt(n));
const word = (n) => encodeAbiParameters([{ type: 'uint256' }], [BigInt(n)]);
const addr = (a) => pad(a, { size: 32 });
const TX_HASH = keccak256(toHex('p4e-synthetic-transaction'));
const BLOCK_HASH = keccak256(toHex('p4e-synthetic-block'));
const BLOCK = 30_000_000n, COVER_ID = 7001n, TS = 1_792_500_000n, PREMIUM = 3_000_578n, MAX_PREMIUM = 3_030_584n;
const TOPIC = { CoverBought: toEventSelector('CoverBought(uint256 indexed coverId, uint256 indexed originalCoverId, uint256 indexed buyerMemberId, uint256 productId)'), Transfer: toEventSelector('Transfer(address indexed from, address indexed to, uint256 value)') };
const SEL = { getCoverData: toFunctionSelector('getCoverData(uint256)'), getCoverReference: toFunctionSelector('getCoverReference(uint256)'), getCoverMetadata: toFunctionSelector('getCoverMetadata(uint256)'), ownerOf: toFunctionSelector('ownerOf(uint256)') };
const COVER_DATA = [{ type: 'tuple', components: ['uint24', 'uint8', 'uint96', 'uint32', 'uint32', 'uint32', 'uint16', 'uint16'].map((type) => ({ type })) }];
const REFERENCE = [{ type: 'tuple', components: [{ type: 'uint32' }, { type: 'uint32' }] }];

const log = (address, topics, data) => ({ address, topics, data });
const usdc = (from, to, value) => log(USDC, [TOPIC.Transfer, addr(from), addr(to)], word(value));
const coverBought = ({ coverId = COVER_ID, original = coverId, member = 9301n, product = 97n, emitter = COVER } = {}) => log(emitter, [TOPIC.CoverBought, word(coverId), word(original), word(member)], word(product));
const mint = ({ to = WALLET, id = COVER_ID, from = ZERO, emitter = NFT } = {}) => log(emitter, [TOPIC.Transfer, addr(from), addr(to), word(id)], '0x');
const coverState = (patch = {}) => ({ productId: 97, coverAsset: 6, amount: 1_000_192_871n, start: Number(TS), period: 2_592_000, gracePeriod: 2_592_000, original: COVER_ID, metadata: TEST_CID, owner: WALLET, ...patch });

/** Eine vollstaendige, konsistente SYNTHETISCHE Kette; Tests veraendern sie gezielt. */
function world() {
	return {
		label: SYNTHETIC,
		chainId: '0x1', head: BLOCK + 100n, finalized: BLOCK + 10n,
		tx: { hash: TX_HASH, from: WALLET, to: BROKER, input: calldata(), value: '0x0', chainId: '0x1', blockHash: BLOCK_HASH, blockNumber: q(BLOCK), nonce: '0x4', gas: '0x7a120', type: '0x2' },
		receipt: { transactionHash: TX_HASH, status: '0x1', from: WALLET, to: BROKER, blockHash: BLOCK_HASH, blockNumber: q(BLOCK), gasUsed: '0x5208', logs: [
			usdc(WALLET, BROKER, MAX_PREMIUM), mint(), usdc(BROKER, POOL, PREMIUM), coverBought(), usdc(BROKER, WALLET, MAX_PREMIUM - PREMIUM)
		] },
		blocks: { [q(BLOCK)]: { number: q(BLOCK), hash: BLOCK_HASH, timestamp: q(TS), parentHash: keccak256('0x02') } },
		code: { [BROKER]: CODE.broker, [COVER]: CODE.proxy, [IMPL]: CODE.implementation },
		slot: addr(IMPL),
		covers: { [COVER_ID]: coverState() }
	};
}

/** Attrappe eines Lesers; Zustandsabfragen NUR am Belegblock (sonst Fehler). */
function reader(w, seen = []) {
	const atBlock = (tag) => { if (tag !== w.receipt?.blockNumber) throw new Error(`state read at ${tag}, not at the receipt block`); };
	const cover = (data) => { const c = w.covers[BigInt(`0x${data.slice(10)}`)]; if (!c) throw new Error('execution reverted'); return c; };
	return {
		async request({ method, params }) {
			seen.push(method);
			switch (method) {
				case 'eth_chainId': return w.chainId;
				case 'eth_getTransactionByHash': return w.tx && params[0] === w.tx.hash ? structuredClone(w.tx) : null;
				case 'eth_getTransactionReceipt': {
					if (!w.receipt || params[0] !== w.receipt.transactionHash) return null;
					const r = structuredClone(w.receipt);
					r.logs = r.logs.map((l, i) => ({ blockHash: r.blockHash, transactionHash: r.transactionHash, logIndex: q(i + 40), removed: false, ...l }));
					return r;
				}
				case 'eth_blockNumber': return typeof w.head === 'string' ? w.head : q(w.head);
				case 'eth_getBlockByNumber': return params[0] === 'finalized' ? { number: q(w.finalized), hash: keccak256('0x03'), timestamp: '0x0' } : structuredClone(w.blocks[params[0]] ?? null);
				case 'eth_getCode': atBlock(params[1]); return w.code[params[0].toLowerCase()] ?? '0x';
				case 'eth_getStorageAt': atBlock(params[2]); return params[0].toLowerCase() === COVER && params[1] === R.RECEIPT_PINS.coverImplementationSlot ? w.slot : pad('0x0', { size: 32 });
				case 'eth_call': {
					atBlock(params[1]);
					const { to, data } = params[0];
					const sel = data.slice(0, 10);
					if (to === NFT && sel === SEL.ownerOf) return addr(cover(data).owner);
					if (to !== COVER) throw new Error('execution reverted');
					const c = cover(data);
					if (sel === SEL.getCoverData) return encodeAbiParameters(COVER_DATA, [[c.productId, c.coverAsset, c.amount, c.start, c.period, c.gracePeriod, 5000, 20000]]);
					if (sel === SEL.getCoverReference) return encodeAbiParameters(REFERENCE, [[Number(c.original), Number(BigInt(`0x${data.slice(10)}`))]]);
					if (sel === SEL.getCoverMetadata) return encodeAbiParameters([{ type: 'string' }], [c.metadata]);
					throw new Error('execution reverted');
				}
				default: throw new Error(`unexpected method ${method}`);
			}
		}
	};
}

/**
 * Prueft gegen die SYNTHETISCHE Welt. edit veraendert beide Leser, editB nur Leser B.
 * bind: calldata_hash folgt der veraenderten Eingabe (isoliert die Decoder-Politik).
 */
async function verify(edit = () => {}, { editB, bind = false, args = {}, intentPatch = {} } = {}) {
	const a = world();
	edit(a);
	const b = structuredClone(a);
	editB?.(b);
	return R.verifyPurchaseReceipt({ rpcA: reader(a), rpcB: reader(b), intent: intent(intentPatch), txHash: TX_HASH, calldataHash: bind ? keccak256(a.tx.input) : STORED_CALLDATA_HASH, minConfirmations: 3, ...args });
}
const status = async (...a) => (await verify(...a)).status;
const failsWith = async (expected, errors, ...a) => {
	const r = await verify(...a);
	assert.equal(r.status, expected, JSON.stringify(r.errors));
	assert.equal(r.ok, false);
	assert.equal(r.coverId, null, 'no cover id without a verified purchase');
	if (errors) assert.deepEqual(r.errors, errors);
	return r;
};
const setTx = (patch) => (w) => { Object.assign(w.tx, patch); for (const k of ['from', 'to']) if (k in patch) w.receipt[k] = patch[k]; };
const withLogs = (fn) => (w) => { w.receipt.logs = fn(w.receipt.logs); };
const isCoverBought = (l) => l.topics[0] === TOPIC.CoverBought;
const isMint = (l) => l.address === NFT;

/* ------------------------------------------------------------- Positiv -- */

test('P4E-VALID a SYNTHETIC receipt constructed from the verified ABI and pins verifies, with every check passed', async () => {
	assert.equal(world().label, SYNTHETIC);
	// die Konstanten des Pruefers folgen aus den Quellsignaturen und den Pins
	assert.equal(R.EVENT_TOPICS.CoverBought, TOPIC.CoverBought);
	assert.equal(R.EVENT_TOPICS.Transfer, TOPIC.Transfer);
	assert.deepEqual({ ...R.VIEW_SELECTORS }, SEL);
	assert.equal(calldata().slice(0, 10), '0x7c59cac4');
	assert.equal(R.RECEIPT_PINS.coverImplementationSlot, keccak256(toHex('org.govblocks.proxy.implementation')));
	assert.equal(keccak256(CODE.broker), R.RECEIPT_PINS.brokerCodeHash);
	assert.equal(keccak256(CODE.proxy), R.RECEIPT_PINS.coverProxyCodeHash);
	assert.equal(keccak256(CODE.implementation), R.RECEIPT_PINS.coverImplementationCodeHash);
	assert.deepEqual([R.RECEIPT_PINS.broker, R.RECEIPT_PINS.coverProxy, R.RECEIPT_PINS.coverImplementation, R.RECEIPT_PINS.coverNft, R.RECEIPT_PINS.pool], [BROKER, COVER, IMPL, NFT, POOL]);
	assert.equal(R.RECEIPT_PINS.brokerMemberId, 9301n);

	const r = await verify();
	assert.deepEqual(r, { ok: true, status: 'VERIFIED_COVER_PURCHASE', coverId: COVER_ID, blockNumber: BLOCK, blockHash: BLOCK_HASH, checks: Object.fromEntries(R.REQUIRED_CHECKS.map((c) => [c, true])), errors: [] });
	assert.ok(Object.isFrozen(r) && Object.isFrozen(r.checks) && Object.isFrozen(r.errors));
	// Allokationen runden auf: der Zustand darf mehr decken als der Intent, nie weniger
	assert.equal((await verify((w) => { w.covers[COVER_ID].amount = 1_000_000_000n; })).status, 'VERIFIED_COVER_PURCHASE', 'amount equal to the intent is enough');
	// Erstattung 0 (Praemie == maxPremium) ist ein gueltiger Fluss
	assert.equal(await status(withLogs((ls) => ls.map((l) => (l.address === USDC && l.topics[2] === addr(POOL) ? usdc(BROKER, POOL, MAX_PREMIUM) : l)).filter((l) => !(l.address === USDC && l.topics[2] === addr(WALLET))))), 'VERIFIED_COVER_PURCHASE');
});

/* --------------------------------------------------------- Transaktion -- */

test('P4E-TX missing, pending and reverted transactions are never confirmed', async () => {
	await failsWith('TX_NOT_FOUND', ['TX_NOT_FOUND'], (w) => { w.tx = null; w.receipt = null; });
	await failsWith('RECEIPT_NOT_FOUND', ['RECEIPT_NOT_FOUND'], (w) => { w.receipt = null; });
	const reverted = await failsWith('TX_FAILED', ['TX_FAILED'], (w) => { w.receipt.status = '0x0'; });
	assert.equal(reverted.checks.receipt, false);
	await failsWith('RECEIPT_MISMATCH', ['TX_RECEIPT_BLOCK'], (w) => { w.tx.blockHash = keccak256('0x09'); });
	await failsWith('RECEIPT_MISMATCH', ['RECEIPT_LOGS'], withLogs((ls) => ls.map((l, i) => (i === 0 ? { ...l, removed: true } : l))));
	await failsWith('RECEIPT_MISMATCH', ['RECEIPT_FROM_TO'], (w) => { w.receipt.from = OTHER; });
});

test('P4E-CHAIN wrong chain, sender, Broker target or value fail closed', async () => {
	await failsWith('WRONG_CHAIN', ['WRONG_CHAIN'], (w) => { w.chainId = '0x5'; });
	await failsWith('WRONG_CHAIN', ['TX_CHAIN_ID'], (w) => { w.tx.chainId = '0xa'; });
	await failsWith('WRONG_SENDER', ['WRONG_SENDER'], setTx({ from: OTHER }));
	await failsWith('WRONG_TARGET', ['WRONG_TARGET'], setTx({ to: OTHER }));
	await failsWith('WRONG_VALUE', ['WRONG_VALUE'], setTx({ value: '0x1' }));
});

test('P4E-CALLDATA the transaction input must hash to the stored calldata_hash and carry the buyCover selector', async () => {
	// eine andere, fuer sich politikkonforme Eingabe (andere Pool-Zuteilung): nur der gebundene Hash faengt sie
	const valid = calldata({}, [{ poolId: 3n, coverAmountInAsset: 1_000_192_871n }]);
	assert.equal(await status(setTx({ input: valid }), { bind: true }), 'VERIFIED_COVER_PURCHASE', 'the swapped input is otherwise acceptable');
	await failsWith('CALLDATA_HASH_MISMATCH', ['CALLDATA_HASH_MISMATCH'], setTx({ input: valid }));
	await failsWith('CALLDATA_HASH_MISMATCH', ['CALLDATA_HASH_MISMATCH'], setTx({ input: `${calldata()}00` }));
	const selector = await failsWith('CALLDATA_POLICY_MISMATCH', null, setTx({ input: `0x7c59cac5${calldata().slice(10)}` }), { bind: true });
	assert.ok(selector.errors.includes('SELECTOR'), JSON.stringify(selector.errors));
	assert.ok((await failsWith('CALLDATA_POLICY_MISMATCH', null, setTx({ input: `${calldata()}00` }), { bind: true })).errors.includes('NON_CANONICAL_ENCODING'));
});

test('P4E-POLICY the independent P4C decoder rejects owner, product, amount, period, maxPremium, commission and proof-of-loss mismatches', async () => {
	const cases = [
		[{ owner: OTHER }, ['OWNER']],
		[{ productId: 98 }, ['PRODUCT']],
		[{ amount: 999_999_999n }, ['AMOUNT']],
		[{ period: 2_592_001 }, ['PERIOD']],
		[{ maxPremiumInAsset: 3_030_585n }, ['MAX_PREMIUM']],
		[{ commissionRatio: 1000, commissionDestination: OTHER }, ['COMMISSION_RATIO', 'COMMISSION_DESTINATION']],
		[{ commissionRatio: 1000 }, ['COMMISSION_RATIO']],
		[{ ipfsData: '' }, ['PROOF_OF_LOSS_CID']],
		[{ ipfsData: OTHER_CID }, ['PROOF_OF_LOSS_CID']],
		[{ coverId: 5n }, ['COVER_ID']]
	];
	for (const [patch, errors] of cases) await failsWith('CALLDATA_POLICY_MISMATCH', errors, setTx({ input: calldata(patch) }), { bind: true });
	// ein Intent ohne Proof-of-Loss wird nie geprueft
	await failsWith('INVALID_INPUT', ['INTENT_WITHOUT_PROOF_OF_LOSS'], undefined, { intentPatch: { proofOfLossCid: null } });
	await failsWith('INVALID_INPUT', ['INTENT_INVALID'], undefined, { intentPatch: { commissionRatio: 1000 } });
});

/* ------------------------------------------------------------ Ereignisse -- */

test('P4E-COVERBOUGHT exactly one CoverBought from the Cover proxy with product 97, broker member 9301 and a new cover id', async () => {
	await failsWith('COVERBOUGHT_MISSING', ['COVERBOUGHT_MISSING'], withLogs((ls) => ls.filter((l) => !isCoverBought(l))));
	await failsWith('COVERBOUGHT_MISMATCH', ['COVERBOUGHT_PRODUCT'], withLogs((ls) => ls.map((l) => (isCoverBought(l) ? coverBought({ product: 98n }) : l))));
	await failsWith('COVERBOUGHT_MISMATCH', ['BUYER_MEMBER_ID'], withLogs((ls) => ls.map((l) => (isCoverBought(l) ? coverBought({ member: 9302n }) : l))));
	// neue Cover: originalCoverId == coverId (Cover.sol v3.3.0); ein Bezug auf ein anderes Cover ist kein neuer Kauf
	await failsWith('COVERBOUGHT_MISMATCH', ['ORIGINAL_COVER_ID'], withLogs((ls) => ls.map((l) => (isCoverBought(l) ? coverBought({ original: 5n }) : l))));
	await failsWith('COVERBOUGHT_MISMATCH', ['COVERBOUGHT_FOREIGN_EMITTER'], withLogs((ls) => [...ls, coverBought({ emitter: OTHER })]));
	await failsWith('COVERBOUGHT_MISMATCH', ['COVERBOUGHT_NOT_UNIQUE'], withLogs((ls) => [...ls, coverBought({ coverId: COVER_ID + 1n })]));
	await failsWith('COVERBOUGHT_MISMATCH', ['COVERBOUGHT_SHAPE'], withLogs((ls) => ls.map((l) => (isCoverBought(l) ? { ...l, data: '0x' } : l))));
});

test('P4E-NFT the CoverNFT mints the cover id to the intent wallet', async () => {
	await failsWith('NFT_MINT_MISSING', ['NFT_MINT_MISSING'], withLogs((ls) => ls.filter((l) => !isMint(l))));
	// eine Praegung durch einen anderen Vertrag zaehlt nicht
	await failsWith('NFT_MINT_MISSING', ['NFT_MINT_MISSING'], withLogs((ls) => ls.map((l) => (isMint(l) ? mint({ emitter: OTHER }) : l))));
	await failsWith('NFT_OWNER_MISMATCH', ['NFT_RECIPIENT'], (w) => { withLogs((ls) => ls.map((l) => (isMint(l) ? mint({ to: OTHER }) : l)))(w); w.covers[COVER_ID].owner = OTHER; });
	await failsWith('NFT_OWNER_MISMATCH', ['NFT_NOT_A_MINT'], withLogs((ls) => ls.map((l) => (isMint(l) ? mint({ from: OTHER }) : l))));
	// CoverBought und NFT muessen dasselbe Cover nennen (der Zustand existiert auch fuer die andere Nummer)
	await failsWith('NFT_OWNER_MISMATCH', ['NFT_TOKEN_ID'], (w) => { withLogs((ls) => ls.map((l) => (isMint(l) ? mint({ id: COVER_ID + 1n }) : l)))(w); w.covers[COVER_ID + 1n] = coverState({ original: COVER_ID + 1n }); });
	await failsWith('NFT_OWNER_MISMATCH', ['NFT_TRANSFER_NOT_UNIQUE'], withLogs((ls) => [...ls, mint({ id: COVER_ID + 1n })]));
});

/* -------------------------------------------------------------- Zustand -- */

test('P4E-STATE Cover state at the receipt block matches product, asset, amount, period, start, owner and metadata', async () => {
	const state = (patch) => (w) => { Object.assign(w.covers[COVER_ID], patch); };
	await failsWith('COVER_STATE_MISMATCH', ['STATE_PRODUCT'], state({ productId: 98 }));
	await failsWith('COVER_STATE_MISMATCH', ['STATE_ASSET'], state({ coverAsset: 0 }));
	await failsWith('COVER_STATE_MISMATCH', ['STATE_AMOUNT_BELOW_INTENT'], state({ amount: 999_999_999n }));
	await failsWith('COVER_STATE_MISMATCH', ['STATE_PERIOD'], state({ period: 2_592_001 }));
	// start = block.timestamp des Belegblocks (Cover._createCover), Ablauf = start + period
	await failsWith('COVER_STATE_MISMATCH', ['STATE_START'], state({ start: Number(TS) + 1 }));
	await failsWith('COVER_STATE_MISMATCH', ['STATE_NOT_ORIGINAL'], state({ original: 5n }));
	await failsWith('NFT_OWNER_MISMATCH', ['OWNER_OF'], state({ owner: OTHER }));
	await failsWith('POL_METADATA_MISMATCH', ['POL_METADATA_MISMATCH'], state({ metadata: '' }));
	await failsWith('POL_METADATA_MISMATCH', ['POL_METADATA_MISMATCH'], state({ metadata: OTHER_CID }));
});

test('P4E-FLOW USDC transfers are supporting evidence: a third-party payout fails closed', async () => {
	const commission = withLogs((ls) => ls.map((l) => (l.address === USDC && l.topics[2] === addr(WALLET) ? usdc(BROKER, OTHER, MAX_PREMIUM - PREMIUM) : l)));
	await failsWith('TOKEN_FLOW_MISMATCH', ['USDC_THIRD_PARTY_TRANSFER', 'USDC_BALANCE'], commission);
	await failsWith('TOKEN_FLOW_MISMATCH', ['USDC_PULL'], withLogs((ls) => ls.map((l, i) => (i === 0 ? usdc(WALLET, BROKER, MAX_PREMIUM + 1n) : l))));
	await failsWith('TOKEN_FLOW_MISMATCH', ['USDC_BALANCE'], withLogs((ls) => ls.map((l) => (l.address === USDC && l.topics[2] === addr(WALLET) ? usdc(BROKER, WALLET, 1n) : l))));
});

/* --------------------------------------------------------------- Pins -- */

test('P4E-PINS Broker code, proxy code, proxy implementation and implementation code are checked at the receipt block', async () => {
	await failsWith('BROKER_DRIFT_AT_EXECUTION', ['BROKER_DRIFT_AT_EXECUTION'], (w) => { w.code[BROKER] = `${CODE.broker}00`; });
	await failsWith('PROXY_DRIFT_AT_EXECUTION', ['PROXY_CODE'], (w) => { w.code[COVER] = `${CODE.proxy}00`; });
	await failsWith('PROXY_DRIFT_AT_EXECUTION', ['PROXY_IMPLEMENTATION'], (w) => { w.slot = addr(OTHER); });
	await failsWith('PROXY_DRIFT_AT_EXECUTION', ['PROXY_IMPLEMENTATION'], (w) => { w.slot = pad('0x0', { size: 32 }); });
	await failsWith('PROXY_DRIFT_AT_EXECUTION', ['IMPLEMENTATION_CODE'], (w) => { w.code[IMPL] = `${CODE.implementation}00`; });
	// ein Beleg unter einer unbekannten Implementierung wird nie VERIFIED, auch wenn alles andere stimmt
	const drift = await verify((w) => { w.slot = addr(OTHER); w.code[OTHER] = CODE.implementation; });
	assert.equal(drift.status, 'PROXY_DRIFT_AT_EXECUTION');
	assert.equal(drift.checks.proxyImplementation, false);
	assert.equal(drift.checks.coverBought, null, 'nothing after the drift is evaluated');
});

/* ---------------------------------------------- Bestaetigung, Reorgs -- */

test('P4E-CONFIRM confirmation depth and finality are enforced; zero confirmations are refused', async () => {
	assert.deepEqual({ ...R.PRODUCTION_CONFIRMATION_POLICY }, { minConfirmations: 64, requireFinalized: true });
	for (const minConfirmations of [0, -1, 1.5, '3', undefined]) await failsWith('INVALID_INPUT', ['MIN_CONFIRMATIONS'], undefined, { args: { minConfirmations } });
	await failsWith('INVALID_INPUT', ['REQUIRE_FINALIZED'], undefined, { args: { requireFinalized: 'no' } });
	// Bestaetigungen = Kopf - Block + 1
	assert.equal(await status((w) => { w.head = BLOCK + 2n; }), 'VERIFIED_COVER_PURCHASE');
	await failsWith('INSUFFICIENT_CONFIRMATIONS', ['INSUFFICIENT_CONFIRMATIONS'], (w) => { w.head = BLOCK + 1n; });
	await failsWith('INSUFFICIENT_CONFIRMATIONS', ['INSUFFICIENT_CONFIRMATIONS'], undefined, { args: { minConfirmations: 102 } });
	assert.equal(await status(undefined, { args: { minConfirmations: 101 } }), 'VERIFIED_COVER_PURCHASE');
	// es zaehlt der niedrigere Kopf der beiden Leser
	await failsWith('INSUFFICIENT_CONFIRMATIONS', ['INSUFFICIENT_CONFIRMATIONS'], undefined, { editB: (w) => { w.head = BLOCK; } });
	// Finalitaet ist Standard; abschaltbar nur ausdruecklich
	await failsWith('INSUFFICIENT_CONFIRMATIONS', ['NOT_FINALIZED'], (w) => { w.finalized = BLOCK - 1n; });
	await failsWith('INSUFFICIENT_CONFIRMATIONS', ['NOT_FINALIZED'], undefined, { editB: (w) => { w.finalized = BLOCK - 1n; } });
	assert.equal(await status((w) => { w.finalized = BLOCK - 1n; }, { args: { requireFinalized: false } }), 'VERIFIED_COVER_PURCHASE');
});

test('P4E-REORG a block hash that differs from the block at that number, or between readers, is never confirmed', async () => {
	await failsWith('BLOCK_HASH_MISMATCH', ['BLOCK_HASH_MISMATCH'], (w) => { w.blocks[q(BLOCK)].hash = keccak256('0x0b'); });
	await failsWith('BLOCK_HASH_MISMATCH', ['BLOCK_HASH_MISMATCH'], (w) => { delete w.blocks[q(BLOCK)]; });
	// der Beleg zeigt auf einen Block, den die Kette unter dieser Nummer nicht mehr kennt
	const reorged = keccak256('0x0c');
	await failsWith('BLOCK_HASH_MISMATCH', ['BLOCK_HASH_MISMATCH'], (w) => { w.tx.blockHash = reorged; w.receipt.blockHash = reorged; });
	await failsWith('RPC_DISAGREEMENT', ['RPC_DISAGREEMENT:eth_getTransactionReceipt'], undefined, { editB: (w) => { w.receipt.blockHash = reorged; } });
	await failsWith('RPC_DISAGREEMENT', ['RPC_DISAGREEMENT:eth_getTransactionByHash'], undefined, { editB: (w) => { w.receipt.blockHash = reorged; w.tx.blockHash = reorged; } });
	await failsWith('RPC_DISAGREEMENT', ['RPC_DISAGREEMENT:eth_getBlockByNumber'], undefined, { editB: (w) => { w.blocks[q(BLOCK)].hash = reorged; } });
});

/* -------------------------------------------------------- Zwei Leser -- */

test('P4E-TWO-RPC reader B disagreeing on block hash, input, implementation, code, logs or state fails closed without majority', async () => {
	const pairs = [
		['eth_getTransactionByHash', (w) => { w.tx.input = calldata({ amount: 2_000_000_000n }); }],
		['eth_getTransactionByHash', (w) => { w.tx.from = OTHER; }],
		['eth_getTransactionReceipt', (w) => { w.receipt.logs = w.receipt.logs.filter((l) => !isCoverBought(l)); }],
		['eth_getTransactionReceipt', (w) => { w.receipt.status = '0x0'; }],
		['eth_getBlockByNumber', (w) => { w.blocks[q(BLOCK)].timestamp = q(TS + 1n); }],
		['eth_getStorageAt', (w) => { w.slot = addr(OTHER); }],
		['eth_getCode', (w) => { w.code[IMPL] = `${CODE.implementation}00`; }],
		['eth_getCode', (w) => { w.code[BROKER] = `${CODE.broker}00`; }],
		['eth_call', (w) => { w.covers[COVER_ID].owner = OTHER; }],
		['eth_call', (w) => { w.covers[COVER_ID].metadata = ''; }],
		['eth_chainId', (w) => { w.chainId = '0x5'; }]
	];
	for (const [method, editB] of pairs) {
		await failsWith('RPC_DISAGREEMENT', [`RPC_DISAGREEMENT:${method}`], undefined, { editB });
		// symmetrisch: A ist nicht der "richtige" Leser
		const swapped = await verify(editB, { editB: (w) => { const fresh = world(); Object.assign(w, fresh); } });
		assert.equal(swapped.status, 'RPC_DISAGREEMENT', method);
	}
	// beide Leser werden fuer jede Abfrage gefragt
	const seenA = [], seenB = [];
	const w = world();
	const r = await R.verifyPurchaseReceipt({ rpcA: reader(w, seenA), rpcB: reader(structuredClone(w), seenB), intent: intent(), txHash: TX_HASH, calldataHash: STORED_CALLDATA_HASH, minConfirmations: 3 });
	assert.equal(r.status, 'VERIFIED_COVER_PURCHASE');
	assert.deepEqual(seenA, seenB);
	assert.ok(seenA.length >= 14, `${seenA.length} reads`);
	// ein Leser zweimal ist kein zweiter Leser
	const single = reader(w);
	assert.deepEqual((await R.verifyPurchaseReceipt({ rpcA: single, rpcB: single, intent: intent(), txHash: TX_HASH, calldataHash: STORED_CALLDATA_HASH, minConfirmations: 3 })).errors, ['RPC_NOT_INDEPENDENT']);
});

test('P4E-RPC-ERROR a reader failure is a temporary failure, never a failed or confirmed purchase', async () => {
	const failing = (method) => (w) => { w.failOn = method; };
	const flaky = (w, inner) => ({ request: (x) => (x.method === w.failOn ? Promise.reject(new Error('503 upstream')) : inner.request(x)) });
	for (const method of ['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_blockNumber']) {
		for (const side of ['A', 'B']) {
			const a = world(), b = structuredClone(a);
			failing(method)(side === 'A' ? a : b);
			const r = await R.verifyPurchaseReceipt({ rpcA: flaky(a, reader(a)), rpcB: flaky(b, reader(b)), intent: intent(), txHash: TX_HASH, calldataHash: STORED_CALLDATA_HASH, minConfirmations: 3 });
			assert.equal(r.status, 'TEMPORARY_RPC_FAILURE', `${side} ${method}`);
			assert.deepEqual(r.errors, [`RPC_${side}_FAILED:${method}`]);
			assert.equal(r.ok, false);
		}
	}
	// ein Leser kennt die Transaktion nicht, der andere schon: Uneinigkeit, nicht "nicht gefunden"
	await failsWith('RPC_DISAGREEMENT', ['RPC_DISAGREEMENT:eth_getTransactionReceipt'], undefined, { editB: (w) => { w.receipt = null; } });
	await failsWith('RPC_DISAGREEMENT', ['RPC_DISAGREEMENT:eth_getTransactionByHash'], undefined, { editB: (w) => { w.tx = null; } });
	// eine fehlerhafte Antwort beider Leser ist kein Kauf
	await failsWith('RPC_DISAGREEMENT', ['MALFORMED:head'], (w) => { w.head = 'latest'; });
});

/* ------------------------------------------------------ Client-Grenze -- */

test('P4E-CLIENT client-shaped receipt, logs, cover id, block number, from, to, data and value are refused and never read', async () => {
	const touched = [];
	const CLAIMS = ['receipt', 'logs', 'coverId', 'blockNumber', 'blockHash', 'from', 'to', 'data', 'value', 'status'];
	const a = world();
	a.receipt.status = '0x0'; // auf der Kette gescheitert; der Client behauptet Erfolg
	const input = { rpcA: reader(a), rpcB: reader(structuredClone(a)), intent: intent(), txHash: TX_HASH, calldataHash: STORED_CALLDATA_HASH, minConfirmations: 3 };
	for (const key of CLAIMS) Object.defineProperty(input, key, { enumerable: true, get() { touched.push(key); return key === 'receipt' ? { status: '0x1' } : 1; } });
	const r = await R.verifyPurchaseReceipt(input);
	assert.equal(r.status, 'INVALID_INPUT');
	assert.deepEqual(r.errors, CLAIMS.map((k) => `CLIENT_FIELD:${k}`));
	assert.deepEqual(touched, [], 'client claims are never read');
	// ohne die Behauptungen spricht allein die Kette
	assert.equal(await status((w) => { w.receipt.status = '0x0'; }), 'TX_FAILED');
	// der einzige kuenftige Client-Wert ist der txHash, streng geformt
	for (const txHash of [TX_HASH.toUpperCase().replace('0X', '0x'), TX_HASH.slice(0, 65), `${TX_HASH} `, 1, null]) await failsWith('INVALID_INPUT', ['TX_HASH'], undefined, { args: { txHash } });
	await failsWith('INVALID_INPUT', ['CALLDATA_HASH'], undefined, { args: { calldataHash: '0x1234' } });
	await failsWith('INVALID_INPUT', ['RPC_READERS'], undefined, { args: { rpcB: { send() {} } } });
	// ein unbekannter txHash ist "nicht gefunden", auch wenn der Client ein Cover nennt
	await failsWith('TX_NOT_FOUND', ['TX_NOT_FOUND'], undefined, { args: { txHash: keccak256('0x0d') } });
});

test('P4E-DETERMINISTIC repeated verification gives identical results without side effects', async () => {
	const w = world();
	const snapshot = structuredClone(w);
	const frozenIntent = Object.freeze(intent());
	const run = () => R.verifyPurchaseReceipt({ rpcA: reader(w), rpcB: reader(structuredClone(w)), intent: frozenIntent, txHash: TX_HASH, calldataHash: STORED_CALLDATA_HASH, minConfirmations: 3 });
	const first = await run();
	for (let i = 0; i < 3; i++) assert.deepEqual(await run(), first);
	assert.deepEqual(w, snapshot, 'the reader state is unchanged');
	const bad = () => verify((x) => { x.covers[COVER_ID].metadata = ''; });
	assert.deepEqual(await bad(), await bad());
});

/* ------------------------------------------------- Echter Negativ-Beleg -- */

const REAL = JSON.parse(read('test/fixtures/nexus/buycover-receipt-26219867.json'));
const REAL_TX = JSON.parse(read('test/fixtures/nexus/buycover-tx-26219867.json'));
const REAL_OWNER = '0x6a8b7244a935f80a35e14d70bb0ad0a569c510c1';
const REAL_COMMISSION_DESTINATION = '0x54c583fd610f7e962fdf2cbe7969b78f0ebe3231';
const topicWord = (t) => BigInt(t);
const topicAddress = (t) => `0x${t.slice(26)}`;

/** Spielt den Mitschnitt ab (beide Anbieter waren identisch); der Code am Block ist der gepinnte, dessen Hash mitgeschnitten wurde. */
function realReader() {
	const at = (tag) => { if (tag !== REAL.receipt.blockNumber) throw new Error('not captured'); };
	const codes = { [BROKER]: CODE.broker, [COVER]: CODE.proxy, [IMPL]: CODE.implementation };
	const calls = { [SEL.getCoverData]: 'getCoverData', [SEL.getCoverReference]: 'getCoverReference', [SEL.getCoverMetadata]: 'getCoverMetadata', [SEL.ownerOf]: 'ownerOf' };
	return {
		async request({ method, params }) {
			switch (method) {
				case 'eth_chainId': return REAL.chainId;
				case 'eth_getTransactionByHash': return params[0] === REAL.tx.hash ? structuredClone(REAL.tx) : null;
				case 'eth_getTransactionReceipt': return params[0] === REAL.tx.hash ? structuredClone(REAL.receipt) : null;
				case 'eth_getBlockByNumber': return params[0] === REAL.block.number ? structuredClone(REAL.block) : null;
				case 'eth_blockNumber': return q(REAL.latestBlockAtCapture[0]);
				case 'eth_getCode': at(params[1]); return codes[params[0].toLowerCase()];
				case 'eth_getStorageAt': at(params[2]); assert.equal(params[1], REAL.proxyImplementationSlot); return REAL.proxySlot;
				case 'eth_call': at(params[1]); assert.equal(BigInt(`0x${params[0].data.slice(10)}`), 5645n); return REAL.calls[calls[params[0].data.slice(0, 10)]];
				default: throw new Error(`not captured: ${method}`);
			}
		}
	};
}

test('P4E-REAL the real mainnet receipt (block 26219867) decodes structurally: tx/receipt relationship, CoverBought, NFT mint and Cover state', () => {
	assert.match(REAL.$comment, /NEGATIVE \/ STRUCTURAL/);
	assert.deepEqual(REAL.providers, ['eth.drpc.org', 'mainnet.gateway.tenderly.co']);
	// dieselbe Transaktion wie der signierte P4C-Mitschnitt (dort wird der Hash offline nachgerechnet)
	assert.equal(REAL.tx.hash, REAL_TX.hash);
	assert.equal(REAL.tx.input, REAL_TX.input);
	assert.equal(REAL.tx.to, REAL_TX.to);
	assert.equal(BigInt(REAL.tx.value), 0n);
	assert.equal(REAL.receipt.transactionHash, REAL.tx.hash);
	assert.equal(REAL.receipt.status, '0x1');
	assert.deepEqual([REAL.receipt.from, REAL.receipt.to], [REAL.tx.from, REAL.tx.to]);
	assert.deepEqual([REAL.receipt.blockHash, REAL.receipt.blockNumber], [REAL.tx.blockHash, REAL.tx.blockNumber]);
	assert.deepEqual([REAL.block.hash, Number(REAL.block.number)], [REAL.receipt.blockHash, 26219867]);
	assert.ok(REAL.receipt.logs.every((l) => l.blockHash === REAL.block.hash && l.transactionHash === REAL.tx.hash && !l.removed));
	// Pins am Ausfuehrungsblock, wie mitgeschnitten
	assert.deepEqual(REAL.code, { proxy: R.RECEIPT_PINS.coverProxyCodeHash, implementation: R.RECEIPT_PINS.coverImplementationCodeHash, broker: R.RECEIPT_PINS.brokerCodeHash, coverProductsProxy: R.RECEIPT_PINS.coverProxyCodeHash });
	assert.equal(REAL.proxyImplementationSlot, R.RECEIPT_PINS.coverImplementationSlot);
	assert.equal(topicAddress(REAL.proxySlot), IMPL);

	const cb = REAL.receipt.logs.filter((l) => l.topics[0] === TOPIC.CoverBought);
	assert.equal(cb.length, 1);
	assert.equal(cb[0].address, COVER);
	assert.deepEqual(cb[0].topics.slice(1).map(topicWord), [5645n, 5645n, 9301n], 'new cover: originalCoverId == coverId; buyer member is the Broker (9301)');
	assert.equal(BigInt(cb[0].data), 97n);
	const nft = REAL.receipt.logs.filter((l) => l.address === NFT);
	assert.equal(nft.length, 1);
	assert.deepEqual([nft[0].topics[0], topicAddress(nft[0].topics[1]), topicAddress(nft[0].topics[2]), topicWord(nft[0].topics[3])], [TOPIC.Transfer, ZERO, REAL_OWNER, 5645n]);
	// USDC (nur stuetzend): Zug maxPremium, Praemie in den Pool, Kommission an Dritte, Erstattung
	const flows = REAL.receipt.logs.filter((l) => l.address === USDC).map((l) => [topicAddress(l.topics[1]), topicAddress(l.topics[2]), BigInt(l.data)]);
	assert.deepEqual(flows, [[REAL_OWNER, BROKER, 1574435n], [BROKER, POOL, 1351601n], [BROKER, REAL_COMMISSION_DESTINATION, 150177n], [BROKER, REAL_OWNER, 72657n]]);
	assert.equal(1351601n + 150177n + 72657n, 1574435n);
	// Zustand am Belegblock
	const [[productId, coverAsset, amount, start, period]] = decodeAbiParameters(COVER_DATA, REAL.calls.getCoverData);
	assert.deepEqual([productId, coverAsset, amount, start, period], [97, 6, 401085049n, Number(REAL.block.timestamp), 2592000]);
	assert.ok(amount >= 400000000n, 'the stored amount is at least the requested amount (allocations round)');
	assert.deepEqual(decodeAbiParameters(REFERENCE, REAL.calls.getCoverReference)[0], [5645, 5645]);
	assert.equal(decodeAbiParameters([{ type: 'string' }], REAL.calls.getCoverMetadata)[0], '', 'empty ipfsData: no proof-of-loss stored');
	assert.equal(topicAddress(REAL.calls.ownerOf), REAL_OWNER);
});

test('P4E-REAL the real purchase is a NEGATIVE example: it is rejected for commission and proof-of-loss, never verified', async () => {
	const real = (patch, args = {}) => R.verifyPurchaseReceipt({ rpcA: realReader(), rpcB: realReader(), intent: intent(patch), txHash: REAL.tx.hash, calldataHash: keccak256(REAL.tx.input), minConfirmations: 64, requireFinalized: false, ...args });
	// bestmoeglich passender CoverRaccoon-Intent (mit Proof-of-Loss, wie CoverRaccoon ihn verlangt)
	const best = await real({ wallet: REAL_OWNER, amountRaw: '400000000', quotePremiumRaw: '1574435', maxPremiumRaw: '1574435' });
	assert.equal(best.ok, false);
	assert.equal(best.status, 'CALLDATA_POLICY_MISMATCH');
	assert.deepEqual(best.errors, ['COMMISSION_RATIO', 'COMMISSION_DESTINATION', 'PROOF_OF_LOSS_CID']);
	assert.equal(best.coverId, null);
	assert.deepEqual([best.blockNumber, best.blockHash], [26219867n, REAL.block.hash]);
	for (const c of ['input', 'chain', 'transaction', 'receipt', 'block', 'confirmations', 'sender', 'target', 'value', 'calldataHash']) assert.equal(best.checks[c], true, c);
	assert.equal(best.checks.calldataPolicy, false);
	// gegen einen fremden Intent: falscher Absender
	assert.equal((await real({})).status, 'WRONG_SENDER');
	// ein anderer gespeicherter calldata_hash
	assert.equal((await real({ wallet: REAL_OWNER }, { calldataHash: STORED_CALLDATA_HASH })).status, 'CALLDATA_HASH_MISMATCH');
	// Finalitaet wurde nicht mitgeschnitten (der Abspieler kennt keinen finalisierten Block): mit Finalitaetspflicht wird nicht bestaetigt
	assert.equal((await real({ wallet: REAL_OWNER, amountRaw: '400000000', quotePremiumRaw: '1574435', maxPremiumRaw: '1574435' }, { requireFinalized: true })).status, 'INSUFFICIENT_CONFIRMATIONS');
});

/* ------------------------------------------------------ Statische Wache -- */

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

test('P4E-STATIC the verifier has no send, sign, wallet, network, DB or environment surface and uses only read methods', () => {
	const full = read('src/purchase-receipt.mjs');
	const source = strip(full);
	assert.deepEqual([...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]).sort(), ['./nexus-pinned.mjs', './purchase-intent.mjs', './purchase-tx-decode.mjs', 'viem']);
	// auch in Kommentaren nicht
	assert.doesNotMatch(full, /eth_sendTransaction|eth_sendRawTransaction|wallet_sendCalls|wallet_sendTransaction|sendTransaction|sendRawTransaction|writeContract|createWalletClient|signTransaction|personal_sign|eth_sign\b|signTypedData|signMessage|walletconnect|safe-global|execTransaction/i);
	assert.doesNotMatch(source, /\.approve\(|\.buyCover\(|functionName:\s*'(approve|buyCover)'|encodeFunctionData|purchase-tx-builder|build(ExactUsdcApproval|NexusBuyCover)|productionReady/);
	assert.doesNotMatch(source, /\bimport\s*\(|require\s*\(|fetch\s*\(|XMLHttpRequest|WebSocket|https?:|createPublicClient|supabase|\.rpc\(|process\.|node:|Date\.now|new Date|Math\.random|globalThis|localStorage/);
	// der einzige Aufruf eines Lesers ist der eine, durch READ_METHODS gefilterte
	assert.equal(source.match(/\.request\(/g).length, 1);
	assert.match(source, /if \(!READ_METHODS\.includes\(method\)\) throw/);
	assert.deepEqual([...R.READ_METHODS].sort(), ['eth_blockNumber', 'eth_call', 'eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']);
	assert.ok(Object.isFrozen(R.READ_METHODS) && Object.isFrozen(R.RECEIPT_PINS));
	// der Pruefer kennt keinen Status ausser seinen eigenen und wird nie "produktionsbereit"
	assert.ok(R.RECEIPT_STATUSES.includes('VERIFIED_COVER_PURCHASE') && R.REQUIRED_CHECKS.length === 21);
});

test('P4E-IMPORT only test/purchase-receipt.test.mjs imports the verifier; the verifier never imports the builder', () => {
	const RECEIPT = 'src/purchase-receipt.mjs';
	const runtime = [...walk('src'), ...walk('api'), ...walk('web'), ...walk('scripts')].filter((f) => f !== RECEIPT && !f.startsWith('web/dist'));
	assert.ok(runtime.includes('src/bot.mjs') && runtime.some((f) => f.startsWith('api/')) && runtime.some((f) => f.startsWith('web/src/')) && runtime.some((f) => /^src\/agent-/.test(f)));
	for (const file of runtime) assert.doesNotMatch(read(file), /purchase-receipt(\.mjs)?['"`]|verifyPurchaseReceipt/, file);
	const importing = /(?:from\s*|import\s*\(\s*)['"`][^'"`]*purchase-receipt\.mjs/;
	assert.deepEqual([...walk('src'), ...walk('api'), ...walk('test'), ...walk('test-support')].filter((f) => importing.test(read(f))).sort(), ['test/purchase-receipt.test.mjs']);
	assert.doesNotMatch(read(RECEIPT), /purchase-tx-builder|build(ExactUsdcApproval|NexusBuyCover)/);
	assert.deepEqual(walk('api').filter((f) => /receipt|purchase|buy|intent/i.test(f)), [], 'no receipt or purchase route');
});
