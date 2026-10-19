/*
	NEXUS P4B: PROOF-OF-LOSS-NUTZLAST, NUR LOKAL (19.10.2026).

	Baut und prueft die minimale Proof-of-Loss-Nutzlast fuer Produkt 97 (nur
	Adresse): genau die angemeldete Wallet, als Ersteller und als einzige
	Adresse. P4B uebertraegt nichts, laedt nichts hoch, signiert nichts, erzeugt
	keine CID und trifft keine Aussage ueber Claim-Gueltigkeit. Die CID bleibt
	kuenftige externe Angabe.

	Form beobachtet im Nexus-SDK 3.1.1 (CoverMetadataInput, nicht von Nexus
	bestaetigt): { creatorAddress, proofOfLoss: [{ type: 'address', content:
	[{ address, label? }] }] }. Das optionale label wird nicht verwendet.

	Selbst eine lokal gueltige Nutzlast bleibt BLOCKED_NEXUS_CONFIRMATION,
	solange die Fragen in PROOF_OF_LOSS_OPEN_QUESTIONS offen sind.
*/
import { normalizeWallet } from './purchase-intent.mjs';

export const PROOF_OF_LOSS_STATUS = 'PROOF_OF_LOSS_UNRESOLVED';
export const PROOF_OF_LOSS_RESULTS = Object.freeze(['VALID_LOCAL_PAYLOAD', 'BLOCKED_NEXUS_CONFIRMATION', 'INVALID_WALLET_BINDING', 'INVALID_PAYLOAD']);

/** Offene Fragen an Nexus; jede blockiert. */
export const PROOF_OF_LOSS_OPEN_QUESTIONS = Object.freeze([
	'EMPTY_IPFS_DATA_CLAIM_VALIDITY', // ist ein Cover fuer Produkt 97 mit leerem ipfsData claimfaehig?
	'DISTRIBUTOR_CREATION_WITHOUT_WALLET_SIGNATURE', // darf ein Vertriebspartner die Metadaten ohne Wallet-Signatur anlegen?
	'CREATOR_MUST_EQUAL_OWNER', // verlangt Nexus creatorAddress == Kaeufer/Eigentuemer?
	'IDEMPOTENCY_AND_RETRY', // was passiert bei Wiederholung (neue uuid/CID je POST?)
	'RETENTION_DELETION_ENCRYPTION', // Aufbewahrung, Loeschung, Verschluesselung
	'MANDATORY_DISTRIBUTOR_WORDING' // verpflichtende Vertriebs-/PoS-Texte
]);

/** Erlaubt ist fuer Produkt 97 im MVP nur die angemeldete Wallet-Adresse. */
export const PROOF_OF_LOSS_POLICY = Object.freeze({ productId: 97, types: Object.freeze(['address']), addressesPerPayload: 1, labels: false });
/** Bekannte personenbezogene oder sensible Felder; werden ausdruecklich benannt abgelehnt. */
export const FORBIDDEN_PROOF_OF_LOSS_FIELDS = Object.freeze(['name', 'email', 'ip', 'ipAddress', 'userAgent', 'apiKey', 'api_key', 'notes', 'note', 'freeText', 'free_text', 'value', 'file', 'files', 'csv', 'label', 'phone', 'country', 'identity', 'passport', 'publicData', 'secondWallet', 'wallets']);

const exactKeys = (object, keys) => object !== null && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).sort().join() === [...keys].sort().join();
const forbiddenIn = (object) => (object !== null && typeof object === 'object' ? Object.keys(object).filter((k) => FORBIDDEN_PROOF_OF_LOSS_FIELDS.includes(k)) : []);

/** Baut die Nutzlast ausschliesslich aus der angemeldeten Wallet. Kein weiterer Parameter. */
export function buildProofOfLossPayload({ wallet, ...rest }) {
	if (Object.keys(rest).length) return { ok: false, errors: Object.keys(rest).map((k) => `UNKNOWN_INPUT:${k}`) };
	const address = normalizeWallet(wallet);
	if (address === null) return { ok: false, errors: ['WALLET'] };
	return { ok: true, payload: Object.freeze({ creatorAddress: address, proofOfLoss: Object.freeze([Object.freeze({ type: 'address', content: Object.freeze([Object.freeze({ address })]) })]) }) };
}

/**
 * Prueft eine Nutzlast gegen die angemeldete Wallet und den Eigentuemer.
 * Liefert VALID_LOCAL_PAYLOAD, INVALID_WALLET_BINDING oder INVALID_PAYLOAD.
 */
export function validateProofOfLossPayload(payload, { wallet, owner }) {
	const session = normalizeWallet(wallet);
	const coverOwner = normalizeWallet(owner);
	if (session === null || coverOwner === null) return { status: 'INVALID_WALLET_BINDING', errors: ['SESSION_OR_OWNER'] };
	if (coverOwner !== session) return { status: 'INVALID_WALLET_BINDING', errors: ['OWNER_NOT_WALLET'] };

	const errors = [];
	const forbidden = (where, object) => { for (const k of forbiddenIn(object)) errors.push(`FORBIDDEN_FIELD:${where}.${k}`); };
	forbidden('payload', payload);
	if (!exactKeys(payload, ['creatorAddress', 'proofOfLoss'])) errors.push('PAYLOAD_SHAPE');
	const entries = payload?.proofOfLoss;
	if (!Array.isArray(entries) || entries.length !== 1) errors.push('ENTRY_COUNT');
	else {
		const [entry] = entries;
		forbidden('entry', entry);
		if (!exactKeys(entry, ['type', 'content'])) errors.push('ENTRY_SHAPE');
		if (entry?.type !== 'address') errors.push('ENTRY_TYPE');
		const content = entry?.content;
		if (!Array.isArray(content) || content.length !== PROOF_OF_LOSS_POLICY.addressesPerPayload) errors.push('ADDRESS_COUNT');
		else {
			forbidden('content', content[0]);
			if (!exactKeys(content[0], ['address'])) errors.push('ADDRESS_SHAPE');
		}
	}
	if (errors.length) return { status: 'INVALID_PAYLOAD', errors };

	const creator = normalizeWallet(payload.creatorAddress);
	const address = normalizeWallet(entries[0].content[0].address);
	if (creator === null || address === null) return { status: 'INVALID_PAYLOAD', errors: ['ADDRESS_FORMAT'] };
	if (creator !== session) errors.push('CREATOR_NOT_WALLET');
	if (address !== session) errors.push('ADDRESS_NOT_WALLET');
	if (errors.length) return { status: 'INVALID_WALLET_BINDING', errors };
	return { status: 'VALID_LOCAL_PAYLOAD', errors: [] };
}

/** Bereitschaft: eine lokal gueltige Nutzlast bleibt blockiert, bis Nexus die offenen Fragen beantwortet. */
export function evaluateProofOfLossReadiness(payload, binding) {
	const local = validateProofOfLossPayload(payload, binding);
	if (local.status !== 'VALID_LOCAL_PAYLOAD') return Object.freeze({ status: local.status, errors: Object.freeze([...local.errors]), openQuestions: PROOF_OF_LOSS_OPEN_QUESTIONS });
	return Object.freeze({ status: 'BLOCKED_NEXUS_CONFIRMATION', local: 'VALID_LOCAL_PAYLOAD', proofOfLoss: PROOF_OF_LOSS_STATUS, errors: Object.freeze([]), openQuestions: PROOF_OF_LOSS_OPEN_QUESTIONS });
}
