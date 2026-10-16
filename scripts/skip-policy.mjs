/*
	Erlaubte Skips fuer alle Testlaeufe (Test-Waechter und CRSF-Verifikation).

	Ausgelagert aus scripts/run-tests-guarded.mjs (CRSF Phase 2A), damit
	`npm run security:verify` exakt dieselbe Liste benutzt und die beiden nicht
	auseinanderlaufen. Inhalt unveraendert: nur die Postgres-Integrationstests
	(M1, H2, L1, L5, REVOKE, DBPRIV, DASHBOARD-LOGIN), jeweils exakt mit Datei und Name, und nur solange kein
	Wegwerf-Postgres konfiguriert ist. Ist M1_DB_TEST_PG_URL gesetzt und ein Test
	wird trotzdem uebersprungen, ist das ein Fehler wie jeder andere Skip.
*/
export const ALLOWED_SKIPS = new Map([
	['test/m1-wallet-limit-db.test.mjs :: M1-DB', (env) => !env.M1_DB_TEST_PG_URL],
	// Restaudit H2: Challenge-Verbrauch unter echter Gleichzeitigkeit, derselbe Wegwerf-Postgres.
	['test/h2-challenge-concurrency-db.test.mjs :: H2-DB', (env) => !env.M1_DB_TEST_PG_URL],
	// Restaudit L1: Zuordnungs-Limit unter echter Gleichzeitigkeit, derselbe Wegwerf-Postgres.
	['test/l1-attribution-limit-db.test.mjs :: L1-DB', (env) => !env.M1_DB_TEST_PG_URL],
	// Restaudit L5: Bereinigung beim Abgleich gegen gleichzeitige Bestaetigung, derselbe Wegwerf-Postgres.
	['test/l5-attribution-cleanup-db.test.mjs :: L5-DB', (env) => !env.M1_DB_TEST_PG_URL],
	// CRSF Phase 2B: Sitzungs-Widerruf und gleichzeitige Widerrufe, derselbe Wegwerf-Postgres.
	['test/session-revocation-db.test.mjs :: REVOKE-DB', (env) => !env.M1_DB_TEST_PG_URL],
	// CRSF Phase 2C: Datenbank-Berechtigungen und Dashboard-Anmeldung gegen echtes Postgres.
	['test/db-privileges-db.test.mjs :: DBPRIV-DB', (env) => !env.M1_DB_TEST_PG_URL],
	['test/dashboard-login-db.test.mjs :: DASHBOARD-LOGIN-DB', (env) => !env.M1_DB_TEST_PG_URL]
]);

/** Ist der Skip `id` ("<datei> :: <name>") unter der Umgebung `env` erlaubt? */
export function isAllowedSkip(id, env = process.env) {
	return ALLOWED_SKIPS.get(id)?.(env) === true;
}
