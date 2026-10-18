/*
	AAVE-V3-POSITIONEN EINER WALLET, NUR LESEND (Phase 1, 11.10.2026).

	Je gepruefter Markt (aave-registry.mjs), alles im SELBEN Block:

	  Runde 1  PoolAddressesProvider.getPool/getPriceOracle/getPoolDataProvider
	           (Gegenprobe zur Registry), Pool.getReservesList,
	           Pool.getUserAccountData, AaveOracle.BASE_CURRENCY(_UNIT),
	           DataProvider.getAllReservesTokens (Symbole)
	  Runde 2  je Reserve DataProvider.getUserReserveData (aktuelle Guthaben und
	           Schulden, Sicherheiten-Flag des Nutzers) und
	           getReserveConfigurationData (Dezimalstellen, Liquidationsschwelle),
	           dazu AaveOracle.getAssetsPrices fuer alle Reserven

	Bewertet wird mit Aaves eigenem Orakel in dessen Basiswaehrung (USD, 8
	Stellen), gerechnet in BigInt. Zum Schluss die Gegenprobe: die Summe der
	Sicherheiten und Schulden je Reserve muss zu Aaves eigener Kontosumme
	(getUserAccountData) passen. Passt sie nicht, ist der Markt UNAVAILABLE -
	ebenso bei jedem fehlenden Aufruf, Zeitueberschreitung oder zu vielen
	Reserven. Ein nicht lesbarer Markt wird nie als "keine Position" gemeldet.

	Keine Transaktion, keine Signatur, keine Freigabe; nur eth_call.
*/
import { formatUnits, getAddress, isAddress } from 'viem';
import { AAVE_V3_MARKETS, REFERENCE_TOKENS } from './aave-registry.mjs';

export const LIMITS = Object.freeze({
	maxReservesPerMarket: 128,
	maxCallsPerLookup: 900,
	rpcTimeoutMs: 8_000,
	lookupBudgetMs: 15_000,
	multicallBatchBytes: 16_384
});

const ZERO = '0x0000000000000000000000000000000000000000';
const MAX_UINT = (1n << 256n) - 1n;

const PROVIDER_ABI = [
	{ type: 'function', name: 'getPool', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'getPriceOracle', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'getPoolDataProvider', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }
];
const POOL_ABI = [
	{ type: 'function', name: 'getReservesList', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
	{
		type: 'function', name: 'getUserAccountData', stateMutability: 'view', inputs: [{ name: 'user', type: 'address' }],
		outputs: ['totalCollateralBase', 'totalDebtBase', 'availableBorrowsBase', 'currentLiquidationThreshold', 'ltv', 'healthFactor'].map((name) => ({ name, type: 'uint256' }))
	}
];
const ORACLE_ABI = [
	{ type: 'function', name: 'BASE_CURRENCY', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
	{ type: 'function', name: 'BASE_CURRENCY_UNIT', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
	{ type: 'function', name: 'getAssetsPrices', stateMutability: 'view', inputs: [{ name: 'assets', type: 'address[]' }], outputs: [{ type: 'uint256[]' }] }
];
const DATA_PROVIDER_ABI = [
	{
		type: 'function', name: 'getAllReservesTokens', stateMutability: 'view', inputs: [],
		outputs: [{ type: 'tuple[]', components: [{ name: 'symbol', type: 'string' }, { name: 'tokenAddress', type: 'address' }] }]
	},
	{
		type: 'function', name: 'getUserReserveData', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }, { name: 'user', type: 'address' }],
		outputs: [
			{ name: 'currentATokenBalance', type: 'uint256' }, { name: 'currentStableDebt', type: 'uint256' }, { name: 'currentVariableDebt', type: 'uint256' },
			{ name: 'principalStableDebt', type: 'uint256' }, { name: 'scaledVariableDebt', type: 'uint256' }, { name: 'stableBorrowRate', type: 'uint256' },
			{ name: 'liquidityRate', type: 'uint256' }, { name: 'stableRateLastUpdated', type: 'uint40' }, { name: 'usageAsCollateralEnabled', type: 'bool' }
		]
	},
	{
		type: 'function', name: 'getReserveConfigurationData', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }],
		outputs: [
			{ name: 'decimals', type: 'uint256' }, { name: 'ltv', type: 'uint256' }, { name: 'liquidationThreshold', type: 'uint256' },
			{ name: 'liquidationBonus', type: 'uint256' }, { name: 'reserveFactor', type: 'uint256' }, { name: 'usageAsCollateralEnabled', type: 'bool' },
			{ name: 'borrowingEnabled', type: 'bool' }, { name: 'stableBorrowRateEnabled', type: 'bool' }, { name: 'isActive', type: 'bool' }, { name: 'isFrozen', type: 'bool' }
		]
	}
];

