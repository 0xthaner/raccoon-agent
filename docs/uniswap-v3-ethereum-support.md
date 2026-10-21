# Uniswap v3 auf Ethereum – Erkennung, Exposure und informative Quote (read-only)

Stand: 21.10.2026. **Read-only in der Produktion** (Abschnitt 13): Erkennung, Exposure, Produkt 72, Kapazität und eine informative Quote je NFT im Dashboard. Es gibt keinen Kauf, keine Freigabe und keine Transaktion.

Code:
- `src/positions/uniswap-v3-math.mjs`: reine Mathematik.
- `src/positions/uniswap-v3-ethereum.mjs`: Registry, Validierung, Leser, Exposure und Readiness.
- `src/positions/price-reference.mjs`: protokollunabhängige USD-Preis-Referenzen (Chainlink, geprüft, selber Block). Rein, ohne Netzaufrufe.
- `src/positions/uniswap-v3-nexus.mjs`: Nexus-Produkt 72, Kapazität, Umrechnung in Cover-Assets, informative Quote je NFT und Readiness (Abschnitt 12).
- `src/positions/uniswap-v3-service.mjs`: Produktionspfad (Scan-Cache, bereinigte Ansicht, Anfrageprüfung, Quote-Cache). Importiert von `api/positions.mjs` und `api/nexus/quote.mjs` (Abschnitt 13).
- `web/src/uniswap-cover.js`: Uniswap-Karte und Quote-Ansicht im Dashboard.

Tests zusätzlich: `test/uniswap-v3-dashboard.test.mjs` (UNI-AUTH, UNI-POS, UNI-QUOTE, UNI-UI, UNI-SEC). Tests: `test/uniswap-v3-ethereum.test.mjs` (UNI-*), `test/price-reference.test.mjs` (PR-*) und `test/uniswap-v3-nexus.test.mjs` (NX72-*). Nachweise: `test/fixtures/uniswap/` und `test/fixtures/prices/chainlink-ethereum-20261021.json`. Support-Matrix: `docs/uniswap-v3-ethereum-support.json`, erzeugt aus `uniswapV3SupportMatrix()`.

## Kurzfassung

| Frage | Ergebnis |
|---|---|
| Nexus-Listing | Produkt **72 „Uniswap v3“**, Single Protocol Cover, aktiv, öffentlich |
| Zuordnung | **MATCHED**, nur für das kanonische Ethereum-Deployment. Zur Laufzeit aktiv (read-only). |
| Kanonische Verträge | Factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`, NonfungiblePositionManager `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`, WETH9 `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |
| Positionen finden | Rein über RPC: `balanceOf` + `tokenOfOwnerByIndex` (der Manager ist ERC721Enumerable) |
| Mengen | Exakt in BigInt, identisch zum Pool. Gegen `eth_call` auf 9 Live-Positionen geprüft: 0 Abweichung |
| Gebühren | Werden getrennt ausgewiesen und sind **nicht** im Vorschlag |
| Preise | Eigene Preisschicht: chainId + exakte Adresse → gepinnter Chainlink-Feed, Frische gegen `block.timestamp`, alles im Scan-Block. WETH, USDC, cbBTC, USDT, WBTC, PAXG. Alles andere hat keinen Preis und schließt. **Nie** der Pool-Spotpreis. |
| Quote | Informativ, je NFT, im Dashboard der angemeldeten Wallet. `quoteReady` nur mit frischer Quote; `purchaseReady` ist immer false. |

## 1. Nexus: welches Listing gilt?

Gelesen am 21.10.2026, frisch und ohne frühere Produkt-IDs:
- `api.nexusmutual.io/v2/products` mit 478 Produkten, dazu `/v2/products/72`, `/v2/product-types/0` und `/v2/capacity/72`.
- On-chain über `CoverProducts` (`0xcafead81…AA8d`): `getProductName`, `getProductWithType`, `getLatestProductMetadata`, `getAllowedPools`, `getProductTypeName` und `getLatestProductTypeMetadata`. Alles nur lesend, im Block 26240616.
- Das Wording über `api.nexusmutual.io/ipfs/QmQQ88…EY` (PDF, 10 Seiten, sha256 `9d831f51…003b`).

| Feld | Produkt 72 |
|---|---|
| Name (API und Chain) | Uniswap v3 |
| Produkttyp | 0 – Single Protocol Cover |
| Kategorie | dex |
| Status | aktiv (`isDeprecated` false), öffentlich (`isPrivate` false) |
| Cover-Assets | ETH, USDC, cbBTC (on-chain Bitmap 193 = Assets 0, 6, 7) |
| Grace Period | 3 024 000 s = 35 Tage, im Wording ebenso definiert |
| Proof of Loss | `address` |
| Wording | `QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY`, dasselbe Typ-0-Wording wie bei Aave 97 |
| Annex | keiner (`metadata` leer, on-chain `ipfsHash` leer) |
| allowedPools | leer, also alle Staking-Pools |
| Kapazität | vorhanden (ETH, USDC, cbBTC; daneben DAI und NXM in der API, die keine Cover-Assets sind) |

Andere Listings mit „Uniswap“ im Namen werden **nie** zugeordnet:
- 71 „Uniswap v2“: andere Version.
- 256 „Uniswap v4“: andere Version.
- 168 „Beefy CLM + Uniswap v3“: Typ 11, deprecated, mit eigenem Annex für Beefy-Vaults.

### Was das Wording über LP-Positionen sagt

Die Wendung „deposited in the Designated Protocol“ steht **weder** im aktuellen Wording **noch** in der Nexus-Doku (NexusMutual/docs, Stand 09.10.2026). Maßgeblich sind diese Stellen:

- **Designated Protocol:** Open-Source-Code, der unter einer Marke vermarktet wird, „running on one or more public blockchain networks“. Benutzeroberflächen sind ausgenommen. Factory, Pools und NonfungiblePositionManager sind Uniswap-v3-Code. Die Oberfläche app.uniswap.org gehört nicht dazu (siehe auch 10.8).
- **Impacted Account:** das Konto, das durch das Covered Event „directly suffered a loss of funds“.
- **Schaden (Klauseln 3–5):** „the loss actually incurred“, bewertet zum Schadenszeitpunkt mit Kursen von coingecko.com, abzüglich Erstattungen. Davon geht ein Selbstbehalt von 5 % der Cover-Summe ab.
- **Ausschlüsse, die für LPs zählen:**
  - **10.5:** Verluste aus Marktpreisbewegungen. Das schließt **Impermanent Loss** und normale Kursverluste aus.
  - **10.2:** Phishing, Schlüsselverlust und alles, wobei das Protokoll wie vorgesehen arbeitet.
  - **10.6:** De-Peg eines vom Protokoll erzeugten Assets.
  - **10.8:** Fehler der Oberfläche.
  - **10.9:** Bridges.

Für uns heißt das: Gedeckt wäre der Verlust der Mittel, die eine Position im Uniswap-v3-Code hält, durch einen Code-Fehler (2.1) oder eines der Ereignisse aus 2.2. Ob dazu auch **nicht eingesammelte Gebühren** zählen, sagt das Wording nicht ausdrücklich. Deshalb gehen sie nicht in den Vorschlag ein (Abschnitt 6).

### Chain-Scope

Laut Nexus-FAQ deckt ein Listing standardmäßig jede EVM-Chain; Ausnahmen stünden im Annex, und Produkt 72 hat keinen. Diese Phase betrachtet **nur Ethereum** (chainId 1). Andere Chains ergeben `UNSUPPORTED` bzw. `WRONG_CHAIN`.

### Einordnung: MATCHED (inaktiv)

