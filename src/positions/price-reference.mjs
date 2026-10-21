/*
	PREIS-REFERENZEN IN USD, PROTOKOLLUNABHAENGIG, INAKTIV (21.10.2026).

	chainId + exakte Token-Adresse -> gepruefte Quelle -> Frische gegen den
	Block -> Preis in USD mit 8 Stellen (BigInt). Gedacht fuer jede Integration
	(Uniswap, spaeter Aave, Morpho, Curve ...); in dieser Phase nutzt sie nur der
	inaktive Uniswap-v3-Pfad. Kein Produktionsmodul importiert diese Datei.

	Reihenfolge der Quellen:
	  1. direkter Chainlink-USD-Feed (Proxy, ueber ENS-Pfad und Reference Data
	     Directory belegt)
	  2. gepruefter Chainlink-Pfad aus zwei Feeds (WBTC: WBTC/BTC x BTC/USD)
	  3. AaveOracle nur ueber evaluateAaveOracleReference, nur fuer eine exakte
	     Reserve mit gepinnter, frisch lesbarer Quelle - nie als Standard
	  sonst: kein Preis.
	Nie: Uniswap-Spotpreis, Symbol, Web-API, DEX-Quote, angenommener 1-USD-Wert,
	aehnlich benannter Token.

	Quellen (am 21.10.2026 gelesen, Nachweis im Testverzeichnis unter prices/, Datei chainlink-ethereum-20261021.json):
	reference-data-directory.vercel.app/feeds-mainnet.json (Datenquelle von
	docs.chain.link) fuer Proxy, Heartbeat und Abweichung; on-chain je Proxy
	decimals, description, aggregator und latestRoundData; Token-Adressen aus der
	Uniswap-Standardliste und on-chain name/symbol/decimals.

	Rein: keine Netzaufrufe. priceReadContracts liefert nur die Aufrufliste, die
	ein Leser im SELBEN Block ausfuehrt; evaluatePriceReference bewertet das Ergebnis.
*/
import { getAddress, isAddress } from 'viem';

export const PRICE_STATUSES = Object.freeze(['PRICE_OK', 'PRICE_UNAVAILABLE', 'PRICE_STALE', 'PRICE_SOURCE_INVALID', 'PRICE_AMBIGUOUS']);
export const SOURCE_TYPES = Object.freeze(['CHAINLINK_DIRECT', 'CHAINLINK_COMPOSITE', 'AAVE_ORACLE_VERIFIED']);
export const USD_DECIMALS = 8;

/*
	Frische: Heartbeat des Feeds plus eine kleine, feste Reserve fuer die
	Zustellung - max(60 s, 5 % des Heartbeats), aufgerundet. Dieselbe Regel gilt
	in der inaktiven Aave-Multichain-Vorbereitung, die sie von hier uebernimmt.
	Eigene Politik, nicht von Chainlink vorgegeben.
*/
export const FRESHNESS_POLICY = Object.freeze({ heartbeatMarginMinSec: 60, heartbeatMarginPercent: 5 });
export function maxFeedAgeSec(heartbeatSec, policy = FRESHNESS_POLICY) {
	if (!Number.isSafeInteger(heartbeatSec) || heartbeatSec <= 0) return null;
	const percent = Math.floor((heartbeatSec * policy.heartbeatMarginPercent + 99) / 100);
	return heartbeatSec + Math.max(policy.heartbeatMarginMinSec, percent);
}

const feed = (fields) => Object.freeze({ decimals: 8, ...fields });

