#!/usr/bin/env node
/*
	CRSF framework self-tests (npm run security:framework-test).

	The verifier is only trustworthy if it rejects known-bad definitions. Every
	fixture below derives a deliberately broken variant of the REAL definition
	(or runs a deliberately broken test/mutation fixture) and states which
	rejection code must appear. The self-test passes only if:
	  - the unmodified definition validates with zero errors,
	  - every invalid fixture is rejected with its expected code,
	  - generation is deterministic.

	Fixture test files live in ./fixtures and are named so that the default
	`node --test` discovery never runs them as part of the repository suite.
*/
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDefinition, loadSchemas, validateSchemas, checkIntegrity, declaredOutcomes } from '../lib/engine.mjs';
import { runTests, classifyOutcomes, childEnv, detectCapabilities, createWorkspace, runMutation, mutationClaimMismatches } from '../lib/exec.mjs';
import { generate } from '../generator/crsf-gen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRSF = path.resolve(HERE, '..');
const REPO = path.resolve(CRSF, '../..');
const clone = (x) => structuredClone(x);
const ctl = (def, id) => def.controls.controls.find((c) => c.id === id);
const evi = (def, id) => def.evidence.evidence.find((e) => e.id === id);
const dev = (def, id) => def.deviations.deviations.find((d) => d.id === id);

