#!/usr/bin/env node
/*
	CRSF verification runner (npm run security:verify).

	Reproduces the CRSF evaluation for the current commit:
	  1. read git commit, 2. load the definition, 3. validate schemas,
	  4-6. validate references and recompute every status (recorded statuses are
	  never trusted - they must equal the recomputation), 7. validate deviations,
	  8. check ASVS completeness against the vendored pinned requirement file,
	  9. execute mapped evidence (tests, probes, framework self-tests, mutations),
	  10. record missing environment capabilities, 11-12. write a deterministic
	  JSON report and a Markdown summary, 13. exit according to profile policy.

	Options:
	  --no-mutations                 skip mutation execution (mutation evidence then counts as NOT_RUN)
	  --base <ref>                   drift: changed paths BASE..HEAD -> affected domains; also checks the lock at BASE
	  --out <dir>                    report directory (default security/reports/out, git-ignored)
	  --require-release-assertion    exit 2 unless RELEASE_SECURITY_ASSERTION is PASS

	Exit codes: 0 framework valid and no executed evidence failed; 1 framework
	invalid, evidence failure, mutation claim mismatch or release-blocking FAIL;
	2 only with --require-release-assertion when the assertion is not PASS.
	No secrets are read: child processes get a fixed minimal environment.
*/
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDefinition, loadSchemas, validateSchemas, checkIntegrity, checkPinnedSources, declaredOutcomes, evaluate, affectedDomains, sha256, findingLedger, openUnmappedFindings, releaseAssertion } from '../security/crsf/lib/engine.mjs';
import { detectCapabilities, childEnv, executeNodeTestEvidence, executeProbe, executeMutations, mutationClaimMismatches, gitInfo, changedPaths } from '../security/crsf/lib/exec.mjs';
import { runSelfTests } from '../security/crsf/selftest/framework-selftest.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRSF = path.join(REPO, 'security/crsf');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const flag = (name) => process.argv.includes(name);
const OUT = path.resolve(REPO, arg('--out') ?? 'security/reports/out');

const log = (m) => process.stderr.write(`${m}\n`);
const git = gitInfo(REPO);
log(`CRSF verify @ ${git.commit ?? 'unknown commit'}${git.clean ? '' : ' (working tree NOT clean)'}`);

/* --------------------------------------------------- 2-8: definition */
const def = loadDefinition(CRSF, path.join(REPO, 'security/mutation/cases.json'));
const schemas = loadSchemas(path.join(CRSF, 'schema'));
const framework = [...validateSchemas(def, schemas)];
let declaredEval = null;
if (!framework.length) {
	const integrity = checkIntegrity(def, declaredOutcomes(def));
	framework.push(...integrity.errors);
	declaredEval = integrity.evaluation;
	// vendored pinned ASVS file: checksum + applicability covers exactly its requirements
	framework.push(...checkPinnedSources(def, (file) => readFileSync(path.join(REPO, file))));
}
const base = arg('--base');
let drift = null;
if (base) {
	drift = affectedDomains(def, changedPaths(REPO, base));
	try {
		const baseLock = JSON.parse(execFileSync('git', ['show', `${base}:security/crsf/framework-lock.json`], { cwd: REPO, encoding: 'utf8' }));
		if (!framework.length) for (const e of checkIntegrity({ ...def, 'framework-lock': baseLock }, declaredOutcomes(def)).errors.filter((x) => /SILENTLY|CHANGE_NOT|THRESHOLD|DELETION|VERSION_WITHOUT|PROFILE_CHANGED|REQUIREMENT_CHANGE/.test(x.code))) framework.push({ ...e, detail: `${e.detail} (against lock at ${base})` });
	} catch { drift.base_lock = 'not present at base (framework introduced after base)'; }
}
log(`framework: ${framework.length ? `INVALID (${framework.length} error(s))` : 'valid'}`);

