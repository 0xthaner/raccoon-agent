/**
 * Zentrale SIWE-Grenze nach ERC-4361 fuer Dashboard und Telegram.
 *
 * AGENT-SEC-A3, 29.08.2026. Erzeugung und Pruefung der beiden Signaturtexte
 * liegen hier an EINER Stelle, damit Aussteller und Verifizierer denselben
 * Text rekonstruieren und nicht auseinanderlaufen koennen.
 *
 * Diese Datei enthaelt KEINE Signaturverifikation: die bleibt in den Handlern
 * bei `verifyMessage`. Sie liest keine Datenbank, kein Netzwerk und keinen
 * Request; sie erzeugt keine Session und kein Cookie.
 */

import { createHash, randomBytes } from 'node:crypto';
import { verifyMessage } from 'viem';
import { createSiweMessage, parseSiweMessage, validateSiweMessage } from 'viem/siwe';

/* ------------------------------------------------------------------------- *
 * Kanonische Konstanten
 * ------------------------------------------------------------------------- */

export const SIWE_VERSION = '1';

/**
 * Die Login-Chain. Fest auf Ethereum Mainnet und ausdruecklich NICHT aus der
 * gerade in der Wallet gewaehlten Chain abgeleitet.
 */
export const SIWE_CHAIN_ID = 1;

export const PRODUCTION_ORIGIN = 'https://agent.coverraccoon.com';

/**
 * ERC-4361 laesst fuer das Statement genau EINE Zeile zu; `createSiweMessage`
 * lehnt ein Statement mit Zeilenumbruch ab, und `parseSiweMessage` liest nur
 * eine Zeile zurueck. Die beiden Saetze des Auftrags stehen deshalb in einer
 * Zeile, im Wortlaut unveraendert und nur durch ein Leerzeichen getrennt.
 */
export const DASHBOARD_STATEMENT =
	'Open your personal CoverRaccoon dashboard. This does not authorize transactions, token approvals, transfers or purchases.';

export const TELEGRAM_STATEMENT =
	'Connect this wallet to Raccoon Agent Telegram cover notifications. This does not authorize dashboard access, transactions, token approvals, transfers or purchases.';

export const DASHBOARD_RESOURCE_PATH = '/dashboard';
export const TELEGRAM_RESOURCE_PATH = '/telegram-link';

/**
 * Toleranz fuer eine vorlaufende Serveruhr.
 *
 * `issuedAt` wird serverseitig gesetzt und beim Pruefen exakt gegen die
 * gespeicherte Challenge gehalten; die Toleranz betrifft nur den Vergleich
 * gegen die JETZT-Zeit derselben Instanz. Eine Minute deckt die uebliche
 * Drift zwischen zwei serverlosen Instanzen ab, ohne einen abgelaufenen
 * Zeitraum zu verlaengern.
 */
export const SIWE_CLOCK_SKEW_MS = 60_000;

/** Request-ID mit 128 Bit Entropie. Hex, damit sie keine Zeile bricht. */
export function newRequestId() {
	return randomBytes(16).toString('hex');
}

/**
 * Request-ID der Telegram-Verknuepfung.
 *
 * Sie wird DETERMINISTISCH aus dem serverseitig gespeicherten Pending-Link-Code
 * abgeleitet, damit die Verifikation sie ohne zusaetzliches Feld rekonstruieren
 * kann. Bewusst als Hash und nicht als Code selbst: der Code ist ein
 * kurzlebiges Einmalgeheimnis und soll nicht im signierten Text stehen. Der
 * Hash ist urbildresistent und gibt ihn nicht preis.
 */
export function telegramRequestId(code) {
	return createHash('sha256').update(`telegram-link:${code}`).digest('hex').slice(0, 32);
}

/* ------------------------------------------------------------------------- *
 * Trusted Origin
 * ------------------------------------------------------------------------- */

/**
 * Ist die Umgebung ausdruecklich nicht-produktiv?
 *
 * STRENG PER VOREINSTELLUNG: ohne ausdrueckliches Entwicklungs- oder
 * Testsignal gilt Production. Eine fehlende Variable darf niemals eine
 * Lockerung bedeuten.
 */
function explicitlyNonProduction() {
	const vercel = process.env.VERCEL_ENV?.trim();
	if (vercel) return vercel !== 'production' && vercel === 'development';
	const node = process.env.NODE_ENV?.trim();
	return node === 'development' || node === 'test';
}

function configurationError() {
	return new Error('Anmeldung ist nicht konfiguriert.');
}

/**
 * Liefert Domain und URI der Anmeldung.
 *
 * AUSSCHLIESSLICH aus `APP_BASE_URL`. Es wird KEIN Requestwert gelesen: weder
 * Host noch Origin, Query, Body oder ein Forwarded-Header. Diese Funktion nimmt
 * bewusst keinen Request entgegen, damit eine Ueberschreibung strukturell
 * unmoeglich ist.
 *
 * In Production ist genau `https://agent.coverraccoon.com` zulaessig. Nur in
 * einer ausdruecklich nicht-produktiven Umgebung ist zusaetzlich
 * `http://localhost:<PORT>` beziehungsweise `http://127.0.0.1:<PORT>` erlaubt.
 * Alles andere faellt zu: keine Preview-Domain ohne eigene Konfiguration, kein
 * HTTP in Production, keine Wildcard, kein Rueckfall auf eine fremde Domain.
 */
