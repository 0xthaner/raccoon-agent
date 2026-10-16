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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDefinition, loadSchemas, validateSchemas, checkIntegrity, checkPinnedSources, declaredOutcomes, derivationOf } from '../lib/engine.mjs';
import { runTests, classifyOutcomes, childEnv, detectCapabilities, createWorkspace, runMutation, mutationClaimMismatches } from '../lib/exec.mjs';
import { generate } from '../generator/crsf-gen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRSF = path.resolve(HERE, '..');
const REPO = path.resolve(CRSF, '../..');
const clone = (x) => structuredClone(x);
const ctl = (def, id) => def.controls.controls.find((c) => c.id === id);
const evi = (def, id) => def.evidence.evidence.find((e) => e.id === id);
const dev = (def, id) => def.deviations.deviations.find((d) => d.id === id);
const mut = (def, id) => def.mutations.cases.find((m) => m.id === id);
const VERSIONED = ['profile', 'controls', 'evidence', 'deviations', 'sources', 'asvs-applicability', 'drift-model'];
/** Bumps every definition file to a fresh version and opens a change entry for it (records added by the fixture). */
function bump(d, records = []) {
	for (const k of VERSIONED) d[k].crsf_version = '1.0-draft-phase2z';
	d['framework-changes'].versions.push({ crsf_version: '1.0-draft-phase2z', summary: 'fixture', changes: records });
	return d['framework-changes'].versions.at(-1);
}
/** The change record that declares finding F-2D-2 fixed (Phase 2E). */
const fixRecord = (d) => d['framework-changes'].versions.flatMap((v) => v.changes).find((c) => c.id === 'F-2D-2' && c.finding);
/** Removes every mutation case targeting `control` and keeps the known-bad evidence consistent (ids, covers). */
function dropMutationsFor(d, control) {
	d.mutations.cases = d.mutations.cases.filter((m) => !m.targets.some((t) => t.control === control));
	const live = new Set(d.mutations.cases.map((m) => m.id));
	for (const e of d.evidence.evidence.filter((x) => x.execution?.runner === 'mutation')) {
		e.execution.mutation_ids = e.execution.mutation_ids.filter((id) => live.has(id));
		e.covers = e.covers.filter((cv) => cv.control !== control);
		e.control_ids = [...new Set(e.covers.map((cv) => cv.control))].sort();
	}
	d.evidence.evidence = d.evidence.evidence.filter((e) => e.execution?.runner !== 'mutation' || e.execution.mutation_ids.length);
}
const fakeStructural = (d, control, property) => ({ ...clone(evi(d, 'EV-STRUCT-MAC-CMP')), id: 'EV-FAKE-STRUCT', covers: [{ control, properties: [property], scope: 'FULL', result: 'SUPPORTS', note: null }], control_ids: [control], coverage: 'PARTIAL', reason_for_partial: `${control}[${property}]: x` });

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
	['P', 'reproducible known-bad evidence without mutation cases', 'KNOWN_BAD_WITHOUT_MUTATION_RUNNER', /EV-FAKE-KB/, (d) => { d.evidence.evidence.push({ ...clone(evi(d, 'EV-SIWE')), id: 'EV-FAKE-KB', type: 'known-bad', level: 'E4', known_bad_checked: true, known_bad_result: 'KILLED' }); }],

	// Phase 2D - structural rule (CR-SESSION-001 P2/P3 only): the exception cannot spread.
	['U1', 'another E4 control property marked STRUCTURAL (not allowlisted)', 'STRUCTURAL_BASIS_NOT_ALLOWED', /CR-AUTH-001\.P1/, (d) => { ctl(d, 'CR-AUTH-001').properties[0].evidence_basis = 'STRUCTURAL'; }],
	['U2', 'allowlist widened to another control at the same version', 'PROFILE_CHANGED_WITHOUT_VERSION', null, (d) => { d.profile.structural_property_rule.allowed.push({ control: 'CR-AUTH-001', property: 'P1' }); ctl(d, 'CR-AUTH-001').properties[0].evidence_basis = 'STRUCTURAL'; }],
	['U3', 'structural evidence pointed at a non-allowlisted E4 property', 'STRUCTURAL_EVIDENCE_MISPLACED', /EV-FAKE-STRUCT/, (d) => { d.evidence.evidence.push(fakeStructural(d, 'CR-AUTH-001', 'P1')); }],
	['U4', 'structural evidence that admits client selection', 'STRUCTURAL_EVIDENCE_INCOMPLETE', /EV-STRUCT-MAC-CMP/, (d) => { evi(d, 'EV-STRUCT-MAC-CMP').structural.client_selectable = true; }],
	['U5', 'P2 left to invalid structural evidence only (mutation proof removed) keeps its recorded PASS', 'STATUS_NOT_RECOMPUTABLE', /CR-SESSION-001\.security_status/, (d) => {
		d.mutations.cases = d.mutations.cases.filter((m) => !m.targets.some((t) => t.control === 'CR-SESSION-001' && t.property === 'P2'));
		const kb = evi(d, 'EV-KB-TOKEN-MAC'); kb.execution.mutation_ids = kb.execution.mutation_ids.filter((id) => !id.includes('-P2-')); kb.covers[0].properties = ['P3'];
		evi(d, 'EV-STRUCT-MAC-CMP').structural.standard_library = false; }],
	// Phase 2D - requirement clarifications must be documented exactly and cannot be silent (CR-API-004 policy, CR-VERIFY-011).
	['V1', 'requirement reworded under a version bump, clarification record without before/after', 'REQUIREMENT_CHANGE_NOT_DOCUMENTED', /CR-API-002/, (d) => { ctl(d, 'CR-API-002').properties[0].text = 'cron endpoint checks something'; bump(d, [{ id: 'CR-API-002', kind: 'REQUIREMENT_CLARIFICATION', reason: 'x', rationale: 'r'.repeat(50), why_not_weakening: 'w'.repeat(50) }]); }],
	['V2', 'clarification record whose "before" wording was fabricated', 'REQUIREMENT_CHANGE_NOT_DOCUMENTED', /do not match/, (d) => { const c = ctl(d, 'CR-API-002'); const after = clone(c.properties); after[0].text = 'cron endpoint checks something'; c.properties = after; bump(d, [{ id: 'CR-API-002', kind: 'REQUIREMENT_CLARIFICATION', reason: 'x', rationale: 'r'.repeat(50), why_not_weakening: 'w'.repeat(50), before: { properties: [{ id: 'P1', kind: 'REQUIREMENT', text: 'invented' }] }, after: { properties: after } }]); }],
	['V3', 'requirement reworded at the same version', 'PROPERTIES_CHANGED_SILENTLY', /CR-API-002/, (d) => { ctl(d, 'CR-API-002').properties[0].text = 'cron endpoint checks something'; }],
	// Phase 2D - CR-VERIFY-011: derivation cannot be rewritten after results.
	['W1', 'expected_property narrowed after the result (same version)', 'DERIVATION_CHANGED_SILENTLY', /CR-INPUT-004/, (d) => { ctl(d, 'CR-INPUT-004').expected_property = 'nothing to check'; }],
	['W2', 'source requirement mapping removed (source_refs, same version)', 'DERIVATION_CHANGED_SILENTLY', /CR-RESOURCE-001/, (d) => { ctl(d, 'CR-RESOURCE-001').source_refs = ctl(d, 'CR-RESOURCE-001').source_refs.slice(0, 1); }],
	['W3', 'external requirement ids removed (same version)', 'DERIVATION_CHANGED_SILENTLY', /CR-RESOURCE-001/, (d) => { ctl(d, 'CR-RESOURCE-001').external_requirement_ids = ctl(d, 'CR-RESOURCE-001').external_requirement_ids.slice(0, 1); }],
	['W4', 'MISSING control declared NOT_APPLICABLE (same version)', 'APPLICABILITY_CHANGED_SILENTLY', /CR-INPUT-004/, (d) => { const c = ctl(d, 'CR-INPUT-004'); c.applicability = 'NOT_APPLICABLE'; c.applicability_reason = 'not needed'; }],
	['W5', 'MISSING control declared NOT_APPLICABLE with a version bump but no APPLICABILITY_CHANGE record', 'APPLICABILITY_CHANGE_NOT_DECLARED', /CR-INPUT-004/, (d) => { const c = ctl(d, 'CR-INPUT-004'); const before = derivationOf(c); c.applicability = 'NOT_APPLICABLE'; c.applicability_reason = 'not needed'; bump(d, [{ id: 'CR-INPUT-004', kind: 'REQUIREMENT_CLARIFICATION', reason: 'x', rationale: 'r'.repeat(50), why_not_weakening: 'w'.repeat(50), before: { derivation: before }, after: { derivation: derivationOf(c) } }]); }],
	['W6', 'release-blocking control reclassified to make the assertion pass (same version)', 'RELEASE_CLASS_CHANGED_SILENTLY', /CR-INPUT-004/, (d) => { ctl(d, 'CR-INPUT-004').release_class = 'SECURITY_DEBT'; }],
	['W7', 'minimum evidence lowered for a MISSING control (same version)', 'THRESHOLD_REDUCED_SILENTLY', /CR-RESOURCE-001/, (d) => { ctl(d, 'CR-RESOURCE-001').minimum_evidence_level = 'E1'; }],
	['W8', 'property narrowed with a version bump but no change record', 'CHANGE_NOT_RECORDED', /CR-RESOURCE-001/, (d) => { ctl(d, 'CR-RESOURCE-001').properties[3].text = 'positions limited'; bump(d); }],
	['W9', 'vendored pinned requirement file checksum does not match', 'VENDORED_CHECKSUM', null, (d) => { d.sources.vendored[0].sha256 = '0'.repeat(64); }],
	['W10', 'pinned ASVS requirement dropped from the applicability list', 'ASVS_COUNT_MISMATCH', null, (d) => { d['asvs-applicability'].items.pop(); }],
	// Phase 2D - CR-VERIFY-003 / CR-VERIFY-004: E4 needs a KILLED mutation, E5 needs real infrastructure.
	['X1', 'E4 control keeps PASS with its behavioural test but every mutation case removed', 'STATUS_NOT_RECOMPUTABLE', /CR-TELEGRAM-001\.security_status/, (d) => { dropMutationsFor(d, 'CR-TELEGRAM-001'); }],
	['X2', 'behavioural test relabelled E4 to replace the removed mutation proof', 'LEVEL_EXCEEDS_TYPE', /EV-FAKE-E4/, (d) => { dropMutationsFor(d, 'CR-TELEGRAM-001'); d.evidence.evidence.push({ ...clone(evi(d, 'EV-SIWE')), id: 'EV-FAKE-E4', level: 'E4', covers: [{ control: 'CR-TELEGRAM-001', properties: ctl(d, 'CR-TELEGRAM-001').properties.map((p) => p.id), scope: 'FULL', result: 'SUPPORTS', note: null }], control_ids: ['CR-TELEGRAM-001'], coverage: 'FULL', reason_for_partial: null }); }],
	// Phase 2E - a finding cannot be declared FIXED: the record must point at behavioural KILLED proof and no VIOLATION may remain.
	['Y1', 'finding marked FIXED citing a mutation case that does not exist', 'FINDING_FIX_NOT_PROVEN', /F-2D-2/, (d) => { fixRecord(d).finding.mutation_ids = ['MUT-DOES-NOT-EXIST']; }],
	['Y2', 'finding marked FIXED citing a KILLED mutation of an unrelated control', 'FINDING_FIX_NOT_PROVEN', /F-2D-2/, (d) => { fixRecord(d).finding.mutation_ids = ['MUT-CR-SESSION-001-P2-NEW1']; }],
	['Y3', 'finding marked FIXED while its VIOLATION evidence is still recorded', 'FINDING_FIX_NOT_PROVEN', /F-2D-2/, (d) => { evi(d, 'EV-PROBE-GETCODE').covers[0].result = 'VIOLATION'; }],
	['Y4', 'finding marked FIXED whose mutation is downgraded to an expected SURVIVED gap', 'FINDING_FIX_NOT_PROVEN', /F-2D-2/, (d) => { for (const id of fixRecord(d).finding.mutation_ids) Object.assign(mut(d, id), { expected_result: 'SURVIVED', expected_failures: [] }); }],
	['T2', 'sequential node test relabelled type real-system (fake real concurrency, E5 within the cap)', 'REAL_SYSTEM_WITHOUT_INFRASTRUCTURE', /EV-FAKE-REAL/, (d) => { d.evidence.evidence.push({ ...clone(evi(d, 'EV-L3')), id: 'EV-FAKE-REAL', type: 'real-system', level: 'E5', covers: [{ control: 'CR-CONC-001', properties: ['P1'], scope: 'FULL', result: 'SUPPORTS', note: 'claims real concurrency' }], control_ids: ['CR-CONC-001'], coverage: 'PARTIAL', reason_for_partial: 'CR-CONC-001[P1]: x' }); }]
];

function definitionErrors(def, schemas) {
	const schemaErrors = validateSchemas(def, schemas);
	return [...schemaErrors, ...checkIntegrity(def, declaredOutcomes(def)).errors, ...checkPinnedSources(def, (file) => readFileSync(path.join(REPO, file)))];
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
