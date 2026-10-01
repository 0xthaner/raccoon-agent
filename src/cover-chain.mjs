/*
	COVERS EINER WALLET, LIVE VON DER KETTE.

	Bis 01.10.2026 kamen diese Daten von CoverRaccoon, und dort aus zwei Tabellen,
	die ausschliesslich der Nachtlauf um 3 Uhr fuellte. Fiel der Lauf aus, zeigte
	der Agent still veraltete Daten, und niemand bemerkte es. Jetzt fragt der
	Agent bei jeder Abfrage selbst:

	  1. Welche Cover-NFTs haelt die Wallet?  Alchemy-NFT-Index, ein Aufruf je
	     Seite. Der CoverNFT-Vertrag selbst kann das nicht auflisten
	     (`tokenOfOwnerByIndex` gibt es dort nicht, am Vertrag geprueft).
	  2. Was steckt in jedem Cover?  `CoverViewer.getCovers(ids)`, ein Aufruf je
	     50 Covers, inklusive `originalCoverId`/`latestCoverId`, also ob ein Cover
	     durch eine Aenderung ersetzt wurde.
	  3. Produktnamen aus dem oeffentlichen Nexus-Katalog, sechs Stunden gecacht.
	     Ist er nicht erreichbar, fehlt nur der Name, nicht das Cover.

	Die Antwort hat dieselbe Form wie die fruehere CoverRaccoon-Antwort
	(`agent.v1`), damit Dashboard, Telegram und Erinnerungen unveraendert bleiben.
	Schlaegt ein Schritt fehl, gibt es einen Fehler, nie eine leere Liste: eine
	leere Liste hiesse "diese Wallet hat keine Covers".
*/
import { createPublicClient, formatUnits, http } from 'viem';
import { mainnet } from 'viem/chains';

export const COVER_NFT = '0xcafeaCa76be547F14D0220482667B42D8E7Bc3eb';
export const COVER_VIEWER = '0xcafea53a6c1774030F4B1C06B4A5743d5AFFF8b9';
const PRODUCTS_URL = 'https://api.nexusmutual.io/v2/products';
const PRODUCTS_TTL_MS = 6 * 60 * 60 * 1000;
const ID_CHUNK = 50;
/** Obergrenze je Wallet. Darueber wird abgebrochen statt still abgeschnitten. */
const MAX_COVERS = 500;

export const ASSETS = {
	0: { symbol: 'ETH', decimals: 18 },
	1: { symbol: 'DAI', decimals: 18 },
	6: { symbol: 'USDC', decimals: 6 },
	7: { symbol: 'cbBTC', decimals: 8 }
};

const COVER_VIEWER_ABI = [{
	type: 'function', name: 'getCovers', stateMutability: 'view',
	inputs: [{ name: 'coverIds', type: 'uint256[]' }],
	outputs: [{
		name: '', type: 'tuple[]', components: [
			{ name: 'coverId', type: 'uint256' }, { name: 'productId', type: 'uint256' },
			{ name: 'coverAsset', type: 'uint256' }, { name: 'amount', type: 'uint256' },
			{ name: 'start', type: 'uint256' }, { name: 'period', type: 'uint256' },
			{ name: 'gracePeriod', type: 'uint256' }, { name: 'originalCoverId', type: 'uint256' },
			{ name: 'latestCoverId', type: 'uint256' }
		]
	}]
}];

export class ChainCoverError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ChainCoverError';
	}
}

/** Eine Zeile aus `getCovers` in die Form, die der Agent seit `agent.v1` kennt. */
export function serializeChainCover(raw, productName, now = Date.now()) {
	const coverId = Number(raw.coverId);
	const assetId = Number(raw.coverAsset);
	const asset = ASSETS[assetId];
	const startMs = Number(raw.start) * 1000;
	const endsMs = startMs + Number(raw.period) * 1000;
	const graceEndsMs = endsMs + Number(raw.gracePeriod) * 1000;
	const latestCoverId = Number(raw.latestCoverId);
	const originalCoverId = Number(raw.originalCoverId);
	// 0 heisst bei Nexus "nie bearbeitet", nicht "ersetzt durch Cover 0".
	const superseded = latestCoverId !== 0 && latestCoverId !== coverId;
	const amount = asset ? formatUnits(BigInt(raw.amount), asset.decimals) : String(raw.amount);
	return {
		coverId,
		productId: Number(raw.productId),
		productName: productName ?? null,
		asset: { id: assetId, symbol: asset?.symbol ?? `asset#${assetId}` },
		amount,
		// Nur bei Stablecoins ist der Betrag ohne Kurs ein Dollarbetrag.
		amountUsd: assetId === 1 || assetId === 6 ? Number(amount) : null,
		startsAt: new Date(startMs).toISOString(),
		endsAt: new Date(endsMs).toISOString(),
		graceEndsAt: new Date(graceEndsMs).toISOString(),
		status: superseded ? 'superseded' : endsMs > now ? 'active' : 'expired',
		originalCoverId: originalCoverId === 0 ? null : originalCoverId,
		latestCoverId: latestCoverId === 0 ? null : latestCoverId,
		superseded,
		analysis: null,
		purchaseTx: null
	};
}

