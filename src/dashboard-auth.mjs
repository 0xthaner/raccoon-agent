import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { dashboardExpectation, dashboardSiweMessage, newRequestId } from './siwe-auth.mjs';

/**
 * Mindestlaenge des Dashboard-Secrets.
 *
 * 32 Zeichen sind die untere Grenze fuer einen HMAC-SHA-256-Schluessel, der
 * nicht schwaecher sein soll als sein eigener Ausgabewert. Kuerzere Werte
 * werden wie ein fehlendes Secret behandelt: fail closed, kein Fallback.
 */
export const MIN_DASHBOARD_SECRET_LENGTH = 32;

/**
 * Ist das Dashboard-Secret eigenstaendig und lang genug gesetzt?
 *
 * Gibt AUSSCHLIESSLICH einen Wahrheitswert zurueck, nie das Secret selbst.
 */
export function dashboardSecretConfigured() {
	const value = process.env.DASHBOARD_SESSION_SECRET?.trim();
	return Boolean(value) && value.length >= MIN_DASHBOARD_SECRET_LENGTH;
}

/**
 * AGENT-SEC-A1, 29.08.2026: der frühere Rückfall auf `TELEGRAM_WEBHOOK_SECRET`
 * ist ersatzlos entfernt. Er hat zwei Vertrauensbereiche mit einem Schluessel
 * bedient: wer den Webhook-Schluessel kannte, konnte Dashboard-Sessions fuer
 * beliebige Wallets signieren. Es gibt keinen Default und keine Ableitung aus
 * oeffentlicher Konfiguration.
 */
function secret() {
	const value = process.env.DASHBOARD_SESSION_SECRET?.trim();
	if (!value || value.length < MIN_DASHBOARD_SECRET_LENGTH) {
		throw new Error('Dashboard ist nicht konfiguriert.');
	}
	return value;
}

function sign(payload) {
	return createHmac('sha256', secret()).update(payload).digest('base64url');
}

/**
 * AGENT-SEC-A3, 29.08.2026: die Challenge traegt zusaetzlich `iat` und `rid`.
 * Beide sind serverseitig gesetzt und gehen in den signierten SIWE-Text ein.
 * Ein altes Token ohne diese Felder wird von `verifyDashboardToken` abgelehnt;
 * damit endet das alte Nachrichtenschema ohne parallelen Legacy-Pfad.
 */
/**
 * Challenge-Lebensdauer. EOA bleibt bei fuenf Minuten. Deployte Contract-Wallets
 * (Safe-Multisig) duerfen laenger, weil mehrere Owner asynchron bestaetigen; der
 * SERVER entscheidet ueber `getCode`, der Client setzt die TTL nie.
 */
export const DASHBOARD_CHALLENGE_TTL_EOA_MS = 5 * 60_000;
export const DASHBOARD_CHALLENGE_TTL_CONTRACT_MS = 30 * 60_000;

export function createDashboardChallenge(wallet, now = Date.now(), ttlMs = DASHBOARD_CHALLENGE_TTL_EOA_MS) {
	// Defensive Grenze: niemals kuerzer als die EOA-TTL, nie laenger als die
	// Contract-TTL. Schuetzt gegen versehentlich durchgereichte Fremdwerte.
	const bounded = Math.min(Math.max(Number(ttlMs) || 0, DASHBOARD_CHALLENGE_TTL_EOA_MS), DASHBOARD_CHALLENGE_TTL_CONTRACT_MS);
	const data = {
		type: 'challenge',
		wallet: wallet.toLowerCase(),
		nonce: randomBytes(16).toString('hex'),
		iat: now,
		rid: newRequestId(),
		exp: now + bounded
	};
	const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
	return { token: `${payload}.${sign(payload)}`, message: dashboardMessage(data, wallet) };
}

export function createDashboardSession(wallet, now = Date.now()) {
	const data = { type: 'session', wallet: wallet.toLowerCase(), iat: now, exp: now + 7 * 24 * 60 * 60_000 };
	const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
	return `${payload}.${sign(payload)}`;
}

export function verifyDashboardToken(token) {
	if (typeof token !== 'string') return null;
	const [payload, received] = token.split('.');
	if (!payload || !received || token.split('.').length !== 2 || payload.length > 2048 || received.length > 128) return null;
	const expected = Buffer.from(sign(payload), 'base64url');
	let actual;
	try { actual = Buffer.from(received, 'base64url'); } catch { return null; }
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
	try {
		const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
		if (!data || !['challenge', 'session'].includes(data.type) || !/^0x[a-f0-9]{40}$/.test(data.wallet ?? '') || !Number.isFinite(data.exp) || Date.now() > data.exp) return null;
		if (data.type === 'challenge' && !/^[a-f0-9]{32}$/.test(data.nonce ?? '')) return null;
		if (data.type === 'challenge' && !/^[a-f0-9]{32}$/.test(data.rid ?? '')) return null;
			// AGENT-SEC-A3, 29.08.2026: eine Challenge ohne die serverseitigen
			// SIWE-Felder stammt aus dem alten Schema und wird abgelehnt. Damit
			// endet das alte Nachrichtenformat ohne parallelen Legacy-Pfad.
			if (data.type === 'challenge' && !Number.isFinite(data.iat)) return null;
			if (data.type === 'session' && !Number.isFinite(data.iat)) return null;
		return data;
	} catch { return null; }
}

export function verifyDashboardSession(token) {
	const data = verifyDashboardToken(token);
	return data?.type === 'session' ? data : null;
}