Die Produktidentität ist exakt belegt: Name, Typ, Assets, Wording und das Fehlen eines Annex sind über API **und** Chain gleich. Für die kanonische Ethereum-Deployment-Kennung `uniswap-v3-ethereum` gilt deshalb `MATCHED`.

Trotzdem bleibt die Zuordnung inaktiv:
- `NEXUS_UNISWAP_V3.runtimeEnabled` ist false. Die Uniswap-Zuordnung lebt nur in `uniswapNexusMapping` und dem inaktiven Modul `uniswap-v3-nexus.mjs`.
- `quoteEligible` ist immer false.
- `PINNED_PRODUCTS` in `nexus-pinned.mjs` enthält weiterhin nur 97.
- `nexus-mapping.mjs` kennt Uniswap nicht.

## 2. Kanonische Verträge (Ethereum, chainId 1)

| Vertrag | Adresse | Quelle | On-chain-Gegenprobe (21.10.2026) |
|---|---|---|---|
| UniswapV3Factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | Uniswap/sdks `sdk-core/src/addresses.ts` | Runtime-keccak `0x4d7b8525…fd69` |
| NonfungiblePositionManager | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` | ebenda | Runtime-keccak `0x692e658b…36c6`, `factory()` = Factory, `WETH9()` = WETH9, Name „Uniswap V3 Positions NFT-V1“, ERC721 und **ERC721Enumerable** = true |
| WETH9 | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | `sdk-core/src/entities/weth9.ts` | Symbol WETH, 18 Stellen |
| POOL_INIT_CODE_HASH | `0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54` | v3-sdk `constants.ts` und v3-periphery `PoolAddress.sol` | CREATE2-Ableitung ergibt für 8 bekannte Pools genau `Factory.getPool`, und jeder Pool meldet die Factory, beide Token und die Gebühr zurück |

Beide Kernverträge sind nicht upgradebar. Der Leser prüft deshalb bei jedem Scan zuerst den keccak des Runtime-Codes im Scan-Block. Ein gleichnamiger oder geforkter Vertrag fällt durch, ebenso ein Deployment auf einer anderen Chain.

**Gebührenstufen:** 100 → 1, 500 → 10, 3000 → 60, 10000 → 200. Gelesen über `feeAmountTickSpacing`; 14 weitere Kandidaten liefern 0. Der Factory-Owner (beobachtet `0xf2371551…bF5A`) kann neue Stufen aktivieren. Eine neue Stufe ist hier unbekannt und ergibt `FEE_TIER_INVALID`, bis sie geprüft ist. Die Logs `FeeAmountEnabled` waren ohne Archiv-RPC nicht abrufbar; die Stufen wurden deshalb direkt abgefragt.

## 3. Wie Uniswap-v3-LP-NFTs funktionieren

Eine Liquiditätsposition ist ein NFT des NonfungiblePositionManager (NPM). `positions(tokenId)` liefert:
- `token0`, `token1` und `fee`, die zusammen den Pool bestimmen,
- die Preisspanne `tickLower` / `tickUpper`,
- die `liquidity`,
- die Gebühren-Merker `feeGrowthInside{0,1}LastX128`,
- die bereits gutgeschriebenen, aber noch nicht abgeholten Beträge `tokensOwed{0,1}`.

Die Token liegen im Pool. Der NPM ist dort Eigentümer der Pool-Position und führt pro NFT Buch.

Liegt der aktuelle Pool-Tick **unter** der Spanne, besteht die Position nur aus token0. **In** der Spanne besteht sie aus beiden Token. **Darüber** besteht sie nur aus token1. Nach `decreaseLiquidity` bis 0 existiert das NFT weiter. Es verschwindet erst mit `burn`, und das geht nur, wenn Liquidität und `tokensOwed` 0 sind.

## 4. Wie CoverRaccoon eine Position erkennt

Alle Schritte laufen im **selben Block**, über `eth_call` per Multicall3 und `eth_getCode`:

0. **Chain und Code:**
   - `chainId` muss 1 sein,
   - Block lesen (`getBlock`: Nummer **und** Zeitstempel); alle weiteren Aufrufe laufen an genau dieser Nummer,
   - keccak des Runtime-Codes von Factory und NPM prüfen.
1. **Kopf:**
   - `NPM.factory()` und `NPM.WETH9()`,
   - `supportsInterface(0x780e9d63)` (Enumerable),
   - `balanceOf(wallet)`,
   - `feeAmountTickSpacing` für die vier Stufen.
2. **Token-IDs:** `tokenOfOwnerByIndex(wallet, i)` für alle i < balance. Doppelte IDs oder eine fehlende Antwort ergeben `ENUMERATION_FAILED`.
3. **Je NFT:** `positions(id)` und `ownerOf(id)`. Ist eine Antwort nicht lesbar, ist der ganze Scan `UNAVAILABLE`. Er wird nie als „keine Position“ gemeldet.
4. **Je Pool, je Position, je Token:**
   - `Factory.getPool`,
   - am per CREATE2 abgeleiteten Pool: `factory`, `token0`, `token1`, `fee`, `tickSpacing`, `slot0` und `feeGrowthGlobal{0,1}X128`,
   - `ticks(tickLower)` und `ticks(tickUpper)`,
   - je Token `decimals` und `symbol`,
   - je benötigtem Chainlink-Feed `description`, `decimals` und `latestRoundData` (nur für Token mit gepinnter Quelle).

   Pool-Zustand, Positionen und Preise stammen damit aus **einem** Block. Das Ergebnis nennt `blockNumber` und `blockTimestamp`, und jede Exposure trägt beide Werte.

**Grenzen:**
- höchstens 50 NFTs je Wallet (darüber `POSITION_LIMIT`),
- höchstens 1 200 Einzelaufrufe,
- 8 s je RPC-Aufruf, 15 s Gesamtbudget.

Alles darüber schließt.

**Warum ohne Indexer:** Der NPM ist ERC721Enumerable, was on-chain bestätigt ist. Die Aufzählung ist damit direkt prüfbar. Ein Indexer wäre nur für sehr große Wallets nötig. **Adapter-Grenze für später:** Ein Indexer dürfte ausschließlich *Kandidaten*-Token-IDs liefern. Eigentum, Position und Pool würden genau wie oben on-chain geprüft, und eine vom Indexer genannte, aber nicht bestätigte ID zählt nie.

**Bewusst nicht erkannt:** Positionen, die die Wallet nicht selbst hält:
- im UniswapV3Staker gestakt,
- in Vaults wie Arrakis, Gamma oder Beefy CLM,
- in anderen Verwahrern.

Dort ist ein anderer Vertrag Eigentümer des NFT. Eine Safe-Wallet ist dagegen selbst Eigentümerin und wird normal erkannt.

## 5. Validierung je Position

Jede Position ist `VALID`, `INVALID` (fester Grund) oder `UNAVAILABLE` (nicht lesbar). Es gibt kein Fuzzy-Matching, und Symbole sind nie eine Kennung.

| Prüfung | Grund bei Fehler |
|---|---|
| chainId exakt 1 | `WRONG_CHAIN` |
| exakt der kanonische NPM | `WRONG_POSITION_MANAGER` |
| `ownerOf` = gescannte Wallet (im selben Block) | `OWNER_MISMATCH` (übertragenes NFT) |
| token0/token1 gültige Adressen ≠ 0, token0 < token1 | `TOKEN_INVALID` / `TOKEN_ORDER` |
| Gebühr ∈ {100, 500, 3000, 10000} **und** die Factory bestätigt genau diesen Tick-Abstand | `FEE_TIER_INVALID` |
| tickLower < tickUpper, beide in [−887272, 887272] und auf dem Tick-Abstand | `TICKS_INVALID` |
| liquidity ist uint128 | `LIQUIDITY_INVALID` |
| `Factory.getPool` ≠ 0 | `POOL_NOT_REGISTERED` (gefälschtes NFT, fremdes Paar) |
| `Factory.getPool` = CREATE2-Ableitung | `NON_CANONICAL_POOL` |
| der Pool meldet dieselbe Factory, dieselben Token, Gebühr und Abstand | `WRONG_FACTORY` / `POOL_MISMATCH` |
| `slot0` in sich stimmig: sqrtRatio(tick) ≤ sqrtPrice ≤ sqrtRatio(tick+1) | `MATH_SLOT0_INCONSISTENT` |
| aktive Liquidität nur auf initialisierten Ticks | `POOL_STATE_INVALID` |
| `decimals()` lesbar, 0–36 | `TOKEN_METADATA_MISSING` |
| jede Rechnung ohne Überlauf | `MATH_*` |

## 6. Tokenmengen, Gebühren, Exposure

### Mengen (Principal)

Die Mengen werden genau so berechnet, wie der Pool sie bei einem vollständigen `decreaseLiquidity` auszahlen würde (`UniswapV3Pool._modifyPosition` mit `SqrtPriceMath`, abgerundet). Die Fallunterscheidung erfolgt über `slot0.tick`:

- Tick < tickLower: `amount0 = Δ0(√P_lower, √P_upper, L)`, `amount1 = 0`.
- tickLower ≤ Tick < tickUpper: `amount0 = Δ0(√P, √P_upper, L)`, `amount1 = Δ1(√P_lower, √P, L)`.
- Tick ≥ tickUpper: `amount0 = 0`, `amount1 = Δ1(√P_lower, √P_upper, L)`.

Dabei gilt `Δ0 = floor(floor(L·2^96·(√B−√A)/√B)/√A)` und `Δ1 = floor(L·(√B−√A)/2^96)`. `√P(tick)` ist `TickMath.getSqrtRatioAtTick`, Bit für Bit portiert. Alles ist BigInt; ein Überlauf wirft einen Fehler, wie das `revert` in Solidity.

Belegt durch:
- den TickMath-Snapshot aus v3-core (28 Werte, dazu die Grenzen),
- die Positions-Testwerte aus dem v3-sdk (unter, in und über der Spanne),
- 9 Live-Positionen vom 21.10.2026:
  - 2 unter der Spanne, 3 in der Spanne, 2 über der Spanne, 2 geschlossen,
  - Dezimalstellen 6, 8 und 18.

  Für jede wurde vom Eigentümer aus per `eth_call` simuliert, was `decreaseLiquidity(alles)` und `collect(max)` im selben Block zurückgäben; gesendet wurde nichts. Ergebnis: identisch bis zur letzten Einheit.

### Gebühren

`uncollectedFees = tokensOwed + floor((feeGrowthInside − feeGrowthInsideLast) · L / 2^128)`, mit `Tick.getFeeGrowthInside`. Die Subtraktion läuft bewusst modulo 2^256, wie in Solidity < 0.8. Das ist genau das, was `collect` auszahlen würde. Wo der NPM still auf uint128 kürzen würde, lehnen wir ab (`FEE_OVERFLOW`).

**Entscheidung:** Gebühren werden ausgewiesen (`fees0`, `fees1`, `feesUsd`), sind aber **nicht** Teil des Vorschlags (`feesIncluded: false`). Gründe:
- Das Wording nennt Gebühren nicht.
- „loss actually incurred“ lässt offen, ob noch nicht abgeholte Erträge dazuzählen.
- Die Vorgabe verlangt starke Belege für eine Einbeziehung.

Ändert Nexus das schriftlich, betrifft es nur `computeUniswapLpExposure`.

### UNISWAP_V3_LP_EXPOSURE_V1

Der Vorschlag wird so definiert: *current estimated economic value of assets represented by the detected LP position*. Er umfasst nur die Liquidität.

Er ist **kein** garantierter Schadensbetrag, **kein** versicherter Wert, **kein** Schutz gegen Impermanent Loss und **kein** Schutz gegen normale Marktverluste (Wording 10.5). Er beschreibt, was heute in der Position steckt, nicht, was ein Schadensfall auszahlen würde.

Je NFT:
- `tokenId`, `pool`, `token0`, `token1`,
- `amount0`, `amount1`, `value0Usd`, `value1Usd`,
- `principalExposureUsd`, `feesUsd`, `suggestedExposureUsd`,
- `pricingStatus`: `PRICED`, `NOT_REQUIRED` (keine Menge) oder `UNKNOWN`.

USD-Beträge sind Dezimal-Strings mit 8 Stellen, gerundet nach unten.

### Preise

Die USD-Preise kommen aus der eigenen Schicht `price-reference.mjs` (Abschnitt 11). Kurz:
- Ein Preis gilt nur mit `PRICE_OK`, für die exakte Adresse, für chainId 1 und aus **demselben Block** wie die Position (`NOT_SAME_BLOCK` sonst).
- Die on-chain gelesenen Dezimalstellen des Tokens müssen zum Pin passen, sonst `PRICE_AMBIGUOUS`.
- `principal = amount0 × price0 / 10^dec0 + amount1 × price1 / 10^dec1`, in BigInt, je Bein abgerundet.
- Ein Bein mit Menge ≠ 0 ohne gültigen Preis: `pricingStatus UNKNOWN`, `principalExposureUsd` und `suggestedExposureUsd` sind `null`, `counted` ist false. `missingPrices` nennt Token, Status und Grund (z. B. `PRICE_STALE` / `paxg-usd:OLDER_THAN_HEARTBEAT`).
- Ein Bein mit Menge 0 braucht keinen Preis. Beispiel: WETH/kpdWBTC unter der Spanne besteht nur aus WETH; kpdWBTC ist `UNSUPPORTED_TOKEN` und blockiert nicht.
- Ein Token, der sich „USDC“ nennt, aber eine andere Adresse hat, bekommt keinen Preis. Auch nicht über den Pool und den bekannten Preis des anderen Tokens.
- `priceSources` nennt je bewertetem Bein Quelle, Feed-Adresse(n), Preis und `updatedAt`.

**Der Spotpreis des Pools ist nie die USD-Autorität.** `slot0` bestimmt nur, wie sich die Position auf token0 und token1 verteilt (Tick-Mathematik). Der Wert in USD kommt ausschließlich aus den externen Feeds. Grund: Wer einen Pool manipuliert oder angreift, darf damit nicht zugleich die Bewertung des Schadens festlegen. Ein manipulierter Kurs verschiebt höchstens die Zusammensetzung. Deren Summe wird mit unabhängigen Preisen bewertet.

### Mehrere NFTs, Summe

Jedes NFT bleibt eine eigene Position. Das gilt auch für mehrere im selben Pool, für mehrere Gebührenstufen und für mehrere Paare. Nichts wird vor der Validierung zusammengelegt.

`aggregateUniswapLpExposure` summiert nur gezählte, voll bewertete Positionen (`countedExposureUsd`). Einen Gesamtvorschlag (`suggestedExposureUsd`) gibt es nur, wenn der Scan OK war **und** jede gefundene Position gezählt wurde (`COMPLETE`). Eine einzige unbewertete, ungültige oder unlesbare Position macht die Summe `INCOMPLETE`, und es gibt keinen Gesamtvorschlag.

Das Aggregat nennt:
- `positions`: alle gefundenen NFTs,
- `activePositions`: NFTs mit Liquidität > 0,
- `pricedPositions`: voll bewertet (`PRICED`),
- `unpricedPositions`: ein benötigter Preis fehlt (`UNKNOWN`),
- `countedPositions`: gezählt (`PRICED` oder `NOT_REQUIRED`),
- `countedExposureUsd` und `suggestedExposureUsd` (nur bei `COMPLETE`),
- `excluded` (je NFT mit Grund) und `incompleteReasons` (z. B. `PRICING_UNKNOWN`, `POOL_READ_FAILED`, `SCAN_UNAVAILABLE`).

### Geschlossene und Sonderfälle

- **liquidity = 0, NFT existiert noch:**
  - `liquidityState: ZERO_LIQUIDITY`,
  - Principal und Vorschlag `0`,
  - zählt **nicht** als aktive Position (`activePositions`).
- **Gebühren nach dem Abziehen der Liquidität:** sichtbar über `tokensOwed`, aber nicht im Vorschlag.
- **Nur geschlossene NFTs:** `exposureReady` ist false.
- **Übertragen:** `ownerOf` ≠ Wallet ergibt `INVALID OWNER_MISMATCH`, und die Summe ist unvollständig.
- **Verbrannt/nicht existent:** `positions()` revertiert („Invalid token ID“). Der Scan ist dann `UNAVAILABLE POSITION_READ_FAILED`.
- **Fehlerhafte Antwort** (falsche Länge, Typen): `INVALID POSITION_MALFORMED` bzw. ein passender Grund aus Abschnitt 5.

## 7. Fehlerverhalten (alles schließt)

| Lage | Ergebnis |
|---|---|
| falsche Chain | Scan `UNAVAILABLE WRONG_CHAIN` |
| falscher NPM- oder Factory-Code, falscher `factory()`/`WETH9()`-Verweis | `WRONG_POSITION_MANAGER` / `WRONG_FACTORY` |
| NPM nicht Enumerable | `NOT_ENUMERABLE` |
| RPC-Zeitüberschreitung | `RPC_TIMEOUT`; Transportfehler `RPC_FAILED` |
| Multicall mit fehlenden Ergebnissen | `INCOMPLETE_RESULT` |
| Aufzählung oder Position nicht lesbar | `ENUMERATION_FAILED` / `POSITION_READ_FAILED` |
| zu viele NFTs oder Aufrufe | `POSITION_LIMIT` / `CALL_LIMIT` |
| ein Pool nicht lesbar | diese Position `UNAVAILABLE POOL_READ_FAILED`, Summe `INCOMPLETE` |
| Pool nicht kanonisch, falsche Stufe, falsche Ticks, Überlauf, unmöglicher slot0 | Position `INVALID` (Abschnitt 5) |
| Token-Metadaten fehlen | `INVALID TOKEN_METADATA_MISSING` |
| Preis fehlt, veraltet, ungültig, aus anderem Block | `pricingStatus UNKNOWN`, kein Vorschlag, Summe `INCOMPLETE` |

## 8. Readiness

Es gibt zwei Ebenen:
- `uniswapV3Readiness(scan)` ist die Erkennung je Wallet, ohne Nexus-Daten. `capacityReady` und `quoteDataReady` sind dort immer false (`CAPACITY_NOT_VERIFIED`, `QUOTE_DATA_NOT_READY`).
- `uniswapV3QuoteReadiness({ position, exposure, model, priceBook, quote, now })` ist die Sicht je NFT, mit Nexus-Daten (Abschnitt 12).

Beide liefern dieselben Felder:
`deploymentClass`, `nexusMappingClass`, `positionValid`, `exposureReady`, `pricingReady`, `capacityReady`, `quoteDataReady`, `termsReady`, `proofOfLossReady`, `quoteReady`, `purchaseReady` und `blockers`.

| Feld | Bedeutung |
|---|---|
| `quoteDataReady` | Technisch kann eine informative Quote angefragt werden: Position gültig und MATCHED, aktiv, voll bewertet, ein Cover-Asset umrechenbar, Kapazität frisch und > 0. |
| `quoteReady` | Eine frische, informative Quote liegt vor (`quoteDataReady` und Quote `FRESH`). Kein Kaufrecht. |
| `purchaseReady` | **Immer false.** Es gibt keinen Kauf. |
| `termsReady`, `proofOfLossReady` | Immer false, bis Nexus schriftlich antwortet. |

Feste Blocker (`PHASE_BLOCKERS`):

| Blocker | Bedeutung |
|---|---|
| `NEXUS_TERMS_INTERPRETATION_UNCONFIRMED` | Nexus hat nicht bestätigt, wie Produkt 72 eine LP-Position bewertet (Gebühren, Zusammensetzung zum Schadenszeitpunkt). |
| `NEXUS_PROOF_OF_LOSS_UNCONFIRMED` | Proof of Loss ist `address`. Ungeklärt ist, ob das für ein NFT reicht, das später übertragen oder gestakt wird. |
| `WALLET_EXECUTION_NOT_AVAILABLE` | Es gibt keinen Wallet- oder Kaufpfad für Uniswap. |

Eine Klärung durch Nexus liegt **nicht** vor.

Je nach Lage kommen hinzu:
- Wallet-Ebene: `SCAN_UNAVAILABLE`, `NO_VALID_POSITION`, `INVALID_OR_UNREADABLE_POSITION`, `NEXUS_MAPPING_NOT_MATCHED`, `EXPOSURE_NOT_READY`, `PRICING_INCOMPLETE`.
- NFT-Ebene: `POSITION_NOT_VALID`, `ZERO_LIQUIDITY`, `PRICING_NOT_READY`, `CAPACITY_NOT_READY`, `QUOTE_DATA_NOT_READY`, `QUOTE_STALE`.

Die früheren Blocker `NO_QUOTE_PATH` und `NO_PRODUCTION_PATH` entfallen: Es gibt einen read-only Produktionspfad (Abschnitt 13).

## 9. Abgrenzung zur Produktion

Seit 21.10.2026 ist der Pfad read-only in der Produktion (Abschnitt 13). Die Tests UNI-REACH, NX72-PIN und UNI-SEC beweisen:
- Importe nur entlang der geprüften Kette: `uniswap-v3-math` ← `uniswap-v3-ethereum` ← `uniswap-v3-nexus` ← `uniswap-v3-service` ← `api/positions.mjs`, `api/nexus/quote.mjs`. Kein Browser- oder Skript-Code importiert ein Server-Modul.
- Im Browser-Code gibt es keine Uniswap-Vertrags-, Feed- oder RPC-Adresse und keine Chainlink-Lesung.
- Die Server-Module enthalten keine Transaktions-, Signatur- oder Freigabe-Methode, kein Kaufmodul und nur `view`-ABI-Einträge. Sie lesen keine Umgebungsvariablen; der RPC-Client ist der bestehende `defaultClient` aus `src/positions/index.mjs`.
- `PINNED_PRODUCTS` des Aave-Pfads enthält weiter nur 97; Produkt 72 wird nur über die eigene Uniswap-Prüfung (Pin in `uniswap-v3-nexus.mjs`) gelesen.
- Die produktive Aave-Bewertung (`aave-v3.mjs`, `AAVE_NET_EXPOSURE_V1`) und der Aave-Quote-Pfad sind unverändert.
- Es gibt keine Migration und keine Änderung an Secrets.

## 10. Offene Blocker

1. **Nexus:** schriftliche Bestätigung, wie Produkt 72 eine Uniswap-v3-LP-Position bewertet:
   - nur Liquidität oder auch nicht eingesammelte Gebühren,
   - Zusammensetzung zum Schadenszeitpunkt,
   - Umgang mit Positionen im Staker oder in Vaults.
2. **Nexus:** Proof of Loss `address` für NFT-Positionen (Übertragung des Positions-NFT, Staker).
3. **Wallet-Ausführung:** Für Uniswap gibt es keinen Kauf- und keinen Transaktionspfad. Er entsteht erst auf ausdrückliche Anweisung.
4. **Preis-Abdeckung:** Nur WETH, USDC, cbBTC, USDT, WBTC und PAXG haben einen Preis. Positionen mit anderen Token (mit Menge ≠ 0) bekommen keinen Vorschlag. Weitere Token nur mit eigenem, geprüftem Feed (Abschnitt 11).
5. **Preis-Betrieb:** Feed-Wechsel (neuer Proxy, neue Beschreibung, geänderter Heartbeat) brechen bewusst. Dann `PRICE_SOURCE_INVALID`, bis der Pin neu geprüft ist. Für die Produktion fehlt eine regelmäßige Gegenprobe des Pins gegen das Chainlink-Directory.
6. **Betrieb:** Route, Anzeige, Rate-Limits, Cache und Budgets sind umgesetzt (Abschnitt 13). Ein Monitoring für Kapazität und Quote fehlt noch.
7. **Wallet-Quote (Aggregat):** bewusst nicht aktiviert (Abschnitt 12).
8. **Weitere Chains:** Uniswap v3 auf L2s ist nicht Teil dieser Phase. Dort gelten andere Adressen und teils andere Init-Code-Hashes.

## 11. Preis-Referenzen (`price-reference.mjs`)

### Architektur

Eingabe `{ chainId, token, decimals?, block: { number, timestamp }, readings }`. Ausgabe:

```
{ status, reason, token, chainId, priceUsd8, sourceType, sourceAddress, feeds,
  updatedAt, blockNumber, blockTimestamp }
