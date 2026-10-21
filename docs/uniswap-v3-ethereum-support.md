# Uniswap v3 auf Ethereum – Erkennung und Exposure (inaktiv)

Stand: 21.10.2026. **Nur Vorbereitung.** Es gibt keine Quote, keinen Kauf, keine Transaktion und keine Produktionsfreigabe.

Code:
- `src/positions/uniswap-v3-math.mjs`: reine Mathematik.
- `src/positions/uniswap-v3-ethereum.mjs`: Registry, Validierung, Leser, Exposure und Readiness.

Kein Produktionsmodul importiert diese Dateien. Tests: `test/uniswap-v3-ethereum.test.mjs` (UNI-*). Support-Matrix: `docs/uniswap-v3-ethereum-support.json`, erzeugt aus `uniswapV3SupportMatrix()`.

## Kurzfassung

| Frage | Ergebnis |
|---|---|
| Nexus-Listing | Produkt **72 „Uniswap v3“**, Single Protocol Cover, aktiv, öffentlich |
| Zuordnung | **MATCHED**, nur für das kanonische Ethereum-Deployment. Zur Laufzeit nicht aktiv. |
| Kanonische Verträge | Factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`, NonfungiblePositionManager `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`, WETH9 `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |
| Positionen finden | Rein über RPC: `balanceOf` + `tokenOfOwnerByIndex` (der Manager ist ERC721Enumerable) |
| Mengen | Exakt in BigInt, identisch zum Pool. Gegen `eth_call` auf 9 Live-Positionen geprüft: 0 Abweichung |
| Gebühren | Werden getrennt ausgewiesen und sind **nicht** im Vorschlag |
| Preise | Aave-v3-Core-Orakel, nur nach exakter Adresse. Alles andere ist UNKNOWN und schließt. |
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
   - Blocknummer lesen,
   - keccak des Runtime-Codes von Factory und NPM prüfen.
1. **Kopf:**
   - `NPM.factory()` und `NPM.WETH9()`,
   - `supportsInterface(0x780e9d63)` (Enumerable),
   - `balanceOf(wallet)`,
   - `feeAmountTickSpacing` für die vier Stufen,
   - von Aave Core die Reserve-Liste, `BASE_CURRENCY` und `BASE_CURRENCY_UNIT`.
2. **Token-IDs:** `tokenOfOwnerByIndex(wallet, i)` für alle i < balance. Doppelte IDs oder eine fehlende Antwort ergeben `ENUMERATION_FAILED`.
3. **Je NFT:** `positions(id)` und `ownerOf(id)`. Ist eine Antwort nicht lesbar, ist der ganze Scan `UNAVAILABLE`. Er wird nie als „keine Position“ gemeldet.
4. **Je Pool, je Position, je Token:**
   - `Factory.getPool`,
   - am per CREATE2 abgeleiteten Pool: `factory`, `token0`, `token1`, `fee`, `tickSpacing`, `slot0` und `feeGrowthGlobal{0,1}X128`,
   - `ticks(tickLower)` und `ticks(tickUpper)`,
   - je Token `decimals` und `symbol`,
   - einmal `AaveOracle.getAssetsPrices` für die Token, die Core-Reserven sind.

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

- **Quelle:** das AaveOracle von Aave v3 Ethereum Core (`0x54586bE6…a0C2`), dieselbe Quelle wie `AAVE_NET_EXPOSURE_V1`. Nie der Spotpreis des Uniswap-Pools.
- **Bedingungen:**
  - Der Token ist im **selben Block** eine Reserve des Core-Pools, nach exakter Adresse.
  - Die Basiswährung ist USD mit 8 Stellen.
  - Der Preis ist > 0.
  - Der Eintrag im Preisbuch gehört genau zu dieser Adresse.
- **Sonst `UNKNOWN`:** `NOT_AN_AAVE_CORE_RESERVE`, `ZERO_PRICE` oder `ORACLE_UNAVAILABLE`.
  - Ein benötigter Token ohne Preis bedeutet keinen Vorschlag.
  - Ein Token mit Menge 0 braucht keinen Preis. Beispiel: WETH/kpdWBTC unter der Spanne besteht nur aus WETH.
  - Ein Token, der sich „USDC“ nennt, aber eine andere Adresse hat, bekommt keinen USDC-Preis.
- **Frische:** Das AaveOracle liefert keinen Zeitstempel. Die Frische ist deshalb nicht belegt (`PROTOCOL_ORACLE_NO_TIMESTAMP`), und `pricingReady` bleibt false.

