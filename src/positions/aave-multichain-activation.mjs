/*
	AAVE V3 MULTI-CHAIN - RPC-, ORACLE- UND UMRECHNUNGS-VORBEREITUNG, INAKTIV (21.10.2026).

	Nichts hier ist in Produktion aktiv. Kein Produktionsmodul importiert diese
	Datei (test/aave-multichain-activation.test.mjs prueft das). Die Produktion
	liest weiterhin nur Ethereum ueber src/positions/index.mjs.

	Inhalt:
	  A  Client-Konfiguration je Chain (ohne URL, ohne Schluessel)
	  B  strenge Chain-Identitaet: chainId + deploymentKey + Pool + Provider
	  C  RPC-Budget und Wiederholungsregel
	  D  Oracle-Frische und L2-Sequencer
	  E  chain-spezifische Referenzen fuer die Umrechnung in Cover-Assets
	  G  Aktivierungs-Bereitschaft je Deployment

	Alle Adressen sind am 21.10.2026 read-only on-chain gelesen (Nachweis:
	docs/aave-v3-multichain-support.md). Arbitrum, Optimism, Polygon und
	Avalanche teilen Pool- und Provider-Adresse; WETH auf Base und Optimism
	teilt die Adresse 0x4200...0006; cbBTC auf Base hat dieselbe Adresse wie auf
	Ethereum. Eine Adresse ohne chainId identifiziert deshalb nie etwas.
*/
import { readAaveV3Positions, LIMITS } from './aave-v3.mjs';
import { AAVE_V3_MARKETS } from './aave-registry.mjs';
import { AAVE_V3_MULTICHAIN_CANDIDATES } from './aave-multichain-candidates.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

/* ------------------------------------------------------------ C: Budget -- */

/*
	Gleiche Grenzen wie der Produktionsleser (aave-v3.mjs LIMITS), je Chain und
	Scan. Ein Scan = eine Chain, ein Block. Ketten werden getrennt gelesen, nie
	in einem gemeinsamen Multicall.
*/
export const RPC_BUDGET = Object.freeze({
	requestTimeoutMs: LIMITS.rpcTimeoutMs,
	scanBudgetMs: LIMITS.lookupBudgetMs,
	maxCallsPerScan: LIMITS.maxCallsPerLookup,
	maxReservesPerMarket: LIMITS.maxReservesPerMarket,
	multicallBatchBytes: LIMITS.multicallBatchBytes,
	// Round 1 hat 8 Aufrufe je Markt, Round 2 zwei je Reserve plus einen Preisaufruf.
	maxMulticallItems: 8 + 2 * LIMITS.maxReservesPerMarket + 1,
	// Zusatz fuer Frische: Sequencer + hoechstens drei Referenz-Feeds, im selben Block.
	freshnessCalls: 4,
	transportRetries: 1,
	revertRetries: 0,
	viemRetryCount: 0
});

/**
 * Darf ein fehlgeschlagener Lesevorgang wiederholt werden? Ein Revert eines
 * eth_call ist deterministisch (gleicher Block, gleiches Ergebnis): nie. Ein
 * Transportfehler oder Timeout: hoechstens einmal und nur, wenn der Rest des
 * Scan-Budgets noch eine volle Anfragezeit hergibt.
 */
export function retryDecision({ kind, attempt, elapsedMs, budget = RPC_BUDGET }) {
	if (!Number.isInteger(attempt) || attempt < 0 || !Number.isFinite(elapsedMs) || elapsedMs < 0) return Object.freeze({ retry: false, reason: 'INVALID_INPUT' });
	if (kind === 'REVERT' || kind === 'CHAIN_MISMATCH' || kind === 'IDENTITY_MISMATCH') return Object.freeze({ retry: false, reason: 'DETERMINISTIC' });
	if (kind !== 'TIMEOUT' && kind !== 'TRANSPORT') return Object.freeze({ retry: false, reason: 'UNKNOWN_FAILURE' });
	if (attempt >= budget.transportRetries) return Object.freeze({ retry: false, reason: 'RETRY_LIMIT' });
	if (budget.scanBudgetMs - elapsedMs < budget.requestTimeoutMs) return Object.freeze({ retry: false, reason: 'BUDGET_EXHAUSTED' });
	return Object.freeze({ retry: true, reason: 'TRANSIENT' });
}

