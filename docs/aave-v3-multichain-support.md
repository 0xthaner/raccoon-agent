# Aave v3 auf weiteren EVM-Chains – Vorbereitung (inaktiv)

Stand 21.10.2026. **Nichts davon ist in Produktion aktiv.** Die Laufzeit-Registry (`src/positions/aave-registry.mjs`), die Nexus-Zuordnung und die Quote bleiben ausschließlich bei Aave v3 Ethereum (siehe `docs/aave-v3-ethereum-support.md`).

- Die Kandidaten stehen in `src/positions/aave-multichain-candidates.mjs`. Diese Datei importiert kein Produktionsmodul; der Test AAVE-MC-INACTIVE prüft das.
- Maschinenlesbar: `docs/aave-v3-multichain-support.json`, erzeugt aus `multichainSupportMatrix()`.
- On-chain-Nachweis: `test/fixtures/aave/multichain-verify-20261021.json`.

## Quellen

- Adressen: offizielles Aave-Adressbuch, `@bgd-labs/aave-address-book` 4.44.22, `src/AaveV3<Chain>.sol`.
- On-chain read-only geprüft am 21.10.2026 gegen 06:02 UTC über öffentliche RPCs, nur `eth_chainId`, `eth_blockNumber`, `eth_call` und `eth_getCode`:
  - chainId der RPC,
  - `PoolAddressesProvider.getPool / getPriceOracle / getPoolDataProvider / getMarketId`,
  - `Pool.getReservesList`,
  - `AaveOracle.BASE_CURRENCY / BASE_CURRENCY_UNIT / getAssetsPrices`,
  - `PoolDataProvider.getAllReservesTokens / getReserveConfigurationData / getPaused`,
  - Multicall3-Code an `0xcA11bde05977b3631167028862bE2a173976CA11`,
  - `getPriceOracleSentinel`.
