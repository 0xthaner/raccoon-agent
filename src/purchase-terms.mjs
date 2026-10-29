/*
	NEXUS P4B: VERSIONIERTE BESTAETIGUNGSTEXTE UND TERMS-HASH (19.10.2026).

	P4B bereitet nur die exakte Bindung der Bestaetigungen an einen Kauf-Intent
	vor. P4B uebertraegt nichts, laedt nichts hoch, signiert nichts, trifft keine
	Aussage ueber Claim-Gueltigkeit und ermoeglicht keinen Kauf.

	Texte sind unveraenderlich je Version: eine geaenderte Formulierung ist eine
	neue Version (alte bleiben stehen, test/purchase-terms.test.mjs haelt ihre
	Digests fest). Was Nexus nicht offiziell bestaetigt hat, hat keinen Text und
	blockiert jede Bereitschaft (NEXUS_CONFIRMATION_REQUIRED).

	Rein: keine Netz-, DB-, Wallet-, Datei-, Umgebungs- oder Uhrzugriffe. Nur
	Tests und die reinen Kauf-Module importieren dieses Modul.
*/
import { encodeAbiParameters, keccak256 } from 'viem';
import { PINNED_PRODUCTS, PURCHASE_ANNEX_CID } from './nexus-pinned.mjs';
import { normalizeWallet, isCid, isIntentId, MVP_PRODUCT_ID } from './purchase-intent.mjs';

export const TERMS_DOMAIN = 'coverraccoon.terms';
export const TERMS_HASH_VERSION = 1;

/** Herkunft einer Aussage. Bewusst nicht zu "verifiziert" zusammengefasst. */
export const SOURCE_STATUSES = Object.freeze([
	'VERIFIED_PRIMARY_SOURCE', // inhaltsadressiert oder rekompiliert nachgewiesen (z. B. Wording-CID)
	'OBSERVED_SDK', // aus dem Code des Nexus-SDK gelesen, nicht von Nexus bestaetigt
	'OBSERVED_PUBLIC_NEXUS_CONTENT', // oeffentliche Nexus-Seite/Blog, nicht gepinnt
	'NEXUS_CONFIRMATION_REQUIRED', // offene Frage an Nexus; kein Text
	'SOURCE_NOT_FULLY_PINNED', // Grundlage existiert, die deployte Fassung ist nicht gepinnt
	'COVERRACCOON_AUTHORED' // eigener erklaerender Text, keine Aussage fuer Nexus
]);
/** Diese Status verhindern jede Bereitschaft ueber das Modell hinaus. */
const BLOCKING = Object.freeze(['NEXUS_CONFIRMATION_REQUIRED', 'SOURCE_NOT_FULLY_PINNED']);

export const TEXT_CATEGORIES = Object.freeze(['COVERRACCOON_EXPLANATION', 'NEXUS_POS_DISCLOSURE', 'RESTRICTED_COUNTRY', 'MEMBERSHIP_AT_CLAIM']);

const WORDING = `SRC-NEXUS-WORDING (IPFS ${PINNED_PRODUCTS[MVP_PRODUCT_ID].wordingCid})`;
const ref = (status, reference) => Object.freeze({ status, reference });
const text = (definition) => Object.freeze({ ...definition, ref: `${definition.id}@${definition.version}`, statuses: Object.freeze([...definition.statuses]), sources: Object.freeze([...definition.sources]) });

/**
 * Alle je veroeffentlichten Textversionen. Nie bearbeiten - neue Version anhaengen.
 * statuses: was fuer DIESE Version gilt (blockierende zuerst); sources: Belege je mit eigenem Status.
 */
