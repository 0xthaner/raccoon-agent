import { createHmac } from 'node:crypto';
import { checkRateLimit } from './db.mjs';
import { dashboardSecretConfigured } from './dashboard-auth.mjs';
import { siweOrigin } from './siwe-auth.mjs';
import { recordSecurityEvent, SECURITY_EVENT } from './security-events.mjs';

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

/**
 * Tatsaechliche Groesse des bereits geparsten Bodys, so zuverlaessig wie hier
 * moeglich: ein String zaehlt als UTF-8-Bytes, ein Buffer direkt, sonst die
 * serialisierte JSON-Form. Ein nicht serialisierbarer Body (z. B. zyklisch)
 * gilt als zu gross - fail closed.
 */
function serializedBodySize(body) {
	if (body == null) return 0;
	if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');
	if (Buffer.isBuffer(body)) return body.length;
	try {
		return Buffer.byteLength(JSON.stringify(body), 'utf8');
	} catch {
		return Infinity;
	}
}

/**
 * AGENT-API-001: die Groessengrenze haengt NICHT mehr allein am
 * `Content-Length`-Header (den ein Client weglassen oder faelschen kann). Der
 * Header dient nur als Frueh-Abweisung; zusaetzlich wird die tatsaechlich
 * vorliegende Body-Groesse geprueft. Die Plattform (Vercel) deckelt Bodies
 * zusaetzlich bei rund 4,5 MB - diese Pruefung ist die anwendungsseitige,
 * header-unabhaengige Schranke darunter. Fail closed.
 */
export function bodyTooLarge(request, maxBytes) {
	const length = Number(request.headers?.['content-length']);
	if (Number.isFinite(length) && length > maxBytes) return true; // Frueh-Abweisung
	return serializedBodySize(request?.body) > maxBytes; // header-unabhaengig
}

export function requireJson(request, response, maxBytes = 16_384) {
	if (!JSON_TYPE.test(request.headers['content-type'] ?? '')) {
		response.status(415).json({ ok: false, error: 'Content-Type application/json erforderlich.' });
		return false;
	}
	if (bodyTooLarge(request, maxBytes)) {
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
/**
 * AGENT-SAFE-4: zusaetzlich erlaubte App-Origins, AUSSCHLIESSLICH ausserhalb
 * Production. Gedacht fuer ein Preview, auf dem die native Safe App unter ihrer
 * eigenen Vercel-Origin laeuft (nicht coverraccoon.com), waehrend die SIWE-Domain
 * kanonisch coverraccoon.com bleibt.
 *
 * HARTE GRENZEN:
 * - In Production (`VERCEL_ENV === 'production'`) wird `ALLOWED_APP_ORIGINS`
 *   vollstaendig ignoriert; dort gilt nur die kanonische SIWE-Origin.
 * - Nur absolute https-Origins, EXAKTER String-Vergleich.
 * - Keine Wildcards, kein Regex, kein Subdomain-/startsWith/endsWith-Match.
 * - Keine Ableitung aus Request-Headern (Host/Referer/X-Forwarded-Host).
 * - Malformed/leere Eintraege werden still ignoriert (kein Crash).
 */
function previewAllowedOrigins() {
	if (process.env.VERCEL_ENV === 'production') return [];
	const raw = process.env.ALLOWED_APP_ORIGINS;
	if (typeof raw !== 'string' || !raw) return [];
	const origins = [];
	for (const part of raw.split(',')) {
		const entry = part.trim();
		if (!entry || entry.includes('*')) continue; // leer oder Wildcard -> ignorieren
		let url;
		try { url = new URL(entry); } catch { continue; } // malformed -> ignorieren
		if (url.protocol !== 'https:') continue; // kein http:// u. a.
		if (url.username || url.password) continue; // keine Credentials
		// Exakte Origin: schliesst Pfade, Query, Fragment, trailing slash aus.
		if (url.origin !== entry) continue;
		origins.push(url.origin);
	}
	return origins;
}

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
	// Kanonische SIWE-Origin immer; zusaetzlich - nur ausserhalb Production - eine
	// exakt gelistete Preview-Origin aus ALLOWED_APP_ORIGINS.
	if (origin !== expected && !previewAllowedOrigins().includes(origin)) {
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
	// AGENT-IR-002: Block als Security-Ereignis festhalten (nur Fingerprint + Scope).
	await recordSecurityEvent(SECURITY_EVENT.RATE_LIMIT_BLOCKED, { source: 'system', fingerprint: identity.slice(0, 12), scope });
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
	// AGENT-IR-002: Block als Security-Ereignis festhalten (nur Fingerprint + Scope,
	// keine rohe IP). Die Flut-Schranke in recordSecurityEvent verhindert Zeilenflut.
	await recordSecurityEvent(SECURITY_EVENT.RATE_LIMIT_BLOCKED, { source: 'system', fingerprint: identity.slice(0, 12), scope });
	response.setHeader('retry-after', String(windowSeconds));
	response.status(429).json({ ok: false, error: 'Too many requests. Please try again later.' });
	return false;
}
