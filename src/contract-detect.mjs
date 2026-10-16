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
/*
	AUDIT-2026-10-12 F3: der Cache hatte keine Obergrenze. Eintraege verfielen nur,
	wenn dieselbe Adresse erneut abgefragt wurde; jede neue Adresse blieb fuer die
	Lebensdauer der warmen Instanz liegen. Jetzt hoechstens CODE_CACHE_MAX_ENTRIES:
	abgelaufene zuerst, dann die aeltesten.
*/
export const CODE_CACHE_MAX_ENTRIES = 1_000;
const BYTECODE = /^0x(?:[0-9a-fA-F]{2})+$/;
const defaultCodeCache = new Map();

function remember(cache, key, entry, now) {
	cache.delete(key);
	cache.set(key, entry);
	if (cache.size <= CODE_CACHE_MAX_ENTRIES) return;
	for (const [k, v] of cache) if (!(v.expires > now)) cache.delete(k);
	while (cache.size > CODE_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

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
	// Restaudit L4: nur leerer Code (viem: undefined, roh: '0x', oder null) ist eine EOA,
	// nur wohlgeformter Bytecode ein Contract. Alles andere (kaputte oder manipulierte
	// Antwort) wirft wie ein RPC-Fehler - nicht gecacht, der Aufrufer nimmt die kurze
	// EOA-TTL. Vorher galt jede nicht leere Antwort als Contract (lange TTL).
	if (code != null && code !== '0x' && !(typeof code === 'string' && BYTECODE.test(code))) throw new Error('Unerwartete getCode-Antwort.');
	const isContract = typeof code === 'string' && BYTECODE.test(code);
	if (key) remember(cache, key, { isContract, expires: now + CODE_CACHE_TTL_MS }, now);
	return isContract;
}
