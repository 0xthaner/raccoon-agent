/**
 * CRSF Phase 2Q, CR-VERIFY-003: Register der historischen Sicherheitskorrekturen
 * (security/crsf/fix-register.json) gegen das echte Repository.
 *
 * 1. Das echte Register ist vollstaendig und konsistent: jede Kennung im
 *    Quelltext eingeordnet, jede eingetragene Kennung noch vorhanden, jede
 *    PROVEN-Korrektur mit Invariante, verhaltensbasierter KILLED-Mutation und
 *    Regressionstest (erwartetes Scheitern genau dieser Mutation). Korrekturen
 *    ohne reproduzierbaren Nachweis stehen ehrlich als MISSING_EVIDENCE da.
 * 2. Der Waechter schlaegt fehl (fail closed) - geprueft mit bekannt-falschen
 *    Registern und Wegwerf-Arbeitsbereichen: neue Kennung einer bekannten oder
 *    einer NEUEN Familie, verschwundene Kennung, Korrektur ohne Mutation, nur
 *    statische Mutation, fremder Test, doppelt beanspruchte Mutation, nicht
 *    eingetragenes FINDING_FIXED, nicht eingeordneter Sicherheits-Commit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkRepository, discoverMarkers, parseSecurityFixTrailer, validateRegister } from '../security/crsf/lib/fix-register.mjs';

const register = JSON.parse(readFileSync('security/crsf/fix-register.json', 'utf8'));
const cases = JSON.parse(readFileSync('security/mutation/cases.json', 'utf8')).cases;
const codes = (r) => r.errors.map((e) => e.code);
const clone = (x) => structuredClone(x);

/** Kennungen nur zusammengesetzt, damit diese Datei selbst keine neue Kennung traegt. */
const TAG = (...parts) => parts.join('-');

function workspace(files) {
	const dir = mkdtempSync(path.join(tmpdir(), 'crsf-fixreg-'));
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		writeFileSync(path.join(dir, rel), text);
	}
	return dir;
}

/** Minimales gueltiges Register mit einer Korrektur und ihrer Mutation. */
function miniWorld() {
	const tag = TAG('AGENT', 'SEC', 'Z9');
	const dir = workspace({ 'src/a.mjs': `// ${tag}: fixed\nexport const a = 1;\n`, 'test/a.test.mjs': '// t\n' });
	const mutation = { id: 'MUT-Z9', expected_result: 'KILLED', detection: 'behavioral', tests: ['test/a.test.mjs'], expected_failures: [{ test: '^Z9 holds$' }] };
	const reg = {
		fixes: [{ id: 'FIX-Z9', classification: 'SECURITY_FIX', tags: [tag], origin: 'fixture origin Z9', files: ['src/a.mjs'], bug: 'fixture bug description', invariant: 'fixture invariant holds', tests: [{ file: 'test/a.test.mjs', test: '^Z9 holds$' }], mutations: ['MUT-Z9'], evidence_level: 'E4', status: 'PROVEN' }],
		tag_classifications: [], loose_markers: [], commits: []
	};
	const check = (r = reg, extra = {}) => validateRegister({ register: r, discovered: discoverMarkers(dir), cases: [mutation], root: dir, ...extra });
	return { dir, tag, mutation, reg, check };
}

test('FIXREG the real register is complete and consistent with the repository', () => {
	const result = checkRepository(process.cwd());
	assert.deepEqual(result.errors, [], 'register errors');
	assert.ok(result.summary.fixes >= 90, `expected the historical fixes, got ${result.summary.fixes}`);
	// Ehrlich offen: npm audit signatures braucht den Sigstore-TUF-Abgleich im Netz (Phase 2R, EXTERNAL_EVIDENCE_REQUIRED).
	assert.deepEqual(result.summary.missing, ['FIX-B706956-REGISTRY-SIGNATURES']);
	assert.equal(result.summary.complete, false, 'complete requires no MISSING_EVIDENCE');
	assert.equal(result.summary.proven, result.summary.fixes - result.summary.missing.length);
});

test('FIXREG every PROVEN fix names only executed, behavioural, KILLED mutations of the catalogue', () => {
	const byId = new Map(cases.map((c) => [c.id, c]));
	for (const f of register.fixes.filter((x) => x.status === 'PROVEN')) {
		assert.ok(f.mutations.length, f.id);
		for (const id of f.mutations) {
			const c = byId.get(id);
			assert.ok(c, `${f.id}: ${id} not in cases.json`);
			assert.equal(c.expected_result, 'KILLED', id);
			assert.equal(c.detection, 'behavioral', id);
		}
	}
});

