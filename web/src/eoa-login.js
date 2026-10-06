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
			: 'The wallet network changed. Please start sign-in again.'
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
export async function ensureMainnetAccount(provider, expectedAccount, { texts, isAborted = () => false } = {}) {
	const expected = normalizeAddress(expectedAccount);

	let chainId = await provider.request({ method: 'eth_chainId' }).catch(() => null);
	if (chainId !== MAINNET_HEX) {
		try {
			await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: MAINNET_HEX }] });
		} catch {
			throw new Error(texts.switchFailed);
		}
		if (isAborted()) throw new Error(texts.chainChanged);
		chainId = await provider.request({ method: 'eth_chainId' }).catch(() => null);
		if (chainId !== MAINNET_HEX) throw new Error(texts.notMainnet);
	}
	if (isAborted()) throw new Error(texts.chainChanged);

	// Account NACH dem Netzwechsel erneut lesen - nie stillschweigend die alte Adresse.
	const accounts = await provider.request({ method: 'eth_accounts' }).catch(() => []);
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
export async function guardedChallengeSignSubmit({ isAborted = () => false, texts, getChallenge, sign, submit }) {
	const stop = () => { throw new Error(texts.chainChanged); };
	if (isAborted()) stop();
	const challenge = await getChallenge();
	if (!challenge || !challenge.ok) throw new Error(challenge?.error || 'challenge failed');
	if (isAborted()) stop();
	const signature = await sign(challenge.message);
	if (isAborted()) stop();
	return submit(challenge, signature);
}
