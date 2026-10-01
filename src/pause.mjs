/*
	ANMELDUNG PAUSIERT (seit 01.10.2026).

	Bis Haftungsfragen geklaert sind (eigene Gesellschaft fuer den Agenten,
	Nachweis der Zustimmung, Berufshaftpflicht), nimmt der Agent keine neuen
	Anmeldungen und keine neuen Wallet-Verknuepfungen an. Zum Wiedereinschalten
	hier auf `false` setzen, committen, deployen.

	Bewusst NICHT pausiert: bestehende Dashboard-Sitzungen, Abmelden, Telegram
	trennen und die Ablauf-Erinnerungen fuer bereits verbundene Wallets. Wer
	schon drin ist, soll sich auch wieder abmelden und trennen koennen.
*/
export const ANMELDUNG_PAUSIERT = true;

export const PAUSE_TEXT = Object.freeze({
	de: 'Neue Anmeldungen und Wallet-Verknüpfungen sind derzeit pausiert. Bereits verbundene Wallets werden weiter überwacht.',
	en: 'New sign-ins and wallet connections are paused for now. Wallets that are already connected keep being monitored.',
	zh: '新的登录和钱包绑定目前已暂停。已绑定的钱包会继续受到监控。'
});

export function pauseAntwort(response) {
	response.setHeader('cache-control', 'no-store');
	return response.status(503).json({ ok: false, code: 'ANMELDUNG_PAUSIERT', error: PAUSE_TEXT.de });
}
