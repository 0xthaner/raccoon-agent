import { isAddress, verifyMessage } from 'viem';
import { getWalletCovers, renewalUrl } from '../src/covers.mjs';
import { createDashboardChallenge, createDashboardSession, dashboardMessage, verifyDashboardSession, verifyDashboardToken } from '../src/dashboard-auth.mjs';
import { beginTelegramDelivery, consumeDashboardAccess, consumeDashboardChallenge, finishTelegramDelivery, getLanguage, getWalletLinkByWallet, isDashboardSessionRevoked, recordAgentEvent, storeDashboardChallenge, unlinkWalletByWallet } from '../src/db.mjs';
import { createDemoRenewToken } from '../src/demo-renew.mjs';
import { newTelegramHandoff } from '../src/linking.mjs';
import { enforceRateLimit, requireJson, requireSameOrigin } from '../src/http-security.mjs';

const SESSION_COOKIE = '__Host-raccoon_dashboard';
const SESSION_COOKIE_OPTIONS = 'Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict';
const CLEAR_SESSION_COOKIES = [
	`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
	'raccoon_dashboard=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'
];

function cookieOf(request, name) {
	const cookies = request.headers.cookie?.split(';') ?? [];
	const match = cookies.map((item) => item.trim().split('=')).find(([key]) => key === name);
	if (!match) return null;
	try { return decodeURIComponent(match.slice(1).join('=')); } catch { return null; }
}

async function dashboardData(wallet) {
	const [result, telegramLink] = await Promise.all([getWalletCovers(wallet), getWalletLinkByWallet(wallet)]);
	const telegramHandoff = telegramLink ? null : await newTelegramHandoff(wallet);
	const covers = result.covers.map((cover) => ({
		coverId: cover.coverId, productId: cover.productId, productName: cover.productName,
		status: cover.status, amount: cover.amount, asset: cover.asset, endsAt: cover.endsAt,
		renewalUrl: cover.demo && telegramLink
			? `/demo-renew?token=${encodeURIComponent(createDemoRenewToken(telegramLink.chat_id))}`
			: renewalUrl(cover)
	}));
	return { ok: true, wallet: wallet.toLowerCase(), covers, telegramLinked: Boolean(telegramLink), telegramStartCode: telegramHandoff?.code ?? null, agentSettings: telegramLink ? { label: telegramLink.label, alertThresholds: telegramLink.alert_thresholds, weeklySummary: telegramLink.weekly_summary } : null, checkedAt: new Date().toISOString(), demoWallet: Boolean(result.demoWallet) };
}

function sessionIssuedAt(session) {
	return Number.isFinite(session?.iat) ? session.iat : session?.exp - 7 * 24 * 60 * 60_000;
}

async function notifyTelegramDisconnected(chatIds) {
	const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
	if (!token) return;
	await Promise.allSettled(chatIds.map(async (chatId) => {
		const language = await getLanguage(chatId) ?? 'de';
		const text = language === 'zh'
			? 'Telegram 通知已断开。你将不再收到提醒。\n\nTelegram 不允许机器人自动删除私人聊天。如需隐藏机器人，请在 Telegram 中删除聊天或屏蔽机器人。'
			: language === 'en'
				? 'Telegram notifications disconnected. You will no longer receive reminders.\n\nTelegram does not allow a bot to remove its private chat automatically. To hide it, delete the chat or block the bot in Telegram.'
				: 'Telegram-Benachrichtigungen wurden getrennt. Du erhältst keine weiteren Erinnerungen.\n\nTelegram erlaubt einem Bot nicht, den privaten Chat automatisch zu entfernen. Lösche den Chat oder blockiere den Bot in Telegram, wenn du ihn ausblenden möchtest.';
		const deliveryId = await beginTelegramDelivery(chatId, 'telegram_disconnected').catch(() => null);
		const result = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text })
		}).then((response) => response.json()).catch(() => null);
		if (deliveryId) await finishTelegramDelivery(deliveryId, result?.ok
			? { messageId: result.result?.message_id }
			: { errorCode: String(result?.error_code ?? 'NETWORK_ERROR'), errorMessage: result?.description ?? 'Telegram request failed.' }).catch(() => {});
	}));
}

export default async function handler(request, response) {
	response.setHeader('cache-control', 'no-store');
	if (request.method === 'GET') {
		if (!await enforceRateLimit(request, response, 'dashboard-read', 120, 600)) return;
		const access = typeof request.query.access === 'string' ? request.query.access : '';
		if (access) {
			const wallet = await consumeDashboardAccess(access);
			if (!wallet || !isAddress(wallet)) return response.status(410).json({ ok: false, error: 'Dieser Dashboard-Link ist ungültig oder abgelaufen.' });
			response.setHeader('set-cookie', `${SESSION_COOKIE}=${encodeURIComponent(createDashboardSession(wallet))}; ${SESSION_COOKIE_OPTIONS}`);
			await recordAgentEvent({ wallet, eventType: 'dashboard.access_link_consumed', source: 'dashboard' }).catch(() => {});
			return response.status(200).json(await dashboardData(wallet));
		}
		const wallet = typeof request.query.wallet === 'string' ? request.query.wallet : '';
		if (wallet) {
			if (!isAddress(wallet)) return response.status(400).json({ ok: false, error: 'Ungültige Wallet-Adresse.' });
			if (!await enforceRateLimit(request, response, 'dashboard-challenge', 20, 600)) return;
			const challenge = createDashboardChallenge(wallet);
			const verified = verifyDashboardToken(challenge.token);
			await storeDashboardChallenge({ nonce: verified.nonce, wallet: verified.wallet, expiresAt: verified.exp });
			return response.status(200).json({ ok: true, ...challenge });
		}
		const saved = verifyDashboardSession(cookieOf(request, SESSION_COOKIE) ?? cookieOf(request, 'raccoon_dashboard'));
		if (!saved) {
			response.setHeader('set-cookie', CLEAR_SESSION_COOKIES);
			return response.status(401).json({ ok: false, code: 'NO_SESSION', error: 'Keine aktive Dashboard-Sitzung.' });
		}
		if (await isDashboardSessionRevoked(saved.wallet, sessionIssuedAt(saved))) {
			response.setHeader('set-cookie', CLEAR_SESSION_COOKIES);
			return response.status(401).json({ ok: false, code: 'SESSION_REVOKED', error: 'Die Wallet-Verbindung wurde vollständig zurückgesetzt.' });
		}
		return response.status(200).json(await dashboardData(saved.wallet));
	}
	if (request.method === 'DELETE') {
		if (!requireSameOrigin(request, response)) return;
		if (!await enforceRateLimit(request, response, 'dashboard-delete', 10, 600)) return;
		const saved = verifyDashboardSession(cookieOf(request, SESSION_COOKIE) ?? cookieOf(request, 'raccoon_dashboard'));
		if (request.query.telegram === '1') {
			if (!saved || await isDashboardSessionRevoked(saved.wallet, sessionIssuedAt(saved))) return response.status(401).json({ ok: false, error: 'Keine aktive Dashboard-Sitzung.' });
			const removed = await unlinkWalletByWallet(saved.wallet);
			await recordAgentEvent({ wallet: saved.wallet, eventType: 'dashboard.telegram_disconnected', source: 'dashboard', metadata: { linkedChats: removed.length } }).catch(() => {});
			await notifyTelegramDisconnected(removed.map((row) => row.chat_id));
			return response.status(200).json({ ok: true, disconnected: removed.length > 0 });
		}
		response.setHeader('set-cookie', CLEAR_SESSION_COOKIES);
		if (saved?.wallet) await recordAgentEvent({ wallet: saved.wallet, eventType: 'dashboard.signed_out', source: 'dashboard' }).catch(() => {});
		return response.status(200).json({ ok: true });
	}
	if (request.method !== 'POST') return response.status(405).json({ ok: false, error: 'Method not allowed' });
	if (!requireSameOrigin(request, response) || !requireJson(request, response)) return;
	if (!await enforceRateLimit(request, response, 'dashboard-login', 10, 600)) return;
	const { wallet, token, signature } = request.body ?? {};
	const challenge = verifyDashboardToken(token);
	if (challenge?.type !== 'challenge' || !isAddress(wallet) || challenge.wallet !== wallet.toLowerCase() || typeof signature !== 'string') return response.status(401).json({ ok: false, error: 'Dashboard-Anmeldung ungültig oder abgelaufen.' });
	if (!await verifyMessage({ address: wallet, message: dashboardMessage(challenge, wallet), signature })) return response.status(401).json({ ok: false, error: 'Wallet-Signatur konnte nicht bestätigt werden.' });
	if (!await consumeDashboardChallenge(challenge.nonce, wallet)) return response.status(409).json({ ok: false, error: 'Diese Login-Anfrage wurde bereits verwendet.' });
	response.setHeader('set-cookie', `${SESSION_COOKIE}=${encodeURIComponent(createDashboardSession(wallet))}; ${SESSION_COOKIE_OPTIONS}`);
	await recordAgentEvent({ wallet, eventType: 'dashboard.wallet_authenticated', source: 'dashboard' }).catch(() => {});
	return response.status(200).json(await dashboardData(wallet));
}
