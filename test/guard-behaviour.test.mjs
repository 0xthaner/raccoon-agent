/**
 * Verhalten des Test-Waechters (CRSF Phase 2C, CR-VERIFY-001, CR-VERIFY-002).
 *
 * Kopiert den ECHTEN Waechter (scripts/run-tests-guarded.mjs) und die ECHTE
 * Skip-Regel (scripts/skip-policy.mjs) in ein Wegwerf-Projekt mit gezielten
 * Testdateien und startet ihn als eigenen Prozess. Belegt wird das Verhalten
 * (Exitcode, Meldung), nicht der Quelltext:
 * - abgebrochene, fehlgeschlagene, todo- und unerwartet uebersprungene Tests
 *   lassen den Lauf scheitern,
 * - ein erlaubter DB-Skip besteht nur, solange M1_DB_TEST_PG_URL fehlt, und nur
 *   mit exakt Datei + Name,
 * - eine gefundene Testdatei ohne einen einzigen Testfall laesst den Lauf
 *   scheitern (Phase 2D, Befund F-2C-1) - im Waechter wie im CRSF-Testausfuehrer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests, classifyOutcomes } from '../security/crsf/lib/exec.mjs';

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));

/** Builds a throwaway project with the real guard and the given test files, runs it, removes it. */
function runGuard(files, env = {}) {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'crsf-guard-'));
	try {
		mkdirSync(path.join(dir, 'scripts'));
		mkdirSync(path.join(dir, 'test'));
		for (const f of ['run-tests-guarded.mjs', 'skip-policy.mjs', 'file-case-accounting.mjs']) copyFileSync(path.join(SCRIPTS, f), path.join(dir, 'scripts', f));
		for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, 'test', name), `import { test } from 'node:test';\n${body}\n`);
		const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...env };
		const p = spawnSync(process.execPath, ['scripts/run-tests-guarded.mjs'], { cwd: dir, env: childEnv, encoding: 'utf8', timeout: 60_000 });
		return { code: p.status, stderr: p.stderr ?? '' };
	} finally { rmSync(dir, { recursive: true, force: true }); }
}
const PASS = "test('a passing test', () => {});";
const DB = { M1_DB_TEST_PG_URL: 'postgres://postgres@127.0.0.1:1/none' };

test('GUARD: a clean run passes (control)', () => {
	const r = runGuard({ 'ok.test.mjs': PASS });
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stderr, /keine Fehler/);
});

test('GUARD-CANCEL: a cancelled subtest fails the run', () => {
	const r = runGuard({ 'ok.test.mjs': PASS, 'cancel.test.mjs': "test('parent', { timeout: 150 }, async (t) => { await t.test('child', async () => { await new Promise((r) => setTimeout(r, 1500)); }); });" });
	assert.equal(r.code, 1);
	assert.match(r.stderr, /CANCELLED\s+test\/cancel\.test\.mjs :: child/);
});

test('GUARD-FAIL: a failing test fails the run', () => {
	const r = runGuard({ 'fail.test.mjs': "test('broken', () => { throw new Error('x'); });" });
	assert.equal(r.code, 1);
	assert.match(r.stderr, /FAILED\s+test\/fail\.test\.mjs :: broken/);
});

test('GUARD-SKIP: an unexpected skip fails the run', () => {
	const r = runGuard({ 'ok.test.mjs': PASS, 'skip.test.mjs': "test('quietly skipped', { skip: 'why not' }, () => {});" });
	assert.equal(r.code, 1);
	assert.match(r.stderr, /SKIPPED\s+test\/skip\.test\.mjs :: quietly skipped/);
});

test('GUARD-TODO: a todo test fails the run', () => {
	const r = runGuard({ 'ok.test.mjs': PASS, 'todo.test.mjs': "test('later', { todo: 'later' }, () => {});" });
	assert.equal(r.code, 1);
	assert.match(r.stderr, /TODO\s+test\/todo\.test\.mjs :: later/);
});

