import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ACTION_PURPOSES, actionExpectation, actionSiweMessage, dashboardExpectation, dashboardSiweMessage, newRequestId } from './siwe-auth.mjs';

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

/*
	AUDIT SA-L1, 14.10.2026: Sitzungsart und Laufzeit.

	Eine EOA-Sitzung beruht auf dem Schluessel der Adresse - der laesst sich
	nicht "entziehen"; sie bleibt bei 7 Tagen. Eine Contract-Sitzung (Safe)
	beruht auf der ERC-1271-Antwort zum Anmeldezeitpunkt; danach kann ein Owner
	entfernt werden. Sie gilt deshalb nur 24 Stunden. Die Art (`kind`) bestimmt
	ausschliesslich der Server aus dem tatsaechlich erfolgreichen Pruefpfad
	(verifyWalletSiweAuthority) und schreibt sie HMAC-geschuetzt ins Token.
	Kein Request-, SDK- oder Header-Wert waehlt sie.

	Tokens von vor dieser Aenderung tragen kein `kind`; sie gelten bis zu ihrem
	alten Ablauf weiter (hoechstens 7 Tage). Fuer destruktive Aktionen entscheidet
	bei ihnen der Server per getCode (api/dashboard.mjs).
*/
export const SESSION_TTL_EOA_MS = 7 * 24 * 60 * 60_000;
export const SESSION_TTL_CONTRACT_MS = 24 * 60 * 60_000;
export const SESSION_KINDS = Object.freeze(['eoa', 'contract']);
const sessionTtl = (kind) => (kind === 'contract' ? SESSION_TTL_CONTRACT_MS : SESSION_TTL_EOA_MS);

export function createDashboardSession(wallet, now = Date.now(), kind = 'eoa') {
	if (!SESSION_KINDS.includes(kind)) throw new Error('Unbekannte Sitzungsart.');
	const data = { type: 'session', wallet: wallet.toLowerCase(), kind, iat: now, exp: now + sessionTtl(kind) };
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
		if (!data || !['challenge', 'session', 'action'].includes(data.type) || !/^0x[a-f0-9]{40}$/.test(data.wallet ?? '') || !Number.isFinite(data.exp) || Date.now() > data.exp) return null;
		if (data.type === 'challenge' && !/^[a-f0-9]{32}$/.test(data.nonce ?? '')) return null;
		if (data.type === 'challenge' && !/^[a-f0-9]{32}$/.test(data.rid ?? '')) return null;
			// AGENT-SEC-A3, 29.08.2026: eine Challenge ohne die serverseitigen
			// SIWE-Felder stammt aus dem alten Schema und wird abgelehnt. Damit
			// endet das alte Nachrichtenformat ohne parallelen Legacy-Pfad.
			if (data.type === 'challenge' && !Number.isFinite(data.iat)) return null;
			if (data.type === 'session' && !Number.isFinite(data.iat)) return null;
			// AUDIT SA-L1: eine Sitzungsart, falls vorhanden, muss bekannt sein und zur
			// Laufzeit passen - eine Contract-Sitzung kann nie laenger als 24 h gelten.
			if (data.type === 'session' && data.kind !== undefined && (!SESSION_KINDS.includes(data.kind) || data.exp - data.iat > sessionTtl(data.kind))) return null;
			// Frische Bestaetigung: bekannter Zweck, Nonce, Request-ID, hoechstens ACTION_CHALLENGE_TTL_MS.
			if (data.type === 'action' && (!Object.prototype.hasOwnProperty.call(ACTION_PURPOSES, data.purpose) || !/^[a-f0-9]{32}$/.test(data.nonce ?? '') || !/^[a-f0-9]{32}$/.test(data.rid ?? '') || !Number.isFinite(data.iat) || data.exp - data.iat > ACTION_CHALLENGE_TTL_MS)) return null;
		return data;
	} catch { return null; }
}

/*
	AUDIT SA-L1: Challenge fuer eine frische Bestaetigung (Telegram trennen,
	ueberall abmelden). Eigener Typ `action` mit Zweck; derselbe Nonce-Speicher
	und derselbe atomare Verbrauch wie beim Login (dashboard_challenges). Ein
	Login-Token ist nie eine Aktions-Challenge und umgekehrt.
*/
export const ACTION_CHALLENGE_TTL_MS = 5 * 60_000;

export function createActionChallenge(wallet, purpose, now = Date.now()) {
	if (!Object.prototype.hasOwnProperty.call(ACTION_PURPOSES, purpose)) throw new Error('Unbekannter Bestaetigungszweck.');
	const data = { type: 'action', purpose, wallet: wallet.toLowerCase(), nonce: randomBytes(16).toString('hex'), iat: now, rid: newRequestId(), exp: now + ACTION_CHALLENGE_TTL_MS };
	const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
	return { token: `${payload}.${sign(payload)}`, message: actionMessage(data), data };
}

export function verifyActionChallenge(token, purpose) {
	const data = verifyDashboardToken(token);
	return data?.type === 'action' && data.purpose === purpose ? data : null;
}

