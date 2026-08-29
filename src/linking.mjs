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
