/*
	META-AUDIT M-3, 15.10.2026: keine Signaturanfrage an Contract-Wallets (Safe).

	Safe{Wallet} entscheidet erst BEIM Signieren, ob eine Nachricht off-chain
	signiert oder als Safe-Transaktion (SignMessageLib, Gas) vorgeschlagen wird -
	abhaengig von Safe-Version, Fallback-Handler und der Nutzer-Einstellung
	"Always use on-chain signatures". Keine Schnittstelle (Safe-Apps-SDK,
	safe_setSettings, WalletConnect wallet_getCapabilities) macht den wirksamen
	Modus VORHER sichtbar; safe_setSettings spiegelt nur die Anfrage. Eine
	Off-chain-Garantie vor der Anfrage gibt es also nicht.

	Deshalb gibt der Server fuer Contract-Wallets KEINE Nachricht zum Signieren aus
	(Login-Challenge, Telegram-Verknuepfung, frische Bestaetigung), und fuer eine
	nicht bestimmbare Wallet-Art ebenfalls nicht. Ohne Nachricht startet keine
	Oberflaeche eine Signaturanfrage. Die Wallet-Art bestimmt ausschliesslich der
	Server (beide RPC-Provider); kein Browser-Wert entscheidet.

	Die ERC-1271-Pruefung im Backend bleibt unveraendert bestehen.
*/
export const CONTRACT_SIGNING_UNSUPPORTED = Object.freeze({
	ok: false,
	code: 'CONTRACT_SIGNING_UNSUPPORTED',
	error: 'Diese Safe kann derzeit nicht sicher über CoverRaccoon angemeldet werden. CoverRaccoon benötigt ausschließlich eine Off-Chain-Signatur. Manche Safe-Konfigurationen wandeln Signaturanfragen in einen Transaktionsvorschlag um. Deshalb wurde keine Signaturanfrage gestartet.'
});

export const WALLET_TYPE_UNAVAILABLE = Object.freeze({
	ok: false,
	code: 'WALLET_TYPE_UNAVAILABLE',
	error: 'Der Wallet-Typ konnte gerade nicht sicher geprüft werden. Es wurde keine Signaturanfrage gestartet. Bitte gleich erneut versuchen.'
});

/**
 * Darf fuer diese Wallet-Art (contractCodeQuorum) eine Nachricht zum Signieren
 * ausgegeben werden? Nur fuer 'NONE' (EOA). Sonst die passende Ablehnung.
 */
export function signingRefusal(walletClass) {
	if (walletClass === 'NONE') return null;
	if (walletClass === 'CONTRACT') return { status: 422, body: CONTRACT_SIGNING_UNSUPPORTED };
	return { status: 503, body: WALLET_TYPE_UNAVAILABLE };
}
