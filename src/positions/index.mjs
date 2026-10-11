/*
	DEFI-POSITIONEN FUER DAS DASHBOARD (Phase 1: Aave v3, Ethereum, 11.10.2026).

	Nur fuer die Wallet der angemeldeten Dashboard-Sitzung, nur lesend, nur die
	gepruefen Maerkte aus aave-registry.mjs, ueber die bestehende Alchemy-RPC.
	Nichts wird in Supabase gespeichert. Ein kurzer Zwischenspeicher im
	Arbeitsspeicher (60 s, Fehler 15 s) haelt wiederholte Aufrufe derselben
	Wallet von der RPC fern; der Schluessel ist die normalisierte Wallet, eine
	andere Wallet bekommt ihn nie.

	Keine empfohlene Cover-Summe, keine Differenz "Position minus Cover": die
	Position, das passende Produkt und vorhandene Covers bleiben getrennt.
*/
import { createPublicClient, http, isAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { AAVE_V3_MARKETS, CHAIN_ID } from './aave-registry.mjs';
import { LIMITS, readAaveV3Positions } from './aave-v3.mjs';
import { loadCatalog, matchDeployment } from './match-nexus.mjs';

export const CACHE_TTL_MS = 60_000;
export const FAILURE_TTL_MS = 15_000;
// Ein Eintrag ist hoechstens rund 200 KB (3 Maerkte x 128 Reserven); 200 Eintraege bleiben unter 40 MB.
const MAX_CACHE_ENTRIES = 200;
// Kalte Abfragen gleichzeitig je Instanz. Mehr wartet nicht, sondern bekommt 503.
export const MAX_CONCURRENT_LOOKUPS = 4;

export class PositionsBusyError extends Error {}
export class LookupNotAdmittedError extends Error {}
let activeLookups = 0;

const cache = new Map();
const inFlight = new Map();

function defaultClient() {
	const apiKey = process.env.ALCHEMY_API_KEY?.trim();
	if (!apiKey) return null;
	// retryCount 0: viem wiederholt sonst bis zu dreimal im Hintergrund - auch dann
	// noch, wenn unser eigenes Zeitlimit den Markt laengst als UNAVAILABLE gemeldet hat.
	return createPublicClient({ chain: mainnet, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${apiKey}`, { timeout: LIMITS.rpcTimeoutMs, retryCount: 0 }) });
}

async function lookup(wallet, { client, catalogLoader, now }) {
	const fetchedAt = new Date(now()).toISOString();
	const reader = client ?? defaultClient();
	const read = reader
		? await readAaveV3Positions(wallet, { client: reader, now })
		: { blockNumber: null, markets: AAVE_V3_MARKETS.map((market) => ({ market, status: 'UNAVAILABLE', reason: 'RPC_NOT_CONFIGURED' })) };
	const needsCatalog = read.markets.some((entry) => entry.position);
	const catalog = needsCatalog ? await catalogLoader() : null;
	const positions = read.markets.filter((entry) => entry.position).map((entry) => ({
		...entry.position,
		nexus: matchDeployment(entry.position.deploymentKey, catalog)
	}));
	const checkedDeployments = read.markets.map(({ market, status, reason }) => ({
		deploymentKey: market.deploymentKey,
		protocolKey: market.protocolKey,
		protocolVersion: market.protocolVersion,
		label: market.label,
		status,
		...(reason ? { reason } : {})
	}));
	return {
		ok: true,
		wallet,
		chainId: CHAIN_ID,
		scope: { protocol: 'aave', version: 'v3', chain: 'eip155:1' },
		complete: checkedDeployments.every((entry) => entry.status === 'OK'),
		checkedDeployments,
		positions,
		blockNumber: read.blockNumber == null ? null : read.blockNumber.toString(),
		fetchedAt
	};
}

/**
 * Positionen genau einer Wallet. `wallet` kommt ausschliesslich aus der
 * verifizierten Sitzung (api/positions.mjs). Fuer Tests injizierbar.
 *
 * `admit` wird NUR vor einer echten Kette-Abfrage gefragt (kein Cache-Treffer,
 * keine laufende Abfrage derselben Wallet) und deckelt so die Summe kalter
 * Abfragen ueber alle Wallets. Sagt es nein, gibt es keine Abfrage.
 */
export async function getWalletPositions(wallet, { client = null, catalogLoader = loadCatalog, now = () => Date.now(), admit = async () => true } = {}) {
	if (typeof wallet !== 'string' || !isAddress(wallet)) throw new TypeError('invalid wallet');
	const key = wallet.toLowerCase();
	const hit = cache.get(key);
	if (hit && now() < hit.expires) return hit.value;
	if (inFlight.has(key)) return joinInFlight(inFlight.get(key));
	if (activeLookups >= MAX_CONCURRENT_LOOKUPS) throw new PositionsBusyError('busy');
	activeLookups++;
	// Synchron eintragen, BEVOR auf die Zulassung gewartet wird: eine zweite Anfrage
	// derselben Wallet haengt sich an, statt eine zweite Zulassung und Abfrage zu starten.
	const pending = Promise.resolve()
		.then(() => admit())
		.then((admitted) => {
			if (!admitted) throw new LookupNotAdmittedError('not admitted');
			return lookup(key, { client, catalogLoader, now });
		})
		.then((value) => {
			cache.delete(key);
			cache.set(key, { value, expires: now() + (value.complete ? CACHE_TTL_MS : FAILURE_TTL_MS) });
			while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
			return value;
		})
		.finally(() => { inFlight.delete(key); activeLookups--; });
	inFlight.set(key, pending);
	return pending;
}

/*
	Wer sich anhaengt, hat selbst keine 429-Antwort geschrieben bekommen. Wird die
	Abfrage, an der er haengt, nicht zugelassen, bekommt er "beschaeftigt" (503)
	statt eines Fehlers, auf den seine Anfrage nie antworten wuerde.
*/
function joinInFlight(pending) {
	return pending.catch((error) => {
		throw error instanceof LookupNotAdmittedError ? new PositionsBusyError('busy') : error;
	});
}

export const _test = { reset: () => { cache.clear(); inFlight.clear(); activeLookups = 0; }, cacheSize: () => cache.size, activeLookups: () => activeLookups };
