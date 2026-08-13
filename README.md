# Raccoon Agent

Raccoon Agent verbindet eine Ethereum-Wallet mit Telegram, zeigt aktive DeFi-Covers
im Dashboard und erinnert an bevorstehende Ablaufdaten. Verlängerungen werden über
den Coverraccoon-Checkout an die jeweilige Owner-Wallet übergeben.

## Funktionen

- Wallet-Login per Reown AppKit / WalletConnect
- Telegram-Verknüpfung über kurzlebige, signierte Links
- Dashboard für Wallets, Covers, Erinnerungen und Renewal-Status
- Telegram-Befehle und interaktive Buttons
- freie Telegram-Sprache mit strikt begrenzten, serverseitig ausgeführten Agent-Aktionen
- konfigurierbare Ablaufwarnungen und Wochenübersicht
- Supabase-Persistenz mit getrennten serverseitigen Zugriffsrechten
- Cover-Daten über die versionierte Coverraccoon Agent API

## Lokal starten

Voraussetzungen: Node.js 24 und ein eigenes Supabase-Projekt.

```bash
npm ci
cp .env.example .env
npm run check
npm start
```

Trage vor dem Start ausschließlich eigene Entwicklungswerte in `.env` ein. Die
benötigten Variablen und ihr Einsatzzweck sind in [.env.example](.env.example)
dokumentiert. Produktions-Secrets gehören in den Secret Store der Hosting-Plattform.

## Qualitätschecks

```bash
npm test
npm run check
npm audit --omit=dev
```

## Sicherheit

- Niemals Seed Phrases, Private Keys, Bot-Tokens oder Service-Role-Keys committen.
- `SUPABASE_SECRET_KEY`, `TELEGRAM_BOT_TOKEN`, `DASHBOARD_SESSION_SECRET`,
  `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET` und `COVER_AGENT_API_KEY` sind nur
  serverseitig erlaubt.
- `REOWN_PROJECT_ID` ist eine öffentliche App-Kennung, sollte aber pro Umgebung
  getrennt verwaltet werden.
- Die Demo-Wallet wird über `DEMO_WALLET` konfiguriert und gehört nicht in den Code.

Hinweise zur vertraulichen Meldung von Schwachstellen stehen in
[SECURITY.md](SECURITY.md).

## Veröffentlichung

Der vorbereitete Public-Release besitzt bewusst keine interne Git-Historie. Interne
Planungsunterlagen und lokale Betriebsdaten sind darin nicht enthalten. Beim ersten
Push wird dieser Release-Stand als `main` des öffentlichen Repositorys veröffentlicht.

## Lizenz

Der Quellcode steht unter der [Apache License 2.0](LICENSE). Beiträge und Forks sind
willkommen. Namen, Logos und Marken von Coverraccoon werden dadurch nicht lizenziert.
