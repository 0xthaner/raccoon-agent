# Laufzeit-Stack – CoverRaccoon

Stand 22.10.2026. Durchgesetzt von `scripts/check-runtime-stack.mjs` (läuft in `check`, `check:ci` und – nur die Node-Untergrenze – am Anfang von `build:web`). Getestet in `test/runtime-stack-guard.test.mjs`.

## Beabsichtigter Stack

| Schicht | Laufzeit | Wer betreibt sie |
|---|---|---|
| API (`api/*.mjs`), Cron | Node.js 24.x, ESM, Vercel Functions (`fra1`) | Vercel (Laufzeit-Patchstand gehört Vercel) |
| Statisches Frontend (`dist-web`) | Browser-JavaScript, ausgeliefert vom Vercel-CDN | Vercel |
| Datenbank | Supabase / PostgreSQL 17 | Supabase |
| Telegram-Bot lokal (`npm start`) | Node.js 24.x | wir |
| Build | Node.js 24.x, Vite/Rolldown (native Bindings) | Vercel-Build-Image bzw. CI (`ubuntu-latest`, `setup-node` 24) |

Nicht Teil des Stacks: PHP, Ruby, Python-Server, Java, Go-Programme, nginx/Apache-Konfiguration, eigene Container. Was Vercel, Supabase oder GitHub intern betreiben (etwa Reverse Proxies), liegt außerhalb dieses Repositorys und ist **Plattformabhängigkeit**, nicht Anwendungscode.

## Bekannte fremde Binärdateien (nur Entwicklerwerkzeug)

- `supabase` (devDependency) bringt über `@supabase/cli-<plattform>` ein Go-Binary mit (`supabase-go`, Go 1.26.5 bei CLI 2.114.0). Es wird nur lokal für Migrationen aufgerufen, von keiner Funktion importiert und nicht in Funktions-Bundles getraced. Liegt in `node_modules` und ist deshalb nicht Gegenstand der Prüfung.

## Node-Untergrenze

`NODE_UNTERGRENZE = 24.22.1`: Node.js-Sicherheitsrelease vom 21.10.2026 (acht CVEs betreffen 24.x) inklusive CA-Store ohne die kompromittierten eMudhra-Zwischenzertifikate. Bei jedem neuen Node-Sicherheitsrelease anheben.

Die CI (`.github/workflows/ci.yml`, beide Jobs) installiert die Untergrenze exakt (`node-version: '24.22.1'`): ein bloßes `'24'` löste am 22.10.2026 auf v24.22.0 auf. Wer die Untergrenze anhebt, zieht die CI-Version mit; ein Test verlangt eine exakte Version, die die Untergrenze erfüllt. Der Schalter `--nur-stack` (nur die Allowlist, ohne Untergrenze) ist ausschließlich für Testfixtures da; kein Skript, kein Vercel-Befehl und kein Workflow darf ihn benutzen.

`engines.node` kann nur die Hauptversion festlegen; Vercel rollt Patchversionen selbst aus. Die Prüfung in `build:web` schreibt deshalb die tatsächliche Build-Version ins Vercel-Build-Log und bricht unter der Untergrenze ab. Die **Funktions**-Laufzeit belegt sie nicht – dafür bleibt die Bestätigung von Vercel bzw. ein geloggtes `process.version` nötig.

## Eine neue Laufzeit einführen

Nur bewusst: diese Datei ändern, die Prüfung anpassen, Begründung im Review. Einzelne Ausnahmen (z. B. ein nie ausgeführtes Sicherheits-Fixture) gehören mit Grund in `ERLAUBT` in `scripts/check-runtime-stack.mjs`.
