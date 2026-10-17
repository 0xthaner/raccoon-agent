/*
	Gemeinsame Pruefumgebung fuer die Reihenfolge "Schranken vor teurer Arbeit"
	(CRSF Phase 2M, CR-RESOURCE-001 P1-P4).

	Echt laufen: der Handler-Quelltext (ohne Importe, Abhaengigkeiten per Name
	eingesetzt) und die Request-Schranken aus src/http-security.mjs. Ersetzt ist
	nur der Zaehlerspeicher des Rate-Limiters: er zaehlt je Schluessel im festen
	Fenster wie check_agent_rate_limit, protokolliert jeden Scope und lehnt einen
	Scope gezielt ab. Provider sind echte viem-Clients auf zwei offline
	Draht-Providern (Alchemy, Infura), die jede JSON-RPC-Anfrage zaehlen.
*/
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { wireProvider } from './rpc-wire.mjs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
export const strip = (file) => read(file).replace(/^import [^;]*;\n/gm, '');
export const SECURITY_EVENT = new Proxy({}, { get: (_t, k) => String(k) });

/** Der Handler aus `file` mit den Abhaengigkeiten `deps` (per Name). */
export function loadHandler(file, deps) {
	const source = strip(file).replace(/export default async function handler/, 'async function handler').replace(/^export /gm, '');
	return new Function(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps));
}

/**
 * Die echten Schranken. `deny`: Scope, den der Zaehler ablehnt. `limits`: jeder
 * gefragte Scope in Reihenfolge. `dashboardSecretConfigured`/`siweOrigin` kommen
 * vom Aufrufer (die echten aus dashboard-auth/siwe-auth).
 */
export function guards({ deny = null, dashboardSecretConfigured, siweOrigin, trace = [] }) {
	const limits = [];
	const sizes = {};
	const counts = new Map();
	const checkRateLimit = async (key, max, windowSeconds) => {
		const scope = key.split(':')[0];
		sizes[scope] = [max, windowSeconds];
		const n = (counts.get(key) ?? 0) + 1;
		counts.set(key, n);
		limits.push(scope);
		trace.push(`limit ${scope}`);
		return scope !== deny && n <= max;
	};
	const http = new Function('createHmac', 'checkRateLimit', 'dashboardSecretConfigured', 'siweOrigin', 'recordSecurityEvent', 'SECURITY_EVENT',
		`${strip('src/http-security.mjs').replace(/^export /gm, '')}\nreturn { enforceRateLimit, enforceRateLimitFor, requireJson, requireSameOrigin };`)(
		createHmac, checkRateLimit, dashboardSecretConfigured, siweOrigin, async () => {}, SECURITY_EVENT);
	return { ...http, limits, sizes };
}

/**
 * Zwei offline Provider. `answer(method, params)` liefert das JSON-RPC-`result`
 * oder `undefined` fuer einen JSON-RPC-Fehler (der Provider ist dann "nicht
 * verfuegbar"). Jede Anfrage wird gezaehlt und in `trace` vermerkt.
 */
export function providers({ answer = () => undefined, trace = [] } = {}) {
	const make = (name, url) => wireProvider((id, body) => {
		trace.push(`RPC ${name} ${body.method}`);
		const result = answer(body.method, body.params);
		return { json: result === undefined ? { jsonrpc: '2.0', id, error: { code: -32000, message: 'offline' } } : { jsonrpc: '2.0', id, result } };
	}, { url });
	const alchemy = make('alchemy', 'https://eth-mainnet.g.alchemy.com/v2/offline');
	const infura = make('infura', 'https://mainnet.infura.io/v3/offline');
	return {
		clients: { alchemy: alchemy.client, infura: infura.client },
		count: () => ({ alchemy: alchemy.requests.length, infura: infura.requests.length })
	};
}

export function response() {
	return { code: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

/** Index des ersten Eintrags, der mit `prefix` beginnt; -1 wenn keiner. */
export const firstIndex = (trace, prefix) => trace.findIndex((t) => t.startsWith(prefix));
