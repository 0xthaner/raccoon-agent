/*
	Testfaelle je Testdatei zaehlen (CRSF Phase 2D, Befund F-2C-1).

	Der Node-Runner meldet jede Testdatei als eigenen Eintrag (Name = Dateipfad).
	Enthaelt die Datei Testfaelle, verschwindet dieser Huellen-Eintrag hinter den
	Faellen; enthaelt sie KEINEN Testfall, meldet er ihn als einen bestandenen
	Test. Ein Sicherheitstest, dem alle Faelle abhanden gekommen sind, lief damit
	"gruen".

	Gemeinsam benutzt vom Test-Waechter (scripts/run-tests-guarded.mjs) und vom
	CRSF-Testausfuehrer (security/crsf/lib/node-test-exec.mjs):
	- die Huelle einer Datei ist nie ein Testfall,
	- jede vom Runner gefundene Datei ohne einen einzigen Testfall ist ein Fehler.
*/
import path from 'node:path';

/** Is this runner event the per-file wrapper node:test creates for a test file (not a test case)? */
export function isFileWrapper({ name, file }, cwd = process.cwd()) {
	return Boolean(file) && path.resolve(cwd, String(name)) === path.resolve(file);
}

/** Tracks every discovered test file and how many real test cases (pass, fail, skip, todo) it produced. */
export function createFileAccounting(cwd = process.cwd()) {
	const cases = new Map();
	const discover = ({ file }) => { if (file && !cases.has(path.resolve(file))) cases.set(path.resolve(file), 0); };
	return {
		discover,
		/** Registers a runner event; counts it as a test case unless it is a suite or the file wrapper. */
		observe(event) {
			discover(event);
			if (!event.file || event.details?.type === 'suite' || isFileWrapper(event, cwd)) return false;
			cases.set(path.resolve(event.file), cases.get(path.resolve(event.file)) + 1);
			return true;
		},
		/** Discovered files without a single test case (absolute paths, sorted). */
		emptyFiles: () => [...cases].filter(([, n]) => n === 0).map(([f]) => f).sort()
	};
}
