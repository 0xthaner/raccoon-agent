/*
	Testhilfe: ein kleines simuliertes Ethereum Mainnet fuer die ERC-1271-Pruefung
	mit zwei Providern. Keine Netzverbindung - echte viem-Clients ueber `custom`-
	Transporte, damit der Produktionscode (getCode, readContract, Blockbindung)
	unveraendert durchlaeuft.

	Eine simulierte Safe hat eine Historie je Block: ab Block `from` gelten
	`owners` und `threshold`. Eine "Owner-Signatur" ist je Owner ein 65-Byte-
	Segment: 1 Byte Owner-Kennung + 32 Byte Hash + 32 Byte Fuellung. isValidSignature
	liefert den Magic-Wert nur, wenn alle Segmente genau diesen Hash tragen, jeder
	Unterzeichner zu diesem Block Owner ist und der Threshold erreicht ist.
*/
import { createPublicClient, custom, decodeFunctionData, parseAbi, toHex } from 'viem';
import { mainnet } from 'viem/chains';

const ABI = parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
export const MAGIC_RESULT = `0x1626ba7e${'0'.repeat(56)}`;
export const NOT_MAGIC_RESULT = `0xffffffff${'0'.repeat(56)}`;
export const SAFE_CODE = '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e';

export function simChain({ head = 20_000_000n, safes = {} } = {}) {
	const normalized = Object.fromEntries(Object.entries(safes).map(([address, safe]) => [address.toLowerCase(), { code: SAFE_CODE, ...safe }]));
	return { head, safes: normalized, hashOf: (n) => `0x${n.toString(16).padStart(64, '0')}` };
}

/** Signatur der genannten Owner (z. B. ['a1', 'b2']) ueber `hash`. */
export function ownerSignature(owners, hash) {
	return `0x${owners.map((owner) => `${owner}${hash.slice(2)}${'ee'.repeat(32)}`).join('')}`;
}

function stateAt(safe, n) {
	return [...safe.history].filter((entry) => entry.from <= n).sort((a, b) => (a.from < b.from ? 1 : -1))[0] ?? null;
}

function accepts(safe, n, hash, signature) {
	const state = stateAt(safe, n);
	if (!state) return false;
	const hex = signature.slice(2);
	if (!hex.length || hex.length % 130) return false;
	const signers = new Set();
	for (let i = 0; i < hex.length; i += 130) {
		const owner = hex.slice(i, i + 2);
		if (`0x${hex.slice(i + 2, i + 66)}`.toLowerCase() !== hash.toLowerCase()) return false;
		if (!state.owners.includes(owner)) return false;
		signers.add(owner);
	}
	return signers.size >= state.threshold;
}

/**
 * Ein Provider auf der simulierten Kette. `headOffset` verschiebt seinen Kopf
 * (zurueckhaengend/voraus). `behave[method](params, chain, n)` kann eine Antwort
 * ersetzen (Rueckgabe != undefined) oder werfen.
 */
export function simProvider(chain, { headOffset = 0n, chainId = 1, behave = {} } = {}) {
	const log = [];
	const head = () => chain.head + headOffset;
	const at = (tag) => (tag === undefined || tag === 'latest' ? head() : BigInt(tag));
	const client = createPublicClient({ chain: mainnet, transport: custom({ async request({ method, params }) {
		log.push({ method, params });
		if (behave[method]) {
			const replaced = await behave[method](params, chain);
			if (replaced !== undefined) return replaced;
		}
		switch (method) {
			case 'eth_chainId': return toHex(chainId);
			case 'eth_blockNumber': return toHex(head());
			case 'eth_getBlockByNumber': {
				const n = BigInt(params[0]);
				return n > head() ? null : { number: params[0], hash: chain.hashOf(n) };
			}
			case 'eth_getCode': {
				const safe = chain.safes[params[0].toLowerCase()];
				return safe && stateAt(safe, at(params[1])) ? safe.code : '0x';
			}
			case 'eth_call': {
				const [tx, tag] = params;
				const n = at(tag);
				const safe = chain.safes[String(tx.to).toLowerCase()];
				if (!safe || !stateAt(safe, n)) return '0x';
				const { args } = decodeFunctionData({ abi: ABI, data: tx.data });
				return accepts(safe, n, args[0], args[1]) ? MAGIC_RESULT : NOT_MAGIC_RESULT;
			}
			default: throw new Error(`unexpected ${method}`);
		}
	} }, { retryCount: 0 }) });
	return { client, log };
}

/** Zwei Provider (Alchemy, Infura) auf derselben Kette, je mit eigenem Verhalten. */
export function dualProviders(chain, alchemy = {}, infura = {}) {
	const a = simProvider(chain, alchemy);
	const b = simProvider(chain, infura);
	return { providers: { alchemy: a.client, infura: b.client }, logs: { alchemy: a.log, infura: b.log } };
}

/** Blocknummern, an denen ein Provider getCode/eth_call ausfuehrte. */
export function stateBlocks(log) {
	return log.filter((entry) => entry.method === 'eth_getCode' || entry.method === 'eth_call').map((entry) => entry.params[1]);
}
