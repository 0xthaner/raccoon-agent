/*
	Offline JSON-RPC-Provider auf Draht-Ebene (CRSF Phase 2E, F-2D-2).

	Ein echter viem-Client mit http-Transport, dessen fetch jede Anfrage lokal
	beantwortet - kein Netz, keine Schluessel. So laeuft die Antwort durch
	dieselbe Transport-/JSON-RPC-Verarbeitung wie in Produktion; nur der Server
	ist ersetzt. `answer(id)` liefert:
	  { json }            HTTP 200, JSON-Body (z. B. eine JSON-RPC-Antwort)
	  { text, status? }   roher Body (leer, kaputtes JSON, HTTP 500 ...)
	  'throw'             fetch wirft (Transportfehler)
	  'hang'              fetch antwortet nie; der Transport-Timeout greift
*/
import { createPublicClient, custom, http } from 'viem';
import { mainnet } from 'viem/chains';

export function wireProvider(answer, { url = 'https://eth-mainnet.g.alchemy.com/v2/offline', timeout = 200 } = {}) {
	const requests = [];
	const fetchFn = async (_url, init = {}) => {
		const body = JSON.parse(init.body);
		requests.push(body);
		const a = answer(body.id, body);
		if (a === 'throw') throw new TypeError('fetch failed');
		if (a === 'hang') return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted'))));
		if (a.json !== undefined) return Response.json(a.json, { status: a.status ?? 200 });
		return new Response(a.text, { status: a.status ?? 200, headers: a.headers ?? {} });
	};
	return { client: createPublicClient({ chain: mainnet, transport: http(url, { fetchFn, retryCount: 0, timeout }) }), requests };
}

/** Ein Client, dessen Transport fuer eth_getCode direkt `value` liefert (auch undefined, das JSON nicht tragen kann). */
export function rawResultProvider(value) {
	return createPublicClient({ chain: mainnet, transport: custom({ async request({ method }) {
		if (method === 'eth_getCode') return value;
		throw new Error(`unexpected ${method}`);
	} }, { retryCount: 0 }) });
}

/** JSON-RPC-Antwort fuer eth_getCode mit einem bestimmten `result` (oder ohne result-Feld). */
export const rpcResult = (result) => (id) => ({ json: result === OMIT ? { jsonrpc: '2.0', id } : { jsonrpc: '2.0', id, result } });
export const OMIT = Symbol('omit result');