/* ------------------------------------------------------------------------- *
 * Cookie- und Logoutgrenze
 *
 * Liegt hier und nicht im Handler, damit das Verhalten ohne Datenbank, ohne
 * Netzwerk und ohne Telegram pruefbar ist. Die Entscheidungen sind dieselben
 * wie zuvor im Handler, nur an einem Ort.
 * ------------------------------------------------------------------------- */

export const SESSION_COOKIE = '__Host-raccoon_dashboard';
export const SESSION_COOKIE_OPTIONS = 'Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict';

/**
 * AGENT-SEC-A1, 29.08.2026: das Cookie ohne `__Host-`-Praefix authentifiziert
 * NICHT mehr. Es wird nur noch geloescht, damit alte Browserzustaende
 * verschwinden. Der Name darf ausserhalb der Loeschlogik nicht mehr gelesen
 * werden.
 */
export const LEGACY_SESSION_COOKIE = 'raccoon_dashboard';

export const CLEAR_SESSION_COOKIES = [
	`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
	`${LEGACY_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
];

/** Die EINZIGE Stelle, die ein Dashboard-Sessioncookie ausstellt. */
export function sessionCookieHeader(wallet, now = Date.now()) {
	return `${SESSION_COOKIE}=${encodeURIComponent(createDashboardSession(wallet, now))}; ${SESSION_COOKIE_OPTIONS}`;
}

function cookieOf(request, name) {
	const cookies = request?.headers?.cookie?.split(';') ?? [];
	const match = cookies.map((item) => item.trim().split('=')).find(([key]) => key === name);
	if (!match) return null;
	try { return decodeURIComponent(match.slice(1).join('=')); } catch { return null; }
}

/** Liest ausschliesslich das `__Host-`-Cookie. Kein Legacy-Rueckfall. */
export function readSessionCookie(request) {
	return cookieOf(request, SESSION_COOKIE);
}

/**
 * Bearer-Session fuer den Safe-App-Pfad (eingebettetes iframe, in dem ein
 * Third-Party-Cookie nicht zuverlaessig gesetzt wird). Liest NUR
 * `Authorization: Bearer <token>`, strikt und laengenbegrenzt. Das Token ist
 * dasselbe signierte Session-Token wie im Cookie; die Gueltigkeit prueft
 * ausschliesslich `verifyDashboardSession`. Niemals aus Query/Body/anderen
 * Headern lesen.
 */
export function readBearerToken(request) {
	const header = request?.headers?.authorization;
	if (typeof header !== 'string' || header.length > 2300) return null;
	const match = /^Bearer[ ]([A-Za-z0-9._-]{1,2200})$/i.exec(header);
	return match ? match[1] : null;
}

/**
 * Loest die Dashboard-Session aus Cookie UND/ODER Bearer auf - rein ueber HMAC,
 * ohne Datenbank (die Revoke-Pruefung bleibt im Handler). Regeln:
 *  - nur Cookie gueltig  -> Cookie-Session
 *  - nur Bearer gueltig  -> Bearer-Session
 *  - beide gueltig, gleiche Wallet -> akzeptieren (Cookie)
 *  - beide gueltig, verschiedene Wallets -> CONFLICT (Aufrufer: fail closed, 401)
 *  - sonst -> keine Session
 * Es wird NIE eine client-behauptete Wallet uebernommen.
 */
export function resolveDashboardSession(request) {
	const cookie = verifyDashboardSession(readSessionCookie(request));
	const bearer = verifyDashboardSession(readBearerToken(request));
	if (cookie && bearer) {
		if (cookie.wallet !== bearer.wallet) return { conflict: true, session: null };
		return { conflict: false, session: cookie };
	}
	return { conflict: false, session: cookie || bearer };
}

/**
 * Entscheidet den Logout. Reine Funktion mit injizierten Wirkungen.
 *
 * Ohne erkannte Session ist der Logout idempotent: es wird keine Wallet
 * erfunden und nichts widerrufen. Schlaegt der Widerruf fehl, wird KEIN
 * Erfolg gemeldet und kein Auditereignis geschrieben; die interne Ursache
 * verlaesst den Server nicht.
 */
export async function resolveLogout({ session, revoke, audit }) {
	if (!session?.wallet) return { status: 200, body: { ok: true }, revoked: false };
	try {
		await revoke(session.wallet);
	} catch {
		return {
			status: 503,
			body: { ok: false, error: 'Abmeldung konnte nicht abgeschlossen werden.' },
			revoked: false
		};
	}
	if (audit) await audit(session.wallet);
	return { status: 200, body: { ok: true }, revoked: true };
}

/**
 * Der Dashboard-Signaturtext, ERC-4361.
 *
 * AGENT-SEC-A3, 29.08.2026: ersetzt den fruehreren proprietaeren Klartext, der
 * weder Domain noch URI oder Chain nannte. Der Text wird IMMER serverseitig aus
 * der verifizierten Challenge rekonstruiert; der Client schickt keine eigene
 * SIWE-Nachricht.
 */
export function dashboardMessage(data, wallet = data.wallet) {
	return dashboardSiweMessage({
		wallet,
		nonce: data.nonce,
		issuedAt: data.iat,
		expiresAt: data.exp,
		requestId: data.rid
	});
}

/** Die trusted Erwartung zu genau dieser Challenge. */
export function dashboardSiweExpectation(data, wallet = data.wallet) {
	return dashboardExpectation({
		wallet,
		nonce: data.nonce,
		issuedAt: data.iat,
		expiresAt: data.exp,
		requestId: data.rid
	});
}
