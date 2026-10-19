/**
 * Nexus P4C (19.10.2026): unabhaengiger Decoder. Builder-Ausgaben muessen sich dekodieren und
 * gegen Intent + Quote bestaetigen lassen; jede Byte- oder Feldaenderung wird abgelehnt. Die echte
 * Mainnet-Transaktion aus Block 26219867 dekodiert strukturell und scheitert an der Politik.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionData, keccak256, parseAbi, serializeTransaction, maxUint256 } from 'viem';

const B = await import('../src/purchase-tx-builder.mjs');
const D = await import('../src/purchase-tx-decode.mjs');
const I = await import('../src/purchase-intent.mjs');

const WALLET = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const OTHER = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359';
const BROKER = '0xcb2b736652d2dbf7d72e4db880cf6b7d99507814';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const T0 = 1_792_400_000;
/** NUR TEST: CIDv0 der UTF-8-Bytes 'coverraccoon-p4c-test-fixture: not a Nexus proof-of-loss record'. Keine Proof-of-Loss-CID. */
const TEST_CID = 'QmQPWELjoGp6zqfrELz2xeafuPgtSBfvVF1pjX3DvuFsah';
const WORDING_CID = 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY';
const intent = (patch = {}) => ({
	id: '0b9e6f1c-3d2a-4f5b-8c7d-1e2f3a4b5c6d', wallet: WALLET, chainId: 1, deploymentKey: 'aave-v3-ethereum-core', productId: 97, productTypeId: 0, coverAssetId: 6,
	amountRaw: '1000000000', periodDays: 30, quotePremiumRaw: '3000578', maxPremiumRaw: '3030584', quoteFetchedAt: T0, capacityFetchedAt: T0, wordingCid: WORDING_CID,
	annexCid: null, termsHash: keccak256('0x01'), proofOfLossCid: TEST_CID, commissionRatio: 0, commissionDestination: I.ZERO_ADDRESS, pinVersion: I.PURCHASE_PIN_VERSION,
	acknowledgedAt: T0 + 10, expiresAt: T0 + 610, ...patch
});
const quote = (patch = {}) => ({ premiumRaw: '3000578', quoteTotalCoverAmountRaw: '1000192871', allocations: [{ poolId: '2', coverAmountInAsset: '1000192871' }], ...patch });
const built = () => B.buildNexusBuyCover({ intent: intent(), quote: quote() }).tx;
const builtApproval = () => B.buildExactUsdcApproval({ intent: intent() }).tx;
const check = (tx, i = intent(), q = quote()) => D.validateDecodedAgainstIntent(tx, i, q);

const SOL_ABI = parseAbi([
	'struct BuyCoverParams { uint256 coverId; address owner; uint24 productId; uint8 coverAsset; uint96 amount; uint32 period; uint256 maxPremiumInAsset; uint8 paymentAsset; uint16 commissionRatio; address commissionDestination; string ipfsData; }',
	'struct PoolAllocationRequest { uint256 poolId; uint256 coverAmountInAsset; }',
	'function buyCover(BuyCoverParams params, PoolAllocationRequest[] poolAllocationRequests) payable returns (uint256)',
	'function approve(address spender, uint256 amount) returns (bool)'
]);
/** Neue Daten, Builder-Metadaten beibehalten, calldataHash passend neu gesetzt: isoliert die Feldpruefung. */
const withData = (tx, data) => ({ ...tx, data, calldataHash: keccak256(data) });
function tamperBuy(change) {
	const tx = built();
	const [p, a] = decodeFunctionData({ abi: SOL_ABI, data: tx.data }).args;
	const [p2, a2] = change({ ...p }, a.map((x) => ({ ...x })));
	return withData(tx, encodeFunctionData({ abi: SOL_ABI, functionName: 'buyCover', args: [p2, a2] }));
}
const tamperApproval = (spender, amount) => withData(builtApproval(), encodeFunctionData({ abi: SOL_ABI, functionName: 'approve', args: [spender, amount] }));