```

- `status`: `PRICE_OK`, `PRICE_UNAVAILABLE`, `PRICE_STALE`, `PRICE_SOURCE_INVALID` oder `PRICE_AMBIGUOUS`.
- `priceUsd8` ist ein BigInt (USD mit 8 Stellen). Es gibt kein Gleitkomma.
- Die Schicht ist rein. `priceReadContracts` liefert die Aufrufliste, die der Leser **im Scan-Block** ausführt. `readingsFromResults` ordnet die Antworten zu, und `evaluatePriceReference` bewertet sie. Damit kann jeder spätere Scanner (Uniswap, Aave, andere) dieselbe Regel nutzen und den gleichen Block erzwingen.

**Reihenfolge der Quellen:**
1. direkter Chainlink-USD-Feed,
2. geprüfter Chainlink-Pfad aus zwei Feeds (nur WBTC),
3. AaveOracle nur über `evaluateAaveOracleReference` und nur, wo Reserve und Quelle exakt geprüft sind. **Nie** als Standard,
4. sonst kein Preis.

**Nie verwendet:** Uniswap-Spotpreis, Symbol-Abgleich, CoinGecko oder andere Web-APIs zur Laufzeit, DEX-Quotes, ein angenommener 1-USD-Wert, ein ähnlich benannter Token.

### Identität

Schlüssel ist ausschließlich `${chainId}:${adresse in Kleinbuchstaben}`.
- Die Adresse wird klein oder mit gültiger Prüfsumme angenommen. Gemischte Schreibweise mit falscher Prüfsumme ist `INVALID_TOKEN`.
- chainId muss eine positive ganze Zahl sein. `'1'`, `1n` oder `1.5` ergeben `INVALID_CHAIN_ID`.
- Dieselbe Adresse auf einer anderen Chain (z. B. USDC-Adresse auf Base) ergibt `UNSUPPORTED_TOKEN`.
- Meldet der Token on-chain andere Dezimalstellen als gepinnt, ist das Ergebnis `PRICE_AMBIGUOUS` (`TOKEN_DECIMALS_CONFLICT`).

### Token und Quellen (Ethereum, chainId 1)

| Token | Adresse | Stellen | Quelle | Feed-Proxy | Heartbeat | Abweichung | max. Alter |
|---|---|---|---|---|---|---|---|
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | 18 | ETH / USD (direkt; WETH9 ist 1:1 in ETH einlösbar) | `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` | 3 600 s | 0,5 % | 3 780 s |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 6 | USDC / USD (direkt) | `0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6` | 82 800 s | 0,25 % | 86 940 s |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | 8 | cbBTC / USD (direkt) | `0x2665701293fCbEB223D11A08D826563EDcCE423A` | 86 400 s | 2 % | 90 720 s |
| USDT | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | 6 | USDT / USD (direkt) | `0x3E7d1eAB13ad0104d2750B8863b489D65364e32D` | 86 400 s | 0,25 % | 90 720 s |
| WBTC | `0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599` | 8 | WBTC / BTC × BTC / USD (Pfad) | `0xfdFD9C85aD200c506Cf9e21F1FD8dd01932FBB23` und `0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c` | 86 400 s / 3 600 s | 0,5 % / 0,5 % | 90 720 s / 3 780 s |
| PAXG | `0x45804880De22913dAFE09f4980848ECE6EcbAf78` | 18 | PAXG / USD (direkt) | `0x9944D86CEB9160aF5C5feB251FD671923323f8C3` | 86 400 s | 0,5 % | 90 720 s |

**Belege** (21.10.2026, `test/fixtures/prices/chainlink-ethereum-20261021.json`):
- **Chainlink Reference Data Directory** (`reference-data-directory.vercel.app/feeds-mainnet.json`, Datenquelle von docs.chain.link): Proxy, Heartbeat, Abweichung, Aggregator. Gepinnt ist je Paar der kanonische ENS-Pfad. Die Varianten „Aave SVR“ und „Shared SVR“ werden nicht genutzt.
- **On-chain im Block 26240768:** je Proxy Code vorhanden, `decimals` = 8, `description` wie gepinnt, `aggregator()` = Directory-Aggregator, `latestRoundData` mit Antwort > 0, `updatedAt` > 0 und `answeredInRound` ≥ `roundId`, frisch.
- **Token:** `name`/`symbol`/`decimals` on-chain, dazu die Uniswap-Labs-Standardliste v22.27.0. Symbole dienen nur dem Abgleich der Belege, nie der Laufzeit.

**PAXG:** Ein eigener, kanonischer Chainlink-Feed PAXG / USD existiert (Basis XAU-Preis, `cex_price`). PAXG wird deshalb unterstützt. Positionen mit PAXG, die vorher `UNKNOWN` waren, sind jetzt bewertet, solange der Feed frisch ist.

**cbBTC:** Der eigene Feed cbBTC / USD wird genutzt, **nicht** BTC / USD. Letzterer wäre ein ähnlich benannter Ersatz. Hinweis: Das Directory führt cbBTC / USD als `dex_state_price` (aus Handelsplätzen abgeleitet) mit 2 % Abweichung und 24 h Heartbeat. Das ist die gröbste Quelle der Liste.

**USDC und USDT:** Die kanonischen Feeds sind laut Directory „stablecoin capped“ (Obergrenze der Meldung). Unter 1 USD fallen sie normal mit. Es wird nie 1 USD angenommen.

### Frische

- `maxAge = heartbeat + max(60 s, ⌈5 % × heartbeat⌉)`, in ganzen Zahlen. Dieselbe Regel nutzt die inaktive Aave-Multichain-Vorbereitung (sie importiert sie jetzt von hier).
- „Jetzt“ ist `block.timestamp` des Scan-Blocks, nie die Uhr der Maschine.
- Der Heartbeat ist je Feed aus dem Directory gepinnt und wird nie geschätzt.

Es schließt:

| Lage | Status / Grund |
|---|---|
| Heartbeat fehlt oder ist ungültig | `PRICE_UNAVAILABLE` / `HEARTBEAT_UNKNOWN` |
| Feed nicht lesbar | `PRICE_UNAVAILABLE` / `FEED_READ_FAILED` |
| Lesung aus anderem Block | `PRICE_UNAVAILABLE` / `NOT_SAME_BLOCK` |
| `description` oder `decimals` weicht vom Pin ab | `PRICE_SOURCE_INVALID` / `DESCRIPTION_MISMATCH`, `DECIMALS_MISMATCH` |
| Antwort ≤ 0 | `PRICE_SOURCE_INVALID` / `NON_POSITIVE_ANSWER` |
| `updatedAt` = 0 | `PRICE_SOURCE_INVALID` / `ROUND_INCOMPLETE` |
| `updatedAt` > `block.timestamp` | `PRICE_SOURCE_INVALID` / `UPDATED_IN_FUTURE` |
| `answeredInRound` < `roundId` | `PRICE_STALE` / `ANSWERED_IN_OLDER_ROUND` |
| Alter > maxAge | `PRICE_STALE` / `OLDER_THAN_HEARTBEAT` |

Beim WBTC-Pfad müssen beide Feeds bestehen. `updatedAt` ist dann der ältere der beiden Zeitstempel.

### AaveOracle: nur geprüfter Adapter

`evaluateAaveOracleReference` akzeptiert einen Aave-Preis nur, wenn alles zutrifft:
- chainId ist 1,
- der Token ist im selben Block exakt eine Reserve von Aave v3 Ethereum Core,
- die Basiswährung ist USD mit 8 Stellen,
- `getSourceOfAsset` meldet genau die gepinnte Quelle,
- diese Quelle besteht alle Feed-Prüfungen oben,
- Aaves Preis ist genau deren Antwort.

Gepinnt ist nur WETH: Aave nutzt die „Aave SVR“-Variante von ETH / USD (`0x5424384B256154046E9667dDFaaa5e550145215e`).

Nicht nutzbar sind:
- **USDC, USDT:** „Capped“-Adapter ohne `latestRoundData`.
- **WBTC:** Rechenadapter ohne `latestRoundData`.
- **cbBTC:** Aave bewertet cbBTC mit BTC / USD.
- **PAXG:** keine Reserve.

**Redundant:** Für WETH liefert der direkte Feed dasselbe Paar ohne den Umweg über Aave. Der Adapter ist deshalb nirgends Standard und wird vom Uniswap-Leser nicht aufgerufen. Die produktive Aave-Bewertung bleibt unverändert.

## 12. Nexus Produkt 72: Kapazität und informative Quote (`uniswap-v3-nexus.mjs`)

Ablauf je NFT:

```
gültige LP-Position  ->  Principal-Exposure (USD, ohne Gebühren)  ->  Produkt 72
  ->  Kapazität (≤ 60 s)  ->  Umrechnung in ETH / USDC / cbBTC (Chainlink, selber Block)
  ->  eine informative Quote
