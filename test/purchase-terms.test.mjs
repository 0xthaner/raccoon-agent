/**
 * Nexus P4B (19.10.2026): versionierte Bestaetigungstexte und Terms-Hash, rein und offline.
 * Prueft Hash-Bindung, Versionsaufloesung, Unveraenderlichkeit der Texte, Bereitschaft (nie
 * kaufbereit) und die Integration mit dem P4A-Intent-Modell.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256, toHex, getAddress } from 'viem';

const T = await import('../src/purchase-terms.mjs');
const I = await import('../src/purchase-intent.mjs');

const WALLET = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const INTENT_ID = '0b9e6f1c-3d2a-4f5b-8c7d-1e2f3a4b5c6d';
const T0 = 1_792_400_000;
const OTHER_CID = 'QmYhCNjfrNTMq8eyg8i7LbBpTkMCHfix9Sv1jrPb7dYZKd';
const input = () => ({
	intentId: INTENT_ID, wallet: WALLET, wordingCid: 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY', annexCid: null,
	coverRaccoonExplanationId: 'coverraccoon.explanation@1', nexusPosDisclosureId: 'nexus.pos-disclosure@1',
	restrictedCountryAckId: 'nexus.restricted-country@1', membershipAtClaimAckId: 'nexus.membership-at-claim@1', acknowledgedAt: T0 + 10
});
const show = (v) => JSON.stringify(v);
/** Hash ohne Politikpruefung - nur um die Feldbindung zu zeigen. */
const rawHash = (patch = {}) => keccak256(T.encodeTermsTuple({ ...input(), ...patch }));

/* ------------------------------------------------------------------- Hash -- */

test('P4B-TERMS-HASH deterministic over a fixed ABI layout; wallet spelling does not matter', () => {
	const h = T.computeTermsHash(input());
	assert.match(h, /^0x[0-9a-f]{64}$/);
	assert.equal(T.computeTermsHash(input()), h);
	assert.equal(T.computeTermsHash(Object.fromEntries(Object.entries(input()).reverse())), h);
	assert.equal(T.computeTermsHash({ ...input(), wallet: getAddress(WALLET) }), h);
	assert.equal(rawHash(), h);
	assert.deepEqual(T.TERMS_HASH_FIELDS.slice(0, 9), ['domain', 'version', 'wordingCid', 'annexCid', 'nexusPosDisclosureId', 'restrictedCountryAckId', 'membershipAtClaimAckId', 'wallet', 'intentId']);
	assert.equal(T.TERMS_DOMAIN, 'coverraccoon.terms');
	assert.equal(T.TERMS_HASH_VERSION, 1);
	// kein JSON, keine Booleans: die Kodierung ist ABI, gebunden sind Text-IDs, nicht "akzeptiert"
	assert.doesNotMatch(readFileSync(new URL('../src/purchase-terms.mjs', import.meta.url), 'utf8'), /JSON\.stringify|accepted\s*:/);
});

test('P4B-TERMS-HASH wording, annex, wallet, intent and every acknowledgement ID are bound', () => {
	const h = rawHash();
	const changes = {
		wordingCid: OTHER_CID, annexCid: OTHER_CID, wallet: '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaee', intentId: '0b9e6f1c-3d2a-4f5b-8c7d-1e2f3a4b5c6e',
		nexusPosDisclosureId: 'nexus.pos-disclosure@2', restrictedCountryAckId: 'nexus.restricted-country@2', membershipAtClaimAckId: 'nexus.membership-at-claim@2',
		coverRaccoonExplanationId: 'coverraccoon.explanation@2'
	};
	for (const [field, value] of Object.entries(changes)) assert.notEqual(rawHash({ [field]: value }), h, field);
	assert.equal(rawHash({ acknowledgedAt: T0 + 99 }), h, 'the time is recorded, not hashed');
});

/* ------------------------------------------------------- Texte, Versionen -- */

