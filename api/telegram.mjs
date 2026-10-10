import { timingSafeEqual } from 'node:crypto';
import { handleUpdate } from '../src/bot.mjs';
import { claimTelegramUpdate } from '../src/db.mjs';
import { bodyTooLarge } from '../src/http-security.mjs';
import { recordSecurityEvent, securityFingerprint, SECURITY_EVENT } from '../src/security-events.mjs';
import { isPrivateChatUpdate } from '../src/telegram-audit.mjs';

function validSecret(received) {
	const expected = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '';
	if (!expected || typeof received !== 'string') return false;
	const a = Buffer.from(received);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(request, response) {
	if (request.method !== 'POST') return response.status(405).json({ ok: false });
	if (!validSecret(request.headers['x-telegram-bot-api-secret-token'])) {
		// AGENT-IR-002: moegliche Webhook-Faelschung festhalten (nur IP-Fingerprint,
		// nicht die rohe IP und nicht das geheime Token). Flut-Schranke in recordSecurityEvent.
		const ip = String(request.headers['x-forwarded-for'] ?? '').split(',', 1)[0].trim();
		await recordSecurityEvent(SECURITY_EVENT.WEBHOOK_AUTH_FAILED, { source: 'telegram', fingerprint: securityFingerprint(ip) });
		return response.status(401).json({ ok: false });
	}
	// AGENT-API-001: Groesse header-unabhaengig pruefen (1 MB), nicht nur per Content-Length.
	if (bodyTooLarge(request, 1_000_000)) return response.status(413).json({ ok: false });
	if (!Number.isSafeInteger(request.body?.update_id) || request.body.update_id < 0) return response.status(400).json({ ok: false });
	// Nur private Chats: alles andere wird still quittiert, ohne Datenbank, KI oder Antwort.
	// 200 statt Fehler, damit Telegram das Update nicht erneut zustellt.
	if (!isPrivateChatUpdate(request.body)) return response.status(200).json({ ok: true });
	if (!await claimTelegramUpdate(request.body.update_id)) return response.status(200).json({ ok: true, duplicate: true });
	await handleUpdate(request.body);
	return response.status(200).json({ ok: true });
}
