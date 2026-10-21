/**
 * Preis-Referenzen in USD (21.10.2026) - rein, offline.
 *
 * Grundlage: test/fixtures/prices/chainlink-ethereum-20261021.json - Chainlink
 * Reference Data Directory (Proxy, Heartbeat, Abweichung), on-chain gelesene
 * Feeds in einem Block (decimals, description, aggregator, latestRoundData),
 * Token-Identitaeten (on-chain und Uniswap-Standardliste) und zur Einordnung
 * die Quellen des Aave-v3-Core-Orakels.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';

const P = await import('../src/positions/price-reference.mjs');
const A = await import('../src/positions/aave-multichain-activation.mjs');
const EV = JSON.parse(readFileSync(new URL('./fixtures/prices/chainlink-ethereum-20261021.json', import.meta.url), 'utf8'));

const B = (x) => BigInt(x);
const BLOCK = { number: B(EV.block.number), timestamp: B(EV.block.timestamp) };
const TOKENS = Object.fromEntries(Object.entries(EV.tokens).map(([symbol, t]) => [symbol, t.address]));
const round = (key) => {
	const o = EV.feeds[key].onchain;
	const r = o.latestRoundData;
	return { blockNumber: BLOCK.number, ok: true, description: o.description, decimals: o.decimals, roundId: B(r.roundId), answer: B(r.answer), startedAt: B(r.startedAt), updatedAt: B(r.updatedAt), answeredInRound: B(r.answeredInRound) };
};
const READINGS = Object.fromEntries(Object.keys(EV.feeds).map((key) => [key, round(key)]));
const price = (token, extra = {}) => P.evaluatePriceReference({ chainId: 1, token, block: BLOCK, readings: READINGS, ...extra });
const withFeed = (key, patch) => ({ ...READINGS, [key]: { ...READINGS[key], ...patch } });

test('PR-PINS every pinned feed equals the Chainlink directory and the chain; every token equals chain and Uniswap list', () => {
	assert.equal(EV.chainId, 1);
	for (const [key, feed] of Object.entries(P.CHAINLINK_FEEDS)) {
		const ev = EV.feeds[key];
		assert.ok(ev, key);
		assert.equal(feed.proxy, getAddress(ev.directory.proxyAddress), `${key} proxy`);
		assert.equal(feed.proxy, getAddress(feed.proxy), `${key} checksummed`);
		assert.equal(feed.heartbeatSec, Number(ev.directory.heartbeat), `${key} heartbeat from the directory, not invented`);
		assert.equal(feed.deviationPercent, ev.directory.threshold, `${key} deviation`);
		assert.equal(ev.directory.ens, key, 'canonical ENS path, not an SVR or shared variant');
		assert.deepEqual([ev.onchain.description, ev.onchain.decimals, feed.decimals], [feed.description, 8, 8], `${key} on-chain identity`);
		assert.equal(ev.onchain.aggregator, ev.directory.contractAddress, `${key} proxy points at the listed aggregator`);
		assert.ok(ev.onchain.codeBytes > 0);
		const r = ev.onchain.latestRoundData;
		assert.ok(B(r.answer) > 0n && B(r.updatedAt) > 0n && B(r.answeredInRound) >= B(r.roundId), `${key} live round sane`);
		assert.ok(BLOCK.timestamp - B(r.updatedAt) <= B(P.maxFeedAgeSec(feed.heartbeatSec)), `${key} fresh at the evidence block`);
	}
	for (const entry of Object.values(P.PRICE_SOURCES)) {
		const ev = EV.tokens[entry.symbol];
		assert.equal(entry.token, ev.address);
		assert.deepEqual([ev.decimals, ev.symbol], [entry.decimals, entry.symbol], `${entry.symbol} on-chain`);
		const listed = EV.uniswapTokenList.tokens.find((t) => t.symbol === entry.symbol);
		assert.deepEqual([listed.address, listed.decimals], [entry.token, entry.decimals], `${entry.symbol} Uniswap default list`);
	}
	// cbBTC hat einen eigenen Feed; BTC/USD waere ein aehnlich benannter Ersatz und ist nicht seine Quelle
	assert.deepEqual([...P.PRICE_SOURCES[`1:${TOKENS.cbBTC.toLowerCase()}`].feeds], ['cbbtc-usd']);
	assert.equal(EV.feeds['cbbtc-usd'].directory.attributeType, 'dex_state_price');
	// Directory kennt Varianten (SVR, shared SVR); gepinnt ist nur der kanonische Pfad
	const variants = EV.allDirectoryEntriesForThesePairs.filter((f) => f.path !== f.ens || f.svrDisplayLabel);
	assert.ok(variants.length > 0);
	for (const v of variants) assert.ok(!Object.values(P.CHAINLINK_FEEDS).some((f) => f.proxy.toLowerCase() === v.proxyAddress.toLowerCase()), `${v.path} not used`);
});

test('PR-OK WETH, USDC, cbBTC, USDT, WBTC and PAXG resolve to exactly their feed with 8-decimal integer prices', () => {
	const expect = { WETH: 'eth-usd', USDC: 'usdc-usd', cbBTC: 'cbbtc-usd', USDT: 'usdt-usd', PAXG: 'paxg-usd' };
	for (const [symbol, key] of Object.entries(expect)) {
		const r = price(TOKENS[symbol]);
		assert.equal(r.status, 'PRICE_OK', `${symbol}: ${r.reason}`);
		assert.deepEqual([r.sourceType, r.sourceAddress, r.priceUsd8, r.chainId, r.token, r.blockNumber, r.blockTimestamp], ['CHAINLINK_DIRECT', P.CHAINLINK_FEEDS[key].proxy, B(EV.feeds[key].onchain.latestRoundData.answer), 1, TOKENS[symbol], EV.block.number, EV.block.timestamp]);
		assert.equal(typeof r.priceUsd8, 'bigint');
		assert.equal(r.updatedAt, EV.feeds[key].onchain.latestRoundData.updatedAt);
		assert.ok(Object.isFrozen(r));
	}
	// WBTC: WBTC/BTC x BTC/USD, exakt, abgerundet, aelterer Zeitstempel zaehlt
	const w = price(TOKENS.WBTC);
	const a = B(EV.feeds['wbtc-btc'].onchain.latestRoundData.answer);
	const b = B(EV.feeds['btc-usd'].onchain.latestRoundData.answer);
	assert.deepEqual([w.status, w.sourceType, w.sourceAddress, w.priceUsd8], ['PRICE_OK', 'CHAINLINK_COMPOSITE', null, (a * b) / 10n ** 8n]);
	assert.deepEqual([...w.feeds], [P.CHAINLINK_FEEDS['wbtc-btc'].proxy, P.CHAINLINK_FEEDS['btc-usd'].proxy]);
	assert.equal(w.updatedAt, [EV.feeds['wbtc-btc'], EV.feeds['btc-usd']].map((f) => B(f.onchain.latestRoundData.updatedAt)).reduce((x, y) => (x < y ? x : y)).toString());
	// WBTC faellt aus, wenn einer der beiden Feeds faellt
	assert.equal(price(TOKENS.WBTC, { readings: withFeed('btc-usd', { updatedAt: BLOCK.timestamp - 3_781n }) }).reason, 'btc-usd:OLDER_THAN_HEARTBEAT');
	assert.equal(price(TOKENS.WBTC, { readings: { ...READINGS, 'wbtc-btc': undefined } }).reason, 'wbtc-btc:FEED_READ_FAILED');
});

test('PR-IDENTITY only chainId + exact address: fake USDC/WETH, other chain, bad chainId, case and checksum', () => {
	const FAKE = '0x00000000000000000000000000000000000fa4e1';
	for (const token of [FAKE, '0x0000000000000000000000000000000000000000', TOKENS.WETH.toLowerCase().replace(/c2$/, 'c3')]) {
		assert.deepEqual([price(token).status, price(token).reason, price(token).priceUsd8], ['PRICE_UNAVAILABLE', 'UNSUPPORTED_TOKEN', null]);
	}
	// gleiche Adresse auf anderer Chain: kein Preis
	for (const chainId of [10, 8453, 42161, 137]) assert.deepEqual([price(TOKENS.USDC, { chainId }).status, price(TOKENS.USDC, { chainId }).reason], ['PRICE_UNAVAILABLE', 'UNSUPPORTED_TOKEN']);
	for (const chainId of ['1', 1.5, 0, -1, NaN, null, undefined, 1n, Number.MAX_SAFE_INTEGER + 1]) {
		assert.deepEqual([price(TOKENS.USDC, { chainId }).status, price(TOKENS.USDC, { chainId }).reason], ['PRICE_UNAVAILABLE', 'INVALID_CHAIN_ID'], String(chainId));
	}
	// klein, Pruefsumme: gleiches Ergebnis; Pruefsummen-Ausgabe
	assert.equal(price(TOKENS.USDC.toLowerCase()).priceUsd8, price(TOKENS.USDC).priceUsd8);
	assert.equal(price(TOKENS.USDC.toLowerCase()).token, TOKENS.USDC);
	// gemischte Schreibweise mit falscher Pruefsumme ist keine Adresse
	const broken = `0x${TOKENS.USDC.slice(2, 3).toLowerCase() === TOKENS.USDC.slice(2, 3) ? TOKENS.USDC.slice(2, 3).toUpperCase() : TOKENS.USDC.slice(2, 3).toLowerCase()}${TOKENS.USDC.slice(3)}`;
	for (const token of [broken, 'USDC', 'usdc', '', null, 42, `${TOKENS.USDC}00`]) assert.equal(price(token).reason, 'INVALID_TOKEN', String(token));
	// on-chain gemeldete Dezimalstellen, die nicht zum Pin passen: mehrdeutig
	assert.deepEqual([price(TOKENS.USDC, { decimals: 18 }).status, price(TOKENS.USDC, { decimals: 18 }).reason], ['PRICE_AMBIGUOUS', 'TOKEN_DECIMALS_CONFLICT']);
	assert.equal(price(TOKENS.USDC, { decimals: 6 }).status, 'PRICE_OK');
	// nur der kanonische Schluessel zaehlt; ein Eintrag unter Pruefsummen- oder Symbol-Schluessel nie
	const key = `1:${TOKENS.USDC.toLowerCase()}`;
	for (const other of [`1:${TOKENS.USDC}`, 'USDC', `${TOKENS.USDC.toLowerCase()}`]) {
		assert.equal(P.evaluatePriceReference({ chainId: 1, token: TOKENS.USDC, block: BLOCK, readings: READINGS }, { registry: { [other]: P.PRICE_SOURCES[key] } }).reason, 'UNSUPPORTED_TOKEN', other);
	}
	// Eintrag, der unter dem richtigen Schluessel eine andere Adresse nennt: gilt nicht
	assert.equal(P.evaluatePriceReference({ chainId: 1, token: TOKENS.USDC, block: BLOCK, readings: READINGS }, { registry: { [key]: P.PRICE_SOURCES[`1:${TOKENS.USDT.toLowerCase()}`] } }).reason, 'UNSUPPORTED_TOKEN');
	// ein Eintrag mit falscher chainId unter richtigem Schluessel gilt nicht
	const wrongChain = { [key]: { ...P.PRICE_SOURCES[key], chainId: 10 } };
	assert.equal(P.evaluatePriceReference({ chainId: 1, token: TOKENS.USDC, block: BLOCK, readings: READINGS }, { registry: wrongChain }).reason, 'UNSUPPORTED_TOKEN');
	assert.ok(Object.keys(P.PRICE_SOURCES).every((k) => /^1:0x[0-9a-f]{40}$/.test(k)), 'keys are chainId:lowercase address, never symbols');
});

test('PR-FRESHNESS heartbeat + max(60 s, 5 %) against block.timestamp; stale, future, zero, negative, missing heartbeat fail closed', () => {
	assert.deepEqual([P.maxFeedAgeSec(3_600), P.maxFeedAgeSec(82_800), P.maxFeedAgeSec(86_400), P.maxFeedAgeSec(1_200), P.maxFeedAgeSec(27), P.maxFeedAgeSec(1_201)], [3_780, 86_940, 90_720, 1_260, 87, 1_262]);
	for (const bad of [0, -1, 1.5, '3600', null, undefined, NaN]) assert.equal(P.maxFeedAgeSec(bad), null);
	// Aave-Multichain nutzt dieselbe Regel
	for (const hb of [27, 1_200, 3_600, 86_400, 1_201]) assert.equal(A.maxFeedAgeSec(hb), P.maxFeedAgeSec(hb));
	assert.equal(A.ORACLE_POLICY.sequencerGraceSec, 3_600);

	const at = (updatedAt) => price(TOKENS.WETH, { readings: withFeed('eth-usd', { updatedAt }) });
	assert.equal(at(BLOCK.timestamp - 3_780n).status, 'PRICE_OK', 'exactly at the limit');
	assert.deepEqual([at(BLOCK.timestamp - 3_781n).status, at(BLOCK.timestamp - 3_781n).reason], ['PRICE_STALE', 'eth-usd:OLDER_THAN_HEARTBEAT']);
	assert.equal(at(BLOCK.timestamp).status, 'PRICE_OK', 'same second');
	assert.deepEqual([at(BLOCK.timestamp + 1n).status, at(BLOCK.timestamp + 1n).reason], ['PRICE_SOURCE_INVALID', 'eth-usd:UPDATED_IN_FUTURE']);
	assert.deepEqual([at(0n).status, at(0n).reason], ['PRICE_SOURCE_INVALID', 'eth-usd:ROUND_INCOMPLETE']);
	// "jetzt" ist der Block, nicht die Uhr der Maschine
	const later = { number: BLOCK.number, timestamp: BLOCK.timestamp + 100_000n };
	assert.equal(price(TOKENS.USDC, { block: later }).status, 'PRICE_STALE');
	for (const answer of [0n, -1n, -245545211980n]) {
		const r = price(TOKENS.WETH, { readings: withFeed('eth-usd', { answer }) });
		assert.deepEqual([r.status, r.reason, r.priceUsd8], ['PRICE_SOURCE_INVALID', 'eth-usd:NON_POSITIVE_ANSWER', null]);
	}
	assert.deepEqual([price(TOKENS.WETH, { readings: withFeed('eth-usd', { answeredInRound: READINGS['eth-usd'].roundId - 1n }) }).status], ['PRICE_STALE']);
	assert.equal(price(TOKENS.WETH, { readings: withFeed('eth-usd', { answer: 245545211980 }) }).reason, 'eth-usd:ROUND_MALFORMED', 'number is not accepted');
	assert.equal(price(TOKENS.WETH, { readings: withFeed('eth-usd', { description: 'ETH / USD ' }) }).reason, 'eth-usd:DESCRIPTION_MISMATCH');
	assert.equal(price(TOKENS.WETH, { readings: withFeed('eth-usd', { decimals: 18 }) }).reason, 'eth-usd:DECIMALS_MISMATCH');
	assert.equal(price(TOKENS.WETH, { readings: withFeed('eth-usd', { ok: false }) }).reason, 'eth-usd:FEED_READ_FAILED');
	assert.equal(price(TOKENS.WETH, { readings: {} }).reason, 'eth-usd:FEED_READ_FAILED');
	// fehlender oder kaputter Heartbeat: nie ein angenommener Wert
	for (const heartbeatSec of [undefined, 0, null, '3600']) {
		const feeds = { ...P.CHAINLINK_FEEDS, 'eth-usd': { ...P.CHAINLINK_FEEDS['eth-usd'], heartbeatSec } };
		const r = P.evaluatePriceReference({ chainId: 1, token: TOKENS.WETH, block: BLOCK, readings: READINGS }, { feeds });
		assert.deepEqual([r.status, r.reason], ['PRICE_UNAVAILABLE', 'eth-usd:HEARTBEAT_UNKNOWN'], String(heartbeatSec));
	}
	const { 'eth-usd': _dropped, ...noFeed } = P.CHAINLINK_FEEDS;
	assert.equal(P.evaluatePriceReference({ chainId: 1, token: TOKENS.WETH, block: BLOCK, readings: READINGS }, { feeds: noFeed }).reason, 'SOURCE_NOT_PINNED');
});

test('PR-SAME-BLOCK a reading from another block or without block is never used', () => {
	const r = price(TOKENS.USDC, { readings: withFeed('usdc-usd', { blockNumber: BLOCK.number - 1n }) });
	assert.deepEqual([r.status, r.reason], ['PRICE_UNAVAILABLE', 'usdc-usd:NOT_SAME_BLOCK']);
	assert.equal(price(TOKENS.USDC, { readings: withFeed('usdc-usd', { blockNumber: undefined }) }).reason, 'usdc-usd:NOT_SAME_BLOCK');
	assert.equal(price(TOKENS.USDC, { readings: withFeed('usdc-usd', { blockNumber: Number(BLOCK.number) }) }).reason, 'usdc-usd:NOT_SAME_BLOCK', 'type matters');
	for (const block of [null, undefined, {}, { number: BLOCK.number }, { number: Number(BLOCK.number), timestamp: BLOCK.timestamp }, { number: 0n, timestamp: 1n }]) {
		assert.equal(price(TOKENS.USDC, { block }).reason, 'NO_BLOCK');
	}
	// WBTC: beide Feeds muessen aus dem Block stammen
	assert.equal(price(TOKENS.WBTC, { readings: withFeed('btc-usd', { blockNumber: BLOCK.number + 1n }) }).reason, 'btc-usd:NOT_SAME_BLOCK');
	// Aufrufliste und Rueckweg fuer den Leser
	const contracts = P.priceReadContracts(1, [TOKENS.WBTC, TOKENS.USDC.toLowerCase(), '0x00000000000000000000000000000000000fa4e1', 'junk']);
	assert.deepEqual([...new Set(contracts.map((c) => c.feedKey))], ['btc-usd', 'usdc-usd', 'wbtc-btc']);
	assert.ok(contracts.every((c) => c.abi.find((f) => f.name === c.functionName).stateMutability === 'view'));
	assert.deepEqual(P.priceReadContracts('1', [TOKENS.USDC]), []);
	assert.deepEqual(P.priceReadContracts(10, [TOKENS.USDC]), []);
	const results = contracts.map((c) => {
		const ev = READINGS[c.feedKey];
		if (c.functionName === 'latestRoundData') return { status: 'success', result: [ev.roundId, ev.answer, ev.startedAt, ev.updatedAt, ev.answeredInRound] };
		return { status: 'success', result: ev[c.functionName] };
	});
	const readings = P.readingsFromResults(contracts, results, BLOCK.number);
	assert.equal(P.evaluatePriceReference({ chainId: 1, token: TOKENS.WBTC, block: BLOCK, readings }).priceUsd8, price(TOKENS.WBTC).priceUsd8);
	const partial = P.readingsFromResults(contracts, results.map((r, i) => (i === 0 ? { status: 'failure' } : r)), BLOCK.number);
	assert.equal(P.evaluatePriceReference({ chainId: 1, token: TOKENS.WBTC, block: BLOCK, readings: partial }).reason, 'btc-usd:FEED_READ_FAILED');
});

test('PR-MATH exact integer value for 6/8/18 decimals and very large amounts, floor rounding, no floats', () => {
	const usdc = price(TOKENS.USDC).priceUsd8;
	assert.equal(P.valueUsd8(1_000_000n, 6, usdc), usdc, '1 USDC');
	assert.equal(P.valueUsd8(1n, 6, 99_981_255n), 99n, 'floor(99.981255)');
	assert.equal(P.valueUsd8(10n ** 18n, 18, 245_545_211_980n), 245_545_211_980n, '1 WETH');
	assert.equal(P.valueUsd8(1n, 18, 245_545_211_980n), 0n, '1 wei rounds down to 0');
	assert.equal(P.valueUsd8(10n ** 8n, 8, 8_275_941_172_942n), 8_275_941_172_942n, '1 cbBTC');
	const huge = (1n << 128n) - 1n;
	assert.equal(P.valueUsd8(huge, 18, 245_545_211_980n), (huge * 245_545_211_980n) / 10n ** 18n);
	assert.equal(P.valueUsd8(huge, 6, (1n << 255n)), (huge * (1n << 255n)) / 10n ** 6n, 'no overflow, BigInt');
	assert.equal(P.valueUsd8(0n, 6, usdc), 0n);
	for (const [amount, decimals, p] of [[1, 6, usdc], [-1n, 6, usdc], [1n, 6, 0n], [1n, 6, -1n], [1n, 6, 1], [1n, -1, usdc], [1n, 37, usdc], [1n, 6.5, usdc]]) {
		assert.throws(() => P.valueUsd8(amount, decimals, p), TypeError);
	}
	const src = readFileSync(new URL('../src/positions/price-reference.mjs', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	assert.doesNotMatch(src, /parseFloat|Number\(reading\.answer|Math\.round|toFixed/, 'no float arithmetic on prices');
});

test('PR-AAVE verified adapter only for an exact reserve with pinned fresh source; never the default; documented redundancy', () => {
	const aave = EV.aaveCoreOracle;
	assert.equal(aave.oracle, P.AAVE_ORACLE.oracle);
	assert.equal(aave.fallbackOracle, '0x0000000000000000000000000000000000000000');
	// Nachweis: Aave nutzt fuer WETH den SVR-Proxy von ETH/USD; USDC/USDT/WBTC Adapter ohne latestRoundData; cbBTC = BTC/USD; PAXG keine Quelle
	assert.equal(aave.sources.WETH.source, P.AAVE_VERIFIED_SOURCES[TOKENS.WETH.toLowerCase()].proxy);
	assert.equal(aave.sources.WETH.source, EV.allDirectoryEntriesForThesePairs.find((f) => f.path === 'eth-usd-svr').secondaryProxyAddress, 'Aave SVR variant of ETH/USD');
	assert.equal(aave.sources.cbBTC.sourceDescription, 'BTC / USD', 'Aave prices cbBTC as BTC - not used here');
	assert.equal(aave.sources.cbBTC.source, EV.allDirectoryEntriesForThesePairs.find((f) => f.path === 'btc-usd-svr').secondaryProxyAddress);
	for (const s of ['USDC', 'USDT', 'WBTC']) assert.match(aave.sources[s].sourceLatestRoundData.error, /reverted/);
	assert.equal(aave.sources.PAXG.source, '0x0000000000000000000000000000000000000000');
	assert.deepEqual(Object.keys(P.AAVE_VERIFIED_SOURCES), [TOKENS.WETH.toLowerCase()]);
	assert.ok(Object.values(P.PRICE_SOURCES).every((e) => e.sourceType !== 'AAVE_ORACLE_VERIFIED'), 'Aave is not a default source');

	const meta = P.AAVE_VERIFIED_SOURCES[TOKENS.WETH.toLowerCase()];
	const reading = { blockNumber: BLOCK.number, ok: true, description: 'ETH / USD', decimals: 8, roundId: 10n, answer: B(aave.sources.WETH.aavePrice), startedAt: 1n, updatedAt: B(aave.sources.WETH.sourceLatestRoundData.updatedAt), answeredInRound: 10n };
	const input = { chainId: 1, token: TOKENS.WETH, block: BLOCK, reserves: [TOKENS.USDC, TOKENS.WETH], baseCurrency: '0x0000000000000000000000000000000000000000', baseUnit: 10n ** 8n, sourceOfAsset: meta.proxy, aavePrice: B(aave.sources.WETH.aavePrice), sourceReading: reading };
	const ok = P.evaluateAaveOracleReference(input);
	assert.deepEqual([ok.status, ok.sourceType, ok.sourceAddress, ok.priceUsd8], ['PRICE_OK', 'AAVE_ORACLE_VERIFIED', meta.proxy, B(aave.sources.WETH.aavePrice)]);
	const reason = (patch) => P.evaluateAaveOracleReference({ ...input, ...patch }).reason;
	assert.equal(reason({ chainId: 10 }), 'INVALID_CHAIN_ID');
	assert.equal(reason({ chainId: '1' }), 'INVALID_CHAIN_ID');
	assert.equal(reason({ reserves: [TOKENS.USDC] }), 'NOT_AN_AAVE_RESERVE');
	assert.equal(reason({ reserves: undefined }), 'NOT_AN_AAVE_RESERVE');
	assert.equal(reason({ token: TOKENS.PAXG, reserves: [TOKENS.PAXG] }), 'AAVE_SOURCE_NOT_VERIFIED');
	assert.equal(reason({ token: TOKENS.cbBTC, reserves: [TOKENS.cbBTC] }), 'AAVE_SOURCE_NOT_VERIFIED');
	assert.equal(reason({ sourceOfAsset: P.CHAINLINK_FEEDS['btc-usd'].proxy }), 'AAVE_SOURCE_CHANGED');
	assert.equal(reason({ baseUnit: 10n ** 18n }), 'UNEXPECTED_BASE_CURRENCY');
	assert.equal(reason({ aavePrice: B(aave.sources.WETH.aavePrice) + 1n }), 'AAVE_PRICE_MISMATCH');
	assert.equal(reason({ aavePrice: Number(aave.sources.WETH.aavePrice) }), 'AAVE_PRICE_MISMATCH');
	assert.equal(reason({ sourceReading: { ...reading, updatedAt: BLOCK.timestamp - 3_781n } }), 'aave-source:OLDER_THAN_HEARTBEAT');
	assert.equal(reason({ sourceReading: { ...reading, blockNumber: BLOCK.number - 1n } }), 'aave-source:NOT_SAME_BLOCK');
	assert.equal(reason({ sourceReading: undefined }), 'aave-source:FEED_READ_FAILED');
	// redundant fuer WETH: dieselbe Preisreihe wie der direkte Feed (Abweichung nur durch Rundenzeitpunkt)
	const direct = price(TOKENS.WETH).priceUsd8;
	const diff = direct > ok.priceUsd8 ? direct - ok.priceUsd8 : ok.priceUsd8 - direct;
	assert.ok(diff * 1000n < direct * 5n, 'within the 0.5 % deviation threshold');
});

test('PR-SUPPORTED readable list for docs: six tokens, no symbol-only entries, max ages from the shared policy', () => {
	const list = P.supportedPriceReferences();
	assert.deepEqual(list.map((e) => e.symbol), ['WETH', 'USDC', 'cbBTC', 'USDT', 'WBTC', 'PAXG']);
	for (const e of list) {
		assert.equal(e.chainId, 1);
		assert.equal(e.token, getAddress(e.token));
		for (const f of e.feeds) assert.equal(f.maxAgeSec, P.maxFeedAgeSec(f.heartbeatSec));
	}
	assert.deepEqual([...P.PRICE_STATUSES], ['PRICE_OK', 'PRICE_UNAVAILABLE', 'PRICE_STALE', 'PRICE_SOURCE_INVALID', 'PRICE_AMBIGUOUS']);
});
