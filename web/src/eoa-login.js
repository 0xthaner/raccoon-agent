/*
	AGENT-UX-5: kleinste provider-unabhaengige Logik des injizierten EOA-Logins,
	damit sie isoliert testbar ist. KEIN DOM, KEIN globaler Zustand.

	Zweck: vor der SIWE-Challenge sicherstellen, dass die Browser-Wallet auf
	Ethereum Mainnet (0x1) steht, und den tatsaechlich aktiven Account NACH dem
	Netzwechsel erneut lesen - damit Challenge-Adresse und signierender Account
	nie durch einen Provider-State-Change auseinanderlaufen. Alles fail closed.
*/

export const MAINNET_HEX = '0x1';

export function normalizeAddress(address) {
	return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : null;
}

export function eoaLoginTexts(language) {
	const de = language === 'de';
	return {
		switchFailed: de
			? 'Für die Anmeldung muss die Wallet auf Ethereum Mainnet stehen. Bitte wechsle das Netzwerk und versuche es erneut.'
			: 'Sign-in requires your wallet on Ethereum Mainnet. Please switch the network and try again.',
		notMainnet: de ? 'Die Wallet ist nicht auf Ethereum Mainnet.' : 'Your wallet is not on Ethereum Mainnet.',
		noAccount: de
			? 'Keine aktive Wallet-Adresse gefunden. Bitte starte die Anmeldung erneut.'
			: 'No active wallet account found. Please start sign-in again.',
		accountChanged: de
			? 'Die aktive Wallet-Adresse hat sich geändert. Bitte starte die Anmeldung erneut.'
			: 'The active wallet account changed. Please start sign-in again.',
		chainChanged: de
			? 'Das Netzwerk der Wallet hat sich geändert. Bitte starte die Anmeldung erneut.'
			: 'The wallet network changed. Please start sign-in again.',
		connectTimeout: de
			? 'Die Wallet hat nicht auf die Verbindungsanfrage reagiert. Öffne die Wallet, prüfe offene Anfragen und versuche es erneut.'
			: 'Your wallet did not respond to the connection request. Open your wallet, check for pending requests and try again.',
		switchTimeout: de
			? 'Die Wallet hat den Wechsel zu Ethereum Mainnet nicht bestätigt. Öffne die Wallet und versuche es erneut.'
			: 'Your wallet did not confirm the switch to Ethereum Mainnet. Open your wallet and try again.',
		signTimeout: de
			? 'Die Wallet hat nicht auf die Signaturanfrage reagiert. Bitte starte die Anmeldung erneut.'
			: 'Your wallet did not respond to the signature request. Please start sign-in again.',
		rejected: de
			? 'Die Anfrage wurde in der Wallet abgelehnt. Du kannst die Anmeldung jederzeit erneut starten.'
			: 'The request was rejected in your wallet. You can start sign-in again at any time.',
		locked: de
			? 'Die Wallet ist gesperrt oder hat noch eine offene Anfrage. Entsperre die Wallet, schließe offene Anfragen und versuche es erneut.'
			: 'Your wallet is locked or still has a pending request. Unlock it, close pending requests and try again.',
		network: de
			? 'Die Verbindung zur Wallet oder zum Server ist gestört. Prüfe die Internetverbindung und versuche es erneut.'
			: 'The connection to your wallet or the server failed. Check your internet connection and try again.',
		providerError: de
			? 'Die Wallet hat einen unerwarteten Fehler gemeldet. Bitte versuche es erneut.'
			: 'Your wallet reported an unexpected error. Please try again.',
		busy: de ? 'Eine Anmeldung läuft bereits.' : 'A sign-in is already in progress.',
		walletDisconnected: de
			? 'Die Wallet hat die Verbindung getrennt. Bitte starte die Anmeldung erneut.'
			: 'Your wallet disconnected. Please start sign-in again.'
	};
}

/*
	Timeouts und verspaetete Antworten (24.10.2026). Ein Timeout bricht die an die
	Wallet gesendete Anfrage NICHT ab: MetaMask oder WalletConnect koennen spaeter
	noch antworten. Deshalb gehoert jeder Schritt zu genau einem Anmeldeversuch.
	Laeuft die Zeit ab, wird der Versuch beendet; jede spaetere Antwort faellt
	weg, und an jeder Grenze vor Challenge, Signatur und POST wird geprueft, ob
	der Versuch noch gilt. Abmelden beendet ihn ebenso. Es gibt nie mehr als einen
	laufenden Versuch, und nichts wird automatisch wiederholt.

	Ungueltig und freigegeben sind zwei Schritte (Review M1, 25.10.2026): ein
	Timeout, ein Disconnect oder ein Abmelden ENTWERTET den Versuch sofort, und
	seine wartenden Wallet-Schritte brechen ab. Die Sperre gibt er aber erst am
	Ende seines finally frei, nach dem Aufraeumen (Trennen, Freigabe entziehen).
	Sonst koennte dieses Aufraeumen einen inzwischen gestarteten neuen Versuch
	treffen. Wird die Sperre frei, laufen die onIdle-Haken (Review M2).
*/
export const WALLET_TIMEOUTS = Object.freeze({ connect: 120_000, switchChain: 60_000, sign: 60_000 });

