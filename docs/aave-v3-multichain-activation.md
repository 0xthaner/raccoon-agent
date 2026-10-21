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

**Gefundenes und behobenes Risiko im Leser** (seit 21.10.2026, MC-EDGE-REFERENCE): `REFERENCE_TOKENS` wurden bisher nur über die Adresse verglichen, unabhängig von der Chain. Ein Base-Markt hätte Base-cbBTC als Ethereum-Referenz erkannt. In Produktion trat das nie auf, weil nur Ethereum gelesen wird.

Jetzt gilt im Leser (`referenceLookup` in `src/positions/aave-v3.mjs`):

| Fall | Ergebnis |
|---|---|
| chainId 1 (Ethereum) | `REFERENCE_TOKENS`, unverändert wie bisher; ein übergebener Resolver wird ignoriert |
| andere chainId, kein Resolver übergeben | keine Referenz, **nie** die Ethereum-Tabelle |
| andere chainId mit Resolver | nur bei Antwort `SUPPORTED_REFERENCE` mit Cover-Asset ETH, USDC oder cbBTC; `AMBIGUOUS_REFERENCE`, `UNAVAILABLE_REFERENCE` und alles andere ergibt keine Referenz |
| chainId fehlt, ist keine ganze Zahl (`'8453'`, `8453n`, `8453.5`) oder ≤ 0 | Markt `UNAVAILABLE` (`INVALID_CHAIN_ID`) |

Die inaktive Vorbereitung (`scanDeployment`) übergibt dafür immer `classifyReserveForConversion`, den chain-spezifischen Resolver. Er kennt nur die fünf Kandidaten-Chains und löst nur über (chainId, Adresse) auf. Eine Adresse, die auf einer anderen Chain gültig ist, ergibt auf dieser keine Referenz: Ethereum-WETH, Ethereum-USDC und cbBTC außerhalb von Base sind überall UNAVAILABLE. Die Produktion übergibt keinen Resolver und liest nur Ethereum. Ihr Verhalten ist unverändert; `test/positions.test.mjs` ist unverändert grün.

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
- **Chainlink-Feeds** liefern `latestRoundData().updatedAt`. Auf Arbitrum und Base nutzt Aave die **SVR-Proxies** (Smart Value Recapture, im Chainlink-Verzeichnis als `secondaryProxyAddress` geführt), auf den anderen Chains die normalen Proxies.
- **USDC** läuft überall über einen „Capped USDC/USD“-Adapter ohne `latestRoundData`. Geprüft wird der innere Feed (`ASSET_TO_USD_AGGREGATOR`, „USDC / USD“).
- **LST- und CAPO-Adapter** (zum Beispiel weETH) haben keinen eigenen Zeitstempel. Sie werden **nicht** geprüft.

### Heartbeats je Referenz-Feed

Quelle ist Chainlinks Reference Data Directory (`reference-data-directory.vercel.app/feeds-*.json`, Datenquelle von docs.chain.link), gelesen am 21.10.2026. Jeder Feed ist über die exakte Adresse zugeordnet. Nachweis: `test/fixtures/aave/chainlink-heartbeats-20261021.json`. Vertrauen: offizielle Chainlink-Metadaten. Sie sind nicht on-chain prüfbar und können sich ändern; vor einer Aktivierung erneut lesen.