export class MarketUnavailable extends Error {
	constructor(reason) { super(reason); this.reason = reason; }
}

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Token-Symbole sind fremde Daten: nur kurze, druckbare ASCII-Zeichen, sonst Kurzadresse. */
export function safeSymbol(symbol, asset) {
	const text = typeof symbol === 'string' ? symbol.trim() : '';
	if (/^[A-Za-z0-9.+_-]{1,16}$/.test(text)) return text;
	return `${asset.slice(0, 6)}…${asset.slice(-4)}`;
}

function withTimeout(promise, ms, reason) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => { timer = setTimeout(() => reject(new MarketUnavailable(reason)), ms); })
	]).finally(() => clearTimeout(timer));
}

async function multicall(client, contracts, blockNumber, deadline, rpcTimeoutMs) {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new MarketUnavailable('LOOKUP_TIMEOUT');
	const results = await withTimeout(
		Promise.resolve().then(() => client.multicall({ contracts, allowFailure: true, blockNumber, batchSize: LIMITS.multicallBatchBytes })),
		Math.min(rpcTimeoutMs, remaining),
		'RPC_TIMEOUT'
	);
	if (!Array.isArray(results) || results.length !== contracts.length) throw new MarketUnavailable('INCOMPLETE_RESULT');
	return results;
}

/** Ergebnis eines Aufrufs oder MarketUnavailable; nie ein stiller Ersatzwert. */
function ok(entry) {
	if (entry?.status !== 'success') throw new MarketUnavailable('CALL_FAILED');
	return entry.result;
}

/** floor(amount * price / 10^decimals) bzw. aufgerundet, wie Aave selbst rechnet. */
function toBase(amount, price, decimals, roundUp = false) {
	const unit = 10n ** BigInt(decimals);
	const product = amount * price;
	return roundUp ? (product + unit - 1n) / unit : product / unit;
}

/*
	Toleranz der Gegenprobe: je beteiligter Reserve 2 Basiseinheiten (10^-8 USD).
	Alle Werte stammen aus demselben Block, also denselben Indizes und Preisen;
	Aave rundet Sicherheiten ab und Schulden auf, aeltere v3-Versionen runden
	Schulden ab - das macht hoechstens 1 Einheit je Reserve. Live am 11.10.2026
	gemessen (Treasury, 75 Reserven, und fuenf Kreditnehmer): Abweichung 0.
	Bis zur Sicherheitspruefung galten zusaetzlich 0,01 % der Kontosumme - bei
	10 Mio. USD haette das einen Lesefehler von 1.000 USD durchgelassen.
*/
function within(sum, total, reserves) {
	const diff = sum > total ? sum - total : total - sum;
	return diff <= BigInt(reserves) * 2n;
}

function round1Calls(market, wallet) {
	return [
		{ address: market.poolAddressesProvider, abi: PROVIDER_ABI, functionName: 'getPool' },
		{ address: market.poolAddressesProvider, abi: PROVIDER_ABI, functionName: 'getPriceOracle' },
		{ address: market.poolAddressesProvider, abi: PROVIDER_ABI, functionName: 'getPoolDataProvider' },
		{ address: market.pool, abi: POOL_ABI, functionName: 'getReservesList' },
		{ address: market.pool, abi: POOL_ABI, functionName: 'getUserAccountData', args: [wallet] },
		{ address: market.oracle, abi: ORACLE_ABI, functionName: 'BASE_CURRENCY' },
		{ address: market.oracle, abi: ORACLE_ABI, functionName: 'BASE_CURRENCY_UNIT' },
		{ address: market.dataProvider, abi: DATA_PROVIDER_ABI, functionName: 'getAllReservesTokens' }
	];
}
const ROUND1_SIZE = 8;

