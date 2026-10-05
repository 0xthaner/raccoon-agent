# Security Incident Runbook — Raccoon Agent

Kurz, konkret, ausführbar. **Keine echten Schlüssel, IDs oder Tokens in dieses Dokument.**

## Grundlagen (einmal lesen)

- **Env ändern wirkt erst nach Redeploy.** Nach jeder Secret-Änderung in Vercel: `vercel --prod` (Projekt `raccoon-agent`).
- **Globaler Session-Kill:** `DASHBOARD_SESSION_SECRET` rotieren → **alle** Dashboard-Sessions sofort ungültig (HMAC passt nicht mehr) und alle Rate-Limit-Kennungen wechseln. Stärkster, gröbster Hebel.
- **Alle produktiven Secrets sind Production-only** (nicht in Preview/Development).
- **Pause-Schalter im Code** (`src/pause.mjs`): `ANMELDUNG_PAUSIERT` (keine neuen Logins/Verknüpfungen), `AGENT_ANTWORTEN_PAUSIERT` (keine KI-Antworten). Setzen → committen → deployen.
- **Rollback:** Vercel-Dashboard → `raccoon-agent` → Deployments → früheres, funktionierendes Deployment → „Promote to Production" (oder `vercel rollback`). Migrationen sind additiv → alter Code läuft gegen aktuelles Schema.
- **Security-Ereignisse** stehen in `agent_events` (`event_type` beginnt mit `security.`), mit nur einem nicht umkehrbaren Fingerprint (`metadata.fp`) und `scope` — keine rohe IP, kein Code, keine Signatur. Abfrage z. B.:
  `select event_type, metadata, occurred_at from agent_events where event_type like 'security.%' order by occurred_at desc limit 100;`
- **Angriffs-Indiz ohne Erfolg:** viele `dashboard_challenges` ohne zugehöriges `dashboard.wallet_authenticated` bzw. viele `security.siwe_signature_invalid`.

---

## 1. TELEGRAM_BOT_TOKEN kompromittiert
- **Detection:** fremde Bot-Antworten; unerwartete `telegram_deliveries`-Fehler; Hinweis von BotFather/Telegram.
- **Containment:** Bei @BotFather `/revoke` → neues Token erzeugen. Alten Token damit sofort ungültig.
- **Recovery:** `TELEGRAM_BOT_TOKEN` in Vercel (Production) setzen → **Redeploy** → **Webhook neu setzen** (`setWebhook` mit der Agent-URL **und** `secret_token` = aktuelles `TELEGRAM_WEBHOOK_SECRET`), sonst kommen keine Updates mehr an.
- **Verification:** `getWebhookInfo` zeigt die richtige URL und „pending_update_count" sinkt; eine Testnachricht an den Bot wird beantwortet.
- **Side Effects:** kurzzeitig keine Bot-Reaktion bis Redeploy+setWebhook. Dashboard-Sessions **unberührt**.

## 2. TELEGRAM_WEBHOOK_SECRET kompromittiert
- **Detection:** gehäufte `security.webhook_auth_failed` ODER plötzlich „echte" Updates ohne Nutzeraktion.
- **Containment:** neues Webhook-Secret wählen, `TELEGRAM_WEBHOOK_SECRET` in Vercel (Production) setzen.
- **Recovery:** **Redeploy** → **`setWebhook`** mit dem neuen `secret_token`. Ab dann werden mit dem alten Secret gefälschte Updates verworfen (401).
- **Verification:** gefälschter POST auf `/api/telegram` ohne korrekten Header → 401; legitime Nachrichten funktionieren; `security.webhook_auth_failed` versiegt.
- **Side Effects:** zwischen Secret-Wechsel und erfolgreichem `setWebhook` kommen keine Updates an. Sessions unberührt.

