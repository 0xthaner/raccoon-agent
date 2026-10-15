import { isAddress } from 'viem';
import { getWalletCovers } from '../src/covers.mjs';
import { actionMessage, actionSiweExpectation, CLEAR_SESSION_COOKIES, createActionChallenge, createDashboardChallenge, createDashboardSession, DASHBOARD_CHALLENGE_TTL_CONTRACT_MS, DASHBOARD_CHALLENGE_TTL_EOA_MS, dashboardMessage, dashboardSiweExpectation, resolveDashboardSession, resolveLogout, sessionCookieHeader, verifyActionChallenge, verifyDashboardToken } from '../src/dashboard-auth.mjs';
import { noContractCodeByQuorum, verifyOnchainDashboardLoginApproval, verifyWalletSiweAuthority } from '../src/contract-signature.mjs';
import { isDeployedContract } from '../src/contract-detect.mjs';
import { beginTelegramDelivery, consumeDashboardAccess, consumeDashboardChallenge, finishTelegramDelivery, getLanguage, isDashboardChallengeOpen, getWalletLinkStateByWallet, isDashboardSessionRevoked, recordAgentEvent, revokeDashboardSessions, storeDashboardChallenge, unlinkWalletByWallet, unlinkWalletFromAllChats } from '../src/db.mjs';
import { ANMELDUNG_PAUSIERT, pauseAntwort } from '../src/pause.mjs';
import { enforceRateLimit, enforceRateLimitFor, requireJson, requireSameOrigin } from '../src/http-security.mjs';
import { recordSecurityEvent, securityFingerprint, SECURITY_EVENT } from '../src/security-events.mjs';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';

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

/*
	AUDIT SA-L1, 14.10.2026: destruktive Aktionen einer Contract-Wallet (Safe)
	brauchen eine FRISCHE Bestaetigung - eine 24-h-Sitzung allein genuegt nicht,
	denn ihr Owner kann inzwischen entfernt worden sein. Betroffen sind nur
	"Telegram trennen" und "ueberall abmelden"; Lesen bleibt unveraendert.

	Ob eine Bestaetigung noetig ist, entscheidet der Server: aus der HMAC-
	geschuetzten Sitzungsart, bei alten Tokens ohne Art per getCode. Faellt
	getCode aus, wird sie verlangt (fail closed). EOA-Sitzungen bleiben wie bisher.
*/
async function freshAuthorityRequired(session) {
	if (session.kind === 'eoa') return false;
	if (session.kind === 'contract') return true;
	// Ohne Bestaetigung nur, wenn BEIDE Provider keinen Code melden; jeder Zweifel -> noetig.
	try { return !await noContractCodeByQuorum(session.wallet); } catch { return true; }
}

/**
 * Prueft die frische Bestaetigung `{ token, signature }` fuer genau diesen Zweck
 * und genau diese Sitzungs-Wallet und verbraucht ihre Nonce atomar. Schreibt bei
 * jedem Fehlschlag die Antwort selbst und liefert dann false.
 */
