/*
	Nexus P4H (20.10.2026): die ECHTE Kette am Block 26230166 (P4F-Mitschnitt, nur lesend
	von zwei Anbietern) als Leser-Attrappe fuer Tests der Ausfuehrungs-Vorbereitung.

	Eigenstaendige Kopie der Welt aus test/purchase-pre-send.test.mjs (dort unveraendert).
	Die Leser antworten nur fuer genau den Block-Hash der Welt; jeder andere Blockbezug ist
	ein Fehler. Der Intent dazu ist SYNTHETISCH (es gibt keine Transaktion).
*/
import { readFileSync } from 'node:fs';

const fixture = (path) => readFileSync(new URL(`../test/fixtures/${path}`, import.meta.url), 'utf8');
export const STATE = JSON.parse(fixture('nexus/pre-send-state-26230166.json'));
const CODE = Object.fromEntries(Object.entries(STATE.codeFiles).map(([a, f]) => [a, fixture(f).trim()]));
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
/** Zeitstempel des Mitschnitt-Blocks (Unix-Sekunden). */
export const TS = Number(BigInt(STATE.block.timestamp));

/** Die echte Kette als veraenderbare Welt. */
export function world() {
	return { chainId: STATE.chainId, head: STATE.block.number, blocks: { [STATE.block.number]: { ...STATE.block } }, code: { ...CODE }, storage: structuredClone(STATE.storage), allowance: STATE.allowance.value };
}

/** Leser-Attrappe; `calls` sammelt jede Anfrage. */
export function reader(w, calls = []) {
	const bound = (tag) => tag && typeof tag === 'object' && Object.keys(tag).length === 1 && Object.values(w.blocks).some((b) => b.hash === tag.blockHash);
	return {
		async request({ method, params }) {
			calls.push({ method, params: structuredClone(params) });
			if (w.failOn === method) throw new Error('503 upstream');
			switch (method) {
				case 'eth_chainId': return w.chainId;
				case 'eth_blockNumber': return w.head;
				case 'eth_getBlockByNumber': return w.blocks[params[0]] ? { ...w.blocks[params[0]], transactions: [] } : null;
				case 'eth_getCode': if (!bound(params[1])) throw new Error('unbound read'); return w.code[params[0]] ?? '0x';
				case 'eth_getStorageAt': if (!bound(params[2])) throw new Error('unbound read'); return w.storage[params[0]]?.[params[1]] ?? `0x${'0'.repeat(64)}`;
				case 'eth_call': if (!bound(params[1])) throw new Error('unbound read');
					if (params[0].to === USDC && params[0].data.startsWith('0xdd62ed3e')) return w.allowance;
					throw new Error('execution reverted');
				default: throw new Error(`unexpected ${method}`);
			}
		}
	};
}