## 3. OPENAI_API_KEY kompromittiert
- **Detection:** unerwartete Kosten im OpenAI-Dashboard; viele `agent.intent`-Events.
- **Containment:** Key im OpenAI-Dashboard widerrufen.
- **Recovery:** neuen Key erzeugen, `OPENAI_API_KEY` in Vercel (**nur Production**) setzen → Redeploy.
- **Verification:** eine Produktfrage wird wieder beantwortet; OpenAI-Nutzung normalisiert sich.
- **Side Effects:** **Kernfunktionen bleiben verfügbar** — ohne gültigen Key fällt die Intent-Erkennung auf die lokale Regex (`localIntent`) zurück; Covers, Ablauf, Erinnerungen, Dashboard funktionieren weiter. Freie Produktantworten entfallen, bis der Key gesetzt ist. Kosten sind durch das AI-Budget (`src/ai-budget.mjs`) gedeckelt.

## 4. SUPABASE_SECRET_KEY kompromittiert — **HOHE PRIORITÄT**
- **Detection:** fremde DB-Zugriffe im Supabase-Log; unerwartete Datenänderungen.
- **Containment:** **sofort** in Supabase die API-Keys rotieren (Secret/Service-Key neu ausstellen). Bei akutem Verdacht zusätzlich App über `ANMELDUNG_PAUSIERT`/`AGENT_ANTWORTEN_PAUSIERT` einfrieren.
- **Recovery:** `SUPABASE_SECRET_KEY` (ggf. `SUPABASE_URL`) in Vercel (Production) aktualisieren → Redeploy. Datenintegrität prüfen (siehe 8/Kritische Tabellen).
- **Verification:** alter Key liefert in Supabase 401/permission denied; App liest/schreibt wieder normal.
- **Side Effects:** kurze DB-Downtime während Rotation/Redeploy. **Dashboard-Sessions unberührt** (eigenes HMAC-Secret). RLS schützt ohnehin alle Tabellen; der Service-Key ist die einzige Vollzugriffs-Grenze.

## 5. DASHBOARD_SESSION_SECRET kompromittiert
- **Detection:** fremde, gültige Dashboard-Sessions ohne zugehörigen Login.
- **Containment / Recovery:** `DASHBOARD_SESSION_SECRET` in Vercel (Production) neu setzen → Redeploy. **= globaler Session-Kill:** alle bestehenden Sessions werden sofort ungültig; alle Rate-Limit-Kennungen (HMAC über dieses Secret) wechseln.
- **Verification:** alte Session-Cookies ergeben `NO_SESSION`/401; ein frischer Login (Signatur) funktioniert.
- **Side Effects:** **alle** Nutzer müssen sich einmalig neu anmelden. Rate-Limit-Zähler starten neu.