/* -------------------------------------------- 9-10: execution */
const caps = detectCapabilities();
const env = childEnv(caps);
const items = def.evidence?.evidence ?? [];
// Phase 2W: the capabilities of this run are part of the observed outcomes (meta-derived properties check them).
const observed = { mode: 'OBSERVED', evidence: {}, mutations: {}, observations: {}, capabilities: caps };
const evidenceResults = [];
let guard = { tests: 0, pass: 0, failed: [], cancelled: [], todo: [], unexpected_skips: [], allowed_skips: [] };
let mutationRun = { results: {}, baseline: { ok: true, reason: 'not run' } };
let selftest = null;
if (!framework.length) {
	log('executing node-test evidence ...');
	const nt = executeNodeTestEvidence(items.filter((e) => e.execution.runner === 'node-test'), { cwd: REPO, env, caps });
	guard = nt.guard;
	observed.observations = nt.observations; // Phase 2U: runner receipts, the only source of real-system credit
	for (const [id, o] of Object.entries(nt.outcomes)) { observed.evidence[id] = o; evidenceResults.push({ id, runner: 'node-test', outcome: o, ...nt.detail[id] }); }
	for (const e of items.filter((x) => x.execution.runner === 'probe')) { const r = executeProbe(e, { cwd: REPO, env }); observed.evidence[e.id] = r.outcome; evidenceResults.push({ id: e.id, runner: 'probe', outcome: r.outcome, observation: r.observation }); }
	log('running framework self-tests ...');
	try { selftest = runSelfTests(); } catch (error) { selftest = { passed: false, rejected: 0, total: 0, fixtures: [], error: error.code ?? error.message }; framework.push({ code: 'SELFTEST_ERROR', detail: String(error.code ?? error.message) }); }
	for (const e of items.filter((x) => x.execution.runner === 'crsf-selftest')) { observed.evidence[e.id] = selftest.passed ? 'PASS' : 'FAIL'; evidenceResults.push({ id: e.id, runner: 'crsf-selftest', outcome: observed.evidence[e.id], rejected: `${selftest.rejected}/${selftest.total}` }); }
	for (const e of items.filter((x) => ['static', 'manual'].includes(x.execution.runner))) { observed.evidence[e.id] = 'STATIC'; evidenceResults.push({ id: e.id, runner: e.execution.runner, outcome: 'NOT_EXECUTABLE' }); }
	if (!flag('--no-mutations')) {
		log(`executing ${def.mutations.cases.length} mutation cases in a disposable workspace ...`);
		mutationRun = executeMutations(def.mutations.cases, { repoRoot: REPO, env, caps });
	} else for (const m of def.mutations.cases) mutationRun.results[m.id] = { result: 'NOT_RUN', reason: '--no-mutations', intended: [], other: [] };
	observed.mutations = mutationRun.results;
	for (const e of items.filter((x) => x.execution.runner === 'mutation')) {
		const rs = e.execution.mutation_ids.map((id) => mutationRun.results[id]?.result ?? 'NOT_RUN');
		observed.evidence[e.id] = rs.every((r) => r === 'NOT_RUN') ? 'NOT_RUN' : 'EXECUTED';
		evidenceResults.push({ id: e.id, runner: 'mutation', outcome: observed.evidence[e.id], cases: Object.fromEntries(e.execution.mutation_ids.map((id) => [id, mutationRun.results[id]?.result ?? 'NOT_RUN'])) });
	}
}
const claimMismatches = framework.length ? [] : mutationClaimMismatches(def.mutations.cases, mutationRun.results);
const worktreeAfter = gitInfo(REPO);
if (git.clean && !worktreeAfter.clean) framework.push({ code: 'WORKTREE_MODIFIED', detail: 'verification changed the working tree' });

/* ------------------------------------------- recompute (observed) */
const obsEval = framework.length ? null : evaluate(def, observed);
const ctlById = new Map((def.controls?.controls ?? []).map((c) => [c.id, c]));
const controls = obsEval ? obsEval.controls.map((r) => {
	const c = ctlById.get(r.id);
	const declared = declaredEval.controls.find((x) => x.id === r.id);
	return { id: r.id, domain: c.domain, release_class: c.release_class, minimum_evidence_level: c.minimum_evidence_level, security_status: r.security_status, conformance_status: r.conformance_status, declared_security_status: declared.security_status, reason: r.security_status_reason, deviation_ids: r.deviation_ids };
}) : [];
const tally = (arr, f) => Object.fromEntries(Object.entries(arr.reduce((a, x) => { const k = f(x); a[k] = (a[k] ?? 0) + 1; return a; }, {})).sort(([a], [b]) => a.localeCompare(b)));
const rb = controls.filter((c) => c.release_class === 'RELEASE_BLOCKING');
const evidenceFailures = evidenceResults.filter((e) => e.outcome === 'FAIL');
const guardProblems = [...guard.failed, ...guard.cancelled, ...guard.todo, ...guard.unexpected_skips];
const frameworkValid = framework.length === 0 && claimMismatches.length === 0 && (selftest?.passed ?? false) && mutationRun.baseline.ok;
// Phase 2J (F-2J-1): an OPEN application finding that no control property shows fails the release directly.
const ledger = def['framework-changes'] ? [...findingLedger(def).values()] : [];
const openUnmapped = def['framework-changes'] ? openUnmappedFindings(def) : [];
const assertion = releaseAssertion({ frameworkValid, releaseBlockingStatuses: rb.map((c) => c.security_status), evidenceFailures: evidenceFailures.length, guardProblems: guardProblems.length, openUnmapped });

