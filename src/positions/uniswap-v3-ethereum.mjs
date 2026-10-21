/*
	UNISWAP V3 AUF ETHEREUM - POSITIONSERKENNUNG UND EXPOSURE, INAKTIV (21.10.2026).

	Vorbereitung, KEINE Produktionsfreigabe. Kein Produktionsmodul importiert
	diese Datei (test/uniswap-v3-ethereum.test.mjs prueft das). Keine Quote, kein
	Kauf, keine Transaktion, keine Signatur: nur eth_call (ueber Multicall3) und
	eth_getCode, alles im selben Block.

	Weg:  Wallet -> NFTs des kanonischen NonfungiblePositionManager (ERC721Enumerable)
	      -> positions(tokenId) + ownerOf(tokenId) -> kanonischer Pool (CREATE2 UND
	      Factory.getPool UND der Pool selbst) -> Tokenmengen (uniswap-v3-math.mjs)
	      -> USD ueber gepruefte Preis-Referenzen (price-reference.mjs, Chainlink,
	      selber Block) -> UNISWAP_V3_LP_EXPOSURE_V1.

	Der Spotpreis des Pools (slot0) bestimmt NUR, wie sich die Position auf
	token0/token1 verteilt (Tick-Mathematik). USD kommt nie aus dem Pool: ein
	Angriff auf den Pool darf nicht zugleich die Bewertung des Schadens festlegen.

	Quellen der Adressen (am 21.10.2026 gelesen und on-chain gegengeprueft):
	Uniswap/sdks sdk-core src/addresses.ts (Factory, NPM), v3-sdk constants.ts und
	v3-periphery PoolAddress.sol (POOL_INIT_CODE_HASH), sdk-core weth9.ts (WETH9).
	Nachweis: docs/uniswap-v3-ethereum-support.md.
*/
import { encodeAbiParameters, formatUnits, getAddress, getContractAddress, isAddress, keccak256 } from 'viem';
import { safeSymbol } from './aave-v3.mjs';
import { PRICE_SOURCES, evaluatePriceReference, priceReadContracts, readingsFromResults, supportedPriceReferences, valueUsd8 } from './price-reference.mjs';
import { UniswapMathError, MAX_UINT128, MAX_UINT160, feeGrowthInside, isTick, principalAmounts, uncollectedFees } from './uniswap-v3-math.mjs';

export const CHAIN_ID = 1;
const ZERO = '0x0000000000000000000000000000000000000000';

/*
	Gebuehrenstufen: nur, was die Factory am 21.10.2026 aktiviert hatte
	(feeAmountTickSpacing != 0; 500/3000/10000 seit dem Deployment, 100 per
	Governance). Eine spaeter aktivierte Stufe ist hier unbekannt und wird
	abgelehnt, bis sie geprueft ist. Zur Laufzeit muss die Factory jede Stufe
	mit genau diesem Abstand bestaetigen.
*/
export const UNISWAP_V3_ETHEREUM = Object.freeze({
	deploymentKey: 'uniswap-v3-ethereum',
	protocolKey: 'uniswap',
	protocolVersion: 'v3',
	chainId: CHAIN_ID,
	label: 'Uniswap v3',
	factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
	positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
	weth9: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
	poolInitCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
	// keccak256 des Runtime-Bytecodes, am 21.10.2026 gelesen. Beide Vertraege sind nicht upgradebar.
	factoryCodeHash: '0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69',
	positionManagerCodeHash: '0x692e658b31cbe3407682854806658d315d61a58c7e4933a2f91d383dc00736c6',
	feeTickSpacing: Object.freeze({ 100: 1, 500: 10, 3000: 60, 10000: 200 })
});

export const LIMITS = Object.freeze({
	maxPositionsPerWallet: 50,
	maxCallsPerLookup: 1_200,
	rpcTimeoutMs: 8_000,
	lookupBudgetMs: 15_000,
	multicallBatchBytes: 16_384
});

const ERC721_ENUMERABLE = '0x780e9d63';