async function verifyFreshAuthority(request, response, wallet, purpose) {
	const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {};
	const challenge = verifyActionChallenge(body.token, purpose);
	if (!challenge || challenge.wallet !== wallet.toLowerCase() || typeof body.signature !== 'string') {
		response.status(403).json({ ok: false, code: 'FRESH_SIGNATURE_REQUIRED', error: 'Diese Aktion braucht eine frische Bestätigung deiner Wallet.' });
		return false;
	}
	if (!await enforceRateLimitFor(response, 'dashboard-action-verify', wallet.toLowerCase(), 10, 600)) return false;
	// META-AUDIT M-2: globales Budget (konstanter Schluessel 'all') VOR der Dual-RPC-
	// ERC-1271-Pruefung. Je Wallet und je IP allein liesse sich mit vielen eigenen
	// Contract-Wallets und IPs beliebig oft pruefen lassen. Wie der Login.
	if (!await enforceRateLimitFor(response, 'dashboard-action-verify-global', 'all', 100, 600)) return false;
	const verified = await verifyWalletSiweAuthority({ message: actionMessage(challenge), signature: body.signature, expected: actionSiweExpectation(challenge) });
	if (verified.result === 'RPC_UNAVAILABLE') {
		response.status(503).json({ ok: false, code: 'SIGNATURE_CHECK_UNAVAILABLE', error: 'Die Bestätigung konnte gerade nicht geprüft werden. Bitte gleich erneut versuchen.' });
		return false;
	}
	if (verified.result !== 'VALID') {
		await recordSecurityEvent(verified.result === 'RPC_DISAGREEMENT' ? SECURITY_EVENT.ERC1271_RPC_DISAGREEMENT : SECURITY_EVENT.SIWE_SIGNATURE_INVALID, { source: 'dashboard', fingerprint: securityFingerprint(wallet) });
		response.status(401).json({ ok: false, code: 'FRESH_SIGNATURE_INVALID', error: 'Die Bestätigung konnte nicht geprüft werden.' });
		return false;
	}
	if (!await consumeDashboardChallenge(challenge.nonce, wallet)) {
		await recordSecurityEvent(SECURITY_EVENT.SIWE_REPLAY_BLOCKED, { source: 'dashboard', fingerprint: securityFingerprint(wallet) });
		response.status(409).json({ ok: false, code: 'FRESH_SIGNATURE_USED', error: 'Diese Bestätigung wurde bereits verwendet oder ist abgelaufen.' });
		return false;
	}
	return true;
}