/* ----------------------------------------------- A: Client-Konfiguration -- */

/*
	rpc.network ist der Alchemy-Netzwerkname, rpc.configKey der Name der
	Umgebungsvariable. Keine URL, kein Schluessel, nichts davon im Browser. Fuer
	die neuen Chains ist weder Endpunkt noch Schluessel eingerichtet oder geprueft.
	Ethereum spiegelt nur den heutigen Produktionsstand; gesteuert wird er nicht
	von hier.
*/
const ETHEREUM_CORE = AAVE_V3_MARKETS[0];
const clientConfig = (market, network, enabled, sequencerFeed) => Object.freeze({
	chainId: market.chainId,
	caip2: `eip155:${market.chainId}`,
	deploymentKey: market.deploymentKey,
	pool: market.pool,
	poolAddressesProvider: market.poolAddressesProvider,
	oracle: market.oracle,
	dataProvider: market.dataProvider,
	rpc: Object.freeze({ configKey: 'ALCHEMY_API_KEY', network, provisioned: enabled }),
	multicall3: MULTICALL3,
	multicallAvailable: true,
	sequencerFeed,
	budget: RPC_BUDGET,
	enabled
});
const candidate = (key) => AAVE_V3_MULTICHAIN_CANDIDATES.find((entry) => entry.deploymentKey === key);

// Chainlink "L2 Sequencer Uptime Status Feed" (description on-chain gelesen). Polygon PoS und Avalanche C-Chain sind keine Rollups.
export const SEQUENCER_FEEDS = Object.freeze({
	42161: '0xFdB631F5EE196F0ed6FAa767959853A9F217697D',
	8453: '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433',
	10: '0x371EAD81c9102C9BF4874A9075FFFf170F2Ee389'
});

export const CHAIN_CLIENT_CONFIGS = Object.freeze([
	clientConfig(ETHEREUM_CORE, 'eth-mainnet', true, null),
	clientConfig(candidate('aave-v3-arbitrum'), 'arb-mainnet', false, SEQUENCER_FEEDS[42161]),
	clientConfig(candidate('aave-v3-base'), 'base-mainnet', false, SEQUENCER_FEEDS[8453]),
	clientConfig(candidate('aave-v3-optimism'), 'opt-mainnet', false, SEQUENCER_FEEDS[10]),
	clientConfig(candidate('aave-v3-polygon'), 'polygon-mainnet', false, null),
	clientConfig(candidate('aave-v3-avalanche'), 'avax-mainnet', false, null)
]);

export const configFor = (deploymentKey) => CHAIN_CLIENT_CONFIGS.find((entry) => entry.deploymentKey === deploymentKey) ?? null;

/* ------------------------------------------------- B: Chain-Identitaet -- */

const isAddr = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const same = (a, b) => isAddr(a) && isAddr(b) && a.toLowerCase() === b.toLowerCase();
const fail = (reason) => Object.freeze({ ok: false, reason });

/**
 * Vor jedem Lesen: die chainId des Clients muss der erwarteten entsprechen,
 * und der Provider muss genau Pool, Oracle und Data-Provider der Konfiguration
 * melden. Eine Adresse allein, ein Symbol oder ein Marktname reichen nie.
 * `observed` = { rpcChainId, pool, oracle, dataProvider } (vom Provider gemeldet).
 */
export function verifyChainIdentity(config, observed) {
	if (!config || !CHAIN_CLIENT_CONFIGS.includes(config)) return fail('UNKNOWN_CONFIG');
	if (!observed || typeof observed !== 'object') return fail('NO_OBSERVATION');
	if (!Number.isSafeInteger(observed.rpcChainId) || observed.rpcChainId !== config.chainId) return fail('CHAIN_MISMATCH');
	if (!same(observed.pool, config.pool)) return fail('POOL_MISMATCH');
	if (!same(observed.oracle, config.oracle)) return fail('ORACLE_MISMATCH');
	if (!same(observed.dataProvider, config.dataProvider)) return fail('DATA_PROVIDER_MISMATCH');
	return Object.freeze({ ok: true, reason: 'IDENTITY_VERIFIED', chainId: config.chainId, deploymentKey: config.deploymentKey });
}

