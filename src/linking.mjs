import { randomBytes } from 'node:crypto';
import { createDashboardAccess, createPendingLink, createTelegramHandoff } from './db.mjs';

const LINK_LIFETIME_MS = 10 * 60 * 1000;

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

export function signingMessage({ wallet, nonce, expiresAt }) {
	return [
		'Raccoon Agent Wallet-Verknüpfung',
		'',
		`Wallet: ${wallet}`,
		'Zweck: Telegram-Ablaufwarnungen für diese Wallet einrichten.',
		`Nonce: ${nonce}`,
		`Gültig bis: ${new Date(expiresAt).toISOString()}`,
		'',
		'Dies ist keine Transaktion und erlaubt keinen Zugriff auf Geld.'
	].join('\n');
}
