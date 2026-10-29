/**
 * Nexus P4A (19.10.2026): reines Kauf-Intent-Modell. Kein Kauf, keine Wallet, kein Netz, keine DB.
 * Prueft Validierung, kanonischen Hash, Zustandsuebergaenge, Allokationsregeln nach Cover v3.3.0,
 * Kommissionspolitik und dass das Modul rein und von keinem Laufzeitpfad erreichbar ist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { keccak256, getAddress } from 'viem';

const P = await import('../src/purchase-intent.mjs');
const { NEXUS_CONTRACT_SOURCES, PINNED_PRODUCTS, PURCHASE_ANNEX_CID } = await import('../src/nexus-pinned.mjs');

const WALLET = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'; // EIP-55-Beispieladresse
const T0 = 1_792_400_000;
/** Ein gueltiger Intent; Quote-Werte aus dem mitgeschnittenen 1000-USDC-Quote (scratch q-usdc.json, 18.10.2026). */
const base = () => ({
	id: '0b9e6f1c-3d2a-4f5b-8c7d-1e2f3a4b5c6d', wallet: WALLET, chainId: 1, deploymentKey: 'aave-v3-ethereum-core', productId: 97, productTypeId: 0,
	coverAssetId: 6, amountRaw: '1000000000', periodDays: 30, quotePremiumRaw: '3000578', maxPremiumRaw: '3030584',
	quoteFetchedAt: T0, capacityFetchedAt: T0, wordingCid: 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY', annexCid: null,
	termsHash: keccak256('0x01'), proofOfLossCid: null, commissionRatio: 0, commissionDestination: '0x0000000000000000000000000000000000000000',
	pinVersion: P.PURCHASE_PIN_VERSION, acknowledgedAt: T0 + 10, expiresAt: T0 + 10 + 600
});
const valid = (patch = {}) => P.validatePurchaseIntent({ ...base(), ...patch });
const show = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
const errorsOf = (patch) => { const r = valid(patch); assert.equal(r.ok, false, show(patch)); return r.errors; };
/** Hash eines kanonischen Intents ohne Politikpruefung - nur um zu zeigen, dass ein Feld gebunden ist. */
const rawHash = (patch = {}, pins = P.PURCHASE_PINS) => keccak256(P.encodeCanonicalIntent({ ...valid().intent, ...patch }, pins));

/* ------------------------------------------------------------ Validierung -- */

test('P4A-VALID a canonical intent validates and hashes stably', () => {
	const r = valid();
	assert.equal(r.ok, true, JSON.stringify(r.errors));
	assert.equal(r.intent.amountRaw, 1000000000n);
	assert.equal(typeof r.intent.maxPremiumRaw, 'bigint');
	const h = P.computePurchaseIntentHash(base());
	assert.match(h, /^0x[0-9a-f]{64}$/);
	assert.equal(P.computePurchaseIntentHash(base()), h);
	// Reihenfolge der Eingabeschluessel spielt keine Rolle, die Kodierung hat eine feste Reihenfolge
	const reversed = Object.fromEntries(Object.entries(base()).reverse());
	assert.equal(P.computePurchaseIntentHash(reversed), h);
	assert.deepEqual(P.PURCHASE_INTENT_HASH_FIELDS.slice(0, 23), ['domain', 'version', 'id', 'wallet', 'chainId', 'broker', 'brokerCodeHash', 'coverProxy', 'coverImplementation', 'coverImplementationCodeHash',
		'productId', 'productTypeId', 'coverAssetId', 'amountRaw', 'periodSeconds', 'maxPremiumRaw', 'termsHash', 'proofOfLossCid', 'commissionRatio', 'commissionDestination', 'owner', 'expiresAt', 'pinVersion']);
	assert.equal(P.PURCHASE_INTENT_DOMAIN, 'coverraccoon.purchase-intent');
	assert.equal(P.PURCHASE_INTENT_HASH_VERSION, 1);
});

test('P4A-VALID wallet normalisation yields one hash; a wrong checksum is rejected', () => {
	const h = P.computePurchaseIntentHash(base());
	assert.equal(P.computePurchaseIntentHash({ ...base(), wallet: getAddress(WALLET) }), h);
	assert.equal(P.computePurchaseIntentHash({ ...base(), wallet: `0x${WALLET.slice(2).toUpperCase()}` }), h);
	const bad = getAddress(WALLET).replace(/[a-f]/, (c) => c.toUpperCase());
	assert.notEqual(bad, getAddress(WALLET));
	assert.ok(errorsOf({ wallet: bad }).includes('WALLET'));
	for (const w of ['0x1234', WALLET.slice(2), `${WALLET} `, 42, null]) assert.ok(errorsOf({ wallet: w }).includes('WALLET'), String(w));
});

