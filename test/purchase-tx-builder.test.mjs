/**
 * Nexus P4C (19.10.2026): Offline-Transaktionsbuilder. Prueft die verifizierte Broker-ABI, die
 * exakte USDC-Freigabe, buyCover aus Intent + Quote, Ablehnung jeder Uebersteuerung, Reinheit
 * und Unerreichbarkeit. Nichts wird gesendet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionData, keccak256, parseAbi, toFunctionSelector, maxUint256, toFunctionSignature } from 'viem';

const B = await import('../src/purchase-tx-builder.mjs');
const D = await import('../src/purchase-tx-decode.mjs');
const I = await import('../src/purchase-intent.mjs');

const WALLET = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
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
/** Echter Quote (test/fixtures/nexus/quote-97-usdc-1000-30d.json): Gesamtdeckung ueber dem angefragten Betrag. */
const quote = (patch = {}) => ({ premiumRaw: '3000578', quoteTotalCoverAmountRaw: '1000192871', allocations: [{ poolId: '2', coverAmountInAsset: '1000192871' }], ...patch });
const buy = (i = {}, q = {}) => B.buildNexusBuyCover({ intent: intent(i), quote: quote(q) });
const approval = (i = {}) => B.buildExactUsdcApproval({ intent: intent(i) });

/** Test-eigene ABI aus dem Solidity-Text, unabhaengig von beiden Modulen. */
const SOL_ABI = parseAbi([
	'struct BuyCoverParams { uint256 coverId; address owner; uint24 productId; uint8 coverAsset; uint96 amount; uint32 period; uint256 maxPremiumInAsset; uint8 paymentAsset; uint16 commissionRatio; address commissionDestination; string ipfsData; }',
	'struct PoolAllocationRequest { uint256 poolId; uint256 coverAmountInAsset; }',
	'function buyCover(BuyCoverParams params, PoolAllocationRequest[] poolAllocationRequests) payable returns (uint256)',
	'function approve(address spender, uint256 amount) returns (bool)'
]);
const decodeBuy = (data) => decodeFunctionData({ abi: SOL_ABI, data }).args;
const builds = JSON.parse(readFileSync(new URL('./fixtures/nexus/contract-builds.json', import.meta.url), 'utf8')).builds;
const signature = (abi) => toFunctionSignature(abi.find((x) => x.name === 'buyCover'));

/* -------------------------------------------------------------------- ABI -- */

test('P4C-ABI the local Broker ABI is exactly the verified v2.12.1 buyCover and yields 0x7c59cac4', () => {
	const v2 = builds.find((b) => b.contract === 'CoverBroker' && b.tag === 'v2.12.1');
	assert.equal(v2.commit, '20082c81ec1a01e03cd7748c5bfc0396e74af93d');
	const canonical = 'buyCover((uint256,address,uint24,uint8,uint96,uint32,uint256,uint8,uint16,address,string),(uint256,uint256)[])';
	assert.equal(v2.methodIdentifiers[canonical], '7c59cac4');
	for (const abi of [B.BROKER_BUY_COVER_ABI, D.DECODER_BUY_COVER_ABI, SOL_ABI]) {
		assert.equal(signature(abi), canonical);
		assert.equal(toFunctionSelector(abi.find((x) => x.name === 'buyCover')), '0x7c59cac4');
	}
	assert.equal(B.BUY_COVER_SELECTOR, '0x7c59cac4');
	assert.deepEqual(B.BROKER_BUY_COVER_ABI[0].inputs[0].components.map((c) => c.name), ['coverId', 'owner', 'productId', 'coverAsset', 'amount', 'period', 'maxPremiumInAsset', 'paymentAsset', 'commissionRatio', 'commissionDestination', 'ipfsData']);
	// der deployte Broker-Runtime-Code (Fixture, Hash in nexus-pinned.mjs) verzweigt auf genau diesen Selector (PUSH4)
	assert.match(readFileSync(new URL('./fixtures/nexus/runtime-coverbroker-cb2b7366.hex', import.meta.url), 'utf8'), /637c59cac4/);
	assert.equal(toFunctionSelector(B.ERC20_APPROVE_ABI[0]), '0x095ea7b3');
	assert.equal(toFunctionSelector(D.DECODER_APPROVE_ABI[0]), '0x095ea7b3');
});