function withTimeout(promise, ms) {
	let timer;
	return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'RPC_TIMEOUT' })), ms); })]).finally(() => clearTimeout(timer));
}

/**
 * Ein Scan eines Deployments mit vorgeschalteter chainId-Pruefung. Inaktiv:
 * ohne `allowInactive` wird ein nicht freigeschaltetes Deployment gar nicht
 * gelesen. Die Provider-Gegenprobe macht danach der Produktionsleser selbst.
 */
export async function scanDeployment(wallet, config, { client, allowInactive = false, budget = RPC_BUDGET, now } = {}) {
	if (!config || !CHAIN_CLIENT_CONFIGS.includes(config)) return Object.freeze({ status: 'UNAVAILABLE', reason: 'UNKNOWN_CONFIG' });
	if (!config.enabled && !allowInactive) return Object.freeze({ status: 'UNAVAILABLE', reason: 'NOT_ENABLED' });
	if (!client || typeof client.getChainId !== 'function') return Object.freeze({ status: 'UNAVAILABLE', reason: 'NO_CLIENT' });
	let chainId;
	try {
		chainId = await withTimeout(Promise.resolve().then(() => client.getChainId()), budget.requestTimeoutMs);
	} catch (error) {
		return Object.freeze({ status: 'UNAVAILABLE', reason: error?.code === 'RPC_TIMEOUT' ? 'RPC_TIMEOUT' : 'RPC_FAILED' });
	}
	if (chainId !== config.chainId) return Object.freeze({ status: 'UNAVAILABLE', reason: 'CHAIN_MISMATCH' });
	const market = [...AAVE_V3_MARKETS, ...AAVE_V3_MULTICHAIN_CANDIDATES].find((entry) => entry.deploymentKey === config.deploymentKey && entry.chainId === config.chainId);
	if (!market) return Object.freeze({ status: 'UNAVAILABLE', reason: 'UNKNOWN_DEPLOYMENT' });
	// Referenzen nur ueber den chain-spezifischen Resolver; Ethereum bleibt im Leser auf REFERENCE_TOKENS.
	const result = await readAaveV3Positions(wallet, { client, markets: [market], rpcTimeoutMs: budget.requestTimeoutMs, lookupBudgetMs: budget.scanBudgetMs, referenceResolver: classifyReserveForConversion, ...(now ? { now } : {}) });
	const [entry] = result.markets;
	return Object.freeze({ status: entry.status, reason: entry.reason ?? null, chainId, position: entry.position ?? null });
}

/* ------------------------------------------------ D: Oracle-Frische -- */

/*
	AaveOracle selbst liefert keinen Zeitstempel (nur getAssetPrice); ein
	Fallback-Oracle ist auf keiner der fuenf Chains gesetzt, ein
	PriceOracleSentinel auch nicht. Lesbar sind:
	  - Chainlink-Feeds (auf Arbitrum und Base die SVR-Proxies, die Aave als
	    Quelle nutzt): latestRoundData().updatedAt
	  - "Capped USDC/USD"-Adapter: kein latestRoundData; der innere Feed
	    (ASSET_TO_USD_AGGREGATOR, "USDC / USD") liefert updatedAt
	  - L2-Sequencer-Feeds (Arbitrum, Base, Optimism): answer 0 = up, startedAt
	Geprueft werden nur die Referenz-Feeds der Umrechnung, nicht jede Reserve.

	Heartbeat und Abweichungsschwelle je Feed stammen aus Chainlinks Reference
	Data Directory (Datenquelle von docs.chain.link), am 21.10.2026 gelesen und
	ueber proxyAddress bzw. secondaryProxyAddress (SVR) exakt zugeordnet.
	Fehlt ein Heartbeat, ist das Ergebnis UNKNOWN - es gibt keinen pauschalen
	Ersatzwert.
*/
export const ORACLE_STATES = Object.freeze(['ORACLE_FRESH', 'ORACLE_STALE', 'SEQUENCER_DOWN', 'SEQUENCER_GRACE_PERIOD', 'UNKNOWN']);

