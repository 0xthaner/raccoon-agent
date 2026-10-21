/*
	AAVE V3 AUF WEITEREN EVM-CHAINS - KANDIDATEN, INAKTIV (21.10.2026).

	Vorbereitung, KEINE Produktionsfreigabe. Diese Datei wird von keinem
	Produktionsmodul importiert (test/aave-multichain.test.mjs prueft das). Die
	Laufzeit-Registry (aave-registry.mjs) und die Nexus-Zuordnung
	(nexus-mapping.mjs) bleiben unveraendert nur Ethereum-Mainnet.

	Quelle der Adressen: offizielles Aave-Adressbuch (@bgd-labs/aave-address-book
	4.44.22, src/AaveV3<Chain>.sol). Am 21.10.2026 read-only on-chain
	gegengeprueft (Nachweis: docs/aave-v3-multichain-support.md):
	chainId der RPC, PoolAddressesProvider -> getPool/getPriceOracle/
	getPoolDataProvider stimmen mit dem Adressbuch, Orakel-Basis USD mit 8
	Stellen, keine Reserve pausiert, Multicall3 deployt.

	Identitaet ist immer das Tupel (chainId, deploymentKey, Pool,
	PoolAddressesProvider). Arbitrum, Optimism, Polygon und Avalanche teilen sich
	Pool- und Provider-Adresse; eine Adresse allein identifiziert daher NIE einen
	Markt.

	Nexus-Scope: Die Nexus-Doku (FAQ, Stand 09.10.2026) sagt, ein Listing decke
	standardmaessig Positionen auf jeder EVM-kompatiblen Chain, Ausnahmen nenne
	der Annex. Produkt 97 hat weder Annex noch Metadaten. Das ist eine allgemeine
	Aussage, keine produkt- und marktgenaue Bestaetigung: daher PROBABLE, nicht
	CONFIRMED. Nur CONFIRMED UND productionEnabled duerfte spaeter zu Kapazitaet
	und Quote fuehren - beides ist hier fuer keinen Eintrag gesetzt.
*/

export const CANDIDATE_CLASSES = Object.freeze(['SUPPORTED_CANDIDATE', 'AMBIGUOUS', 'UNSUPPORTED', 'DEPRECATED']);
export const NEXUS_SCOPES = Object.freeze(['CONFIRMED', 'PROBABLE', 'AMBIGUOUS', 'UNSUPPORTED']);

const candidate = (fields) => Object.freeze({
	protocolKey: 'aave',
	protocolVersion: 'v3',
	deploymentClass: 'SUPPORTED_CANDIDATE',
	nexusScope: 'PROBABLE',
	productionEnabled: false,
	...fields
});

export const AAVE_V3_MULTICHAIN_CANDIDATES = Object.freeze([
	candidate({
		deploymentKey: 'aave-v3-arbitrum', chainId: 42161, label: 'Arbitrum', marketId: 'Arbitrum Aave Market',
		poolAddressesProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
		pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
		dataProvider: '0x243Aa95cAC2a25651eda86e80bEe66114413c43b',
		oracle: '0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7'
	}),
	candidate({
		deploymentKey: 'aave-v3-base', chainId: 8453, label: 'Base', marketId: 'Aave V3 BASE Market',
		poolAddressesProvider: '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D',
		pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
		dataProvider: '0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A',
		oracle: '0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156'
	}),
	candidate({
		deploymentKey: 'aave-v3-optimism', chainId: 10, label: 'Optimism', marketId: 'Optimism Aave Market',
		poolAddressesProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
		pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
		dataProvider: '0x243Aa95cAC2a25651eda86e80bEe66114413c43b',
		oracle: '0xD81eb3728a631871a7eBBaD631b5f424909f0c77'
	}),
	candidate({
		deploymentKey: 'aave-v3-polygon', chainId: 137, label: 'Polygon', marketId: 'Polygon Aave Market',
		poolAddressesProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
		pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
		dataProvider: '0x243Aa95cAC2a25651eda86e80bEe66114413c43b',
		oracle: '0xb023e699F5a33916Ea823A16485e259257cA8Bd1'
	}),
	candidate({
		deploymentKey: 'aave-v3-avalanche', chainId: 43114, label: 'Avalanche', marketId: 'Avalanche Aave Market',
		poolAddressesProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
		pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
		dataProvider: '0x243Aa95cAC2a25651eda86e80bEe66114413c43b',
		oracle: '0xEBd36016B3eD09D4693Ed4251c67Bd858c3c7C9C'
	})
]);

