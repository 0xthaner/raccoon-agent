/*
	Optionale Live-Probe der lesenden Nexus-Integration (P1 + P2, 18.10.2026).

	NICHT Teil von test/test:ci: normale Tests laufen nur gegen die Mitschnitte in
	test/fixtures/nexus. Diese Probe liest die echte oeffentliche API (nur die
	drei GET-Endpunkte aus src/nexus-read-api.mjs) und meldet, ob Produkt 97 noch
	der gepinnten Identitaet entspricht. Keine Wallet, keine RPC, keine Quote,
	keine Transaktion, kein Schreiben.

	  node scripts/nexus-live-probe.mjs

	Exit 0: AVAILABLE fuer eine synthetische Aave-v3-Core-Position.
	Exit 1: alles andere (Identitaet, Wording oder Kapazitaet abweichend/fehlend).
*/
import { AAVE_V3_MARKETS } from '../src/positions/aave-registry.mjs';
import { getNexusReadModel } from '../src/nexus-read-model.mjs';

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
	pricing: { source: 'aave-oracle', baseCurrency: 'USD' },
	blockNumber: null
};

const model = await getNexusReadModel(position);
console.log(JSON.stringify({
	eligibility: model.eligibility,
	nexusMatch: model.nexusMatch,
	capacity: model.capacity && { status: model.capacity.status, fetchedAt: model.capacity.fetchedAt, assets: model.capacity.assets?.map((asset) => `${asset.symbol} ${asset.formatted}`) },
	wording: model.wording && { wordingUrl: model.wording.wordingUrl, annexUrl: model.wording.annexUrl, gracePeriodDays: model.wording.gracePeriodDays }
}, null, 2));
process.exitCode = model.eligibility.status === 'AVAILABLE' ? 0 : 1;
