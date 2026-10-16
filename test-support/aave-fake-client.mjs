/*
	Offline-Attrappe fuer readAaveV3Positions: beantwortet jeden Multicall-Aufruf
	aus einer Fixture (wie in test/positions.test.mjs) und zaehlt die Aufrufe.
	Nur die Teile, die ein vollstaendiges Ergebnis "eine USDC-Position in Core,
	sonst leer" brauchen. Kein Netz.
*/
import { AAVE_V3_MARKETS } from '../src/positions/aave-registry.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';
const MAX_UINT = (1n << 256n) - 1n;
export const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
export const CATALOG = [{ productId: 97, officialName: 'Aave v3', normalizedName: 'aave v3', productType: 0, typeName: 'Single Protocol Cover', status: 'ACTIVE', deprecated: false }];

const reserve = (address, symbol, decimals, price, user = {}) => ({ address, symbol, decimals, price, supply: 0n, stableDebt: 0n, variableDebt: 0n, collateral: false, liquidationThreshold: 8_000n, ...user });

function marketState(market, reserves) {
	return { market, reserves, pool: market.pool, oracle: market.oracle, dataProvider: market.dataProvider, baseCurrency: ZERO, baseUnit: 100_000_000n, account: [0n, 0n, 0n, 8_200n, 7_500n, MAX_UINT] };
}

/** Eine USDC-Einlage (5 USDC) im Core-Markt, Lido und EtherFi leer. `fail` laesst jede Lesung scheitern. */
export function aaveClient({ fail = false } = {}) {
	const [core, ...rest] = AAVE_V3_MARKETS;
	const states = [marketState(core, [reserve(USDC, 'USDC', 6, 100_000_000n, { supply: 5_000_000n })]), ...rest.map((m) => marketState(m, [reserve(WETH, 'WETH', 18, 300_000_000_000n)]))];
	const byAddress = new Map();
	for (const s of states) for (const a of [s.market.poolAddressesProvider, s.market.pool, s.market.dataProvider, s.market.oracle]) byAddress.set(a.toLowerCase(), s);
	const client = { calls: 0 };
	client.getBlockNumber = async () => { client.calls++; if (fail) throw new Error('rpc down'); return 21_000_000n; };
	client.multicall = async ({ contracts }) => contracts.map((c) => {
		client.calls++;
		const s = byAddress.get(c.address.toLowerCase());
		if (!s) return { status: 'failure', error: new Error('unknown contract') };
		const find = (a) => s.reserves.find((r) => r.address.toLowerCase() === String(a).toLowerCase());
		switch (c.functionName) {
			case 'getPool': return { status: 'success', result: s.pool };
			case 'getPriceOracle': return { status: 'success', result: s.oracle };
			case 'getPoolDataProvider': return { status: 'success', result: s.dataProvider };
			case 'getReservesList': return { status: 'success', result: s.reserves.map((r) => r.address) };
			case 'getUserAccountData': return { status: 'success', result: s.account };
			case 'BASE_CURRENCY': return { status: 'success', result: s.baseCurrency };
			case 'BASE_CURRENCY_UNIT': return { status: 'success', result: s.baseUnit };
			case 'getAllReservesTokens': return { status: 'success', result: s.reserves.map((r) => ({ symbol: r.symbol, tokenAddress: r.address })) };
			case 'getUserReserveData': { const r = find(c.args[0]); return { status: 'success', result: [r.supply, r.stableDebt, r.variableDebt, 0n, 0n, 0n, 0n, 0, r.collateral] }; }
			case 'getReserveConfigurationData': { const r = find(c.args[0]); return { status: 'success', result: [BigInt(r.decimals), 7_500n, r.liquidationThreshold, 10_500n, 1_000n, true, true, false, true, false] }; }
			case 'getAssetsPrices': return { status: 'success', result: c.args[0].map((a) => find(a).price) };
			default: return { status: 'failure', error: new Error('unexpected function') };
		}
	});
	return client;
}
