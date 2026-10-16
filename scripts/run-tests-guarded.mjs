/*
	Testlauf mit Abbruch-Waechter (16.10.2026).

	`node --test` beendet sich mit Erfolg, auch wenn Tests ABGEBROCHEN wurden
	("cancelledByParent") oder uebersprungen sind - so liefen 33 Tests aus
	nexus-documents.test.mjs, darunter alle PDF-, Umleitungs- und Abruf-
	Sicherheitstests, wochenlang gar nicht, und die CI blieb gruen.

	Dieser Wrapper fuehrt dieselben Testdateien mit dem Node-Runner aus (gleiche
	Erkennung, ein Prozess je Datei) und scheitert bei:
	- jedem fehlgeschlagenen oder abgebrochenen Test,
	- jedem `todo`,
	- jedem Skip, der nicht exakt (Datei + Testname) unten erlaubt ist,
	- einem Lauf ohne Tests.

	Erlaubt ist nur, was ohne Infrastruktur bewusst nicht laufen kann - und auch
	das nur, solange die Infrastruktur tatsaechlich fehlt und der Test
	uebersprungen wird, nicht wenn er scheitert.
*/
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import path from 'node:path';

// Genau ein erlaubter Skip: der Postgres-Integrationstest von M1, und nur solange
// kein Wegwerf-Postgres konfiguriert ist. Ist M1_DB_TEST_PG_URL gesetzt und der
// Test wird trotzdem uebersprungen, ist das ein Fehler wie jeder andere Skip.
const ALLOWED_SKIPS = new Map([
	['test/m1-wallet-limit-db.test.mjs :: M1-DB', () => !process.env.M1_DB_TEST_PG_URL]
]);

const relative = (file) => path.relative(process.cwd(), file ?? '').split(path.sep).join('/');
const problems = [];
const count = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };

const stream = run({ concurrency: true });
stream.on('test:pass', ({ name, file, skip, todo, details }) => {
	if (details?.type === 'suite') return;
	count.tests++;
	const id = `${relative(file)} :: ${name}`;
	if (todo !== undefined) { count.todo++; problems.push(`TODO       ${id}`); return; }
	if (skip !== undefined) {
		count.skipped++;
		if (!ALLOWED_SKIPS.get(id)?.()) problems.push(`SKIPPED    ${id}`);
		return;
	}
	count.pass++;
});
stream.on('test:fail', ({ name, file, details }) => {
	if (details?.type === 'suite') return;
	count.tests++;
	const cancelled = details?.error?.failureType === 'cancelledByParent';
	count[cancelled ? 'cancelled' : 'fail']++;
	problems.push(`${cancelled ? 'CANCELLED ' : 'FAILED    '} ${relative(file)} :: ${name}`);
});
stream.compose(spec).pipe(process.stdout);
stream.on('end', () => {
	if (!count.tests) problems.push('KEINE TESTS gefunden');
	const summary = Object.entries(count).map(([k, v]) => `${k}=${v}`).join(' ');
	if (problems.length) {
		process.stderr.write(`\nTEST-WAECHTER: ${summary}\nTEST-WAECHTER: ${problems.length} Problem(e)\n${problems.map((p) => `  ${p}`).join('\n')}\n`);
		process.exitCode = 1;
	} else {
		process.stderr.write(`\nTEST-WAECHTER: ${summary} - keine Fehler, keine Abbrueche, nur erlaubte Skips.\n`);
	}
});