export function siweOrigin() {
	const configured = process.env.APP_BASE_URL?.trim();
	if (!configured) throw configurationError();

	let url;
	try {
		url = new URL(configured);
	} catch {
		throw configurationError();
	}
	if (url.username || url.password || url.search || url.hash) throw configurationError();
	if (url.pathname !== '/') throw configurationError();

	const origin = url.origin;
	if (origin === PRODUCTION_ORIGIN) return { domain: url.host, uri: origin };

	const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	if (explicitlyNonProduction() && url.protocol === 'http:' && loopback) {
		return { domain: url.host, uri: origin };
	}
	throw configurationError();
}

export function dashboardResource() {
	return `${siweOrigin().uri}${DASHBOARD_RESOURCE_PATH}`;
}

export function telegramResource() {
	return `${siweOrigin().uri}${TELEGRAM_RESOURCE_PATH}`;
}

/* ------------------------------------------------------------------------- *
 * Nachrichtenerzeugung
 * ------------------------------------------------------------------------- */

function buildMessage({ wallet, nonce, issuedAt, expiresAt, requestId, statement, resourcePath }) {
	const { domain, uri } = siweOrigin();
	// `createSiweMessage` prueft Domain, Nonce, URI und Version selbst und
	// setzt die Adresse in Pruefsummenschreibweise.
	return createSiweMessage({
		address: wallet,
		domain,
		uri,
		version: SIWE_VERSION,
		chainId: SIWE_CHAIN_ID,
		statement,
		nonce,
		issuedAt: new Date(issuedAt),
		expirationTime: new Date(expiresAt),
		requestId,
		resources: [`${uri}${resourcePath}`]
	});
}

export function dashboardSiweMessage({ wallet, nonce, issuedAt, expiresAt, requestId }) {
	return buildMessage({
		wallet, nonce, issuedAt, expiresAt, requestId,
		statement: DASHBOARD_STATEMENT,
		resourcePath: DASHBOARD_RESOURCE_PATH
	});
}

export function telegramSiweMessage({ wallet, nonce, issuedAt, expiresAt, code }) {
	return buildMessage({
		wallet, nonce, issuedAt, expiresAt,
		requestId: telegramRequestId(code),
		statement: TELEGRAM_STATEMENT,
		resourcePath: TELEGRAM_RESOURCE_PATH
	});
}

/* ------------------------------------------------------------------------- *
 * Pruefung
 * ------------------------------------------------------------------------- */

/**
 * Getrennte Ursachen. Es gibt hier bewusst KEINEN Boolean: die Domainfunktion
 * nennt den Grund, und erst der Handler bildet nach aussen auf eine sichere,
 * allgemeine Meldung ab.
 */
export const SIWE_RESULTS = [
	'VALID',
	'INVALID_FORMAT',
	'DOMAIN_MISMATCH',
	'URI_MISMATCH',
	'VERSION_MISMATCH',
	'CHAIN_MISMATCH',
	'ADDRESS_MISMATCH',
	'STATEMENT_MISMATCH',
	'NONCE_MISMATCH',
	'REQUEST_ID_MISMATCH',
	'RESOURCE_MISMATCH',
	'ISSUED_AT_INVALID',
	'EXPIRED'
];

const MAX_MESSAGE_LENGTH = 4096;

/**
 * Prueft eine SIWE-Nachricht Feld fuer Feld gegen die trusted Erwartung.
 *
 * Geparst wird ausschliesslich mit `parseSiweMessage` aus viem, es gibt keinen
 * eigenen Parser. `validateSiweMessage` laeuft zusaetzlich als Gegenprobe der
 * Bibliothek; sie deckt nur Domain, Nonce, Adresse und Zeitfenster ab und
 * ersetzt die Feldpruefung deshalb nicht.
 */