const NPM_ABI = [
	{ type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'WETH9', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'supportsInterface', stateMutability: 'view', inputs: [{ type: 'bytes4' }], outputs: [{ type: 'bool' }] },
	{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
	{ type: 'function', name: 'tokenOfOwnerByIndex', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] },
	{ type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
	{
		type: 'function', name: 'positions', stateMutability: 'view', inputs: [{ type: 'uint256' }],
		outputs: [
			{ name: 'nonce', type: 'uint96' }, { name: 'operator', type: 'address' }, { name: 'token0', type: 'address' }, { name: 'token1', type: 'address' },
			{ name: 'fee', type: 'uint24' }, { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' }, { name: 'liquidity', type: 'uint128' },
			{ name: 'feeGrowthInside0LastX128', type: 'uint256' }, { name: 'feeGrowthInside1LastX128', type: 'uint256' },
			{ name: 'tokensOwed0', type: 'uint128' }, { name: 'tokensOwed1', type: 'uint128' }
		]
	}
];
const FACTORY_ABI = [
	{ type: 'function', name: 'feeAmountTickSpacing', stateMutability: 'view', inputs: [{ type: 'uint24' }], outputs: [{ type: 'int24' }] },
	{ type: 'function', name: 'getPool', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], outputs: [{ type: 'address' }] }
];
const POOL_ABI = [
	{ type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
	{ type: 'function', name: 'tickSpacing', stateMutability: 'view', inputs: [], outputs: [{ type: 'int24' }] },
	{
		type: 'function', name: 'slot0', stateMutability: 'view', inputs: [],
		outputs: [
			{ name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' }, { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' },
			{ name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8' }, { name: 'unlocked', type: 'bool' }
		]
	},
	{ type: 'function', name: 'feeGrowthGlobal0X128', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
	{ type: 'function', name: 'feeGrowthGlobal1X128', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
	{
		type: 'function', name: 'ticks', stateMutability: 'view', inputs: [{ type: 'int24' }],
		outputs: [
			{ name: 'liquidityGross', type: 'uint128' }, { name: 'liquidityNet', type: 'int128' }, { name: 'feeGrowthOutside0X128', type: 'uint256' }, { name: 'feeGrowthOutside1X128', type: 'uint256' },
			{ name: 'tickCumulativeOutside', type: 'int56' }, { name: 'secondsPerLiquidityOutsideX128', type: 'uint160' }, { name: 'secondsOutside', type: 'uint32' }, { name: 'initialized', type: 'bool' }
		]
	}
];
const ERC20_ABI = [
	{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
	{ type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }
];

/*
	NEXUS (21.10.2026, api.nexusmutual.io/v2 und CoverProducts on-chain):
	Produkt 72 "Uniswap v3", Typ 0 Single Protocol Cover, Kategorie dex, aktiv,
	nicht privat, Cover-Assets ETH/USDC/cbBTC (Bitmap 193), Proof of Loss
	"address", Wording QmQQ88...EY (gleich wie Aave 97), kein Annex, keine
	Produkt-Metadaten, keine allowedPools, Grace Period 35 Tage.
	Die Identitaet ist exakt belegt; MATCHED gilt nur fuer den kanonischen
	Ethereum-Deployment-Schluessel unten. Daraus folgt hier NICHTS fuer Quote
	oder Kauf: runtimeEnabled ist false, quoteEligible immer false.
*/
export const NEXUS_UNISWAP_V3 = Object.freeze({
	productId: 72,
	name: 'Uniswap v3',
	productTypeId: 0,
	productTypeName: 'Single Protocol Cover',
	category: 'dex',
	isPrivate: false,
	isDeprecated: false,
	coverAssets: Object.freeze(['ETH', 'USDC', 'cbBTC']),
	coverAssetsBitmap: 193,
	gracePeriodSec: 3_024_000,
	proofOfLossInputTypes: Object.freeze(['address']),
	wordingCid: 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY',
	annexCid: null,
	productMetadata: '',
	allowedPools: Object.freeze([]),
	verifiedAt: '2026-10-21',
	mappingClass: 'MATCHED',
	runtimeEnabled: false
});
export const NEXUS_MAPPING_CLASSES = Object.freeze(['MATCHED', 'AMBIGUOUS', 'UNSUPPORTED']);

/*
	Nicht dasselbe Produkt, nie zugeordnet: 71 Uniswap v2, 256 Uniswap v4,
	168 "Beefy CLM + Uniswap v3" (Typ 11, deprecated, eigener Annex fuer Beefy-Vaults).
*/
export const OTHER_UNISWAP_LISTINGS = Object.freeze([
	Object.freeze({ productId: 71, name: 'Uniswap v2', class: 'UNSUPPORTED', reason: 'OTHER_PROTOCOL_VERSION' }),
	Object.freeze({ productId: 256, name: 'Uniswap v4', class: 'UNSUPPORTED', reason: 'OTHER_PROTOCOL_VERSION' }),
	Object.freeze({ productId: 168, name: 'Beefy CLM + Uniswap v3', class: 'UNSUPPORTED', reason: 'DEPRECATED_MULTI_PROTOCOL_VAULT' })
]);

export class ScanUnavailable extends Error {
	constructor(reason) { super(reason); this.reason = reason; }
}

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
const lower = (address) => address.toLowerCase();

/** CREATE2-Adresse des Pools wie PoolAddress.computeAddress; token0 < token1 Pflicht. */
export function computePoolAddress(token0, token1, fee, deployment = UNISWAP_V3_ETHEREUM) {
	if (!isAddress(token0) || !isAddress(token1)) throw new ScanUnavailable('TOKEN_INVALID');
	if (!(BigInt(token0) < BigInt(token1))) throw new ScanUnavailable('TOKEN_ORDER');
	if (!Number.isSafeInteger(fee) || fee < 0 || fee >= 2 ** 24) throw new ScanUnavailable('FEE_INVALID');
	const salt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], [getAddress(token0), getAddress(token1), fee]));
	return getContractAddress({ opcode: 'CREATE2', from: deployment.factory, salt, bytecodeHash: deployment.poolInitCodeHash });
}

/*
	Validierung einer einzelnen Position. `raw` enthaelt nur gelesene Daten aus
	EINEM Block; nichts wird geraten oder ergaenzt. Ergebnis ist VALID oder
	INVALID mit festem Grund. Geprueft wird alles, was eine fremde, gefaelschte
	oder fehlerhafte Position verraten wuerde.
*/
export const POSITION_STATUSES = Object.freeze(['VALID', 'INVALID', 'UNAVAILABLE']);

function invalid(tokenId, reason) {
	return Object.freeze({ tokenId: String(tokenId), status: 'INVALID', reason });
}

export function validatePosition(raw, { wallet, chainId, deployment = UNISWAP_V3_ETHEREUM, block = null } = {}) {
	const tokenId = raw?.tokenId;
	if (typeof tokenId !== 'bigint' || tokenId < 0n) return invalid(String(tokenId), 'TOKEN_ID_INVALID');
	if (chainId !== CHAIN_ID || deployment.chainId !== CHAIN_ID) return invalid(tokenId, 'WRONG_CHAIN');
	if (!same(raw.positionManager, deployment.positionManager)) return invalid(tokenId, 'WRONG_POSITION_MANAGER');
	if (!same(raw.owner, wallet)) return invalid(tokenId, 'OWNER_MISMATCH');
	const p = raw.position;
	if (!p || typeof p !== 'object') return invalid(tokenId, 'POSITION_MALFORMED');
	const { token0, token1, fee, tickLower, tickUpper, liquidity } = p;
	if (!isAddress(token0) || !isAddress(token1) || same(token0, ZERO) || same(token1, ZERO)) return invalid(tokenId, 'TOKEN_INVALID');
	if (!(BigInt(token0) < BigInt(token1))) return invalid(tokenId, 'TOKEN_ORDER');
	if (!Number.isSafeInteger(fee) || !Object.hasOwn(deployment.feeTickSpacing, fee)) return invalid(tokenId, 'FEE_TIER_INVALID');
	const spacing = deployment.feeTickSpacing[fee];
	if (raw.factoryTickSpacing !== spacing) return invalid(tokenId, 'FEE_TIER_INVALID');
	if (!isTick(tickLower) || !isTick(tickUpper) || tickLower >= tickUpper) return invalid(tokenId, 'TICKS_INVALID');
	if (tickLower % spacing !== 0 || tickUpper % spacing !== 0) return invalid(tokenId, 'TICKS_INVALID');
	if (typeof liquidity !== 'bigint' || liquidity < 0n || liquidity > MAX_UINT128) return invalid(tokenId, 'LIQUIDITY_INVALID');
	for (const owed of [p.tokensOwed0, p.tokensOwed1]) if (typeof owed !== 'bigint' || owed < 0n || owed > MAX_UINT128) return invalid(tokenId, 'POSITION_MALFORMED');

	let derived;
	try { derived = computePoolAddress(token0, token1, fee, deployment); } catch { return invalid(tokenId, 'POOL_DERIVATION_FAILED'); }
	if (!isAddress(raw.registeredPool ?? '') || same(raw.registeredPool, ZERO)) return invalid(tokenId, 'POOL_NOT_REGISTERED');
	if (!same(raw.registeredPool, derived)) return invalid(tokenId, 'NON_CANONICAL_POOL');
	const pool = raw.pool;
	if (!pool || !same(pool.address, derived)) return invalid(tokenId, 'POOL_MISMATCH');
	if (!same(pool.factory, deployment.factory)) return invalid(tokenId, 'WRONG_FACTORY');
	if (!same(pool.token0, token0) || !same(pool.token1, token1) || pool.fee !== fee || pool.tickSpacing !== spacing) return invalid(tokenId, 'POOL_MISMATCH');
	if (typeof pool.sqrtPriceX96 !== 'bigint' || pool.sqrtPriceX96 > MAX_UINT160 || !Number.isSafeInteger(pool.tick)) return invalid(tokenId, 'POOL_STATE_INVALID');

	const decimals = [raw.token0Meta?.decimals, raw.token1Meta?.decimals];
	if (!decimals.every((d) => Number.isInteger(d) && d >= 0 && d <= 36)) return invalid(tokenId, 'TOKEN_METADATA_MISSING');
	if (liquidity > 0n && !(raw.tickLowerInfo?.initialized === true && raw.tickUpperInfo?.initialized === true)) return invalid(tokenId, 'POOL_STATE_INVALID');

	let principal, fees;
	try {
		principal = principalAmounts({ liquidity, tickLower, tickUpper, sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick });
		// Ohne Liquiditaet waechst nichts mehr zu; offen ist nur tokensOwed (die Ticks koennen schon geloescht sein).
		const inside = liquidity === 0n
			? { inside0X128: p.feeGrowthInside0LastX128, inside1X128: p.feeGrowthInside1LastX128 }
			: feeGrowthInside({
				tick: pool.tick, tickLower, tickUpper, feeGrowthGlobal0X128: pool.feeGrowthGlobal0X128, feeGrowthGlobal1X128: pool.feeGrowthGlobal1X128,
				lower: raw.tickLowerInfo, upper: raw.tickUpperInfo
			});
		fees = uncollectedFees(p, inside);
	} catch (error) {
		return invalid(tokenId, error instanceof UniswapMathError ? `MATH_${error.reason}` : 'MATH_FAILED');
	}
	const token = (address, meta) => Object.freeze({ address: getAddress(address), decimals: meta.decimals, symbol: safeSymbol(meta.symbol, getAddress(address)) });
	return Object.freeze({
		tokenId: tokenId.toString(),
		status: 'VALID',
		chainId: CHAIN_ID,
		blockNumber: typeof block?.number === 'bigint' ? block.number.toString() : null,
		blockTimestamp: typeof block?.timestamp === 'bigint' ? block.timestamp.toString() : null,
		deploymentKey: deployment.deploymentKey,
		positionManager: deployment.positionManager,
		factory: deployment.factory,
		pool: getAddress(derived),
		fee,
		tickSpacing: spacing,
		tickLower,
		tickUpper,
		liquidity: liquidity.toString(),
		liquidityState: liquidity === 0n ? 'ZERO_LIQUIDITY' : 'ACTIVE',
		currentTick: pool.tick,
		sqrtPriceX96: pool.sqrtPriceX96.toString(),
		rangeState: principal.rangeState,
		token0: token(token0, raw.token0Meta),
		token1: token(token1, raw.token1Meta),
		principal: Object.freeze({ amount0Raw: principal.amount0.toString(), amount1Raw: principal.amount1.toString() }),
		uncollectedFees: Object.freeze({ amount0Raw: fees.amount0.toString(), amount1Raw: fees.amount1.toString() })
	});
}

/*
	PREISE (21.10.2026): price-reference.mjs, je Token chainId + exakte Adresse
	-> gepinnter Chainlink-Feed -> Frische gegen block.timestamp, alles im
	Scan-Block. Die Dezimalstellen, die der Token on-chain meldet, muessen zum
	Pin passen. Kein Pool-Spotpreis, kein Symbol, kein Aave-Orakel als Standard.
*/
export const PRICE_MODEL = 'CHAINLINK_PRICE_REFERENCE_V1';

/*
	Referenz-Token je Nexus-Cover-Asset (Asset-ID -> Token in price-reference).
	Der Leser bewertet sie in jedem Scan mit, im selben Block wie die Positionen,
	damit eine USD-Exposure spaeter in ETH, USDC oder cbBTC umgerechnet werden
	kann. ETH = WETH9 (1:1 einloesbar, Feed ETH / USD); USDC hat seinen eigenen
	Feed, es gibt keine angenommene Paritaet.
*/
const reference = (symbol) => Object.values(PRICE_SOURCES).find((entry) => entry.chainId === CHAIN_ID && entry.symbol === symbol).token;
export const COVER_ASSET_REFERENCES = Object.freeze({
	0: Object.freeze({ assetId: 0, symbol: 'ETH', token: reference('WETH'), feed: 'eth-usd' }),
	6: Object.freeze({ assetId: 6, symbol: 'USDC', token: reference('USDC'), feed: 'usdc-usd' }),
	7: Object.freeze({ assetId: 7, symbol: 'cbBTC', token: reference('cbBTC'), feed: 'cbbtc-usd' })
});

export function buildPriceBook({ tokens, block, readings }) {
	const book = {};
	for (const { address, decimals } of tokens) {
		book[lower(address)] = evaluatePriceReference({ chainId: CHAIN_ID, token: address, ...(decimals === undefined ? {} : { decimals }), block, readings });
	}
	return Object.freeze(book);
}

/*
	UNISWAP_V3_LP_EXPOSURE_V1

	suggestedExposure = geschaetzter aktueller wirtschaftlicher Wert der Assets,
	die die erkannte LP-Position repraesentiert: NUR die Liquiditaet (principal),
	ohne nicht eingesammelte Gebuehren. Kein garantierter Schadensbetrag, kein
	versicherter Wert, kein Schutz gegen Impermanent Loss oder normale
	Marktverluste (Wording 10.5).
	Fehlt fuer einen benoetigten Token ein Preis, gibt es keinen Vorschlag
	(UNKNOWN schliesst). Ein Token mit Menge 0 braucht keinen Preis.
*/
export const EXPOSURE_MODEL = 'UNISWAP_V3_LP_EXPOSURE_V1';
export const EXPOSURE_DEFINITION = 'current estimated economic value of assets represented by the detected LP position';
export const EXPOSURE_IS_NOT = Object.freeze(['guaranteed claimable amount', 'insured value', 'protection against impermanent loss', 'protection against normal market losses']);

const USD_DECIMALS = 8;
const usd = (value) => (value === null ? null : formatUnits(value, USD_DECIMALS));

/* Ein Preis gilt nur: PRICE_OK, exakte Adresse, chainId 1 und derselbe Block wie die Position. */
function priceFor(position, token, priceBook) {
	const entry = Object.hasOwn(priceBook ?? {}, lower(token.address)) ? priceBook[lower(token.address)] : null;
	if (!entry) return { problem: 'NO_PRICE_REFERENCE' };
	if (entry.status !== 'PRICE_OK') return { problem: entry.status, reason: entry.reason };
	if (typeof entry.priceUsd8 !== 'bigint' || entry.priceUsd8 <= 0n || !same(entry.token, token.address) || entry.chainId !== CHAIN_ID) return { problem: 'PRICE_SOURCE_INVALID', reason: 'PRICE_ENTRY_MISMATCH' };
	if (position.blockNumber === null || entry.blockNumber !== position.blockNumber) return { problem: 'PRICE_UNAVAILABLE', reason: 'NOT_SAME_BLOCK' };
	return { entry };
}

function valuePair(position, amounts, priceBook) {
	const legs = [[position.token0, BigInt(amounts.amount0Raw)], [position.token1, BigInt(amounts.amount1Raw)]];
	const missing = [];
	const sources = [];
	const values = legs.map(([token, amount]) => {
		if (amount === 0n) return 0n;
		const { entry, problem, reason } = priceFor(position, token, priceBook);
		if (!entry) {
			missing.push(Object.freeze({ token: token.address, status: problem, reason: reason ?? null }));
			return null;
		}
		sources.push(Object.freeze({ token: token.address, sourceType: entry.sourceType, sourceAddress: entry.sourceAddress, feeds: entry.feeds, priceUsd8: entry.priceUsd8.toString(), updatedAt: entry.updatedAt }));
		return valueUsd8(amount, token.decimals, entry.priceUsd8);
	});
	const needed = legs.some(([, amount]) => amount > 0n);
	const status = missing.length ? 'UNKNOWN' : needed ? 'PRICED' : 'NOT_REQUIRED';
	return { values, status, missing, sources, total: missing.length ? null : values[0] + values[1] };
}

export function computeUniswapLpExposure(position, priceBook) {
	if (position?.status !== 'VALID') {
		return Object.freeze({ model: EXPOSURE_MODEL, tokenId: position?.tokenId ?? null, counted: false, reason: position?.reason ?? 'NOT_A_POSITION', pricingStatus: 'NOT_APPLICABLE', suggestedExposureUsd: null, suggestedExposureUsd8: null });
	}
	const principal = valuePair(position, position.principal, priceBook);
	const fees = valuePair(position, position.uncollectedFees, priceBook);
	const fmt = (token, raw) => formatUnits(BigInt(raw), token.decimals);
	return Object.freeze({
		model: EXPOSURE_MODEL,
		protocol: 'Uniswap v3',
		chainId: CHAIN_ID,
		blockNumber: position.blockNumber,
		blockTimestamp: position.blockTimestamp,
		tokenId: position.tokenId,
		pool: position.pool,
		fee: position.fee,
		token0: position.token0,
		token1: position.token1,
		liquidityState: position.liquidityState,
		rangeState: position.rangeState,
		amount0: fmt(position.token0, position.principal.amount0Raw),
		amount1: fmt(position.token1, position.principal.amount1Raw),
		value0Usd: usd(principal.values[0]),
		value1Usd: usd(principal.values[1]),
		principalExposureUsd: usd(principal.total),
		fees0: fmt(position.token0, position.uncollectedFees.amount0Raw),
		fees1: fmt(position.token1, position.uncollectedFees.amount1Raw),
		feesUsd: usd(fees.total),
		feesPricingStatus: fees.status,
		feesIncluded: false,
		suggestedExposureUsd: usd(principal.total),
		suggestedExposureUsd8: principal.total === null ? null : principal.total.toString(),
		pricingStatus: principal.status,
		missingPrices: Object.freeze(principal.missing),
		priceSources: Object.freeze(principal.sources),
		priceModel: PRICE_MODEL,
		counted: principal.total !== null,
		definition: EXPOSURE_DEFINITION,
		isNot: EXPOSURE_IS_NOT
	});
}

/**
 * Summe nur gepruefter, voll bewerteter Positionen. Vollstaendig (COMPLETE) nur,
 * wenn der Scan OK war und JEDE gefundene Position gezaehlt wurde; sonst gibt es
 * keinen Gesamtvorschlag, und incompleteReasons nennt die Gruende.
 */
export function aggregateUniswapLpExposure(exposures, { scanStatus = 'OK' } = {}) {
	const list = Array.isArray(exposures) ? exposures : [];
	const counted = list.filter((entry) => entry.counted === true && typeof entry.suggestedExposureUsd8 === 'string');
	const excluded = list.filter((entry) => !counted.includes(entry)).map((entry) => Object.freeze({ tokenId: entry.tokenId, reason: entry.reason ?? `PRICING_${entry.pricingStatus}` }));
	const sum = counted.reduce((total, entry) => total + BigInt(entry.suggestedExposureUsd8), 0n);
	const complete = scanStatus === 'OK' && excluded.length === 0;
	const incompleteReasons = [...new Set([...(scanStatus === 'OK' ? [] : [`SCAN_${scanStatus}`]), ...excluded.map((entry) => entry.reason)])];
	return Object.freeze({
		model: EXPOSURE_MODEL,
		status: complete ? 'COMPLETE' : 'INCOMPLETE',
		positions: list.length,
		activePositions: list.filter((entry) => entry.liquidityState === 'ACTIVE').length,
		pricedPositions: list.filter((entry) => entry.pricingStatus === 'PRICED').length,
		unpricedPositions: list.filter((entry) => entry.pricingStatus === 'UNKNOWN').length,
		countedPositions: counted.length,
		excluded: Object.freeze(excluded),
		incompleteReasons: Object.freeze(incompleteReasons),
		countedExposureUsd: usd(sum),
		suggestedExposureUsd: complete ? usd(sum) : null
	});
}

/* ------------------------------------------------------------------ Leser -- */

function withTimeout(promise, ms, reason) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => { timer = setTimeout(() => reject(new ScanUnavailable(reason)), ms); })
	]).finally(() => clearTimeout(timer));
}

