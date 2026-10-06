import { isAddress } from 'viem';
import { getWalletCovers } from '../src/covers.mjs';
import { CLEAR_SESSION_COOKIES, createDashboardChallenge, createDashboardSession, DASHBOARD_CHALLENGE_TTL_CONTRACT_MS, DASHBOARD_CHALLENGE_TTL_EOA_MS, dashboardMessage, dashboardSiweExpectation, resolveDashboardSession, resolveLogout, sessionCookieHeader, verifyDashboardToken } from '../src/dashboard-auth.mjs';
import { verifyWalletSiweSignature } from '../src/contract-signature.mjs';
import { isDeployedContract } from '../src/contract-detect.mjs';
import { beginTelegramDelivery, consumeDashboardAccess, consumeDashboardChallenge, finishTelegramDelivery, getLanguage, getWalletLinkStateByWallet, isDashboardSessionRevoked, recordAgentEvent, revokeDashboardSessions, storeDashboardChallenge, unlinkWalletByWallet } from '../src/db.mjs';
import { ANMELDUNG_PAUSIERT, pauseAntwort } from '../src/pause.mjs';
import { enforceRateLimit, enforceRateLimitFor, requireJson, requireSameOrigin } from '../src/http-security.mjs';
import { recordSecurityEvent, securityFingerprint, SECURITY_EVENT } from '../src/security-events.mjs';