/* --------------------------------------------------- 11: report */
const devResults = obsEval ? obsEval.deviations : {};
const report = {
	framework: 'CRSF', framework_version: def.profile?.crsf_version ?? null,
	repository_commit: git.commit, branch: git.branch, worktree_clean: git.clean,
	framework_digest: sha256(Object.fromEntries(['profile', 'controls', 'evidence', 'deviations', 'asvs-applicability', 'drift-model', 'framework-lock', 'mutations'].map((k) => [k, def[k]]))),
	source_manifest_digest: def.sources ? sha256({ sources: def.sources.sources, deferred: def.sources.deferred_sources }) : null,
	profile_digest: def.profile ? sha256(def.profile) : null,
	deviation_set_digest: def.deviations ? sha256(def.deviations.deviations) : null,
	framework_valid: frameworkValid,
	framework_errors: framework,
	framework_selftest: selftest ? { passed: selftest.passed, rejected: selftest.rejected, total: selftest.total, fixtures: selftest.fixtures.map((f) => ({ id: f.id, expected: f.expected, rejected: f.rejected })) } : null,
	security_status_counts: tally(controls, (c) => c.security_status),
	release_blocking_status_counts: tally(rb, (c) => c.security_status),
	conformance_status_counts: obsEval ? tally(obsEval.asvs.filter((a) => a.conformance_status !== 'NOT_APPLICABLE' && a.conformance_status !== 'DEFERRED'), (a) => a.conformance_status) : {},
	declared_vs_observed: controls.filter((c) => c.security_status !== c.declared_security_status).map((c) => ({ id: c.id, declared: c.declared_security_status, observed: c.security_status, reason: c.reason })),
	controls,
	evidence_results: evidenceResults.sort((a, b) => a.id.localeCompare(b.id)),
	manual_assurance_items: controls.filter((c) => c.release_class === 'MANUAL_ASSURANCE').map((c) => ({ id: c.id, status: c.security_status })),
	missing_evidence: controls.filter((c) => c.security_status === 'MISSING_EVIDENCE').map((c) => ({ id: c.id, release_class: c.release_class, reason: c.reason })),
	failures: controls.filter((c) => c.security_status === 'FAIL').map((c) => ({ id: c.id, release_class: c.release_class, reason: c.reason })),
	accepted_deviations: (def.deviations?.deviations ?? []).filter((d) => devResults[d.id]?.status === 'ACCEPTED').map((d) => ({ id: d.id, type: d.type, controls: d.control_ids, requirement: d.external_requirement_ids[0], owner_signoff: d.owner_signoff })),
	rejected_deviation_candidates: (def.deviations?.deviations ?? []).filter((d) => devResults[d.id]?.status === 'REJECTED').map((d) => d.id),
	environment_capabilities: caps,
	unexpected_skips: guard.unexpected_skips, unexpected_cancellations: guard.cancelled, todo_count: guard.todo.length, failed_tests: guard.failed,
	allowed_infrastructure_skips: guard.allowed_skips,
	mutation_baseline: mutationRun.baseline,
	mutation_results: Object.entries(mutationRun.results).sort(([a], [b]) => a.localeCompare(b)).map(([id, r]) => {
		const m = def.mutations?.cases.find((x) => x.id === id);
		// A declared-EQUIVALENT mutant that survived is reported as EQUIVALENT (visible, never E4, never a gap).
		const observed = m?.expected_result === 'EQUIVALENT' && r.result === 'SURVIVED' ? 'EQUIVALENT' : r.result;
		return { id, declared: m?.expected_result, observed, layering: m?.layering ?? null, reason: r.reason, intended_failures: r.intended };
	}),
	mutation_claim_mismatches: claimMismatches,
	findings: ledger.map((f) => ({ id: f.id, finding_class: f.finding_class, status: f.status, mapping: f.mapping?.control ? `${f.mapping.control}.${f.mapping.property}` : f.finding_class === 'APPLICATION' ? 'UNMAPPED' : null, opened_in: f.opened_in, closed_in: f.closed_in })),
	open_unmapped_findings: openUnmapped,
	affected_domains: drift,
	release_blocking_controls: rb.length,
	verification_result: { FRAMEWORK_VALID: frameworkValid ? 'YES' : 'NO', RELEASE_SECURITY_ASSERTION: assertion }
};
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'crsf-report.json'), JSON.stringify(report, null, '\t') + '\n');

