/*
	NEXUS MUTUAL: GEPINNTE LESE-QUELLEN (P1, 18.10.2026).

	Alles, was CoverRaccoon ueber ein Nexus-Produkt fest erwartet, steht hier und
	nirgends sonst. Weicht die oeffentliche Nexus-API davon ab, gilt das Produkt
	als nicht verfuegbar (nexus-read-model.mjs) - es wird nie still uebernommen.

	Quellen, am 18.10.2026 gelesen:
	  - api.nexusmutual.io/v2/products/97, /v2/product-types/0, /v2/capacity/97
	  - NexusMutual/smart-contracts, Tag v3.4.0 (Commit 67f53120):
	    Cover.sol MIN_COVER_PERIOD 28 days / MAX_COVER_PERIOD 365 days
	    (Cover.sol dort byte-gleich mit v3.3.0, der deployten Implementierung)
	  - Nexus-SDK 3.1.1 (npm), data/addresses.json (Mainnet-Adressen). Das SDK
	    selbst wird NICHT verwendet (GPL-3.0, rechtliche Pruefung offen); hier
	    stehen nur die Adressen als Referenz.

	Welcher Quellcode hinter welcher Adresse steht, regelt NEXUS_CONTRACT_SOURCES
	unten - je Vertrag eigens, nicht ein Release fuer alle (F-2Z-1).

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
	F-2Z-1 (18.10.2026): der deployte Quellcode je Vertrag, nachgewiesen durch
	unabhaengige Rekompilierung gegen den on-chain gelesenen Runtime-Bytecode
	(Mitschnitte und Builds: test/nexus-contract-source.test.mjs).
	Abweichungen nur in den vom Compiler gemeldeten Immutable-Regionen, Metadaten-
	Hash identisch. Broker und Cover stammen aus VERSCHIEDENEN Releases: der Broker
	unter NEXUS_CONTRACTS.CoverBroker ist v2.12.1 (master/memberRoles), nicht
	v3.4.0 - die v3-ABI aus @nexusmutual/deployments (pool, registry,
	tokenController) gilt fuer ihn nicht; seine Funktionen stehen als Compiler-
	Ausgabe in contract-builds.json, nicht hier. Nur Referenz, kein Aufruf.
*/
export const NEXUS_CONTRACT_SOURCES = Object.freeze({
	CoverBroker: Object.freeze({
		address: '0xCB2B736652D2dBf7d72e4dB880Cf6B7d99507814',
		proxy: false,
		source: Object.freeze({ repository: 'NexusMutual/smart-contracts', tag: 'v2.12.1', commit: '20082c81ec1a01e03cd7748c5bfc0396e74af93d', contract: 'CoverBroker' }),
		compiler: Object.freeze({ solc: '0.8.28+commit.7893614a', optimizer: true, runs: 200, evmVersion: 'cancun' }),
		runtime: Object.freeze({ keccak256: '0xeb0e42231c9134305a54b102cea19fa29ec57f663a294a35c5bd870d81e9657c', length: 5245, metadataCid: 'QmYTrtJnwoqumTd33yvNJrL1hb8RNgcCRWhrn9Pqy6ZCJK' }),
		immutables: Object.freeze({
			cover: '0xcafeac0fF5dA0A2777d915531bfA6B29d282Ee62',
			memberRoles: '0x055CC48f7968FD8640EF140610dd4038e1b03926',
			nxmToken: '0xd7c49CEE7E9188cCa6AD8FF264C1DA2e69D4Cf3B',
			master: '0x01BFd82675DBCc7762C84019cA518e701C0cD07e'
		}),
		deployment: Object.freeze({ block: 22375780, transaction: '0x10f3551e896d2ffe1473e7a0a0c61191d9635f593e523b514c13f1359ecf9fd1', create2Factory: '0xfac7011663910f75cbe1e25539ec2d7529f93c3f', salt: '0x00000000000000000000000000000000000000000000000000000000000027c9', owner: '0x7CB8e530c3310fe192b07315A3ccaD440cb7281c' })
	}),
	Cover: Object.freeze({
		address: '0xcafeac0fF5dA0A2777d915531bfA6B29d282Ee62',
		proxy: true,
		// OwnedUpgradeabilityProxy; die Implementierung kann per Governance wechseln - dann gilt dieser Pin nicht mehr.
		implementation: '0xcafeafF1a21418f530Feb00C6BAeF07523979C05',
		source: Object.freeze({ repository: 'NexusMutual/smart-contracts', tag: 'v3.3.0', commit: '070972503a471b6e14d01213aca4cf41e156c215', contract: 'Cover' }),
		compiler: Object.freeze({ solc: '0.8.28+commit.7893614a', optimizer: true, runs: 200, evmVersion: 'prague' }),
		runtime: Object.freeze({ keccak256: '0x2ecdeb32b923da39e181ca3fd7f2aa543e7e35e3db146f79327993f3b796a530', length: 23948, metadataCid: 'QmVvxQParTb5FBNEDYsP4Wjpwj7G5ZqjaRcxSTc5Wwudht' }),
		immutables: Object.freeze({
			registry: '0xcafea2c575550512582090AA06d0a069E7236b9e',
			pool: '0xcafea91714e55756C125B509274eDE9Bc91697CB',
			tokenController: '0x5407381b6c251cFd498ccD4A1d877739CB7960B8',
			coverProducts: '0xcafead81a2c2508e7344155eB0DA67a3a487AA8d',
			coverNFT: '0xcafeaCa76be547F14D0220482667B42D8E7Bc3eb',
			stakingNFT: '0xcafea508a477D94c502c253A58239fb8F948e97f',
			stakingPoolFactory: '0xcafeafb97BF8831D95C0FC659b8eB3946B101CB3',
			stakingPoolImplementation: '0xcafeade1872f14adc0a03Ec7b0088b61D76ec729',
			claims: '0x0000000000000000000000000000000000000000',
			DOMAIN_SEPARATOR: '0x0c926483fccaf049ee12d0f3db8a758db3f41547bb1afbb7a5b80925c9e1e962'
		}),
		deployment: Object.freeze({ block: 24476528, transaction: '0xb2e2418bde74537a62d68ff63c099ead01a963cc313f54c36d6375a7a6a550f6' })
	})
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