/** Definition fixtures: [id, description, expected code, optional detail regex, mutate(def)] */
export const DEFINITION_FIXTURES = [
	['A', 'PASS with missing evidence (evidence removed, recorded PASS kept)', 'STATUS_NOT_RECOMPUTABLE', /CR-DOC-001\.security_status/, (d) => { const e = evi(d, 'EV-NEXUS'); e.covers = e.covers.filter((c) => c.control !== 'CR-DOC-001'); e.control_ids = [...new Set(e.covers.map((c) => c.control))].sort(); }],
	['B', 'unknown control reference', 'UNKNOWN_CONTROL_REFERENCE', /CR-AUTH-999/, (d) => { evi(d, 'EV-SIWE').covers.push({ control: 'CR-AUTH-999', properties: ['P1'], scope: 'FULL', result: 'SUPPORTS', note: null }); }],
	['C', 'unknown evidence reference', 'UNKNOWN_EVIDENCE_REFERENCE', /EV-DOES-NOT-EXIST/, (d) => { dev(d, 'DEV-PROTO-001').evidence_ids.push('EV-DOES-NOT-EXIST'); }],
	['C2', 'unknown source reference', 'UNKNOWN_SOURCE', /SRC-NOT-PINNED/, (d) => { ctl(d, 'CR-AUTH-001').source_refs.push('SRC-NOT-PINNED §1'); }],
	['D', 'duplicate control ID', 'DUPLICATE_CONTROL', /CR-AUTH-001/, (d) => { d.controls.controls.push(clone(ctl(d, 'CR-AUTH-001'))); }],
	['E', 'partial evidence falsely labelled FULL', 'COVERAGE_MISLABELED', /EV-RL/, (d) => { evi(d, 'EV-RL').coverage = 'FULL'; }],
	['E2', 'PARTIAL cover without reason', 'PARTIAL_WITHOUT_REASON', /EV-RL/, (d) => { for (const c of evi(d, 'EV-RL').covers) c.note = null; }],
	['F', 'release-blocking minimum threshold reduced silently (E4 -> E3, same version)', 'THRESHOLD_REDUCED_SILENTLY', /CR-AUTH-001/, (d) => { ctl(d, 'CR-AUTH-001').minimum_evidence_level = 'E3'; }],
	['F2', 'release class changed silently (RELEASE_BLOCKING -> SECURITY_DEBT, same version)', 'RELEASE_CLASS_CHANGED_SILENTLY', /CR-AUTH-002/, (d) => { ctl(d, 'CR-AUTH-002').release_class = 'SECURITY_DEBT'; }],
	['F3', 'threshold reduced with a version bump but no change record', 'VERSION_WITHOUT_CHANGE_RECORD', /phase2z/, (d) => { for (const k of ['profile', 'controls', 'evidence', 'deviations', 'sources', 'asvs-applicability', 'drift-model']) d[k].crsf_version = '1.0-draft-phase2z'; ctl(d, 'CR-AUTH-001').minimum_evidence_level = 'E3'; }],
	['F4', 'control deleted silently', 'CONTROL_DELETED_SILENTLY', /CR-INPUT-013/, (d) => { d.controls.controls = d.controls.controls.filter((c) => c.id !== 'CR-INPUT-013'); }],
	['G', 'deviation with unpinned protocol source', 'DEVIATION_STATUS_NOT_RECOMPUTABLE', /not pinned/, (d) => { dev(d, 'DEV-PROTO-001').required_protocol_source = ['SRC-BLOGPOST ethereum crypto']; }],
	['H', 'deviation hiding an implementation FAIL', 'DEVIATION_STATUS_NOT_RECOMPUTABLE', /would hide/, (d) => { dev(d, 'DEV-PROTO-001').independent_defect_check_controls.push('CR-CONFIG-003'); }],
	['H2', 'deviation APPROVED without a sign-off record', 'DEVIATION_STATUS_NOT_RECOMPUTABLE', /sign-off record/, (d) => { dev(d, 'DEV-PROTO-002').owner_signoff = 'APPROVED'; }],
	['I', 'manual status override flag', 'MANUAL_OVERRIDE', /CR-SESSION-004/, (d) => { ctl(d, 'CR-SESSION-004').manual_override_allowed = true; }],
	['I2', 'extra hand-written override field', 'SCHEMA', /unknown property "status_override"/, (d) => { ctl(d, 'CR-SESSION-004').status_override = 'PASS_AUTOMATED'; }],
	['J', 'applicable ASVS requirement unmapped', 'APPLICABLE_UNMAPPED', /V1\.3\.7/, (d) => { ctl(d, 'CR-INPUT-013').external_requirement_ids = []; }],
	// Picks a release-blocking control that is currently MISSING_EVIDENCE, so the fixture never goes stale when evidence closes a control.
	['N', 'control status changed without evidence change', 'STATUS_NOT_RECOMPUTABLE', /^CR-[A-Z]+-\d{3}\.security_status: recorded "PASS_AUTOMATED"/, (d) => { const target = d.controls.controls.find((c) => c.release_class === 'RELEASE_BLOCKING' && c.security_status === 'MISSING_EVIDENCE'); if (!target) throw new Error('no MISSING_EVIDENCE control left for fixture N'); target.security_status = 'PASS_AUTOMATED'; }],
	['N2', 'deviation reported as PASS', 'STATUS_NOT_RECOMPUTABLE', /CR-CRYPTO-008\.security_status/, (d) => { ctl(d, 'CR-CRYPTO-008').security_status = 'PASS_MANUAL'; }],
	['O', 'mutation evidence covering a property no case targets', 'MUTATION_COVERS_MISMATCH', /EV-KB-L3/, (d) => { evi(d, 'EV-KB-L3').covers.push({ control: 'CR-AUTH-001', properties: ['P4'], scope: 'FULL', result: 'SUPPORTS', note: 'x' }); }],
	['Q', 'EQUIVALENT mutant without a written proof', 'EQUIVALENT_WITHOUT_PROOF', /MUT-CR-AUTH-007-P2-NEW1/, (d) => { delete d.mutations.cases.find((m) => m.id === 'MUT-CR-AUTH-007-P2-NEW1').equivalence; }],
	['Q2', 'EQUIVALENT proof too thin to review', 'SCHEMA', /equivalence\.proof: shorter than 80/, (d) => { d.mutations.cases.find((m) => m.id === 'MUT-CR-AUTH-007-P2-NEW1').equivalence.proof = 'trust me'; }],
	['Q3', 'KILLED cases relabelled EQUIVALENT to dodge a gap (recorded PASS no longer recomputes)', 'STATUS_NOT_RECOMPUTABLE', /CR-TELEGRAM-003\.security_status/, (d) => { for (const m of d.mutations.cases.filter((x) => x.targets.some((t) => t.control === 'CR-TELEGRAM-003' && t.property === 'P2'))) { m.expected_result = 'EQUIVALENT'; m.expected_failures = []; m.equivalence = { kind: 'REDUNDANT_LAYER', proof: 'x'.repeat(90) }; } }],
	['S', 'MULTI_LAYER mutation without a rationale', 'MULTI_LAYER_WITHOUT_RATIONALE', /MUT-CR-AUTH-004-P1-NEW1/, (d) => { delete d.mutations.cases.find((m) => m.id === 'MUT-CR-AUTH-004-P1-NEW1').layering_rationale; }],
	['S2', 'MULTI_LAYER label on a single-edit mutation', 'MULTI_LAYER_WITHOUT_RATIONALE', /MUT-CR-AUTH-001-P3-NEW1/, (d) => { const m = d.mutations.cases.find((x) => x.id === 'MUT-CR-AUTH-001-P3-NEW1'); m.layering = 'MULTI_LAYER'; m.layering_rationale = 'pretending one removed check is a multi-layer defect here'; }],
	['T', 'sequential behavioural test declared as E5 real-system concurrency evidence', 'LEVEL_EXCEEDS_TYPE', /EV-FAKE-CONCURRENCY/, (d) => { d.evidence.evidence.push({ ...clone(evi(d, 'EV-L3')), id: 'EV-FAKE-CONCURRENCY', level: 'E5', covers: [{ control: 'CR-CONC-001', properties: ['P1'], scope: 'FULL', result: 'SUPPORTS', note: null }], control_ids: ['CR-CONC-001'], coverage: 'PARTIAL', reason_for_partial: 'CR-CONC-001[P1]: x' }); }],
	['P', 'reproducible known-bad evidence without mutation cases', 'KNOWN_BAD_WITHOUT_MUTATION_RUNNER', /EV-FAKE-KB/, (d) => { d.evidence.evidence.push({ ...clone(evi(d, 'EV-SIWE')), id: 'EV-FAKE-KB', type: 'known-bad', level: 'E4', known_bad_checked: true, known_bad_result: 'KILLED' }); }]
];