function budget(deadline, rpcTimeoutMs) {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new ScanUnavailable('LOOKUP_TIMEOUT');
	return Math.min(rpcTimeoutMs, remaining);
}

async function multicall(client, contracts, blockNumber, deadline, rpcTimeoutMs, counter) {
	counter.calls += contracts.length;
	if (counter.calls > LIMITS.maxCallsPerLookup) throw new ScanUnavailable('CALL_LIMIT');
	if (!contracts.length) return [];
	const results = await withTimeout(
		Promise.resolve().then(() => client.multicall({ contracts, allowFailure: true, blockNumber, batchSize: LIMITS.multicallBatchBytes })),
		budget(deadline, rpcTimeoutMs),
		'RPC_TIMEOUT'
	);
	if (!Array.isArray(results) || results.length !== contracts.length) throw new ScanUnavailable('INCOMPLETE_RESULT');
	return results;
}

const ok = (entry, reason = 'CALL_FAILED') => {
	if (entry?.status !== 'success') throw new ScanUnavailable(reason);
	return entry.result;
};
const maybe = (entry) => (entry?.status === 'success' ? entry.result : undefined);

/**
 * Liest alle Uniswap-v3-Positionen einer Wallet auf Ethereum, nur lesend.
 * `client` braucht getChainId(), getBlock(), getCode() und multicall() (viem).
 * Positionen, Pools, Token und Preis-Feeds stammen aus EINEM Block; das Ergebnis
 * nennt blockNumber und blockTimestamp, und "jetzt" fuer die Frische ist dieser Zeitstempel.
 * Ergebnis: { status: 'OK', ... } oder { status: 'UNAVAILABLE', reason } - nie
 * "keine Position", wenn nicht vollstaendig gelesen werden konnte.
 */