/** Chainlink-Proxies auf Ethereum (chainId 1), je mit Heartbeat und Abweichung laut Directory. */
export const CHAINLINK_FEEDS = Object.freeze({
	'eth-usd': feed({ proxy: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', description: 'ETH / USD', heartbeatSec: 3_600, deviationPercent: 0.5, attributeType: 'cex_price' }),
	'usdc-usd': feed({ proxy: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6', description: 'USDC / USD', heartbeatSec: 82_800, deviationPercent: 0.25, attributeType: 'cex_price', capped: true }),
	'cbbtc-usd': feed({ proxy: '0x2665701293fCbEB223D11A08D826563EDcCE423A', description: 'cbBTC / USD', heartbeatSec: 86_400, deviationPercent: 2, attributeType: 'dex_state_price' }),
	'usdt-usd': feed({ proxy: '0x3E7d1eAB13ad0104d2750B8863b489D65364e32D', description: 'USDT / USD', heartbeatSec: 86_400, deviationPercent: 0.25, attributeType: 'cex_price', capped: true }),
	'wbtc-btc': feed({ proxy: '0xfdFD9C85aD200c506Cf9e21F1FD8dd01932FBB23', description: 'WBTC / BTC', heartbeatSec: 86_400, deviationPercent: 0.5, attributeType: 'cex_price' }),
	'btc-usd': feed({ proxy: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', description: 'BTC / USD', heartbeatSec: 3_600, deviationPercent: 0.5, attributeType: 'cex_price' }),
	'paxg-usd': feed({ proxy: '0x9944D86CEB9160aF5C5feB251FD671923323f8C3', description: 'PAXG / USD', heartbeatSec: 86_400, deviationPercent: 0.5, attributeType: 'cex_price' })
});

const source = (fields) => Object.freeze({ chainId: 1, ...fields, feeds: Object.freeze(fields.feeds) });

/*
	Token -> Quelle. Schluessel ist IMMER `${chainId}:${adresse klein}`. Das
	Symbol steht nur zur Anzeige da. WETH9 ist 1:1 in ETH einloesbar (Vertrag
	verifiziert) und wird deshalb mit ETH/USD bewertet - die einzige
	Gleichsetzung; sie ist hier ausdruecklich festgelegt, nicht abgeleitet.
*/
export const PRICE_SOURCES = Object.freeze(Object.fromEntries([
	source({ token: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18, sourceType: 'CHAINLINK_DIRECT', feeds: ['eth-usd'], underlying: 'ETH (WETH9 1:1)' }),
	source({ token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6, sourceType: 'CHAINLINK_DIRECT', feeds: ['usdc-usd'] }),
	source({ token: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC', decimals: 8, sourceType: 'CHAINLINK_DIRECT', feeds: ['cbbtc-usd'] }),
	source({ token: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6, sourceType: 'CHAINLINK_DIRECT', feeds: ['usdt-usd'] }),
	source({ token: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', decimals: 8, sourceType: 'CHAINLINK_COMPOSITE', feeds: ['wbtc-btc', 'btc-usd'] }),
	source({ token: '0x45804880De22913dAFE09f4980848ECE6EcbAf78', symbol: 'PAXG', decimals: 18, sourceType: 'CHAINLINK_DIRECT', feeds: ['paxg-usd'] })
].map((entry) => [`${entry.chainId}:${entry.token.toLowerCase()}`, entry])));

export const CHAINLINK_FEED_ABI = [
	{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
	{ type: 'function', name: 'description', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
	{
		type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [],
		outputs: [{ name: 'roundId', type: 'uint80' }, { name: 'answer', type: 'int256' }, { name: 'startedAt', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' }, { name: 'answeredInRound', type: 'uint80' }]
	}
];

const isChainId = (chainId) => Number.isSafeInteger(chainId) && chainId > 0;
/** Adresse klein oder mit gueltiger Pruefsumme; gemischte Schreibweise mit falscher Pruefsumme ist keine Adresse. */
const normalize = (token) => (typeof token === 'string' && isAddress(token) ? token.toLowerCase() : null);

/** Genau der Eintrag unter `${chainId}:${adresse}`, und nur wenn er selbst dieselbe chainId und Adresse nennt. */
function lookup(chainId, token, registry) {
	const key = `${chainId}:${token}`;
	const entry = Object.hasOwn(registry, key) ? registry[key] : null;
	return entry?.chainId === chainId && normalize(entry.token) === token ? entry : null;
}

/** Aufrufliste fuer den Leser: je benoetigtem Feed description, decimals, latestRoundData. */
export function priceReadContracts(chainId, tokens, { registry = PRICE_SOURCES, feeds = CHAINLINK_FEEDS } = {}) {
	if (!isChainId(chainId)) return [];
	const keys = new Set();
	for (const token of tokens) {
		const address = normalize(token);
		if (!address) continue;
		const entry = lookup(chainId, address, registry);
		if (entry) for (const key of entry.feeds) if (Object.hasOwn(feeds, key)) keys.add(key);
	}
	return [...keys].sort().flatMap((key) => ['description', 'decimals', 'latestRoundData'].map((functionName) => ({ feedKey: key, address: feeds[key].proxy, abi: CHAINLINK_FEED_ABI, functionName })));
}

/** Multicall-Ergebnisse -> Lesungen je Feed. blockNumber ist der Block, in dem gelesen wurde. */
export function readingsFromResults(contracts, results, blockNumber) {
	const readings = {};
	contracts.forEach((contract, i) => {
		const entry = results?.[i];
		const reading = readings[contract.feedKey] ??= { blockNumber, ok: true };
		if (entry?.status !== 'success') { reading.ok = false; return; }
		if (contract.functionName === 'latestRoundData') {
			const [roundId, answer, startedAt, updatedAt, answeredInRound] = Array.isArray(entry.result) ? entry.result : [];
			Object.assign(reading, { roundId, answer, startedAt, updatedAt, answeredInRound });
		} else reading[contract.functionName] = entry.result;
	});
	return readings;
}

function verdict(status, reason, fields = {}) {
	return Object.freeze({ status, reason, priceUsd8: null, sourceType: null, sourceAddress: null, updatedAt: null, ...fields });
}

/* Prueft eine Feed-Lesung gegen Pin, Block und Frische. Liefert null (gut) oder ein Urteil. */
function checkReading(meta, reading, block, policy) {
	if (!Number.isSafeInteger(meta?.heartbeatSec) || meta.heartbeatSec <= 0) return ['PRICE_UNAVAILABLE', 'HEARTBEAT_UNKNOWN'];
	if (!reading || reading.ok !== true) return ['PRICE_UNAVAILABLE', 'FEED_READ_FAILED'];
	if (reading.blockNumber !== block.number) return ['PRICE_UNAVAILABLE', 'NOT_SAME_BLOCK'];
	if (reading.description !== meta.description) return ['PRICE_SOURCE_INVALID', 'DESCRIPTION_MISMATCH'];
	if (Number(reading.decimals) !== meta.decimals || meta.decimals !== USD_DECIMALS) return ['PRICE_SOURCE_INVALID', 'DECIMALS_MISMATCH'];
	const { roundId, answer, updatedAt, answeredInRound } = reading;
	if ([roundId, answer, updatedAt, answeredInRound].some((value) => typeof value !== 'bigint')) return ['PRICE_SOURCE_INVALID', 'ROUND_MALFORMED'];
	if (answer <= 0n) return ['PRICE_SOURCE_INVALID', 'NON_POSITIVE_ANSWER'];
	if (updatedAt <= 0n) return ['PRICE_SOURCE_INVALID', 'ROUND_INCOMPLETE'];
	if (updatedAt > block.timestamp) return ['PRICE_SOURCE_INVALID', 'UPDATED_IN_FUTURE'];
	if (answeredInRound < roundId) return ['PRICE_STALE', 'ANSWERED_IN_OLDER_ROUND'];
	if (block.timestamp - updatedAt > BigInt(maxFeedAgeSec(meta.heartbeatSec, policy))) return ['PRICE_STALE', 'OLDER_THAN_HEARTBEAT'];
	return null;
}

const isBlock = (block) => typeof block?.number === 'bigint' && block.number > 0n && typeof block.timestamp === 'bigint' && block.timestamp > 0n;

/**
 * { chainId, token, decimals?, block: { number, timestamp } (bigint), readings }
 * -> { status, reason, token, chainId, priceUsd8, sourceType, sourceAddress, updatedAt, blockNumber, blockTimestamp, feeds }
 * `decimals` ist, was der Aufrufer on-chain gelesen hat; weicht es vom Pin ab, ist die Identitaet
 * mehrdeutig (PRICE_AMBIGUOUS). Ein zweiter Eintrag fuer dieselbe Adresse ist unmoeglich (ein Schluessel).
 */
export function evaluatePriceReference({ chainId, token, decimals, block, readings }, { registry = PRICE_SOURCES, feeds = CHAINLINK_FEEDS, policy = FRESHNESS_POLICY } = {}) {
	const address = normalize(token);
	const base = { token: address ? getAddress(address) : null, chainId: isChainId(chainId) ? chainId : null, blockNumber: isBlock(block) ? block.number.toString() : null, blockTimestamp: isBlock(block) ? block.timestamp.toString() : null };
	if (!isChainId(chainId)) return verdict('PRICE_UNAVAILABLE', 'INVALID_CHAIN_ID', base);
	if (!address) return verdict('PRICE_UNAVAILABLE', 'INVALID_TOKEN', base);
	if (!isBlock(block)) return verdict('PRICE_UNAVAILABLE', 'NO_BLOCK', base);
	const entry = lookup(chainId, address, registry);
	if (!entry) return verdict('PRICE_UNAVAILABLE', 'UNSUPPORTED_TOKEN', base);
	// Mehrdeutig: die Adresse ist bekannt, aber der Token meldet andere Dezimalstellen als gepinnt.
	if (decimals !== undefined && decimals !== entry.decimals) return verdict('PRICE_AMBIGUOUS', 'TOKEN_DECIMALS_CONFLICT', base);
	const used = entry.feeds.map((key) => [key, feeds[key]]);
	if (!used.length || used.some(([, meta]) => !meta)) return verdict('PRICE_SOURCE_INVALID', 'SOURCE_NOT_PINNED', base);
	const sourceFields = { sourceType: entry.sourceType, sourceAddress: used.length === 1 ? used[0][1].proxy : null, feeds: Object.freeze(used.map(([key, meta]) => meta.proxy)) };
	for (const [key, meta] of used) {
		const problem = checkReading(meta, readings?.[key], block, policy);
		if (problem) return verdict(problem[0], `${key}:${problem[1]}`, { ...base, ...sourceFields });
	}
	// Direkt: answer hat 8 Stellen. Zusammengesetzt (Basis/Zwischenwert x Zwischenwert/USD): beide 8 Stellen.
	let price = 1n, scale = 1n;
	for (const [key] of used) { price *= readings[key].answer; scale *= 10n ** BigInt(USD_DECIMALS); }
	const priceUsd8 = (price * 10n ** BigInt(USD_DECIMALS)) / scale;
	if (priceUsd8 <= 0n) return verdict('PRICE_SOURCE_INVALID', 'NON_POSITIVE_ANSWER', { ...base, ...sourceFields });
	const updatedAt = used.map(([key]) => readings[key].updatedAt).reduce((a, b) => (a < b ? a : b));
	return Object.freeze({ status: 'PRICE_OK', reason: null, ...base, ...sourceFields, priceUsd8, updatedAt: updatedAt.toString() });
}

/** Wert in USD (8 Stellen), exakt und abgerundet: floor(amount * price / 10^decimals). */
export function valueUsd8(amount, decimals, priceUsd8) {
	if (typeof amount !== 'bigint' || amount < 0n || typeof priceUsd8 !== 'bigint' || priceUsd8 <= 0n) throw new TypeError('invalid amount or price');
	if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new TypeError('invalid decimals');
	return (amount * priceUsd8) / 10n ** BigInt(decimals);
}

/*
	AAVE-ORACLE-ADAPTER, NICHT STANDARD (21.10.2026).

	Das AaveOracle selbst hat keinen Zeitstempel. Ein Aave-Preis gilt hier nur,
	wenn (a) chainId 1, (b) der Token im selben Block exakt Reserve von Aave v3
	Ethereum Core ist, (c) getSourceOfAsset genau die hier gepinnte Quelle meldet,
	(d) diese Quelle ein Chainlink-Proxy mit Pin, Heartbeat und frischer Runde
	im selben Block ist und (e) Aaves Preis genau deren Antwort ist.
	Gepinnt ist nur WETH (Aave nutzt den SVR-Proxy von ETH/USD). USDC/USDT sind
	"Capped"-Adapter ohne latestRoundData, WBTC ein Rechenadapter, cbBTC wird von
	Aave mit BTC/USD bewertet: alles nicht hier verifizierbar -> kein Preis.
	Fuer WETH ist der Adapter redundant: Aave liest die "Aave SVR"-Variante
	desselben Paars ETH/USD (gleicher Heartbeat und gleiche Abweichung); der
	direkte kanonische Feed liefert dasselbe Paar ohne den Umweg ueber Aave.
*/
export const AAVE_ORACLE = Object.freeze({ chainId: 1, oracle: '0x54586bE62E3c3580375aE3723C145253060Ca0C2', pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' });
export const AAVE_VERIFIED_SOURCES = Object.freeze({
	'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': feed({ proxy: '0x5424384B256154046E9667dDFaaa5e550145215e', description: 'ETH / USD', heartbeatSec: 3_600, deviationPercent: 0.5, attributeType: 'cex_price', path: 'eth-usd-svr (secondaryProxyAddress)' })
});

export function evaluateAaveOracleReference({ chainId, token, block, reserves, baseCurrency, baseUnit, sourceOfAsset, aavePrice, sourceReading }, { policy = FRESHNESS_POLICY, sources = AAVE_VERIFIED_SOURCES } = {}) {
	const address = normalize(token);
	const base = { token: address ? getAddress(address) : null, chainId: isChainId(chainId) ? chainId : null, blockNumber: isBlock(block) ? block.number.toString() : null, blockTimestamp: isBlock(block) ? block.timestamp.toString() : null, sourceType: 'AAVE_ORACLE_VERIFIED' };
	if (chainId !== AAVE_ORACLE.chainId) return verdict('PRICE_UNAVAILABLE', 'INVALID_CHAIN_ID', base);
	if (!address) return verdict('PRICE_UNAVAILABLE', 'INVALID_TOKEN', base);
	if (!isBlock(block)) return verdict('PRICE_UNAVAILABLE', 'NO_BLOCK', base);
	if (!Array.isArray(reserves) || !reserves.some((reserve) => normalize(reserve) === address)) return verdict('PRICE_UNAVAILABLE', 'NOT_AN_AAVE_RESERVE', base);
	if (normalize(baseCurrency) !== '0x0000000000000000000000000000000000000000' || baseUnit !== 10n ** BigInt(USD_DECIMALS)) return verdict('PRICE_SOURCE_INVALID', 'UNEXPECTED_BASE_CURRENCY', base);
	const meta = Object.hasOwn(sources, address) ? sources[address] : null;
	if (!meta) return verdict('PRICE_UNAVAILABLE', 'AAVE_SOURCE_NOT_VERIFIED', base);
	if (normalize(sourceOfAsset) !== meta.proxy.toLowerCase()) return verdict('PRICE_SOURCE_INVALID', 'AAVE_SOURCE_CHANGED', { ...base, sourceAddress: sourceOfAsset ?? null });
	const problem = checkReading(meta, sourceReading, block, policy);
	if (problem) return verdict(problem[0], `aave-source:${problem[1]}`, { ...base, sourceAddress: meta.proxy });
	if (typeof aavePrice !== 'bigint' || aavePrice !== sourceReading.answer) return verdict('PRICE_SOURCE_INVALID', 'AAVE_PRICE_MISMATCH', { ...base, sourceAddress: meta.proxy });
	return Object.freeze({ status: 'PRICE_OK', reason: null, ...base, sourceAddress: meta.proxy, feeds: Object.freeze([meta.proxy]), priceUsd8: aavePrice, updatedAt: sourceReading.updatedAt.toString() });
}

/** Lesbare Liste der unterstuetzten Token (fuer Doku und Matrix). */
export function supportedPriceReferences() {
	return Object.values(PRICE_SOURCES).map((entry) => Object.freeze({
		chainId: entry.chainId,
		token: entry.token,
		symbol: entry.symbol,
		decimals: entry.decimals,
		sourceType: entry.sourceType,
		feeds: entry.feeds.map((key) => Object.freeze({ path: key, proxy: CHAINLINK_FEEDS[key].proxy, description: CHAINLINK_FEEDS[key].description, heartbeatSec: CHAINLINK_FEEDS[key].heartbeatSec, maxAgeSec: maxFeedAgeSec(CHAINLINK_FEEDS[key].heartbeatSec), deviationPercent: CHAINLINK_FEEDS[key].deviationPercent }))
	}));
}
