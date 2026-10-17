/**
 * CRSF Phase 2Q, CR-VERIFY-003: Regressionsnachweis fuer die historischen
 * Korrekturen am Pruefrahmen selbst (FRAMEWORK_FIX in framework-changes.json):
 *   F-2C-3 - Evidenzstufe je Typ gedeckelt (LEVEL_EXCEEDS_TYPE; Fixtures T, X2);
 *   F-2D-1 - real-system-Evidenz braucht echte Infrastruktur (Fixture T2);
 *   F-2J-1 - offene Anwendungsbefunde blockieren die Freigabe (Fixtures Z1, Z6, Z12).
 * (F-2C-2, NOT_RUN blockiert, steht in test/crsf-engine.test.mjs.)
 *
 * Der echte Selbsttest (security/crsf/selftest/framework-selftest.mjs) laeuft als
 * eigener Prozess gegen die echte Definition und die echte Engine; jede genannte
 * Fixture ist eine bekannt-falsche Definition, die abgelehnt werden MUSS. Der
 * Gesamtlauf (inkl. der Fixtures M/R, die einen Git-Arbeitsbereich brauchen) ist
 * `npm run security:framework-test`; hier zaehlen nur die genannten Fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const run = spawnSync(process.execPath, ['security/crsf/selftest/framework-selftest.mjs'], { encoding: 'utf8', timeout: 240_000 });
const lines = `${run.stdout}${run.stderr}`.split('\n');
const fixture = (id) => lines.find((l) => new RegExp(`^\\S+\\s+${id}\\s`).test(l)) ?? `missing fixture ${id}`;

for (const [fix, ids] of [['F-2C-3', ['T', 'X2']], ['F-2D-1', ['T2']], ['F-2J-1', ['Z1', 'Z6', 'Z12']]]) {
	test(`HIST ${fix} the framework still rejects its known-bad fixtures ${ids.join(', ')}`, () => {
		for (const id of ids) assert.match(fixture(id), /^ok\s/, `${fix}: fixture ${id} accepted - ${fixture(id)}`);
	});
}