/* ----------------------------------------------------------- Rundlauf -- */

test('P4C-DECODE builder output decodes independently and validates field by field', () => {
	const tx = built();
	assert.deepEqual(check(tx), { ok: true, errors: [], productionReady: false });
	const { call } = D.decodeNexusBuyCover(tx);
	assert.equal(call.params.owner, WALLET);
	assert.equal(call.params.period, 2592000);
	assert.equal(call.params.ipfsData, TEST_CID);
	assert.deepEqual(call.allocations, [{ poolId: 2n, coverAmountInAsset: 1000192871n }]);
	const a = builtApproval();
	assert.deepEqual(check(a), { ok: true, errors: [], productionReady: false });
	assert.deepEqual(D.decodeUsdcApproval(a).call, { spender: BROKER, amount: 3030584n });
	// bare transaction shape without builder metadata validates the same way
	assert.equal(check({ chainId: 1, to: BROKER, value: 0n, data: tx.data }).ok, true);
});

test('P4C-DECODE every single-bit change of the calldata is rejected', () => {
	for (const tx of [built(), builtApproval()]) {
		const bytes = (tx.data.length - 2) / 2;
		for (let i = 0; i < bytes; i++) {
			const at = 2 + i * 2;
			const flipped = (parseInt(tx.data.slice(at, at + 2), 16) ^ (1 << (i % 8))).toString(16).padStart(2, '0');
			const r = check(withData(tx, tx.data.slice(0, at) + flipped + tx.data.slice(at + 2)));
			assert.equal(r.ok, false, `${tx.kind} byte ${i}`);
		}
	}
});

test('P4C-DECODE changed buyCover fields are each rejected for their own reason', () => {
	const cases = [
		[(p, a) => [{ ...p, owner: OTHER }, a], 'OWNER'],
		[(p, a) => [{ ...p, amount: p.amount + 1n }, a], 'AMOUNT'],
		[(p, a) => [{ ...p, period: p.period + 86400 }, a], 'PERIOD'],
		[(p, a) => [{ ...p, maxPremiumInAsset: p.maxPremiumInAsset + 1n }, a], 'MAX_PREMIUM'],
		[(p, a) => [{ ...p, commissionRatio: 1000 }, a], 'COMMISSION_RATIO'],
		[(p, a) => [{ ...p, commissionDestination: OTHER }, a], 'COMMISSION_DESTINATION'],
		[(p, a) => [{ ...p, ipfsData: WORDING_CID }, a], 'PROOF_OF_LOSS_CID'],
		[(p, a) => [{ ...p, ipfsData: '' }, a], 'PROOF_OF_LOSS_CID'],
		[(p, a) => [{ ...p, coverId: 5645n }, a], 'COVER_ID'],
		[(p, a) => [{ ...p, productId: 98 }, a], 'PRODUCT'],
		[(p, a) => [{ ...p, coverAsset: 0 }, a], 'COVER_ASSET'],
		[(p, a) => [{ ...p, paymentAsset: 0 }, a], 'PAYMENT_ASSET'],
		[(p, a) => [p, [{ ...a[0], coverAmountInAsset: a[0].coverAmountInAsset - 1n }]], 'ALLOCATIONS'],
		[(p, a) => [p, [{ ...a[0], poolId: 3n }]], 'ALLOCATIONS'],
		[(p, a) => [p, [...a, { poolId: 9n, coverAmountInAsset: 1n }]], 'ALLOCATIONS']
	];
	for (const [change, code] of cases) assert.deepEqual(check(tamperBuy(change)).errors, [code], code);
});

