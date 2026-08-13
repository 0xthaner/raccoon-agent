import { beginTelegramDelivery, finishTelegramDelivery, getLanguage, getMonitoredWallets, recordAgentEvent } from '../src/db.mjs';
import { demoRenewal, verifyDemoRenewToken } from '../src/demo-renew.mjs';
import { enforceRateLimit, requireJson, requireSameOrigin } from '../src/http-security.mjs';

async function notify(chatId, language) {
	const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
	if (!token) throw new Error('Telegram ist nicht konfiguriert.');
	const text = language === 'en'
		? `Renewal demo completed\n\nThis is how a successful renewal would look:\nAave v3 · Cover #424242\nCover amount: 15,000 USDC\nNew expiry: 27 August 2027\n\nSimulation only · no payment or transaction`
		: language === 'zh'
			? `续保演示已完成\n\n成功续保将显示如下：\nAave v3 · 保障 #424242\n保障金额：15,000 USDC\n新到期日：2027年8月27日\n\n仅为模拟 · 无付款或交易`
			: `Verlängerungsdemo abgeschlossen\n\nSo würde eine erfolgreiche Verlängerung aussehen:\nAave v3 · Cover #424242\nVersicherungssumme: 15.000 USDC\nNeuer Ablauf: 27. August 2027\n\nNur Simulation · keine Zahlung und keine Transaktion`;
	const result = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, text })
	});
	if (!result.ok) throw new Error('Telegram-Bestätigung fehlgeschlagen.');
}

export default async function handler(request, response) {
	response.setHeader('cache-control', 'no-store');
	if (request.method === 'GET' && request.query.preview === '1') {
		return response.status(200).json({ ok: true, preview: true, renewal: demoRenewal });
	}
	const token = request.method === 'GET' ? request.query.token : request.body?.token;
	const session = verifyDemoRenewToken(token);
	if (!session) return response.status(401).json({ ok: false, error: 'Checkout-Link ungültig oder abgelaufen.' });
	const wallets = await getMonitoredWallets(session.chatId);
	if (!wallets.some((wallet) => wallet.wallet?.toLowerCase() === demoRenewal.wallet)) return response.status(403).json({ ok: false, error: 'Dieser Checkout gehört nicht zu deiner Wallet.' });
	if (request.method === 'GET') return response.status(200).json({ ok: true, renewal: demoRenewal });
	if (request.method !== 'POST') return response.status(405).json({ ok: false, error: 'Method not allowed' });
	if (!requireSameOrigin(request, response) || !requireJson(request, response)) return;
	if (!await enforceRateLimit(request, response, 'demo-renew', 10, 600)) return;
	if (String(request.body?.wallet ?? '').toLowerCase() !== demoRenewal.wallet) return response.status(403).json({ ok: false, error: 'Verbinde die Owner-Wallet dieses Covers.' });
	const deliveryId = await beginTelegramDelivery(session.chatId, 'demo_renewal_completed').catch(() => null);
	try {
		await notify(session.chatId, await getLanguage(session.chatId) ?? 'de');
		if (deliveryId) await finishTelegramDelivery(deliveryId).catch(() => {});
	} catch (error) {
		if (deliveryId) await finishTelegramDelivery(deliveryId, { errorCode: 'TELEGRAM_SEND_FAILED', errorMessage: error.message }).catch(() => {});
		throw error;
	}
	await recordAgentEvent({ chatId: session.chatId, wallet: demoRenewal.wallet, eventType: 'renewal.demo_completed', source: 'dashboard', coverId: demoRenewal.coverId }).catch(() => {});
	return response.status(200).json({ ok: true, newExpiry: demoRenewal.newExpiry });
}
