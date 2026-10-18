/*
	NEXUS MUTUAL: GEPINNTE LESE-QUELLEN (P1, 18.10.2026).

	Alles, was CoverRaccoon ueber ein Nexus-Produkt fest erwartet, steht hier und
	nirgends sonst. Weicht die oeffentliche Nexus-API davon ab, gilt das Produkt
	als nicht verfuegbar (nexus-read-model.mjs) - es wird nie still uebernommen.

	Quellen, am 18.10.2026 gelesen:
	  - api.nexusmutual.io/v2/products/97, /v2/product-types/0, /v2/capacity/97
	  - NexusMutual/smart-contracts, Tag v3.4.0 (Commit 67f53120):
	    Cover.sol MIN_COVER_PERIOD 28 days / MAX_COVER_PERIOD 365 days
	  - Nexus-SDK 3.1.1 (npm), data/addresses.json (Mainnet-Adressen). Das SDK
	    selbst wird NICHT verwendet (GPL-3.0, rechtliche Pruefung offen); hier
	    stehen nur die Adressen als Referenz.

	Nur lesend: keine Adresse hier wird aufgerufen, keine Transaktion gebaut.
*/

export const NEXUS_API_BASE = 'https://api.nexusmutual.io';
export const NEXUS_CHAIN_ID = 1;

/** Mainnet-Vertraege laut Nexus-SDK 3.1.1. Referenz, kein Aufruf. */
export const NEXUS_CONTRACTS = Object.freeze({
	Cover: '0xcafeac0fF5dA0A2777d915531bfA6B29d282Ee62',
	CoverBroker: '0xCB2B736652D2dBf7d72e4dB880Cf6B7d99507814',
	CoverNFT: '0xcafeaCa76be547F14D0220482667B42D8E7Bc3eb',
	CoverViewer: '0xcafea53a6c1774030F4B1C06B4A5743d5AFFF8b9',
	CoverProducts: '0xcafead81a2c2508e7344155eB0DA67a3a487AA8d',
	Registry: '0xcafea2c575550512582090AA06d0a069E7236b9e'
});

/*
	Cover-Assets, die CoverRaccoon kennt. DAI taucht in der Kapazitaets-API auf,
	ist aber fuer Produkt 97 kein Cover-Asset; es zaehlt nur, was das Produkt
	selbst als coverAssets fuehrt UND hier steht.
*/
export const NEXUS_ASSETS = Object.freeze({
	0: Object.freeze({ assetId: 0, symbol: 'ETH', decimals: 18 }),
	6: Object.freeze({ assetId: 6, symbol: 'USDC', decimals: 6 }),
	7: Object.freeze({ assetId: 7, symbol: 'cbBTC', decimals: 8 })
});

/** Laufzeitgrenzen aus Cover.sol (v3.4.0), in Tagen. */
export const COVER_PERIOD_DAYS = Object.freeze({ min: 28, max: 365 });

export const PROOF_OF_LOSS_TYPES = Object.freeze(['address', 'validator', 'free_text', 'api_key', 'csv']);

/*
	Erwartete Identitaet je unterstuetztem Produkt. Name, Typ, Kategorie,
	Proof-of-Loss-Arten und das Wording (CID des Produkttyps) muessen exakt
	passen; Produkt 97 hat keinen Annex.
*/
export const PINNED_PRODUCTS = Object.freeze({
	97: Object.freeze({
		productId: 97,
		name: 'Aave v3',
		productTypeId: 0,
		productTypeName: 'Single Protocol Cover',
		category: 'lending',
		proofOfLossInputTypes: Object.freeze(['address']),
		wordingCid: 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY',
		annexCid: null
	})
});