```

Wiederverwendet werden, unverändert:
- die Nexus-Leser und -Parser aus `nexus-read-api.mjs`: Produkt, Produkttyp, Kapazität und Quote, mit Bindung an Asset, Betrag, Pools und Prämie,
- `capacityView` aus `nexus-read-model.mjs`,
- `QUOTE_TTL_MS`, `parseAssetAmount` und `quoteFreshness` aus `nexus-quote.mjs`.

Neu ist nur, was für Produkt 72 eigen ist: der Pin, das Gate, die Umrechnung über Chainlink und die Readiness.

### Produkt 72 (neu gelesen am 21.10.2026, 12:08 UTC)

Gelesen über `GET /v2/products/72`, `/v2/product-types/0` und `/v2/capacity/72`. Die Antworten liegen unverändert in `test/fixtures/uniswap/nexus-72/`. Das Produkt ist identisch mit dem Stand der Erkennungsphase (gleicher Zeitstempel 1761821039).

| Feld | Wert | Prüfung (`verifyUniswapProduct`) |
|---|---|---|
| Produkt-ID | 72 | `PRODUCT_ID_MISMATCH` |
| Name | Uniswap v3 | `PRODUCT_NAME_MISMATCH` (auch für „Uniswap v2/v4“, „Beefy CLM + Uniswap v3“) |
| Produkttyp | 0, Single Protocol Cover | `PRODUCT_TYPE_MISMATCH` |
| Status | aktiv, öffentlich | `PRODUCT_DEPRECATED` / `PRODUCT_PRIVATE` |
| Kategorie | dex | `CATEGORY_MISMATCH` |
| Cover-Assets | genau ETH (0), USDC (6), cbBTC (7) | `COVER_ASSETS_CHANGED` / `ASSET_IDENTITY_MISMATCH` |
| Proof of Loss | `address` | `PROOF_OF_LOSS_CHANGED` |
| Grace Period | 3 024 000 s = 35 Tage | `GRACE_PERIOD_CHANGED` |
| Wording | `QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY` | `TERMS_CHANGED` |
| Metadata / Annex | leer, kein Annex | `TERMS_CHANGED`, sobald ein Annex auftaucht |
| Kapazität | ETH ≈ 3 629, USDC ≈ 8 922 543, cbBTC ≈ 108, aus 19 Pools; Jahrespreis 0,5–0,81 % | siehe unten |

Der Pin ist strenger als der für Produkt 97: Cover-Assets und Grace Period müssen exakt passen. Produkt 97 und `PINNED_PRODUCTS` bleiben unverändert. Produkt 72 steht bewusst **nicht** dort, weil es sonst produktiv erreichbar würde.

### Zuordnung

`uniswapNexusMapping(position)` liefert MATCHED nur unter diesen Bedingungen:
- `status` VALID und chainId genau 1,
- `deploymentKey` `uniswap-v3-ethereum` mit kanonischer Factory und kanonischem NonfungiblePositionManager,
- der Pool ist genau die CREATE2-Ableitung aus Token-Paar und Gebührenstufe.

Alle anderen Fälle:

| Fall | Ergebnis |
|---|---|
| `uniswap-v2-*`, `uniswap-v4-*` | `UNSUPPORTED` / `OTHER_PROTOCOL_VERSION` (Produkte 71 und 256 werden nie zugeordnet) |
| Beefy CLM, Vaults, Arrakis, Gamma | `UNSUPPORTED` / `VAULT_OR_WRAPPER` (Produkt 168 wird nie zugeordnet) |
| andere Chain | `UNSUPPORTED` / `WRONG_CHAIN` |
| anderes Deployment, anderer NPM oder andere Factory | `AMBIGUOUS` / `DEPLOYMENT_CONFLICT` |
| Pool ≠ Ableitung (gefälschter Pool) | `AMBIGUOUS` / `NON_CANONICAL_POOL` |

Namen werden nicht unscharf verglichen.

### Gate vor jedem Nexus-Abruf

`uniswapQuoteGate` prüft, bevor Nexus überhaupt gefragt wird. Fällt eine Bedingung durch, gibt es keinen einzigen Abruf:
- Position VALID und MATCHED,
- die Exposure gehört zu genau diesem NFT, Pool und Block,
- Liquidität > 0 (sonst `ZERO_LIQUIDITY`),
- `pricingStatus PRICED` mit Vorschlag > 0 (sonst `PRICING_INCOMPLETE`),
- Gebühren nicht enthalten,
- der Scan ist höchstens 5 Minuten alt (`POSITION_STALE`). Ein Block aus der Zukunft ergibt `POSITION_CLOCK_SKEW`.

### Kapazität

Die Kapazität wird über den bestehenden Leser `readCapacity(72)` geholt. Er prüft Form, Produkt-ID und die Summe der Pools. Zusätzlich gilt:
- **Frische:** höchstens 60 s alt (`CAPACITY_MAX_AGE_MS = QUOTE_TTL_MS`, wie beim Aave-Quote-Pfad). Ein Zeitstempel in der Zukunft gilt nie als frisch (`CAPACITY_CLOCK_SKEW`). Die Frische wird zur Quote-Zeit erneut geprüft.
- **Assets:** nur ETH, USDC und cbBTC. DAI und NXM aus der API fallen weg. Fehlt eines der drei, ergibt das `CAPACITY_ASSET_MISSING`.
- **Fehlerfälle:** Null überall ergibt `NO_CAPACITY`. Kaputte, inkonsistente oder fremde Antworten, HTTP-Fehler und Zeitüberschreitung ergeben `UNAVAILABLE`.
- Eine Kapazität bedeutet nie, dass ein Kauf möglich ist.

### Umrechnung USD → Cover-Asset

```
amount = floor(suggestedExposureUsd8 × 10^decimals / priceUsd8)
```

- ETH wird über ETH / USD bewertet (Referenz WETH9, 1:1 einlösbar), USDC über USDC / USD, cbBTC über cbBTC / USD.
- Alle drei Feeds liest der Uniswap-Leser in jedem Scan im **selben Block** wie die Positionen mit (`COVER_ASSET_REFERENCES`).
- Bedingungen an den Preis:
  - Status `PRICE_OK`,
  - exakter Referenz-Token, chainId 1,
  - Quelle `CHAINLINK_DIRECT` mit genau dem gepinnten Feed,
  - Preis als BigInt,
  - derselbe Block wie die Exposure.
- Sonst ist dieses Asset nicht wählbar: `COVER_ASSET_PRICE_UNAVAILABLE`, `_INVALID` oder `_NOT_SAME_BLOCK`.
- **Nie** verwendet werden der Spotpreis des Pools, die Nexus-Quote als Preisquelle, Symbole oder eine angenommene Stablecoin-Parität. Beispiel: 1 000 USD ergeben bei USDC / USD = 0,99981255 genau 1 000,187… USDC, nicht 1 000.
- Grenze je Asset: `min(Exposure umgerechnet, Kapazität)`.

### Quote je NFT

Anfrage, streng geparst (`parseUniswapQuoteRequest`):

```
{ mode: 'POSITION', tokenId, coverAsset: 'ETH'|'USDC'|'cbBTC', amount, periodDays }
```

- Eine Produkt-ID im Body ergibt `PRODUCT_ID_NOT_ACCEPTED`. Weitere Felder wie Pool oder Adressen ergeben `INVALID_BODY`.
- Die Laufzeit ist eine ganze Zahl von 28 bis 365 Tagen.
- Die Prüfung (`checkUniswapQuoteRequest`) verlangt:
  - das Modell ist AVAILABLE, Produkt 72 und MATCHED, und die `tokenId` stimmt,
  - die Kapazität ist zur Quote-Zeit frisch,
  - der Betrag ist > 0, höchstens die Kapazität (`AMOUNT_OUT_OF_RANGE`) und höchstens die umgerechnete Principal-Exposure (`AMOUNT_ABOVE_EXPOSURE`).
- Danach folgt genau ein `GET /v2/quote` für Produkt 72 über `readQuote`. Der bestehende Parser prüft:
  - Asset (`QUOTE_ASSET_MISMATCH`),
  - Betrag nicht unter der Anfrage und höchstens 1 % + 1 Einheit darüber (`QUOTE_AMOUNT_MISMATCH`),
  - Pools des Produkts mit Platz (`QUOTE_PRODUCT_MISMATCH`),
  - Prämie = Betrag × Jahrespreis × Tage / 365 (`QUOTE_PRICE_INCONSISTENT`),
  - Form (`MALFORMED_QUOTE`).
- Zusätzlich prüft die Uniswap-Schicht:
  - die Bindung an Produkt 72, Asset und Laufzeit,
  - dass der gequotete Betrag nicht über der Exposure plus derselben Toleranz liegt (`QUOTE_AMOUNT_ABOVE_EXPOSURE`).
- Ergebniscodes bei Fehlern:
  - `QUOTE_UNAVAILABLE` mit Grund (`TIMEOUT`, `HTTP_ERROR`, …),
  - `QUOTE_REJECTED` mit dem Grund des Parsers,
  - `QUOTE_AMOUNT_TOO_SMALL` (siehe Rundung).

  Nie gibt es eine Ersatz-Prämie.

Interne Ansicht (`uniswapQuoteView`):

```
{ provider: 'Nexus Mutual', productId: 72, productName, productTypeName, tokenId, pool,
  suggestedExposureUsd, coverAsset, requestedCoverAmount, quotedCoverAmount, periodDays,
  premium, premiumAsset, annualPricePercent, capacity, quoteFetchedAt, quoteExpiresAt,
  informationalOnly: true, purchaseAvailable: false, status: 'FRESH' | 'STALE' }