export async function readUniswapV3Positions(wallet, { client, deployment = UNISWAP_V3_ETHEREUM, now = () => Date.now(), rpcTimeoutMs = LIMITS.rpcTimeoutMs, lookupBudgetMs = LIMITS.lookupBudgetMs } = {}) {
	if (typeof wallet !== 'string' || !isAddress(wallet)) throw new TypeError('invalid wallet');
	const user = getAddress(wallet);
	const deadline = Date.now() + lookupBudgetMs;
	const detectedAt = new Date(now()).toISOString();
	const counter = { calls: 0 };
	let blockNumber = null;
	let blockTimestamp = null;
	try {
		if (deployment !== UNISWAP_V3_ETHEREUM) throw new ScanUnavailable('UNKNOWN_DEPLOYMENT');
		const chainId = await withTimeout(Promise.resolve().then(() => client.getChainId()), budget(deadline, rpcTimeoutMs), 'RPC_TIMEOUT');
		if (chainId !== CHAIN_ID) throw new ScanUnavailable('WRONG_CHAIN');
		const head0 = await withTimeout(Promise.resolve().then(() => client.getBlock()), budget(deadline, rpcTimeoutMs), 'RPC_TIMEOUT');
		if (typeof head0?.number !== 'bigint' || head0.number <= 0n || typeof head0.timestamp !== 'bigint' || head0.timestamp <= 0n) throw new ScanUnavailable('BAD_BLOCK');
		blockNumber = head0.number;
		blockTimestamp = head0.timestamp;
		const block = Object.freeze({ number: blockNumber, timestamp: blockTimestamp });

		// Runde 0: Code der beiden Kernvertraege - Name und Adresse allein reichen nicht.
		const [factoryCode, npmCode] = await withTimeout(Promise.all([
			client.getCode({ address: deployment.factory, blockNumber }),
			client.getCode({ address: deployment.positionManager, blockNumber })
		]), budget(deadline, rpcTimeoutMs), 'RPC_TIMEOUT');
		if (typeof factoryCode !== 'string' || factoryCode.length <= 2 || keccak256(factoryCode) !== deployment.factoryCodeHash) throw new ScanUnavailable('WRONG_FACTORY');
		if (typeof npmCode !== 'string' || npmCode.length <= 2 || keccak256(npmCode) !== deployment.positionManagerCodeHash) throw new ScanUnavailable('WRONG_POSITION_MANAGER');

		// Runde 1: Kopf - NPM-Verweise, Enumerable, Bestand, Gebuehrenstufen.
		const fees = Object.keys(deployment.feeTickSpacing).map(Number);
		const head = await multicall(client, [
			{ address: deployment.positionManager, abi: NPM_ABI, functionName: 'factory' },
			{ address: deployment.positionManager, abi: NPM_ABI, functionName: 'WETH9' },
			{ address: deployment.positionManager, abi: NPM_ABI, functionName: 'supportsInterface', args: [ERC721_ENUMERABLE] },
			{ address: deployment.positionManager, abi: NPM_ABI, functionName: 'balanceOf', args: [user] },
			...fees.map((fee) => ({ address: deployment.factory, abi: FACTORY_ABI, functionName: 'feeAmountTickSpacing', args: [fee] }))
		], blockNumber, deadline, rpcTimeoutMs, counter);
		if (!same(ok(head[0]), deployment.factory)) throw new ScanUnavailable('WRONG_FACTORY');
		if (!same(ok(head[1]), deployment.weth9)) throw new ScanUnavailable('WRONG_POSITION_MANAGER');
		if (ok(head[2]) !== true) throw new ScanUnavailable('NOT_ENUMERABLE');
		const balance = ok(head[3]);
		if (typeof balance !== 'bigint' || balance < 0n) throw new ScanUnavailable('BAD_BALANCE');
		if (balance > BigInt(LIMITS.maxPositionsPerWallet)) throw new ScanUnavailable('POSITION_LIMIT');
		const factorySpacing = Object.fromEntries(fees.map((fee, i) => [fee, Number(ok(head[4 + i]))]));
		const count = Number(balance);
		if (count === 0) {
			return Object.freeze({ status: 'OK', wallet: lower(user), chainId: CHAIN_ID, blockNumber: blockNumber.toString(), blockTimestamp: blockTimestamp.toString(), detectedAt, positions: Object.freeze([]), exposures: Object.freeze([]), priceBook: Object.freeze({}), aggregate: aggregateUniswapLpExposure([]) });
		}

		// Runde 2: Token-IDs der Wallet.
		const enumerated = await multicall(client, Array.from({ length: count }, (_, i) => ({ address: deployment.positionManager, abi: NPM_ABI, functionName: 'tokenOfOwnerByIndex', args: [user, BigInt(i)] })), blockNumber, deadline, rpcTimeoutMs, counter);
		const tokenIds = enumerated.map((entry) => ok(entry, 'ENUMERATION_FAILED'));
		if (tokenIds.some((id) => typeof id !== 'bigint') || new Set(tokenIds.map(String)).size !== tokenIds.length) throw new ScanUnavailable('ENUMERATION_FAILED');

		// Runde 3: Position und Eigentuemer je NFT.
		const round3 = await multicall(client, tokenIds.flatMap((id) => [
			{ address: deployment.positionManager, abi: NPM_ABI, functionName: 'positions', args: [id] },
			{ address: deployment.positionManager, abi: NPM_ABI, functionName: 'ownerOf', args: [id] }
		]), blockNumber, deadline, rpcTimeoutMs, counter);
		const raws = tokenIds.map((tokenId, i) => {
			const position = maybe(round3[i * 2]);
			const owner = maybe(round3[i * 2 + 1]);
			const parsed = Array.isArray(position) && position.length === 12
				? { token0: position[2], token1: position[3], fee: position[4], tickLower: position[5], tickUpper: position[6], liquidity: position[7], feeGrowthInside0LastX128: position[8], feeGrowthInside1LastX128: position[9], tokensOwed0: position[10], tokensOwed1: position[11] }
				: null;
			return { tokenId, owner, position: parsed, positionManager: deployment.positionManager, readFailed: position === undefined || owner === undefined };
		});
		if (raws.some((raw) => raw.readFailed)) throw new ScanUnavailable('POSITION_READ_FAILED');

		// Runde 4: Pools, Ticks, Token-Metadaten und Preis-Feeds - ein Multicall, ein Block.
		const usable = raws.filter((raw) => raw.position && isAddress(raw.position.token0) && isAddress(raw.position.token1) && BigInt(raw.position.token0) < BigInt(raw.position.token1)
			&& Object.hasOwn(deployment.feeTickSpacing, raw.position.fee) && isTick(raw.position.tickLower) && isTick(raw.position.tickUpper));
		const poolKey = (p) => `${lower(p.token0)}|${lower(p.token1)}|${p.fee}`;
		const pools = [...new Map(usable.map((raw) => [poolKey(raw.position), raw.position])).values()];
		const tokens = [...new Map(usable.flatMap((raw) => [raw.position.token0, raw.position.token1]).map((t) => [lower(t), getAddress(t)])).values()];
		const calls = [];
		const poolCalls = pools.map((p) => {
			const address = computePoolAddress(p.token0, p.token1, p.fee, deployment);
			const start = calls.length;
			calls.push({ address: deployment.factory, abi: FACTORY_ABI, functionName: 'getPool', args: [p.token0, p.token1, p.fee] });
			for (const functionName of ['factory', 'token0', 'token1', 'fee', 'tickSpacing', 'slot0', 'feeGrowthGlobal0X128', 'feeGrowthGlobal1X128']) calls.push({ address, abi: POOL_ABI, functionName });
			return { key: poolKey(p), address, start };
		});
		const tickCalls = usable.map((raw) => {
			const address = poolCalls.find((entry) => entry.key === poolKey(raw.position)).address;
			const start = calls.length;
			calls.push({ address, abi: POOL_ABI, functionName: 'ticks', args: [raw.position.tickLower] }, { address, abi: POOL_ABI, functionName: 'ticks', args: [raw.position.tickUpper] });
			return start;
		});
		const tokenStart = calls.length;
		for (const token of tokens) calls.push({ address: token, abi: ERC20_ABI, functionName: 'decimals' }, { address: token, abi: ERC20_ABI, functionName: 'symbol' });
		// Positions-Token plus die Referenz-Token der Cover-Assets (deren Stellen sind gepinnt, nicht gelesen).
		const coverTokens = Object.values(COVER_ASSET_REFERENCES).map((entry) => entry.token).filter((token) => !tokens.some((t) => same(t, token)));
		const priceContracts = priceReadContracts(CHAIN_ID, [...tokens, ...coverTokens]);
		const priceStart = calls.length;
		for (const { address, abi, functionName } of priceContracts) calls.push({ address, abi, functionName });
		const round4 = await multicall(client, calls, blockNumber, deadline, rpcTimeoutMs, counter);

		const meta = new Map(tokens.map((token, i) => {
			const decimals = maybe(round4[tokenStart + i * 2]);
			return [lower(token), { decimals: typeof decimals === 'number' ? decimals : typeof decimals === 'bigint' && decimals <= 255n ? Number(decimals) : null, symbol: maybe(round4[tokenStart + i * 2 + 1]) }];
		}));
		const poolState = new Map(poolCalls.map(({ key, address, start }) => {
			const [registered, factory, token0, token1, fee, tickSpacing, slot0, g0, g1] = round4.slice(start, start + 9).map(maybe);
			return [key, {
				registered,
				pool: slot0 === undefined ? null : {
					address, factory, token0, token1, fee: Number(fee), tickSpacing: Number(tickSpacing),
					sqrtPriceX96: Array.isArray(slot0) ? slot0[0] : undefined, tick: Array.isArray(slot0) ? slot0[1] : undefined,
					feeGrowthGlobal0X128: g0, feeGrowthGlobal1X128: g1
				}
			}];
		}));
		const tickInfo = (entry) => (Array.isArray(entry) ? { feeGrowthOutside0X128: entry[2], feeGrowthOutside1X128: entry[3], initialized: entry[7] } : null);

		const positions = raws.map((raw) => {
			const usableIndex = usable.indexOf(raw);
			if (usableIndex === -1) return validatePosition({ ...raw, factoryTickSpacing: raw.position ? factorySpacing[raw.position.fee] : undefined }, { wallet: user, chainId, deployment });
			const state = poolState.get(poolKey(raw.position));
			const start = tickCalls[usableIndex];
			const lowerInfo = tickInfo(maybe(round4[start]));
			const upperInfo = tickInfo(maybe(round4[start + 1]));
			// Nicht lesbar ist nicht "ungueltig": dann UNAVAILABLE, und die Summe bleibt unvollstaendig.
			const derived = poolCalls.find((entry) => entry.key === poolKey(raw.position)).address;
			const decided = isAddress(state.registered ?? '') && (same(state.registered, ZERO) || !same(state.registered, derived));
			if (!decided && (state.registered === undefined || !state.pool || !lowerInfo || !upperInfo)) {
				return Object.freeze({ tokenId: raw.tokenId.toString(), status: 'UNAVAILABLE', reason: 'POOL_READ_FAILED' });
			}
			return validatePosition({
				...raw,
				factoryTickSpacing: factorySpacing[raw.position.fee],
				registeredPool: state.registered,
				pool: state.pool,
				tickLowerInfo: lowerInfo,
				tickUpperInfo: upperInfo,
				token0Meta: meta.get(lower(raw.position.token0)),
				token1Meta: meta.get(lower(raw.position.token1))
			}, { wallet: user, chainId, deployment, block });
		});

		const readings = readingsFromResults(priceContracts, round4.slice(priceStart), blockNumber);
		const priceBook = buildPriceBook({ tokens: [...tokens.map((address) => ({ address, decimals: meta.get(lower(address)).decimals ?? null })), ...coverTokens.map((address) => ({ address }))], block, readings });
		const exposures = positions.map((position) => computeUniswapLpExposure(position, priceBook));
		return Object.freeze({
			status: 'OK',
			wallet: lower(user),
			chainId: CHAIN_ID,
			blockNumber: blockNumber.toString(),
			blockTimestamp: blockTimestamp.toString(),
			detectedAt,
			positions: Object.freeze(positions),
			priceBook,
			exposures: Object.freeze(exposures),
			aggregate: aggregateUniswapLpExposure(exposures)
		});
	} catch (error) {
		return Object.freeze({ status: 'UNAVAILABLE', reason: error instanceof ScanUnavailable ? error.reason : 'RPC_FAILED', wallet: lower(user), chainId: CHAIN_ID, blockNumber: blockNumber === null ? null : String(blockNumber), blockTimestamp: blockTimestamp === null ? null : String(blockTimestamp), detectedAt });
	}
}