const RDD = 'Chainlink Reference Data Directory 21.10.2026';
const heartbeat = (chainId, feed, path, heartbeatSec, deviationPercent) => [`${chainId}:${feed.toLowerCase()}`, Object.freeze({ chainId, feed, path, heartbeatSec, deviationPercent, source: RDD, confidence: 'OFFICIAL_METADATA' })];
export const FEED_HEARTBEATS = Object.freeze(Object.fromEntries([
	heartbeat(42161, '0xbD41b1548a5A06544cBcf87c0c54864312842C00', 'eth-usd-svr', 86_400, 0.05),
	heartbeat(42161, '0xDbFF913E9058C1E60446150D23Bb0fFE9144d531', 'usdc-usd-svr', 86_400, 0.1),
	heartbeat(8453, '0x9dA00D23465282005DB222a441a663eE7B9dfCc8', 'eth-usd-svr', 1_200, 0.15),
	heartbeat(8453, '0x1550207eAeB590D1557a6E6C066D3d57B5A4Dc65', 'usdc-usd-svr', 86_400, 0.3),
	heartbeat(8453, '0x3A932b286715abc4A86a4ACAF68A6cdD89E0d446', 'btc-usd-svr', 1_200, 0.1),
	heartbeat(10, '0x13e3Ee699D1909E989722E753853AE30b17e08c5', 'eth-usd', 1_200, 0.15),
	heartbeat(10, '0x16a9FA2FDa030272Ce99B29CF780dFA30361E0f3', 'usdc-usd', 86_400, 0.1),
	heartbeat(137, '0xF9680D99D6C9589e2a93a78A04A279e509205945', 'eth-usd', 27, 0.1),
	heartbeat(137, '0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7', 'usdc-usd', 27, 0.005),
	heartbeat(43114, '0x976B3D034E162d8bD72D6b9C989d545b839003b0', 'eth-usd', 86_400, 0.1),
	heartbeat(43114, '0xF096872672F44d6EBA71458D74fe67F9a77a23B9', 'usdc-usd', 86_400, 0.1)
]));

/*
	Politik (nicht von Chainlink vorgegeben): ein Feed ist veraltet, wenn er
	aelter als Heartbeat + max(60 s, 5 % des Heartbeats) ist. Sequencer-
	Schonfrist 3600 s nach einem Neustart.
*/
export const ORACLE_POLICY = Object.freeze({ heartbeatMarginMinSec: 60, heartbeatMarginRatio: 0.05, sequencerGraceSec: 3_600 });
export const maxFeedAgeSec = (heartbeatSec, policy = ORACLE_POLICY) => heartbeatSec + Math.max(policy.heartbeatMarginMinSec, Math.ceil(heartbeatSec * policy.heartbeatMarginRatio));

const state = (value, reason) => Object.freeze({ state: value, reason });
const isBlock = (value) => typeof value === 'bigint' && value > 0n;
const intAnswer = (value) => (typeof value === 'bigint' ? value : (typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : (typeof value === 'string' && /^-?\d+$/.test(value) ? BigInt(value) : null)));

/**
 * Frische in EINEM gewaehlten Block. `snapshot` =
 *   { block: { number: bigint, timestamp: int },
 *     prices: { blockNumber },                        // Aave-Reservepreise
 *     sequencer: { answer, startedAt, blockNumber } | null,
 *     feeds: [{ feed, answer, updatedAt, blockNumber }] }
 * Alles muss aus genau diesem Block stammen; "jetzt" ist der Block-Zeitstempel,
 * nie die Serveruhr. Fehlt etwas, stammt es aus einem anderen Block oder ist es
 * unplausibel: UNKNOWN. Nur ORACLE_FRESH erlaubt spaeter eine Quote.
 */
