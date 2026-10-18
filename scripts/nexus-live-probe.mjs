/*
	Optionale Live-Probe der lesenden Nexus-Integration (P1 + P2, 18.10.2026; P3-Quote).

	NICHT Teil von test/test:ci: normale Tests laufen nur gegen die Mitschnitte in
	test/fixtures/nexus. Diese Probe liest die echte oeffentliche API (nur die
	GET-Endpunkte aus src/nexus-read-api.mjs) und meldet, ob Produkt 97 noch
	der gepinnten Identitaet entspricht. Keine Wallet, keine RPC, keine
	Transaktion, kein Schreiben; eine Quote nur mit --quote.

	  node scripts/nexus-live-probe.mjs            Lesemodell (Produkt, Typ, Kapazitaet)
	  node scripts/nexus-live-probe.mjs --quote    zusaetzlich eine Quote (P3):
	                                               1000 USDC, 30 Tage, GET /v2/quote
	Der USDC-Referenzpreis der synthetischen Position ist fest 1 USD (keine RPC).

	Exit 0: AVAILABLE fuer eine synthetische Aave-v3-Core-Position.
	Exit 1: alles andere (Identitaet, Wording oder Kapazitaet abweichend/fehlend).
*/
import { AAVE_V3_MARKETS } from '../src/positions/aave-registry.mjs';
import { getNexusReadModel } from '../src/nexus-read-model.mjs';
import { requestCoverQuote } from '../src/nexus-quote.mjs';

const core = AAVE_V3_MARKETS.find((market) => market.deploymentKey === 'aave-v3-ethereum-core');
const position = {
	chainId: core.chainId,
	protocolKey: core.protocolKey,
	protocolVersion: core.protocolVersion,
	deploymentKey: core.deploymentKey,
	marketAddress: core.pool,
	supplied: [{ usdValue: '1000' }],
	borrowed: [],
	totals: { suppliedUsd: '1000', debtUsd: '0' },
	valueKind: 'DERIVED_FROM_AAVE_ORACLE',
	pricing: { source: 'aave-oracle', baseCurrency: 'USD', reference: [{ token: 'USDC', asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, price: '100000000' }] },
	blockNumber: null
};

const model = await getNexusReadModel(position);
console.log(JSON.stringify({
	eligibility: model.eligibility,
	nexusMatch: model.nexusMatch,
	capacity: model.capacity && { status: model.capacity.status, fetchedAt: model.capacity.fetchedAt, assets: model.capacity.assets?.map((asset) => `${asset.symbol} ${asset.formatted}`) },
	wording: model.wording && { wordingUrl: model.wording.wordingUrl, annexUrl: model.wording.annexUrl, gracePeriodDays: model.wording.gracePeriodDays }
}, null, 2));
let quoteOk = true;
if (process.argv.includes('--quote')) {
	const quote = await requestCoverQuote({ coverAsset: 'USDC', amount: '1000', periodDays: 30 }, await getNexusReadModel(position, { capacityMaxAgeMs: 60_000 }), position);
	console.log(JSON.stringify({ quote }, null, 2));
	quoteOk = quote.ok === true;
}
process.exitCode = model.eligibility.status === 'AVAILABLE' && quoteOk ? 0 : 1;