/* ---------------------------------------------------- Nexus und Readiness -- */

/**
 * Nexus-Sicht auf eine gepruefte Position. MATCHED nur fuer eine VALID-Position
 * des kanonischen Ethereum-Deployments. quoteEligible ist in dieser Phase immer false.
 */
export function uniswapNexusMapping(position) {
	const result = (mappingClass, reason) => Object.freeze({ mappingClass, productId: mappingClass === 'MATCHED' ? NEXUS_UNISWAP_V3.productId : null, reason, quoteEligible: false });
	if (position?.status !== 'VALID') return result('UNSUPPORTED', 'NOT_A_VALID_POSITION');
	if (position.chainId !== CHAIN_ID) return result('UNSUPPORTED', 'WRONG_CHAIN');
	// Andere Uniswap-Versionen und Vaults haben eigene Listings (71, 256, 168) und werden nie Produkt 72.
	if (typeof position.deploymentKey === 'string' && /^uniswap-v(2|4)-/.test(position.deploymentKey)) return result('UNSUPPORTED', 'OTHER_PROTOCOL_VERSION');
	if (typeof position.deploymentKey === 'string' && /beefy|clm|vault|arrakis|gamma/i.test(position.deploymentKey)) return result('UNSUPPORTED', 'VAULT_OR_WRAPPER');
	if (position.deploymentKey !== UNISWAP_V3_ETHEREUM.deploymentKey || !same(position.positionManager, UNISWAP_V3_ETHEREUM.positionManager) || !same(position.factory, UNISWAP_V3_ETHEREUM.factory)) return result('AMBIGUOUS', 'DEPLOYMENT_CONFLICT');
	// Pool: genau die CREATE2-Ableitung aus Token-Paar und Gebuehrenstufe des kanonischen Deployments.
	let derived = null;
	try { derived = computePoolAddress(position.token0?.address, position.token1?.address, position.fee); } catch { derived = null; }
	if (!derived || !same(position.pool, derived)) return result('AMBIGUOUS', 'NON_CANONICAL_POOL');
	return result(NEXUS_UNISWAP_V3.mappingClass, 'CANONICAL_DEPLOYMENT_PRODUCT_72');
}

