import { isAddress } from 'viem';
import { getWalletCovers } from '../src/covers.mjs';
import { CLEAR_SESSION_COOKIES, createDashboardChallenge, dashboardMessage, dashboardSiweExpectation, readSessionCookie, resolveLogout, sessionCookieHeader, verifyDashboardSession, verifyDashboardToken } from '../src/dashboard-auth.mjs';
import { verifyExpectedSiweSignature } from '../src/siwe-auth.mjs';
import { beginTelegramDelivery, consumeDashboardAccess, consumeDashboardChallenge, finishTelegramDelivery, getLanguage, getWalletLinkStateByWallet, isDashboardSessionRevoked, recordAgentEvent, revokeDashboardSessions, storeDashboardChallenge, unlinkWalletByWallet } from '../src/db.mjs';
import { newTelegramHandoff } from '../src/linking.mjs';
import { ANMELDUNG_PAUSIERT, pauseAntwort } from '../src/pause.mjs';
import { enforceRateLimit, requireJson, requireSameOrigin } from '../src/http-security.mjs';
import { recordSecurityEvent, securityFingerprint, SECURITY_EVENT } from '../src/security-events.mjs';

async function dashboardData(wallet) {
	const [result, telegramState] = await Promise.all([getWalletCovers(wallet), getWalletLinkStateByWallet(wallet)]);
	const telegramLink = telegramState.link;
	const telegramHandoff = telegramState.linked ? null : await newTelegramHandoff(wallet);
	const covers = result.covers.map((cover) => ({
		coverId: cover.coverId, productId: cover.productId, productName: cover.productName,
		status: cover.status, amount: cover.amount, asset: cover.asset, endsAt: cover.endsAt
	}));
	return { ok: true, wallet: wallet.toLowerCase(), covers, telegramLinked: telegramState.linked, telegramStartCode: telegramHandoff?.code ?? null, agentSettings: telegramLink ? { label: telegramLink.label, alertThresholds: telegramLink.alert_thresholds, weeklySummary: telegramLink.weekly_summary } : null, checkedAt: new Date().toISOString(), demoWallet: Boolean(result.demoWallet) };
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
		if (access && ANMELDUNG_PAUSIERT) return pauseAntwort(response);
		if (access) {
			// AGENT-AUTH-002, 05.10.2026: GET darf den Einmal-Zugangscode NICHT mehr
			// konsumieren. Zustandsaenderung (used_at) gehoert nicht in ein GET. Das
			// Einloesen laeuft jetzt ausschliesslich ueber POST (same-origin, JSON);
			// dieser Zweig bleibt READ-ONLY, fasst die Datenbank nicht an und weist
			// nur den Weg. Der frueher hier liegende Verbrauch (AGENT-SEC-A2) war
			// durch den unerratbaren Code gedeckt, blieb aber ein
			// zustandsaendernder GET.
			return response.status(405).json({ ok: false, code: 'ACCESS_REDEEM_VIA_POST', error: 'Diesen Dashboard-Link bitte über die Seite öffnen.' });
		}
		const wallet = typeof request.query.wallet === 'string' ? request.query.wallet : '';
		if (wallet && ANMELDUNG_PAUSIERT) return pauseAntwort(response);
		if (wallet) {
			if (!isAddress(wallet)) return response.status(400).json({ ok: false, error: 'Ungültige Wallet-Adresse.' });
			if (!await enforceRateLimit(request, response, 'dashboard-challenge', 20, 600)) return;
			const challenge = createDashboardChallenge(wallet);
			const verified = verifyDashboardToken(challenge.token);
			await storeDashboardChallenge({ nonce: verified.nonce, wallet: verified.wallet, expiresAt: verified.exp });
			return response.status(200).json({ ok: true, ...challenge });
		}
		const saved = verifyDashboardSession(readSessionCookie(request));
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
		const saved = verifyDashboardSession(readSessionCookie(request));
		if (request.query.telegram === '1') {
			if (!saved || await isDashboardSessionRevoked(saved.wallet, sessionIssuedAt(saved))) return response.status(401).json({ ok: false, error: 'Keine aktive Dashboard-Sitzung.' });
			const removed = await unlinkWalletByWallet(saved.wallet);
			await recordAgentEvent({ wallet: saved.wallet, eventType: 'dashboard.telegram_disconnected', source: 'dashboard', metadata: { linkedChats: removed.length } }).catch(() => {});
			await notifyTelegramDisconnected(removed.map((row) => row.chat_id));
			return response.status(200).json({ ok: true, disconnected: removed.length > 0 });
		}
		// AGENT-SEC-A1, 29.08.2026: der Logout loeschte bis dahin nur Browsercookies.
		// Eine abgegriffene Session blieb damit sieben Tage gueltig. Jetzt wird sie
		// serverseitig widerrufen. Die Cookies verschwinden in JEDEM Fall, auch
		// wenn der Widerruf scheitert; gemeldet wird der Erfolg aber erst danach.
		response.setHeader('set-cookie', CLEAR_SESSION_COOKIES);
		const logout = await resolveLogout({
			session: saved,
			revoke: revokeDashboardSessions,
			audit: (wallet) => recordAgentEvent({ wallet, eventType: 'dashboard.signed_out', source: 'dashboard' }).catch(() => {})
		});
		return response.status(logout.status).json(logout.body);
	}
	if (request.method !== 'POST') return response.status(405).json({ ok: false, error: 'Method not allowed' });
	if (!requireSameOrigin(request, response) || !requireJson(request, response)) return;
	if (ANMELDUNG_PAUSIERT) return pauseAntwort(response);
	const body = request.body ?? {};
	// AGENT-AUTH-002, 05.10.2026: der Telegram-Zugangscode wird NUR hier per POST
	// eingeloest - Same-Origin und JSON sind oben bereits erzwungen. Der Verbrauch
	// bleibt atomar (consumeDashboardAccess, bedingtes Update, Erfolg nur bei genau
	// einer Zeile), also weiterhin single-use. Es entsteht KEINE Session und kein
	// Cookie: zurueck kommt nur die erwartete Wallet, der Login braucht weiter die
	// Signatur. Fail closed: ein nicht aufloesbarer Code endet in genau einem Code.
	if (typeof body.access === 'string' && body.access && body.token === undefined && body.signature === undefined) {
		if (!await enforceRateLimit(request, response, 'dashboard-access', 20, 600)) return;
		const wallet = await consumeDashboardAccess(body.access);
		if (!wallet || !isAddress(wallet)) {
			await recordSecurityEvent(SECURITY_EVENT.ACCESS_CODE_INVALID, { source: 'dashboard', fingerprint: securityFingerprint(body.access) });
			return response.status(410).json({ ok: false, code: 'ACCESS_CODE_INVALID', error: 'Dieser Dashboard-Link ist ungültig oder abgelaufen.' });
		}
		await recordAgentEvent({ wallet, eventType: 'dashboard.access_link_consumed', source: 'dashboard' }).catch(() => {});
		return response.status(200).json({ ok: false, code: 'WALLET_SIGNATURE_REQUIRED', wallet: wallet.toLowerCase() });
	}
	if (!await enforceRateLimit(request, response, 'dashboard-login', 10, 600)) return;
	const { wallet, token, signature } = body;
	const challenge = verifyDashboardToken(token);
	if (challenge?.type !== 'challenge' || !isAddress(wallet) || challenge.wallet !== wallet.toLowerCase() || typeof signature !== 'string') return response.status(401).json({ ok: false, error: 'Dashboard-Anmeldung ungültig oder abgelaufen.' });
	// AGENT-SEC-A3/A4: der SIWE-Text wird serverseitig aus der verifizierten
	// Challenge rekonstruiert; Felder und Signatur prueft die eine gemeinsame
	// Grenze. Die interne Ursache bleibt dort, nach aussen geht eine stabile,
	// allgemeine Meldung.
	const message = dashboardMessage(challenge, wallet);
	const verified = await verifyExpectedSiweSignature({
		message,
		signature,
		expected: dashboardSiweExpectation(challenge, wallet)
	});
	if (verified !== 'VALID') {
		await recordSecurityEvent(SECURITY_EVENT.SIWE_SIGNATURE_INVALID, { source: 'dashboard', fingerprint: securityFingerprint(wallet) });
		return response.status(401).json({ ok: false, error: 'Wallet-Signatur konnte nicht bestätigt werden.' });
	}
	if (!await consumeDashboardChallenge(challenge.nonce, wallet)) {
		await recordSecurityEvent(SECURITY_EVENT.SIWE_REPLAY_BLOCKED, { source: 'dashboard', fingerprint: securityFingerprint(wallet) });
		return response.status(409).json({ ok: false, error: 'Diese Login-Anfrage wurde bereits verwendet.' });
	}
	response.setHeader('set-cookie', sessionCookieHeader(wallet));
	await recordAgentEvent({ wallet, eventType: 'dashboard.wallet_authenticated', source: 'dashboard' }).catch(() => {});
	return response.status(200).json(await dashboardData(wallet));
}
