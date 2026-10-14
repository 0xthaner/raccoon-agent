/*
	AGENT-IR-002: minimale, persistierte Security-Fehlerereignisse.

	Forensisch relevante Fehlversuche (ungueltige SIWE-Signatur, Replay,
	Webhook-Auth-Fehler, Rate-Limit-Block, ungueltiger Access-Code) landen als
	kleine, strukturierte Eintraege in der bestehenden `agent_events`-Tabelle.
	KEINE Migration: das Schema (event_type, source, metadata jsonb) reicht.

	DATENMINIMIERUNG - es wird NIE gespeichert: rohe IP, rohe Signatur,
	SIWE-Nachricht, Nonce im Klartext, Access-Code, Bot-Token, Session-Cookie,
	Nutzer-Nachricht oder ein Secret. Wo eine Korrelation technisch sinnvoll ist,
	steht nur ein kurzer, NICHT umkehrbarer Fingerprint (HMAC ueber das bereits
	vorhandene DASHBOARD_SESSION_SECRET, auf 12 Hexzeichen gekuerzt) - kein neues
	Secret.

	FLUT-/STURM-SCHRANKE: je Ereignistyp werden hoechstens RECORD_MAX_PER_WINDOW
	Eintraege pro Fenster geschrieben. Ein anhaltender Angriff flutet die
	Audit-Tabelle damit nicht, und ein spaeterer Alert kann ohne Sturm darauf
	aufsetzen. Der Zaehler nutzt dieselbe atomare Rate-Limit-Infrastruktur
	(api_rate_limits, Upsert - keine Zeilenflut).
*/
import { createHmac } from 'node:crypto';
import { recordAgentEvent, checkRateLimit } from './db.mjs';

export const SECURITY_EVENT = Object.freeze({
	SIWE_SIGNATURE_INVALID: 'security.siwe_signature_invalid',
	SIWE_REPLAY_BLOCKED: 'security.siwe_replay_blocked',
	WEBHOOK_AUTH_FAILED: 'security.webhook_auth_failed',
	RATE_LIMIT_BLOCKED: 'security.rate_limit_blocked',
	ACCESS_CODE_INVALID: 'security.access_code_invalid',
	// Zwei ERC-1271-Provider widersprechen sich (Fork, veralteter Knoten oder Luege).
	ERC1271_RPC_DISAGREEMENT: 'security.erc1271_rpc_disagreement'
});

const RECORD_MAX_PER_WINDOW = 30;
const RECORD_WINDOW_SECONDS = 600;

/*
	AGENT-IR-001: Operator-Alerts ueber den bestehenden Telegram-Bot.

	Schwellen sind an den bestehenden Rate-Limits ausgerichtet:
	- Login/SIWE (dashboard-login / wallet-link-verify je 10/600s pro IP): ein
	  legitimer Nutzer scheitert selten; > 5 Fehlversuche in 10 min sind
	  auffaellig.
	- Webhook: eine Authentifizierung schlaegt legitim NIE fehl; > 3 in 10 min
	  ist bereits ein Faelschungssignal.
	- Rate-Limit-Blocks: einzelne 429 sind normal; > 20 Blocks in 10 min ueber
	  alle Scopes signalisieren Missbrauch.
	Je Gruppe hoechstens EIN Alert pro Cooldown (1 h) - kein Alarm-Sturm.
*/
const ALERT_RULES = Object.freeze({
	[/* SIWE_SIGNATURE_INVALID */ 'security.siwe_signature_invalid']: { group: 'login', label: 'SIWE/Login-Fehlversuche', threshold: 5, window: 600 },
	[/* SIWE_REPLAY_BLOCKED */ 'security.siwe_replay_blocked']: { group: 'login', label: 'SIWE/Login-Fehlversuche', threshold: 5, window: 600 },
	[/* WEBHOOK_AUTH_FAILED */ 'security.webhook_auth_failed']: { group: 'webhook', label: 'Webhook-Authentifizierung fehlgeschlagen', threshold: 3, window: 600 },
	[/* RATE_LIMIT_BLOCKED */ 'security.rate_limit_blocked']: { group: 'ratelimit', label: 'Rate-Limit-Blocks', threshold: 20, window: 600 },
	// Ehrliche Provider widersprechen sich am selben Block praktisch nie: schon EIN Fall meldet sich (Cooldown 1 h).
	[/* ERC1271_RPC_DISAGREEMENT */ 'security.erc1271_rpc_disagreement']: { group: 'rpc', label: 'ERC-1271-Provider uneinig', threshold: 1, window: 3600 }
});
const ALERT_COOLDOWN_SECONDS = 3600;

/** Operator-chat_id AUSSCHLIESSLICH aus der Umgebung, validiert. Nie aus einem Request. */
function operatorChatId() {
	const id = process.env.OPERATOR_TELEGRAM_CHAT_ID?.trim() ?? '';
	return /^\d{1,20}$/.test(id) ? id : null;
}

function alertingConfigured() {
	return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()) && operatorChatId() !== null;
}