/*
	Feste Blocker dieser Phase. Solange einer davon gilt, sind quoteReady
	(Anzeige in der Produktion) und purchaseReady false - auch wenn alle Daten
	fuer eine informative Quote vorliegen (quoteDataReady, im Nexus-Modul).
	Die drei externen Blocker sind offen; eine Nexus-Klaerung liegt nicht vor.
*/
export const EXTERNAL_BLOCKERS = Object.freeze([
	'NEXUS_TERMS_INTERPRETATION_UNCONFIRMED',
	'NEXUS_PROOF_OF_LOSS_UNCONFIRMED',
	'WALLET_EXECUTION_NOT_AVAILABLE'
]);
export const PHASE_BLOCKERS = Object.freeze(['NO_PRODUCTION_PATH', ...EXTERNAL_BLOCKERS]);

export function uniswapV3Readiness(scan) {
	const blockers = [];
	const scanned = scan?.status === 'OK';
	if (!scanned) blockers.push('SCAN_UNAVAILABLE');
	const positions = scanned && Array.isArray(scan.positions) ? scan.positions : [];
	const valid = positions.filter((position) => position.status === 'VALID');
	const positionValid = scanned && valid.length > 0 && valid.length === positions.length;
	if (scanned && !valid.length) blockers.push('NO_VALID_POSITION');
	if (scanned && valid.length !== positions.length) blockers.push('INVALID_OR_UNREADABLE_POSITION');
	const mappings = valid.map(uniswapNexusMapping);
	const nexusMappingClass = valid.length && mappings.every((m) => m.mappingClass === 'MATCHED') ? 'MATCHED' : valid.length ? 'AMBIGUOUS' : 'UNSUPPORTED';
	if (nexusMappingClass !== 'MATCHED') blockers.push('NEXUS_MAPPING_NOT_MATCHED');
	const exposureReady = scanned && scan.aggregate?.status === 'COMPLETE' && valid.some((position) => position.liquidityState === 'ACTIVE');
	if (!exposureReady) blockers.push('EXPOSURE_NOT_READY');
	// Preise bereit: jede gezaehlte Position voll bewertet (Chainlink, frisch, selber Block), mindestens eine mit Preis.
	const exposures = scanned && Array.isArray(scan.exposures) ? scan.exposures : [];
	const pricingReady = exposureReady && exposures.every((entry) => entry.pricingStatus === 'PRICED' || entry.pricingStatus === 'NOT_REQUIRED') && exposures.some((entry) => entry.pricingStatus === 'PRICED');
	if (!pricingReady) blockers.push('PRICING_INCOMPLETE');
	// Ohne Nexus-Daten (nur Erkennung): Kapazitaet und Quote-Daten sind nicht geprueft.
	blockers.push('CAPACITY_NOT_VERIFIED', 'QUOTE_DATA_NOT_READY', ...PHASE_BLOCKERS);
	return Object.freeze({
		deploymentClass: scanned ? 'CANONICAL' : 'UNVERIFIED',
		nexusMappingClass,
		positionValid,
		exposureReady,
		pricingReady,
		capacityReady: false,
		quoteDataReady: false,
		termsReady: false,
		proofOfLossReady: false,
		quoteReady: false,
		purchaseReady: false,
		blockers: Object.freeze([...new Set(blockers)])
	});
}