/*
	Weitere Aave-v3-Maerkte im Adressbuch, in dieser Phase NICHT on-chain
	geprueft. Sie bleiben UNSUPPORTED, bis sie einzeln wie oben verifiziert sind.
	Ink ist ein White-Label-Markt (nicht von der Aave-DAO betrieben); Fantom und
	Harmony stehen nur noch historisch im Adressbuch.
*/
export const OTHER_AAVE_V3_DEPLOYMENTS = Object.freeze([
	...['BNB', 'Celo', 'Gnosis', 'Linea', 'Mantle', 'MegaEth', 'Metis', 'Plasma', 'Scroll', 'Soneium', 'Sonic', 'ZkSync']
		.map((name) => Object.freeze({ addressBookName: `AaveV3${name}`, class: 'UNSUPPORTED', reason: 'NOT_VERIFIED_IN_THIS_PHASE' })),
	Object.freeze({ addressBookName: 'AaveV3InkWhitelabel', class: 'UNSUPPORTED', reason: 'WHITE_LABEL_MARKET' }),
	Object.freeze({ addressBookName: 'AaveV3Fantom', class: 'UNSUPPORTED', reason: 'LEGACY_NOT_VERIFIED' }),
	Object.freeze({ addressBookName: 'AaveV3Harmony', class: 'UNSUPPORTED', reason: 'LEGACY_NOT_VERIFIED' })
]);

const isAddress = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const sameAddress = (a, b) => isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
const verdict = (cls, reason, deploymentKey = null) => Object.freeze({ class: cls, reason, deploymentKey });

/**
 * Exakte Aufloesung eines behaupteten Deployments gegen die Kandidaten. Verlangt
 * chainId (Zahl), protocolKey/Version, deploymentKey, Pool UND
 * PoolAddressesProvider. Kein Namens-, Teil- oder Gross/Klein-Abgleich des Keys.
 */
export function resolveMultichainCandidate(claim) {
	if (claim === null || typeof claim !== 'object') return verdict('UNSUPPORTED', 'NOT_A_DEPLOYMENT');
	const { chainId, protocolKey, protocolVersion, deploymentKey, pool, poolAddressesProvider } = claim;
	if (protocolKey !== 'aave') return verdict('UNSUPPORTED', 'NOT_AAVE');
	if (protocolVersion === 'v2') return verdict('DEPRECATED', 'AAVE_V2');
	if (protocolVersion !== 'v3') return verdict('UNSUPPORTED', 'UNSUPPORTED_VERSION');
	if (!Number.isSafeInteger(chainId)) return verdict('UNSUPPORTED', 'INVALID_CHAIN_ID');
	const entry = AAVE_V3_MULTICHAIN_CANDIDATES.find((market) => market.deploymentKey === deploymentKey);
	if (!entry) return verdict('UNSUPPORTED', 'UNKNOWN_DEPLOYMENT');
	if (entry.chainId !== chainId) return verdict('AMBIGUOUS', 'CHAIN_CONFLICT');
	if (!sameAddress(pool, entry.pool)) return verdict('AMBIGUOUS', 'POOL_CONFLICT');
	if (!sameAddress(poolAddressesProvider, entry.poolAddressesProvider)) return verdict('AMBIGUOUS', 'PROVIDER_CONFLICT');
	return verdict(entry.deploymentClass, 'EXACT_CANDIDATE_MATCH', entry.deploymentKey);
}

/**
 * Nexus-Sicht auf einen Kandidaten. Eine Quote waere nur bei CONFIRMED UND
 * productionEnabled denkbar; beides ist derzeit nirgends gesetzt, also nie.
 */
export function multichainNexusScope(claim) {
	const resolved = resolveMultichainCandidate(claim);
	if (resolved.class !== 'SUPPORTED_CANDIDATE') return Object.freeze({ nexusScope: 'UNSUPPORTED', productId: null, quoteEligible: false, reason: resolved.reason });
	const entry = AAVE_V3_MULTICHAIN_CANDIDATES.find((market) => market.deploymentKey === resolved.deploymentKey);
	const quoteEligible = entry.nexusScope === 'CONFIRMED' && entry.productionEnabled === true;
	return Object.freeze({ nexusScope: entry.nexusScope, productId: quoteEligible ? 97 : null, quoteEligible, reason: quoteEligible ? 'CONFIRMED' : 'NEXUS_SCOPE_NOT_CONFIRMED' });
}

/** Lesbare Support-Matrix (docs/aave-v3-multichain-support.json wird daraus erzeugt). */
export function multichainSupportMatrix() {
	return Object.freeze(AAVE_V3_MULTICHAIN_CANDIDATES.map((entry) => Object.freeze({
		chain: entry.label,
		chainId: entry.chainId,
		deploymentKey: entry.deploymentKey,
		marketId: entry.marketId,
		pool: entry.pool,
		poolAddressesProvider: entry.poolAddressesProvider,
		oracle: entry.oracle,
		deploymentClass: entry.deploymentClass,
		detectionReady: true,
		exposureReady: true,
		oracleVerified: true,
		nexusScope: entry.nexusScope,
		quoteEligible: entry.nexusScope === 'CONFIRMED' && entry.productionEnabled === true,
		productionEnabled: entry.productionEnabled
	})));
}
