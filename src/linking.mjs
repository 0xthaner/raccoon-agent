import { randomBytes } from 'node:crypto';
import { checkRateLimit, createDashboardAccess, createPendingLink } from './db.mjs';
import { recordSecurityEvent, securityFingerprint, SECURITY_EVENT } from './security-events.mjs';
import { telegramExpectation, telegramSiweMessage } from './siwe-auth.mjs';

export const LINK_LIFETIME_MS = 10 * 60 * 1000;

/*
	Restaudit M1, 15.10.2026: neue Link-Codes sind begrenzt - je Chat und global,
	geprueft VOR jedem Schreiben. Identitaet ist der Telegram-Chat (der Webhook
	kommt immer von Telegrams Servern, eine IP sagt nichts), als HMAC-Fingerprint.
	Je Chat 10 in 10 Minuten: jedes Oeffnen der Wallet-Einstellungen erzeugt einen
	Code, normales Bedienen bleibt deutlich darunter. Global 300 in 10 Minuten:
	ein Vielfaches des echten Bedarfs, aber eine Obergrenze fuer Schreiblast aus
	vielen Chats. Ergebnis null = abgelehnt; ohne Secret wird nichts angelegt.
*/
export const LINK_CODE_CHAT_LIMIT = Object.freeze({ max: 10, windowSeconds: 600 });
export const LINK_CODE_GLOBAL_LIMIT = Object.freeze({ max: 300, windowSeconds: 600 });

export async function newLinkRequest(chatId, { gate = checkRateLimit, create = createPendingLink, record = recordSecurityEvent } = {}) {
	const fingerprint = securityFingerprint(`telegram-chat:${chatId}`);
	if (!fingerprint) throw new Error('Security configuration missing.');
	for (const [scope, key, limit] of [['link-code-chat', `link-code-chat:${fingerprint}`, LINK_CODE_CHAT_LIMIT], ['link-code-global', 'link-code-global:all', LINK_CODE_GLOBAL_LIMIT]]) {
		if (!await gate(key, limit.max, limit.windowSeconds)) {
			await record(SECURITY_EVENT.RATE_LIMIT_BLOCKED, { source: 'telegram', fingerprint, scope }).catch(() => {});
			return null;
		}
	}
	const code = randomBytes(18).toString('base64url');
	const nonce = randomBytes(16).toString('hex');
	const expiresAt = Date.now() + LINK_LIFETIME_MS;
	await create({ code, chatId, nonce, expiresAt });
	return { code, expiresAt };
}

/*
	AUDIT-2026-10-12 F1: `pending_links` traegt neben den Verknuepfungen auch
	Dashboard-Zugangscodes (`dashboard:<code>`), gemerkte getrennte Wallets
	(`unlinked:...`) und Widerrufsmarken (`revoked:<wallet>` mit dem
	VORHERSAGBAREN Code `revoked_wallet_<wallet>`). Die Verknuepfungsendpunkte
	schlugen jeden Code nach, ohne die Art zu pruefen; eine Widerrufsmarke verriet
	so ohne Anmeldung, ob und wann sich eine fremde Wallet abgemeldet hatte.

	Deshalb zwei Schranken: nur das exakte Format aus newLinkRequest (18 Byte,
	base64url, also genau 24 Zeichen) erreicht ueberhaupt die Datenbank, und nur
	eine Zeile mit privater Telegram-Chat-ID (positive Ganzzahl) gilt als
	Verknuepfung.
*/
const TELEGRAM_LINK_CODE = /^[A-Za-z0-9_-]{24}$/;
const PRIVATE_CHAT_ID = /^[1-9][0-9]{0,19}$/;

export function isTelegramLinkCode(code) {
	return typeof code === 'string' && TELEGRAM_LINK_CODE.test(code);
}

export function isTelegramLinkRow(row) {
	return typeof row?.chat_id === 'string' && PRIVATE_CHAT_ID.test(row.chat_id);
}

export async function newDashboardAccess(wallet) {
	const code = randomBytes(24).toString('base64url');
	const expiresAt = Date.now() + 5 * 60 * 1000;
	await createDashboardAccess({ code, wallet, expiresAt });
	return { code, expiresAt };
}

