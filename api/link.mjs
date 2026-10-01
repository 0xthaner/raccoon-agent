import { isAddress } from 'viem';
import { getPendingLink } from '../src/db.mjs';
import { signingMessage } from '../src/linking.mjs';
import { enforceRateLimit } from '../src/http-security.mjs';
import { ANMELDUNG_PAUSIERT, pauseAntwort } from '../src/pause.mjs';

async function telegramAccount(chatId) {
	const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
	if (!token || !/^\d{1,20}$/.test(String(chatId))) return null;
	try {
		const result = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`, { signal: AbortSignal.timeout(4_000) })
			.then((r) => r.json());
		if (!result?.ok || result.result?.type !== 'private') return null;
		const chat = result.result;
		const username = typeof chat.username === 'string' && /^[A-Za-z0-9_]{5,32}$/.test(chat.username) ? chat.username : null;
		const name = [chat.first_name, chat.last_name].filter((t) => typeof t === 'string').join(' ').slice(0, 64) || null;
		return username || name ? { username, name } : null;
	} catch {
		return null;
	}
}

export default async function handler(request, response) {
	response.setHeader('cache-control', 'no-store');
	if (request.method !== 'GET') return response.status(405).json({ ok: false, error: 'Method not allowed' });
	if (ANMELDUNG_PAUSIERT) return pauseAntwort(response);
	if (!await enforceRateLimit(request, response, 'wallet-link-read', 30, 600)) return;
	const code = typeof request.query.code === 'string' ? request.query.code : '';
	const wallet = typeof request.query.wallet === 'string' ? request.query.wallet : '';
	const pending = code && await getPendingLink(code);
	if (!pending || pending.used_at || pending.expires_at < Date.now()) {
		return response.status(410).json({ ok: false, error: 'Verbindungscode ungültig oder abgelaufen.' });
	}
	/*
		Ohne Wallet: nur sagen, MIT WELCHEM Telegram-Konto verknuepft wird.
		Sonst kann jemand einem anderen seinen eigenen Verknuepfungslink schicken
		("bitte kurz bestaetigen"), und dessen Wallet haengt danach an fremdem
		Chat. Der Name kommt live von Telegram und wird nicht gespeichert.
	*/
	if (!wallet) {
		return response.status(200).json({ ok: true, telegram: await telegramAccount(pending.chat_id) });
	}
	if (!isAddress(wallet)) return response.status(400).json({ ok: false, error: 'Ungültige Wallet-Adresse.' });
	return response.status(200).json({
		ok: true,
		message: signingMessage({ wallet, nonce: pending.nonce, expiresAt: pending.expires_at, code })
	});
}
