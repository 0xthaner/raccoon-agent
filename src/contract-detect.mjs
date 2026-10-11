/*
	Read-only Contract-Erkennung auf Ethereum Mainnet.

	Dient AUSSCHLIESSLICH dazu, serverseitig zu entscheiden, ob eine Wallet ein
	deployter Contract ist (dann laengere Challenge-TTL fuer Safe-Multisig) oder
	eine EOA (bestehende kurze TTL). KEINE Sicherheitsentscheidung: die finale
	Autoritaet bleibt die ERC-1271-Pruefung in contract-signature.mjs.

	Chain fest Ethereum Mainnet (chainId 1), serverseitig, RPC ueber den
	vorhandenen ALCHEMY_API_KEY. Kein Client-Input. Bei RPC-Fehler oder fehlendem
	Schluessel wirft die Funktion; der Aufrufer behandelt das fail closed
	(kurze EOA-TTL, kein laengeres Fenster).

	AGENT-HARD-001: ein kurzlebiger (60 s) Best-Effort-Cache je Adresse deckelt
	wiederholte Alchemy-getCode-Aufrufe fuer dieselbe Wallet (Kosten-/Abuse-
	Daempfung). Der Cache ist NUR eine Optimierung der Contract-TTL-Erkennung -
	NICHT die Autoritaet fuer den Login; die ERC-1271-Signaturpruefung liest
	weiterhin live on-chain. Auf Vercel/serverless ist der Cache per warmer
	Instanz best effort; das ist fuer diese Optimierung akzeptabel (kein Redis,
	keine neue Infrastruktur). RPC-Fehler werden NIE als Klassifikation gecacht.
*/
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';

/** Best-Effort-Cache: normalisierte Adresse -> { isContract, expires }. */
export const CODE_CACHE_TTL_MS = 60_000;
const defaultCodeCache = new Map();

function defaultClient() {
	const apiKey = process.env.ALCHEMY_API_KEY?.trim();
	if (!apiKey) return null;
	// retryCount 0 (11.10.2026): der Browser gibt die Challenge-Anfrage nach 15 s
	// auf, viem wiederholte aber bis zu dreimal (zusammen rund 41 s) - Lesearbeit
	// im Hintergrund fuer eine Antwort, die niemand mehr abholt. Ein Fehler faellt
	// ohnehin geschlossen auf die kurze EOA-TTL zurueck.
	return createPublicClient({
		chain: mainnet,
		transport: http(`https://eth-mainnet.g.alchemy.com/v2/${apiKey}`, { timeout: 10_000, retryCount: 0 })
	});
}

/**
 * Ist `address` auf Mainnet ein deployter Contract? `getCode` ist fuer Tests
 * injizierbar, ebenso `cache`/`now` (fuer deterministische Cache-Tests). Wirft
 * bei fehlendem Schluessel oder RPC-Fehler - der Aufrufer faellt dann auf die
 * kurze (EOA-)TTL zurueck (fail closed). Ein RPC-Fehler wird NICHT gecacht.
 */
export async function isDeployedContract(address, { getCode = null, client, cache = defaultCodeCache, now = Date.now() } = {}) {
	const key = typeof address === 'string' ? address.toLowerCase() : '';
	const hit = key && cache.get(key);
	if (hit && hit.expires > now) return hit.isContract;

	let codeOf = getCode;
	if (!codeOf) {
		const c = client ?? defaultClient();
		if (!c) throw new Error('Contract-Erkennung nicht konfiguriert.');
		codeOf = (addr) => c.getCode({ address: addr });
	}
	// Wirft bei RPC-Fehler -> propagiert (wird NICHT gecacht).
	const code = await codeOf(address);
	const isContract = Boolean(code && code !== '0x');
	if (key) cache.set(key, { isContract, expires: now + CODE_CACHE_TTL_MS });
	return isContract;
}