/** Ein JSON-Body bei DELETE ist optional; ist er da, gelten dieselben Grenzen wie sonst. */
function optionalJson(request, response) {
	return request.headers['content-type'] ? requireJson(request, response) : true;
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
		const query = queryParams(request);
		const access = singleQueryValue(query, 'access');
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
		const wallet = singleQueryValue(query, 'wallet');
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
		let revoked;
		try {
			revoked = await isDashboardSessionRevoked(saved.wallet, sessionIssuedAt(saved));
		} catch {
			// AUDIT SA-L2: Widerruf nicht pruefbar -> keine Daten (fail closed), kein Absturz.
			return response.status(503).json({ ok: false, code: 'SESSION_CHECK_UNAVAILABLE', error: 'Sitzung konnte gerade nicht geprüft werden.' });
		}
		if (revoked) {
			response.setHeader('set-cookie', CLEAR_SESSION_COOKIES);
			return response.status(401).json({ ok: false, code: 'SESSION_REVOKED', error: 'Die Wallet-Verbindung wurde vollständig zurückgesetzt.' });
		}
		return response.status(200).json(await dashboardData(saved.wallet));
	}
	if (request.method === 'DELETE') {
		if (!requireSameOrigin(request, response) || !optionalJson(request, response)) return;
		if (!await enforceRateLimit(request, response, 'dashboard-delete', 10, 600)) return;
		const resolvedDelete = resolveDashboardSession(request);
		const saved = resolvedDelete.conflict ? null : resolvedDelete.session;
		if (singleQueryValue(queryParams(request), 'telegram') === '1') {
			if (!saved || await isDashboardSessionRevoked(saved.wallet, sessionIssuedAt(saved))) return response.status(401).json({ ok: false, error: 'Keine aktive Dashboard-Sitzung.' });
			// AUDIT SA-L1: Contract-Wallet -> nur mit frischer Bestaetigung fuer genau "telegram-disconnect".
			const contractAuthority = await freshAuthorityRequired(saved);
			if (contractAuthority && !await verifyFreshAuthority(request, response, saved.wallet, 'telegram-disconnect')) return;
			// META-AUDIT M-1: mit AKTUELLER, frisch bestaetigter Contract-Befugnis werden ALLE
			// Telegram-Chats dieser Wallet getrennt - auch ein veralteter Chat eines entfernten
			// Owners. EOA unveraendert (nur bei genau einem Chat, sonst im jeweiligen Chat).
			const removed = contractAuthority ? await unlinkWalletFromAllChats(saved.wallet) : await unlinkWalletByWallet(saved.wallet);
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
		// AUDIT SA-L1: Contract-Wallet -> der wallet-weite Widerruf braucht eine frische
		// Bestaetigung fuer genau "session-revoke". Ohne sie wird nur DIESES Geraet
		// abgemeldet (Cookie weg), niemand sonst. Eine mitgeschickte, aber ungueltige
		// Bestaetigung aendert nichts und wird gemeldet.
		if (saved && await freshAuthorityRequired(saved)) {
			const body = request.body && typeof request.body === 'object' ? request.body : {};
			if (body.token === undefined && body.signature === undefined) {
				response.setHeader('set-cookie', CLEAR_SESSION_COOKIES);
				return response.status(200).json({ ok: true, revoked: false, freshSignatureRequired: true });
			}
			if (!await verifyFreshAuthority(request, response, saved.wallet, 'session-revoke')) return;
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
	const body = request.body ?? {};
	/*
		AUDIT SA-L1: Challenge fuer eine frische Bestaetigung anfordern. Nur mit
		gueltiger, nicht widerrufener Sitzung; die Wallet kommt aus der Sitzung, der
		Zweck aus einer festen Liste. Fuer EOA-Sitzungen gibt es keine Challenge
		("nicht noetig") - deren Ablauf bleibt unveraendert. Absichtlich VOR der
		Anmeldepause: wer angemeldet ist, kann sich immer abmelden.
	*/
	if (typeof body.action === 'string' && body.token === undefined && body.signature === undefined && body.access === undefined) {
		if (!await enforceRateLimit(request, response, 'dashboard-action', 20, 600)) return;
		if (!['session-revoke', 'telegram-disconnect'].includes(body.action)) return response.status(400).json({ ok: false, error: 'Unbekannte Aktion.' });
		const resolvedAction = resolveDashboardSession(request);
		const session = resolvedAction.conflict ? null : resolvedAction.session;
		if (!session) return response.status(401).json({ ok: false, code: 'NO_SESSION', error: 'Keine aktive Dashboard-Sitzung.' });
		let revoked;
		try { revoked = await isDashboardSessionRevoked(session.wallet, sessionIssuedAt(session)); } catch { return response.status(503).json({ ok: false, code: 'SESSION_CHECK_UNAVAILABLE', error: 'Sitzung konnte gerade nicht geprüft werden.' }); }
		if (revoked) return response.status(401).json({ ok: false, code: 'SESSION_REVOKED', error: 'Die Wallet-Verbindung wurde vollständig zurückgesetzt.' });
		if (!await freshAuthorityRequired(session)) return response.status(200).json({ ok: true, freshSignatureRequired: false });
		if (!await enforceRateLimitFor(response, 'dashboard-action-wallet', session.wallet, 10, 600)) return;
		const action = createActionChallenge(session.wallet, body.action);
		await storeDashboardChallenge({ nonce: action.data.nonce, wallet: action.data.wallet, expiresAt: action.data.exp });
		return response.status(200).json({ ok: true, freshSignatureRequired: true, action: body.action, token: action.token, message: action.message });
	}
	if (ANMELDUNG_PAUSIERT) return pauseAntwort(response);
	/*
		META-AUDIT M-3, Modus B: ONCHAIN_SAFE_MESSAGE_APPROVAL - NUR Dashboard-Login.
		Safe{Wallet} hat die Login-Signatur in seine Standard-On-chain-Bestaetigung
		(SignMessageLib) umgewandelt; der Browser fragt nur noch read-only ab, ob die
		Owner sie ausgefuehrt haben. Body exakt { wallet, token, approval: 'onchain' }:
		keine Signatur, kein Hash, keine Nachricht, kein Ziel, keine Gaswerte. Der
		Server baut die Nachricht aus der HMAC-Challenge, rechnet den Hash, setzt die
		leere ERC-1271-Signatur selbst und verlangt VALID von beiden Providern
		(verifyOnchainDashboardLoginApproval). Noch nicht freigegeben -> 202, nichts
		verbraucht, nichts gespeichert. Erst VALID -> Nonce atomar verbrauchen ->
		24-h-Contract-Sitzung. Der Zugangsbeweis ist allein der On-chain-Zustand der
		Safe; das Token waehlt nur, WELCHE Challenge geprueft wird.
	*/
	if (Object.prototype.hasOwnProperty.call(body, 'approval')) {
		if (!await enforceRateLimit(request, response, 'dashboard-onchain', 60, 600)) return;
		const keys = Object.keys(body).sort().join(',');
		if (keys !== 'approval,token,wallet' || body.approval !== 'onchain') return response.status(400).json({ ok: false, code: 'ONCHAIN_APPROVAL_INVALID_REQUEST', error: 'Ungültige Anfrage.' });
		const { wallet, token } = body;
		const challenge = verifyDashboardToken(token);
		if (challenge?.type !== 'challenge' || !isAddress(wallet) || challenge.wallet !== wallet.toLowerCase()) return response.status(401).json({ ok: false, error: 'Dashboard-Anmeldung ungültig oder abgelaufen.' });
		// Abfrage-Budget je Challenge, je Wallet und global (M-2) - alles VOR jedem RPC.
		if (!await enforceRateLimitFor(response, 'dashboard-onchain-nonce', challenge.nonce, 45, 600)) return;
		if (!await enforceRateLimitFor(response, 'dashboard-onchain-wallet', wallet.toLowerCase(), 90, 600)) return;
		if (!await enforceRateLimitFor(response, 'dashboard-onchain-global', 'all', 600, 600)) return;
		let open;
		try { open = await isDashboardChallengeOpen(challenge.nonce, wallet); } catch { return response.status(503).json({ ok: false, code: 'ONCHAIN_APPROVAL_CHECK_UNAVAILABLE', error: 'Die Freigabe konnte gerade nicht geprüft werden.' }); }
		if (!open) return response.status(409).json({ ok: false, code: 'CHALLENGE_CLOSED', error: 'Diese Login-Anfrage ist abgelaufen oder wurde bereits verwendet.' });
		const approval = await verifyOnchainDashboardLoginApproval({ challenge, wallet });
		if (approval === 'PENDING') return response.status(202).json({ ok: false, code: 'ONCHAIN_APPROVAL_PENDING' });
		if (approval === 'NOT_CONTRACT') return response.status(400).json({ ok: false, code: 'ONCHAIN_APPROVAL_CONTRACT_ONLY', error: 'Diese Anmeldung gilt nur für Safe- und andere Contract-Wallets.' });
		if (approval === 'RPC_DISAGREEMENT') {
			await recordSecurityEvent(SECURITY_EVENT.ERC1271_RPC_DISAGREEMENT, { source: 'dashboard', fingerprint: securityFingerprint(wallet) });
			return response.status(401).json({ ok: false, error: 'Wallet-Freigabe konnte nicht bestätigt werden.' });
		}
		if (approval !== 'APPROVED') return response.status(503).json({ ok: false, code: 'ONCHAIN_APPROVAL_CHECK_UNAVAILABLE', error: 'Die Freigabe konnte gerade nicht geprüft werden. Bitte gleich erneut versuchen.' });
		// Erst verbrauchen, DANN Sitzung - atomar, einmalig.
		if (!await consumeDashboardChallenge(challenge.nonce, wallet)) {
			await recordSecurityEvent(SECURITY_EVENT.SIWE_REPLAY_BLOCKED, { source: 'dashboard', fingerprint: securityFingerprint(wallet) });
			return response.status(409).json({ ok: false, error: 'Diese Login-Anfrage wurde bereits verwendet.' });
		}
		return issueLoginSession(request, response, wallet, 'contract', 'onchain_safe_message_approval');
	}
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
	// AUDIT SA-L1: das Ergebnis nennt auch die Autoritaet ('eoa' | 'contract');
	// daraus - und nur daraus - folgt die Sitzungsart und damit die Laufzeit.
	const { result: verified, authority } = await verifyWalletSiweAuthority({
		message,
		signature,
		expected: dashboardSiweExpectation(challenge, wallet)
	});
	if (verified !== 'VALID') {
		// RPC-Ausfall (Contract-Status nicht feststellbar) ist kein Angriffssignal;
		// ein Widerspruch der beiden ERC-1271-Provider schon (eigenes Ereignis).
		if (verified !== 'RPC_UNAVAILABLE') {
			await recordSecurityEvent(verified === 'RPC_DISAGREEMENT' ? SECURITY_EVENT.ERC1271_RPC_DISAGREEMENT : SECURITY_EVENT.SIWE_SIGNATURE_INVALID, { source: 'dashboard', fingerprint: securityFingerprint(wallet) });
		}
		return response.status(401).json({ ok: false, error: 'Wallet-Signatur konnte nicht bestätigt werden.' });
	}
	if (!await consumeDashboardChallenge(challenge.nonce, wallet)) {
		await recordSecurityEvent(SECURITY_EVENT.SIWE_REPLAY_BLOCKED, { source: 'dashboard', fingerprint: securityFingerprint(wallet) });
		return response.status(409).json({ ok: false, error: 'Diese Login-Anfrage wurde bereits verwendet.' });
	}
	return issueLoginSession(request, response, wallet, authority === 'contract' ? 'contract' : 'eoa', 'signature');

	/*
		Die EINE Stelle, an der eine Dashboard-Sitzung entsteht. Aufgerufen NUR nach
		erfolgreicher Pruefung UND atomarem Nonce-Verbrauch - vom Signatur-Login
		(Modus A) und vom On-chain-Freigabe-Login (META-AUDIT M-3, Modus B, immer
		'contract'). Die Sitzungsart kommt aus dem tatsaechlich erfolgreichen Pfad.
	*/
	async function issueLoginSession(request, response, wallet, kind, mode) {
		response.setHeader('set-cookie', sessionCookieHeader(wallet, Date.now(), kind));
		await recordAgentEvent({ wallet, eventType: 'dashboard.wallet_authenticated', source: 'dashboard', metadata: { mode } }).catch(() => {});
		const data = await dashboardData(wallet);
		// AGENT-SAFE-3: Safe-App-Pfad (eingebettetes iframe) kann das __Host-Cookie
		// nicht zuverlaessig setzen und bekommt das Session-Token deshalb auf Anfrage
		// im Body - JS-lesbar.
		// EOA-Meta-Audit M1 (15.10.2026): den Header setzt jeder Client selbst, auch ein
		// kompromittiertes Frontend. Ob es ein Bearer-Token gibt, entscheidet deshalb
		// die serverseitig BEWIESENE Autoritaet: nur eine Contract-Wallet-Sitzung
		// (ERC-1271 bzw. On-chain-Freigabe, 24 h) - der einzige Nutzer ist der
		// Safe-App-Login. Eine EOA bekommt NIE ein JS-lesbares Token, egal was der
		// Client verlangt; sie hat nur das HttpOnly-Cookie. Restrisiko: ein
		// kompromittiertes Frontend kann fuer eine Safe weiterhin einen 24-h-Bearer
		// anfordern (Abhilfe waere ein Partitioned-HttpOnly-Cookie, offen).
		if (kind === 'contract' && String(request.headers['x-dashboard-transport'] ?? '').toLowerCase() === 'bearer') {
			data.sessionToken = createDashboardSession(wallet, Date.now(), kind);
		}
		return response.status(200).json(data);
	}
}
