/*
	AGENT-SEC-W1: WAS DIE WALLET-SITZUNG ERLAUBEN DARF.

	AppKit haengt ohne eigene Angabe seine Vorgabe in die Sitzung - vierundzwanzig
	Methoden, nachzulesen in `DEFAULT_METHODS.eip155` von `@reown/appkit-utils`.
	Darunter `eth_sendTransaction`, das blinde `eth_sign`, die gebuendelten
	Aufrufe aus EIP-5792 (`wallet_sendCalls`) und - am unangenehmsten -
	`wallet_grantPermissions` aus EIP-7715, also delegierte Rechte, die spaetere
	Transaktionen ganz ohne Rueckfrage erlauben sollen.

	Diese Anwendung braucht davon genau EINE: `personal_sign`. Sie fragt nie eine
	Transaktion an, nie eine Freigabe, nie eine typisierte Signatur. Also soll die
	Sitzung das auch gar nicht erst hergeben. Ein Wallet zeigt beim Verbinden, was
	es erteilt; wer hier nur signieren will, soll auch nur um Signieren bitten.

	Der Unterschied zum Waechter in `dashboard-auth-boundaries.test.mjs`: jener
	prueft, dass UNSER Code nichts Gefaehrliches aufruft. Diese Liste legt fest,
	worum wir die Wallet ueberhaupt bitten.

	Mehr als eine Bitte ist sie aber nicht. Ob die Wallet sich daran haelt,
	entscheidet die Wallet: MetaMask Mobile genehmigt trotzdem seine volle Liste,
	`eth_sendTransaction` eingeschlossen (am 30.09.2026 in der ausgehandelten
	Sitzung nachgesehen). Die eigentliche Grenze zieht deshalb AGENT-SEC-W2 in
	`main.js`: die Sitzung wird direkt nach der Signatur getrennt.

	AppKit nimmt die Liste ueber `universalProviderConfigOverride.methods`
	entgegen und ERSETZT damit die Vorgabe, statt sie zu ergaenzen
	(`WcHelpersUtil.applyNamespaceOverrides`).
*/

/** Verbinden und Adresse lesen. Ohne diese beiden gibt es keine Sitzung. */
const BASIS = ['eth_requestAccounts', 'eth_accounts'];

/** Der Anmeldeweg: eine Klartextsignatur, sonst nichts. */
export const WALLET_METHODEN_ANMELDEN = [...BASIS, 'personal_sign'];

/** Die Gesamtmenge. Keine Stelle im Frontend darf darueber hinausgehen. */
export const WALLET_METHODEN_ALLE = [...WALLET_METHODEN_ANMELDEN];

/** Formt die Liste in die Gestalt, die `createAppKit` erwartet. */
export function appKitMethoden(methoden) {
	return { methods: { eip155: [...methoden] } };
}