| Chain | Asset | Feed | Chainlink-Pfad | Heartbeat | Abweichung | Feed-Alter am 21.10. |
|---|---|---|---|---|---|---|
| Arbitrum | ETH | `0xbD41…2C00` (SVR) | eth-usd-svr | 86 400 s | 0,05 % | 114 s |
| Arbitrum | USDC | `0xDbFF…d531` (SVR) | usdc-usd-svr | 86 400 s | 0,1 % | 51 440 s |
| Base | ETH | `0x9dA0…fCc8` (SVR) | eth-usd-svr | 1 200 s | 0,15 % | 422 s |
| Base | USDC | `0x1550…Dc65` (SVR) | usdc-usd-svr | 86 400 s | 0,3 % | 36 682 s |
| Base | cbBTC | `0x3A93…d446` (SVR) | btc-usd-svr (BTC/USD, nicht cbBTC/USD) | 1 200 s | 0,1 % | 490 s |
| Optimism | ETH | `0x13e3…08c5` | eth-usd | 1 200 s | 0,15 % | 438 s |
| Optimism | USDC | `0x16a9…E0f3` | usdc-usd | 86 400 s | 0,1 % | 39 664 s |
| Polygon | ETH | `0xF968…5945` | eth-usd | 27 s | 0,1 % | 7 s |
| Polygon | USDC | `0xfE4A…b2F7` | usdc-usd | 27 s | 0,005 % | 24 s |
| Avalanche | ETH | `0x976B…03b0` | eth-usd | 86 400 s | 0,1 % | 122 s |
| Avalanche | USDC | `0xF096…23B9` | usdc-usd | 86 400 s | 0,1 % | 58 603 s |

**Unbekannte Heartbeats:** keiner der elf Referenz-Feeds. Für die L2-Sequencer-Feeds führt Chainlink keinen Heartbeat (`heartbeat: null`); sie aktualisieren sich nur bei einem Statuswechsel und werden über `startedAt` bewertet, nicht über ein Alter. Für alle anderen Reserven (LST, CAPO, EUR usw.) ist kein Heartbeat hinterlegt; sie gehen nicht in die Frische-Entscheidung ein. Fehlt für einen benötigten Feed der Heartbeat, ist das Ergebnis `UNKNOWN`, nie ein pauschaler Ersatzwert (MC-ORACLE).

Auffällig ist der Polygon-Wert von 27 s (USDC mit 0,005 % Abweichung). Die gelesenen Alter (7 s und 24 s) passen dazu. Die enge Grenze lässt Polygon aber schon bei kurzen RPC- oder Feed-Verzögerungen als veraltet gelten. Das ist gewollt: lieber keine Quote als eine auf alten Preisen.

**Politik (CoverRaccoon, nicht von Chainlink):** Ein Feed ist veraltet, wenn er älter ist als Heartbeat + max(60 s, 5 % des Heartbeats):

| Heartbeat | Grenze |
|---|---|
| 27 s | 87 s |
| 1 200 s | 1 260 s |
| 86 400 s | 90 720 s |

Die Sequencer-Schonfrist beträgt 3600 s nach einem Neustart.

### Ein Block für alles

`oracleFreshness(chainId, snapshot)` bewertet alles gegen **einen** gewählten Block:

```
snapshot = {
  block:     { number, timestamp },          // der gewählte Block
  prices:    { blockNumber },                 // Aave-Reservepreise (getAssetsPrices)
  sequencer: { answer, startedAt, blockNumber } | null,
  feeds:     [{ feed, answer, updatedAt, blockNumber }]
}
```

- Preise, jeder Feed und der Sequencer müssen aus genau `block.number` stammen (BigInt-Gleichheit). Sonst gibt es `UNKNOWN` (`PRICES_NOT_SAME_BLOCK`, `FEED_NOT_SAME_BLOCK`, `SEQUENCER_NOT_SAME_BLOCK`).
- „Jetzt“ ist `block.timestamp`, nie die Serveruhr. Serveruhren können abweichen, und Chains unterscheiden sich in der Blockzeit. Ein `updatedAt` oder `startedAt` nach dem Block-Zeitstempel ist `UNKNOWN`.
- Reihenfolge: Block → Preise → Sequencer → alle Feeds. Ein fehlender oder kaputter Feed ist `UNKNOWN`, auch wenn ein anderer nur veraltet wäre.