test('P4A-INVALID policy violations never validate and never hash', () => {
	const cases = [
		[{ chainId: 10 }, 'CHAIN'], [{ chainId: '1' }, 'CHAIN'], [{ productId: 98 }, 'PRODUCT'], [{ productTypeId: 1 }, 'PRODUCT_TYPE'],
		[{ deploymentKey: 'aave-v3-ethereum-lido' }, 'DEPLOYMENT'], [{ deploymentKey: 'compound' }, 'DEPLOYMENT'],
		[{ coverAssetId: 0 }, 'COVER_ASSET'], [{ coverAssetId: 7 }, 'COVER_ASSET'],
		[{ amountRaw: '0' }, 'AMOUNT'], [{ amountRaw: (1n << 96n).toString() }, 'AMOUNT'],
		[{ periodDays: 27 }, 'PERIOD'], [{ periodDays: 366 }, 'PERIOD'], [{ periodDays: 30.5 }, 'PERIOD'],
		[{ quotePremiumRaw: '0' }, 'QUOTE_PREMIUM'], [{ maxPremiumRaw: '3000577' }, 'MAX_PREMIUM_BELOW_QUOTE'],
		[{ commissionRatio: 1000 }, 'COMMISSION_RATIO'], [{ commissionRatio: '0' }, 'COMMISSION_RATIO'],
		[{ commissionDestination: '0x8e53d04644e9ab0412a8c6bd228c84da7664cfe3' }, 'COMMISSION_DESTINATION'],
		[{ wordingCid: 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8E0' }, 'WORDING_CID'], [{ wordingCid: 'QmYhCNjfrNTMq8eyg8i7LbBpTkMCHfix9Sv1jrPb7dYZKd' }, 'WORDING_CID'],
		[{ annexCid: 'not-a-cid' }, 'ANNEX_CID'], [{ annexCid: 'QmYhCNjfrNTMq8eyg8i7LbBpTkMCHfix9Sv1jrPb7dYZKd' }, 'ANNEX_CID_NOT_PINNED'],
		[{ proofOfLossCid: 'Qm123' }, 'PROOF_OF_LOSS_CID'], [{ proofOfLossCid: '' }, 'PROOF_OF_LOSS_CID'],
		[{ termsHash: '0x1234' }, 'TERMS_HASH'], [{ termsHash: true }, 'TERMS_HASH'],
		[{ pinVersion: '' }, 'PIN_VERSION'], [{ pinVersion: 'nexus-pin-0:broker-v3.4.0:cover-v3.4.0' }, 'PIN_VERSION'],
		[{ id: 'not-a-uuid' }, 'ID'],
		[{ expiresAt: T0 + 10 }, 'EXPIRES_NOT_AFTER_ACKNOWLEDGEMENT'], [{ expiresAt: T0 + 10 + 901 }, 'LIFETIME_TOO_LONG'],
		[{ quoteFetchedAt: T0 - 100 }, 'QUOTE_STALE_AT_ACKNOWLEDGEMENT'], [{ capacityFetchedAt: T0 + 11 }, 'CAPACITY_STALE_AT_ACKNOWLEDGEMENT'],
		[{ acknowledgedAt: 1.5 }, 'TIME:acknowledgedAt']
	];
	for (const [patch, code] of cases) {
		assert.ok(errorsOf(patch).includes(code), `${show(patch)} -> ${code}: ${errorsOf(patch)}`);
		assert.throws(() => P.computePurchaseIntentHash({ ...base(), ...patch }), /INVALID_PURCHASE_INTENT/);
	}
});

test('P4A-ANNEX the purchase path keeps its own annex pin and rejects the read-path annex of product 97', () => {
	// Lese-Pin (Annex vom 27.10.2026) und Kauf-Pin (ohne Annex, cover_purchase_intents.annex_cid ist null) sind getrennt.
	assert.equal(PURCHASE_ANNEX_CID, null);
	assert.equal(PINNED_PRODUCTS[97].annexCid, 'QmWAdgxbaPGj6umcoZJk5xwc8K5rxZRSFx5DSyMxNfSkuJ');
	const r = valid({ annexCid: PINNED_PRODUCTS[97].annexCid });
	assert.ok(r.ok === false && r.errors.includes('ANNEX_CID_NOT_PINNED'), `read-path annex -> ANNEX_CID_NOT_PINNED: ${r.errors}`);
	assert.throws(() => P.computePurchaseIntentHash({ ...base(), annexCid: PINNED_PRODUCTS[97].annexCid }), /INVALID_PURCHASE_INTENT/);
});

test('P4A-INVALID raw amounts are canonical integer strings only, parsed without precision loss', () => {
	for (const bad of ['1e9', '1000000000.0', '+1000000000', '-1', ' 1000000000', '1000000000\n', '01000000000', '0x3b9aca00', 'NaN', 'Infinity', '', 1000000000, 1000000000n]) {
		assert.ok(errorsOf({ amountRaw: bad }).includes('AMOUNT'), JSON.stringify(String(bad)));
	}
	const max = ((1n << 96n) - 1n).toString();
	const r = valid({ amountRaw: max, quotePremiumRaw: '9007199254740993', maxPremiumRaw: '9007199254740993' });
	assert.equal(r.ok, true, JSON.stringify(r.errors));
	assert.equal(r.intent.amountRaw, (1n << 96n) - 1n);
	assert.equal(r.intent.quotePremiumRaw, 9007199254740993n);
	assert.equal(P.parseRawUint('9007199254740993'), 9007199254740993n);
	assert.equal(P.parseRawUint('0'), 0n);
	assert.equal(P.parseRawUint('0', { positive: true }), null);
});

test('P4A-INVALID extra, derived and caller-supplied hash fields are rejected', () => {
	for (const extra of ['intentHash', 'periodSeconds', 'owner', 'txHash', 'coverId', 'calldata', 'signature', 'ip', 'userAgent', 'quote', 'proofOfLoss', 'accepted']) {
		assert.ok(errorsOf({ [extra]: 'x' }).includes(`UNKNOWN_FIELD:${extra}`), extra);
	}
	const missing = base(); delete missing.termsHash;
	assert.deepEqual(P.validatePurchaseIntent(missing).errors, ['MISSING_FIELD:termsHash']);
	for (const bad of [null, [], 'x', 1]) assert.equal(P.validatePurchaseIntent(bad).ok, false);
});

/* ------------------------------------------------------------------- Hash -- */

test('P4A-HASH every security-critical field and every pin is bound into the intent hash', () => {
	const h = rawHash();
	assert.equal(h, P.computePurchaseIntentHash(base()), 'the public hash is the raw hash of the canonical intent with the current pins');
	const fieldChanges = {
		id: '0b9e6f1c-3d2a-4f5b-8c7d-1e2f3a4b5c6e', wallet: '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaee', chainId: 10, deploymentKey: 'aave-v3-ethereum-lido',
		productId: 98, productTypeId: 1, coverAssetId: 0, amountRaw: 1000000001n, periodDays: 31, quotePremiumRaw: 3000579n, maxPremiumRaw: 3030585n,
		quoteFetchedAt: T0 + 1, capacityFetchedAt: T0 + 1, acknowledgedAt: T0 + 11, expiresAt: T0 + 611,
		wordingCid: 'QmYhCNjfrNTMq8eyg8i7LbBpTkMCHfix9Sv1jrPb7dYZKd', annexCid: 'QmYhCNjfrNTMq8eyg8i7LbBpTkMCHfix9Sv1jrPb7dYZKd',
		termsHash: keccak256('0x02'), proofOfLossCid: 'QmYhCNjfrNTMq8eyg8i7LbBpTkMCHfix9Sv1jrPb7dYZKd', commissionRatio: 1000,
		commissionDestination: '0x8e53d04644e9ab0412a8c6bd228c84da7664cfe3', pinVersion: 'nexus-pin-2:broker-v2.12.1:cover-v3.4.0'
	};
	assert.deepEqual(Object.keys(fieldChanges).sort(), [...P.INTENT_FIELDS].sort(), 'every model field is exercised');
	for (const [field, value] of Object.entries(fieldChanges)) assert.notEqual(rawHash({ [field]: value }), h, field);
	for (const pin of Object.keys(P.PURCHASE_PINS)) {
		const changed = pin.endsWith('CodeHash') ? keccak256('0xff') : '0x00000000000000000000000000000000000000aa';
		assert.notEqual(rawHash({}, { ...P.PURCHASE_PINS, [pin]: changed }), h, pin);
	}
});

test('P4A-HASH the implementation pin is part of the hash and comes from the verified Cover pin', () => {
	assert.equal(P.PURCHASE_PINS.coverImplementation, NEXUS_CONTRACT_SOURCES.Cover.implementation.toLowerCase());
	assert.equal(P.PURCHASE_PINS.coverImplementationCodeHash, NEXUS_CONTRACT_SOURCES.Cover.runtime.keccak256);
	assert.equal(P.PURCHASE_PINS.broker, NEXUS_CONTRACT_SOURCES.CoverBroker.address.toLowerCase());
	assert.equal(P.PURCHASE_PINS.brokerCodeHash, '0xeb0e42231c9134305a54b102cea19fa29ec57f663a294a35c5bd870d81e9657c');
	assert.equal(P.PURCHASE_PINS.coverImplementation, '0xcafeaff1a21418f530feb00c6baef07523979c05');
	assert.notEqual(rawHash({}, { ...P.PURCHASE_PINS, coverImplementation: '0xcafeac0ff5da0a2777d915531bfa6b29d282ee62' }), rawHash());
	assert.ok(Object.isFrozen(P.PURCHASE_PINS));
});

test('P4A-HASH derived values follow the canonical fields: owner is the wallet, period in seconds', () => {
	const intent = valid().intent;
	assert.equal(P.ownerOf(intent), WALLET);
	assert.equal(P.periodSecondsOf(intent), 30n * 86400n);
	assert.equal(rawHash({ periodDays: 31 }) === rawHash(), false);
});

/* --------------------------------------------------------------- Zustaende -- */

const ALLOWED = [['OPEN', 'BUILT'], ['OPEN', 'EXPIRED'], ['OPEN', 'CANCELLED'], ['BUILT', 'SUBMITTED'], ['BUILT', 'EXPIRED'], ['BUILT', 'CANCELLED'], ['SUBMITTED', 'CONFIRMED'], ['SUBMITTED', 'FAILED']];

test('P4A-STATE exactly the allowed transitions; everything else is refused', () => {
	for (const from of P.INTENT_STATUSES) for (const to of P.INTENT_STATUSES) {
		const allowed = ALLOWED.some(([a, b]) => a === from && b === to);
		assert.equal(P.canTransition(from, to), allowed, `${from} -> ${to}`);
		if (allowed) assert.doesNotThrow(() => P.assertTransition(from, to));
		else assert.throws(() => P.assertTransition(from, to), /ILLEGAL_TRANSITION/);
	}
	for (const [from, to] of [['OPEN', 'SUBMITTED'], ['OPEN', 'CONFIRMED'], ['BUILT', 'CONFIRMED'], ['SUBMITTED', 'CANCELLED'], ['SUBMITTED', 'EXPIRED'], ['BUILT', 'BUILT'], ['OPEN', 'OPEN']]) {
		assert.equal(P.canTransition(from, to), false, `${from} -> ${to}`);
	}
	assert.equal(P.canTransition('NOPE', 'OPEN'), false);
	assert.equal(P.canTransition('OPEN', 'NOPE'), false);
	assert.deepEqual([...P.INTENT_STATUSES].filter(P.canBuild), ['OPEN']);
	assert.deepEqual([...P.INTENT_STATUSES].filter(P.canSubmit), ['BUILT']);
	assert.deepEqual([...P.INTENT_STATUSES].filter(P.canConfirm), ['SUBMITTED']);
});

test('P4A-STATE terminal states never restart', () => {
	const terminal = ['CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED'];
	assert.deepEqual([...P.INTENT_STATUSES].filter(P.isTerminal), terminal);
	for (const from of terminal) for (const to of P.INTENT_STATUSES) assert.equal(P.canTransition(from, to), false, `${from} -> ${to}`);
	assert.equal(P.isTerminal('SUBMITTED'), false);
});

test('P4A-STATE a submitted transaction keeps its late on-chain outcome; expiry never ends it', () => {
	const intent = valid().intent;
	const late = intent.expiresAt + 3600;
	assert.equal(P.expiryEffect('SUBMITTED', intent, late), 'AWAIT_CHAIN');
	assert.equal(P.lateOnChainOutcomePossible('SUBMITTED', { builtBefore: true }), true);
	assert.equal(P.canTransition('SUBMITTED', 'EXPIRED'), false);
	assert.equal(P.canTransition('SUBMITTED', 'CANCELLED'), false);
	assert.equal(P.canConfirm('SUBMITTED'), true);
	// abgelaufen oder abgebrochen nach BUILT: die Wallet hatte die Transaktion - eine spaete Beobachtung bleibt moeglich
	assert.equal(P.lateOnChainOutcomePossible('EXPIRED', { builtBefore: true }), true);
	assert.equal(P.lateOnChainOutcomePossible('CANCELLED', { builtBefore: true }), true);
	assert.equal(P.lateOnChainOutcomePossible('EXPIRED', { builtBefore: false }), false);
	assert.equal(P.lateOnChainOutcomePossible('OPEN', { builtBefore: false }), false);
	assert.throws(() => P.lateOnChainOutcomePossible('SUBMITTED', {}), /builtBefore/);
});

test('P4A-EXPIRY OPEN and BUILT expire at expiresAt; time is always passed in', () => {
	const intent = valid().intent;
	assert.equal(P.isIntentExpired(intent, intent.expiresAt - 1), false);
	assert.equal(P.isIntentExpired(intent, intent.expiresAt), true);
	for (const status of ['OPEN', 'BUILT']) {
		assert.equal(P.expiryEffect(status, intent, intent.expiresAt - 1), 'USABLE');
		assert.equal(P.expiryEffect(status, intent, intent.expiresAt), 'EXPIRE');
		assert.doesNotThrow(() => P.assertIntentUsable(intent, intent.expiresAt - 1, status));
		assert.throws(() => P.assertIntentUsable(intent, intent.expiresAt, status), /INTENT_EXPIRED/);
	}
	for (const status of ['SUBMITTED', 'CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED']) assert.throws(() => P.assertIntentUsable(intent, intent.expiresAt - 1, status), /NOT_USABLE/);
	for (const status of ['CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED']) assert.equal(P.expiryEffect(status, intent, intent.expiresAt), 'TERMINAL');
	for (const now of [undefined, null, '1792400000', 1.5, Date]) assert.throws(() => P.isIntentExpired(intent, now), /explicit unix timestamp/);
});

/* ----------------------------------------------------------- Bereitschaft -- */

test('P4A-READINESS never reports send or purchase readiness; proof of loss blocks every transaction', () => {
	const now = T0 + 20;
	assert.deepEqual(P.READINESS, ['READY_MODEL_ONLY', 'BLOCKED_PROOF_OF_LOSS', 'INVALID_INTENT', 'EXPIRED']);
	assert.equal(P.evaluateIntentReadiness(base(), { now, purpose: 'MODEL' }).status, 'READY_MODEL_ONLY');
	assert.deepEqual(P.evaluateIntentReadiness(base(), { now, purpose: 'TRANSACTION' }), { status: 'BLOCKED_PROOF_OF_LOSS', reasons: ['PROOF_OF_LOSS_MISSING'] });
	const withCid = { ...base(), proofOfLossCid: 'QmYhCNjfrNTMq8eyg8i7LbBpTkMCHfix9Sv1jrPb7dYZKd' };
	assert.deepEqual(P.evaluateIntentReadiness(withCid, { now, purpose: 'TRANSACTION' }), { status: 'BLOCKED_PROOF_OF_LOSS', reasons: ['PROOF_OF_LOSS_UNRESOLVED'] }, 'a CID is not production readiness');
	assert.equal(P.evaluateIntentReadiness({ ...base(), chainId: 5 }, { now, purpose: 'MODEL' }).status, 'INVALID_INTENT');
	assert.equal(P.evaluateIntentReadiness(base(), { now: base().expiresAt, purpose: 'TRANSACTION' }).status, 'EXPIRED');
	assert.throws(() => P.evaluateIntentReadiness(base(), { now, purpose: 'SEND' }), /purpose/);
	assert.throws(() => P.evaluateIntentReadiness(base(), { purpose: 'MODEL' }), /explicit unix timestamp/);
});

/* ------------------------------------------------------------- Kommission -- */

test('P4A-COMMISSION the policy is fixed to ratio 0 and the zero address; SDK defaults are not inherited', () => {
	assert.deepEqual({ ...P.COMMISSION_POLICY }, { ratio: 0, destination: '0x0000000000000000000000000000000000000000' });
	assert.ok(Object.isFrozen(P.COMMISSION_POLICY));
	// Nexus-SDK 3.1.1 setzt sonst productType.commissionRatio (Typ 0: 1000) und die DAO-Treasury als Ziel
	assert.ok(errorsOf({ commissionRatio: 1000 }).includes('COMMISSION_RATIO'));
	assert.ok(errorsOf({ commissionRatio: 1 }).includes('COMMISSION_RATIO'));
	assert.ok(errorsOf({ commissionDestination: '0x8e53D04644E9ab0412a8c6bd228C84da7664cFE3' }).includes('COMMISSION_DESTINATION'));
	assert.ok(errorsOf({ commissionDestination: WALLET }).includes('COMMISSION_DESTINATION'));
	assert.equal(valid().ok, true);
});

/* ------------------------------------------------------------- Allokation -- */

const ALLOC = (allocations, patch = {}) => P.validatePoolAllocations({ requestedAmountRaw: '1000000000', quoteTotalCoverAmountRaw: '1000192871', allocations, ...patch });

test('P4A-ALLOC the real 1000 USDC quote with overshoot passes; more than requested is allowed', () => {
	const r = ALLOC([{ poolId: '2', coverAmountInAsset: '1000192871' }]);
	assert.deepEqual(r, { ok: true, totalRaw: 1000192871n, overshootRaw: 192871n });
	const split = ALLOC([{ poolId: '2', coverAmountInAsset: '600000000' }, { poolId: '7', coverAmountInAsset: '400192871' }]);
	assert.equal(split.ok, true);
	assert.equal(ALLOC([{ poolId: '2', coverAmountInAsset: '1000000000' }], { quoteTotalCoverAmountRaw: '1000000000' }).ok, true, 'exact equality is fine too');
	// genau an der Grenze: 1 % Ueberdeckung
	assert.equal(ALLOC([{ poolId: '2', coverAmountInAsset: '1010000000' }], { quoteTotalCoverAmountRaw: '1010000000' }).ok, true);
});

test('P4A-ALLOC allocations below the requested amount, off the quote total or beyond the overshoot cap fail', () => {
	assert.deepEqual(ALLOC([{ poolId: '2', coverAmountInAsset: '999999999' }], { quoteTotalCoverAmountRaw: '999999999' }).errors, ['ALLOCATED_BELOW_REQUESTED']);
	assert.deepEqual(ALLOC([{ poolId: '2', coverAmountInAsset: '1000192870' }]).errors, ['ALLOCATED_NOT_QUOTE_TOTAL']);
	assert.deepEqual(ALLOC([{ poolId: '2', coverAmountInAsset: '1010000001' }], { quoteTotalCoverAmountRaw: '1010000001' }).errors, ['OVERSHOOT_TOO_LARGE']);
	assert.deepEqual(ALLOC([{ poolId: '2', coverAmountInAsset: '2000000000' }], { quoteTotalCoverAmountRaw: '2000000000' }).errors, ['OVERSHOOT_TOO_LARGE']);
	assert.ok(ALLOC([{ poolId: '2', coverAmountInAsset: '1000192871' }], { overshootBps: 101 }).errors.includes('OVERSHOOT_BPS'));
	assert.ok(ALLOC([{ poolId: '2', coverAmountInAsset: '1000192871' }], { overshootBps: 1e9 }).errors.includes('OVERSHOOT_BPS'));
	assert.deepEqual(ALLOC([{ poolId: '2', coverAmountInAsset: '1000192871' }], { overshootBps: 1 }).errors, ['OVERSHOOT_TOO_LARGE'], 'a tighter versioned cap applies (0.019 % > 0.01 %)');
});

test('P4A-ALLOC malformed allocation lists fail: empty, too many, duplicate pool, zero or non-canonical amounts', () => {
	assert.deepEqual(ALLOC([]).errors, ['NO_ALLOCATIONS']);
	assert.deepEqual(ALLOC(undefined).errors, ['NO_ALLOCATIONS']);
	const eleven = Array.from({ length: 11 }, (_, i) => ({ poolId: String(i + 1), coverAmountInAsset: '90926625' }));
	assert.deepEqual(ALLOC(eleven).errors, ['TOO_MANY_ALLOCATIONS']);
	assert.ok(ALLOC([{ poolId: '2', coverAmountInAsset: '500000000' }, { poolId: '2', coverAmountInAsset: '500192871' }]).errors.includes('DUPLICATE_POOL:1'));
	assert.ok(ALLOC([{ poolId: '2', coverAmountInAsset: '1000192871' }, { poolId: '3', coverAmountInAsset: '0' }]).errors.includes('ALLOCATION_AMOUNT:1'));
	assert.ok(ALLOC([{ poolId: '0', coverAmountInAsset: '1000192871' }]).errors.includes('POOL_ID:0'));
	assert.ok(ALLOC([{ poolId: 2, coverAmountInAsset: '1000192871' }]).errors.includes('POOL_ID:0'));
	assert.ok(ALLOC([{ poolId: '2', coverAmountInAsset: '1.000192871e9' }]).errors.includes('ALLOCATION_AMOUNT:0'));
	assert.ok(ALLOC([{ poolId: '2', coverAmountInAsset: '1000192871', extra: 1 }]).errors.includes('ALLOCATION_SHAPE:0'));
	assert.ok(ALLOC([{ poolId: '2', coverAmountInAsset: '1000192871' }], { requestedAmountRaw: '0' }).errors.includes('REQUESTED_AMOUNT'));
});

/* ------------------------------------------------------------ Reinheit -- */

const SRC = 'src/purchase-intent.mjs';
const code = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

test('P4A-PURE the module imports only viem and the local pin constants and has no I/O, clock or transaction surface', () => {
	const source = code(SRC);
	const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
	assert.deepEqual(imports.sort(), ['./nexus-pinned.mjs', 'viem']);
	assert.doesNotMatch(source, /\bimport\s*\(/, 'no dynamic import');
	assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|WebSocket|createPublicClient|createWalletClient|http\s*\(|process\.|node:|require\s*\(|readFile|writeFile|supabase|Date\.now|new Date|Math\.random|setTimeout|setInterval|globalThis/);
	assert.doesNotMatch(source, /eth_sendTransaction|wallet_sendCalls|sendTransaction|writeContract|encodeFunctionData|approve\s*\(|buyCover|CoverBroker\s*\.|signTypedData|personal_sign|eth_sign/);
	assert.doesNotMatch(source, /\b(calldata|selector)\b|\bto\s*:|\bdata\s*:|\bvalue\s*:/, 'no transaction-shaped output');
});

test('P4A-PURE calling every export performs no network or clock access and returns no transaction shape', async () => {
	const realFetch = globalThis.fetch, realNow = Date.now;
	const touched = [];
	globalThis.fetch = () => { touched.push('fetch'); throw new Error('network'); };
	Date.now = () => { touched.push('Date.now'); return 0; };
	try {
		const fresh = await import(`../src/purchase-intent.mjs?pure=${T0}`);
		const outputs = [
			fresh.validatePurchaseIntent(base()), fresh.computePurchaseIntentHash(base()),
			fresh.evaluateIntentReadiness(base(), { now: T0 + 20, purpose: 'TRANSACTION' }), fresh.evaluateIntentReadiness(base(), { now: T0 + 20, purpose: 'MODEL' }),
			fresh.validatePoolAllocations({ requestedAmountRaw: '1000000000', quoteTotalCoverAmountRaw: '1000192871', allocations: [{ poolId: '2', coverAmountInAsset: '1000192871' }] }),
			fresh.isIntentExpired(fresh.validatePurchaseIntent(base()).intent, T0), fresh.expiryEffect('OPEN', fresh.validatePurchaseIntent(base()).intent, T0)
		];
		const keys = JSON.stringify(outputs, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
		assert.doesNotMatch(keys, /"(to|data|value|selector|calldata|gas|nonce)":/);
	} finally {
		globalThis.fetch = realFetch; Date.now = realNow;
	}
	assert.deepEqual(touched, []);
});

function walk(dir) {
	const out = [];
	for (const name of readdirSync(new URL(`../${dir}`, import.meta.url))) {
		if (name === 'node_modules' || name.startsWith('.')) continue;
		const path = `${dir}/${name}`;
		if (statSync(new URL(`../${path}`, import.meta.url)).isDirectory()) out.push(...walk(path));
		else if (/\.(m?js|cjs|ts|tsx|jsx|html)$/.test(name)) out.push(path);
	}
	return out;
}

/** Die reinen Kauf-Module (P4A, P4B, P4C); sie duerfen einander importieren, Laufzeitcode keins. */
// P4D (19.10.2026): dazu der schmale DB-Helfer; er ist selbst von keinem Laufzeitpfad erreichbar (P4D-IMPORT in test/purchase-intent-db.test.mjs).
// P4E (19.10.2026): der nur lesende Beleg-Pruefer ist ebenso unerreichbar (P4E-IMPORT in test/purchase-receipt.test.mjs).
// P4F (20.10.2026): ebenso der nur lesende Pre-Send-Pruefer (P4F-IMPORT in test/purchase-pre-send.test.mjs).
// P4G (20.10.2026): ebenso die Bestaetigungs-Orchestrierung (P4G-IMPORT in test/purchase-confirmation.test.mjs).
// P4H (20.10.2026): ebenso Lader und Ausfuehrungs-Sitzung (P4H-LOADER-IMPORT, P4H-SESSION-IMPORT).
const PURE_PURCHASE = [SRC, 'src/purchase-terms.mjs', 'src/purchase-proof-of-loss.mjs', 'src/purchase-tx-builder.mjs', 'src/purchase-tx-decode.mjs', 'src/purchase-intent-db.mjs', 'src/purchase-receipt.mjs', 'src/purchase-pre-send.mjs', 'src/purchase-confirmation.mjs', 'src/purchase-runtime-loader.mjs', 'src/purchase-execution-session.mjs'];

test('AAVE-SCOPE-INTENT the readiness allowlists equal the P4A intent policy (Core only, USDC only, product 97, 60 s)', async () => {
	// Die Bereitschaft darf das Intent-Modell nicht importieren (P4A-IMPORT); deshalb dieser Abgleich hier.
	const R = await import('../src/aave-cover-readiness.mjs');
	const { NEXUS_ASSETS } = await import('../src/nexus-pinned.mjs');
	assert.deepEqual([...R.PURCHASE_DEPLOYMENT_KEYS], [...P.MVP_DEPLOYMENT_KEYS]);
	assert.deepEqual([...R.PURCHASE_COVER_ASSETS], P.MVP_COVER_ASSET_IDS.map((id) => NEXUS_ASSETS[id].symbol));
	assert.equal(R.AAVE_PRODUCT_ID, P.MVP_PRODUCT_ID);
	assert.equal(R.MAX_QUOTE_AGE_MS, P.QUOTE_MAX_AGE_SECONDS * 1000);
});

test('P4A-IMPORT no runtime code imports the purchase-intent module; only tests do', () => {
	const runtime = [...walk('src'), ...walk('api'), ...walk('web'), ...walk('scripts')].filter((f) => !PURE_PURCHASE.includes(f) && !f.startsWith('web/dist'));
	assert.ok(runtime.some((f) => f.startsWith('api/')) && runtime.some((f) => f.startsWith('web/src/')) && runtime.includes('src/bot.mjs'), 'the scan covers api, web, bot');
	for (const file of runtime) {
		const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
		assert.doesNotMatch(text, /purchase-intent(\.mjs)?['"`]/, file);
	}
	// importiert (statisch oder dynamisch) wird es nur von Tests der reinen Kauf-Module; andere Tests duerfen den Pfad nennen
	const importing = /(?:from\s*|import\s*\(\s*)['"`][^'"`]*purchase-intent\.mjs/;
	const testers = walk('test').filter((f) => importing.test(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')));
	assert.deepEqual(testers, ['test/purchase-confirmation-db.test.mjs', 'test/purchase-confirmation.test.mjs', 'test/purchase-execution-attempt-db.test.mjs', 'test/purchase-execution-session-db.test.mjs', 'test/purchase-execution-session-store.test.mjs', 'test/purchase-execution-session.test.mjs', 'test/purchase-intent-db.test.mjs', 'test/purchase-intent.test.mjs', 'test/purchase-pre-send.test.mjs', 'test/purchase-receipt.test.mjs', 'test/purchase-runtime-loader-db.test.mjs', 'test/purchase-runtime-loader.test.mjs', 'test/purchase-terms.test.mjs', 'test/purchase-tx-builder.test.mjs', 'test/purchase-tx-decode.test.mjs']);
});