export class WalletTimeoutError extends Error {
	constructor(message) { super(message); this.name = 'WalletTimeoutError'; }
}

export class StaleAttemptError extends Error {
	constructor() { super('stale login attempt'); this.name = 'StaleAttemptError'; }
}

/**
 * Hoechstens ein laufender Versuch; begin() liefert null, solange die Sperre
 * gehalten wird. `expire()` entwertet, `end()` entwertet und gibt frei.
 * `begin({ cleanup: true })` markiert eine reine Aufraeum-Sperre: ihr Ende
 * loest keine onIdle-Haken aus (sonst endlose Trenn-Versuche).
 */
export function createLoginAttempts() {
	let aktiv = null;
	let zaehler = 0;
	const idleHaken = new Set();
	return {
		begin({ cleanup = false } = {}) {
			if (aktiv) return null;
			const eintrag = { id: ++zaehler, gueltig: true, beiAblauf: new Set() };
			aktiv = eintrag;
			const expire = () => {
				if (!eintrag.gueltig) return;
				eintrag.gueltig = false;
				for (const fn of [...eintrag.beiAblauf]) fn();
				eintrag.beiAblauf.clear();
			};
			eintrag.expire = expire;
			return {
				id: eintrag.id,
				isCurrent: () => eintrag.gueltig,
				expire,
				/** fn laeuft beim Entwerten (sofort, falls schon entwertet); Rueckgabe meldet ab. */
				onExpire(fn) {
					if (!eintrag.gueltig) { fn(); return () => {}; }
					eintrag.beiAblauf.add(fn);
					return () => eintrag.beiAblauf.delete(fn);
				},
				end: () => {
					expire();
					if (aktiv !== eintrag) return;
					aktiv = null;
					if (!cleanup) for (const fn of [...idleHaken]) fn();
				}
			};
		},
		/** Abmelden: entwertet den laufenden Versuch; frei wird die Sperre in dessen finally. */
		invalidate() { aktiv?.expire(); },
		/** fn laeuft jedes Mal, wenn ein (Nicht-Aufraeum-)Versuch die Sperre freigibt. */
		onIdle(fn) { idleHaken.add(fn); return () => idleHaken.delete(fn); },
		get busy() { return aktiv !== null; }
	};
}

/**
 * Wartet hoechstens `ms` auf `promise`. Bei Ablauf wird der Versuch entwertet
 * und WalletTimeoutError geworfen; eine spaetere Antwort wird verworfen. Wird
 * der Versuch vorher entwertet (Abmelden, Trennen), endet der Schritt sofort
 * mit StaleAttemptError - auch wenn die Wallet nie antwortet.
 */
export function walletStep(promise, { attempt, ms, message }) {
	return new Promise((resolve, reject) => {
		let abmelden = () => {};
		const fertig = () => { clearTimeout(timer); abmelden(); };
		const timer = setTimeout(() => {
			fertig();
			if (!attempt.isCurrent()) return reject(new StaleAttemptError());
			attempt.expire();
			reject(new WalletTimeoutError(message));
		}, ms);
		abmelden = attempt.onExpire(() => { clearTimeout(timer); reject(new StaleAttemptError()); });
		Promise.resolve(promise).then(
			(value) => { fertig(); if (attempt.isCurrent()) resolve(value); else reject(new StaleAttemptError()); },
			(error) => { fertig(); reject(attempt.isCurrent() ? error : new StaleAttemptError()); }
		);
	});
}

/**
 * Nutzerlesbare Meldung zu einem Fehler im Anmeldeablauf. Eigene Meldungen
 * (Mainnet, Account, Server) bleiben, Wallet-Fehler werden auf feste Texte
 * abgebildet, damit kein Provider-Innenleben in der Oberflaeche landet.
 */
export function walletErrorMessage(error, texts) {
	if (error instanceof WalletTimeoutError) return error.message;
	const code = error?.code;
	const text = String(error?.message ?? '');
	if (Object.values(texts).includes(text)) return text;
	if (code === 4001 || code === 'ACTION_REJECTED' || /user (rejected|denied|cancel)/i.test(text)) return texts.rejected;
	if (code === -32002 || /already pending|locked|unlock/i.test(text)) return texts.locked;
	if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || error instanceof TypeError || /network (error|request failed)|failed to fetch|websocket|socket hang up|relay|offline/i.test(text)) return texts.network;
	if (code !== undefined) return texts.providerError;
	return text || texts.providerError;
}

// Timeout und abgelaufener Versuch duerfen nicht zu "anderes Netz"/"kein Account" werden.
function rethrowGuard(fallback) {
	return (error) => {
		if (error instanceof WalletTimeoutError || error instanceof StaleAttemptError) throw error;
		return fallback;
	};
}