### Mehrere NFTs, Summe

Jedes NFT bleibt eine eigene Position. Das gilt auch für mehrere im selben Pool, für mehrere Gebührenstufen und für mehrere Paare. Nichts wird vor der Validierung zusammengelegt.

`aggregateUniswapLpExposure` summiert nur gezählte, bewertete Positionen (`countedExposureUsd`). Einen Gesamtvorschlag (`suggestedExposureUsd`) gibt es nur, wenn der Scan OK war **und** jede gefundene Position gezählt wurde (`COMPLETE`). Sonst lautet der Status `INCOMPLETE`, und `excluded` nennt die Gründe.

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
| Token-Metadaten oder Preis fehlen | `INVALID TOKEN_METADATA_MISSING` bzw. `pricingStatus UNKNOWN`, kein Vorschlag |

## 8. Readiness

`uniswapV3Readiness(scan)` liefert `deploymentClass`, `nexusMappingClass`, `positionValid`, `exposureReady`, `pricingReady`, `termsReady`, `proofOfLossReady`, `quoteReady` und `blockers`.

`pricingReady`, `termsReady`, `proofOfLossReady` und `quoteReady` sind in dieser Phase **immer false**, auch bei `MATCHED` und vollständiger Exposure. Die festen Blocker sind:

| Blocker | Bedeutung |
|---|---|
| `NO_QUOTE_PATH` | Es gibt keinen Quote-Pfad für Uniswap. |
| `NO_PRODUCTION_PATH` | Kein Produktionsmodul nutzt die Vorbereitung. |
| `PRICE_FRESHNESS_NOT_VERIFIED` | Das AaveOracle liefert keinen Zeitstempel. Die Frische der Quell-Feeds ist je Asset nicht nachgewiesen. |
| `TERMS_LP_TREATMENT_UNCONFIRMED` | Nexus hat nicht bestätigt, wie LP-Positionen bewertet werden (Gebühren, Zusammensetzung zum Schadenszeitpunkt). |
| `PROOF_OF_LOSS_LP_UNCONFIRMED` | Proof of Loss ist `address`. Ungeklärt ist, ob das für ein NFT reicht, das später übertragen oder gestakt wird. |

Je nach Scan kommen hinzu: `SCAN_UNAVAILABLE`, `NO_VALID_POSITION`, `INVALID_OR_UNREADABLE_POSITION`, `NEXUS_MAPPING_NOT_MATCHED` und `EXPOSURE_NOT_READY`.

## 9. Abgrenzung zur Produktion

Der Test UNI-ISOLATION beweist:
- Kein Modul unter `api/`, `src/`, `web/` oder `scripts/` importiert die neuen Dateien.
- Es gibt keine neue API-Route.
- Im Browser-Code gibt es keine Uniswap- und keine RPC-Adresse.
- Die neuen Module enthalten keine Transaktions-, Signatur- oder Freigabe-Methode und nur `view`-ABI-Einträge. Sie lesen keine Umgebungsvariablen und enthalten keine RPC-URL; der Client wird übergeben.
- `PINNED_PRODUCTS` enthält nur 97, und die Nexus-Zuordnung liefert für Uniswap `NO_LISTING`.
- Das Read-Model fragt Nexus nicht ab, und die Quote-Prüfung ergibt `COVER_NOT_AVAILABLE`.
- Aave-Dateien sind unverändert.

## 10. Offene Blocker

1. **Nexus:** schriftliche Bestätigung, wie Produkt 72 eine Uniswap-v3-LP-Position bewertet:
   - nur Liquidität oder auch nicht eingesammelte Gebühren,
   - Zusammensetzung zum Schadenszeitpunkt,
   - Umgang mit Positionen im Staker oder in Vaults.
2. **Nexus:** Proof of Loss `address` für NFT-Positionen (Übertragung des Positions-NFT, Staker).
3. **Preise:** Frische je Asset nachweisen (Quell-Feed und Heartbeat hinter dem AaveOracle) oder eine eigene geprüfte Referenz festlegen. Bis dahin bleibt `pricingReady` false.
4. **Abdeckung:** Token, die keine Aave-Core-Reserve sind (z. B. PAXG), haben keinen Preis. Ihre Positionen bekommen keinen Vorschlag.
5. **Produktion:** Quote- und Anzeigepfad, Cache, Budgets und Monitoring. Erst auf ausdrückliche Anweisung.
6. **Weitere Chains:** Uniswap v3 auf L2s ist nicht Teil dieser Phase. Dort gelten andere Adressen und teils andere Init-Code-Hashes.
