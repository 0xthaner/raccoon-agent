import { timingSafeEqual } from 'node:crypto';
import { checkExpiryAlerts } from '../src/alerts.mjs';
import { beginTelegramDelivery, finishTelegramDelivery, purgeOldRecords } from '../src/db.mjs';
import { alertOperatorCronFailure } from '../src/security-events.mjs';
import { telegramText } from '../src/display-text.mjs';

function authorized(header) {
	const expected = process.env.CRON_SECRET?.trim() ?? '';
	if (!expected || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
	const received = Buffer.from(header.slice(7));
	const wanted = Buffer.from(expected);
	return received.length === wanted.length && timingSafeEqual(received, wanted);
}

async function sendMessage(chatId, text, options = {}) {
	const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
	if (!token) throw new Error('Telegram ist nicht konfiguriert.');
	const { _messageKind = 'scheduled_alert', ...telegramOptions } = options;
	const deliveryId = await beginTelegramDelivery(chatId, _messageKind).catch(() => null);
	const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		// AUDIT E-L3: keine Nachricht ueber Telegrams 4096-Zeichen-Grenze (Klartext, kein parse_mode).
		body: JSON.stringify({ chat_id: chatId, text: telegramText(text), disable_web_page_preview: true, ...telegramOptions })
	});
	const result = await response.json().catch(() => null);
	if (!response.ok || !result?.ok) {
		if (deliveryId) await finishTelegramDelivery(deliveryId, { errorCode: String(result?.error_code ?? response.status), errorMessage: result?.description ?? `HTTP ${response.status}` }).catch(() => {});
		throw new Error(`Telegram-Versand fehlgeschlagen: ${result?.description ?? response.status}`);
	}
	if (deliveryId) await finishTelegramDelivery(deliveryId, { messageId: result.result?.message_id }).catch(() => {});
	return result.result;
}

export default async function handler(request, response) {
	if (request.method !== 'GET') return response.status(405).json({ ok: false });
	if (!authorized(request.headers.authorization)) return response.status(401).json({ ok: false });
	// Restaudit M1: fehlt die Konfiguration, scheitert der Lauf als Ganzes - statt
	// dass jedes Abo einzeln still fehlschlaegt und der Lauf "ok" meldet.
	if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
		console.error('Erinnerungslauf: Telegram ist nicht konfiguriert');
		await alertOperatorCronFailure('expiry-alert-config');
		return response.status(500).json({ ok: false });
	}
	const dashboardUrl = (process.env.APP_BASE_URL?.trim() || '').replace(/\/$/, '');
	// AGENT-IR-001 (ALERT-4): ein echter Reminder-Lauf-Fehler alarmiert den
	// Operator (generische Kennung, kein roher Fehlertext) und meldet generisch 500.
	let result;
	try {
		result = await checkExpiryAlerts({ sendMessage, dashboardUrl });
	} catch {
		console.error('checkExpiryAlerts fehlgeschlagen');
		await alertOperatorCronFailure('expiry-alert-run');
		return response.status(500).json({ ok: false });
	}
	// Nach den Erinnerungen und unabhaengig davon: scheitert die Bereinigung,
	// steht es im Ergebnis, aber keine Erinnerung ist verloren.
	//
	// AGENT-API-003: interne DB-/Postgres-Fehlertexte duerfen NICHT nach aussen
	// gelangen. purgeOldRecords liefert je Tabelle entweder eine Zahl (Erfolg)
	// oder eine `fehler: <...>`-Zeichenkette mit der rohen Fehlermeldung. Nach
	// aussen geht deshalb nur die Zahl oder ein generisches 'fehler'; die
	// Ursache wird ausschliesslich server-seitig geloggt (nur Tabellenname,
	// keine Meldung, kein Secret, kein Payload).
	const roh = await purgeOldRecords().catch(() => null);
	let bereinigt;
	let purgeFehler = false;
	if (!roh || typeof roh !== 'object') {
		console.error('purgeOldRecords: Lauf fehlgeschlagen');
		bereinigt = { ok: false };
		purgeFehler = true;
	} else {
		bereinigt = {};
		for (const [tabelle, wert] of Object.entries(roh)) {
			if (typeof wert === 'number') {
				bereinigt[tabelle] = wert;
			} else {
				console.error(`purgeOldRecords: ${tabelle} nicht bereinigt`);
				bereinigt[tabelle] = 'fehler';
				purgeFehler = true;
			}
		}
	}
	// ALERT-4: scheiterte die Bereinigung (ganz oder je Tabelle), Operator alarmieren.
	if (purgeFehler) await alertOperatorCronFailure('purge');
	return response.status(200).json({ ok: true, ...result, bereinigt });
}