/**
 * Stellt die injizierte Wallet auf Mainnet und liefert den verifizierten,
 * aktuell aktiven Account (lowercase) zurueck. Wirft bei jedem Problem mit
 * nutzerlesbarer Meldung (fail closed): abgelehnter/zwecklos gebliebener
 * Netzwechsel, kein Account, geaenderter Account, oder Abbruch durch einen
 * zwischenzeitlichen chainChanged.
 *
 * `provider`  injizierte EIP-1193-Wallet (window.ethereum)
 * `expectedAccount` die beim Verbinden gelesene Adresse
 * `texts`     lokalisiertе Meldungen (eoaLoginTexts)
 * `isAborted` liefert true, wenn ein chainChanged den Versuch entwertet hat
 */
export async function ensureMainnetAccount(provider, expectedAccount, { texts, isAborted = () => false, step = (promise) => promise } = {}) {
	const expected = normalizeAddress(expectedAccount);

	let chainId = await step(provider.request({ method: 'eth_chainId' })).catch(rethrowGuard(null));
	if (chainId !== MAINNET_HEX) {
		try {
			await step(provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: MAINNET_HEX }] }));
		} catch (error) {
			rethrowGuard()(error);
			throw new Error(texts.switchFailed);
		}
		if (isAborted()) throw new Error(texts.chainChanged);
		chainId = await step(provider.request({ method: 'eth_chainId' })).catch(rethrowGuard(null));
		if (chainId !== MAINNET_HEX) throw new Error(texts.notMainnet);
	}
	if (isAborted()) throw new Error(texts.chainChanged);

	// Account NACH dem Netzwechsel erneut lesen - nie stillschweigend die alte Adresse.
	const accounts = await step(provider.request({ method: 'eth_accounts' })).catch(rethrowGuard([]));
	const current = normalizeAddress(Array.isArray(accounts) ? accounts[0] : null);
	if (!current) throw new Error(texts.noAccount);
	if (expected && current !== expected) throw new Error(texts.accountChanged);
	if (isAborted()) throw new Error(texts.chainChanged);
	return current;
}

/**
 * Fuehrt die SIWE-Sequenz Challenge -> Signatur -> Verifikation aus und prueft
 * an JEDER Grenze `isAborted()`: vor der Challenge, nach der Challenge/vor der
 * Signatur und nach der Signatur/vor dem Verifikations-POST. So kann ein
 * zwischenzeitlicher chainChanged den laufenden injizierten EOA-Login fail
 * closed stoppen, ohne dass noch signiert oder gepostet wird.
 *
 * Seiteneffekte sind injiziert (getChallenge/sign/submit), damit die Race
 * offline testbar ist. Fuer den WalletConnect-Pfad ist `isAborted` die Vorgabe
 * `() => false`, also laufen die Grenzpruefungen leer - Verhalten unveraendert.
 */
/**
 * AGENT-UX-5 (WalletConnect/AppKit): synchronisiert die verbundene Wallet auf
 * Ethereum Mainnet und liefert den verifizierten aktiven Account zurueck.
 *
 * `modal.switchNetwork(network, {throwOnFailure:true})` wird IMMER aufgerufen -
 * auch wenn `modal.getChainId()` bereits 1 meldet -, weil die installierte
 * AppKit-Implementierung den Wechsel ohne Chain-Vergleich an die Wallet
 * weiterreicht (wallet_switchEthereumChain) und so MetaMask wirklich umschaltet.
 * Ein `if (getChainId() !== 1)` wuerde genau den UX-Bug reproduzieren.
 *
 * Danach: AppKit-Chain muss 1 sein, Account erneut lesen, fail closed bei
 * fehlendem/geaendertem Account. Alles injizierbar fuer Offline-Tests.
 */
export async function ensureAppKitMainnetAccount({ modal, network, expectedAddress, texts, step = (promise) => promise }) {
	try {
		await step(modal.switchNetwork(network, { throwOnFailure: true }));
	} catch (error) {
		rethrowGuard()(error);
		throw new Error(texts.switchFailed);
	}
	if (Number(modal.getChainId()) !== 1) throw new Error(texts.notMainnet);
	const current = normalizeAddress(modal.getAddress());
	if (!current) throw new Error(texts.noAccount);
	const expected = normalizeAddress(expectedAddress);
	if (expected && current !== expected) throw new Error(texts.accountChanged);
	return current;
}

export async function guardedChallengeSignSubmit({ isAborted = () => false, isCurrent = () => true, texts, getChallenge, sign, submit }) {
	const stop = () => {
		if (!isCurrent()) throw new StaleAttemptError();
		if (isAborted()) throw new Error(texts.chainChanged);
	};
	stop();
	const challenge = await getChallenge();
	if (!challenge || !challenge.ok) throw new Error(challenge?.error || 'challenge failed');
	stop();
	const signature = await sign(challenge.message);
	stop();
	return submit(challenge, signature);
}
