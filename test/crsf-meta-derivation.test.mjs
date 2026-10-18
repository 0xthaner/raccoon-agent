/**
 * CRSF Phase 2W - CR-VERIFY-004 P1 as a meta-derived property.
 *
 * "each concurrency control has a real-Postgres test" is computed from the
 * evidence graph (profile.meta_control_derivation, rule
 * OBSERVED_CONCURRENCY_COVERAGE), never from an evidence item of its own. It
 * holds only if EVERY canonical concurrency property (profile marking plus
 * classifier, without meta properties) is satisfied by its control, has
 * real-system evidence at >= E5 that passed in this run with its capabilities and
 * runner-observed Postgres use and overlap, has every mutation case ended as
 * declared, and carries no violation or open finding.
 *
 * The outcomes below are built from the real definition. The receipts are
 * synthetic: their authenticity (runner key, nonce, real upstream) is proven in
 * test/crsf-real-system-observation.test.mjs; here only the derivation is tested.
 * CR-CONC-006 (minimum E3) stays PASS through its known-bad evidence when its
 * real-system item is not genuinely observed - so these cases isolate the meta
 * rule's own checks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadDefinition, loadSchemas, checkIntegrity, declaredOutcomes, evaluate, isExecutable, canonicalConcurrencyProperties } from '../security/crsf/lib/engine.mjs';
import { allReleaseControlsSatisfied, runDefinitionFixtures, runFindingFixtures } from '../security/crsf/selftest/framework-selftest.mjs';

const CRSF = path.resolve('security/crsf');
const definition = () => loadDefinition(CRSF, path.resolve('security/mutation/cases.json'));
const GENUINE = { connections_total: 4, databases: { crsf_db: { authenticated: 4, completed: 40, max_busy: 4, overlap_events: 12 } } };
const SEQUENTIAL = { connections_total: 2, databases: { crsf_db: { authenticated: 2, completed: 20, max_busy: 1, overlap_events: 0 } } };
// connections authenticated and busy at the same time, but the server never completed a statement
const NO_USE = { connections_total: 2, databases: { crsf_db: { authenticated: 2, completed: 0, max_busy: 2, overlap_events: 4 } } };

/** A full-environment run in which everything ran and was observed as declared. */
function genuineRun(def) {
	const evidence = {}, observations = {}, mutations = {};
	for (const e of def.evidence.evidence) evidence[e.id] = !isExecutable(e) ? 'STATIC' : e.execution.runner === 'mutation' ? 'EXECUTED' : 'PASS';
	for (const e of def.evidence.evidence.filter((x) => x.type === 'real-system')) observations[e.id] = { upstream_kind: 'postgres', receipt: GENUINE };
	for (const m of def.mutations.cases) mutations[m.id] = { result: m.expected_result === 'EQUIVALENT' ? 'SURVIVED' : m.expected_result };
	return { mode: 'OBSERVED', evidence, mutations, observations, capabilities: { node: { available: true }, postgres: { available: true } } };
}
const control = (def, out, id) => evaluate(def, out).controls.find((c) => c.id === id);
const verify004 = (def, out) => control(def, out, 'CR-VERIFY-004');
const failing = (c) => c.property_coverage.P1.derived?.failing ?? [];
const notPass = (c, re, what) => {
	assert.equal(c.security_status, 'MISSING_EVIDENCE', `${what}: CR-VERIFY-004 must not pass`);
	assert.equal(c.property_coverage.P1.derived?.ok, false);
	assert.ok(failing(c).some((f) => re.test(f)), `${what}: expected a failing entry matching ${re}, got ${JSON.stringify(failing(c))}`);
};
const firstCase = (def, control, property) => def.mutations.cases.find((m) => m.expected_result === 'KILLED' && m.targets.some((t) => t.control === control && t.property === property));

