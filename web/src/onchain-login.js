/*
	META-AUDIT M-3, Modus B (15.10.2026): Login, wenn Safe{Wallet} die Signatur in
	seine Standard-On-chain-Bestaetigung (SignMessageLib) umgewandelt hat.

	Erkennbar ist das erst NACH der Antwort der Safe: WalletConnect liefert '0x'
	statt einer Signatur, die Safe App { safeTxHash } statt messageHash. Dann
	wechselt der Client in Modus B und fragt den Server nur noch READ-ONLY ab -
	mit { wallet, token, approval: 'onchain' }. Er sendet NIE '0x' als Signatur,
	nie einen Hash, nie eine Transaktion. Ob die Owner ausgefuehrt haben, prueft
	allein der Server on-chain (beide Provider).

	Nur fuer den Dashboard-Login. Telegram-Link und frische Bestaetigungen
	(destruktive Aktionen) kennen diesen Weg nicht.
*/

/** Die Antwort von WalletConnect, wenn Safe on-chain signiert (safe-wallet-provider: '0x'). */
export const ONCHAIN_SIGNATURE_PLACEHOLDER = '0x';
export const ONCHAIN_POLL_INTERVAL_MS = 15_000;
export const ONCHAIN_POLL_TIMEOUT_MS = 30 * 60_000; // = Challenge-TTL fuer Contract-Wallets

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fragt den Server ab, bis er die On-chain-Freigabe bestaetigt (200) oder endgueltig
 * ablehnt. 202 (noch nicht ausgefuehrt), 429 (Budget) und 503 (RPC) -> weiter warten.
 */
export async function pollOnchainLogin({ wallet, token, fetchFn, headers = {}, onPending = () => {}, intervalMs = ONCHAIN_POLL_INTERVAL_MS, timeoutMs = ONCHAIN_POLL_TIMEOUT_MS, waitFn = wait, now = () => Date.now() }) {
	const started = now();
	while (now() - started < timeoutMs) {
		const response = await fetchFn('/api/dashboard', {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify({ wallet, token, approval: 'onchain' })
		});
		const result = await response.json().catch(() => null);
		if (response.status === 200 && result?.ok) return result;
		if (![202, 429, 503].includes(response.status)) throw new Error(result?.error || 'Die Safe-Freigabe konnte nicht bestätigt werden.');
		onPending(result?.code ?? 'ONCHAIN_APPROVAL_PENDING');
		await waitFn(intervalMs);
	}
	throw new Error('Die Safe-Freigabe wurde nicht rechtzeitig ausgeführt. Bitte neu starten.');
}

/**
 * Dashboard-Login nach der Wallet-Antwort (WalletConnect / Browser-Wallet).
 * Echte Signatur -> Modus A wie bisher. '0x' -> Modus B (nur Abfrage).
 */
export async function submitDashboardLogin({ wallet, token, signature, fetchFn, onPending, ...poll }) {
	if (signature === ONCHAIN_SIGNATURE_PLACEHOLDER) return pollOnchainLogin({ wallet, token, fetchFn, onPending, ...poll });
	const result = await fetchFn('/api/dashboard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet, token, signature }) }).then((res) => res.json());
	if (!result.ok) throw new Error(result.error);
	return result;
}
