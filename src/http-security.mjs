import { createHmac } from 'node:crypto';
import { checkRateLimit } from './db.mjs';
import { dashboardSecretConfigured } from './dashboard-auth.mjs';
import { siweOrigin } from './siwe-auth.mjs';

const JSON_TYPE = /^application\/json(?:\s*;|$)/i;

function requestIp(request) {
	const forwarded = request.headers['x-forwarded-for'];
	return String(Array.isArray(forwarded) ? forwarded[0] : forwarded ?? request.socket?.remoteAddress ?? 'unknown')
		.split(',', 1)[0].trim().slice(0, 128);
}

/**
 * AGENT-SEC-A1, 29.08.2026: kein Rueckfall mehr auf `TELEGRAM_WEBHOOK_SECRET`.
 * Die Rate-Limit-Identitaet ist eine Dashboard-Groesse und haengt allein am
 * Dashboard-Secret. Ist es nicht oder zu kurz gesetzt, bleibt der Schluessel
 * leer und `enforceRateLimit` nimmt den bestehenden sicheren 503-Pfad; es gibt
 * keinen leeren HMAC-Schluessel und keinen Default.
 */
function rateSecret() {
	return dashboardSecretConfigured() ? process.env.DASHBOARD_SESSION_SECRET.trim() : '';
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

/**
 * AGENT-SEC-W2: hier stand ein Rueckfall auf `https://${request.headers.host}`,
 * falls `APP_BASE_URL` fehlt. Damit entschied ein Requestwert darueber, welche
 * Herkunft als die eigene gilt - genau das, was `siweOrigin()` eine Datei weiter
 * mit ausfuehrlicher Begruendung ausschliesst. Aus dem Browser war es nicht
 * ausnutzbar, weil dieser `Host` selbst auf das echte Ziel setzt; aber es war
 * eine Vertrauensquelle, die hier nichts zu suchen hat.
 *
 * Jetzt gilt dieselbe Herkunft wie fuer die Anmeldung, aus derselben Funktion.
 * Ist sie nicht konfiguriert, gibt es keinen Rueckfall, sondern 503 - wie beim
 * fehlenden Rate-Limit-Secret eine Zeile weiter oben.
 */
export function requireSameOrigin(request, response) {
	const site = String(request.headers['sec-fetch-site'] ?? '').toLowerCase();
	if (site && !['same-origin', 'none'].includes(site)) {
		response.status(403).json({ ok: false, error: 'Cross-site request blocked.' });
		return false;
	}
	const origin = request.headers.origin;
	if (!origin) return true;
	let expected;
	try {
		expected = siweOrigin().uri;
	} catch {
		response.status(503).json({ ok: false, error: 'Security configuration missing.' });
		return false;
	}
	if (origin !== expected) {
		response.status(403).json({ ok: false, error: 'Invalid request origin.' });
		return false;
	}
	return true;
}

/**
 * AGENT-SEC-A5: ein Limit pro IP allein schuetzt einen einzelnen Verbindungscode
 * nicht - wer ueber viele Adressen verteilt raet, laeuft nie in die Schranke.
 * Deshalb zusaetzlich ein Limit, das am Wert selbst haengt und damit fuer alle
 * Aufrufer zusammen gilt.
 *
 * Der Wert geht nur als HMAC in den Schluessel: der Zaehler soll den Code
 * begrenzen, ihn aber nirgends im Klartext ablegen.
 */
/** Pseudonyme Zaehl-Kennung fuer Begrenzungen ausserhalb von HTTP (z. B. Bot-Nachrichten). */
export function rateKey(scope, wert) {
	const secret = rateSecret();
	if (!secret) return null;
	return `${scope}:${createHmac('sha256', secret).update(String(wert)).digest('hex')}`;
}

export async function enforceRateLimitFor(response, scope, wert, maxRequests, windowSeconds) {
	const secret = rateSecret();
	if (!secret) {
		response.status(503).json({ ok: false, error: 'Security configuration missing.' });
		return false;
	}
	const identity = createHmac('sha256', secret).update(String(wert)).digest('hex');
	if (await checkRateLimit(`${scope}:${identity}`, maxRequests, windowSeconds)) return true;
	response.setHeader('retry-after', String(windowSeconds));
	response.status(429).json({ ok: false, error: 'Too many requests. Please try again later.' });
	return false;
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
