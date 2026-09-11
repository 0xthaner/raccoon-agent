/*
	AGENT-SEC-A6: `TELEGRAM_BOT_USERNAME` ist zwar ein eigener Konfigurationswert
	und keine Besuchereingabe - er verlaesst hier aber den Server und bildet im
	Browser eine t.me-Adresse. Ein vertippter oder versehentlich mit Zusatz
	befuellter Wert erzeugt sonst still einen Verweis ins Nichts.

	Geprueft wird gegen das Format, das Telegram selbst vergibt. Haelt der Wert es
	nicht ein, wird er nicht ausgeliefert; das Frontend zeigt dann keinen
	Telegram-Verweis statt eines falschen. Dasselbe Muster steht dort noch einmal,
	weil die Antwort fuer den Browser ein Fremdwert bleibt.
*/
const TELEGRAM_NAME = /^[A-Za-z0-9_]{5,32}$/;

export default function handler(_request, response) {
	response.setHeader('cache-control', 'no-store');
	const username = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '') || '';
	response.status(200).json({
		reownProjectId: process.env.REOWN_PROJECT_ID?.trim() || '',
		telegramUsername: TELEGRAM_NAME.test(username) ? username : ''
	});
}