test('P4C-DECODE changed target, value, selector, chain, metadata or encoding are rejected', () => {
	const tx = built();
	assert.ok(check({ ...tx, to: OTHER }).errors.includes('TARGET'));
	assert.ok(check({ ...tx, to: USDC }).errors.includes('TARGET'));
	assert.ok(check({ ...tx, value: 1n }).errors.includes('VALUE'));
	assert.ok(check({ ...tx, value: 0 }).errors.includes('VALUE'), 'value must be exactly 0n');
	assert.ok(check({ ...tx, chainId: 10 }).errors.includes('CHAIN'));
	assert.deepEqual(check(withData(tx, `0x7c59cac5${tx.data.slice(10)}`)).errors, ['SELECTOR']);
	assert.ok(check({ ...tx, gas: 500000n }).errors.includes('TX_FIELD:gas'));
	assert.ok(check({ ...tx, from: WALLET }).errors.includes('TX_FIELD:from'));
	assert.ok(check({ ...tx, productionReady: true }).errors.includes('PRODUCTION_READY_CLAIMED'));
	assert.ok(check({ ...tx, kind: 'USDC_APPROVAL' }).errors.includes('KIND'));
	assert.ok(check({ ...tx, calldataHash: keccak256('0x01') }).errors.includes('CALLDATA_HASH'));
	assert.ok(check(withData(tx, `${tx.data}00`)).errors.includes('NON_CANONICAL_ENCODING'), 'trailing bytes');
	assert.deepEqual(check(withData(tx, tx.data.toUpperCase().replace('0X', '0x'))).errors, ['SELECTOR'], 'only canonical lowercase hex');
	assert.ok(D.decodeNexusBuyCover(withData(tx, `0x7c59cac4${tx.data.slice(10).toUpperCase()}`)).errors.includes('DATA'));
	assert.ok(check({ ...tx, intentHash: keccak256('0x02') }).errors.includes('INTENT_HASH'));
	assert.ok(check({ ...tx, intentId: '0b9e6f1c-3d2a-4f5b-8c7d-1e2f3a4b5c6e' }).errors.includes('INTENT_ID'));
	assert.deepEqual(check(tx, intent({ maxPremiumRaw: '3030585' })).errors, ['MAX_PREMIUM', 'INTENT_HASH'], 'another intent does not match');
	assert.deepEqual(check(tx, intent(), quote({ allocations: [{ poolId: '2', coverAmountInAsset: '1000192871' }], quoteTotalCoverAmountRaw: '1000192872' })).errors, ['QUOTE_ALLOCATIONS']);
	assert.deepEqual(check(tx, intent(), quote({ premiumRaw: '3030585' })).errors, ['QUOTE_PREMIUM']);
	assert.deepEqual(check(tx, { ...intent(), to: OTHER }).errors, ['INTENT_INVALID']);
	assert.deepEqual(check({ ...tx, data: '0x12345678' }).errors, ['SELECTOR']);
});

test('P4C-DECODE an empty proof-of-loss is never accepted', () => {
	const tx = tamperBuy((p, a) => [{ ...p, ipfsData: '' }, a]);
	assert.deepEqual(check({ ...tx, intentHash: I.computePurchaseIntentHash(intent({ proofOfLossCid: null })) }, intent({ proofOfLossCid: null })).errors, ['PROOF_OF_LOSS_MISSING']);
});

test('P4C-DECODE-APPROVAL spender, amount, unlimited amount and target are checked exactly', () => {
	assert.deepEqual(check(tamperApproval(OTHER, 3030584n)).errors, ['SPENDER']);
	assert.deepEqual(check(tamperApproval(BROKER, 3030585n)).errors, ['APPROVAL_AMOUNT']);
	assert.deepEqual(check(tamperApproval(BROKER, 3030583n)).errors, ['APPROVAL_AMOUNT']);
	assert.deepEqual(check(tamperApproval(BROKER, maxUint256)).errors, ['APPROVAL_AMOUNT', 'APPROVAL_UNBOUNDED']);
	const a = builtApproval();
	assert.ok(check({ ...a, to: BROKER }).errors.includes('TARGET'));
	assert.ok(check({ ...a, value: 1n }).errors.includes('VALUE'));
	assert.ok(check({ ...a, kind: 'NEXUS_BUY_COVER' }).errors.includes('KIND'));
	assert.deepEqual(D.decodeUsdcApproval({ ...a, to: BROKER }).errors, ['TARGET']);
	assert.equal(D.decodeNexusBuyCover(a).ok, false, 'an approval is not a buyCover');
});

