/*
	WIRTSCHAFTLICHES ENGAGEMENT EINER AAVE-POSITION (P2, 18.10.2026).

	Reine Rechnung, kein Netz. Grundlage sind die bereits erkannten Werte der
	Position (Aaves eigenes Orakel, USD mit 8 Stellen, aave-v3.mjs):

	  grossExposure     = Summe aller Einlagen (Sicherheit oder nicht)
	  debt              = Summe der offenen Schulden
	  suggestedExposure = max(grossExposure - debt, 0)

	Das ist ein VORSCHLAG fuer eine Cover-Summe, kein versicherter Verlust und
	kein Betrag, den Nexus auszahlen wuerde: massgeblich ist allein das Wording
	(Verlust zum Schadenszeitpunkt, nach Erstattungen, abzueglich Selbstbehalt).

	Gerechnet wird in BigInt auf 8 Stellen. Passen die Einzelwerte nicht exakt zu
	den Summen der Position, gibt es kein Ergebnis (INVALID) statt einer Zahl.
*/

export const EXPOSURE_METHOD = 'AAVE_NET_EXPOSURE_V1';
export const EXPOSURE_DISCLAIMERS = Object.freeze(['SUGGESTED_AMOUNT_ONLY', 'NOT_A_GUARANTEED_CLAIMABLE_AMOUNT', 'NEXUS_WORDING_GOVERNS']);

const SCALE = 8;
const USD = /^(0|[1-9][0-9]{0,29})(\.[0-9]{1,8})?$/;

function parseUsd(value) {
	if (typeof value !== 'string' || !USD.test(value)) return null;
	const [whole, fraction = ''] = value.split('.');
	return BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(fraction.padEnd(SCALE, '0'));
}

function formatUsd(value) {
	const unit = 10n ** BigInt(SCALE);
	const fraction = (value % unit).toString().padStart(SCALE, '0').replace(/0+$/, '');
	return `${value / unit}${fraction ? `.${fraction}` : ''}`;
}

function sum(entries) {
	if (!Array.isArray(entries)) return null;
	let total = 0n;
	for (const entry of entries) {
		const value = parseUsd(entry?.usdValue);
		if (value === null) return null;
		total += value;
	}
	return total;
}

const invalid = (reason) => Object.freeze({ status: 'INVALID', reason, calculationMethod: EXPOSURE_METHOD, grossExposure: null, debt: null, suggestedExposure: null, disclaimers: EXPOSURE_DISCLAIMERS });

export function computeAaveExposure(position) {
	if (position === null || typeof position !== 'object' || position.valueKind !== 'DERIVED_FROM_AAVE_ORACLE' || position.pricing?.baseCurrency !== 'USD') return invalid('UNSUPPORTED_VALUATION');
	const gross = sum(position.supplied);
	const debt = sum(position.borrowed);
	if (gross === null || debt === null) return invalid('MALFORMED_VALUES');
	if (gross !== parseUsd(position.totals?.suppliedUsd) || debt !== parseUsd(position.totals?.debtUsd)) return invalid('TOTALS_MISMATCH');
	const net = gross - debt;
	return Object.freeze({
		status: 'OK',
		calculationMethod: EXPOSURE_METHOD,
		currency: 'USD',
		valuation: Object.freeze({ source: 'aave-oracle', blockNumber: position.blockNumber ?? null }),
		grossExposure: formatUsd(gross),
		debt: formatUsd(debt),
		suggestedExposure: formatUsd(net > 0n ? net : 0n),
		disclaimers: EXPOSURE_DISCLAIMERS
	});
}
