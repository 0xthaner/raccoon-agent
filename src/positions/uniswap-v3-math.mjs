/*
	UNISWAP V3 - REINE POSITIONSMATHEMATIK, INAKTIV (21.10.2026).

	Exakte BigInt-Portierung der Uniswap-Referenz (Uniswap/v3-core und
	v3-periphery, am 21.10.2026 gelesen):

	  TickMath.getSqrtRatioAtTick          -> sqrtRatioAtTick
	  FullMath.mulDiv                      -> mulDiv (Ueberlauf wirft, wie revert)
	  SqrtPriceMath.getAmount0/1Delta      -> amount0Delta / amount1Delta (abgerundet)
	  UniswapV3Pool._modifyPosition        -> principalAmounts (Fallunterscheidung
	                                          ueber slot0.tick, wie der Pool beim burn)
	  Tick.getFeeGrowthInside + NPM.collect -> uncollectedFees (Subtraktion modulo
	                                          2^256, wie in Solidity <0.8 beabsichtigt)

	Abgerundet heisst: genau das, was der Pool bei einem vollstaendigen
	decreaseLiquidity auszahlen wuerde. Am 21.10.2026 gegen eth_call
	(decreaseLiquidity und collect vom Eigentuemer, ohne Transaktion) auf neun
	Live-Positionen geprueft: identisch bis auf die letzte Einheit.

	Kein Gleitkomma, keine Netzaufrufe, keine Seiteneffekte. Jede unmoegliche
	Eingabe wirft UniswapMathError mit festem Grund.
*/

export class UniswapMathError extends Error {
	constructor(reason) { super(reason); this.reason = reason; }
}

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;
export const MAX_UINT128 = (1n << 128n) - 1n;
export const MAX_UINT160 = (1n << 160n) - 1n;
export const MAX_UINT256 = (1n << 256n) - 1n;
const MOD256 = 1n << 256n;

const fail = (reason) => { throw new UniswapMathError(reason); };
const isUint = (value, max) => typeof value === 'bigint' && value >= 0n && value <= max;
export const isTick = (tick) => Number.isSafeInteger(tick) && tick >= MIN_TICK && tick <= MAX_TICK;

// TickMath-Konstanten, Reihenfolge = Bit 0x2 ... 0x80000.
const TICK_FACTORS = [
	0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
	0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n, 0xff2ea16466c96a3843ec78b326b52861n,
	0xfe5dee046a99a2a811c461f1969c3053n, 0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n,
	0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n, 0xd097f3bdfd2022b8845ad8f792aa5825n,
	0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
	0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n, 0x2216e584f5fa1ea926041bedfe98n,
	0x48a170391f7dc42444e8fa2n
];