function parseRound1(market, results) {
	const [pool, oracle, dataProvider, reserves, account, baseCurrency, baseUnit, tokens] = results.map(ok);
	if (!same(pool, market.pool) || !same(oracle, market.oracle) || !same(dataProvider, market.dataProvider)) throw new MarketUnavailable('REGISTRY_MISMATCH');
	if (!same(baseCurrency, ZERO) || baseUnit !== 100_000_000n) throw new MarketUnavailable('UNSUPPORTED_BASE_CURRENCY');
	if (!Array.isArray(reserves) || reserves.some((asset) => !isAddress(asset))) throw new MarketUnavailable('BAD_RESERVE_LIST');
	if (reserves.length > LIMITS.maxReservesPerMarket) throw new MarketUnavailable('RESERVE_LIMIT');
	if (new Set(reserves.map((asset) => asset.toLowerCase())).size !== reserves.length) throw new MarketUnavailable('BAD_RESERVE_LIST');
	const [totalCollateralBase, totalDebtBase, , , , healthFactor] = account;
	const symbols = new Map((Array.isArray(tokens) ? tokens : []).map((token) => [String(token?.tokenAddress ?? '').toLowerCase(), token?.symbol]));
	return { reserves: reserves.map((asset) => getAddress(asset)), totalCollateralBase, totalDebtBase, healthFactor, baseUnit, symbols };
}

function round2Calls(market, wallet, reserves) {
	const calls = [];
	for (const asset of reserves) {
		calls.push({ address: market.dataProvider, abi: DATA_PROVIDER_ABI, functionName: 'getUserReserveData', args: [asset, wallet] });
		calls.push({ address: market.dataProvider, abi: DATA_PROVIDER_ABI, functionName: 'getReserveConfigurationData', args: [asset] });
	}
	calls.push({ address: market.oracle, abi: ORACLE_ABI, functionName: 'getAssetsPrices', args: [reserves] });
	return calls;
}

function buildPosition(market, wallet, head, results, blockNumber, detectedAt) {
	const prices = ok(results.at(-1));
	if (!Array.isArray(prices) || prices.length !== head.reserves.length) throw new MarketUnavailable('INCOMPLETE_RESULT');
	const supplied = [], borrowed = [], reference = [];
	let suppliedBase = 0n, debtBase = 0n, collateralAll = 0n, collateralWithThreshold = 0n, involved = 0;
	head.reserves.forEach((asset, i) => {
		const user = ok(results[i * 2]);
		const config = ok(results[i * 2 + 1]);
		const decimals = Number(config[0]);
		if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new MarketUnavailable('BAD_DECIMALS');
		const price = prices[i];
		if (typeof price !== 'bigint' || price < 0n) throw new MarketUnavailable('BAD_PRICE');
		const token = Object.keys(REFERENCE_TOKENS).find((key) => same(REFERENCE_TOKENS[key], asset));
		if (token && price > 0n) reference.push({ token, asset, decimals, price: price.toString() });
		const supply = user[0];
		const debt = user[1] + user[2];
		const isCollateral = Boolean(user[8]);
		if (supply === 0n && debt === 0n) return;
		if (price === 0n) throw new MarketUnavailable('MISSING_PRICE');
		involved++;
		const symbol = safeSymbol(head.symbols.get(asset.toLowerCase()), asset);
		if (supply > 0n) {
			const value = toBase(supply, price, decimals);
			suppliedBase += value;
			if (isCollateral) {
				collateralAll += value;
				if (config[2] !== 0n) collateralWithThreshold += value;
			}
			supplied.push({ asset, symbol, decimals, amount: formatUnits(supply, decimals), amountRaw: supply.toString(), usdValue: formatUnits(value, 8), isCollateral });
		}
		if (debt > 0n) {
			const value = toBase(debt, price, decimals, true);
			debtBase += value;
			borrowed.push({ asset, symbol, decimals, amount: formatUnits(debt, decimals), amountRaw: debt.toString(), usdValue: formatUnits(value, 8) });
		}
	});
	// Gegenprobe gegen Aaves eigene Kontosumme. Aeltere v3-Versionen zaehlen
	// Sicherheiten mit Liquidationsschwelle 0 nicht mit; beide Regeln sind zulaessig.
	const collateralOk = within(collateralAll, head.totalCollateralBase, involved) || within(collateralWithThreshold, head.totalCollateralBase, involved);
	if (!collateralOk || !within(debtBase, head.totalDebtBase, involved)) throw new MarketUnavailable('TOTALS_MISMATCH');
	if (!supplied.length && !borrowed.length) return null;
	return {
		wallet,
		chainId: market.chainId,
		protocolKey: market.protocolKey,
		protocolVersion: market.protocolVersion,
		deploymentKey: market.deploymentKey,
		label: market.label,
		marketAddress: market.pool,
		supplied,
		borrowed,
		totals: {
			suppliedUsd: formatUnits(suppliedBase, 8),
			debtUsd: formatUnits(debtBase, 8),
			netUsd: formatUnits(suppliedBase - debtBase, 8),
			healthFactor: head.totalDebtBase === 0n || head.healthFactor === MAX_UINT ? null : formatUnits(head.healthFactor, 18)
		},
		valueKind: 'DERIVED_FROM_AAVE_ORACLE',
		pricing: { source: 'aave-oracle', oracle: market.oracle, baseCurrency: 'USD', baseUnitDecimals: 8, reference },
		sourceContracts: [market.poolAddressesProvider, market.pool, market.dataProvider, market.oracle],
		blockNumber: blockNumber.toString(),
		detectedAt,
		status: 'OK'
	};
}