/** Der Signaturtext einer frischen Bestaetigung, immer serverseitig aus der Challenge. */
export function actionMessage(data) {
	return actionSiweMessage({ wallet: data.wallet, nonce: data.nonce, issuedAt: data.iat, expiresAt: data.exp, requestId: data.rid, purpose: data.purpose });
}

export function actionSiweExpectation(data) {
	return actionExpectation({ wallet: data.wallet, nonce: data.nonce, issuedAt: data.iat, expiresAt: data.exp, requestId: data.rid, purpose: data.purpose });
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

/*
	Safe-App-Sitzung (15.10.2026): Die Safe App laeuft als Drittanbieter-iframe unter
	app.safe.global; dort wird das Strict-Cookie nie gesendet. Statt des frueheren
	JS-lesbaren 24-h-Bearers traegt die Safe App ihre Sitzung jetzt in einem
	partitionierten HttpOnly-Cookie (CHIPS, Partition = Top-Level-Site safe.global):
	  __Host-raccoon_safeapp=<Contract-Sitzung>; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=None; Partitioned
	Es gilt NUR als Contract-Sitzung (kind=contract) - nie fuer eine EOA. Gleiches Token,
	gleiche Laufzeit (24 h), gleicher Widerruf wie das Strict-Cookie derselben Anmeldung.
	Browser ohne CHIPS koennen die eingebettete Safe App damit nicht halten; ein
	JS-lesbarer Rueckfall ist bewusst NICHT vorgesehen.
*/
export const SAFEAPP_COOKIE = '__Host-raccoon_safeapp';
export const SAFEAPP_TRANSPORT = 'partitioned-cookie';
const SAFEAPP_COOKIE_OPTIONS = `Path=/; Max-Age=${SESSION_TTL_CONTRACT_MS / 1000}; Secure; HttpOnly; SameSite=None; Partitioned`;

export const CLEAR_SESSION_COOKIES = [
	`${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
	`${LEGACY_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
	`${SAFEAPP_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None; Partitioned`
];

/** Die EINZIGE Stelle, die ein Dashboard-Sessioncookie ausstellt. */
export function sessionCookieHeader(wallet, now = Date.now(), kind = 'eoa') {
	const token = createDashboardSession(wallet, now, kind);
	// Das Cookie lebt nie laenger als das Token (Contract: 24 h).
	const options = kind === 'contract' ? SESSION_COOKIE_OPTIONS.replace('Max-Age=604800', `Max-Age=${SESSION_TTL_CONTRACT_MS / 1000}`) : SESSION_COOKIE_OPTIONS;
	return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${options}`;
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
 * Das partitionierte Safe-App-Cookie zum soeben ausgestellten Strict-Cookie - oder
 * null. Nur fuer eine bewiesene Contract-Sitzung (`kind === 'contract'`) und nur,
 * wenn die Safe App genau diesen Transport anfordert. Der Wert wird aus dem
 * Strict-Cookie uebernommen (kein neues Token, keine neue Laufzeit) und nochmals
 * geprueft. Es gibt KEINEN Transport, der ein JS-lesbares Token liefert.
 */
export function safeAppCookieFor(sessionCookie, kind, transport) {
	if (kind !== 'contract' || transport !== SAFEAPP_TRANSPORT) return null;
	const prefix = `${SESSION_COOKIE}=`;
	if (typeof sessionCookie !== 'string' || !sessionCookie.startsWith(prefix)) return null;
	const raw = sessionCookie.slice(prefix.length, sessionCookie.indexOf(';'));
	let session;
	try { session = verifyDashboardSession(decodeURIComponent(raw)); } catch { return null; }
	if (session?.kind !== 'contract') return null;
	return `${SAFEAPP_COOKIE}=${raw}; ${SAFEAPP_COOKIE_OPTIONS}`;
}

/** Safe-App-Cookie als Sitzung - ausschliesslich eine Contract-Sitzung. */
function readSafeAppSession(request) {
	const session = verifyDashboardSession(cookieOf(request, SAFEAPP_COOKIE));
	return session?.kind === 'contract' ? session : null;
}

/**
 * Loest die Dashboard-Session aus dem Strict-Cookie (normaler Browser) UND/ODER dem
 * partitionierten Safe-App-Cookie auf - rein ueber HMAC, ohne Datenbank (die
 * Revoke-Pruefung bleibt im Handler). Regeln:
 *  - nur eines gueltig -> diese Session
 *  - beide gueltig, gleiche Wallet -> akzeptieren (Strict-Cookie)
 *  - beide gueltig, verschiedene Wallets -> CONFLICT (Aufrufer: fail closed, 401)
 *  - sonst -> keine Session
 * `Authorization: Bearer` wird NICHT mehr gelesen (Safe-App-Sitzung, 15.10.2026).
 * Es wird NIE eine client-behauptete Wallet uebernommen.
 */
export function resolveDashboardSession(request) {
	const cookie = verifyDashboardSession(readSessionCookie(request));
	const safeApp = readSafeAppSession(request);
	if (cookie && safeApp) {
		if (cookie.wallet !== safeApp.wallet) return { conflict: true, session: null };
		return { conflict: false, session: cookie };
	}
	return { conflict: false, session: cookie || safeApp };
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