test('FIXREG fixture: a minimal correct register passes (positive control)', (t) => {
	const w = miniWorld();
	t.after(() => rmSync(w.dir, { recursive: true, force: true }));
	assert.deepEqual(w.check().errors, []);
});

test('FIXREG fixture: a new tag of a known family fails closed', (t) => {
	const w = miniWorld();
	t.after(() => rmSync(w.dir, { recursive: true, force: true }));
	writeFileSync(path.join(w.dir, 'src/b.mjs'), `// ${TAG('AGENT', 'API', '9')}: new fix\n`);
	assert.ok(codes(w.check()).includes('UNCLASSIFIED_SECURITY_TAG'));
});

test('FIXREG fixture: a marker of a NEW family (catch-all) fails closed', (t) => {
	const w = miniWorld();
	t.after(() => rmSync(w.dir, { recursive: true, force: true }));
	writeFileSync(path.join(w.dir, 'src/c.mjs'), `// ${'AUD' + 'IT'} QX-9 hardening\n`);
	assert.ok(codes(w.check()).includes('UNCLASSIFIED_SECURITY_MARKER'));
});

test('FIXREG fixture: a registered tag that vanished from the code fails (stale)', (t) => {
	const w = miniWorld();
	t.after(() => rmSync(w.dir, { recursive: true, force: true }));
	writeFileSync(path.join(w.dir, 'src/a.mjs'), 'export const a = 1;\n');
	assert.ok(codes(w.check()).includes('STALE_TAG'));
});

test('FIXREG fixture: a PROVEN fix without mutation, with a static mutation, or with an unknown mutation fails', (t) => {
	const w = miniWorld();
	t.after(() => rmSync(w.dir, { recursive: true, force: true }));
	const none = clone(w.reg); none.fixes[0].mutations = [];
	assert.ok(codes(w.check(none)).includes('FIX_WITHOUT_MUTATION'));
	const unknown = clone(w.reg); unknown.fixes[0].mutations = ['MUT-NOPE'];
	assert.ok(codes(w.check(unknown)).includes('FIX_MUTATION_UNKNOWN'));
	const staticOnly = validateRegister({ register: w.reg, discovered: discoverMarkers(w.dir), cases: [{ ...w.mutation, detection: 'static' }], root: w.dir });
	assert.ok(codes(staticOnly).includes('FIX_MUTATION_NOT_BEHAVIORAL'));
	const survived = validateRegister({ register: w.reg, discovered: discoverMarkers(w.dir), cases: [{ ...w.mutation, expected_result: 'SURVIVED' }], root: w.dir });
	assert.ok(codes(survived).includes('FIX_MUTATION_NOT_KILLED'));
});

test('FIXREG fixture: missing invariant, foreign test or a mutation claimed twice fails', (t) => {
	const w = miniWorld();
	t.after(() => rmSync(w.dir, { recursive: true, force: true }));
	const noInv = clone(w.reg); noInv.fixes[0].invariant = '';
	assert.ok(codes(w.check(noInv)).includes('FIX_FIELD_MISSING'));
	const foreign = clone(w.reg); foreign.fixes[0].tests = [{ file: 'test/a.test.mjs', test: '^something else$' }];
	assert.ok(codes(w.check(foreign)).includes('FIX_TEST_NOT_AN_EXPECTED_FAILURE'));
	const twice = clone(w.reg); twice.fixes.push({ ...clone(twice.fixes[0]), id: 'FIX-Z9B', tags: [] });
	assert.ok(codes(w.check(twice)).includes('MUTATION_CLAIMED_TWICE'));
	const level = clone(w.reg); level.fixes[0].evidence_level = 'E3';
	assert.ok(codes(w.check(level)).includes('FIX_LEVEL_MISMATCH'));
});

test('FIXREG fixture: MISSING_EVIDENCE needs a reason and keeps the register incomplete', (t) => {
	const w = miniWorld();
	t.after(() => rmSync(w.dir, { recursive: true, force: true }));
	const open = clone(w.reg); Object.assign(open.fixes[0], { status: 'MISSING_EVIDENCE', mutations: [], tests: [], evidence_level: 'E2' });
	const r = w.check(open);
	assert.ok(codes(r).includes('FIX_MISSING_REASON'));
	open.fixes[0].missing_reason = 'platform behaviour, not reproducible offline';
	const r2 = w.check(open);
	assert.deepEqual(r2.errors, []);
	assert.equal(r2.summary.complete, false);
});