/**
 * Liest alle gepruefen Maerkte fuer genau eine Wallet. Ergebnis je Markt:
 * { market, status: 'OK', position|null } oder { market, status: 'UNAVAILABLE', reason }.
 * `client` braucht nur getBlockNumber() und multicall() (viem).
 */
export async function readAaveV3Positions(wallet, { client, markets = AAVE_V3_MARKETS, now = () => Date.now(), rpcTimeoutMs = LIMITS.rpcTimeoutMs, lookupBudgetMs = LIMITS.lookupBudgetMs } = {}) {
	if (typeof wallet !== 'string' || !isAddress(wallet)) throw new TypeError('invalid wallet');
	const user = getAddress(wallet);
	const owner = wallet.toLowerCase();
	const deadline = Date.now() + lookupBudgetMs;
	const detectedAt = new Date(now()).toISOString();
	const unavailable = (market, reason) => ({ market, status: 'UNAVAILABLE', reason });

	let blockNumber;
	try {
		blockNumber = await withTimeout(Promise.resolve().then(() => client.getBlockNumber()), rpcTimeoutMs, 'RPC_TIMEOUT');
		if (typeof blockNumber !== 'bigint' || blockNumber <= 0n) throw new MarketUnavailable('BAD_BLOCK');
	} catch (error) {
		return { blockNumber: null, markets: markets.map((market) => unavailable(market, error instanceof MarketUnavailable ? error.reason : 'RPC_FAILED')) };
	}

	let round1;
	try {
		round1 = await multicall(client, markets.flatMap((market) => round1Calls(market, user)), blockNumber, deadline, rpcTimeoutMs);
	} catch (error) {
		return { blockNumber, markets: markets.map((market) => unavailable(market, error instanceof MarketUnavailable ? error.reason : 'RPC_FAILED')) };
	}

	const heads = markets.map((market, i) => {
		try { return { market, head: parseRound1(market, round1.slice(i * ROUND1_SIZE, (i + 1) * ROUND1_SIZE)) }; }
		catch (error) { return { market, error: error instanceof MarketUnavailable ? error.reason : 'PARSE_FAILED' }; }
	});
	const readable = heads.filter((entry) => entry.head);
	const calls = readable.map(({ market, head }) => round2Calls(market, user, head.reserves));
	const total = round1.length + calls.reduce((sum, list) => sum + list.length, 0);
	if (total > LIMITS.maxCallsPerLookup) {
		return { blockNumber, markets: markets.map((market) => unavailable(market, 'CALL_LIMIT')) };
	}

	let round2 = [];
	if (calls.length) {
		try {
			round2 = await multicall(client, calls.flat(), blockNumber, deadline, rpcTimeoutMs);
		} catch (error) {
			const reason = error instanceof MarketUnavailable ? error.reason : 'RPC_FAILED';
			return { blockNumber, markets: heads.map((entry) => unavailable(entry.market, entry.error ?? reason)) };
		}
	}

	let offset = 0;
	const slices = new Map(readable.map(({ market }, i) => {
		const slice = round2.slice(offset, offset + calls[i].length);
		offset += calls[i].length;
		return [market.deploymentKey, slice];
	}));
	return {
		blockNumber,
		markets: heads.map(({ market, head, error }) => {
			if (error) return unavailable(market, error);
			try {
				return { market, status: 'OK', position: buildPosition(market, owner, head, slices.get(market.deploymentKey), blockNumber, detectedAt) };
			} catch (failure) {
				return unavailable(market, failure instanceof MarketUnavailable ? failure.reason : 'PARSE_FAILED');
			}
		})
	};
}

export const _abi = { PROVIDER_ABI, POOL_ABI, ORACLE_ABI, DATA_PROVIDER_ABI };