- Nexus:
  - `api.nexusmutual.io/v2/products/97` und `/v2/product-types/0` (Wording `QmQQ88…EY`),
  - Nexus-Doku FAQ (`docs.nexusmutual.io/resources/faq/`, eingeführt mit NexusMutual/docs PR #179, gemergt am 09.10.2026).

## Deployments

In allen fünf Fällen stimmen Pool, Oracle und Data-Provider des Providers mit dem Adressbuch überein. Das Oracle rechnet überall in USD mit 8 Nachkommastellen (`BASE_CURRENCY` = 0x0, Einheit 1e8). Keine Reserve ist pausiert, kein Preis ist 0, Multicall3 ist deployt, und ein `PriceOracleSentinel` ist nirgends gesetzt (0x0). Je Chain gibt es genau einen Aave-v3-Markt im Adressbuch.

| Chain | chainId | Markt (`getMarketId`) | Pool | PoolAddressesProvider | Oracle | Reserven (eingefroren) | Block |
|---|---|---|---|---|---|---|---|
| Arbitrum | 42161 | Arbitrum Aave Market | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` | `0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7` | 20 (10) | 516833305 |
| Base | 8453 | Aave V3 BASE Market | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` | `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` | `0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156` | 15 (4) | 52887250 |
| Optimism | 10 | Optimism Aave Market | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` | `0xD81eb3728a631871a7eBBaD631b5f424909f0c77` | 14 (6) | 158482535 |
| Polygon | 137 | Polygon Aave Market | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` | `0xb023e699F5a33916Ea823A16485e259257cA8Bd1` | 21 (12) | 95905654 |
| Avalanche | 43114 | Avalanche Aave Market | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` | `0xEBd36016B3eD09D4693Ed4251c67Bd858c3c7C9C` | 18 (6) | 98124597 |

**Wichtig:** Arbitrum, Optimism, Polygon und Avalanche nutzen dieselbe Pool- und Provider-Adresse. Eine Adresse allein identifiziert deshalb nie einen Markt. Die Identität ist immer das Tupel aus chainId, Deployment-Schlüssel, Pool und PoolAddressesProvider (AAVE-MC-NO-LEAK).

Eingefrorene Reserven (nur noch Rückzahlung und Abzug möglich) bleiben lesbar und werden mitbewertet:

- Arbitrum: DAI, USDC (bridged), EURS, MAI, rETH, LUSD, FRAX, ezETH, rsETH, tBTC
- Base: USDbC, ezETH, wrsETH, tBTC
- Optimism: DAI, USDC (bridged), sUSD, LUSD, MAI, rETH
- Polygon: USDC (bridged), CRV, SUSHI, GHST, BAL, DPI, EURS, jEUR, EURA, miMATIC, stMATIC, MaticX
- Avalanche: LINK.e, WBTC.e, AAVE.e, FRAX, MAI, wrsETH

Keiner der fünf Märkte ist zugangsbeschränkt oder für einen Sonderzweck gebaut.

## Positionserkennung

Der bestehende Leser (`readAaveV3Positions`) ist marktgenerisch. Er nimmt eine Liste von Märkten und einen viem-Client und benutzt auf allen Chains dieselben ABIs. AAVE-MC-READER zeigt offline, dass ein Arbitrum-Kandidat damit unverändert gelesen wird:

- Es werden nur Verträge des Kandidaten aufgerufen.
- Die Summen stimmen.
- Die Position trägt `chainId` 42161.

Vor einer Freischaltung fehlt noch:

1. **Ein Client je Chain.** `src/positions/index.mjs` baut einen einzigen Mainnet-Client (Alchemy, `eth-mainnet`). Der Leser schickt alle Märkte in einen Multicall auf diesem einen Client. Märkte verschiedener Chains müssen getrennt je Chain gelesen werden, jeweils mit eigenem Client, eigener Blocknummer und eigenem Zeit- und Aufrufbudget. Die Blöcke sind dann je Chain verschieden; das Engagement bleibt pro Markt in einem Block konsistent.
2. **RPC-Endpunkte je Chain**, zum Beispiel Alchemy `arb-mainnet`, `base-mainnet`, `opt-mainnet`, `polygon-mainnet` und `avax-mainnet`, mit Prüfung der chainId beim Start.
3. **Zeitbudget:** fünf weitere Chains vervielfachen die RPC-Last pro Dashboard-Aufruf.

## Engagement (AAVE_NET_EXPOSURE_V1)

Das Modell lässt sich unverändert wiederverwenden. Es rechnet nur mit den USD-Werten aus dem Aave-Oracle im selben Block, und das Oracle hat auf allen fünf Chains dieselbe Basis (USD, 1e8). Das prüft der Leser schon heute (`UNSUPPORTED_BASE_CURRENCY`).

| Punkt | Befund |
|---|---|
| Guthaben und Schulden | gleiche Data-Provider-ABI (`getUserReserveData`), aktuelle aToken- und Schulden-Salden |
| Dezimalstellen | 6/8/18, zusätzlich 2 (EURS auf Arbitrum und Polygon); der Leser erlaubt 0–36 |
| Oracle-Einheit | überall USD, 8 Nachkommastellen |
| Wrapped Native | Aave hält nie native Coins, nur WETH (alle), WPOL (Polygon) und WAVAX (Avalanche) als normale Reserven; native Einzahlungen laufen über das WrappedTokenGateway und erscheinen als aWETH, aWPOL oder aWAVAX |

Unterschiede, die festzuhalten sind:

- **Umrechnung in Cover-Assets.** `REFERENCE_TOKENS` (WETH, USDC, cbBTC) sind Ethereum-Adressen. Auf anderen Chains gibt es keinen Treffer und daher keine Umrechnung in ETH, USDC oder cbBTC. Eine spätere Quote braucht Referenzpreise, die nachvollziehbar sind: entweder vom Ethereum-Oracle oder je Chain mit eigenen Referenz-Token. Heute schlägt das sicher fehl.
- **L2-Sequencer.** Auf Arbitrum, Base und Optimism ist kein `PriceOracleSentinel` gesetzt. Fällt der Sequencer aus, können die Oracle-Preise veraltet sein, ohne dass Aave das markiert. Der Leser prüft keine Preis-Aktualität, auch auf Ethereum nicht. Für eine Anzeige ist das hinnehmbar; für eine Quote sollte es ein eigenes Kriterium werden.
- **Bridged und nativer USDC.** Auf Arbitrum, Optimism und Polygon gibt es zwei Reserven mit dem Symbol „USDC“. Symbole sind keine Identität; der Leser arbeitet ohnehin mit Adressen.

## Nexus: Produkt 97 heute

Live gelesen am 21.10.2026 von `api.nexusmutual.io/v2/products/97`:

| Feld | Wert |
|---|---|
| Name | Aave v3 |
| Status | aktiv (`isDeprecated: false`, `isPrivate: false`) |
| Produkttyp | 0, Single Protocol Cover |
| Cover-Assets | ETH, USDC, cbBTC |
| `metadata` | leer, also kein Annex |
| Proof of Loss | `address` |
| Kategorie | lending |
| Chain- oder Deployment-Beschränkung | keine im Produkt hinterlegt |

Das Wording ist das Typ-0-Wording `QmQQ88…EY`, dasselbe wie am 20.10.2026. Das Designated Protocol ist dort Code, der unter einer Marke vermarktet wird, „running on one or more public blockchain networks including any directly linked layer two components“. Ausschluss 10.1 betrifft nur Schwachstellen, die auf einer **nicht** EVM-kompatiblen Chain entstehen, sofern der Annex nichts anderes bestimmt.

Die Nexus-Doku (FAQ, seit 09.10.2026) sagt:

- „By default, a listing covers positions on any EVM-compatible chain. Its annex names any exception.“
- „The cover itself can protect your position on Base, since listings cover any EVM-compatible chain by default.“

Der Forumsbeitrag von 2023 bezieht sich auf Produkt 98 und ist deshalb kein Beleg für Produkt 97 (siehe Ethereum-Doku).

**Einordnung: PROBABLE für alle fünf Chains.** Die Belege sind aktuell und offiziell und zeigen in dieselbe Richtung: Wording, Ausschluss nur für Nicht-EVM, kein Annex und die FAQ. Es sind aber allgemeine Aussagen über Listings. Keine nennt Produkt 97 und eine bestimmte Chain oder einen bestimmten Markt. Eine FAQ ist auch kein Vertragsbestandteil. Nach der Vorgabe reicht das nicht für CONFIRMED. Deshalb gibt es weder Produkt-ID noch Kapazität noch Quote.

## Support-Matrix

„Erkennung bereit“ heißt: Die Registry-Daten sind on-chain verifiziert und mit dem Leser kompatibel. Die Verdrahtung fehlt noch (siehe oben).

| Chain | Deployment | Klasse | Erkennung bereit | Engagement bereit | Oracle geprüft | Nexus-Scope | Quote möglich | In Produktion |
|---|---|---|---|---|---|---|---|---|
| Arbitrum | `aave-v3-arbitrum` | SUPPORTED_CANDIDATE | ja | ja | ja | PROBABLE | nein | nein |
| Base | `aave-v3-base` | SUPPORTED_CANDIDATE | ja | ja | ja | PROBABLE | nein | nein |
| Optimism | `aave-v3-optimism` | SUPPORTED_CANDIDATE | ja | ja | ja | PROBABLE | nein | nein |
| Polygon | `aave-v3-polygon` | SUPPORTED_CANDIDATE | ja | ja | ja | PROBABLE | nein | nein |
| Avalanche | `aave-v3-avalanche` | SUPPORTED_CANDIDATE | ja | ja | ja | PROBABLE | nein | nein |

## Weitere Aave-v3-Deployments im Adressbuch

Alle sind **UNSUPPORTED** und wurden in dieser Phase nicht on-chain geprüft:

- BNB, Celo, Gnosis, Linea, Mantle, MegaETH, Metis, Plasma, Scroll, Soneium, Sonic, zkSync.
- Ink ist ein White-Label-Markt, der nicht von der Aave-DAO betrieben wird.
- Fantom und Harmony stehen nur noch als Altbestand im Adressbuch. Für die Einstufung als DEPRECATED fehlt hier ein geprüfter Beleg, deshalb UNSUPPORTED.

Auf Ethereum bleiben Horizon (UNSUPPORTED) sowie Lido/Prime und EtherFi (AMBIGUOUS) wie dokumentiert.

## Was vor einer Freischaltung nötig ist

1. **Nexus:** eine schriftliche Bestätigung, dass Produkt 97 die Aave-v3-Märkte auf genau diesen Chains abdeckt. Alternativ ein Annex oder Metadaten an Produkt 97, die sie nennen. Erst dann CONFIRMED, und nur je Chain.
2. **Technik:** Clients je Chain, chainId-Prüfung, Budget, Referenzpreise für die Umrechnung und ein Kriterium für die Preis-Aktualität auf L2s.
3. **Freischaltung:** eine ausdrückliche Anweisung des Nutzers. Danach erst `productionEnabled` und die Laufzeit-Registry anpassen.
