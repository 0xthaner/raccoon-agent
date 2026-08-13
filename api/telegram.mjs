import { timingSafeEqual } from 'node:crypto';
import { handleUpdate } from '../src/bot.mjs';
import { claimTelegramUpdate } from '../src/db.mjs';

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
		return response.status(401).json({ ok: false });
	}
	const length = Number(request.headers['content-length']);
	if (Number.isFinite(length) && length > 1_000_000) return response.status(413).json({ ok: false });
	if (!Number.isSafeInteger(request.body?.update_id) || request.body.update_id < 0) return response.status(400).json({ ok: false });
	if (!await claimTelegramUpdate(request.body.update_id)) return response.status(200).json({ ok: true, duplicate: true });
	await handleUpdate(request.body);
	return response.status(200).json({ ok: true });
}
