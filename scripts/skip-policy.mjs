/*
	Erlaubte Skips fuer alle Testlaeufe (Test-Waechter und CRSF-Verifikation).

	Ausgelagert aus scripts/run-tests-guarded.mjs (CRSF Phase 2A), damit
	`npm run security:verify` exakt dieselbe Liste benutzt und die beiden nicht
	auseinanderlaufen. Inhalt unveraendert: nur die Postgres-Integrationstests
	(M1, H2, L1, L5, REVOKE, DBPRIV, DASHBOARD-LOGIN, INPUT-DB-PG, RL, LOCKS, PURCHASE-DB, PURCHASE-DB-CONC, PURCHASE-CONFIRMATION-DB), jeweils exakt mit Datei und Name, und nur solange kein
	Wegwerf-Postgres konfiguriert ist. Ist M1_DB_TEST_PG_URL gesetzt und ein Test
	wird trotzdem uebersprungen, ist das ein Fehler wie jeder andere Skip.

	CRSF Phase 2R: die beiden Tests mit der echten Vercel-CLI, exakt mit Datei und
	Name, nur solange `vercel --version` nicht laeuft. Ist die CLI installiert und
	ein Test wird trotzdem uebersprungen, ist das ein Fehler.

	CRSF Phase 2S: der Registry-Signatur-Test (Netz, nur lesend) nur solange
	CRSF_NETWORK_EVIDENCE nicht auf 1 steht; mit Freigabe ist ein Skip ein Fehler.
*/
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

function vercelCliMissing(env) {
	try {
		const r = spawnSync('vercel', ['--version'], { encoding: 'utf8', env: { PATH: env.PATH ?? '', HOME: tmpdir(), VERCEL_TELEMETRY_DISABLED: '1', NO_UPDATE_NOTIFIER: '1' }, timeout: 60_000 });
		return !(r.status === 0 && /\d+\.\d+\.\d+/.test(`${r.stdout}${r.stderr}`));
	} catch {
		return true;
	}
}
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
	['test/dashboard-login-db.test.mjs :: DASHBOARD-LOGIN-DB', (env) => !env.M1_DB_TEST_PG_URL],
	// CRSF Phase 2N: CR-INPUT-004, feindselige Werte und SQL-Funktionen gegen echtes Postgres.
	['test/input-db-adversarial-db.test.mjs :: INPUT-DB-PG', (env) => !env.M1_DB_TEST_PG_URL],
	// CRSF Phase 2V: CR-RESOURCE-002 (Rate-Limit-Zaehler) und CR-CONC-006 (Advisory-Sperren) gegen echtes Postgres.
	['test/rate-limit-atomic-db.test.mjs :: RL-DB', (env) => !env.M1_DB_TEST_PG_URL],
	['test/advisory-locks-db.test.mjs :: LOCKS-DB', (env) => !env.M1_DB_TEST_PG_URL],
	// Nexus P4D: Kauf-Intents (Unveraenderlichkeit, Rechte, Einmal-Nutzung unter echter Gleichzeitigkeit), derselbe Wegwerf-Postgres.
	['test/purchase-intent-db.test.mjs :: PURCHASE-DB', (env) => !env.M1_DB_TEST_PG_URL],
	['test/purchase-intent-db-concurrency.test.mjs :: PURCHASE-DB-CONC', (env) => !env.M1_DB_TEST_PG_URL],
	// Nexus P4G: Bestaetigungs-Orchestrierung gegen die echten P4D-Uebergaenge, derselbe Wegwerf-Postgres.
	['test/purchase-confirmation-db.test.mjs :: PURCHASE-CONFIRMATION-DB', (env) => !env.M1_DB_TEST_PG_URL],
	// CRSF Phase 2R: historische Korrekturen cad24d4 und b647281 mit der echten Vercel-CLI.
	['test/vercel-cli-local.test.mjs :: VERCEL-CLI cad24d4 the real CLI upload set excludes .env and .env.* (except .env.example)', vercelCliMissing],
	['test/vercel-cli-local.test.mjs :: VERCEL-CLI b647281 vercel build runs the installCommand of vercel.json and it refuses a lockfile that does not match', vercelCliMissing],
	// CRSF Phase 2S: historische Korrektur b706956 gegen die echte Registry und Sigstore-TUF - nur mit ausdruecklicher Netz-Freigabe.
	['test/npm-registry-signatures.test.mjs :: NPM-SIGNATURES b706956 check:ci verifies registry signatures with the real npm and fails on a tampered package', (env) => env.CRSF_NETWORK_EVIDENCE !== '1']
]);

/** Ist der Skip `id` ("<datei> :: <name>") unter der Umgebung `env` erlaubt? */
export function isAllowedSkip(id, env = process.env) {
	return ALLOWED_SKIPS.get(id)?.(env) === true;
}
