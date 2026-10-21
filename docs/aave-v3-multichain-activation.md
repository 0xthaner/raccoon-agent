# Aave v3 Multi-Chain – RPC-, Oracle- und Umrechnungs-Vorbereitung (inaktiv)

Stand 21.10.2026. **Keine neue Chain ist in Produktion aktiv, und auf keiner gibt es eine Quote.** Die Produktion liest weiterhin nur Ethereum über `src/positions/index.mjs`.

- Code: `src/positions/aave-multichain-activation.mjs`. Kein Produktionsmodul importiert ihn (MC-ISOLATION).
- Tests: `test/aave-multichain-activation.test.mjs`.
- On-chain-Nachweis: `test/fixtures/aave/multichain-oracle-20261021.json`, gelesen read-only per `eth_call`.
- Kandidaten und Nexus-Scope: `docs/aave-v3-multichain-support.md`.
- Maschinenlesbare Matrix: `docs/aave-v3-multichain-activation.json`, erzeugt aus `activationMatrix()`.

## Warum gleiche Adressen über Chains hinweg gefährlich sind

Mehrere Aave-Deployments und Tokens haben auf verschiedenen Chains **dieselbe Adresse**:

| Adresse | Chains |
|---|---|
| Pool `0x794a…14aD` und PoolAddressesProvider `0xa976…3CDb` | Arbitrum, Optimism, Polygon, Avalanche |
| Data-Provider `0x243A…c43b` | Arbitrum, Optimism, Polygon, Avalanche |
| WETH `0x4200…0006` | Base, Optimism |
| cbBTC `0xcbB7…33Bf` | Base **und Ethereum** |

Wer eine Chain aus einer Adresse ableitet, liest im besten Fall den falschen Markt. Im schlechtesten Fall bewertet er eine Position mit Preisen und Cover-Bezug einer anderen Chain.

**Gefundenes Risiko im heutigen Leser** (MC-EDGE-REFERENCE): `REFERENCE_TOKENS` werden nur über die Adresse verglichen. Würde man einen Base-Markt mit dem heutigen Leser lesen, wäre cbBTC auf Base als Ethereum-Referenz erkannt. In Produktion tritt das nicht auf, weil nur Ethereum gelesen wird. Vor jeder Aktivierung muss die Umrechnung aber auf den chain-spezifischen Resolver umgestellt werden.

## Chain-Identität

Die Identität ist immer das Tupel **chainId + deploymentKey + Pool + PoolAddressesProvider**. Nie zählen:
- eine Adresse allein,
- ein Symbol,
- ein Marktname.

Vor jedem Lesen (`scanDeployment`):
1. `client.getChainId()` muss exakt die erwartete chainId liefern, als Zahl. Sonst wird kein einziger Aufruf gemacht (`CHAIN_MISMATCH`).
2. Der Produktionsleser prüft im selben Block, dass der Provider genau den erwarteten Pool, das erwartete Oracle und den erwarteten Data-Provider meldet.
3. Nur eingefrorene Konfigurationsobjekte aus `CHAIN_CLIENT_CONFIGS` werden akzeptiert. Eine Kopie mit `enabled: true` gilt als `UNKNOWN_CONFIG`.
4. Ein inaktives Deployment wird ohne ausdrückliches `allowInactive` nicht gelesen (`NOT_ENABLED`). Das ist nur für Tests gedacht.

## RPC-Modell und Budget

Je Chain gibt es eine Konfiguration mit diesen Feldern:
- chainId, deploymentKey,
- erwarteter Pool, Provider, Oracle und Data-Provider,
- Multicall3 (`0xcA11…CA11`, auf allen fünf Chains deployt),
- Sequencer-Feed,
- RPC-Kennung (`ALCHEMY_API_KEY` plus Netzwerkname `arb-mainnet`, `base-mainnet`, `opt-mainnet`, `polygon-mainnet`, `avax-mainnet`),
- `enabled`.

Die Konfiguration enthält keine URL und keinen Schlüssel, und nichts davon steht im Browser-Code (MC-ISOLATION). Für die neuen Chains ist weder ein Endpunkt eingerichtet noch geprüft (`provisioned: false`).

| Budget | Wert | Herkunft |
|---|---|---|
| Timeout je Anfrage | 8 s | wie der Produktionsleser |
| Gesamtbudget je Scan (eine Chain) | 15 s | wie der Produktionsleser |
| Aufrufe je Scan | höchstens 900 | wie der Produktionsleser |
| Reserven je Markt | höchstens 128 | wie der Produktionsleser |
| Einträge je Multicall | höchstens 265 (8 + 2 × 128 + 1) | Runde 1 bzw. Runde 2 |
| Zusatzaufrufe für die Frische | 4 (Sequencer + bis zu 3 Referenz-Feeds) | im selben Block |
| Wiederholung bei Revert | 0 | ein Revert im selben Block ist deterministisch |
| Wiederholung bei Timeout oder Transportfehler | höchstens 1 | nur wenn noch ≥ 8 s Budget übrig sind |
| viem-Hintergrund-Retries | 0 | wie in Produktion |