/** sqrt(1.0001^tick) * 2^96, aufgerundet wie TickMath. */
export function sqrtRatioAtTick(tick) {
	if (!isTick(tick)) fail('TICK_OUT_OF_RANGE');
	const absTick = BigInt(Math.abs(tick));
	let ratio = (absTick & 1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
	TICK_FACTORS.forEach((factor, i) => {
		if ((absTick & (2n << BigInt(i))) !== 0n) ratio = (ratio * factor) >> 128n;
	});
	if (tick > 0) ratio = MAX_UINT256 / ratio;
	return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** floor(a * b / d) mit voller Genauigkeit; wirft bei d = 0 oder Ergebnis >= 2^256. */
export function mulDiv(a, b, d) {
	if (!isUint(a, MAX_UINT256) || !isUint(b, MAX_UINT256) || !isUint(d, MAX_UINT256) || d === 0n) fail('MULDIV_INPUT');
	const result = (a * b) / d;
	if (result > MAX_UINT256) fail('MULDIV_OVERFLOW');
	return result;
}

const ordered = (a, b) => (a > b ? [b, a] : [a, b]);

/** SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, liquidity, roundUp = false). */
export function amount0Delta(sqrtA, sqrtB, liquidity) {
	if (!isUint(sqrtA, MAX_UINT160) || !isUint(sqrtB, MAX_UINT160) || !isUint(liquidity, MAX_UINT128)) fail('AMOUNT_INPUT');
	const [lower, upper] = ordered(sqrtA, sqrtB);
	if (lower === 0n) fail('ZERO_SQRT_PRICE');
	return mulDiv(liquidity << 96n, upper - lower, upper) / lower;
}

/** SqrtPriceMath.getAmount1Delta(sqrtA, sqrtB, liquidity, roundUp = false). */
export function amount1Delta(sqrtA, sqrtB, liquidity) {
	if (!isUint(sqrtA, MAX_UINT160) || !isUint(sqrtB, MAX_UINT160) || !isUint(liquidity, MAX_UINT128)) fail('AMOUNT_INPUT');
	const [lower, upper] = ordered(sqrtA, sqrtB);
	return mulDiv(liquidity, upper - lower, Q96);
}

/*
	slot0 muss in sich stimmig sein: sqrtRatioAtTick(tick) <= sqrtPriceX96 <=
	sqrtRatioAtTick(tick + 1). Die obere Grenze ist einschliesslich: endet ein
	Swap abwaerts genau auf einer Tick-Grenze, setzt der Pool tick = next - 1 bei
	sqrtPrice = sqrtRatioAtTick(next).
*/
export function assertSlot0(sqrtPriceX96, tick) {
	if (!isUint(sqrtPriceX96, MAX_UINT160) || sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) fail('SQRT_PRICE_OUT_OF_RANGE');
	if (!isTick(tick)) fail('TICK_OUT_OF_RANGE');
	if (sqrtRatioAtTick(tick) > sqrtPriceX96) fail('SLOT0_INCONSISTENT');
	if (tick < MAX_TICK && sqrtPriceX96 > sqrtRatioAtTick(tick + 1)) fail('SLOT0_INCONSISTENT');
}

export const RANGE_STATES = Object.freeze(['BELOW_RANGE', 'IN_RANGE', 'ABOVE_RANGE']);

/** Wo der Kurs relativ zur Spanne liegt - dieselbe Fallunterscheidung wie der Pool. */
export function rangeState(tick, tickLower, tickUpper) {
	if (tick < tickLower) return 'BELOW_RANGE';
	if (tick < tickUpper) return 'IN_RANGE';
	return 'ABOVE_RANGE';
}

/**
 * Token-Mengen, die ein vollstaendiges Entfernen der Liquiditaet jetzt ergaebe
 * (ohne Gebuehren). Unterhalb der Spanne nur token0, oberhalb nur token1.
 */
export function principalAmounts({ liquidity, tickLower, tickUpper, sqrtPriceX96, tick }) {
	if (!isUint(liquidity, MAX_UINT128)) fail('LIQUIDITY_INVALID');
	if (!isTick(tickLower) || !isTick(tickUpper)) fail('TICK_OUT_OF_RANGE');
	if (tickLower >= tickUpper) fail('TICK_ORDER');
	assertSlot0(sqrtPriceX96, tick);
	const sqrtLower = sqrtRatioAtTick(tickLower);
	const sqrtUpper = sqrtRatioAtTick(tickUpper);
	const state = rangeState(tick, tickLower, tickUpper);
	if (liquidity === 0n) return Object.freeze({ amount0: 0n, amount1: 0n, rangeState: state });
	if (state === 'BELOW_RANGE') return Object.freeze({ amount0: amount0Delta(sqrtLower, sqrtUpper, liquidity), amount1: 0n, rangeState: state });
	if (state === 'IN_RANGE') return Object.freeze({ amount0: amount0Delta(sqrtPriceX96, sqrtUpper, liquidity), amount1: amount1Delta(sqrtLower, sqrtPriceX96, liquidity), rangeState: state });
	return Object.freeze({ amount0: 0n, amount1: amount1Delta(sqrtLower, sqrtUpper, liquidity), rangeState: state });
}

const sub256 = (a, b) => (((a - b) % MOD256) + MOD256) % MOD256;

/** Tick.getFeeGrowthInside, Subtraktion modulo 2^256. */
export function feeGrowthInside({ tick, tickLower, tickUpper, feeGrowthGlobal0X128, feeGrowthGlobal1X128, lower, upper }) {
	for (const value of [feeGrowthGlobal0X128, feeGrowthGlobal1X128, lower?.feeGrowthOutside0X128, lower?.feeGrowthOutside1X128, upper?.feeGrowthOutside0X128, upper?.feeGrowthOutside1X128]) {
		if (!isUint(value, MAX_UINT256)) fail('FEE_GROWTH_INVALID');
	}
	const inside = (global, lowerOutside, upperOutside) => {
		const below = tick >= tickLower ? lowerOutside : sub256(global, lowerOutside);
		const above = tick < tickUpper ? upperOutside : sub256(global, upperOutside);
		return sub256(sub256(global, below), above);
	};
	return Object.freeze({
		inside0X128: inside(feeGrowthGlobal0X128, lower.feeGrowthOutside0X128, upper.feeGrowthOutside0X128),
		inside1X128: inside(feeGrowthGlobal1X128, lower.feeGrowthOutside1X128, upper.feeGrowthOutside1X128)
	});
}

/**
 * Nicht eingesammelte Gebuehren wie NonfungiblePositionManager.collect sie
 * auszahlen wuerde: tokensOwed + floor((inside - insideLast) * liquidity / 2^128).
 * Wo der NPM still auf uint128 kuerzen wuerde, wird hier abgelehnt.
 */
export function uncollectedFees({ liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1 }, inside) {
	if (!isUint(liquidity, MAX_UINT128) || !isUint(tokensOwed0, MAX_UINT128) || !isUint(tokensOwed1, MAX_UINT128)) fail('POSITION_INVALID');
	if (!isUint(feeGrowthInside0LastX128, MAX_UINT256) || !isUint(feeGrowthInside1LastX128, MAX_UINT256)) fail('FEE_GROWTH_INVALID');
	const accrued0 = mulDiv(sub256(inside.inside0X128, feeGrowthInside0LastX128), liquidity, Q128);
	const accrued1 = mulDiv(sub256(inside.inside1X128, feeGrowthInside1LastX128), liquidity, Q128);
	if (accrued0 > MAX_UINT128 || accrued1 > MAX_UINT128) fail('FEE_OVERFLOW');
	const amount0 = tokensOwed0 + accrued0;
	const amount1 = tokensOwed1 + accrued1;
	if (amount0 > MAX_UINT128 || amount1 > MAX_UINT128) fail('FEE_OVERFLOW');
	return Object.freeze({ amount0, amount1 });
}