test('META canonical set: every marked or classified concurrency property, without the meta property itself', () => {
	const def = definition();
	const canonical = canonicalConcurrencyProperties(def);
	const marked = def.profile.real_system_observation.concurrency.properties.map((x) => `${x.control}.${x.property}`);
	assert.ok(!canonical.includes('CR-VERIFY-004.P1'), 'the meta property is not its own input');
	assert.deepEqual(canonical, marked.filter((k) => k !== 'CR-VERIFY-004.P1').sort());
	for (const id of ['CR-CONC-001', 'CR-CONC-002', 'CR-CONC-003', 'CR-CONC-004', 'CR-CONC-005', 'CR-CONC-006', 'CR-RESOURCE-002']) assert.ok(canonical.some((k) => k.startsWith(`${id}.`)), id);
});

test('META M9 every concurrency property genuinely satisfied and observed: CR-VERIFY-004 PASS_AUTOMATED, derived at E5', () => {
	const def = definition();
	const c = verify004(def, genuineRun(def));
	assert.equal(c.security_status, 'PASS_AUTOMATED', JSON.stringify(c.property_coverage.P1));
	assert.deepEqual(c.property_coverage.P1.satisfied_by, [], 'no evidence item is credited directly');
	assert.deepEqual({ ...c.property_coverage.P1.derived }, { rule: 'OBSERVED_CONCURRENCY_COVERAGE', ok: true, level: 'E5', properties: canonicalConcurrencyProperties(def).length, failing: [] });
});

test('META M1 one concurrency property without evidence: not PASS', () => {
	const def = definition();
	const out = genuineRun(def);
	def.evidence.evidence = def.evidence.evidence.filter((e) => e.id !== 'EV-RL-DB');
	notPass(verify004(def, out), /^CR-RESOURCE-002\.P1: .*no real-system evidence at >= E5/, 'CR-RESOURCE-002 without EV-RL-DB');
});

test('META M2 the postgres capability is missing in this run: not PASS', () => {
	const def = definition();
	const out = genuineRun(def);
	out.capabilities.postgres.available = false;
	notPass(verify004(def, out), /capability postgres missing in this run/, 'postgres unavailable');
	const none = genuineRun(def); delete none.capabilities;
	notPass(verify004(def, none), /capability postgres missing in this run/, 'no capabilities reported');
});

test('META M3 Postgres use observed but no overlap: not PASS, while the E3 control itself still passes', () => {
	const def = definition();
	const out = genuineRun(def);
	out.observations['EV-LOCKS-DB'] = { upstream_kind: 'postgres', receipt: SEQUENTIAL };
	assert.equal(control(def, out, 'CR-CONC-006').security_status, 'PASS_AUTOMATED', 'CR-CONC-006 (E3) still passes through its known-bad evidence');
	notPass(verify004(def, out), /^CR-CONC-006\.P1: EV-LOCKS-DB runner observed no concurrent execution$/, 'sequential receipt');
});

test('META M3b overlapping connections without any completed statement: no Postgres use, not PASS', () => {
	const def = definition();
	const out = genuineRun(def);
	out.observations['EV-LOCKS-DB'] = { upstream_kind: 'postgres', receipt: NO_USE };
	assert.equal(control(def, out, 'CR-CONC-006').security_status, 'PASS_AUTOMATED');
	notPass(verify004(def, out), /^CR-CONC-006\.P1: EV-LOCKS-DB runner observed no Postgres use$/, 'no completed statement');
});

test('META M4 one required mutation NOT_RUN: not PASS', () => {
	const def = definition();
	const out = genuineRun(def);
	const m = firstCase(def, 'CR-CONC-001', 'P1');
	out.mutations[m.id] = { result: 'NOT_RUN' };
	assert.equal(control(def, out, 'CR-CONC-001').security_status, 'PASS_AUTOMATED', 'the E5 control itself passes on its real-system evidence');
	notPass(verify004(def, out), new RegExp(`^CR-CONC-001\\.P1: mutation ${m.id}=NOT_RUN$`), 'mutation NOT_RUN');
	delete out.mutations[m.id];
	notPass(verify004(def, out), new RegExp(`mutation ${m.id}=NOT_RUN`), 'mutation missing from the run');
});