/*
	AUDIT E-L2, 14.10.2026: WOHIN die Wallet verknuepft wird, steht jetzt im
	signierten Text. Quelle ist ausschliesslich Telegram selbst: `getChat` fuer die
	Chat-ID, die der Server beim Anlegen des Links aus dem authentifizierten Update
	gespeichert hat. Kein Wert aus Query, Body oder Header geht ein.

	Dieselbe Funktion liefert Anzeige (/api/link) und Signaturtext (/api/link,
	/api/link/verify). Aendert jemand zwischen Anzeigen und Signieren seinen
	Telegram-Namen, passt die Signatur nicht mehr - fail closed, neu signieren.
	Ist Telegram nicht erreichbar, gibt es KEINEN Signaturtext (kein Rueckfall auf
	einen Text ohne Ziel).
*/
const TELEGRAM_USERNAME = /^[A-Za-z0-9_]{5,32}$/;

/** Ein frei waehlbarer Telegram-Name als ASCII-Text: ohne @, Klammern, Steuerzeichen. */
function asciiName(chat) {
	const raw = [chat?.first_name, chat?.last_name].filter((part) => typeof part === 'string').join(' ');
	return raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 .-]+/g, ' ')
		.replace(/\s+/g, ' ').trim().slice(0, 32).trim().replace(/^[ .-]+/, '');
}

/**
 * Zielbeschreibung fuer genau diesen privaten Chat - oder null.
 * `chat` ist die `getChat`-Antwort; `chatId` die serverseitig gebundene ID.
 */
export function telegramTargetOf(chat, chatId) {
	if (!/^[1-9][0-9]{0,19}$/.test(String(chatId))) return null;
	if (!chat || chat.type !== 'private' || String(chat.id) !== String(chatId)) return null;
	const username = typeof chat.username === 'string' && TELEGRAM_USERNAME.test(chat.username) ? chat.username : null;
	const name = [chat.first_name, chat.last_name].filter((part) => typeof part === 'string').join(' ').replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').trim().slice(0, 64) || null;
	const ascii = asciiName(chat);
	const target = username ? `@${username}` : ascii ? `[${ascii}] (no username)` : `account ending ${String(chatId).slice(-4).padStart(4, '0')} (no username)`;
	return { username, name, target };
}

/** Liest das Ziel live bei Telegram. Jeder Fehler ergibt null. */
export async function telegramTarget(chatId, { token = process.env.TELEGRAM_BOT_TOKEN?.trim(), fetchImpl = fetch } = {}) {
	if (!token || !/^[1-9][0-9]{0,19}$/.test(String(chatId))) return null;
	try {
		const result = await fetchImpl(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`, { signal: AbortSignal.timeout(4_000) })
			.then((response) => response.json());
		return result?.ok ? telegramTargetOf(result.result, chatId) : null;
	} catch {
		return null;
	}
}

/**
 * Der Signaturtext der Telegram-Verknuepfung, ERC-4361.
 *
 * AGENT-SEC-A3, 29.08.2026: ersetzt den fruehreren proprietaeren Klartext.
 * `issuedAt` wird aus der gespeicherten Ablaufzeit und der festen Lebensdauer
 * ABGELEITET, damit Aussteller und Verifizierer denselben Zeitpunkt ohne ein
 * zusaetzliches Datenbankfeld rekonstruieren. Die Request-ID haengt am
 * serverseitigen Pending-Link-Code, siehe `telegramRequestId`. `target` ist die
 * Zielbeschreibung aus `telegramTarget` (Pflicht, AUDIT E-L2).
 *
 * Statement und Ressource unterscheiden sich vom Dashboard; eine Signatur des
 * einen Zwecks passt deshalb nie auf den anderen.
 */
export function signingMessage({ wallet, nonce, expiresAt, code, target }) {
	return telegramSiweMessage({
		wallet,
		nonce,
		issuedAt: Number(expiresAt) - LINK_LIFETIME_MS,
		expiresAt: Number(expiresAt),
		code,
		target
	});
}

/** Die trusted Erwartung zu genau diesem Pending-Link. */
export function linkSiweExpectation({ wallet, nonce, expiresAt, code, target }) {
	return telegramExpectation({
		wallet,
		nonce,
		issuedAt: Number(expiresAt) - LINK_LIFETIME_MS,
		expiresAt: Number(expiresAt),
		code,
		target
	});
}