async function dashboardData(wallet) {
	const [result, telegramState] = await Promise.all([getWalletCovers(wallet), getWalletLinkStateByWallet(wallet)]);
	const telegramLink = telegramState.link;
	const covers = result.covers.map((cover) => ({
		coverId: cover.coverId, productId: cover.productId, productName: cover.productName,
		status: cover.status, amount: cover.amount, asset: cover.asset, endsAt: cover.endsAt
	}));
	return { ok: true, wallet: wallet.toLowerCase(), covers, telegramLinked: telegramState.linked, telegramStartCode: null, agentSettings: telegramLink ? { label: telegramLink.label, alertThresholds: telegramLink.alert_thresholds, weeklySummary: telegramLink.weekly_summary } : null, checkedAt: new Date().toISOString(), demoWallet: Boolean(result.demoWallet) };
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
			// AGENT-HARD-001: zusaetzliche Schranke pro Wallet (nur gueltige Adressen
			// erreichen sie), BEVOR getCode (Alchemy) oder der DB-Insert laufen. Die
			// IP-Schranke oben allein laesst IP-/IPv6-Rotation gegen EINE Wallet durch.
			if (!await enforceRateLimitFor(response, 'dashboard-challenge-wallet', wallet.toLowerCase(), 10, 600)) return;
			// AGENT-HARD-003: globales Abuse-Budget NACH den engeren IP-/Wallet-Schranken,
			// damit eine einzelne IP/Wallet das geteilte Budget nicht aufbraucht. Konstanter
			// Diskriminator ('all'), kein Angreifer-Input. Greift VOR getCode (Alchemy) und
			// dem Challenge-Insert und deckelt so die aggregierte Last verteilter Angreifer.
			if (!await enforceRateLimitFor(response, 'dashboard-challenge-global', 'all', 600, 600)) return;
			// AGENT-SAFE-1: deployte Contract-Wallets (Safe-Multisig) bekommen ein
			// laengeres Challenge-Fenster, weil mehrere Owner asynchron bestaetigen.
			// Der SERVER entscheidet ueber Mainnet-getCode; der Client sendet nie
			// multisig/contract/ttl. Faellt die Erkennung aus (kein Schluessel, RPC-
			// Fehler): fail closed auf die kurze EOA-TTL.
			let ttlMs = DASHBOARD_CHALLENGE_TTL_EOA_MS;
			try {
				if (await isDeployedContract(wallet)) ttlMs = DASHBOARD_CHALLENGE_TTL_CONTRACT_MS;
			} catch { /* fail closed: kurze EOA-TTL */ }
			const challenge = createDashboardChallenge(wallet, Date.now(), ttlMs);
			const verified = verifyDashboardToken(challenge.token);
			await storeDashboardChallenge({ nonce: verified.nonce, wallet: verified.wallet, expiresAt: verified.exp });
			return response.status(200).json({ ok: true, ...challenge });
		}
		// AGENT-SAFE-2: Session aus Cookie (normaler Browser) ODER Bearer (Safe-App
		// iframe). Beide gueltig und verschiedene Wallets -> fail closed.
		const resolved = resolveDashboardSession(request);
		if (resolved.conflict) {
			response.setHeader('set-cookie', CLEAR_SESSION_COOKIES);
			return response.status(401).json({ ok: false, code: 'NO_SESSION', error: 'Keine aktive Dashboard-Sitzung.' });
		}
		const saved = resolved.session;
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
		const resolvedDelete = resolveDashboardSession(request);
		const saved = resolvedDelete.conflict ? null : resolvedDelete.session;
		if (request.query.telegram === '1') {
			if (!saved || await isDashboardSessionRevoked(saved.wallet, sessionIssuedAt(saved))) return response.status(401).json({ ok: false, error: 'Keine aktive Dashboard-Sitzung.' });
			const removed = await unlinkWalletByWallet(saved.wallet);
			await recordAgentEvent({ wallet: saved.wallet, eventType: 'dashboard.telegram_disconnected', source: 'dashboard', metadata: { linkedChats: removed.length } }).catch(() => {});
			await notifyTelegramDisconnected(removed.map((row) => row.chat_id));
			return response.status(200).json({ ok: true, disconnected: removed.length > 0 });
		}
		// HARD-004: already-revoked credentials cannot revoke newer sessions.
		// A request that passed this check can overlap another revoke (in-flight boundary).
		if (saved) {
			try {
				if (await isDashboardSessionRevoked(saved.wallet, sessionIssuedAt(saved))) {
					response.setHeader('set-cookie', CLEAR_SESSION_COOKIES);
					return response.status(200).json({ ok: true });
				}
			} catch {
				return response.status(503).json({ ok: false, error: 'Abmeldung konnte nicht abgeschlossen werden.' });
			}
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
	// AGENT-HARD-001: per-Wallet-Schranke NACH der billigen Strukturpruefung (nur
	// gueltige Adressen, challenge-gebunden) und VOR der teuren Signatur-/ERC-1271-
	// Verifikation (Alchemy). Malformed Strings erreichen den Wallet-Key nie.
	if (!await enforceRateLimitFor(response, 'dashboard-login-wallet', wallet.toLowerCase(), 10, 600)) return;
	// AGENT-HARD-003: globales Login-Budget NACH der billigen Struktur-/Wallet-Pruefung
	// (gefaelschte Tokens fallen schon oben bei 401 durch, ohne Budget zu ziehen) und VOR
	// der teuren Signatur-/ERC-1271-Verifikation, dem Nonce-Consume und der Session-Ausgabe.
	// Konstanter Diskriminator ('all'), kein Angreifer-Input.
	if (!await enforceRateLimitFor(response, 'dashboard-login-global', 'all', 200, 600)) return;
	// AGENT-SEC-A3/A4: der SIWE-Text wird serverseitig aus der verifizierten
	// Challenge rekonstruiert; Felder und Signatur prueft die eine gemeinsame
	// Grenze. Die interne Ursache bleibt dort, nach aussen geht eine stabile,
	// allgemeine Meldung.
	const message = dashboardMessage(challenge, wallet);
	// EOA (offline) oder deployte Contract-Wallet (ERC-1271, Chain-Read). Reihenfolge
	// und Felder unveraendert; der Contract-Pfad greift nur nach bestandener
	// Feldpruefung. Die Nonce wird erst NACH erfolgreicher Signaturpruefung konsumiert.
	const verified = await verifyWalletSiweSignature({
		message,
		signature,
		expected: dashboardSiweExpectation(challenge, wallet)
	});
	if (verified !== 'VALID') {
		// RPC-Ausfall (Contract-Status nicht feststellbar) ist kein Angriffssignal.
		if (verified !== 'RPC_UNAVAILABLE') {
			await recordSecurityEvent(SECURITY_EVENT.SIWE_SIGNATURE_INVALID, { source: 'dashboard', fingerprint: securityFingerprint(wallet) });
		}
		return response.status(401).json({ ok: false, error: 'Wallet-Signatur konnte nicht bestätigt werden.' });
	}
	if (!await consumeDashboardChallenge(challenge.nonce, wallet)) {
		await recordSecurityEvent(SECURITY_EVENT.SIWE_REPLAY_BLOCKED, { source: 'dashboard', fingerprint: securityFingerprint(wallet) });
		return response.status(409).json({ ok: false, error: 'Diese Login-Anfrage wurde bereits verwendet.' });
	}
	response.setHeader('set-cookie', sessionCookieHeader(wallet));
	await recordAgentEvent({ wallet, eventType: 'dashboard.wallet_authenticated', source: 'dashboard' }).catch(() => {});
	const data = await dashboardData(wallet);
	// AGENT-SAFE-3: Safe-App-Pfad (eingebettetes iframe) kann das __Host-Cookie
	// nicht zuverlaessig setzen. NUR wenn der Client den Bearer-Transport
	// ausdruecklich anfordert, liegt zusaetzlich das bestehende signierte
	// Session-Token im Body (gleiche type=session/wallet/iat/exp/HMAC/7-Tage/
	// Revoke-Semantik). Das Flag steuert NUR den Transport, nie Identity,
	// Signatur, Chain, Nonce oder ERC-1271. Normaler Browser bekommt es nie.
	if (String(request.headers['x-dashboard-transport'] ?? '').toLowerCase() === 'bearer') {
		data.sessionToken = createDashboardSession(wallet);
	}
	return response.status(200).json(data);
}