test('P4B-TERMS-TEXT unknown, superseded or wrong-category text references are rejected', () => {
	const errorsOf = (patch) => { const r = T.buildAcknowledgementRecord({ ...input(), ...patch }); assert.equal(r.ok, false, show(patch)); return r.errors; };
	assert.ok(errorsOf({ nexusPosDisclosureId: 'nexus.pos-disclosure@2' }).includes('UNKNOWN_TEXT:nexusPosDisclosureId'));
	assert.ok(errorsOf({ restrictedCountryAckId: 'nexus.restricted-country' }).includes('UNKNOWN_TEXT:restrictedCountryAckId'));
	assert.ok(errorsOf({ membershipAtClaimAckId: 'nexus.membership-at-claim@0' }).includes('UNKNOWN_TEXT:membershipAtClaimAckId'));
	assert.ok(errorsOf({ membershipAtClaimAckId: 'nexus.restricted-country@1' }).includes('WRONG_CATEGORY:membershipAtClaimAckId'));
	assert.ok(errorsOf({ coverRaccoonExplanationId: 1 }).includes('UNKNOWN_TEXT:coverRaccoonExplanationId'));
	assert.deepEqual(T.resolveTextRef('nexus.pos-disclosure@1', 'NEXUS_POS_DISCLOSURE').ok, true);
	assert.equal(T.resolveTextRef('nexus.pos-disclosure@2', 'NEXUS_POS_DISCLOSURE').error, 'UNKNOWN_TEXT');
	assert.throws(() => T.computeTermsHash({ ...input(), nexusPosDisclosureId: 'nexus.pos-disclosure@2' }), /INVALID_TERMS/);
});

test('P4B-TERMS-TEXT a missing acknowledgement, a bare boolean or a foreign field is rejected', () => {
	for (const field of ['nexusPosDisclosureId', 'restrictedCountryAckId', 'membershipAtClaimAckId', 'coverRaccoonExplanationId', 'wordingCid', 'annexCid', 'wallet', 'intentId', 'acknowledgedAt']) {
		const partial = input(); delete partial[field];
		assert.deepEqual(T.buildAcknowledgementRecord(partial).errors, [`MISSING_FIELD:${field}`], field);
	}
	for (const extra of ['accepted', 'termsAccepted', 'agreed', 'checkbox']) assert.ok(T.buildAcknowledgementRecord({ ...input(), [extra]: true }).errors.includes(`UNKNOWN_FIELD:${extra}`), extra);
	assert.ok(T.buildAcknowledgementRecord({ ...input(), termsHash: keccak256('0x01') }).errors.includes('UNKNOWN_FIELD:termsHash'), 'a caller hash is never input');
	const { record } = T.buildAcknowledgementRecord(input());
	assert.deepEqual(Object.keys(record).sort(), [...T.ACKNOWLEDGEMENT_FIELDS].sort());
	assert.ok(Object.values(record).every((v) => typeof v !== 'boolean'), 'no boolean acknowledgement');
	for (const [patch, code] of [[{ wallet: '0x1234' }, 'WALLET'], [{ intentId: 'x' }, 'INTENT_ID'], [{ wordingCid: OTHER_CID }, 'WORDING_CID'], [{ annexCid: OTHER_CID }, 'ANNEX_CID'], [{ acknowledgedAt: '1792400010' }, 'ACKNOWLEDGED_AT'], [{ acknowledgedAt: 0 }, 'ACKNOWLEDGED_AT']]) {
		assert.ok(T.buildAcknowledgementRecord({ ...input(), ...patch }).errors.includes(code), `${show(patch)} -> ${code}`);
	}
});

test('P4B-TERMS-RECORD the terms hash is recomputed, never trusted from the caller', () => {
	const { ok, record } = T.buildAcknowledgementRecord(input());
	assert.equal(ok, true);
	assert.equal(record.termsHash, T.computeTermsHash(input()));
	assert.equal(record.acknowledgedAt, T0 + 10, 'the time is the one passed in');
	assert.equal(T.validateAcknowledgementRecord(record).ok, true);
	assert.deepEqual(T.validateAcknowledgementRecord({ ...record, termsHash: keccak256('0x01') }).errors, ['TERMS_HASH_MISMATCH']);
	assert.deepEqual(T.validateAcknowledgementRecord({ ...record, intentId: '0b9e6f1c-3d2a-4f5b-8c7d-1e2f3a4b5c6e' }).errors, ['TERMS_HASH_MISMATCH']);
	assert.ok(Object.isFrozen(record));
});