export function checkSiweMessage(message, expected, now = Date.now()) {
	if (typeof message !== 'string' || message.length === 0 || message.length > MAX_MESSAGE_LENGTH) {
		return 'INVALID_FORMAT';
	}
	let parsed;
	try {
		parsed = parseSiweMessage(message);
	} catch {
		return 'INVALID_FORMAT';
	}
	if (!parsed || !parsed.domain || !parsed.address || !parsed.uri || !parsed.nonce) return 'INVALID_FORMAT';
	if (!parsed.version || !Number.isFinite(parsed.chainId)) return 'INVALID_FORMAT';
	if (!(parsed.issuedAt instanceof Date) || Number.isNaN(parsed.issuedAt.getTime())) return 'INVALID_FORMAT';
	if (!(parsed.expirationTime instanceof Date) || Number.isNaN(parsed.expirationTime.getTime())) {
		return 'INVALID_FORMAT';
	}

	if (parsed.domain !== expected.domain) return 'DOMAIN_MISMATCH';
	if (parsed.uri !== expected.uri) return 'URI_MISMATCH';
	if (parsed.version !== SIWE_VERSION) return 'VERSION_MISMATCH';
	if (parsed.chainId !== SIWE_CHAIN_ID) return 'CHAIN_MISMATCH';
	if (String(parsed.address).toLowerCase() !== String(expected.wallet).toLowerCase()) {
		return 'ADDRESS_MISMATCH';
	}
	if (parsed.statement !== expected.statement) return 'STATEMENT_MISMATCH';
	if (parsed.nonce !== expected.nonce) return 'NONCE_MISMATCH';
	if (parsed.requestId !== expected.requestId) return 'REQUEST_ID_MISMATCH';
	if (!Array.isArray(parsed.resources) || parsed.resources.length !== 1) return 'RESOURCE_MISMATCH';
	if (parsed.resources[0] !== expected.resource) return 'RESOURCE_MISMATCH';

	// Zeit: serverseitig gebunden, keine Clientzeit, keine Verlaengerung.
	const issuedAt = parsed.issuedAt.getTime();
	if (issuedAt !== expected.issuedAt) return 'ISSUED_AT_INVALID';
	if (issuedAt > now + SIWE_CLOCK_SKEW_MS) return 'ISSUED_AT_INVALID';
	if (parsed.expirationTime.getTime() !== expected.expiresAt) return 'EXPIRED';
	if (now >= expected.expiresAt) return 'EXPIRED';

	if (!validateSiweMessage({
		address: parsed.address,
		domain: expected.domain,
		message: parsed,
		nonce: expected.nonce,
		time: new Date(now)
	})) {
		return 'INVALID_FORMAT';
	}
	return 'VALID';
}

/* ------------------------------------------------------------------------- *
 * Die eine Verifikationsgrenze
 * ------------------------------------------------------------------------- */

/**
 * Ergebnisse der vollstaendigen Pruefung: die Feldursachen plus die beiden
 * Signaturursachen. Weiterhin KEINE Gesamtklasse `trusted`, `secure` oder
 * `proven`.
 */
export const SIWE_VERIFICATION_RESULTS = [...SIWE_RESULTS, 'INVALID_SIGNATURE', 'INVALID_SIGNATURE_FORMAT'];

/**
 * Eine EOA-Signatur nach EIP-191 ist 65 Byte, also `0x` plus 130 Hexzeichen.
 * Alles andere wird gar nicht erst an die Bibliothek gereicht.
 */
const EOA_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/**
 * Prueft Felder UND Signatur an einer Stelle.
 *
 * AGENT-SEC-A4, 29.08.2026: die Handler kombinierten `checkSiweMessage` und
 * `verifyMessage` bisher jeder fuer sich. Drei Kopien derselben Reihenfolge
 * koennen auseinanderlaufen, und genau die Reihenfolge ist sicherheitsrelevant:
 * ohne bestandene Feldpruefung wird KEINE Signatur betrachtet.
 *
 * EOA SUPPORTED. ERC-1271 CONTRACT-WALLET VERIFICATION NOT IMPLEMENTED:
 * `verifyMessage` laeuft ohne Public Client, es gibt keine RPC- oder
 * Chainanbindung und ausdruecklich keinen Teil-Fallback.
 *
 * Der Rueckgabewert nennt die interne Ursache. Die Handler bilden sie nach
 * aussen auf eine einzige allgemeine Meldung ab.
 */
export async function verifyExpectedSiweSignature({ message, signature, expected, now = Date.now() }) {
	const field = checkSiweMessage(message, expected, now);
	if (field !== 'VALID') return field;
	if (typeof signature !== 'string' || !EOA_SIGNATURE.test(signature)) return 'INVALID_SIGNATURE_FORMAT';
	try {
		const valid = await verifyMessage({ address: expected.wallet, message, signature });
		return valid ? 'VALID' : 'INVALID_SIGNATURE';
	} catch {
		// Eine unbrauchbare Signatur darf niemals als Ausnahme nach aussen
		// gelangen und niemals als gueltig durchgehen.
		return 'INVALID_SIGNATURE_FORMAT';
	}
}

/** Erwartungsobjekt fuer den Dashboard-Login aus einer verifizierten Challenge. */
export function dashboardExpectation({ wallet, nonce, issuedAt, expiresAt, requestId }) {
	const { domain, uri } = siweOrigin();
	return {
		domain,
		uri,
		wallet,
		nonce,
		issuedAt,
		expiresAt,
		requestId,
		statement: DASHBOARD_STATEMENT,
		resource: `${uri}${DASHBOARD_RESOURCE_PATH}`
	};
}

/** Erwartungsobjekt fuer die Telegram-Verknuepfung aus dem Pending-Link. */
export function telegramExpectation({ wallet, nonce, issuedAt, expiresAt, code }) {
	const { domain, uri } = siweOrigin();
	return {
		domain,
		uri,
		wallet,
		nonce,
		issuedAt,
		expiresAt,
		requestId: telegramRequestId(code),
		statement: TELEGRAM_STATEMENT,
		resource: `${uri}${TELEGRAM_RESOURCE_PATH}`
	};
}