| Ergebnis | Bedingung |
|---|---|
| `SEQUENCER_DOWN` | Rollup-Sequencer meldet `answer ≠ 0` |
| `SEQUENCER_GRACE_PERIOD` | Sequencer seit weniger als 3600 s wieder oben |
| `ORACLE_STALE` | ein Referenz-Feed älter als seine Grenze, alles andere gültig |
| `ORACLE_FRESH` | alle Referenz-Feeds der Chain gültig und frisch, gleicher Block, Sequencer oben und außerhalb der Schonfrist |
| `UNKNOWN` | in allen anderen Fällen (siehe unten) |

`UNKNOWN` gilt bei:
- unbekannter Chain oder chainId, die keine Zahl ist,
- fehlendem oder ungültigem Block,
- anderem Block für Preise, Feeds oder Sequencer,
- fehlendem Sequencer-Status auf einem Rollup,
- Sequencer-Daten auf Polygon oder Avalanche,
- fehlendem Heartbeat,
- fehlendem Feed,
- Feed-Antwort ≤ 0,
- ungültigem Zeitstempel.

Eine Quote dürfte später nur `ORACLE_FRESH` sehen; alles andere blockiert.

Für die Verdrahtung gibt es ein festes Budget: 4 Zusatzaufrufe im Multicall des Scan-Blocks (Sequencer und bis zu 3 Feeds). Noch ist sie nicht gebaut.

**Sequencer:** Arbitrum (`0xFdB6…697D`), Base (`0xBCF8…6433`) und Optimism (`0x371E…E389`) haben einen Chainlink-Feed „L2 Sequencer Uptime Status Feed“; on-chain gelesen und im Chainlink-Verzeichnis bestätigt. Am 21.10.2026 war die Antwort überall 0 (oben), seit 105 bis 153 Tagen. Polygon PoS und Avalanche C-Chain sind keine Rollups; dort gibt es keinen Sequencer-Feed und keine Sequencer-Regel.

**Warum Oracle-Bereitschaft trotzdem noch PARTIAL ist:**
1. Das Lesen von Sequencer und Feeds im Scan-Block ist nicht verdrahtet; `oracleFreshness` ist eine reine Entscheidungsfunktion.
2. Geprüft werden nur die Referenz-Feeds der Umrechnung (ETH, USDC und auf Base cbBTC), nicht jede Reserve einer Position.
3. Die Heartbeats sind Chainlink-Metadaten von heute. Vor einer Aktivierung müssen sie erneut gelesen werden.

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

Blocker je Kandidat heute: `RPC_NOT_PROVISIONED`, `ORACLE_READ_NOT_WIRED`, `NEXUS_SCOPE_PROBABLE`, `NOT_ENABLED`, `NO_PRODUCTION_PATH`.

## Was vor dem Freischalten je Chain fehlt

1. **Nexus:** CONFIRMED für Produkt 97 auf genau dieser Chain, schriftlich oder per Annex bzw. Metadaten.
2. **RPC:** Endpunkt je Chain einrichten und prüfen. Schlüssel nur serverseitig; chainId-Prüfung beim Start.
3. **Oracle:**
   - das Lesen von Sequencer und Referenz-Feeds im Scan-Block verdrahten (4 Zusatzaufrufe) und `oracleFreshness` vor jeder Quote verlangen,
   - die Heartbeats direkt vor der Aktivierung erneut aus dem Chainlink-Verzeichnis lesen,
   - festlegen, wie mit Reserven ohne eigenen Zeitstempel umgegangen wird.
4. **Umrechnung:** im Leser erledigt. Für Nicht-Ethereum gibt es Referenzen nur über den chain-spezifischen Resolver, nie über `REFERENCE_TOKENS`. Der künftige Produktionspfad muss ihn übergeben; ohne ihn gibt es keine Referenz und damit keine Quote.
5. **Produktionspfad:** Leser je Chain, eigene Caches und Budgets, Anzeige, API. Jeweils nur auf ausdrückliche Anweisung.