async function ownedCoverIds(wallet, apiKey, fetchImpl) {
	const ids = [];
	let pageKey = null;
	let totalCount = null;
	do {
		const url = new URL(`https://eth-mainnet.g.alchemy.com/nft/v3/${apiKey}/getNFTsForOwner`);
		url.searchParams.set('owner', wallet);
		url.searchParams.append('contractAddresses[]', COVER_NFT);
		url.searchParams.set('withMetadata', 'false');
		url.searchParams.set('pageSize', '100');
		if (pageKey) url.searchParams.set('pageKey', pageKey);
		let response;
		try {
			response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
		} catch {
			throw new ChainCoverError('Cover-Index nicht erreichbar.');
		}
		// Die Adresse traegt den Schluessel; sie gehoert in keine Fehlermeldung.
		if (!response.ok) throw new ChainCoverError(`Cover-Index nicht erreichbar (HTTP ${response.status}).`);
		const body = await response.json();
		if (!Array.isArray(body?.ownedNfts)) throw new ChainCoverError('Cover-Index lieferte ein unbekanntes Format.');
		if (totalCount == null && body.totalCount != null) totalCount = Number(body.totalCount);
		for (const nft of body.ownedNfts) {
			/*
				Ohne Metadaten heisst das Feld `contractAddress`, mit Metadaten
				`contract.address`. Die erste Fassung kannte nur das zweite und hat
				damit JEDES Cover verworfen - das Ergebnis sah aus wie "keine
				Covers". Ein Eintrag ohne erkennbaren oder mit fremdem Vertrag ist
				deshalb ein Fehler, kein stiller Ausschluss: gefiltert hat schon der
				Index.
			*/
			const contract = String(nft?.contractAddress ?? nft?.contract?.address ?? '').toLowerCase();
			if (contract !== COVER_NFT.toLowerCase()) throw new ChainCoverError('Cover-Index lieferte einen fremden oder unbekannten Vertrag.');
			if (!/^\d+$/.test(String(nft.tokenId))) throw new ChainCoverError('Cover-Index lieferte eine ungueltige Cover-ID.');
			ids.push(BigInt(nft.tokenId));
		}
		if (ids.length > MAX_COVERS) throw new ChainCoverError(`Mehr als ${MAX_COVERS} Covers in einer Wallet.`);
		pageKey = body.pageKey ?? null;
	} while (pageKey);
	// Gegenprobe gegen die eigene Zaehlung des Index: weniger gelesen als gemeldet ist ein Fehler.
	if (totalCount != null && Number.isFinite(totalCount) && ids.length !== totalCount) {
		throw new ChainCoverError(`Cover-Index unvollstaendig gelesen (${ids.length} von ${totalCount}).`);
	}
	return ids.sort((a, b) => (a < b ? -1 : 1));
}

let productCache = null;
async function productNames(fetchImpl) {
	if (productCache && Date.now() - productCache.at < PRODUCTS_TTL_MS) return productCache.names;
	try {
		const response = await fetchImpl(PRODUCTS_URL, { signal: AbortSignal.timeout(8_000) });
		if (!response.ok) throw new Error(String(response.status));
		const products = await response.json();
		const names = new Map(products.filter((p) => typeof p?.id === 'number' && typeof p?.name === 'string').map((p) => [p.id, p.name]));
		productCache = { at: Date.now(), names };
		return names;
	} catch {
		// Ohne Katalog fehlt nur der Name; die Anzeige faellt auf "Nexus-Produkt #id" zurueck.
		return productCache?.names ?? new Map();
	}
}

export async function getChainWalletCovers(wallet, { apiKey = process.env.ALCHEMY_API_KEY?.trim(), fetchImpl = fetch, client = null, now = Date.now() } = {}) {
	if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) throw new ChainCoverError('Ungueltige Wallet-Adresse.');
	if (!apiKey) throw new ChainCoverError('ALCHEMY_API_KEY fehlt.');
	const ids = await ownedCoverIds(wallet, apiKey, fetchImpl);
	const [names, rows] = await Promise.all([productNames(fetchImpl), readCovers(ids, apiKey, client)]);
	const covers = rows.map((row) => serializeChainCover(row, names.get(Number(row.productId)), now));
	return {
		apiVersion: 'agent.v1',
		wallet: wallet.toLowerCase(),
		checkedAt: new Date(now).toISOString(),
		count: covers.length,
		activeCount: covers.filter((cover) => cover.status === 'active').length,
		covers,
		source: { protocol: 'Nexus Mutual', chain: 'eip155:1', live: true }
	};
}

async function readCovers(ids, apiKey, client) {
	if (!ids.length) return [];
	const reader = client ?? createPublicClient({ chain: mainnet, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${apiKey}`, { timeout: 10_000 }) });
	const rows = [];
	for (let i = 0; i < ids.length; i += ID_CHUNK) {
		const chunk = ids.slice(i, i + ID_CHUNK);
		let result;
		try {
			result = await reader.readContract({ address: COVER_VIEWER, abi: COVER_VIEWER_ABI, functionName: 'getCovers', args: [chunk] });
		} catch {
			throw new ChainCoverError('Cover-Daten konnten nicht von der Kette gelesen werden.');
		}
		if (!Array.isArray(result) || result.length !== chunk.length) throw new ChainCoverError('Cover-Daten unvollstaendig.');
		rows.push(...result);
	}
	return rows;
}

export const _test = { MAX_COVERS, resetProductCache: () => { productCache = null; } };
