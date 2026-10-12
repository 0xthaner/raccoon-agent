import { randomBytes } from 'node:crypto';
import { createDashboardAccess, createPendingLink, createTelegramHandoff } from './db.mjs';
import { telegramExpectation, telegramSiweMessage } from './siwe-auth.mjs';

export const LINK_LIFETIME_MS = 10 * 60 * 1000;

export async function newLinkRequest(chatId) {
	const code = randomBytes(18).toString('base64url');
	const nonce = randomBytes(16).toString('hex');
	const expiresAt = Date.now() + LINK_LIFETIME_MS;
	await createPendingLink({ code, chatId, nonce, expiresAt });
	return { code, expiresAt };
}

/*
	AUDIT-2026-10-12 F1: `pending_links` traegt neben den Verknuepfungen auch
	Dashboard-Zugangscodes (`dashboard:<code>`), gemerkte getrennte Wallets
	(`unlinked:...`) und Widerrufsmarken (`revoked:<wallet>` mit dem
	VORHERSAGBAREN Code `revoked_wallet_<wallet>`). Die Verknuepfungsendpunkte
	schlugen jeden Code nach, ohne die Art zu pruefen; eine Widerrufsmarke verriet
	so ohne Anmeldung, ob und wann sich eine fremde Wallet abgemeldet hatte.

	Deshalb zwei Schranken: nur das exakte Format aus newLinkRequest (18 Byte,
	base64url, also genau 24 Zeichen) erreicht ueberhaupt die Datenbank, und nur
	eine Zeile mit privater Telegram-Chat-ID (positive Ganzzahl) gilt als
	Verknuepfung.
*/
const TELEGRAM_LINK_CODE = /^[A-Za-z0-9_-]{24}$/;
const PRIVATE_CHAT_ID = /^[1-9][0-9]{0,19}$/;

export function isTelegramLinkCode(code) {
	return typeof code === 'string' && TELEGRAM_LINK_CODE.test(code);
}

export function isTelegramLinkRow(row) {
	return typeof row?.chat_id === 'string' && PRIVATE_CHAT_ID.test(row.chat_id);
}

export async function newTelegramHandoff(wallet) {
	const code = randomBytes(18).toString('base64url');
	const expiresAt = Date.now() + LINK_LIFETIME_MS;
	await createTelegramHandoff({ code, wallet, expiresAt });
	return { code, expiresAt };
}

export async function newDashboardAccess(wallet) {
	const code = randomBytes(24).toString('base64url');
	const expiresAt = Date.now() + 5 * 60 * 1000;
	await createDashboardAccess({ code, wallet, expiresAt });
	return { code, expiresAt };
}

/**
 * Der Signaturtext der Telegram-Verknuepfung, ERC-4361.
 *
 * AGENT-SEC-A3, 29.08.2026: ersetzt den fruehreren proprietaeren Klartext.
 * `issuedAt` wird aus der gespeicherten Ablaufzeit und der festen Lebensdauer
 * ABGELEITET, damit Aussteller und Verifizierer denselben Zeitpunkt ohne ein
 * zusaetzliches Datenbankfeld rekonstruieren. Die Request-ID haengt am
 * serverseitigen Pending-Link-Code, siehe `telegramRequestId`.
 *
 * Statement und Ressource unterscheiden sich vom Dashboard; eine Signatur des
 * einen Zwecks passt deshalb nie auf den anderen.
 */
export function signingMessage({ wallet, nonce, expiresAt, code }) {
	return telegramSiweMessage({
		wallet,
		nonce,
		issuedAt: Number(expiresAt) - LINK_LIFETIME_MS,
		expiresAt: Number(expiresAt),
		code
	});
}

/** Die trusted Erwartung zu genau diesem Pending-Link. */
export function linkSiweExpectation({ wallet, nonce, expiresAt, code }) {
	return telegramExpectation({
		wallet,
		nonce,
		issuedAt: Number(expiresAt) - LINK_LIFETIME_MS,
		expiresAt: Number(expiresAt),
		code
	});
}