/** Unveraenderlichkeit: Digest je veroeffentlichter Version. Eine neue Formulierung braucht eine neue Version. */
const TEXT_DIGESTS = {
	'coverraccoon.explanation@1': '0x3cf393d648fe82e99303ce0397e2e69ff44fe6459dc011ee0a712cf0cc0fba37',
	'nexus.pos-disclosure@1': '0x973b95e26fd633550a679a9deaf9acf23b169970788e39219690aa529b7a6d7e',
	'nexus.restricted-country@1': '0x462005b8cd787be93c37de5e53c262ebef038351628e1006fbfafa4419db5bca',
	'nexus.membership-at-claim@1': '0xf539eb5fa9dede68bba32b5e4b4c5c37c52683dbe706293d05beca9eed18776d'
};
const digest = (t) => keccak256(toHex(JSON.stringify([t.id, t.version, t.category, t.required, t.text, t.statuses, t.sources.map((s) => [s.status, s.reference])])));

test('P4B-TERMS-TEXT published text versions are immutable and each category has exactly one current version', () => {
	assert.deepEqual(Object.fromEntries(T.TERMS_TEXTS.map((t) => [t.ref, digest(t)])), TEXT_DIGESTS);
	assert.ok(Object.isFrozen(T.TERMS_TEXTS) && T.TERMS_TEXTS.every((t) => Object.isFrozen(t) && Object.isFrozen(t.statuses) && Object.isFrozen(t.sources)));
	const refs = T.TERMS_TEXTS.map((t) => t.ref);
	assert.equal(new Set(refs).size, refs.length, 'id@version unique');
	assert.deepEqual(Object.keys(T.CURRENT_TEXT_REFS).sort(), [...T.TEXT_CATEGORIES].sort());
	for (const [category, current] of Object.entries(T.CURRENT_TEXT_REFS)) assert.equal(T.TERMS_TEXTS.find((t) => t.ref === current)?.category, category);
	for (const t of T.TERMS_TEXTS) {
		assert.ok(t.statuses.length >= 1 && t.statuses.every((s) => T.SOURCE_STATUSES.includes(s)), t.ref);
		assert.ok(t.sources.every((s) => T.SOURCE_STATUSES.includes(s.status)), t.ref);
		assert.ok(Number.isInteger(t.version) && t.version >= 1);
	}
});

test('P4B-TERMS-TEXT nothing unconfirmed is presented as Nexus wording; membership and country texts claim no more than the sources', () => {
	const get = (ref) => T.TERMS_TEXTS.find((t) => t.ref === ref);
	assert.equal(get('nexus.pos-disclosure@1').text, null);
	assert.deepEqual([...get('nexus.pos-disclosure@1').statuses], ['NEXUS_CONFIRMATION_REQUIRED']);
	assert.equal(get('nexus.restricted-country@1').text, null, 'no invented jurisdiction list or acknowledgement wording');
	assert.ok(get('nexus.restricted-country@1').statuses.includes('NEXUS_CONFIRMATION_REQUIRED'));
	const membership = get('nexus.membership-at-claim@1');
	assert.deepEqual([...membership.statuses].sort(), ['NEXUS_CONFIRMATION_REQUIRED', 'SOURCE_NOT_FULLY_PINNED']);
	assert.ok(membership.sources.some((s) => s.status === 'SOURCE_NOT_FULLY_PINNED' && /Claims\.submitClaim/.test(s.reference)));
	assert.ok(membership.sources.some((s) => s.status === 'VERIFIED_PRIMARY_SOURCE' && s.reference.includes('QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY')));
	assert.doesNotMatch(membership.text, /\bonly\b|definitely|guarantee|will be paid|KYC/i, 'neutral: no claim about KYC timing or payout');
	assert.doesNotMatch(get('coverraccoon.explanation@1').text, /guarantee|insur(ed|ance) by CoverRaccoon|will be paid/i);
	assert.deepEqual([...T.SOURCE_STATUSES], ['VERIFIED_PRIMARY_SOURCE', 'OBSERVED_SDK', 'OBSERVED_PUBLIC_NEXUS_CONTENT', 'NEXUS_CONFIRMATION_REQUIRED', 'SOURCE_NOT_FULLY_PINNED', 'COVERRACCOON_AUTHORED']);
});

/* ----------------------------------------------------------- Bereitschaft -- */