export function oracleFreshness(chainId, snapshot, { policy = ORACLE_POLICY, heartbeats = FEED_HEARTBEATS } = {}) {
	if (!Number.isSafeInteger(chainId) || chainId === 1) return state('UNKNOWN', 'UNSUPPORTED_CHAIN');
	const config = CHAIN_CLIENT_CONFIGS.find((entry) => entry.chainId === chainId);
	if (!config) return state('UNKNOWN', 'UNSUPPORTED_CHAIN');
	if (!snapshot || typeof snapshot !== 'object') return state('UNKNOWN', 'NO_SNAPSHOT');
	const block = snapshot.block;
	if (!block || !isBlock(block.number) || !Number.isSafeInteger(block.timestamp) || block.timestamp <= 0) return state('UNKNOWN', 'NO_BLOCK');
	const inBlock = (value) => isBlock(value) && value === block.number;
	if (!inBlock(snapshot.prices?.blockNumber)) return state('UNKNOWN', 'PRICES_NOT_SAME_BLOCK');
	const nowSec = block.timestamp;
	if (config.sequencerFeed) {
		const seq = snapshot.sequencer;
		if (!seq || typeof seq !== 'object') return state('UNKNOWN', 'SEQUENCER_STATUS_UNAVAILABLE');
		if (!inBlock(seq.blockNumber)) return state('UNKNOWN', 'SEQUENCER_NOT_SAME_BLOCK');
		if (!Number.isSafeInteger(seq.startedAt) || seq.startedAt <= 0 || seq.startedAt > nowSec) return state('UNKNOWN', 'SEQUENCER_STATUS_UNAVAILABLE');
		const answer = intAnswer(seq.answer);
		if (answer === null) return state('UNKNOWN', 'SEQUENCER_STATUS_UNAVAILABLE');
		if (answer !== 0n) return state('SEQUENCER_DOWN', 'SEQUENCER_REPORTED_DOWN');
		if (nowSec - seq.startedAt < policy.sequencerGraceSec) return state('SEQUENCER_GRACE_PERIOD', 'SEQUENCER_RECENTLY_RESTARTED');
	} else if (snapshot.sequencer != null) {
		return state('UNKNOWN', 'UNEXPECTED_SEQUENCER_DATA');
	}
	const needed = (REFERENCES[chainId] ?? []).filter((ref) => ref.status === 'SUPPORTED_REFERENCE').map((ref) => ref.freshnessFeed.toLowerCase());
	if (!needed.length) return state('UNKNOWN', 'NO_REFERENCE_FEEDS');
	const feeds = Array.isArray(snapshot.feeds) ? snapshot.feeds : [];
	let stale = false;
	for (const feed of needed) {
		const meta = heartbeats[`${chainId}:${feed}`];
		if (!meta || !Number.isSafeInteger(meta.heartbeatSec) || meta.heartbeatSec <= 0) return state('UNKNOWN', 'HEARTBEAT_UNKNOWN');
		const reading = feeds.find((entry) => typeof entry?.feed === 'string' && entry.feed.toLowerCase() === feed);
		if (!reading) return state('UNKNOWN', 'FEED_MISSING');
		if (!inBlock(reading.blockNumber)) return state('UNKNOWN', 'FEED_NOT_SAME_BLOCK');
		const answer = intAnswer(reading.answer);
		if (answer === null || answer <= 0n) return state('UNKNOWN', 'FEED_ANSWER_INVALID');
		if (!Number.isSafeInteger(reading.updatedAt) || reading.updatedAt <= 0 || reading.updatedAt > nowSec) return state('UNKNOWN', 'FEED_TIMESTAMP_INVALID');
		if (nowSec - reading.updatedAt > maxFeedAgeSec(meta.heartbeatSec, policy)) stale = true;
	}
	// erst alle Feeds vollstaendig pruefen: ein fehlender oder kaputter Feed ist UNKNOWN, nicht nur "veraltet"
	return stale ? state('ORACLE_STALE', 'FEED_TOO_OLD') : state('ORACLE_FRESH', 'ALL_REFERENCE_FEEDS_FRESH');
}

/* ------------------------------------------- E: Umrechnungs-Referenzen -- */