test('P4C-ABI wrong Broker ABI assumptions give another selector; no v3-only Broker method is used', () => {
	const wrong = [
		'function buyCover((uint256,address,uint24,uint8,uint256,uint32,uint256,uint8,uint16,address,string),(uint256,uint256)[])', // amount uint256
		'function buyCover((uint256,address,uint24,uint8,uint96,uint32,uint256,uint8,uint16,address,string),(uint256,uint256,bool)[])',
		'function buyCover((uint256,address,uint24,uint8,uint96,uint32,uint256,uint8,address,uint16,string),(uint256,uint256)[])', // Reihenfolge
		'function buyCover((uint256,address,uint24,uint8,uint96,uint32,uint256,uint8,uint16,address,string))',
		'function buyCoverWithRi((uint256,address,uint24,uint8,uint96,uint32,uint256,uint8,uint16,address,string),(uint256,uint256)[],(uint256,uint256,uint256,bytes,bytes,uint8,uint32))'
	];
	for (const w of wrong) assert.notEqual(toFunctionSelector(w), '0x7c59cac4', w);
	for (const abi of [B.BROKER_BUY_COVER_ABI, B.ERC20_APPROVE_ABI, D.DECODER_BUY_COVER_ABI, D.DECODER_APPROVE_ABI]) {
		assert.equal(abi.length, 1);
		assert.ok(['buyCover', 'approve'].includes(abi[0].name));
	}
	for (const file of ['src/purchase-tx-builder.mjs', 'src/purchase-tx-decode.mjs']) {
		assert.doesNotMatch(code(file), /\b(registry|pool|tokenController|master|memberRoles)\s*\(|buyCoverWithRi|@nexusmutual|NEXUS_CONTRACTS\b/, file);
	}
});

/* -------------------------------------------------------------- Freigabe -- */

test('P4C-APPROVAL exact USDC.approve(Broker, maxPremiumRaw), value 0, no gas or nonce', () => {
	const r = approval();
	assert.equal(r.ok, true, JSON.stringify(r.errors));
	const { tx } = r;
	assert.deepEqual(Object.keys(tx).sort(), ['blockers', 'calldataHash', 'chainId', 'data', 'intentHash', 'intentId', 'kind', 'productionReady', 'to', 'value']);
	assert.equal(tx.kind, 'USDC_APPROVAL');
	assert.equal(tx.chainId, 1);
	assert.equal(tx.to, USDC);
	assert.equal(B.USDC_ADDRESS, USDC);
	assert.equal(tx.value, 0n);
	assert.equal(tx.data.slice(0, 10), '0x095ea7b3');
	const { functionName, args } = decodeFunctionData({ abi: SOL_ABI, data: tx.data });
	assert.equal(functionName, 'approve');
	assert.equal(args[0].toLowerCase(), BROKER);
	assert.equal(args[1], 3030584n);
	assert.equal(tx.data, encodeFunctionData({ abi: SOL_ABI, functionName: 'approve', args: [BROKER, 3030584n] }));
	assert.equal(tx.calldataHash, keccak256(tx.data));
	assert.equal(tx.intentHash, I.computePurchaseIntentHash(intent()));
	assert.equal(tx.productionReady, false);
	// P4G (20.10.2026): der Builder bleibt offline und kennt nur die USDC-Adresse; Pin und Pre-Send-Pruefung leistet P4F extern.
	assert.equal(B.USDC_PIN_STATUS, 'BUILDER_ADDRESS_ONLY_PIN_EXTERNAL_P4F');
	assert.equal(B.BUILDER_CAPABILITY, 'OFFLINE_ONLY');
	assert.deepEqual({ ...B.EXTERNAL_REQUIRED_CONTROLS }, { USDC_PIN: 'SATISFIED_BY_P4F', PRE_SEND_CHAIN_VALIDATION: 'SATISFIED_BY_P4F', RECEIPT_BEFORE_CONFIRMATION: 'SATISFIED_BY_P4G', WALLET_ORCHESTRATION: 'UNRESOLVED', TERMS: 'UNRESOLVED', PROOF_OF_LOSS: 'UNRESOLVED' });
	assert.ok(tx.blockers.includes('WALLET_ORCHESTRATION_UNRESOLVED'));
	assert.deepEqual(approval(), r, 'deterministic');
	assert.ok(Object.isFrozen(tx));
});

test('P4C-APPROVAL wrong asset, zero or unbounded amount and every override are rejected', () => {
	assert.equal(approval({ coverAssetId: 0 }).ok, false);
	assert.ok(approval({ coverAssetId: 0 }).errors.includes('INTENT:COVER_ASSET'));
	assert.ok(approval({ maxPremiumRaw: '0' }).errors.includes('INTENT:MAX_PREMIUM'));
	const unlimited = approval({ maxPremiumRaw: maxUint256.toString() });
	assert.deepEqual(unlimited.errors, ['MAX_PREMIUM_ABOVE_COVER_AMOUNT'], 'MaxUint can never become an approval');
	assert.deepEqual(approval({ maxPremiumRaw: '1000000001' }).errors, ['MAX_PREMIUM_ABOVE_COVER_AMOUNT']);
	assert.equal(approval({ maxPremiumRaw: '1000000000' }).ok, true);
	for (const field of ['to', 'spender', 'amount', 'data', 'value', 'abi', 'selector', 'functionName', 'contract', 'broker', 'chainId', 'gas', 'nonce']) {
		assert.deepEqual(B.buildExactUsdcApproval({ intent: intent(), [field]: field === 'value' ? 0n : BROKER }).errors, [`UNKNOWN_INPUT:${field}`], field);
	}
	assert.ok(B.buildExactUsdcApproval({ intent: { ...intent(), spender: WALLET } }).errors.includes('INTENT:UNKNOWN_FIELD:spender'));
	assert.deepEqual(B.buildExactUsdcApproval(intent()).errors.slice(0, 1), ['UNKNOWN_INPUT:id'], 'the intent is never the top-level input');
});

/* -------------------------------------------------------------- buyCover -- */

test('P4C-BUY every buyCover field derives from the intent and the quote; exact Broker, selector, value 0', () => {
	const r = buy();
	assert.equal(r.ok, true, JSON.stringify(r.errors));
	const { tx } = r;
	assert.deepEqual(Object.keys(tx).sort(), ['blockers', 'calldataHash', 'chainId', 'data', 'intentHash', 'intentId', 'kind', 'productionReady', 'to', 'value']);
	assert.equal(tx.kind, 'NEXUS_BUY_COVER');
	assert.equal(tx.to, BROKER);
	assert.equal(B.BROKER_ADDRESS, BROKER);
	assert.equal(tx.chainId, 1);
	assert.equal(tx.value, 0n);
	assert.equal(tx.data.slice(0, 10), '0x7c59cac4');
	const [p, allocations] = decodeBuy(tx.data);
	assert.deepEqual({ ...p, owner: p.owner.toLowerCase() }, {
		coverId: 0n, owner: WALLET, productId: 97, coverAsset: 6, amount: 1000000000n, period: 30 * 86400, maxPremiumInAsset: 3030584n,
		paymentAsset: 6, commissionRatio: 0, commissionDestination: I.ZERO_ADDRESS, ipfsData: TEST_CID
	});
	assert.deepEqual(allocations, [{ poolId: 2n, coverAmountInAsset: 1000192871n }]);
	assert.equal(tx.intentId, intent().id);
	assert.equal(tx.intentHash, I.computePurchaseIntentHash(intent()));
	assert.equal(tx.productionReady, false);
	assert.deepEqual([...tx.blockers], ['PROOF_OF_LOSS_UNRESOLVED', 'NEXUS_TEXTS_UNCONFIRMED', 'WALLET_ORCHESTRATION_UNRESOLVED']);
});

test('P4C-BUY-HASH calldataHash is deterministic and changes with every bound field', () => {
	const { tx } = buy();
	assert.equal(tx.calldataHash, keccak256(tx.data));
	assert.deepEqual(buy(), buy());
	const variants = {
		owner: buy({ wallet: '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359' }), amount: buy({ amountRaw: '999000000' }, { allocations: [{ poolId: '2', coverAmountInAsset: '1000192871' }] }),
		period: buy({ periodDays: 31 }), maxPremium: buy({ maxPremiumRaw: '3030585' }), pol: buy({ proofOfLossCid: WORDING_CID }),
		allocations: buy({}, { quoteTotalCoverAmountRaw: '1000192871', allocations: [{ poolId: '2', coverAmountInAsset: '1000000000' }, { poolId: '7', coverAmountInAsset: '192871' }] })
	};
	for (const [field, r] of Object.entries(variants)) {
		assert.equal(r.ok, true, `${field}: ${r.errors}`);
		assert.notEqual(r.tx.calldataHash, tx.calldataHash, field);
	}
	// policy-feste Felder (Produkt, Asset, Zahlungsasset, Kommission) sind nicht eingebbar; ihre Bindung zeigt die Kodierung
	const [p, a] = decodeBuy(tx.data);
	for (const [field, value] of Object.entries({ productId: 98, coverAsset: 7, paymentAsset: 0, commissionRatio: 1000, commissionDestination: WALLET, coverId: 1n })) {
		assert.notEqual(keccak256(encodeFunctionData({ abi: SOL_ABI, functionName: 'buyCover', args: [{ ...p, [field]: value }, a] })), tx.calldataHash, field);
	}
});

test('P4C-BUY-ALLOC the real quote overshoot is accepted; underflow, mismatch and malformed allocations are rejected', () => {
	assert.equal(buy().ok, true, 'sum 1000192871 > requested 1000000000 is the real captured quote');
	assert.ok(buy({}, { quoteTotalCoverAmountRaw: '999999999', allocations: [{ poolId: '2', coverAmountInAsset: '999999999' }] }).errors.includes('ALLOCATION:ALLOCATED_BELOW_REQUESTED'));
	assert.ok(buy({}, { quoteTotalCoverAmountRaw: '1000192872' }).errors.includes('ALLOCATION:ALLOCATED_NOT_QUOTE_TOTAL'));
	assert.ok(buy({}, { allocations: [] }).errors.includes('ALLOCATION:NO_ALLOCATIONS'));
	assert.ok(buy({}, { allocations: [{ poolId: '2', coverAmountInAsset: '1000192871', extra: '1' }] }).errors.includes('ALLOCATION:ALLOCATION_SHAPE:0'));
	assert.ok(buy({}, { quoteTotalCoverAmountRaw: '1020000000', allocations: [{ poolId: '2', coverAmountInAsset: '1020000000' }] }).errors.includes('ALLOCATION:OVERSHOOT_TOO_LARGE'));
});

test('P4C-BUY-PREMIUM a quote premium above maxPremium is rejected; maxPremium is never raised', () => {
	assert.deepEqual(buy({}, { premiumRaw: '3030585' }).errors, ['QUOTE_PREMIUM_ABOVE_MAX']);
	assert.equal(buy({}, { premiumRaw: '3030584' }).ok, true);
	assert.deepEqual(buy({}, { premiumRaw: '0' }).errors, ['QUOTE_PREMIUM']);
	assert.equal(decodeBuy(buy({}, { premiumRaw: '1' }).tx.data)[0].maxPremiumInAsset, 3030584n, 'the encoded maximum is the intent maximum, not the quote');
});

test('P4C-BUY-ASSET only USDC; any other cover asset is rejected', () => {
	for (const coverAssetId of [0, 7, 255]) assert.equal(buy({ coverAssetId }).ok, false, String(coverAssetId));
	assert.deepEqual(B.TX_KINDS, ['USDC_APPROVAL', 'NEXUS_BUY_COVER']);
});

test('P4C-BUY-POL without an externally supplied proof-of-loss CID nothing is built; output is never production-ready', () => {
	assert.deepEqual(buy({ proofOfLossCid: null }).errors, ['PROOF_OF_LOSS_CID_MISSING'], 'no empty ipfsData');
	assert.equal(decodeBuy(buy().tx.data)[0].ipfsData, TEST_CID);
	assert.equal(decodeBuy(buy({ proofOfLossCid: WORDING_CID }).tx.data)[0].ipfsData, WORDING_CID);
	for (const r of [buy(), approval()]) {
		assert.equal(r.tx.productionReady, false);
		assert.ok(r.tx.blockers.includes('PROOF_OF_LOSS_UNRESOLVED'));
	}
	assert.equal(I.evaluateIntentReadiness(intent(), { now: T0 + 20, purpose: 'TRANSACTION' }).status, 'BLOCKED_PROOF_OF_LOSS');
});

test('P4C-BUY-OVERRIDE no top-level or quote field can override an authoritative parameter', () => {
	const fields = ['to', 'data', 'value', 'abi', 'selector', 'functionName', 'spender', 'contract', 'broker', 'commissionRatio', 'commissionDestination', 'productId', 'owner', 'paymentAsset', 'coverAsset', 'ipfsData', 'gas', 'nonce', 'calldata'];
	for (const field of fields) {
		assert.deepEqual(B.buildNexusBuyCover({ intent: intent(), quote: quote(), [field]: 1 }).errors, [`UNKNOWN_INPUT:${field}`], field);
		assert.ok(buy({}, { [field]: 1 }).errors.includes(`QUOTE:UNKNOWN_INPUT:${field}`), `quote.${field}`);
	}
	assert.ok(buy({ commissionRatio: 1000 }).errors.includes('INTENT:COMMISSION_RATIO'));
	assert.ok(buy({ commissionDestination: WALLET }).errors.includes('INTENT:COMMISSION_DESTINATION'));
	assert.ok(buy({ productId: 98 }).errors.includes('INTENT:PRODUCT'));
	assert.deepEqual(B.buildNexusBuyCover({ intent: intent() }).errors, ['MISSING_INPUT:quote']);
});

test('P4C-EXPORTS exactly two transaction kinds; no generic builder', () => {
	assert.deepEqual(Object.keys(B).sort(), ['APPROVE_SELECTOR', 'BROKER_ADDRESS', 'BROKER_BUY_COVER_ABI', 'BUILDER_CAPABILITY', 'BUY_COVER_SELECTOR', 'ERC20_APPROVE_ABI', 'EXTERNAL_REQUIRED_CONTROLS', 'PRODUCTION_BLOCKERS', 'TX_KINDS', 'USDC_ADDRESS', 'USDC_PIN_STATUS', 'buildExactUsdcApproval', 'buildNexusBuyCover']);
	assert.deepEqual(Object.keys(D).sort(), ['DECODER_APPROVE_ABI', 'DECODER_BUY_COVER_ABI', 'decodeNexusBuyCover', 'decodeUsdcApproval', 'validateDecodedAgainstIntent']);
	const source = code('src/purchase-tx-builder.mjs');
	assert.deepEqual([...source.matchAll(/encodeFunctionData\(\{\s*abi:\s*(\w+),\s*functionName:\s*('\w+')/g)].map((m) => `${m[1]}.${m[2]}`), ["ERC20_APPROVE_ABI.'approve'", "BROKER_BUY_COVER_ABI.'buyCover'"]);
	assert.equal(source.match(/encodeFunctionData/g).length, 3, 'one import, two fixed calls');
});

/* ------------------------------------------------------- Reinheit, Reichweite -- */

function code(file) {
	return readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
}
const P4C = ['src/purchase-tx-builder.mjs', 'src/purchase-tx-decode.mjs'];

test('P4C-PURE no wallet, network, DB, clock, environment or unlimited-approval code in the P4C modules', () => {
	const allowed = { 'src/purchase-tx-builder.mjs': ['./nexus-pinned.mjs', './purchase-intent.mjs', 'viem'], 'src/purchase-tx-decode.mjs': ['./nexus-pinned.mjs', './purchase-intent.mjs', 'viem'] };
	for (const file of P4C) {
		const source = code(file);
		assert.deepEqual([...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]).sort(), allowed[file], file);
		assert.doesNotMatch(source, /\bimport\s*\(|require\s*\(|fetch\s*\(|XMLHttpRequest|WebSocket|http|createPublicClient|createWalletClient|supabase|\bdb\b|process\.|node:|Date\.now|new Date|Math\.random|globalThis|localStorage/i, file);
		assert.doesNotMatch(source, /eth_sendTransaction|wallet_sendCalls|wallet_sendTransaction|sendTransaction|sendRawTransaction|writeContract|personal_sign|eth_sign|signTypedData|signMessage|signTransaction|\.request\s*\(|walletconnect|safe/i, file);
		assert.doesNotMatch(source, /maxUint|MaxUint|2n\s*\*\*\s*256n|1n\s*<<\s*256n|0x[fF]{64}|increaseAllowance|decreaseAllowance|permit|setApprovalForAll|CoverNFT/, file);
	}
	assert.doesNotMatch(code('src/purchase-tx-decode.mjs'), /purchase-tx-builder|build(ExactUsdcApproval|NexusBuyCover)/, 'the decoder does not use the builder');
});

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

test('P4C-IMPORT no runtime code imports the builder or decoder; only P4C tests do', () => {
	// P4E (19.10.2026): der unerreichbare Beleg-Pruefer (P4E-IMPORT) nutzt den unabhaengigen DECODER, nie den Builder.
	const RECEIPT = 'src/purchase-receipt.mjs';
	const runtime = [...walk('src'), ...walk('api'), ...walk('web'), ...walk('scripts')].filter((f) => !P4C.includes(f) && f !== RECEIPT);
	assert.ok(runtime.includes('src/bot.mjs') && runtime.some((f) => f.startsWith('api/')) && runtime.some((f) => f.startsWith('web/src/')) && runtime.some((f) => /^src\/agent-/.test(f)));
	for (const file of runtime) assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /purchase-tx-(builder|decode)(\.mjs)?['"`]/, file);
	assert.doesNotMatch(readFileSync(new URL(`../${RECEIPT}`, import.meta.url), 'utf8'), /purchase-tx-builder|build(ExactUsdcApproval|NexusBuyCover)/, RECEIPT);
	const importing = /(?:from\s*|import\s*\(\s*)['"`][^'"`]*purchase-tx-(builder|decode)\.mjs/;
	const importers = [...walk('src'), ...walk('test')].filter((f) => importing.test(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'))).sort();
	// P4G (20.10.2026): der P4G-Test liest die Blocker-Aussage des Builders (P4G-P4C-MODEL); das P4G-Modul selbst importiert ihn nie (P4G-STATIC).
	assert.deepEqual(importers, [RECEIPT, 'test/purchase-confirmation.test.mjs', 'test/purchase-tx-builder.test.mjs', 'test/purchase-tx-decode.test.mjs']);
});

test('P4C-SURFACE transaction encoding and transaction-shaped objects exist only in the two pure P4C modules', () => {
	const runtime = [...walk('src'), ...walk('api'), ...walk('web/src'), 'web/index.html', ...walk('scripts')].filter((f) => !P4C.includes(f));
	for (const file of runtime) {
		// P4D (19.10.2026): der unerreichbare DB-Helfer (P4D-IMPORT) nimmt den Calldata-Hash entgegen, um ihn zu speichern; alles andere gilt auch dort.
		// P4E (19.10.2026): ebenso der unerreichbare, nur lesende Beleg-Pruefer (P4E-IMPORT), der keccak256(input) gegen ihn vergleicht.
		// P4F (20.10.2026): ebenso der unerreichbare, nur lesende Pre-Send-Pruefer (P4F-IMPORT), der nur das Format des gespeicherten Hashes prueft.
		// P4G (20.10.2026): ebenso die unerreichbare Bestaetigungs-Orchestrierung (P4G-IMPORT), die den gespeicherten Hash an P4E weiterreicht.
		const surface = ['src/purchase-intent-db.mjs', 'src/purchase-receipt.mjs', 'src/purchase-pre-send.mjs', 'src/purchase-confirmation.mjs'].includes(file) ? /encodeFunctionData|buyCover|7c59cac4|095ea7b3|NEXUS_BUY_COVER|USDC_APPROVAL|functionName:\s*'approve'|\.approve\(|productionReady/ : /encodeFunctionData|buyCover|7c59cac4|095ea7b3|NEXUS_BUY_COVER|USDC_APPROVAL|functionName:\s*'approve'|\.approve\(|calldataHash|productionReady/;
		assert.doesNotMatch(code(file), surface, file);
	}
});
