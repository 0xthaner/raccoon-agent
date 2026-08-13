import { isAddress, verifyMessage } from 'viem';
import { consumePendingLink, getPendingLink, getLanguage } from '../../src/db.mjs';
import { newDashboardAccess, signingMessage } from '../../src/linking.mjs';
import { createDashboardSession } from '../../src/dashboard-auth.mjs';
import { enforceRateLimit, requireJson, requireSameOrigin } from '../../src/http-security.mjs';

async function notifyLinked(chatId, wallet) {
	const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
	if (!token) throw new Error('Telegram ist nicht konfiguriert.');
	const language = await getLanguage(chatId) ?? 'de';
	const text = language === 'zh'
		? `一切设置完毕 🦝\n\n我现在会监控你的保障并及时提醒你。你可以随时在仪表板中查看保障、期限和设置。\n\n钱包：${wallet}`
		: language === 'en'
			? `Everything is set up 🦝\n\nI will now monitor your cover and notify you in time. You can view cover, expiry dates and settings in the dashboard at any time.\n\nWallet: ${wallet}`
			: `Alles eingerichtet 🦝\n\nIch überwache jetzt deine Covers und melde mich rechtzeitig. Im Dashboard kannst du Covers, Laufzeiten und Einstellungen jederzeit ansehen.\n\nWallet: ${wallet}`;
	const labels = language === 'zh'
		? ['打开仪表板', '我的保障']
		: language === 'en' ? ['Open dashboard', 'My covers'] : ['Dashboard öffnen', 'Meine Covers'];
	const appBaseUrl = (process.env.APP_BASE_URL?.trim() || '').replace(/\/$/, '');
	const dashboardAccess = appBaseUrl ? await newDashboardAccess(wallet) : null;
	const result = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, text, reply_markup: { inline_keyboard: [[
			...(dashboardAccess ? [{ text: labels[0], url: `${appBaseUrl}/?access=${encodeURIComponent(dashboardAccess.code)}` }] : []),
			{ text: labels[1], callback_data: 'show_covers' }
		]] } })
	});
	if (!result.ok) throw new Error('Telegram-Bestätigung fehlgeschlagen.');
}

export default async function handler(request, response) {
	response.setHeader('cache-control', 'no-store');
	if (request.method !== 'POST') return response.status(405).json({ ok: false, error: 'Method not allowed' });
	if (!requireSameOrigin(request, response) || !requireJson(request, response)) return;
	if (!await enforceRateLimit(request, response, 'wallet-link-verify', 10, 600)) return;
	const { code, wallet, signature } = request.body ?? {};
	const pending = typeof code === 'string' && await getPendingLink(code);
	if (!pending || pending.used_at || pending.expires_at < Date.now()) {
		return response.status(410).json({ ok: false, error: 'Verbindungscode ungültig oder abgelaufen.' });
	}
	if (!isAddress(wallet) || typeof signature !== 'string') {
		return response.status(400).json({ ok: false, error: 'Ungültige Signaturdaten.' });
	}
	const message = signingMessage({ wallet, nonce: pending.nonce, expiresAt: pending.expires_at });
	if (!await verifyMessage({ address: wallet, message, signature })) {
		return response.status(401).json({ ok: false, error: 'Signatur konnte nicht bestätigt werden.' });
	}
	const chatId = await consumePendingLink(code, wallet);
	if (!chatId) return response.status(409).json({ ok: false, error: 'Verbindungscode wurde bereits verwendet.' });
	await notifyLinked(chatId, wallet);
	response.setHeader('set-cookie', `__Host-raccoon_dashboard=${encodeURIComponent(createDashboardSession(wallet))}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict`);
	return response.status(200).json({ ok: true });
}