/*
	Je (chainId, Cover-Asset) genau ein Referenz-Token, mit Adresse,
	Dezimalstellen, erwarteter Aave-Quelle und Beschreibung des Feeds.
	Gebridgte USDC-Varianten tragen dasselbe Symbol und - bei Aave - sogar
	dieselbe Preisquelle, sind aber nicht das Cover-Asset: AMBIGUOUS_REFERENCE.
	cbBTC gibt es nur auf Base. WPOL und WAVAX sind keine Cover-Assets.
*/
export const REFERENCE_STATES = Object.freeze(['SUPPORTED_REFERENCE', 'AMBIGUOUS_REFERENCE', 'UNAVAILABLE_REFERENCE']);
export const COVER_ASSETS = Object.freeze(['ETH', 'USDC', 'cbBTC']);

const ref = (coverAsset, token, decimals, kind, aaveSource, sourceDescription, freshnessFeed) => Object.freeze({ coverAsset, token, decimals, kind, aaveSource, sourceDescription, freshnessFeed, status: 'SUPPORTED_REFERENCE' });
const variant = (token, decimals, kind, reason) => Object.freeze({ token, decimals, kind, reason, status: 'AMBIGUOUS_REFERENCE' });

const REFERENCES = Object.freeze({
	42161: Object.freeze([
		ref('ETH', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 18, 'canonical-weth', '0xbD41b1548a5A06544cBcf87c0c54864312842C00', 'ETH / USD', '0xbD41b1548a5A06544cBcf87c0c54864312842C00'),
		ref('USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6, 'native-usdc', '0xB0C9A7122aaB68F75CffD9851E867144DBFF113b', 'Capped USDC/USD', '0xDbFF913E9058C1E60446150D23Bb0fFE9144d531')
	]),
	8453: Object.freeze([
		ref('ETH', '0x4200000000000000000000000000000000000006', 18, 'canonical-weth', '0x9dA00D23465282005DB222a441a663eE7B9dfCc8', 'ETH / USD', '0x9dA00D23465282005DB222a441a663eE7B9dfCc8'),
		ref('USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6, 'native-usdc', '0xf52D010c7d4ecBfda92c2509900593CE34535D86', 'Capped USDC/USD', '0x1550207eAeB590D1557a6E6C066D3d57B5A4Dc65'),
		ref('cbBTC', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 8, 'cbbtc', '0x3A932b286715abc4A86a4ACAF68A6cdD89E0d446', 'BTC / USD', '0x3A932b286715abc4A86a4ACAF68A6cdD89E0d446')
	]),
	10: Object.freeze([
		ref('ETH', '0x4200000000000000000000000000000000000006', 18, 'canonical-weth', '0x13e3Ee699D1909E989722E753853AE30b17e08c5', 'ETH / USD', '0x13e3Ee699D1909E989722E753853AE30b17e08c5'),
		ref('USDC', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6, 'native-usdc', '0x6379A975Ef93EC2bE87f56A02CCF8535dFAde201', 'Capped USDC/USD', '0x16a9FA2FDa030272Ce99B29CF780dFA30361E0f3')
	]),
	137: Object.freeze([
		ref('ETH', '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 18, 'bridged-weth', '0xF9680D99D6C9589e2a93a78A04A279e509205945', 'ETH / USD', '0xF9680D99D6C9589e2a93a78A04A279e509205945'),
		ref('USDC', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6, 'native-usdc', '0x31Ebeb03223AaC82C8EB24C77624Ea40F4D849Fb', 'Capped USDC/USD', '0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7')
	]),
	43114: Object.freeze([
		ref('ETH', '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', 18, 'bridged-weth', '0x976B3D034E162d8bD72D6b9C989d545b839003b0', 'ETH / USD', '0x976B3D034E162d8bD72D6b9C989d545b839003b0'),
		ref('USDC', '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 6, 'native-usdc', '0xb0D7A8bbDcdb1203850b742bB4d7f57a1F1C8483', 'Capped USDC/USD', '0xF096872672F44d6EBA71458D74fe67F9a77a23B9')
	])
});

// Bekannte Doppelgaenger: gleiches Symbol oder gleicher Wert, aber nicht das Cover-Asset.
const KNOWN_VARIANTS = Object.freeze({
	42161: Object.freeze([variant('0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', 6, 'bridged-usdc', 'BRIDGED_USDC')]),
	8453: Object.freeze([variant('0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', 6, 'bridged-usdc', 'BRIDGED_USDC')]),
	10: Object.freeze([variant('0x7F5c764cBc14f9669B88837ca1490cCa17c31607', 6, 'bridged-usdc', 'BRIDGED_USDC')]),
	137: Object.freeze([variant('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 6, 'bridged-usdc', 'BRIDGED_USDC')]),
	43114: Object.freeze([])
});

export const referencesFor = (chainId) => REFERENCES[chainId] ?? Object.freeze([]);

const verdictRef = (status, reason, extra = {}) => Object.freeze({ status, reason, ...extra });

/**
 * Referenz fuer ein Cover-Asset auf einer Chain. `observed` (optional) =
 * { token, decimals, price, aaveSource, sourceDescription } aus dem Lesevorgang;
 * jede Abweichung faellt geschlossen.
 */
export function resolveConversionReference(chainId, coverAsset, observed = null) {
	if (chainId === 1) return verdictRef('UNAVAILABLE_REFERENCE', 'ETHEREUM_USES_PRODUCTION_PATH');
	if (!Number.isSafeInteger(chainId) || !Object.hasOwn(REFERENCES, chainId)) return verdictRef('UNAVAILABLE_REFERENCE', 'UNSUPPORTED_CHAIN');
	if (!COVER_ASSETS.includes(coverAsset)) return verdictRef('UNAVAILABLE_REFERENCE', 'NOT_A_COVER_ASSET');
	const reference = REFERENCES[chainId].find((entry) => entry.coverAsset === coverAsset);
	if (!reference) return verdictRef('UNAVAILABLE_REFERENCE', 'ASSET_NOT_ON_CHAIN');
	if (observed === null) return verdictRef('SUPPORTED_REFERENCE', 'STATIC', { chainId, coverAsset, token: reference.token, decimals: reference.decimals });
	if (typeof observed !== 'object' || !same(observed.token, reference.token)) {
		const known = KNOWN_VARIANTS[chainId].find((entry) => same(entry.token, observed?.token));
		return known ? verdictRef('AMBIGUOUS_REFERENCE', known.reason) : verdictRef('UNAVAILABLE_REFERENCE', 'TOKEN_MISMATCH');
	}
	const price = typeof observed.price === 'bigint' ? observed.price : null;
	if (price === null || price <= 0n) return verdictRef('UNAVAILABLE_REFERENCE', 'NO_VALID_PRICE');
	if (observed.decimals !== reference.decimals) return verdictRef('AMBIGUOUS_REFERENCE', 'DECIMALS_MISMATCH');
	if (!same(observed.aaveSource, reference.aaveSource) || observed.sourceDescription !== reference.sourceDescription) return verdictRef('AMBIGUOUS_REFERENCE', 'PRICE_SOURCE_MISMATCH');
	return verdictRef('SUPPORTED_REFERENCE', 'VERIFIED', { chainId, coverAsset, token: reference.token, decimals: reference.decimals });
}

/** Was ist ein Reserve-Token (chainId + Adresse) fuer die Umrechnung? Symbole zaehlen nicht. */
export function classifyReserveForConversion(chainId, token) {
	if (!isAddr(token) || !Number.isSafeInteger(chainId) || !Object.hasOwn(REFERENCES, chainId)) return verdictRef('UNAVAILABLE_REFERENCE', 'UNKNOWN_TOKEN');
	const reference = REFERENCES[chainId].find((entry) => same(entry.token, token));
	if (reference) return verdictRef('SUPPORTED_REFERENCE', 'REFERENCE_TOKEN', { coverAsset: reference.coverAsset });
	const known = KNOWN_VARIANTS[chainId].find((entry) => same(entry.token, token));
	if (known) return verdictRef('AMBIGUOUS_REFERENCE', known.reason);
	return verdictRef('UNAVAILABLE_REFERENCE', 'NOT_A_REFERENCE_TOKEN');
}

/* --------------------------------------- G: Aktivierungs-Bereitschaft -- */

/*
	Heutiger Stand je Kandidat. rpcReady: kein Endpunkt/Schluessel je Chain
	eingerichtet oder geprueft. oracleReady: Feeds und Heartbeats belegt, die
	Entscheidung (oracleFreshness) steht, aber das Lesen von Sequencer und
	Feeds im Scan-Block ist nicht verdrahtet; Reserven ohne eigenen Zeitstempel
	bleiben ungeprueft. conversionReady: ETH und USDC haben je eine eindeutige
	Referenz.
*/
export function currentActivationFacts(deploymentKey) {
	const entry = AAVE_V3_MULTICHAIN_CANDIDATES.find((market) => market.deploymentKey === deploymentKey);
	if (!entry) return null;
	const conversionReady = ['ETH', 'USDC'].every((asset) => resolveConversionReference(entry.chainId, asset).status === 'SUPPORTED_REFERENCE');
	return Object.freeze({ deploymentKey, chainId: entry.chainId, detectionReady: true, rpcReady: false, oracleReady: false, conversionReady, nexusScope: entry.nexusScope, enabled: entry.productionEnabled });
}

/**
 * Bereitschaft aus Fakten. quoteReady nur bei CONFIRMED + RPC + Oracle +
 * Umrechnung + ausdruecklicher Freischaltung. productionActivationReady ist in dieser
 * Phase immer false: ein Produktionspfad fuer andere Chains existiert nicht.
 */
export function activationReadiness(facts) {
	if (!facts || typeof facts !== 'object') return Object.freeze({ detectionReady: false, rpcReady: false, oracleReady: false, conversionReady: false, nexusScope: 'UNSUPPORTED', quoteReady: false, productionActivationReady: false, blockers: Object.freeze(['UNKNOWN_DEPLOYMENT']) });
	const flag = (value) => value === true;
	const blockers = [];
	if (!flag(facts.detectionReady)) blockers.push('DETECTION_NOT_READY');
	if (!flag(facts.rpcReady)) blockers.push('RPC_NOT_PROVISIONED');
	if (!flag(facts.oracleReady)) blockers.push('ORACLE_READ_NOT_WIRED');
	if (!flag(facts.conversionReady)) blockers.push('CONVERSION_REFERENCE_MISSING');
	if (facts.nexusScope !== 'CONFIRMED') blockers.push(`NEXUS_SCOPE_${facts.nexusScope === 'PROBABLE' ? 'PROBABLE' : 'NOT_CONFIRMED'}`);
	if (!flag(facts.enabled)) blockers.push('NOT_ENABLED');
	blockers.push('NO_PRODUCTION_PATH');
	const quoteReady = flag(facts.detectionReady) && flag(facts.rpcReady) && flag(facts.oracleReady) && flag(facts.conversionReady) && facts.nexusScope === 'CONFIRMED' && flag(facts.enabled);
	return Object.freeze({
		detectionReady: flag(facts.detectionReady),
		rpcReady: flag(facts.rpcReady),
		oracleReady: flag(facts.oracleReady),
		conversionReady: flag(facts.conversionReady),
		nexusScope: facts.nexusScope,
		quoteReady,
		productionActivationReady: false,
		blockers: Object.freeze(blockers)
	});
}

/** Matrix fuer die Doku (docs/aave-v3-multichain-activation.json wird daraus erzeugt). */
export function activationMatrix() {
	return Object.freeze(AAVE_V3_MULTICHAIN_CANDIDATES.map((entry) => {
		const readiness = activationReadiness(currentActivationFacts(entry.deploymentKey));
		const config = configFor(entry.deploymentKey);
		return Object.freeze({
			chain: entry.label,
			chainId: entry.chainId,
			deploymentKey: entry.deploymentKey,
			rpcNetwork: config.rpc.network,
			sequencerFeed: config.sequencerFeed ?? 'NOT_APPLICABLE',
			references: Object.freeze(COVER_ASSETS.map((asset) => `${asset}:${resolveConversionReference(entry.chainId, asset).status}`)),
			...readiness,
			productionEnabled: entry.productionEnabled
		});
	}));
}

export const _test = { REFERENCES, KNOWN_VARIANTS, ZERO };
