/*
	GEPRUEFTE AAVE-V3-MAERKTE AUF ETHEREUM (Phase 1, 11.10.2026).

	Quelle: das offizielle Aave-Adressbuch (bgd-labs/aave-address-book,
	src/ts/AaveV3Ethereum*.ts), am 11.10.2026 gelesen. Abgefragt werden
	ausschliesslich diese Vertraege. Nichts wird aus Nutzereingaben, Token-
	Metadaten, Token-Listen oder freiem Text entdeckt.

	Zur Laufzeit prueft aave-v3.mjs zusaetzlich, dass der PoolAddressesProvider
	genau diesen Pool, dieses Orakel und diesen Data-Provider meldet. Weicht
	etwas ab (Aave hat neu deployt), faellt der Markt geschlossen aus, statt
	still einen veralteten Vertrag zu lesen.

	Bewusst NICHT enthalten: Horizon (zugangsbeschraenkter RWA-Markt), Aave v4,
	andere Chains.
*/

export const CHAIN_ID = 1;
export const AAVE_V3_NEXUS_PRODUCT_ID = 97;

export const AAVE_V3_MARKETS = Object.freeze([
	Object.freeze({
		deploymentKey: 'aave-v3-ethereum-core',
		protocolKey: 'aave',
		protocolVersion: 'v3',
		chainId: CHAIN_ID,
		label: 'Core',
		poolAddressesProvider: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e',
		pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
		dataProvider: '0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD',
		oracle: '0x54586bE62E3c3580375aE3723C145253060Ca0C2'
	}),
	Object.freeze({
		deploymentKey: 'aave-v3-ethereum-lido',
		protocolKey: 'aave',
		protocolVersion: 'v3',
		chainId: CHAIN_ID,
		label: 'Lido / Prime',
		poolAddressesProvider: '0xcfBf336fe147D643B9Cb705648500e101504B16d',
		pool: '0x4e033931ad43597d96D6bcc25c280717730B58B1',
		dataProvider: '0xB85B2bFEbeC4F5f401dbf92ac147A3076391fCD5',
		oracle: '0xE3C061981870C0C7b1f3C4F4bB36B95f1F260BE6'
	}),
	Object.freeze({
		deploymentKey: 'aave-v3-ethereum-etherfi',
		protocolKey: 'aave',
		protocolVersion: 'v3',
		chainId: CHAIN_ID,
		label: 'EtherFi',
		poolAddressesProvider: '0xeBa440B438Ad808101d1c451C1C5322c90BEFCdA',
		pool: '0x0AA97c284e98396202b6A04024F5E2c65026F3c0',
		dataProvider: '0x7c8509591f9693D21280d96e149a08A3bf69Cd0c',
		oracle: '0x43b64f28A678944E0655404B0B98E443851cC34F'
	})
]);

/** Kanonische Nexus-Produkt-ID je gepruefter Deployment-Kennung; sonst keine. */
export function nexusProductIdFor(deploymentKey) {
	return AAVE_V3_MARKETS.some((market) => market.deploymentKey === deploymentKey) ? AAVE_V3_NEXUS_PRODUCT_ID : null;
}