/** Lesbare Support-Matrix (docs/uniswap-v3-ethereum-support.json wird daraus erzeugt). */
export function uniswapV3SupportMatrix() {
	const d = UNISWAP_V3_ETHEREUM;
	return Object.freeze([Object.freeze({
		protocol: d.label,
		chain: 'Ethereum',
		chainId: d.chainId,
		deploymentKey: d.deploymentKey,
		factory: d.factory,
		positionManager: d.positionManager,
		weth9: d.weth9,
		poolInitCodeHash: d.poolInitCodeHash,
		feeTiers: Object.keys(d.feeTickSpacing).map(Number),
		enumeration: 'ERC721Enumerable (balanceOf + tokenOfOwnerByIndex)',
		detectionReady: true,
		exposureModel: EXPOSURE_MODEL,
		feesInSuggestedExposure: false,
		priceModel: PRICE_MODEL,
		priceReferences: supportedPriceReferences().map((entry) => Object.freeze({ symbol: entry.symbol, token: entry.token, sourceType: entry.sourceType, feeds: entry.feeds.map((f) => f.proxy) })),
		pricing: 'PER_SCAN_SAME_BLOCK',
		usdFromPoolSpotPrice: false,
		nexusProductId: NEXUS_UNISWAP_V3.productId,
		nexusMapping: NEXUS_UNISWAP_V3.mappingClass,
		coverAssetConversion: 'USD / CHAINLINK_PRICE_REFERENCE_V1 (ETH/USD, USDC/USD, cbBTC/USD), same block, floor',
		quoteMode: 'PER_POSITION',
		aggregateQuote: false,
		quoteDataPath: 'INACTIVE_INTERNAL',
		termsReady: false,
		proofOfLossReady: false,
		quoteReady: false,
		purchaseReady: false,
		productionEnabled: false
	})]);
}

export const _abi = { NPM_ABI, FACTORY_ABI, POOL_ABI, ERC20_ABI };
