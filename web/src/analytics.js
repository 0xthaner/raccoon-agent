/*
	Vercel Web Analytics (15.10.2026): anonyme Seitenaufruf-Statistik, ohne Cookies.
	Das Skript kommt von der eigenen Domain (/_vercel/insights/script.js), gebuendelt
	ueber @vercel/analytics - kein Inline-Skript, keine CSP-Aenderung.

	SCHWAERZEN: URLs dieser Anwendung tragen Einmalgeheimnisse - `?access=` (Dashboard-
	Code aus Telegram), `?code=` (Verknuepfungscode), und Safe{Wallet} haengt eigene
	Parameter an. Vercel speichert zu jedem Aufruf die URL samt Query (laut Doku nur
	"gefiltert"). Deshalb geht vor dem Senden NUR Origin + Pfad raus: keine Query, kein
	Fragment. Unlesbare URLs werden gar nicht gesendet.
*/
import { inject } from '@vercel/analytics';

export function redactAnalyticsUrl(url) {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return null;
	}
}

export function analyticsBeforeSend(event) {
	const url = redactAnalyticsUrl(event?.url);
	return url ? { ...event, url } : null;
}

export function startAnalytics(injectFn = inject) {
	injectFn({ beforeSend: analyticsBeforeSend });
}
