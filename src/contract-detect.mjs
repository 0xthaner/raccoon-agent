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
*/
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';

function defaultClient() {
	const apiKey = process.env.ALCHEMY_API_KEY?.trim();
	if (!apiKey) return null;
	return createPublicClient({
		chain: mainnet,
		transport: http(`https://eth-mainnet.g.alchemy.com/v2/${apiKey}`, { timeout: 10_000 })
	});
}

/**
 * Ist `address` auf Mainnet ein deployter Contract? `getCode` ist fuer Tests
 * injizierbar. Wirft bei fehlendem Schluessel oder RPC-Fehler - der Aufrufer
 * faellt dann auf die kurze (EOA-)TTL zurueck (fail closed).
 */
export async function isDeployedContract(address, { getCode = null, client } = {}) {
	let codeOf = getCode;
	if (!codeOf) {
		const c = client ?? defaultClient();
		if (!c) throw new Error('Contract-Erkennung nicht konfiguriert.');
		codeOf = (addr) => c.getCode({ address: addr });
	}
	const code = await codeOf(address);
	return Boolean(code && code !== '0x');
}