Chains werden getrennt gelesen, jeweils mit eigenem Client und eigenem Block, nie in einem gemeinsamen Multicall.

## Oracle-Frische

On-chain gelesen am 21.10.2026:

- **AaveOracle** liefert keinen Zeitstempel, nur `getAssetPrice`. Ein Fallback-Oracle ist auf keiner der fünf Chains gesetzt, ein `PriceOracleSentinel` ebenfalls nicht. Aave selbst schützt dort also nicht vor einem Sequencer-Ausfall.
- **Direkte Chainlink-Feeds** (ETH / USD, BTC / USD, EUR / USD, MATIC / USD, AVAX / USD) liefern `latestRoundData().updatedAt`. Gelesene Alter: wenige Sekunden bis 12 Minuten.
- **USDC** läuft überall über einen „Capped USDC/USD“-Adapter ohne `latestRoundData`. Der innere Feed (`ASSET_TO_USD_AGGREGATOR`, „USDC / USD“) liefert `updatedAt`. Gelesene Alter: 24 s (Polygon) bis 16,3 h (Avalanche), passend zu einem 24-Stunden-Heartbeat.
- **LST- und CAPO-Adapter** (zum Beispiel weETH) haben keinen eigenen Zeitstempel. Sie werden **nicht** geprüft.

Die Entscheidung trifft `oracleFreshness(chainId, observation)`:

| Ergebnis | Bedingung |
|---|---|
| `SEQUENCER_DOWN` | L2-Sequencer-Feed meldet `answer ≠ 0` |
| `SEQUENCER_GRACE_PERIOD` | Sequencer ist seit weniger als 3600 s wieder oben |
| `ORACLE_STALE` | ein Referenz-Feed ist älter als 87 300 s (24 h + 15 min) |
| `ORACLE_FRESH` | alle Referenz-Feeds der Chain gültig und frisch, Sequencer oben und außerhalb der Schonfrist |
| `UNKNOWN` | in allen anderen Fällen (siehe unten) |

`UNKNOWN` gilt, wenn etwas fehlt oder unplausibel ist:
- Sequencer-Status fehlt auf einem Rollup,
- unerwartete Sequencer-Daten auf Polygon oder Avalanche,
- ein Feed fehlt,
- ein Feed hat eine Antwort ≤ 0,
- ein Zeitstempel ist ungültig oder liegt in der Zukunft,
- die Chain ist unbekannt.

Eine Quote dürfte später nur `ORACLE_FRESH` sehen; `UNKNOWN` schlägt sicher fehl.

**Sequencer:** Arbitrum (`0xFdB6…697D`), Base (`0xBCF8…6433`) und Optimism (`0x371E…E389`) haben einen Chainlink-Feed „L2 Sequencer Uptime Status Feed“. Am 21.10.2026 war die Antwort überall 0 (oben), seit 105 bis 153 Tagen. Polygon PoS und Avalanche C-Chain sind keine Rollups; dort gibt es keinen Sequencer-Feed und keine Sequencer-Regel.

**Grenzen (deshalb Oracle-Bereitschaft nur PARTIAL):**
1. 87 300 s ist eine obere Grenze aus dem längsten beobachteten Heartbeat (24 h). Die tatsächlichen Heartbeats je Feed, die zum Teil kürzer sind, lassen sich on-chain nicht lesen und sind nicht anders verifiziert. Ein Feed mit 1-Stunden-Heartbeat würde erst nach gut 24 h als veraltet erkannt.
2. Geprüft werden nur die Referenz-Feeds der Umrechnung (ETH, USDC und auf Base cbBTC), nicht jede Reserve einer Position.
3. Die Frische-Daten werden heute nicht gelesen. `oracleFreshness` ist eine reine Entscheidungsfunktion; das Lesen der Feeds ist nicht verdrahtet.

## Umrechnung in Cover-Assets

Referenzen werden nur über **(chainId, Adresse)** aufgelöst, nie über das Symbol (`resolveConversionReference`, `classifyReserveForConversion`). Zusätzlich muss der gelesene Stand passen:
- Dezimalstellen,
- Preis > 0 (als BigInt),
- Aave-Preisquelle (Adresse),
- Beschreibung des Feeds.

Jede Abweichung schlägt sicher fehl.

| Chain | ETH | USDC | cbBTC |
|---|---|---|---|
| Arbitrum | WETH `0x82aF…Bab1` (18), ETH / USD | nativ `0xaf88…5831` (6), Capped USDC/USD | UNAVAILABLE (nicht gelistet) |
| Base | WETH `0x4200…0006` (18), ETH / USD | nativ `0x8335…2913` (6), Capped USDC/USD | `0xcbB7…33Bf` (8), BTC / USD |
| Optimism | WETH `0x4200…0006` (18), ETH / USD | nativ `0x0b2C…Ff85` (6), Capped USDC/USD | UNAVAILABLE |
| Polygon | WETH (PoS-Bridge) `0x7ceB…f619` (18), ETH / USD | nativ `0x3c49…3359` (6), Capped USDC/USD | UNAVAILABLE |
| Avalanche | WETH.e (Bridge) `0x49D5…0bAB` (18), ETH / USD | nativ `0xB97E…8a6E` (6), Capped USDC/USD | UNAVAILABLE |