## 6. Gestohlene Dashboard-Session (einzelner Nutzer)
- **Detection:** Nutzer meldet fremden Zugriff; ungewöhnliche Aktivität einer Wallet.
- **Containment:** Die betroffene Wallet trennt sich selbst („Wallet vollständig trennen" im Bot/Dashboard) → `revokeDashboardSessions(wallet)` macht **alle** Sessions dieser Wallet sofort ungültig (Prüfung bei jedem Dashboard-Request). Ist Nutzer-Mitwirkung unmöglich und sofortiges Handeln nötig: `DASHBOARD_SESSION_SECRET` rotieren (globaler Kill, Szenario 5).
- **Recovery:** Nutzer meldet sich neu an (Wallet-Signatur erforderlich).
- **Verification:** altes Cookie → 401 `SESSION_REVOKED`.
- **Side Effects:** bei Einzel-Trennung nur diese Wallet betroffen; bei Secret-Rotation alle.
- **Hinweis:** Ein betreiberseitiger Einzel-Widerruf **ohne** Nutzer existiert derzeit nicht (offenes Finding AGENT-IR-004).

## 7. Kompromittierte Wallet
- **Detection:** Nutzer meldet verlorenen Schlüssel.
- **Containment (Agent-seitig):** Die Wallet kann im Agent nur ihre **eigenen, öffentlichen** Cover-Daten sehen und Telegram ver-/entknüpfen — **keine Transaktion, keine Geldbewegung** (der Agent ist read-only, verlangt nur die Klartext-Login-Signatur). „Wallet vollständig trennen" entfernt die Telegram-Verknüpfung und widerruft Sessions.
- **Recovery:** Blockchain-/Wallet-Recovery liegt außerhalb des Agents (eigener Schlüsseltausch beim Nutzer). Agent-seitig: Verknüpfung trennen.
- **Verification:** keine aktive Telegram-Verknüpfung mehr für die Wallet; keine aktive Session.
- **Side Effects:** nur diese Wallet/Chat betroffen.

## 8. Datenbank-Ausfall (Supabase nicht erreichbar)
- **Detection:** API-Endpunkte antworten 500/503; Cron-Lauf meldet Fehler (`console.error purgeOldRecords …`); `security.*`/Audit-Writes fehlen.
- **Containment:** Supabase-Status prüfen; abwarten/Support. Verhalten ist **fail closed** — kein stiller Teilzustand. `allowAiRequest` bleibt privat offen, in Gruppen zu.
- **Recovery:** sobald Supabase wieder `ACTIVE_HEALTHY`, normalisiert sich alles ohne Eingriff.
- **Verification:** Dashboard lädt; `/api/alerts` (mit `CRON_SECRET`) liefert `ok:true`.
- **Side Effects:** während des Ausfalls keine Logins/Verknüpfungen/Erinnerungen.

## 9. Fehlerhaftes Production-Deployment
- **Detection:** Fehleranstieg nach einem Deploy; kaputte Seite/Funktion.
- **Containment:** **Vercel-Rollback** auf das letzte funktionierende Deployment (Dashboard → Deployments → Promote, oder `vercel rollback`).
- **Recovery:** Fehler im Code beheben, Tests (`npm run test:ci`, `npm run check:ci`) grün, neu deployen.
- **Verification:** Smoke-Test der betroffenen Route; Fehlerrate sinkt.
- **Side Effects:** keine — additive Migrationen, alter Code ist schema-kompatibel. Laufende Sessions bleiben gültig.

## 10. Ungewöhnlicher Traffic / Abuse
- **Detection:** viele `security.rate_limit_blocked`; viele `security.siwe_signature_invalid`/`webhook_auth_failed`; `api_rate_limits` zeigt hohe Zähler.
- **Containment:** Rate-Limits greifen bereits (fail closed). Bei Bedarf `ANMELDUNG_PAUSIERT=true` setzen (stoppt Logins/Verknüpfungen) und deployen. Bei gezieltem Missbrauch einer Wallet: Szenario 6.
- **Recovery:** nach Abklingen Pause wieder aufheben.
- **Verification:** `security.rate_limit_blocked`-Rate normalisiert sich.
- **Side Effects:** während der Pause keine neuen Logins/Verknüpfungen.

## 11. OpenAI-Ausfall
- **Detection:** Produktfragen bleiben unbeantwortet; OpenAI-Statusseite.
- **Containment:** keine Aktion nötig — **graceful**: Timeout (8/12s) + Fallback auf lokale Intent-Regex; Antwortfunktionen liefern „derzeit nicht beantwortbar".
- **Recovery:** von selbst, sobald OpenAI zurück ist.
- **Verification:** Produktfrage wird wieder beantwortet.
- **Side Effects:** vorübergehend keine freien KI-Antworten; Kernfunktionen laufen weiter.

## 12. Telegram-Ausfall
- **Detection:** Nachrichten/Erinnerungen kommen nicht an; `telegram_deliveries`-Fehler; Telegram-Statusseite.
- **Containment:** keine Aktion — Zustellversuche scheitern best-effort, nichts bricht.
- **Recovery:** von selbst; verpasste Erinnerungen werden nicht automatisch nachgeholt (Ablaufprüfung läuft beim nächsten Cron erneut).
- **Verification:** Testnachricht wird zugestellt.
- **Side Effects:** während des Ausfalls keine Benachrichtigungen.

---

## Offen: Operator-Alerting (AGENT-IR-001)
Automatisches Alerting ist **noch nicht aktiv**, weil keine sichere Operator-Destination konfiguriert ist. Benötigt wird später eine serverseitige, Production-only Variable (Vorschlag: `OPERATOR_TELEGRAM_CHAT_ID`, nur eine numerische Chat-ID, kein Secret) plus ein kleiner Alert-Pfad über das bestehende Telegram-Bot-Token. Bis dahin: die obigen `agent_events`-Abfragen manuell bzw. über Vercel-/Supabase-Observability nutzen.
