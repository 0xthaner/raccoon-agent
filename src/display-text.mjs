/*
	AUDIT E-L3, 14.10.2026: Grenzen fuer Anzeigetext von aussen.

	Produktnamen kommen von der Nexus-Produkt-API - fremde Daten. Ein
	5000-Zeichen-Name machte eine Ablaufwarnung laenger als die 4096 Zeichen, die
	Telegram annimmt; der Versand scheiterte, und mit ihm alle weiteren Warnungen
	desselben Abos. Deshalb wird solcher Text an der Vertrauensgrenze (dort, wo er
	hereinkommt) gekuerzt und von Steuer- und Formatzeichen befreit. IDs und
	Produkt-IDs bleiben unberuehrt; das hier gilt nur fuer Anzeigetext.

	Telegram bleibt Klartext (kein parse_mode); hier entsteht kein Markup.
*/

/** Hoechstlaenge eines Anzeigenamens von aussen, in Zeichen (Codepoints). */
export const MAX_DISPLAY_NAME = 120;

/** Telegram nimmt hoechstens 4096 Zeichen je Nachricht an. */
export const TELEGRAM_TEXT_MAX = 4096;

/**
 * Anzeigetext von aussen: nur Zeichenketten, ohne Steuer-/Format-/Zeilentrennzeichen
 * (u. a. CR, LF, Tab, U+202E), Leerraum zusammengefasst, hoechstens `max` Zeichen.
 * Leer oder kein String -> null (der Aufrufer zeigt dann seinen Ersatz, z. B. "#97").
 */
export function boundedDisplayText(value, max = MAX_DISPLAY_NAME) {
	if (typeof value !== 'string') return null;
	const clean = value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim();
	if (!clean) return null;
	const chars = Array.from(clean);
	return chars.length <= max ? clean : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/**
 * Letzte Schranke vor dem Telegram-Versand: haelt jede Nachricht unter dem Limit,
 * ohne ein Surrogatpaar zu zerschneiden. Normale Nachrichten bleiben unveraendert.
 */
export function telegramText(text) {
	const value = String(text ?? '');
	if (value.length <= TELEGRAM_TEXT_MAX) return value;
	let cut = value.slice(0, TELEGRAM_TEXT_MAX - 1);
	if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
	return `${cut}…`;
}