Regeln:
- **Gebridgtes ETH** (Polygon WETH, Avalanche WETH.e) ist nur deshalb SUPPORTED, weil Aave es direkt mit dem Chainlink-Feed „ETH / USD“ bewertet. Umgerechnet wird also mit dem ETH-Preis, nicht mit einem Bridge-Kurs. Mit jeder anderen Quelle wird es AMBIGUOUS.
- **WPOL und WAVAX** sind keine Cover-Assets und damit keine Referenz (UNAVAILABLE). Als Reserve werden sie normal bewertet.
- **WBTC und BTC.b** sind nicht cbBTC und werden nie dafür eingesetzt.
- **Ethereum** bleibt auf dem Produktionspfad (`REFERENCE_TOKENS`). Der Resolver antwortet dort `ETHEREUM_USES_PRODUCTION_PATH`.

### Doppelte USDC

Auf Arbitrum, Optimism und Polygon gibt es zwei Reserven mit dem Symbol „USDC“; auf Base heißt die gebridgte Variante USDbC. Die gebridgte Variante hat **dieselbe Aave-Preisquelle** wie die native, ist aber nicht das Cover-Asset. Sie wird deshalb immer `AMBIGUOUS_REFERENCE` (`BRIDGED_USDC`) und nie zur Umrechnung verwendet:

| Chain | gebridgt |
|---|---|
| Arbitrum | `0xFF97…5CC8` (USDC.e) |
| Base | `0xd9aA…b6CA` (USDbC) |
| Optimism | `0x7F5c…1607` (USDC.e) |
| Polygon | `0x2791…4174` (USDC.e) |

Auf Avalanche ist nur natives USDC gelistet. Als Positionswert bleiben beide Varianten normal erfasst, auch eingefroren.

## Aktivierungs-Bereitschaft

`activationReadiness(facts)` liefert `{ detectionReady, rpcReady, oracleReady, conversionReady, nexusScope, quoteReady, productionActivationReady, blockers }`.

- `quoteReady` ist nur wahr, wenn alle Bedingungen gleichzeitig erfüllt sind:
  - Nexus-Scope `CONFIRMED`,
  - RPC bereit,
  - Oracle bereit,
  - Umrechnung bereit,
  - Erkennung bereit,
  - ausdrücklich freigeschaltet (`enabled === true`).
- `PROBABLE` blockiert immer.
- `productionActivationReady` (im Auftrag „productionReady“; der Name `productionReady` ist in `src/` durch den Wächter P4C-SURFACE den Kaufmodulen vorbehalten) ist in dieser Phase immer `false`, weil es keinen Produktionspfad für andere Chains gibt (`NO_PRODUCTION_PATH`).

| Chain | RPC bereit | Oracle-Frische bereit | Umrechnung bereit | Nexus-Scope | Quote bereit | In Produktion |
|---|---|---|---|---|---|---|
| Arbitrum | nein | PARTIAL | ja (ETH, USDC) | PROBABLE | nein | nein |
| Base | nein | PARTIAL | ja (ETH, USDC, cbBTC) | PROBABLE | nein | nein |
| Optimism | nein | PARTIAL | ja (ETH, USDC) | PROBABLE | nein | nein |
| Polygon | nein | PARTIAL | ja (ETH, USDC) | PROBABLE | nein | nein |
| Avalanche | nein | PARTIAL | ja (ETH, USDC) | PROBABLE | nein | nein |

Blocker je Kandidat heute: `RPC_NOT_PROVISIONED`, `ORACLE_FRESHNESS_NOT_PROVEN`, `NEXUS_SCOPE_PROBABLE`, `NOT_ENABLED`, `NO_PRODUCTION_PATH`.

## Was vor dem Freischalten je Chain fehlt

1. **Nexus:** CONFIRMED für Produkt 97 auf genau dieser Chain, schriftlich oder per Annex bzw. Metadaten.
2. **RPC:** Endpunkt je Chain einrichten und prüfen. Schlüssel nur serverseitig; chainId-Prüfung beim Start.
3. **Oracle:**
   - Heartbeats der Referenz-Feeds je Chain belegen (Chainlink-Daten) und die Grenzwerte je Feed statt pauschal setzen,
   - das Lesen von Sequencer und Feeds im selben Block verdrahten,
   - festlegen, wie mit Reserven ohne eigenen Zeitstempel umgegangen wird.
4. **Umrechnung:** Die Adress-Suche in `REFERENCE_TOKENS` muss für Nicht-Ethereum durch den chain-spezifischen Resolver ersetzt werden (siehe das cbBTC-Risiko oben).
5. **Produktionspfad:** Leser je Chain, eigene Caches und Budgets, Anzeige, API. Jeweils nur auf ausdrückliche Anweisung.