export const TERMS_TEXTS = Object.freeze([
	text({ id: 'coverraccoon.explanation', version: 1, category: 'COVERRACCOON_EXPLANATION', required: true,
		text: 'CoverRaccoon is an independent interface. It is not Nexus Mutual and does not underwrite cover or decide claims. The cover is governed by the Nexus Mutual cover wording identified by its IPFS CID.',
		statuses: ['COVERRACCOON_AUTHORED'], sources: [] }),
	text({ id: 'nexus.pos-disclosure', version: 1, category: 'NEXUS_POS_DISCLOSURE', required: true, text: null,
		statuses: ['NEXUS_CONFIRMATION_REQUIRED'],
		sources: [ref('NEXUS_CONFIRMATION_REQUIRED', 'mandatory distributor / point-of-sale wording: not found in any pinned Nexus source; to be requested from Nexus')] }),
	text({ id: 'nexus.restricted-country', version: 1, category: 'RESTRICTED_COUNTRY', required: true, text: null,
		statuses: ['NEXUS_CONFIRMATION_REQUIRED'],
		sources: [
			ref('VERIFIED_PRIMARY_SOURCE', `${WORDING}, "CLAIMS SUBMISSION" (d): a claimant must not reside in or be located in a jurisdiction subject to sanctions or legal restrictions that prohibit participation or claims`),
			ref('NEXUS_CONFIRMATION_REQUIRED', 'the jurisdiction list (docs.nexusmutual.io/overview/membership) is not pinned; whether and in which words a distributor must obtain an acknowledgement at purchase is unconfirmed')
		] }),
	text({ id: 'nexus.membership-at-claim', version: 1, category: 'MEMBERSHIP_AT_CLAIM', required: true,
		text: 'The Nexus Mutual cover wording lists conditions for submitting a claim, including Nexus Mutual membership at the time the claim is submitted. CoverRaccoon does not check whether you meet these conditions.',
		statuses: ['NEXUS_CONFIRMATION_REQUIRED', 'SOURCE_NOT_FULLY_PINNED'],
		sources: [
			ref('VERIFIED_PRIMARY_SOURCE', `${WORDING}, "CLAIMS SUBMISSION" (a)-(c): membership at the time the claim is submitted, completed KYC process, membership fee paid`),
			ref('SOURCE_NOT_FULLY_PINNED', 'Claims.submitClaim (smart-contracts source read, deployed version not pinned): caller must be a member and own the cover NFT'),
			ref('NEXUS_CONFIRMATION_REQUIRED', 'whether this acknowledgement wording is acceptable to Nexus for distributor purchases')
		] })
]);

const byRef = new Map(TERMS_TEXTS.map((t) => [t.ref, t]));
/** Die je Kategorie aktuell geltende Version. Eine aeltere Version ist fuer neue Bestaetigungen ungueltig. */
export const CURRENT_TEXT_REFS = Object.freeze({
	COVERRACCOON_EXPLANATION: 'coverraccoon.explanation@1',
	NEXUS_POS_DISCLOSURE: 'nexus.pos-disclosure@1',
	RESTRICTED_COUNTRY: 'nexus.restricted-country@1',
	MEMBERSHIP_AT_CLAIM: 'nexus.membership-at-claim@1'
});

/** Feld der Bestaetigung -> Kategorie des Textes, auf den es zeigen muss. */
const ACK_TEXT_FIELDS = Object.freeze({
	coverRaccoonExplanationId: 'COVERRACCOON_EXPLANATION',
	nexusPosDisclosureId: 'NEXUS_POS_DISCLOSURE',
	restrictedCountryAckId: 'RESTRICTED_COUNTRY',
	membershipAtClaimAckId: 'MEMBERSHIP_AT_CLAIM'
});
const INPUT_FIELDS = Object.freeze(['intentId', 'wallet', 'wordingCid', 'annexCid', ...Object.keys(ACK_TEXT_FIELDS), 'acknowledgedAt']);
export const ACKNOWLEDGEMENT_FIELDS = Object.freeze([...INPUT_FIELDS, 'termsHash']);

/** Loest eine Text-Referenz exakt auf (id@version) - nur bekannte, aktuelle Version der erwarteten Kategorie. */
export function resolveTextRef(value, category) {
	const definition = typeof value === 'string' ? byRef.get(value) : undefined;
	if (!definition) return { ok: false, error: 'UNKNOWN_TEXT' };
	if (definition.category !== category) return { ok: false, error: 'WRONG_CATEGORY' };
	if (CURRENT_TEXT_REFS[category] !== value) return { ok: false, error: 'SUPERSEDED_VERSION' };
	return { ok: true, definition };
}

const LAYOUT = [
	['string', 'domain'], ['uint8', 'version'], ['string', 'wordingCid'], ['string', 'annexCid'], ['string', 'nexusPosDisclosureId'],
	['string', 'restrictedCountryAckId'], ['string', 'membershipAtClaimAckId'], ['address', 'wallet'], ['bytes16', 'intentId'],
	// ab hier: zusaetzlich gebunden, feste Reihenfolge
	['string', 'coverRaccoonExplanationId']
];
export const TERMS_HASH_FIELDS = Object.freeze(LAYOUT.map(([, name]) => name));

/** Kodiert bereits gepruefte Werte (abi.encode, feste Reihenfolge). Prueft keine Politik. */
export function encodeTermsTuple(values) {
	const all = { ...values, domain: TERMS_DOMAIN, version: TERMS_HASH_VERSION, annexCid: values.annexCid ?? '', intentId: `0x${values.intentId.replaceAll('-', '')}` };
	return encodeAbiParameters(LAYOUT.map(([type]) => ({ type })), LAYOUT.map(([, name]) => all[name]));
}