test('META M5 one required mutation SURVIVED, KILLED_OTHER or INVALID: not PASS', () => {
	const def = definition();
	const m = firstCase(def, 'CR-RESOURCE-002', 'P1');
	for (const result of ['SURVIVED', 'KILLED_OTHER', 'INVALID']) {
		const out = genuineRun(def);
		out.mutations[m.id] = { result };
		notPass(verify004(def, out), new RegExp(`mutation ${m.id}=${result}`), result);
	}
	const gap = definition();
	Object.assign(gap.mutations.cases.find((x) => x.id === m.id), { expected_result: 'SURVIVED', expected_failures: [] });
	const out = genuineRun(gap);
	notPass(verify004(gap, out), new RegExp(`mutation ${m.id}=SURVIVED`), 'a declared SURVIVED gap');
});

test('META M6 open VIOLATION on a concurrency control: not PASS', () => {
	const def = definition();
	const out = genuineRun(def);
	def.evidence.evidence.find((e) => e.id === 'EV-M1-DB').covers.push({ control: 'CR-CONC-002', properties: ['P1'], scope: 'FULL', result: 'VIOLATION', note: 'fixture: race reproduced' });
	assert.equal(control(def, out, 'CR-CONC-002').security_status, 'FAIL');
	notPass(verify004(def, out), /^CR-CONC-002\.P1: control FAIL; VIOLATION recorded/, 'violation');
	const finding = definition();
	finding['framework-changes'].versions.at(-1).changes.push({ id: 'F-META-1', kind: 'NEW_FINDING', finding_class: 'APPLICATION', reason: 'fixture', mapping: { control: 'CR-CONC-005', property: 'P1', rationale: 'fixture mapping for the meta rule test' } });
	notPass(verify004(finding, genuineRun(finding)), /^CR-CONC-005\.P1: .*open finding F-META-1/, 'open finding');
});

test('META M7 a new concurrency property joins the canonical set automatically; unmarked it is a framework error', () => {
	const def = definition();
	const added = { ...structuredClone(def.controls.controls.find((c) => c.id === 'CR-CONC-005')), id: 'CR-CONC-007', title: 'fixture: new concurrency control', properties: [{ id: 'P1', kind: 'SECURITY', text: 'fixture: a new race-free operation' }] };
	def.controls.controls.push(added);
	def.profile.real_system_observation.concurrency.properties.push({ control: 'CR-CONC-007', property: 'P1' });
	assert.ok(canonicalConcurrencyProperties(def).includes('CR-CONC-007.P1'));
	notPass(verify004(def, genuineRun(def)), /^CR-CONC-007\.P1: control MISSING_EVIDENCE; no real-system evidence at >= E5/, 'new marked property without evidence');
	const unmarked = definition();
	unmarked.controls.controls.push(structuredClone(added));
	assert.ok(canonicalConcurrencyProperties(unmarked).includes('CR-CONC-007.P1'), 'the classifier includes it even unmarked');
	assert.ok(checkIntegrity(unmarked, declaredOutcomes(unmarked)).errors.some((e) => e.code === 'CONCURRENCY_CLAIM_UNMARKED' && /CR-CONC-007\.P1/.test(e.detail)));
	notPass(verify004(unmarked, genuineRun(unmarked)), /^CR-CONC-007\.P1: /, 'new unmarked property');
});

test('META M8 declared E5 metadata without a runner observation: not PASS', () => {
	const def = definition();
	const out = genuineRun(def);
	delete out.observations['EV-LOCKS-DB'];
	assert.equal(control(def, out, 'CR-CONC-006').security_status, 'PASS_AUTOMATED');
	notPass(verify004(def, out), /^CR-CONC-006\.P1: EV-LOCKS-DB not observed by the runner against the real postgres$/, 'no observation');
	const fake = genuineRun(def);
	fake.observations['EV-LOCKS-DB'] = { upstream_kind: 'selftest-fake', receipt: GENUINE };
	notPass(verify004(def, fake), /EV-LOCKS-DB not observed by the runner against the real postgres/, 'fake upstream');
	const failed = genuineRun(def);
	failed.evidence['EV-LOCKS-DB'] = 'FAIL';
	notPass(verify004(def, failed), /EV-LOCKS-DB did not pass in this run \(FAIL\)/, 'failed run');
	// only DECLARED mode (generator, recorded statuses) takes the claims as recorded
	assert.equal(verify004(def, declaredOutcomes(def)).security_status, 'PASS_AUTOMATED');
	assert.equal(verify004(def, { ...genuineRun(def), observations: {} }).security_status, 'MISSING_EVIDENCE');
});

