# Aave v3 Ethereum – Support-Matrix

Stand 20.10.2026. Maschinenlesbar: `docs/aave-v3-ethereum-support.json`. Die Datei wird aus `src/aave-cover-readiness.mjs` (`aaveSupportMatrix()`) erzeugt. `test/aave-cover-readiness.test.mjs` (AAVE-MATRIX) prüft, dass sie der Implementierung entspricht. Die Matrix beschreibt nur, was der Code tut, keine Werbeaussage.

## Scope

Nur **Aave v3 im Ethereum-Mainnet (chainId 1)**. Ein Markt ist nur über die exakte Registry-Identität unterstützt:

- Kette
- Protokoll-Schlüssel `aave`
- Version `v3`
- Deployment-Schlüssel
- Pool-Adresse

Die Märkte stehen in `src/positions/aave-registry.mjs`. Quelle ist das Aave-Adressbuch. Zur Laufzeit prüft der Code gegen den PoolAddressesProvider. Am 20.10.2026 wurde zusätzlich live bei Block 26235509 geprüft: Pool, Oracle und Data-Provider stimmen für alle drei Märkte.

| Markt | Klasse | Positionserkennung | Engagement | Nexus-Zuordnung | Kapazität | Quote | Quote-Assets | Kauf-Assets | Terms | Proof of Loss | Kauf-Ausführung | Cover-Monitoring |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Aave v3 Ethereum Core | SUPPORTED | ja | ja | MATCHED (Produkt 97) | ja | ja | ETH, USDC, cbBTC | USDC | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | nein | ja |
| Aave v3 Ethereum Lido / Prime | SUPPORTED | ja | ja | AMBIGUOUS | nein | nein | – | – | – | – | nein | ja |
| Aave v3 Ethereum EtherFi | SUPPORTED | ja | ja | AMBIGUOUS | nein | nein | – | – | – | – | nein | ja |

**AMBIGUOUS** heißt: Der Nexus-Katalog führt kein eigenes Produkt für diesen Markt, und Nexus hat nicht bestätigt, dass Produkt 97 ihn abdeckt. Deshalb gibt es dort weder Kapazität noch Quote. Die Positionen werden trotzdem erkannt und angezeigt.

## Ausgeschlossen

Live gegen den Nexus-Katalog gelesen am 20.10.2026:

| Scope | Klasse | Grund |
|---|---|---|
| Aave v2 (Ethereum) | DEPRECATED | Nexus-Produkt 2 „aave v2“ ist deprecated |
| Aave v4 | UNSUPPORTED | eigenes Nexus-Produkt 449, nicht abgebildet |
| Aave v3 Ethereum Horizon | UNSUPPORTED | zugangsbeschränkter RWA-Markt |
| Aave v3 auf anderen Chains (Arbitrum, Base, Optimism, Polygon, Avalanche …) | UNSUPPORTED | nur Ethereum-Mainnet |

## Engagement (AAVE_NET_EXPOSURE_V1)

`suggestedExposure = max(Einlagen − Schulden, 0)` in USD mit 8 Nachkommastellen, gerechnet in BigInt. Die Werte kommen aus dem Aave-Oracle im selben Block. Die Einzelwerte müssen exakt die Summen der Position ergeben.

Das Ergebnis ist ein **Vorschlag**. Es ist kein versicherter Wert, kein garantierter Schadensbetrag und kein finaler Underwriting-Betrag. Maßgeblich ist allein das Nexus-Wording.

## Frische (60 s / 120 s)

- Quote und Kapazität sind 60 s gültig; der Ablaufzeitpunkt selbst zählt schon als abgelaufen.
- Das P4D-Build-Fenster ist 120 s lang. Damit trotzdem nie eine ältere Quote zu einem Senden führt:
  - Der Ausführungs-Lader lehnt Quote oder Kapazität ab 60 s ab (`QUOTE_STALE_FOR_EXECUTION`, `CAPACITY_STALE_FOR_EXECUTION`).
  - Jede Ausführungs-Sitzung endet spätestens beim älteren der beiden Abrufzeitpunkte plus 60 s (`executionFreshUntil`).
  - Eine Wallet-Anfrage darf nur vor dem Sitzungsende beginnen (P4J).
- Eine neuere Quote bedeutet einen neuen Intent.

Restrisiko: Wie lange der Nutzer in der Wallet zum Bestätigen braucht, liegt außerhalb von CoverRaccoon. On-chain begrenzen `maxPremiumInAsset` und die Allokationen den Kauf.

## Kaufbereitschaft

`evaluateAavePurchaseReadiness` ist die einzige serverseitige Entscheidung. Ergebnis ist `READY_FOR_PURCHASE_EXECUTION` oder `BLOCKED`, immer mit allen Gründen. Diese externen Blocker sind fest eingetragen und lassen sich nicht abschalten:

- **CR-TERMS-002**: Nexus hat die Pflichttexte für den Vertrieb noch nicht bestätigt.
- **CR-POL-002**: Nexus hat die Semantik der Proof-of-Loss-Metadaten noch nicht bestätigt.
- **CR-PURCHASE-008 P3**: Es gibt keinen geprüften Wallet-Ausführungspfad.

Solange einer davon offen ist, lautet die Entscheidung `BLOCKED`. Die Cover-Details im Dashboard zeigen das neutral als „Noch nicht möglich“ mit Begründung an.

## Cover-Status

| Status | Bedeutung |
|---|---|
| `ACTIVE_COVER` | Es gibt eine vom Wallet-Inhaber bestätigte, gültige Zuordnung zu genau diesem Markt. Das Cover ist ein aktives, nicht abgelaufenes Produkt-97-Cover derselben Wallet. |
| `NO_ACTIVE_COVER` | Kein solches Cover. Ein aktives Produkt-97-Cover ohne Zuordnung wird nur als offener Hinweis angezeigt. |
| `UNKNOWN` | Die Daten sind nicht lesbar oder gehören zu einer fremden Wallet. |
| `UNSUPPORTED` | Das Deployment liegt außerhalb des Scopes. |

Ablauf-Erinnerungen laufen unverändert über die bestehenden Telegram-Schwellen (0, 1, 3, 7, 14 und 30 Tage).