```

- Die Ansicht enthält keine Pool-Zuteilungen, keine NXM-Werte und keine Vertragsdaten.
- Gültig ist sie 60 s, danach `STALE`.

### Kleine Beträge (Rundung)

Am 21.10.2026 wurden 14 Quotes für Produkt 72 mit 30 Tagen Laufzeit gelesen. Ergebnis:

| Asset | angefragt | gequotet | Einordnung (bestehender Parser) |
|---|---|---|---|
| ETH | 0,000001 / 0,0001 | je 0,000256527 | `QUOTE_AMOUNT_ROUNDED_UP` → `QUOTE_AMOUNT_TOO_SMALL` |
| ETH | 0,001 | 0,001026 (+2,6 %) | `QUOTE_AMOUNT_ROUNDED_UP` |
| ETH | 0,01 / 0,1 / 1 | +0,05 % / +0,05 % / +0,02 % | OK |
| USDC | 1 | 1,261446 (+26 %) | `QUOTE_AMOUNT_ROUNDED_UP` |
| USDC | 10 / 100 / 1 000 | +0,9 % / +0,3 % / +0,03 % | OK |
| cbBTC | 0,00001 | 0,00001528, Prämie 0 | `QUOTE_AMOUNT_MISMATCH` (nicht einmal als Rundung einordenbar) |
| cbBTC | 0,0001 | +7 % | `QUOTE_AMOUNT_ROUNDED_UP` |
| cbBTC | 0,001 / 0,01 | +0,09 % / +0,01 % | OK |

Belegt ist damit:
- **Rundung wie bei 97:** Nexus rundet auch Produkt 72 je Pool auf ganze Allokations-Einheiten auf. Die kleinste Summe ist genau eine Einheit von 0,01 NXM (`Cover.NXM_PER_ALLOCATION_UNIT = 1e16`, ein Vertragswert und kein Produktwert). Sie entspricht hier 0,000256527 ETH, ≈ 0,63 USDC bzw. ≈ 0,0000076 cbBTC.
- **Gleiche Einheit:** Die Einheit in ETH stimmt auf 1 % mit dem Aave-Mitschnitt vom 20.10. überein. Die Abweichung kommt vom NXM-Kurs.
- **Klassifikator wiederverwendbar:** `isAllocationRoundUp` in `parseQuote` ordnet die Fälle korrekt ein. Wo er nicht einordnen kann (Prämie 0), schließt er mit `QUOTE_AMOUNT_MISMATCH`.
- **Keine Aufblähung:** Es gibt keinen höheren Betrag und keine automatische neue Anfrage. Jede angenommene Quote liegt höchstens 1 % + 1 Einheit über der Anfrage, und die Anfrage liegt höchstens bei der umgerechneten Exposure. Liegt die Rundung materiell darüber, wird die Quote mit `QUOTE_AMOUNT_TOO_SMALL` abgelehnt.

### Eine NFT oder die ganze Wallet

- **Je NFT (diese Phase):** Jede Quote gehört zu genau einem NFT (`mode: 'POSITION'`, `tokenId`). Mehrere NFTs werden nie still zusammengelegt.
- **Wallet / Aggregat (später):** `aggregateQuoteBasis(scan)` beschreibt nur die Grundlage: Das Aggregat ist `COMPLETE`, und jede aktive Position ist MATCHED. NFTs ohne Liquidität gehören nicht dazu. Eine solche Quote wird nicht angefragt: `mode: 'AGGREGATE'` ergibt `AGGREGATE_QUOTE_NOT_ENABLED`, und `quoteEnabled` ist false.

### NFTs ohne Liquidität

Ein NFT mit Liquidität 0 bleibt sichtbar, Gebühren getrennt. Es hat keine Principal-Exposure, fragt weder Kapazität noch Quote an (`ZERO_LIQUIDITY`, kein einziger Abruf) und gilt nicht als aktive Exposure.

### Fehlerfälle (alle schließen)

| Fall | Ergebnis |
|---|---|
| falsches Produkt (97 statt 72, anderer Name) | `PRODUCT_ID_MISMATCH` / `PRODUCT_NAME_MISMATCH` / `PRODUCT_MISMATCH` |
| v2, v4, Beefy CLM | `UNSUPPORTED` |
| gefälschter Pool | `AMBIGUOUS NON_CANONICAL_POOL` |
| gefälschtes NFT, falscher Eigentümer | `POSITION_NOT_VALID` |
| unvollständige Bewertung, veralteter Chainlink-Preis | `PRICING_INCOMPLETE` bzw. `COVER_ASSET_PRICE_UNAVAILABLE` |
| nicht unterstütztes Cover-Asset (DAI, NXM, `eth`) | `ASSET_NOT_SUPPORTED` |
| veraltete oder kaputte Kapazität | `CAPACITY_STALE` / `CAPACITY_UNAVAILABLE:MALFORMED_CAPACITY` u. a. |
| kaputte Quote, falsches Asset, Betrag darunter oder materiell darüber, Prämie unstimmig | `QUOTE_REJECTED` mit Grund |
| winzige Beträge | `QUOTE_AMOUNT_TOO_SMALL` |
| Zeitüberschreitung, Teilausfall (Produkt, Typ oder Kapazität) | `QUOTE_UNAVAILABLE` bzw. Modell `UNAVAILABLE` |

## 13. Produktionspfad (read-only)

Kein neuer API-Endpunkt. Alles läuft über bestehende Routen und deren Schutz.

### Positionen: `GET /api/positions`

Gleiche Sitzung, gleicher Widerruf, gleiche Limits wie bisher. Die Wallet stammt nur aus der Sitzung; ein `wallet`-Parameter ergibt 400. Neu in der Antwort:
- `protocols`: `[{ protocol: 'Aave v3', chainId: 1, status }, { protocol: 'Uniswap v3', chainId: 1, status }]`.
- `uniswapV3`: `{ protocol, chainId, status, reason?, positions, unsupported, suggestedExposureUsd }`.

Je NFT nur die bereinigten Felder: `protocol`, `chainId`, `tokenId`, `pool`, `feeTier`, `feeTierPercent`, `rangeState`, `token0`/`token1` (`address`, `symbol`, `decimals`, `amount`), `liquidityState`, `principalExposureUsd`, `suggestedExposureUsd`, `fees` (`token0Amount`, `token1Amount`, `includedInSuggestedExposure: false`), `pricingStatus`, `nexus` (`productId: 72`, `productName`, `productTypeName`, `mapping: 'MATCHED'`), `coverOptions`, `purchaseAvailable: false`. Keine Fee-Growth-Werte, keine Ticks, keine RPC-Rohdaten. Übertragene NFTs (`OWNER_MISMATCH`) erscheinen nicht.

Der Uniswap-Scan läuft parallel zu Aave. Fällt er aus, bleibt Aave unverändert und der Abschnitt meldet `UNAVAILABLE`.

### Details und Quote: `POST /api/nexus/quote`

Dieselbe Route wie die Aave-Quote, mit Sitzung, Widerruf, Same-Origin, JSON ≤ 1 KiB und strengem Schema:
- `{ action: 'uniswap-details', tokenId }`
- `{ action: 'uniswap-quote', tokenId, coverAsset, periodDays }`, optional `amount`.

Der Server leitet Wallet, Position, Exposure, Produkt 72 und den Höchstbetrag selbst ab. Jeder Schlüssel mit `product` ergibt `PRODUCT_ID_NOT_ACCEPTED`; Wallet, Pool, Exposure, Prämie oder Kapazität sind unbekannte Schlüssel und werden abgelehnt. `tokenId` muss im Scan der Sitzungs-Wallet liegen, sonst `POSITION_NOT_FOUND`.

Höchstbetrag = min(Exposure über `CHAINLINK_PRICE_REFERENCE_V1`, Kapazität). Gebühren zählen nicht, nie der Spotpreis, nie USDC = 1 USD. Ohne `amount` gilt der Höchstbetrag; ein `amount` darüber ergibt `AMOUNT_ABOVE_EXPOSURE` bzw. `AMOUNT_OUT_OF_RANGE`. Zu kleine Beträge ergeben `QUOTE_AMOUNT_TOO_SMALL`, ohne automatische Erhöhung. Cover-Assets: ETH, USDC, cbBTC; Laufzeit 28–365 Tage.

Antworten (Fehler mit festen Codes, nie Rohdaten von Nexus oder RPC): `ZERO_LIQUIDITY`, `MAPPING_AMBIGUOUS`, `NOT_SUPPORTED`, `UNSUPPORTED_TOKEN_PRICE`, `STALE_PRICE`, `PRICE_UNAVAILABLE`, `POSITION_STALE`, `CAPACITY_UNAVAILABLE`, `SCAN_INCOMPLETE`, `QUOTE_UNAVAILABLE`, `QUOTE_AMOUNT_TOO_SMALL`, `RATE_LIMITED`.

### Cache

| Was | Dauer | Schlüssel |
|---|---|---|
| Scan (Positionen, Preise im Scan-Block) | 30 s, Fehlschlag 15 s, höchstens 4 parallel | Wallet (klein) |
| Kapazität | ≤ 60 s | Produkt 72 |
| Quote | bis `quoteExpiresAt` (60 s) | Wallet, Chain, tokenId, Asset, Laufzeit, Betrag, Block |

Nichts wird zwischen Wallets geteilt. Ein Cache-Treffer verbraucht kein Quote-Budget.

### Rate-Limits (HMAC-Schlüssel, keine rohen IPs)

| Budget | Grenze je 600 s |
|---|---|
| `nexus-cover-ip` | 30 |
| `nexus-cover-wallet` | 20 |
| `nexus-read-global` | 400 |
| `nexus-quote-wallet` | 10 |
| `nexus-quote-global` | 200 |
| `positions-lookup-global` (Quote-Scan) | 200 |
| `positions-uniswap-lookup-global` (Positions-Scan, still) | 200 |

### Anzeige

Eigene Karte „Uniswap v3“ je NFT: Paar, Fee-Tier, NFT-Nummer, LP-Mengen, Suggested Exposure, nicht eingesammelte Gebühren („Nicht in der vorgeschlagenen Exposure enthalten“), „Nexus Mutual Uniswap v3 – Single Protocol Cover“ und „Cover-Optionen ansehen“. Die Quote-Ansicht zeigt Produkt, Anbieter, Exposure, Asset-Auswahl, Laufzeit, Kapazität, Prämie, Jahrespreis und Frische. Der Knopf heißt „Informative Quote abrufen“, nie Kaufen, Freigeben oder Bestätigen. Hinweise: Exposure ist eine Schätzung, Impermanent Loss ist nicht als gedeckt dargestellt, Gebühren sind ausgeschlossen, die Quote ist informativ, ein Kauf ist noch nicht möglich. Der Sprachwechsel DE/EN aktualisiert offene Ansichten ohne Neuladen und ohne neue Nexus-Anfrage.

Die Wallet-Methodenliste bleibt unverändert (`eth_requestAccounts`, `eth_accounts`, `personal_sign` nur für SIWE, `wallet_switchEthereumChain`).
