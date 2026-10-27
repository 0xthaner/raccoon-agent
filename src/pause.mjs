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
export const ANMELDUNG_PAUSIERT = false;

export const PAUSE_TEXT = Object.freeze({
	de: 'Neue Anmeldungen und Wallet-Verknüpfungen sind derzeit pausiert. Bereits verbundene Wallets werden weiter überwacht.',
	en: 'New sign-ins and wallet connections are paused for now. Wallets that are already connected keep being monitored.',
	zh: '新的登录和钱包绑定目前已暂停。已绑定的钱包会继续受到监控。'
});

export function pauseAntwort(response) {
	response.setHeader('cache-control', 'no-store');
	return response.status(503).json({ ok: false, code: 'ANMELDUNG_PAUSIERT', error: PAUSE_TEXT.de });
}

/*
	INHALTLICHE AGENT-ANTWORTEN PAUSIERT (seit 02.10.2026).

	Unabhaengig vom Login: solange `true`, beantwortet der Bot keine freien
	Produkt-/Versicherungsfragen und keinen Smalltalk mehr (weder privat noch in
	Gruppen), weil eine inhaltliche Auskunft, auf die sich jemand verlaesst,
	Beratungshaftung ausloesen kann. Zum Wiedereinschalten hier auf `false`
	setzen, committen, deployen.

	Bewusst NICHT betroffen: die funktionalen Befehle fuer bereits verbundene
	Wallets (Covers, Ablauf, Erinnerungen, Dashboard, Abmelden/Trennen) sowie
	alle Knoepfe und /-Befehle. Es entfaellt nur die frei formulierte Auskunft.
*/
export const AGENT_ANTWORTEN_PAUSIERT = false;

export const ANTWORT_PAUSE_TEXT = Object.freeze({
	de: 'Inhaltliche Fragen zu Produkten und Versicherung beantworte ich derzeit nicht. Verbindliche Angaben stehen in der offiziellen Nexus-Mutual-Doku und im jeweiligen Bedingungstext. Covers, Ablaufdaten und Erinnerungen für verbundene Wallets funktionieren weiterhin.',
	en: 'I am not answering questions about products or insurance right now. Binding information is in the official Nexus Mutual docs and the respective cover wording. Covers, expiry dates and reminders for connected wallets keep working.',
	zh: '我目前不回答有关产品或保险的问题。具有约束力的信息请查阅 Nexus Mutual 官方文档及相应的保障条款。已绑定钱包的保障、到期日和提醒仍可正常使用。'
});

/*
	UNISWAP V3 DEAKTIVIERT (seit 27.10.2026).

	Getrenntes Production-Release: Sicherheits- und Aave-Korrekturen gehen raus,
	Uniswap v3 bleibt aus, bis Nexus die Bewertung einer LP-Position und den
	Proof of Loss fuer ein NFT geklaert hat (offene Punkte in der Uniswap-Doku unter docs/).
	Solange `false`: kein Uniswap-Scan, keine RPC-Aufrufe dafuer, kein Abschnitt
	`uniswapV3` in /api/positions, und `uniswap-*`-Aktionen bei /api/nexus/quote
	werden wie jede unbekannte Aktion als INVALID_BODY abgelehnt - genau wie vor
	dem Uniswap-Release. Das Dashboard zeigt den Abschnitt nur, wenn der Server
	ihn liefert. Zum Einschalten hier auf `true` setzen, committen, deployen.
*/
export const UNISWAP_V3_AKTIV = false;
