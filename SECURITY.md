# Security Policy

## Schwachstellen melden

Bitte veröffentliche Sicherheitslücken, Zugangsdaten oder personenbezogene Daten
nicht in einem öffentlichen Issue und nicht in der öffentlichen Telegram-Gruppe.

Nutze im öffentlichen GitHub-Repository stattdessen **Security → Report a
vulnerability**. Vor der Veröffentlichung muss dafür GitHub Private Vulnerability
Reporting in den Repository-Einstellungen aktiviert werden.

Bitte füge eine kurze Beschreibung, betroffene Route oder Komponente,
Reproduktionsschritte und die erwartete Auswirkung bei. Keine fremden Daten abrufen,
verändern oder veröffentlichen und keine produktiven Systeme durch Lasttests stören.

## Geheimnisse

Falls versehentlich ein Secret veröffentlicht wurde, reicht das Entfernen aus Git
nicht aus: Das Secret muss sofort beim jeweiligen Anbieter widerrufen und ersetzt
werden. Erst danach wird die Git-Historie bereinigt.

## Fremdwerte im Frontend

Diese Werte werden **ausschließlich als Text** ausgegeben:

- `telegramUsername`
- Wallet-Adresse und ENS-Name
- **jedes** Feld aus einer `/api/*`-Antwort

Erlaubt ist `textContent` oder `document.createElement`. Nicht erlaubt ist,
einen dieser Werte in eine HTML-Zeichenkette zu interpolieren oder über
`innerHTML`, `outerHTML`, `insertAdjacentHTML` oder `document.write` in den Baum
zu schreiben.

Muss ein Element **Markup** tragen, steht das Markup fest in der HTML-Vorlage;
die Textstücke bekommen dort ein `data-teil="0"`, `data-teil="1"` und so fort,
und übersetzt wird nur deren `textContent`. So gibt es keine Stelle mehr, an der
aus einem Wert Markup werden kann — auch nicht, wenn später jemand einen
dynamischen Wert durchreicht.

Durchgesetzt wird das von `scripts/check-frontend.mjs`. Der Wächter hängt an
`npm run check` und damit am Build: eine wiedereingeführte Senke lässt ihn
fallen. Er verbietet zusätzlich eingebettete `<script>`-Blöcke und
`on…`-Ereignisattribute, weil beides `unsafe-inline` in der CSP verlangen würde.
`test/frontend-markup.test.mjs` hält fest, dass der Wächter tatsächlich anschlägt.