test('FIXREG fixture: a fixed CRSF finding that is not registered as a fix fails', (t) => {
	const w = miniWorld();
	t.after(() => rmSync(w.dir, { recursive: true, force: true }));
	assert.ok(codes(w.check(w.reg, { findingsFixed: [TAG('F', '9Z', '1')] })).includes('FINDING_FIX_UNREGISTERED'));
});

test('FIXREG fixture: every commit is classified - by hash in the register or by a Security-Fix: trailer; keyword-free commits too', (t) => {
	const w = miniWorld();
	t.after(() => rmSync(w.dir, { recursive: true, force: true }));
	const reg = clone(w.reg);
	const c = (hash, subject, body = '', matched = false) => ({ hash: `${hash}0000000000`, subject, body, matched });
	const commits = { mode: 'FULL', commits: [
		c('aaaaaaa', 'Harden the login', '', true),
		c('bbbbbbb', 'Tighten cookie handling', ''),
		c('ccccccc', 'Tighten cookie handling', 'Body.\n\nSecurity-Fix: FIX-Z9\n'),
		c('ddddddd', 'Fix typo', 'Security-Fix: none - wording in the guide only\n'),
		c('eeeeeee', 'Something', 'Security-Fix: FIX-NOPE\n'),
		c('fffffff', 'Something else', 'Security-Fix: none\n')
	] };
	const codesOf = (r) => r.errors.map((e) => `${e.code} ${e.detail.slice(0, 7)}`);
	assert.deepEqual(codesOf(w.check(reg, { commits })), [
		'UNCLASSIFIED_SECURITY_COMMIT aaaaaaa',
		'UNCLASSIFIED_COMMIT bbbbbbb',
		'SECURITY_FIX_TRAILER_UNKNOWN_FIX eeeeeee',
		'SECURITY_FIX_TRAILER_INVALID fffffff'
	]);
	// Registered by hash, the security commit passes; the trailers declare the rest.
	reg.commits = [{ commit: 'aaaaaaa', classification: 'SECURITY_FIX', fixes: ['FIX-Z9'] }, { commit: 'bbbbbbb', classification: 'NOT_SECURITY_FIX', reason: 'fixture' }];
	const ok = { mode: 'FULL', commits: commits.commits.filter((x) => !/^(eeeeeee|fffffff)/.test(x.hash)) };
	const r = w.check(reg, { commits: ok });
	assert.deepEqual(r.errors, []);
	assert.deepEqual(r.summary.commit_trailers.map((x) => x.commit), ['ccccccc', 'ddddddd']);
	// A shallow clone (CI) still checks every commit it has; without git nothing is asserted.
	assert.deepEqual(codesOf(w.check(reg, { commits: { mode: 'SHALLOW', commits: [c('9999999', 'New thing', '')] } })), ['UNCLASSIFIED_COMMIT 9999999']);
	assert.deepEqual(w.check(reg, { commits: { mode: 'UNAVAILABLE', commits: [] } }).errors, []);
	// A registered commit that vanished from full history is stale.
	assert.ok(codesOf(w.check(reg, { commits: { mode: 'FULL', commits: ok.commits.filter((x) => !x.hash.startsWith('bbbbbbb')) } })).includes('STALE_COMMIT bbbbbbb'));
});

test('FIXREG Security-Fix: trailer parsing is strict', () => {
	assert.equal(parseSecurityFixTrailer('no trailer here'), null);
	assert.deepEqual(parseSecurityFixTrailer('x\n\nSecurity-Fix: FIX-A1-SESSION-SECRET, FIX-F-2K-1\n'), { fixes: ['FIX-A1-SESSION-SECRET', 'FIX-F-2K-1'] });
	assert.deepEqual(parseSecurityFixTrailer('Security-Fix: none - evidence only, no behaviour change'), { fixes: [], none: 'evidence only, no behaviour change' });
	for (const bad of ['Security-Fix: none', 'Security-Fix: none - short', 'Security-Fix:', 'Security-Fix: fixes the login', 'Security-Fix: FIX-A\nSecurity-Fix: none - also something else']) {
		assert.ok(parseSecurityFixTrailer(bad).error, bad);
	}
});