test('P4B-TERMS-READINESS unresolved Nexus texts block; never ready to buy', () => {
	const { record } = T.buildAcknowledgementRecord(input());
	const r = T.evaluateTermsReadiness(record);
	assert.equal(r.status, 'BLOCKED_NEXUS_TEXT');
	assert.deepEqual([...r.texts].sort(), ['nexus.membership-at-claim@1', 'nexus.pos-disclosure@1', 'nexus.restricted-country@1']);
	assert.equal(T.evaluateTermsReadiness({ ...record, termsHash: keccak256('0x01') }).status, 'INVALID_TERMS');
	assert.equal(T.evaluateTermsReadiness({ ...record, nexusPosDisclosureId: 'nexus.pos-disclosure@9' }).status, 'INVALID_TERMS');
	assert.deepEqual([...T.TERMS_READINESS], ['READY_MODEL_ONLY', 'BLOCKED_NEXUS_TEXT', 'BLOCKED_SOURCE_PIN', 'INVALID_TERMS']);
	// die Rangfolge mit synthetischen Definitionen: Nexus-Text vor Quellen-Pin vor Modell
	const def = (ref, statuses, extra = {}) => ({ ref, required: true, category: 'MEMBERSHIP_AT_CLAIM', text: 'x', statuses, ...extra });
	assert.equal(T.readinessForTexts([def('a@1', ['SOURCE_NOT_FULLY_PINNED'])]).status, 'BLOCKED_SOURCE_PIN');
	assert.equal(T.readinessForTexts([def('a@1', ['VERIFIED_PRIMARY_SOURCE'])]).status, 'READY_MODEL_ONLY');
	assert.equal(T.readinessForTexts([def('a@1', ['VERIFIED_PRIMARY_SOURCE'], { text: null })]).status, 'BLOCKED_NEXUS_TEXT', 'a required Nexus text without wording blocks');
	assert.equal(T.readinessForTexts([def('a@1', ['NEXUS_CONFIRMATION_REQUIRED'], { required: false })]).status, 'READY_MODEL_ONLY');
	for (const status of T.TERMS_READINESS) assert.doesNotMatch(status, /BUY|PURCHASE|SEND/);
});

/* --------------------------------------------------------------- P4A -- */

const intentBase = (termsHash) => ({
	id: INTENT_ID, wallet: WALLET, chainId: 1, deploymentKey: 'aave-v3-ethereum-core', productId: 97, productTypeId: 0, coverAssetId: 6, amountRaw: '1000000000', periodDays: 30,
	quotePremiumRaw: '3000578', maxPremiumRaw: '3030584', quoteFetchedAt: T0, capacityFetchedAt: T0, wordingCid: 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY', annexCid: null,
	termsHash, proofOfLossCid: null, commissionRatio: 0, commissionDestination: '0x0000000000000000000000000000000000000000', pinVersion: I.PURCHASE_PIN_VERSION, acknowledgedAt: T0 + 10, expiresAt: T0 + 610
});

test('P4B-CROSS the P4B terms hash validates in the P4A intent, binds it, and readiness stays blocked', () => {
	const termsHash = T.computeTermsHash(input());
	const intent = intentBase(termsHash);
	assert.equal(I.validatePurchaseIntent(intent).ok, true);
	const h = I.computePurchaseIntentHash(intent);
	const otherTerms = T.computeTermsHash({ ...input(), intentId: '0b9e6f1c-3d2a-4f5b-8c7d-1e2f3a4b5c6e' });
	assert.notEqual(otherTerms, termsHash);
	assert.notEqual(I.computePurchaseIntentHash(intentBase(otherTerms)), h, 'a terms change is a different intent');
	assert.equal(intent.proofOfLossCid, null, 'no CID until an external one is supplied later');
	assert.equal(I.evaluateIntentReadiness(intent, { now: T0 + 20, purpose: 'TRANSACTION' }).status, 'BLOCKED_PROOF_OF_LOSS');
	assert.equal(I.evaluateIntentReadiness(intent, { now: T0 + 20, purpose: 'MODEL' }).status, 'READY_MODEL_ONLY');
});

/* ------------------------------------------------------------- Reinheit -- */

const code = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

test('P4B-TERMS-PURE the terms module imports only viem and local pure modules and has no I/O, signing or transaction surface', () => {
	const source = code('src/purchase-terms.mjs');
	const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
	assert.deepEqual(imports.sort(), ['./nexus-pinned.mjs', './purchase-intent.mjs', 'viem']);
	assert.doesNotMatch(source, /\bimport\s*\(|fetch\s*\(|XMLHttpRequest|createPublicClient|createWalletClient|process\.|node:|require\s*\(|Date\.now|new Date|Math\.random|globalThis/);
	assert.doesNotMatch(source, /cover-metadata|x-auth|signTypedData|eth_signTypedData|personal_sign|Authentication|eth_sendTransaction|wallet_sendCalls|sendTransaction|writeContract|encodeFunctionData|approve\s*\(|buyCover|POST/);
});
