/*
	BEGRENZUNG FUER KI-ANTWORTEN IM BOT.

	Jede freie Nachricht an den Bot kostet bis zu zwei OpenAI-Aufrufe (Einordnung
	und Antwort). Ohne Grenze kann jemand den Bot in grosse Gruppen holen oder
	ihn privat zuspammen und so Kosten erzeugen. Gezaehlt wird in derselben
	Tabelle wie bei den Web-Endpunkten (api_rate_limits), mit HMAC-Kennung statt
	Klartext-ID.

	Grenzen je Stunde: privater Chat 30, Gruppe 40, einzelner Absender in einer
	Gruppe 10, alle Chats zusammen 600 als Kostendeckel. Befehle und Knoepfe
	zaehlen nicht; nur Nachrichten, die die KI erreichen.
*/
import { checkRateLimit } from './db.mjs';
import { rateKey } from './http-security.mjs';

export const AI_LIMITS = Object.freeze({
	privat: { max: 30, sekunden: 3_600 },
	gruppe: { max: 40, sekunden: 3_600 },
	absender: { max: 10, sekunden: 3_600 },
	gesamt: { max: 600, sekunden: 3_600 }
});

/**
 * true, wenn die KI fuer diese Nachricht angefragt werden darf. Faellt die
 * Zaehlung aus, gilt privat "ja" (der Nutzer soll antworten koennen) und in
 * Gruppen "nein" (dort entstehen die grossen Mengen).
 */
export async function allowAiRequest({ chatId, senderId = null, isGroup = false }, { check = checkRateLimit, key = rateKey } = {}) {
	try {
		/*
			Engste Grenze zuerst: was beim einzelnen Absender abgewiesen wird,
			verbraucht nichts mehr vom Kontingent der Gruppe oder vom Gesamtdeckel.
			Sonst koennte ein Einzelner den Bot fuer eine ganze Gruppe stummschalten.
		*/
		const pruefungen = [];
		if (isGroup) {
			if (senderId != null) pruefungen.push(['ai-absender', `${chatId}:${senderId}`, AI_LIMITS.absender]);
			pruefungen.push(['ai-gruppe', chatId, AI_LIMITS.gruppe]);
		} else {
			pruefungen.push(['ai-privat', chatId, AI_LIMITS.privat]);
		}
		pruefungen.push(['ai-gesamt', 'alle', AI_LIMITS.gesamt]);
		for (const [scope, wert, grenze] of pruefungen) {
			const schluessel = key(scope, wert);
			if (!schluessel || !await check(schluessel, grenze.max, grenze.sekunden)) return false;
		}
		return true;
	} catch {
		return !isGroup;
	}
}