test('META M10 reduced environment without Postgres: MISSING_EVIDENCE, never PASS', () => {
	const def = definition();
	const out = genuineRun(def);
	out.capabilities.postgres.available = false;
	out.observations = {};
	for (const e of def.evidence.evidence.filter((x) => x.execution?.environment?.includes('postgres') && x.execution.runner !== 'mutation')) out.evidence[e.id] = 'NOT_RUN';
	for (const m of def.mutations.cases.filter((x) => x.environment.includes('postgres'))) out.mutations[m.id] = { result: 'NOT_RUN' };
	const c = verify004(def, out);
	notPass(c, /capability postgres missing in this run/, 'reduced environment');
	assert.equal(failing(c).length, canonicalConcurrencyProperties(def).length, 'every concurrency property is reported, none passes');
});

test('META the rule\'s own known-bad cases must have been killed in this run', () => {
	const def = definition();
	const own = def.mutations.cases.filter((m) => m.targets.some((t) => t.control === 'CR-VERIFY-004' && t.property === 'P1'));
	assert.ok(own.length >= 6, 'six rule mutations');
	const out = genuineRun(def);
	out.mutations[own[0].id] = { result: 'NOT_RUN' };
	notPass(verify004(def, out), new RegExp(`^rule mutation ${own[0].id}=NOT_RUN$`), 'own mutation not run');
});

test('META direct real-system evidence for the meta property is a framework error and never counted', () => {
	const def = definition();
	const template = def.evidence.evidence.find((e) => e.id === 'EV-RL-DB');
	def.evidence.evidence.push({ ...structuredClone(template), id: 'EV-RELABEL-004', covers: [{ control: 'CR-VERIFY-004', properties: ['P1'], scope: 'FULL', result: 'SUPPORTS', note: 'relabelled application test' }], control_ids: ['CR-VERIFY-004'] });
	assert.ok(checkIntegrity(def, declaredOutcomes(def)).errors.some((e) => e.code === 'META_PROPERTY_DIRECT_EVIDENCE' && /EV-RELABEL-004/.test(e.detail)));
	const out = genuineRun(def);
	out.mutations[firstCase(def, 'CR-CONC-002', 'P1').id] = { result: 'NOT_RUN' };
	const c = verify004(def, out);
	assert.equal(c.security_status, 'MISSING_EVIDENCE', 'a relabelled item cannot stand in for the derivation');
	assert.ok(c.property_coverage.P1.insufficient.some((x) => x.startsWith('EV-RELABEL-004') && x.includes('not counted for a meta-derived property')));
});

test('META the meta control keeps a real-system minimum: lowering it is a framework error', () => {
	const def = definition();
	def.controls.controls.find((c) => c.id === 'CR-VERIFY-004').minimum_evidence_level = 'E3';
	const codes = checkIntegrity(def, declaredOutcomes(def)).errors.map((e) => e.code);
	assert.ok(codes.includes('META_RULE_NOT_REAL_SYSTEM'));
	assert.ok(codes.includes('THRESHOLD_REDUCED_SILENTLY'));
});

test('META the definition as recorded is valid', () => {
	const def = definition();
	const schemas = loadSchemas(path.join(CRSF, 'schema'));
	assert.deepEqual(checkIntegrity(def, declaredOutcomes(def)).errors, []);
	assert.ok(schemas.profile.properties.meta_control_derivation, 'profile schema knows the meta rule');
});

test('META all-closed state: every definition and findings fixture is still rejected (no fixture needs an open control, F-2W-1)', () => {
	const schemas = loadSchemas(path.join(CRSF, 'schema'));
	const d = allReleaseControlsSatisfied(definition());
	assert.ok(d.controls.controls.filter((c) => c.release_class === 'RELEASE_BLOCKING').every((c) => c.security_status === 'PASS_AUTOMATED'), 'every release-blocking control satisfied');
	const missed = [...runDefinitionFixtures(d, schemas), ...runFindingFixtures(d, schemas)].filter((f) => !f.rejected).map((f) => f.id);
	assert.deepEqual(missed, [], 'fixtures not rejected in the all-closed state');
});
