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

/*
	AGENT-UX-5 (WalletConnect): zusaetzlich `wallet_switchEthereumChain`. Grund:
	`personal_sign` ist chain-agnostisch, MetaMask Mobile zeigt beim Signieren sein
	eigenes aktives Netz (z. B. Polygon), obwohl die SIWE-Nachricht Chain ID 1
	traegt. AppKits `modal.switchNetwork(mainnet)` synchronisiert die Wallet - es
	schickt dafuer ueber die WC-Session `wallet_switchEthereumChain`, das aber nur
	funktioniert, wenn die Methode in der Session genehmigt ist.

	`wallet_switchEthereumChain` ist NICHT werttragend: es kann KEINE Transaktion
	senden, KEIN Token freigeben, KEIN Permit erzeugen, KEINE (typisierte oder
	sonstige) Signatur ausloesen und KEINE Transaktion signieren - es bittet die
	Wallet ausschliesslich, das aktive Netz zu wechseln (mit Nutzerbestaetigung).
	`wallet_addEthereumChain` wird bewusst NICHT aufgenommen (Mainnet existiert in
	jeder Wallet; kein Add noetig).
*/
export const WALLET_METHODEN_ANMELDEN = [...BASIS, 'personal_sign', 'wallet_switchEthereumChain'];

/** Die Gesamtmenge. Keine Stelle im Frontend darf darueber hinausgehen. */
export const WALLET_METHODEN_ALLE = [...WALLET_METHODEN_ANMELDEN];

/** Formt die Liste in die Gestalt, die `createAppKit` erwartet. */
export function appKitMethoden(methoden) {
	return { methods: { eip155: [...methoden] } };
}
