# Uniswap v3 auf Ethereum – Erkennung und Exposure (inaktiv)

Stand: 21.10.2026. **Nur Vorbereitung.** Es gibt keine Quote, keinen Kauf, keine Transaktion und keine Produktionsfreigabe.

Code:
- `src/positions/uniswap-v3-math.mjs`: reine Mathematik.
- `src/positions/uniswap-v3-ethereum.mjs`: Registry, Validierung, Leser, Exposure und Readiness.
- `src/positions/price-reference.mjs`: protokollunabhängige USD-Preis-Referenzen (Chainlink, geprüft, selber Block). Rein, ohne Netzaufrufe.

Kein Produktionsmodul importiert diese Dateien. Tests: `test/uniswap-v3-ethereum.test.mjs` (UNI-*) und `test/price-reference.test.mjs` (PR-*). Nachweise: `test/fixtures/uniswap/` und `test/fixtures/prices/chainlink-ethereum-20261021.json`. Support-Matrix: `docs/uniswap-v3-ethereum-support.json`, erzeugt aus `uniswapV3SupportMatrix()`.

## Kurzfassung

| Frage | Ergebnis |
|---|---|
| Nexus-Listing | Produkt **72 „Uniswap v3“**, Single Protocol Cover, aktiv, öffentlich |
| Zuordnung | **MATCHED**, nur für das kanonische Ethereum-Deployment. Zur Laufzeit nicht aktiv. |
| Kanonische Verträge | Factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`, NonfungiblePositionManager `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`, WETH9 `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |
| Positionen finden | Rein über RPC: `balanceOf` + `tokenOfOwnerByIndex` (der Manager ist ERC721Enumerable) |
| Mengen | Exakt in BigInt, identisch zum Pool. Gegen `eth_call` auf 9 Live-Positionen geprüft: 0 Abweichung |
| Gebühren | Werden getrennt ausgewiesen und sind **nicht** im Vorschlag |
| Preise | Eigene Preisschicht: chainId + exakte Adresse → gepinnter Chainlink-Feed, Frische gegen `block.timestamp`, alles im Scan-Block. WETH, USDC, cbBTC, USDT, WBTC, PAXG. Alles andere hat keinen Preis und schließt. **Nie** der Pool-Spotpreis. |
| Quote | **nein**, `quoteReady` ist in dieser Phase immer false |

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
- `NEXUS_UNISWAP_V3.runtimeEnabled` ist false.
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

`uniswapV3Readiness(scan)` liefert `deploymentClass`, `nexusMappingClass`, `positionValid`, `exposureReady`, `pricingReady`, `termsReady`, `proofOfLossReady`, `quoteReady` und `blockers`.

`pricingReady` ist true, wenn die Exposure vollständig ist und jede Position voll bewertet ist (Chainlink, frisch, selber Block). `termsReady`, `proofOfLossReady` und `quoteReady` sind in dieser Phase **immer false**, auch bei `MATCHED`, vollständiger Exposure und gültigen Preisen. Die festen Blocker sind:

| Blocker | Bedeutung |
|---|---|
| `NO_QUOTE_PATH` | Es gibt keinen Quote-Pfad für Uniswap. |
| `NO_PRODUCTION_PATH` | Kein Produktionsmodul nutzt die Vorbereitung. |
| `TERMS_LP_TREATMENT_UNCONFIRMED` | Nexus hat nicht bestätigt, wie LP-Positionen bewertet werden (Gebühren, Zusammensetzung zum Schadenszeitpunkt). |
| `PROOF_OF_LOSS_LP_UNCONFIRMED` | Proof of Loss ist `address`. Ungeklärt ist, ob das für ein NFT reicht, das später übertragen oder gestakt wird. |

Je nach Scan kommen hinzu: `SCAN_UNAVAILABLE`, `NO_VALID_POSITION`, `INVALID_OR_UNREADABLE_POSITION`, `NEXUS_MAPPING_NOT_MATCHED`, `EXPOSURE_NOT_READY` und `PRICING_INCOMPLETE`.

Der frühere Blocker `PRICE_FRESHNESS_NOT_VERIFIED` entfällt: Die Frische ist jetzt je Feed nachgewiesen (Abschnitt 11).

## 9. Abgrenzung zur Produktion

Der Test UNI-ISOLATION beweist:
- Kein Modul unter `api/`, `src/`, `web/` oder `scripts/` importiert die Uniswap-Dateien.
- `price-reference.mjs` wird nur von den beiden inaktiven Vorbereitungen genutzt: `uniswap-v3-ethereum.mjs` und `aave-multichain-activation.mjs` (gemeinsame Frische-Regel). `test/production-reach.test.mjs` bestätigt, dass keine davon produktiv erreichbar ist.
- Es gibt keine neue API-Route.
- Im Browser-Code gibt es keine Uniswap- und keine RPC-Adresse.
- Die neuen Module enthalten keine Transaktions-, Signatur- oder Freigabe-Methode und nur `view`-ABI-Einträge. Sie lesen keine Umgebungsvariablen und enthalten keine RPC-URL; der Client wird übergeben.
- `PINNED_PRODUCTS` enthält nur 97, und die Nexus-Zuordnung liefert für Uniswap `NO_LISTING`.
- Das Read-Model fragt Nexus nicht ab, und die Quote-Prüfung ergibt `COVER_NOT_AVAILABLE`.
- Die produktive Aave-Bewertung (`aave-v3.mjs`, `AAVE_NET_EXPOSURE_V1`) ist unverändert. Geändert hat sich nur die inaktive `aave-multichain-activation.mjs`: Sie übernimmt die Frische-Regel jetzt aus der Preisschicht, mit identischen Werten.

## 10. Offene Blocker

1. **Nexus:** schriftliche Bestätigung, wie Produkt 72 eine Uniswap-v3-LP-Position bewertet:
   - nur Liquidität oder auch nicht eingesammelte Gebühren,
   - Zusammensetzung zum Schadenszeitpunkt,
   - Umgang mit Positionen im Staker oder in Vaults.
2. **Nexus:** Proof of Loss `address` für NFT-Positionen (Übertragung des Positions-NFT, Staker).
3. **Preis-Abdeckung:** Nur WETH, USDC, cbBTC, USDT, WBTC und PAXG haben einen Preis. Positionen mit anderen Token (mit Menge ≠ 0) bekommen keinen Vorschlag. Weitere Token nur mit eigenem, geprüftem Feed (Abschnitt 11).
4. **Preis-Betrieb:** Feed-Wechsel (neuer Proxy, neue Beschreibung, geänderter Heartbeat) brechen bewusst. Dann `PRICE_SOURCE_INVALID`, bis der Pin neu geprüft ist. Für die Produktion fehlt eine regelmäßige Gegenprobe des Pins gegen das Chainlink-Directory.
5. **Produktion:** Quote- und Anzeigepfad, Cache, Budgets und Monitoring. Erst auf ausdrückliche Anweisung.
6. **Weitere Chains:** Uniswap v3 auf L2s ist nicht Teil dieser Phase. Dort gelten andere Adressen und teils andere Init-Code-Hashes.

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