function validateInput(input, { allowTermsHash }) {
	const errors = [];
	if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['NOT_AN_OBJECT'] };
	const allowed = allowTermsHash ? ACKNOWLEDGEMENT_FIELDS : INPUT_FIELDS;
	for (const key of Object.keys(input)) if (!allowed.includes(key)) errors.push(`UNKNOWN_FIELD:${key}`);
	for (const key of INPUT_FIELDS) if (!Object.hasOwn(input, key)) errors.push(`MISSING_FIELD:${key}`);
	if (errors.length) return { ok: false, errors };
	if (!isIntentId(input.intentId)) errors.push('INTENT_ID');
	const wallet = normalizeWallet(input.wallet);
	if (wallet === null) errors.push('WALLET');
	const product = PINNED_PRODUCTS[MVP_PRODUCT_ID];
	if (!isCid(input.wordingCid) || input.wordingCid !== product.wordingCid) errors.push('WORDING_CID');
	if ((input.annexCid !== null && !isCid(input.annexCid)) || input.annexCid !== PURCHASE_ANNEX_CID) errors.push('ANNEX_CID');
	const texts = {};
	for (const [field, category] of Object.entries(ACK_TEXT_FIELDS)) {
		const resolved = resolveTextRef(input[field], category);
		if (!resolved.ok) errors.push(`${resolved.error}:${field}`);
		else texts[field] = resolved.definition;
	}
	if (!Number.isSafeInteger(input.acknowledgedAt) || input.acknowledgedAt <= 0 || input.acknowledgedAt >= 2 ** 40) errors.push('ACKNOWLEDGED_AT');
	if (errors.length) return { ok: false, errors };
	return { ok: true, values: { ...input, wallet }, texts };
}

/** Terms-Hash ueber exakte Text-Versionen, Wording/Annex, Wallet und Intent. Ungueltig -> wirft. */
export function computeTermsHash(input) {
	const result = validateInput(input, { allowTermsHash: false });
	if (!result.ok) throw new Error(`INVALID_TERMS: ${result.errors.join(',')}`);
	return keccak256(encodeTermsTuple(result.values));
}

/** Baut den kanonischen Bestaetigungsdatensatz; der termsHash wird hier berechnet, nie uebernommen. */
export function buildAcknowledgementRecord(input) {
	const result = validateInput(input, { allowTermsHash: false });
	if (!result.ok) return { ok: false, errors: result.errors };
	return { ok: true, record: Object.freeze({ ...result.values, termsHash: keccak256(encodeTermsTuple(result.values)) }) };
}

/** Prueft einen gespeicherten Datensatz: der mitgelieferte termsHash muss der neu berechnete sein. */
export function validateAcknowledgementRecord(record) {
	const result = validateInput(record, { allowTermsHash: true });
	if (!result.ok) return { ok: false, errors: result.errors };
	const expected = keccak256(encodeTermsTuple(result.values));
	if (record.termsHash !== expected) return { ok: false, errors: ['TERMS_HASH_MISMATCH'] };
	return { ok: true, record: Object.freeze({ ...result.values, termsHash: expected }), texts: result.texts };
}

export const TERMS_READINESS = Object.freeze(['READY_MODEL_ONLY', 'BLOCKED_NEXUS_TEXT', 'BLOCKED_SOURCE_PIN', 'INVALID_TERMS']);

/** Bereitschaft fuer eine Menge aufgeloester Textdefinitionen. Nie kaufbereit. */
export function readinessForTexts(definitions) {
	const required = definitions.filter((d) => d.required);
	const nexus = required.filter((d) => d.statuses.includes('NEXUS_CONFIRMATION_REQUIRED') || (d.category !== 'COVERRACCOON_EXPLANATION' && d.text === null));
	if (nexus.length) return Object.freeze({ status: 'BLOCKED_NEXUS_TEXT', texts: Object.freeze(nexus.map((d) => d.ref)) });
	const pin = required.filter((d) => d.statuses.some((s) => BLOCKING.includes(s)));
	if (pin.length) return Object.freeze({ status: 'BLOCKED_SOURCE_PIN', texts: Object.freeze(pin.map((d) => d.ref)) });
	return Object.freeze({ status: 'READY_MODEL_ONLY', texts: Object.freeze([]) });
}

export function evaluateTermsReadiness(record) {
	const result = validateAcknowledgementRecord(record);
	if (!result.ok) return Object.freeze({ status: 'INVALID_TERMS', texts: Object.freeze([]), reasons: Object.freeze([...result.errors]) });
	return readinessForTexts(Object.values(result.texts));
}