/* --------------------------------------------------------- Echte Transaktion -- */

const REAL = JSON.parse(readFileSync(new URL('./fixtures/nexus/buycover-tx-26219867.json', import.meta.url), 'utf8'));
const REAL_OWNER = '0x6a8b7244a935f80a35e14d70bb0ad0a569c510c1';

test('P4C-REAL the mainnet product-97 purchase (block 26219867) is genuine and decodes structurally', () => {
	const serialized = serializeTransaction({
		type: REAL.type, chainId: REAL.chainId, nonce: REAL.nonce, maxPriorityFeePerGas: BigInt(REAL.maxPriorityFeePerGas), maxFeePerGas: BigInt(REAL.maxFeePerGas),
		gas: BigInt(REAL.gas), to: REAL.to, value: BigInt(REAL.value), data: REAL.input, accessList: REAL.accessList
	}, { r: REAL.r, s: REAL.s, yParity: REAL.yParity });
	assert.equal(keccak256(serialized), REAL.hash, 'fixture bytes are exactly the signed mainnet transaction');
	assert.equal(REAL.hash, '0x1bec0316a5e23e34d1e81bd81aab8b38333d67e01b01382a112314823edae031');
	assert.equal(REAL.blockNumber, 26219867);
	const tx = { chainId: REAL.chainId, to: REAL.to, value: BigInt(REAL.value), data: REAL.input };
	const decoded = D.decodeNexusBuyCover(tx);
	assert.equal(decoded.ok, true, JSON.stringify(decoded.errors));
	const { params: p, allocations } = decoded.call;
	assert.deepEqual({ coverId: p.coverId, owner: p.owner, productId: p.productId, coverAsset: p.coverAsset, amount: p.amount, period: p.period, maxPremiumInAsset: p.maxPremiumInAsset, paymentAsset: p.paymentAsset, commissionRatio: p.commissionRatio, ipfsData: p.ipfsData }, {
		coverId: 0n, owner: REAL_OWNER, productId: 97, coverAsset: 6, amount: 400000000n, period: 2592000, maxPremiumInAsset: 1574435n, paymentAsset: 6, commissionRatio: 1000, ipfsData: ''
	});
	assert.notEqual(p.commissionDestination, I.ZERO_ADDRESS);
	assert.deepEqual(allocations, [{ poolId: 2n, coverAmountInAsset: 400466246n }], 'the real allocation overshoots the amount');
});

test('P4C-REAL CoverRaccoon policy rejects the real purchase for the intended reasons', () => {
	const tx = { chainId: REAL.chainId, to: REAL.to, value: BigInt(REAL.value), data: REAL.input };
	// gegen einen fremden CoverRaccoon-Intent: alles Gebundene weicht ab
	const foreign = check(tx);
	for (const code of ['OWNER', 'AMOUNT', 'MAX_PREMIUM', 'COMMISSION_RATIO', 'COMMISSION_DESTINATION', 'PROOF_OF_LOSS_CID', 'ALLOCATIONS']) assert.ok(foreign.errors.includes(code), code);
	// gegen den bestmoeglich passenden Intent bleiben genau Kommission und fehlender Proof-of-Loss
	const matching = intent({ wallet: REAL_OWNER, amountRaw: '400000000', quotePremiumRaw: '1574435', maxPremiumRaw: '1574435', proofOfLossCid: null });
	const matchingQuote = { premiumRaw: '1574435', quoteTotalCoverAmountRaw: '400466246', allocations: [{ poolId: '2', coverAmountInAsset: '400466246' }] };
	assert.deepEqual(check(tx, matching, matchingQuote), { ok: false, errors: ['COMMISSION_RATIO', 'COMMISSION_DESTINATION', 'PROOF_OF_LOSS_MISSING'], productionReady: false });
});