function definitionErrors(def, schemas) {
	return [...validateSchemas(def, schemas), ...checkIntegrity(def, declaredOutcomes(def)).errors];
}

function runDefinitionFixtures(base, schemas) {
	return DEFINITION_FIXTURES.map(([id, description, code, detail, mutate]) => {
		const d = clone(base);
		mutate(d);
		let errors;
		try { errors = definitionErrors(d, schemas); } catch (e) { errors = [{ code: 'EXCEPTION', detail: e.message }]; }
		const hit = errors.some((e) => e.code === code && (!detail || detail.test(e.detail)));
		return { id, description, expected: code, rejected: hit, codes: [...new Set(errors.map((e) => e.code))].sort() };
	});
}

/** K/L/K2: execution fixtures - the executor must flag unexpected skips, cancellations and todos. */
function runExecutionFixtures() {
	const env = childEnv(detectCapabilities());
	const cases = [
		['K', 'unexpected skipped test', 'security/crsf/selftest/fixtures/skip-fixture.mjs', 'unexpected_skips'],
		['L', 'unexpected cancelled test', 'security/crsf/selftest/fixtures/cancel-fixture.mjs', 'cancelled'],
		['K2', 'unexpected todo test', 'security/crsf/selftest/fixtures/todo-fixture.mjs', 'todo']
	];
	return cases.map(([id, description, file, field]) => {
		const run = runTests([file], { cwd: REPO, env, timeoutMs: 60_000 });
		const c = classifyOutcomes(run.results, env);
		return { id, description, expected: field, rejected: run.ok && c[field].length > 0, codes: [`${field}=${c[field].length}`] };
	});
}

