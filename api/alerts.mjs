import { timingSafeEqual } from 'node:crypto';
import { checkExpiryAlerts } from '../src/alerts.mjs';
import { beginTelegramDelivery, finishTelegramDelivery } from '../src/db.mjs';

function authorized(header) {
	const expected = process.env.CRON_SECRET?.trim() ?? '';
	if (!expected || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
	const received = Buffer.from(header.slice(7));
	const wanted = Buffer.from(expected);
	return received.length === wanted.length && timingSafeEqual(received, wanted);
}

async function sendMessage(chatId, text, options = {}) {
	const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
	if (!token) throw new Error('Telegram ist nicht konfiguriert.');
	const { _messageKind = 'scheduled_alert', ...telegramOptions } = options;
	const deliveryId = await beginTelegramDelivery(chatId, _messageKind).catch(() => null);
	const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true, ...telegramOptions })
	});
	const result = await response.json().catch(() => null);
	if (!response.ok || !result?.ok) {
		if (deliveryId) await finishTelegramDelivery(deliveryId, { errorCode: String(result?.error_code ?? response.status), errorMessage: result?.description ?? `HTTP ${response.status}` }).catch(() => {});
		throw new Error(`Telegram-Versand fehlgeschlagen: ${result?.description ?? response.status}`);
	}
	if (deliveryId) await finishTelegramDelivery(deliveryId, { messageId: result.result?.message_id }).catch(() => {});
	return result.result;
}

export default async function handler(request, response) {
	if (request.method !== 'GET') return response.status(405).json({ ok: false });
	if (!authorized(request.headers.authorization)) return response.status(401).json({ ok: false });
	const dashboardUrl = (process.env.APP_BASE_URL?.trim() || '').replace(/\/$/, '');
	const result = await checkExpiryAlerts({ sendMessage, dashboardUrl });
	return response.status(200).json({ ok: true, ...result });
}