test('GUARD-DBSKIP: the allowlisted DB skip passes only while no disposable Postgres is configured', () => {
	const files = { 'ok.test.mjs': PASS, 'm1-wallet-limit-db.test.mjs': "test('M1-DB', { skip: 'no db' }, () => {});" };
	const without = runGuard(files);
	assert.equal(without.code, 0, `without DB the exact allowlisted skip is fine: ${without.stderr}`);
	const withDb = runGuard(files, DB);
	assert.equal(withDb.code, 1, 'with M1_DB_TEST_PG_URL set the same skip is an error');
	assert.match(withDb.stderr, /SKIPPED\s+test\/m1-wallet-limit-db\.test\.mjs :: M1-DB/);
});

test('GUARD-DBSKIP: the allowlist is exact - same name in another file, or another name in the file, is not allowed', () => {
	const otherFile = runGuard({ 'ok.test.mjs': PASS, 'elsewhere.test.mjs': "test('M1-DB', { skip: 'no db' }, () => {});" });
	assert.equal(otherFile.code, 1);
	const otherName = runGuard({ 'ok.test.mjs': PASS, 'm1-wallet-limit-db.test.mjs': "test('something else', { skip: 'no db' }, () => {});" });
	assert.equal(otherName.code, 1);
});

test('GUARD-EMPTY: a run without any test file fails', () => {
	const r = runGuard({});
	assert.equal(r.code, 1);
	assert.match(r.stderr, /KEINE TESTS/);
});

// F-2C-1: node:test reports a test FILE without any test case as one passing entry (the file wrapper).
const EMPTY_VARIANTS = {
	'only the import': '',
	'an empty suite': "import { describe } from 'node:test';\ndescribe('nothing inside', () => {});",
	'tests registered behind a false condition': "if (process.env.CRSF_NEVER_SET) test('never registered', () => {});",
	'a comment only': '// all tests were removed'
};

test('GUARD-EMPTYFILE: a discovered test file without any test case fails the run, next to a passing file', () => {
	for (const [label, body] of Object.entries(EMPTY_VARIANTS)) {
		const r = runGuard({ 'ok.test.mjs': PASS, 'lost-all-tests.test.mjs': body });
		assert.equal(r.code, 1, `${label}: ${r.stderr}`);
		assert.match(r.stderr, /LEER\s+test\/lost-all-tests\.test\.mjs :: keine Testfaelle/, label);
		assert.doesNotMatch(r.stderr, /LEER\s+test\/ok\.test\.mjs/, `${label}: the file with a test is not flagged`);
	}
});

test('GUARD-EMPTYFILE: a file whose only test is the allowlisted DB skip is not empty (control)', () => {
	const r = runGuard({ 'ok.test.mjs': PASS, 'm1-wallet-limit-db.test.mjs': "test('M1-DB', { skip: 'no db' }, () => {});" });
	assert.equal(r.code, 0, r.stderr);
	assert.doesNotMatch(r.stderr, /LEER/);
});

test('EXEC-EMPTYFILE: the CRSF test executor reports a file without test cases as a failure, never as a pass', () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'crsf-exec-'));
	try {
		mkdirSync(path.join(dir, 'test'));
		writeFileSync(path.join(dir, 'test', 'ok.test.mjs'), `import { test } from 'node:test';\n${PASS}\n`);
		writeFileSync(path.join(dir, 'test', 'lost-all-tests.test.mjs'), "import { test } from 'node:test';\n");
		const env = { PATH: process.env.PATH, HOME: process.env.HOME };
		const run = runTests(['test/ok.test.mjs', 'test/lost-all-tests.test.mjs'], { cwd: dir, env, timeoutMs: 60_000 });
		assert.ok(run.ok, run.error);
		assert.deepEqual(run.results.filter((r) => r.file === 'test/lost-all-tests.test.mjs').map((r) => r.outcome), ['fail']);
		assert.deepEqual(classifyOutcomes(run.results, env).fail, ['test/lost-all-tests.test.mjs :: (no test cases)']);
		assert.equal(classifyOutcomes(run.results, env).pass, 1, 'only the real test counts as a pass');
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
