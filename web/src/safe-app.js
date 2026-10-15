/*
	Native Safe-App-Flow fuer CoverRaccoon.

	Laeuft nur, wenn CoverRaccoon als Safe App im iframe von Safe{Wallet} geoeffnet
	ist. Die Safe-UI koordiniert Owner-Bestaetigungen und den Transaction Service
	selbst; wir bauen KEINE eigene Multisig-Krypto, keine Aggregation, keinen
	Threshold-Code und keinen eigenen Hash. Identitaet ist am Ende ausschliesslich
	das serverseitig per ERC-1271 gepruefte Ergebnis - SDK-Daten dienen nur der UX.

	Diese Datei ist bewusst frei von Top-Level-Abhaengigkeiten und DOM-Zugriffen:
	das SDK, fetch, Warten und Zeit werden injiziert, damit der Flow offline
	testbar ist. Einzige Ausnahme: der ebenso abhaengigkeitsfreie Modus-B-Helfer.
*/
import { ONCHAIN_POLL_INTERVAL_MS, pollOnchainLogin } from './onchain-login.js';

export const SAFE_ORIGIN = 'https://app.safe.global';
export const SAFE_LOGIN_CHAIN_ID = 1;

export const SAFE_STATES = Object.freeze([
	'SAFE_CONTEXT_DETECTED',
	'CHALLENGE_CREATED',
	'SIGNATURE_PENDING',
	'WAITING_FOR_OWNERS',
	'SIGNATURE_READY',
	'ONCHAIN_APPROVAL_PENDING',
	'VERIFYING',
	'AUTHENTICATED',
	'EXPIRED',
	'REJECTED'
]);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rueckgabe von signSafeMessage, wenn Safe on-chain (SignMessageLib) signiert. Nur im Login erlaubt. */
export const ONCHAIN_APPROVAL = Symbol('ONCHAIN_APPROVAL');
const SAFE_TX_HASH = /^0x[0-9a-fA-F]{64}$/;

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
export async function signSafeMessage({ sdk, message, threshold, onState = () => {}, pollIntervalMs = 5000, pollTimeoutMs = 25 * 60_000, waitFn = wait, now = () => Date.now(), allowOnchainApproval = false }) {
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
	// META-AUDIT M-3, Modus B: Safe hat statt einer Off-chain-Signatur seine
	// SignMessageLib-Bestaetigung vorgeschlagen (safeTxHash, kein messageHash).
	// Nur der Dashboard-Login darf darauf warten; frische Bestaetigungen nicht.
	if (!messageHash && allowOnchainApproval && SAFE_TX_HASH.test(signed?.safeTxHash ?? '')) return ONCHAIN_APPROVAL;
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
 * Rueckgabe bei Erfolg: {dashboard}. Sonst wirft sie (fail closed),
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

	const signature = await signSafeMessage({ sdk, message: challenge.message, threshold: info.threshold, onState, pollIntervalMs, pollTimeoutMs, waitFn, now, allowOnchainApproval: true });

	if (signature === ONCHAIN_APPROVAL) {
		// Nur noch read-only: der Server prueft on-chain, ob die Owner ausgefuehrt haben.
		onState('ONCHAIN_APPROVAL_PENDING', { threshold: info.threshold });
		let login;
		try {
			login = await pollOnchainLogin({ wallet, token: challenge.token, fetchFn, headers: { 'X-Dashboard-Transport': 'partitioned-cookie' }, intervalMs: ONCHAIN_POLL_INTERVAL_MS, timeoutMs: pollTimeoutMs, waitFn, now });
		} catch (error) {
			onState('EXPIRED');
			throw error;
		}
		onState('AUTHENTICATED', { wallet });
		return { dashboard: withoutToken(login) };
	}

	onState('VERIFYING');
	const login = await fetchFn('/api/dashboard', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'X-Dashboard-Transport': 'partitioned-cookie' },
		body: JSON.stringify({ wallet, token: challenge.token, signature })
	}).then((r) => r.json());
	if (!login || !login.ok) {
		onState('REJECTED', { reason: 'backend' });
		throw new Error(login?.error || 'Anmeldung konnte nicht bestätigt werden.');
	}
	onState('AUTHENTICATED', { wallet });
	// Die Sitzung liegt im partitionierten HttpOnly-Cookie; ein Token gibt es nicht.
	return { dashboard: withoutToken(login) };
}

/** Ein Sitzungstoken, das ein (alter) Server doch mitschickt, gelangt nie in den Frontend-Zustand. */
function withoutToken(login) {
	const { sessionToken: _ignored, ...dashboard } = login;
	return dashboard;
}

/*
	Safe-App-Reload: Eine bestehende Sitzung (partitioniertes HttpOnly-Cookie)
	ueberlebt einen Reload von app.safe.global. Bevor ein neuer Login mit Signatur
	startet, wird deshalb einmal gelesen - nur das, kein Schreiben:
	GET /api/dashboard ohne Authorization; das Cookie schickt der Browser selbst.

	Uebernommen wird das Ergebnis NUR bei Status 200, `ok: true` und GENAU derselben
	Safe-Adresse auf Mainnet. Alles andere (401, anderer Status, Zeitueberschreitung,
	Netzfehler, unlesbare Antwort, fehlende oder ANDERE Wallet) -> null, und der Login
	laeuft wie bisher. Daten einer anderen Wallet werden nie zurueckgegeben. Die
	Sitzung selbst prueft weiterhin allein der Server (HMAC, Widerruf, Contract).
*/
export const SAFE_RESTORE_TIMEOUT_MS = 8000;
const SAFE_ADDRESS = /^0x[0-9a-f]{40}$/;

export async function restoreSafeSession({ info, fetchFn, timeoutMs = SAFE_RESTORE_TIMEOUT_MS }) {
	const wallet = typeof info?.safeAddress === 'string' ? info.safeAddress.toLowerCase() : '';
	if (info?.chainId !== SAFE_LOGIN_CHAIN_ID || !SAFE_ADDRESS.test(wallet)) return null;
	const controller = typeof AbortController === 'function' ? new AbortController() : null;
	let timer;
	try {
		const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller?.abort(); reject(new Error('restore timeout')); }, timeoutMs); });
		const response = await Promise.race([fetchFn('/api/dashboard', controller ? { signal: controller.signal } : {}), timeout]);
		if (!response || response.status !== 200) return null;
		const dashboard = await Promise.race([response.json(), timeout]);
		if (!dashboard || typeof dashboard !== 'object' || Array.isArray(dashboard) || dashboard.ok !== true) return null;
		if (typeof dashboard.wallet !== 'string' || dashboard.wallet.toLowerCase() !== wallet) return null;
		return dashboard;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Start der Safe App: erst eine bestehende Sitzung derselben Safe uebernehmen
 * (ohne Signatur), sonst runSafeLogin. Rueckgabe { dashboard, restored }.
 */
export async function startSafeApp({ sdk, info, fetchFn, onState = () => {}, restoreTimeoutMs, runLogin = runSafeLogin, ...login }) {
	const restored = await restoreSafeSession({ info, fetchFn, timeoutMs: restoreTimeoutMs });
	if (restored) {
		onState('AUTHENTICATED', { wallet: info.safeAddress, restored: true });
		return { dashboard: restored, restored: true };
	}
	return { ...(await runLogin({ sdk, info, fetchFn, onState, ...login })), restored: false };
}
