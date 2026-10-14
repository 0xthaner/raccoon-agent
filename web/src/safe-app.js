/*
	Native Safe-App-Flow fuer CoverRaccoon.

	Laeuft nur, wenn CoverRaccoon als Safe App im iframe von Safe{Wallet} geoeffnet
	ist. Die Safe-UI koordiniert Owner-Bestaetigungen und den Transaction Service
	selbst; wir bauen KEINE eigene Multisig-Krypto, keine Aggregation, keinen
	Threshold-Code und keinen eigenen Hash. Identitaet ist am Ende ausschliesslich
	das serverseitig per ERC-1271 gepruefte Ergebnis - SDK-Daten dienen nur der UX.

	Diese Datei ist bewusst frei von Top-Level-Abhaengigkeiten und DOM-Zugriffen:
	das SDK, fetch, Warten und Zeit werden injiziert, damit der Flow offline
	testbar ist.
*/

export const SAFE_ORIGIN = 'https://app.safe.global';
export const SAFE_LOGIN_CHAIN_ID = 1;

export const SAFE_STATES = Object.freeze([
	'SAFE_CONTEXT_DETECTED',
	'CHALLENGE_CREATED',
	'SIGNATURE_PENDING',
	'WAITING_FOR_OWNERS',
	'SIGNATURE_READY',
	'VERIFYING',
	'AUTHENTICATED',
	'EXPIRED',
	'REJECTED'
]);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Erkennt den Safe-App-Kontext. `loadSdk` liefert die SafeAppsSDK-Klasse (per
 * dynamischem Import). `getInfo` blockt ausserhalb eines Safe-iframes, deshalb
 * ein enger Timeout. Rueckgabe {sdk, info} oder null (dann normaler Browser).
 */
export async function detectSafeContext(loadSdk, { timeoutMs = 2000 } = {}) {
	try {
		const SafeAppsSDK = await loadSdk();
		const sdk = new SafeAppsSDK({ allowedDomains: [/^https:\/\/app\.safe\.global$/] });
		const info = await Promise.race([
			sdk.safe.getInfo(),
			new Promise((_, reject) => setTimeout(() => reject(new Error('safe-context-timeout')), timeoutMs))
		]);
		if (!info || typeof info.safeAddress !== 'string') return null;
		return { sdk, info };
	} catch {
		return null;
	}
}

/**
 * Laesst die Safe genau `message` OFF-CHAIN signieren und wartet auf die fertige
 * Signatur. Gemeinsamer Weg fuer den Login und fuer frische Bestaetigungen
 * (AUDIT SA-L1): erst muss die Safe-Oberflaeche Off-chain-Signieren bestaetigen,
 * sonst gibt es KEINE Signaturanfrage (sonst schluege Safe eine On-chain-
 * Transaktion ueber SignMessageLib vor). Kein eigener Hash, kein Typed Data,
 * keine Transaktion. Wirft (fail closed), nachdem der passende Zustand gemeldet wurde.
 */
export async function signSafeMessage({ sdk, message, threshold, onState = () => {}, pollIntervalMs = 5000, pollTimeoutMs = 25 * 60_000, waitFn = wait, now = () => Date.now() }) {
	// Off-chain-Signing aktivieren, sonst wuerde Safe on-chain signieren (Transaktion).
	// AUDIT-2026-10-12 F2: das Ergebnis pruefen (laut SDK "Returns the new
	// SafeSettings"). Bestaetigt die Safe-Oberflaeche das Off-chain-Signieren nicht,
	// gibt es KEINE Signaturanfrage - sonst schlaegt Safe statt einer Nachricht eine
	// On-chain-Transaktion (SignMessageLib) in der Warteschlange vor.
	const settings = await sdk.eth.setSafeSettings([{ offChainSigning: true }]);
	if (settings?.offChainSigning !== true) {
		onState('REJECTED', { reason: 'offchain-signing-unavailable' });
		throw new Error('Diese Safe-Oberfläche bestätigt kein Off-chain-Signieren. Es wird keine Signatur angefragt.');
	}
	onState('SIGNATURE_PENDING', { threshold });

	// Exakt die serverseitige SIWE-Nachricht. Keine eigene Hash-/Typed-Data-Logik.
	const signed = await sdk.txs.signMessage(message);
	const messageHash = signed && signed.messageHash;
	if (!messageHash) {
		onState('REJECTED', { reason: 'no-message-hash' });
		throw new Error('Safe hat keinen Message-Hash geliefert.');
	}
	onState('WAITING_FOR_OWNERS', { threshold, confirmations: 0 });

	// Die Safe-UI sammelt die weiteren Owner. Wir pollen nur read-only nach der
	// fertigen Signatur. getOffChainSignature liefert '' bis der Threshold erreicht ist.
	const started = now();
	let signature = '';
	while (now() - started < pollTimeoutMs) {
		signature = await sdk.safe.getOffChainSignature(messageHash).catch(() => '');
		if (signature) break;
		await waitFn(pollIntervalMs);
	}
	if (!signature) {
		onState('EXPIRED');
		throw new Error('Das Signaturfenster ist abgelaufen.');
	}
	onState('SIGNATURE_READY');
	return signature;
}

/**
 * Fuehrt den Safe-Multisig-Login aus. Alle Seiteneffekte sind injiziert:
 *  - sdk:    Safe Apps SDK (safe.getInfo liefert bereits `info`)
 *  - info:   {safeAddress, chainId, threshold, owners}
 *  - fetchFn: fetch
 *  - onState(state, detail): UX-Callback
 *  - waitFn/now: fuer Tests
 *
 * Rueckgabe bei Erfolg: {sessionToken, dashboard}. Sonst wirft sie (fail closed),
 * nachdem der passende Endzustand gemeldet wurde.
 */
export async function runSafeLogin({
	sdk,
	info,
	fetchFn,
	onState = () => {},
	pollIntervalMs = 5000,
	pollTimeoutMs = 25 * 60_000,
	waitFn = wait,
	now = () => Date.now()
}) {
	if (info.chainId !== SAFE_LOGIN_CHAIN_ID) {
		onState('REJECTED', { reason: 'chain', chainId: info.chainId });
		throw new Error('CoverRaccoon Safe Login ist derzeit nur auf Ethereum Mainnet verfügbar.');
	}
	const wallet = info.safeAddress;
	onState('SAFE_CONTEXT_DETECTED', { wallet, threshold: info.threshold });

	const challenge = await fetchFn(`/api/dashboard?wallet=${encodeURIComponent(wallet)}`).then((r) => r.json());
	if (!challenge || !challenge.ok) {
		onState('EXPIRED');
		throw new Error(challenge?.error || 'Challenge konnte nicht erstellt werden.');
	}
	onState('CHALLENGE_CREATED', { threshold: info.threshold });

	const signature = await signSafeMessage({ sdk, message: challenge.message, threshold: info.threshold, onState, pollIntervalMs, pollTimeoutMs, waitFn, now });

	onState('VERIFYING');
	const login = await fetchFn('/api/dashboard', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'X-Dashboard-Transport': 'bearer' },
		body: JSON.stringify({ wallet, token: challenge.token, signature })
	}).then((r) => r.json());
	if (!login || !login.ok) {
		onState('REJECTED', { reason: 'backend' });
		throw new Error(login?.error || 'Anmeldung konnte nicht bestätigt werden.');
	}
	onState('AUTHENTICATED', { wallet });
	// Bearer-Token nur im Speicher des Aufrufers; nie persistieren, nie loggen.
	return { sessionToken: login.sessionToken || null, dashboard: login };
}
