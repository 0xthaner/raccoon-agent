import { createHmac } from 'node:crypto';
import { checkRateLimit } from './db.mjs';

const JSON_TYPE = /^application\/json(?:\s*;|$)/i;

function requestIp(request) {
	const forwarded = request.headers['x-forwarded-for'];
	return String(Array.isArray(forwarded) ? forwarded[0] : forwarded ?? request.socket?.remoteAddress ?? 'unknown')
		.split(',', 1)[0].trim().slice(0, 128);
}

function rateSecret() {
	return process.env.DASHBOARD_SESSION_SECRET?.trim() || process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || '';
}

export function requireJson(request, response, maxBytes = 16_384) {
	if (!JSON_TYPE.test(request.headers['content-type'] ?? '')) {
		response.status(415).json({ ok: false, error: 'Content-Type application/json erforderlich.' });
		return false;
	}
	const length = Number(request.headers['content-length']);
	if (Number.isFinite(length) && length > maxBytes) {
		response.status(413).json({ ok: false, error: 'Request too large.' });
		return false;
	}
	return true;
}

export function requireSameOrigin(request, response) {
	const site = String(request.headers['sec-fetch-site'] ?? '').toLowerCase();
	if (site && !['same-origin', 'none'].includes(site)) {
		response.status(403).json({ ok: false, error: 'Cross-site request blocked.' });
		return false;
	}
	const origin = request.headers.origin;
	if (!origin) return true;
	const configured = process.env.APP_BASE_URL?.trim();
	const expected = configured ? new URL(configured).origin : `https://${request.headers.host}`;
	if (origin !== expected) {
		response.status(403).json({ ok: false, error: 'Invalid request origin.' });
		return false;
	}
	return true;
}

export async function enforceRateLimit(request, response, scope, maxRequests, windowSeconds) {
	const secret = rateSecret();
	if (!secret) {
		response.status(503).json({ ok: false, error: 'Security configuration missing.' });
		return false;
	}
	const identity = createHmac('sha256', secret).update(requestIp(request)).digest('hex');
	const allowed = await checkRateLimit(`${scope}:${identity}`, maxRequests, windowSeconds);
	if (allowed) return true;
	response.setHeader('retry-after', String(windowSeconds));
	response.status(429).json({ ok: false, error: 'Too many requests. Please try again later.' });
	return false;
}