/**
 * Sendet einen Operator-Alert ueber den bestehenden Bot. Best effort: jeder
 * Fehler wird geschluckt, nie wird ein Request gekippt, kein Retry. Plain text
 * (kein parse_mode). Ohne Token/chat_id ein No-op.
 */
export async function sendOperatorAlert(text, { fetchImpl = fetch } = {}) {
	try {
		const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
		const chatId = operatorChatId();
		if (!token || !chatId) return false;
		await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
			signal: AbortSignal.timeout(4_000)
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Prueft Schwelle + Cooldown und alarmiert ggf. den Operator. Der Zaehler nutzt
 * dieselbe atomare Rate-Limit-Infrastruktur: unter der Schwelle kein Alert; bei
 * Ueberschreitung genau EIN Alert pro Cooldown. `gate`/`alert`/`now` injizierbar.
 */
export async function maybeAlertOperator(eventType, { scope = null, fingerprint = null } = {}, { gate = checkRateLimit, alert = sendOperatorAlert, now = () => new Date() } = {}) {
	try {
		const rule = ALERT_RULES[eventType];
		if (!rule || !alertingConfigured()) return false;
		// Unter der Schwelle: der Zaehler erlaubt noch -> kein Alert (ein einzelner
		// Fehlversuch loest nie aus).
		if (await gate(`alertcount:${rule.group}`, rule.threshold, rule.window)) return false;
		// Schwelle ueberschritten: genau ein Alert je Cooldown-Fenster.
		if (!await gate(`alertcooldown:${rule.group}`, 1, ALERT_COOLDOWN_SECONDS)) return false;
		const text = [
			'⚠️ Raccoon Agent — Security-Alarm',
			`Kategorie: ${rule.label}`,
			scope ? `Scope: ${String(scope).slice(0, 64)}` : null,
			`Schwelle überschritten (> ${rule.threshold} in ${Math.round(rule.window / 60)} min)`,
			`Zeit: ${now().toISOString()}`,
			fingerprint ? `fp: ${String(fingerprint).slice(0, 12)}` : null
		].filter(Boolean).join('\n');
		return await alert(text);
	} catch {
		return false;
	}
}

/**
 * ALERT-4: echter Cron-/Reminder-Fehler. `reason` ist eine generische Kennung
 * (kein roher Fehlertext). Ein Alert je Cooldown.
 */
export async function alertOperatorCronFailure(reason, { gate = checkRateLimit, alert = sendOperatorAlert, now = () => new Date() } = {}) {
	try {
		if (!alertingConfigured()) return false;
		if (!await gate('alertcooldown:cron', 1, ALERT_COOLDOWN_SECONDS)) return false;
		const text = [
			'⚠️ Raccoon Agent — Cron-Fehler',
			`Bereich: ${String(reason ?? 'unbekannt').slice(0, 80)}`,
			`Zeit: ${now().toISOString()}`
		].join('\n');
		return await alert(text);
	} catch {
		return false;
	}
}

/**
 * Kurzer, nicht umkehrbarer Fingerprint ueber das vorhandene
 * DASHBOARD_SESSION_SECRET. Kein neues Secret. Ohne (ausreichendes) Secret oder
 * ohne Wert gibt es keinen Fingerprint (null) - fail closed, nie Rohdaten.
 */
export function securityFingerprint(value) {
	const secret = process.env.DASHBOARD_SESSION_SECRET?.trim();
	if (!secret || secret.length < 32 || value == null || value === '') return null;
	return createHmac('sha256', secret).update(String(value)).digest('hex').slice(0, 12);
}

/**
 * Persistiert ein Security-Ereignis best-effort. Darf niemals einen Request
 * kippen (alles in try/catch). `record` und `gate` sind fuer Tests injizierbar.
 *
 * metadata: nur kleine, unverfaengliche Schluessel (z. B. `fp`, `scope`).
 * Der Aufrufer ist dafuer verantwortlich, hier KEINE Rohdaten zu uebergeben.
 */
export async function recordSecurityEvent(
	eventType,
	{ source = 'system', fingerprint = null, scope = null } = {},
	{ record = recordAgentEvent, gate = checkRateLimit, alert = sendOperatorAlert } = {}
) {
	let recorded = false;
	// 1) Persistieren (gedrosselt). Best effort, kippt nie einen Request.
	try {
		let allowed = true;
		if (gate) allowed = await gate(`secevent:${eventType}`, RECORD_MAX_PER_WINDOW, RECORD_WINDOW_SECONDS);
		if (allowed) {
			const metadata = {};
			if (fingerprint) metadata.fp = String(fingerprint).slice(0, 32);
			if (scope) metadata.scope = String(scope).slice(0, 64);
			await record({ eventType, source, metadata });
			recorded = true;
		}
	} catch { /* best effort */ }
	// 2) Operator-Alert (Schwelle + Cooldown), UNABHAENGIG von der Aufzeichnungs-
	// Schranke, damit ein Flut-Angriff trotz gedrosselter Writes alarmiert.
	await maybeAlertOperator(eventType, { scope, fingerprint }, { gate, alert });
	return recorded;
}