/** M: a mutation declared KILLED whose mapped test still passes must be reported as a claim mismatch. */
function runMutationFixture() {
	const env = childEnv(detectCapabilities());
	const fake = {
		id: 'MUT-CR-VERIFY-009-P1-FIXTURE', expected_result: 'KILLED', detection: 'behavioral', timeout_ms: 60_000,
		edits: [{ file: 'security/crsf/selftest/fixtures/mut-target.mjs', find: 'return 1;', replace: 'return 2;' }],
		tests: ['security/crsf/selftest/fixtures/mut-weak-check.mjs'], expected_failures: [{ test: '.*' }]
	};
	let ws;
	try { ws = createWorkspace(REPO); } catch (error) {
		return { id: 'M', description: 'mutation marked KILLED although the mapped test still passes', expected: 'MUTATION_CLAIM_MISMATCH', rejected: false, codes: [`workspace error: ${error.code ?? error.message}`] };
	}
	let result;
	try { result = runMutation(fake, ws, env, 60_000); } finally { ws.dispose(); }
	const mismatches = mutationClaimMismatches([fake], { [fake.id]: result });
	return { id: 'M', description: 'mutation marked KILLED although the mapped test still passes', expected: 'MUTATION_CLAIM_MISMATCH', rejected: result.result === 'SURVIVED' && mismatches.length === 1, codes: [`observed=${result.result}`] };
}

/** R: a mutation declared EQUIVALENT that the mapped test actually kills must be reported as a claim violation. */
function runEquivalentClaimFixture() {
	const env = childEnv(detectCapabilities());
	const fake = { id: 'MUT-CR-VERIFY-009-P1-EQFIXTURE', expected_result: 'EQUIVALENT', detection: 'behavioral', timeout_ms: 60_000, edits: [{ file: 'security/crsf/selftest/fixtures/mut-target.mjs', find: 'return 1;', replace: 'return 2;' }], tests: ['security/crsf/selftest/fixtures/mut-strict-check.mjs'], expected_failures: [] };
	let ws;
	try { ws = createWorkspace(REPO); } catch (error) { return { id: 'R', description: 'declared EQUIVALENT mutant that the tests kill', expected: 'MUTATION_CLAIM_MISMATCH', rejected: false, codes: [`workspace error: ${error.code ?? error.message}`] }; }
	let result;
	try { result = runMutation(fake, ws, env, 60_000); } finally { ws.dispose(); }
	const mismatches = mutationClaimMismatches([fake], { [fake.id]: result });
	return { id: 'R', description: 'declared EQUIVALENT mutant that the tests kill', expected: 'MUTATION_CLAIM_MISMATCH', rejected: result.result !== 'SURVIVED' && mismatches.length === 1, codes: [`observed=${result.result}`] };
}

function runGeneratorDeterminism(base) {
	const a = JSON.stringify(generate(clone(base))), b = JSON.stringify(generate(clone(base)));
	return { id: 'GEN', description: 'generator output is deterministic', expected: 'identical', rejected: a === b, codes: [a === b ? 'identical' : 'different'] };
}

export function runSelfTests() {
	const base = loadDefinition(CRSF, path.resolve(CRSF, '../mutation/cases.json'));
	const schemas = loadSchemas(path.join(CRSF, 'schema'));
	const baseline = definitionErrors(base, schemas);
	const fixtures = [...runDefinitionFixtures(base, schemas), ...runExecutionFixtures(), runMutationFixture(), runEquivalentClaimFixture(), runGeneratorDeterminism(base)];
	const passed = baseline.length === 0 && fixtures.every((f) => f.rejected);
	return { passed, baseline_errors: baseline, fixtures, total: fixtures.length, rejected: fixtures.filter((f) => f.rejected).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const r = runSelfTests();
	if (r.baseline_errors.length) console.error(`baseline definition invalid:\n${r.baseline_errors.map((e) => `  ${e.code} ${e.detail}`).join('\n')}`);
	for (const f of r.fixtures) console.log(`${f.rejected ? 'ok  ' : 'FAIL'} ${f.id.padEnd(4)} ${f.description} -> expected ${f.expected}; got ${f.codes.join(', ')}`);
	console.log(`\nCRSF framework self-test: ${r.rejected}/${r.total} invalid fixtures rejected; baseline errors ${r.baseline_errors.length} -> ${r.passed ? 'PASS' : 'FAIL'}`);
	process.exitCode = r.passed ? 0 : 1;
}