/* ----------------------------------------------- 12: human summary */
const count = (s) => report.security_status_counts[s] ?? 0;
const md = [
	'# CoverRaccoon Security Verification', '',
	`- Commit: \`${report.repository_commit}\`${report.worktree_clean ? '' : ' (working tree not clean)'}`,
	`- CRSF: ${report.framework_version}`,
	`- Framework integrity: ${frameworkValid ? 'PASS' : 'FAIL'}${selftest ? ` (self-test ${selftest.rejected}/${selftest.total} invalid fixtures rejected)` : ''}`,
	`- Environment: postgres ${caps.postgres.available ? 'available' : 'NOT available (DB evidence and DB mutations NOT_RUN)'}; mutations ${flag('--no-mutations') ? 'skipped (--no-mutations)' : 'executed'}`, '',
	'## Security assurance (observed)', '',
	`- Controls: ${controls.length}; release-blocking: ${rb.length}`,
	`- PASS_AUTOMATED: ${count('PASS_AUTOMATED')} | PASS_MANUAL: ${count('PASS_MANUAL')} | MISSING_EVIDENCE: ${count('MISSING_EVIDENCE')} | FAIL: ${count('FAIL')} | INFORMATIONAL: ${count('INFORMATIONAL')}`,
	`- Release-blocking: ${Object.entries(report.release_blocking_status_counts).map(([k, v]) => `${k} ${v}`).join(', ')}`, '',
	'## Standard conformance (ASVS 5.0.0, applicable)', '',
	...Object.entries(report.conformance_status_counts).map(([k, v]) => `- ${k}: ${v}`), '',
	`Accepted protocol deviations: ${report.accepted_deviations.filter((d) => d.type === 'PROTOCOL').length} · Accepted platform deviations: ${report.accepted_deviations.filter((d) => d.type === 'PLATFORM').length} · Owner sign-off pending: ${report.accepted_deviations.filter((d) => d.owner_signoff === 'PENDING').length}`, '',
	'## Execution', '',
	`- Evidence tests: ${guard.tests} run, ${guard.failed.length} failed, ${guard.cancelled.length} cancelled, ${guard.todo.length} todo, ${guard.unexpected_skips.length} unexpected skips, ${guard.allowed_skips.length} allowed infrastructure skips`,
	`- Mutations: ${Object.entries(tally(report.mutation_results, (m) => m.observed)).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; claim mismatches ${claimMismatches.length}`,
	...(report.declared_vs_observed.length ? ['', `Declared vs observed differences: ${report.declared_vs_observed.length} (see report JSON)`] : []),
	...(drift ? ['', `## Drift since ${base}`, '', `- Affected domains: ${drift.domains.join(', ') || 'none'}`, `- Unmatched paths (full re-run): ${drift.unmatched.length}`] : []), '',
	'## Result', '',
	`- FRAMEWORK_VALID: ${report.verification_result.FRAMEWORK_VALID}`,
	`- RELEASE_SECURITY_ASSERTION: ${assertion}`, '',
	assertion === 'PASS' ? 'All release-blocking controls are PASS_AUTOMATED in this run.' : assertion === 'INCOMPLETE_EVIDENCE' ? `Not release-assertable: ${rb.filter((c) => c.security_status === 'MISSING_EVIDENCE').length} release-blocking control(s) lack sufficient evidence. This is a statement about evidence, not a finding of vulnerability.` : assertion === 'FAIL' ? (openUnmapped.length ? `Open application finding(s) not mapped to any control: ${openUnmapped.join(', ')}. ` : '') + 'A release-blocking control failed, an executed security test failed, or an open finding is unmapped.' : 'The framework definition is invalid; no security statement is made.', '',
	'This report evaluates CoverRaccoon against the CRSF mapping of the pinned sources. It is not a certification or compliance claim.', ''
].join('\n');
writeFileSync(path.join(OUT, 'crsf-report.md'), md);
log(`report: ${path.relative(REPO, path.join(OUT, 'crsf-report.json'))}, ${path.relative(REPO, path.join(OUT, 'crsf-report.md'))}`);
log(`FRAMEWORK_VALID: ${report.verification_result.FRAMEWORK_VALID}  RELEASE_SECURITY_ASSERTION: ${assertion}`);
if (!frameworkValid) for (const e of framework.slice(0, 20)) log(`  ${e.code} ${e.detail}`);
for (const m of claimMismatches) log(`  MUTATION_CLAIM_MISMATCH ${m.id}: declared ${m.declared}, observed ${m.observed} (${m.reason})`);

/* ------------------------------------------------------ 13: exit */
// Exit 1 for an invalid framework or a FAIL assertion (failed control, failed evidence, guard problem, open unmapped finding).
if (!frameworkValid || assertion === 'FAIL') process.exitCode = 1;
else if (flag('--require-release-assertion') && assertion !== 'PASS') process.exitCode = 2;
