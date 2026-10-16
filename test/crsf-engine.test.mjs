/**
 * CRSF-Verifikationslogik (CRSF Phase 2C, CR-VERIFY-005, CR-VERIFY-009).
 *
 * Gegen den ECHTEN Mutationsausfuehrer (security/crsf/lib/exec.mjs) in einem
 * Wegwerf-Arbeitsbereich und die ECHTE Statusberechnung (engine.mjs) auf der
 * ECHTEN Definition:
 * - VERIFY-005: ein Test, der aus einem ANDEREN Grund scheitert, zaehlt nie als
 *   KILLED (KILLED_OTHER); nur das benannte erwartete Scheitern zaehlt.
 * - VERIFY-009: ein Mutant, den die Tests nicht bemerken (SURVIVED), entwertet
 *   den Known-bad-Nachweis der Eigenschaft; ebenso KILLED_OTHER, INVALID und
 *   NOT_RUN. EQUIVALENT ist neutral und beweist nie etwas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runMutation, childEnv, detectCapabilities, mutationClaimMismatches } from '../security/crsf/lib/exec.mjs';
import { loadDefinition, declaredOutcomes, evaluate, context, knownBadEffective } from '../security/crsf/lib/engine.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const TARGET = 'security/crsf/selftest/fixtures/mut-target.mjs';
const STRICT = 'security/crsf/selftest/fixtures/mut-strict-check.mjs';
const caseFor = (expected, extra = {}) => ({ id: 'MUT-CR-VERIFY-005-P1-FIXTURE', expected_result: 'KILLED', detection: 'behavioral', timeout_ms: 60_000, edits: [{ file: TARGET, find: 'return 1;', replace: 'return 2;' }], tests: [STRICT], expected_failures: expected, ...extra });

test('VERIFY-005: the named expected failure is KILLED; any other failure is KILLED_OTHER', () => {
	const env = childEnv(detectCapabilities());
	// Minimal disposable workspace with just the two fixture files (runMutation only needs a directory).
	const dir = mkdtempSync(path.join(os.tmpdir(), 'crsf-engine-'));
	const ws = { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
	for (const f of [TARGET, STRICT]) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); copyFileSync(path.join(REPO, f), path.join(dir, f)); }
	try {
		assert.equal(runMutation(caseFor([{ test: '^CRSF fixture: strict value check$' }]), ws, env, 60_000).result, 'KILLED', 'intended reason');
		assert.equal(runMutation(caseFor([{ test: '^CRSF fixture: unrelated check$' }]), ws, env, 60_000).result, 'KILLED_OTHER', 'tests failed, but not the expected one');
		assert.equal(runMutation(caseFor([{ test: '^CRSF fixture: strict value check$', message: 'some other assertion text' }]), ws, env, 60_000).result, 'KILLED_OTHER', 'right test, wrong assertion message');
		const noop = { ...caseFor([{ test: '.*' }]), edits: [{ file: TARGET, find: 'return 1;', replace: 'return 1; ' }] };
		assert.equal(runMutation(noop, ws, env, 60_000).result, 'SURVIVED', 'a behaviour-preserving edit survives');
		const ambiguous = { ...caseFor([{ test: '.*' }]), edits: [{ file: TARGET, find: 'r', replace: 'r' }] };
		assert.equal(runMutation(ambiguous, ws, env, 60_000).result, 'INVALID', 'a non-unique anchor is invalid, never KILLED');
	} finally { ws.dispose(); }
});

test('VERIFY-005: a declared EQUIVALENT mutant that the tests detect is a claim violation', () => {
	const m = { id: 'X', expected_result: 'EQUIVALENT' };
	assert.equal(mutationClaimMismatches([m], { X: { result: 'KILLED' } }).length, 1);
	assert.equal(mutationClaimMismatches([m], { X: { result: 'SURVIVED' } }).length, 0);
	const k = { id: 'Y', expected_result: 'KILLED' };
	assert.equal(mutationClaimMismatches([k], { Y: { result: 'KILLED_OTHER' } }).length, 1, 'declared KILLED but killed for another reason');
});

const def = loadDefinition(fileURLToPath(new URL('../security/crsf/', import.meta.url)), path.join(REPO, 'security/mutation/cases.json'));
const ctx = context(def);
const kbL3 = def.evidence.evidence.find((e) => e.id === 'EV-KB-L3');
const p2Cases = def.mutations.cases.filter((m) => m.evidence_id === 'EV-KB-L3' && m.targets.some((t) => t.control === 'CR-TELEGRAM-003' && t.property === 'P2'));

test('VERIFY-009: with every case KILLED the property is proven (control)', () => {
	const outcomes = declaredOutcomes(def);
	assert.equal(knownBadEffective(ctx, kbL3, 'CR-TELEGRAM-003', 'P2', outcomes).ok, true);
	assert.equal(evaluate(def, outcomes).controls.find((c) => c.id === 'CR-TELEGRAM-003').security_status, 'PASS_AUTOMATED');
});

for (const bad of ['SURVIVED', 'KILLED_OTHER', 'INVALID', 'NOT_RUN']) {
	test(`VERIFY-009: one ${bad} case invalidates the known-bad proof of the property even if others are KILLED`, () => {
		assert.ok(p2Cases.length >= 2, 'needs at least two cases for the property');
		const outcomes = declaredOutcomes(def);
		outcomes.mutations[p2Cases[0].id] = { result: bad };
		assert.equal(knownBadEffective(ctx, kbL3, 'CR-TELEGRAM-003', 'P2', outcomes).ok, false);
		assert.equal(evaluate(def, outcomes).controls.find((c) => c.id === 'CR-TELEGRAM-003').security_status, 'MISSING_EVIDENCE');
	});
}

test('VERIFY-009: EQUIVALENT cases alone never prove a property', () => {
	const outcomes = declaredOutcomes(def);
	const equivalentOnly = { ...def, mutations: { ...def.mutations, cases: def.mutations.cases.map((m) => (p2Cases.some((c) => c.id === m.id) ? { ...m, expected_result: 'EQUIVALENT' } : m)) } };
	for (const c of p2Cases) outcomes.mutations[c.id] = { result: 'SURVIVED' };
	const r = knownBadEffective(context(equivalentOnly), kbL3, 'CR-TELEGRAM-003', 'P2', outcomes);
	assert.equal(r.ok, false);
	assert.match(r.why, /only EQUIVALENT/);
});

test('VERIFY-009: a static-only kill never proves a property', () => {
	const outcomes = declaredOutcomes(def);
	const staticOnly = { ...def, mutations: { ...def.mutations, cases: def.mutations.cases.map((m) => (p2Cases.some((c) => c.id === m.id) ? { ...m, detection: 'static' } : m)) } };
	assert.equal(knownBadEffective(context(staticOnly), kbL3, 'CR-TELEGRAM-003', 'P2', outcomes).ok, false);
});
