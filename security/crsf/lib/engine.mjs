/*
	CRSF engine: loads the authoritative JSON definition, validates it and
	recomputes every status. Pure functions only (no process execution); the
	execution layer (exec.mjs) supplies observed evidence and mutation outcomes.

	Two evaluation inputs:
	- DECLARED: what the definition claims (executable evidence passes, mutation
	  cases end with their declared expected_result). Recorded statuses in
	  controls.json must equal this recomputation exactly.
	- OBSERVED: what security:verify actually executed. Evidence that failed or
	  could not run never counts; a mutation counts only if it was KILLED for the
	  intended reason in this run.

	Ambiguity resolves to MISSING_EVIDENCE, never to PASS.
*/
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { validate } from './schema.mjs';

export const FILES = ['sources', 'profile', 'controls', 'evidence', 'deviations', 'asvs-applicability', 'drift-model', 'framework-lock', 'framework-changes'];
export const sha256 = (x) => createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : canonical(x)).digest('hex');
export function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
	return JSON.stringify(value);
}

/* ===================================================================== load */
export function loadDefinition(dir, mutationFile) {
	const def = {};
	for (const name of FILES) {
		const file = path.join(dir, `${name}.json`);
		def[name] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
	}
	def.mutations = mutationFile && existsSync(mutationFile) ? JSON.parse(readFileSync(mutationFile, 'utf8')) : null;
	return def;
}
export function loadSchemas(dir) {
	const out = {};
	for (const name of ['sources', 'profile', 'controls', 'evidence', 'deviations', 'asvs-applicability', 'drift-model', 'framework-lock', 'framework-changes', 'mutations']) out[name] = JSON.parse(readFileSync(path.join(dir, `${name}.schema.json`), 'utf8'));
	return out;
}
export function validateSchemas(def, schemas) {
	const errors = [];
	for (const name of [...FILES, 'mutations']) {
		if (!def[name]) { errors.push({ code: 'MISSING_FILE', detail: `${name}.json missing` }); continue; }
		for (const e of validate(schemas[name], def[name])) errors.push({ code: 'SCHEMA', detail: `${name}: ${e}` });
	}
	return errors;
}

/* =============================================================== evaluation */
const RUNNERS_EXECUTABLE = new Set(['node-test', 'mutation', 'crsf-selftest', 'probe']);
export const isExecutable = (e) => RUNNERS_EXECUTABLE.has(e.execution?.runner);

export function declaredOutcomes(def) {
	const evidence = {}, mutations = {};
	for (const e of def.evidence.evidence) evidence[e.id] = isExecutable(e) ? 'PASS' : 'STATIC';
	for (const m of def.mutations.cases) mutations[m.id] = { result: m.expected_result };
	return { mode: 'DECLARED', evidence, mutations };
}

/** Builds the evaluation context once per definition. */
export function context(def) {
	const p = def.profile;
	const ctlById = new Map(def.controls.controls.map((c) => [c.id, c]));
	const evById = new Map(def.evidence.evidence.map((e) => [e.id, e]));
	const casesByEvidence = new Map();
	for (const m of def.mutations.cases) { if (!casesByEvidence.has(m.evidence_id)) casesByEvidence.set(m.evidence_id, []); casesByEvidence.get(m.evidence_id).push(m); }
	return { p, levels: p.evidence_levels.map((l) => l.id), ctlById, evById, casesByEvidence, evidenceClass: p.evidence_type_classes };
}
const rank = (ctx, l) => ctx.levels.indexOf(l);

function coversFor(ctx, def, c) {
	const out = [];
	for (const e of def.evidence.evidence) for (const cv of e.covers) if (cv.control === c.id) out.push({ e, cv });
	return out;
}

/**
 * Is mutation-backed (known-bad) evidence effective for (control, property)?
 * Needs >= 1 case KILLED with behavioral detection and no case for the same
 * property SURVIVED / KILLED_OTHER / INVALID. Static-detection kills are neutral.
 */
export function knownBadEffective(ctx, e, controlId, propertyId, outcomes) {
	const cases = (ctx.casesByEvidence.get(e.id) ?? []).filter((m) => m.targets.some((t) => t.control === controlId && t.property === propertyId));
	if (!cases.length) return { ok: false, why: 'no mutation case targets this property' };
	const res = cases.map((m) => ({ m, r: outcomes.mutations[m.id]?.result ?? 'NOT_RUN' }));
	const bad = res.filter(({ r }) => ['SURVIVED', 'KILLED_OTHER', 'INVALID'].includes(r));
	if (bad.length) return { ok: false, why: `mutation ${bad.map(({ m, r }) => `${m.id}=${r}`).join(', ')}` };
	const behavioral = res.filter(({ m, r }) => r === 'KILLED' && m.detection === 'behavioral');
	if (!behavioral.length) {
		const notRun = res.filter(({ r }) => r === 'NOT_RUN');
		return { ok: false, why: notRun.length ? `mutation not run: ${notRun.map(({ m }) => m.id).join(', ')}` : 'only static-detection kills' };
	}
	return { ok: true, why: behavioral.map(({ m }) => m.id).join(', ') };
}

function acceptable(ctx, e, c, propertyId, outcomes) {
	if (e.known_bad_result === 'SURVIVED' && e.execution?.runner !== 'mutation') return { ok: false, why: 'known-bad check survived' };
	const cls = ctx.evidenceClass[e.type];
	const required = ctx.p.required_types_by_level[c.minimum_evidence_level] ?? [];
	if (isExecutable(e)) {
		const o = outcomes.evidence[e.id];
		if (e.execution.runner === 'mutation') {
			const kb = knownBadEffective(ctx, e, c.id, propertyId, outcomes);
			if (!kb.ok) return kb;
		} else if (o !== 'PASS') return { ok: false, why: `execution ${o ?? 'NOT_RUN'}` };
	}
	if (e.reproducible) {
		const ok = required.includes(cls) || (rank(ctx, e.level) >= rank(ctx, c.minimum_evidence_level) && cls !== 'manual');
		return ok ? { ok: true } : { ok: false, why: 'type not acceptable for minimum level' };
	}
	const ok = cls === 'manual' && Boolean(e.recorded) && (c.release_class === 'MANUAL_ASSURANCE' || c.automation === 'NO');
	return ok ? { ok: true } : { ok: false, why: 'non-reproducible (only dated manual records for MANUAL_ASSURANCE/automation NO)' };
}

/** Accepted deviation property set per control (only status ACCEPTED counts). */
function deviatedFor(def, deviationStatus, controlId) {
	const props = new Set(); const types = new Set(); const ids = [];
	for (const d of def.deviations.deviations) {
		if (deviationStatus[d.id] !== 'ACCEPTED' || !d.control_ids.includes(controlId)) continue;
		for (const pid of d.deviated_properties[controlId] ?? []) props.add(pid);
		types.add(d.type); ids.push(d.id);
	}
	return { props, type: types.size === 1 ? [...types][0] : types.size ? 'MIXED' : null, ids };
}

export function evaluateControl(ctx, def, c, outcomes, deviation = { props: new Set(), type: null, ids: [] }) {
	if (c.applicability === 'NOT_APPLICABLE' || c.applicability === 'DEFERRED') return { security: c.applicability, conformance: c.applicability, sreason: c.applicability_reason, creason: c.applicability_reason, detail: {}, deviated: [] };
	const kind = Object.fromEntries(c.properties.map((p) => [p.id, p.kind]));
	const covers = coversFor(ctx, def, c);
	const defects = []; const deviated = new Set();
	for (const { e, cv } of covers.filter(({ cv }) => cv.result === 'VIOLATION')) for (const pid of cv.properties) {
		if (kind[pid] === 'CONFORMANCE' && deviation.props.has(pid)) deviated.add(pid);
		else defects.push({ pid, kind: kind[pid], text: `${pid}: ${cv.note} [${e.id}]` });
	}
	const detail = {}; let anyManual = false;
	for (const p of c.properties) {
		if (deviated.has(p.id)) { detail[p.id] = { deviated: true, satisfied_by: [], partial_only: [], insufficient: [] }; continue; }
		const sats = [], partial = [], insufficient = [];
		for (const { e, cv } of covers) {
			if (cv.result !== 'SUPPORTS' || !cv.properties.includes(p.id)) continue;
			if (cv.scope === 'PARTIAL') { partial.push(e.id); continue; }
			const a = acceptable(ctx, e, c, p.id, outcomes);
			if (a.ok && rank(ctx, e.level) >= rank(ctx, c.minimum_evidence_level)) sats.push(e);
			else insufficient.push(`${e.id}(${e.level}${e.reproducible ? '' : ',non-reproducible'}${a.ok ? '' : `: ${a.why}`})`);
		}
		detail[p.id] = { satisfied_by: sats.map((e) => e.id), partial_only: partial, insufficient };
		if (sats.some((e) => !e.reproducible)) anyManual = true;
	}
	const unsat = (ids) => ids.filter((k) => !detail[k].deviated && !detail[k].satisfied_by.length && !defects.some((d) => d.pid === k));
	const why = (k) => `${k} unsatisfied${detail[k].partial_only.length ? ` (partial only: ${detail[k].partial_only.join(',')})` : ''}${detail[k].insufficient.length ? ` (below ${c.minimum_evidence_level}/not acceptable: ${detail[k].insufficient.join(',')})` : ''}`;
	const all = c.properties.map((p) => p.id);
	let security, sreason;
	if (defects.length) { security = 'FAIL'; sreason = defects.map((d) => d.text).join('; '); }
	else if (unsat(all).length) { security = 'MISSING_EVIDENCE'; sreason = unsat(all).map(why).join('; '); }
	else if (deviated.size) { security = 'INFORMATIONAL'; sreason = `${[...deviated].join('+')} covered by accepted ${deviation.type} deviation; all ${all.length - deviated.size} remaining sub-properties satisfied at >= ${c.minimum_evidence_level}; no defect`; }
	else { security = anyManual ? 'PASS_MANUAL' : 'PASS_AUTOMATED'; sreason = `all ${all.length} sub-properties satisfied at >= ${c.minimum_evidence_level}`; }
	const lit = c.properties.filter((p) => p.kind !== 'SECURITY').map((p) => p.id);
	const litDefects = defects.filter((d) => d.kind !== 'SECURITY');
	let conformance, creason;
	if (litDefects.length) { conformance = 'NON_CONFORMANT'; creason = litDefects.map((d) => d.text).join('; '); }
	else if (unsat(lit).length) { conformance = 'NOT_DEMONSTRATED'; creason = unsat(lit).map(why).join('; '); }
	else if (deviated.size) { conformance = `ACCEPTED_${deviation.type}_DEVIATION`; creason = `${[...deviated].join('+')} deviates under a validated ${deviation.type} deviation`; }
	else { conformance = 'CONFORMANT'; creason = `all ${lit.length} requirement properties demonstrated`; }
	return { security, conformance, sreason, creason, detail, deviated: [...deviated] };
}

/* ======================================================= deviation validator */
export function validateDeviation(ctx, def, d, baseline) {
	const checks = [];
	const sourceIds = new Set(def.sources.sources.map((s) => s.id));
	const pinned = (ref) => sourceIds.has(String(ref).split(' ')[0]);
	const crit = ctx.p.deviation_rules.criteria[d.type] ?? [];
	for (const k of crit) if (!d.criteria?.[k] || typeof d.criteria[k].met !== 'boolean' || !d.criteria[k].basis) checks.push(`criterion ${k} missing basis`);
	const unmet = crit.filter((k) => d.criteria?.[k]?.met === false);
	for (const f of ctx.p.deviation_rules.required_fields) { const v = d[f]; if (v == null || v === '' || (Array.isArray(v) && !v.length)) checks.push(`missing field ${f}`); }
	if (d.external_requirement_ids.length !== 1) checks.push('deviation must target exactly one external requirement (no aggregation)');
	if (d.control_ids.length !== 1) checks.push('deviation must target exactly one control');
	for (const ref of d.external_standard_source) if (!pinned(ref)) checks.push(`conflicting standard source not pinned: ${ref}`);
	for (const ref of d.required_protocol_source) if (!pinned(ref)) checks.push(`protocol/platform source not pinned: ${ref}`);
	if (d.type === 'PROTOCOL' && d.required_protocol_source.some((r) => /^SRC-ASVS/.test(r))) checks.push('protocol source cannot be the conflicting standard itself');
	if (d.type === 'PLATFORM' && !d.trust_assumption) checks.push('platform deviation needs trust_assumption');
	if (d.owner_signoff === 'APPROVED' && !(d.owner_signoff_record?.by && d.owner_signoff_record?.date && d.owner_signoff_record?.reference)) checks.push('APPROVED sign-off without a sign-off record');
	for (const cid of d.control_ids) {
		const c = ctx.ctlById.get(cid);
		if (!c) { checks.push(`unknown control ${cid}`); continue; }
		if (!c.external_requirement_ids.includes(d.external_requirement_ids[0])) checks.push(`${cid} does not map ${d.external_requirement_ids[0]}`);
		if (c.release_class === 'RELEASE_BLOCKING') checks.push(`${cid} is RELEASE_BLOCKING; deviations are not allowed there in CRSF 1.0`);
		for (const pid of d.deviated_properties[cid] ?? []) {
			const p = c.properties.find((x) => x.id === pid);
			if (!p) { checks.push(`${cid}.${pid} unknown`); continue; }
			if (p.kind !== 'CONFORMANCE') checks.push(`${cid}.${pid} is ${p.kind}; only CONFORMANCE properties can deviate`);
			const viol = coversFor(ctx, def, c).some(({ cv }) => cv.result === 'VIOLATION' && cv.properties.includes(pid));
			if (!viol) checks.push(`${cid}.${pid} has no VIOLATION finding (MISSING_EVIDENCE cannot become a deviation)`);
		}
	}
	for (const eid of d.evidence_ids) if (!ctx.evById.has(eid)) checks.push(`unknown evidence ${eid}`);
	for (const ic of d.independent_defect_check_controls) {
		if (!ctx.ctlById.has(ic)) checks.push(`unknown implementation control ${ic}`);
		else if (baseline[ic]?.security === 'FAIL') checks.push(`implementation control ${ic} is FAIL (deviation would hide it)`);
	}
	if (!d.review_triggers.length) checks.push('no review triggers');
	const needed = ctx.p.deviation_rules.required_review_triggers[d.external_requirement_ids[0]?.split('.')[0]] ?? [];
	if (d.type === 'PROTOCOL') for (const code of needed) if (!d.review_triggers.some((t) => t.code === code)) checks.push(`deviation lacks review trigger ${code}`);
	return { status: unmet.length ? 'REJECTED' : checks.length ? 'REQUIRES_REVIEW' : 'ACCEPTED', unmet_criteria: unmet, machine_check_failures: checks };
}

/* ================================================================ evaluate */
export function evaluate(def, outcomes) {
	const ctx = context(def);
	const baseline = Object.fromEntries(def.controls.controls.map((c) => [c.id, evaluateControl(ctx, def, c, outcomes)]));
	const deviationResults = Object.fromEntries(def.deviations.deviations.map((d) => [d.id, validateDeviation(ctx, def, d, baseline)]));
	const devStatus = Object.fromEntries(Object.entries(deviationResults).map(([k, v]) => [k, v.status]));
	const controls = def.controls.controls.map((c) => {
		const dv = deviatedFor(def, devStatus, c.id);
		const r = dv.ids.length ? evaluateControl(ctx, def, c, outcomes, dv) : baseline[c.id];
		const covers = coversFor(ctx, def, c);
		const classes = [...new Set(covers.filter(({ cv, e }) => cv.result === 'SUPPORTS' && e.reproducible).map(({ e }) => ctx.evidenceClass[e.type]))].sort();
		const fixtures = covers.map(({ e }) => e.fixture_group).filter(Boolean);
		return {
			id: c.id,
			required_evidence_types: ctx.p.required_types_by_level[c.minimum_evidence_level] ?? [],
			current_evidence_ids: [...new Set(covers.map(({ e }) => e.id))].sort(),
			property_coverage: r.detail,
			conformance_status: r.conformance, conformance_status_reason: r.creason,
			security_status: r.security, security_status_reason: r.sreason,
			deviation_ids: dv.ids,
			independence: c.release_class === 'RELEASE_BLOCKING' ? { evidence_classes: classes, independent_classes: classes.length, shared_fixture_groups: [...new Set(fixtures.filter((f, i) => fixtures.indexOf(f) !== i))].sort() } : null
		};
	});
	const byId = new Map(controls.map((c) => [c.id, c]));
	const mapped = {};
	for (const c of def.controls.controls) for (const id of c.external_requirement_ids) if (/^V\d+\.\d+\.\d+$/.test(id)) (mapped[id] ??= []).push(c.id);
	const asvs = def['asvs-applicability'].items.map((i) => {
		const ids = mapped[i.req_id] ?? [];
		if (i.applicability !== 'APPLICABLE') return { req_id: i.req_id, controls: ids, conformance_status: i.applicability };
		const cs = ids.map((id) => byId.get(id).conformance_status);
		const conf = !cs.length ? 'UNMAPPED' : cs.includes('NON_CONFORMANT') ? 'NON_CONFORMANT' : cs.includes('NOT_DEMONSTRATED') ? 'NOT_DEMONSTRATED' : cs.includes('ACCEPTED_PROTOCOL_DEVIATION') ? 'ACCEPTED_PROTOCOL_DEVIATION' : cs.includes('ACCEPTED_PLATFORM_DEVIATION') ? 'ACCEPTED_PLATFORM_DEVIATION' : 'CONFORMANT';
		const cls = ids.map((id) => ctx.ctlById.get(id).release_class);
		return { req_id: i.req_id, controls: ids, conformance_status: conf, release_relevance: cls.includes('RELEASE_BLOCKING') ? 'RELEASE_BLOCKING' : [...new Set(cls)].sort().join('+') || 'UNMAPPED' };
	});
	return { mode: outcomes.mode, controls, deviations: deviationResults, asvs, baseline };
}

/* ============================================================ integrity */
const COMPUTED_CONTROL_FIELDS = ['required_evidence_types', 'current_evidence_ids', 'property_coverage', 'conformance_status', 'conformance_status_reason', 'security_status', 'security_status_reason', 'deviation_ids', 'independence'];

/** Framework invariants. Returns [{code, detail}]; empty = definition is valid. */
export function checkIntegrity(def, declared) {
	const errors = [];
	const err = (code, detail) => errors.push({ code, detail });
	const ctx = context(def);
	const sourceIds = new Set(def.sources.sources.map((s) => s.id));
	const controls = def.controls.controls;
	const ids = controls.map((c) => c.id);
	if (new Set(ids).size !== ids.length) err('DUPLICATE_CONTROL', ids.filter((x, i) => ids.indexOf(x) !== i).join(', '));
	const eids = def.evidence.evidence.map((e) => e.id);
	if (new Set(eids).size !== eids.length) err('DUPLICATE_EVIDENCE', eids.filter((x, i) => eids.indexOf(x) !== i).join(', '));
	const dids = def.deviations.deviations.map((d) => d.id);
	if (new Set(dids).size !== dids.length) err('DUPLICATE_DEVIATION', dids.join(', '));
	const mids = def.mutations.cases.map((m) => m.id);
	if (new Set(mids).size !== mids.length) err('DUPLICATE_MUTATION', mids.filter((x, i) => mids.indexOf(x) !== i).join(', '));
	const versions = new Set([def.profile.crsf_version, def.controls.crsf_version, def.evidence.crsf_version, def.deviations.crsf_version, def.sources.crsf_version, def['asvs-applicability'].crsf_version, def['drift-model'].crsf_version]);
	if (versions.size !== 1) err('VERSION_SKEW', [...versions].join(' / '));

	for (const c of controls) {
		if (c.status_computed !== true || c.manual_override_allowed !== false) err('MANUAL_OVERRIDE', c.id);
		for (const ref of c.source_refs) { const sid = ref.split(' ')[0]; if (sid !== 'CRSF_INTERNAL_POLICY' && !sourceIds.has(sid)) err('UNKNOWN_SOURCE', `${c.id}: ${sid}`); }
		if (c.derivation_type === 'EXTERNAL_STANDARD' && !c.source_refs.some((r) => sourceIds.has(r.split(' ')[0]))) err('UNPINNED_EXTERNAL_CONTROL', c.id);
		if (c.derivation_type === 'CRSF_INTERNAL_POLICY' && c.external_requirement_ids.length) err('INTERNAL_CLAIMS_EXTERNAL', c.id);
		const pids = c.properties.map((p) => p.id);
		if (new Set(pids).size !== pids.length) err('DUPLICATE_PROPERTY', c.id);
	}
	for (const e of def.evidence.evidence) {
		for (const cv of e.covers) {
			const c = ctx.ctlById.get(cv.control);
			if (!c) { err('UNKNOWN_CONTROL_REFERENCE', `${e.id} -> ${cv.control}`); continue; }
			for (const pid of cv.properties) if (!c.properties.some((p) => p.id === pid)) err('UNKNOWN_PROPERTY_REFERENCE', `${e.id} -> ${cv.control}.${pid}`);
			if (cv.scope === 'PARTIAL' && !cv.note) err('PARTIAL_WITHOUT_REASON', `${e.id} -> ${cv.control}`);
		}
		const derivedIds = [...new Set(e.covers.map((cv) => cv.control))].sort();
		if (canonical(derivedIds) !== canonical(e.control_ids)) err('EVIDENCE_CONTROL_IDS_MISMATCH', e.id);
		const partial = e.covers.some((cv) => cv.scope === 'PARTIAL' || (ctx.ctlById.get(cv.control) && cv.properties.length < ctx.ctlById.get(cv.control).properties.length));
		if (e.coverage !== (partial ? 'PARTIAL' : 'FULL')) err('COVERAGE_MISLABELED', `${e.id}: declared ${e.coverage}, derived ${partial ? 'PARTIAL' : 'FULL'}`);
		if (e.coverage === 'PARTIAL' && !e.reason_for_partial) err('PARTIAL_WITHOUT_REASON', e.id);
		if (e.execution?.runner === 'mutation') {
			const cases = ctx.casesByEvidence.get(e.id) ?? [];
			if (!cases.length) err('MUTATION_EVIDENCE_WITHOUT_CASES', e.id);
			const targets = new Set(cases.flatMap((m) => m.targets.map((t) => `${t.control}.${t.property}`)));
			const covered = new Set(e.covers.flatMap((cv) => cv.properties.map((p) => `${cv.control}.${p}`)));
			if (canonical([...targets].sort()) !== canonical([...covered].sort())) err('MUTATION_COVERS_MISMATCH', e.id);
			const declaredKb = cases.every((m) => m.expected_result === 'KILLED') ? 'KILLED' : cases.every((m) => m.expected_result === 'SURVIVED') ? 'SURVIVED' : 'MIXED';
			if (declaredKb === 'MIXED' || e.known_bad_result !== declaredKb) err('KNOWN_BAD_RESULT_MISMATCH', `${e.id}: declared ${e.known_bad_result}, cases ${declaredKb}`);
			if (!e.known_bad_checked) err('KNOWN_BAD_FLAG', e.id);
		} else if (e.type === 'known-bad' && e.reproducible) err('KNOWN_BAD_WITHOUT_MUTATION_RUNNER', `${e.id}: reproducible known-bad evidence must be backed by mutation cases`);
	}
	for (const m of def.mutations.cases) {
		if (!ctx.evById.has(m.evidence_id)) err('UNKNOWN_EVIDENCE_REFERENCE', `${m.id} -> ${m.evidence_id}`);
		for (const t of m.targets) { const c = ctx.ctlById.get(t.control); if (!c || !c.properties.some((p) => p.id === t.property)) err('UNKNOWN_CONTROL_REFERENCE', `${m.id} -> ${t.control}.${t.property}`); }
		if (m.expected_result === 'KILLED' && !m.expected_failures.length) err('MUTATION_WITHOUT_EXPECTED_FAILURE', m.id);
	}
	for (const d of def.deviations.deviations) {
		for (const eid of d.evidence_ids) if (!ctx.evById.has(eid)) err('UNKNOWN_EVIDENCE_REFERENCE', `${d.id} -> ${eid}`);
		if (d.manual_override_allowed !== false || d.status_computed !== true) err('MANUAL_OVERRIDE', d.id);
	}

	// recompute and compare: recorded state must equal the declared recomputation
	const ev = evaluate(def, declared);
	for (const r of ev.controls) {
		const c = ctx.ctlById.get(r.id);
		for (const f of COMPUTED_CONTROL_FIELDS) if (canonical(c[f]) !== canonical(r[f])) err(f === 'security_status' || f === 'conformance_status' ? 'STATUS_NOT_RECOMPUTABLE' : 'COMPUTED_FIELD_MISMATCH', `${c.id}.${f}: recorded ${JSON.stringify(c[f])?.slice(0, 80)} != recomputed ${JSON.stringify(r[f])?.slice(0, 80)}`);
		if (r.security_status.startsWith('PASS') || r.security_status === 'INFORMATIONAL') for (const [pid, v] of Object.entries(r.property_coverage)) if (!v.deviated && !v.satisfied_by.length) err('PASS_WITHOUT_EVIDENCE', `${c.id}.${pid}`);
		if (c.release_class === 'RELEASE_BLOCKING' && r.security_status === 'PASS_MANUAL') err('RELEASE_BLOCKING_PASS_MANUAL', c.id);
		if (r.deviation_ids.length && r.security_status.startsWith('PASS')) err('DEVIATION_AS_PASS', c.id);
	}
	for (const d of def.deviations.deviations) {
		const v = ev.deviations[d.id];
		if (d.status !== v.status) err('DEVIATION_STATUS_NOT_RECOMPUTABLE', `${d.id}: recorded ${d.status}, recomputed ${v.status} (${[...v.unmet_criteria.map((k) => `criterion ${k} unmet`), ...v.machine_check_failures].join('; ')})`);
		if (canonical(d.validation) !== canonical({ unmet_criteria: v.unmet_criteria, machine_check_failures: v.machine_check_failures })) err('COMPUTED_FIELD_MISMATCH', `${d.id}.validation`);
		if (v.status === 'ACCEPTED') for (const ic of d.independent_defect_check_controls) if (ev.baseline[ic]?.security === 'FAIL') err('DEVIATION_HIDES_FAIL', `${d.id} -> ${ic}`);
		if (v.status === 'ACCEPTED' && d.owner_signoff === 'APPROVED' && !d.owner_signoff_record) err('SIGNOFF_WITHOUT_RECORD', d.id);
	}
	// ASVS completeness
	const asvsItems = def['asvs-applicability'].items;
	for (const a of ev.asvs) {
		const item = asvsItems.find((i) => i.req_id === a.req_id);
		if (item.applicability === 'APPLICABLE' && !a.controls.length) err('APPLICABLE_UNMAPPED', a.req_id);
		if (item.applicability !== 'APPLICABLE' && !item.reason) err('APPLICABILITY_WITHOUT_REASON', a.req_id);
		if (canonical(item.controls) !== canonical(a.controls) || item.conformance_status !== a.conformance_status) err('COMPUTED_FIELD_MISMATCH', `asvs ${a.req_id}`);
	}
	for (const c of controls) for (const id of c.external_requirement_ids) if (/^V\d+\.\d+\.\d+$/.test(id) && !asvsItems.some((i) => i.req_id === id)) err('UNKNOWN_ASVS_REFERENCE', `${c.id} -> ${id}`);
	errors.push(...checkLock(def, ctx));
	return { errors, evaluation: ev };
}

/* =========================================================== version lock */
export function lockEntry(c) {
	return { release_class: c.release_class, minimum_evidence_level: c.minimum_evidence_level, applicability: c.applicability, external_requirement_ids: c.external_requirement_ids, properties_digest: sha256(c.properties) };
}
export function profileLockDigest(profile) {
	return sha256({ release_classes: profile.release_classes, minimum_levels: profile.minimum_levels, required_types_by_level: profile.required_types_by_level, acceptance_rules: profile.acceptance_rules, deviation_rules: profile.deviation_rules, evidence_levels: profile.evidence_levels });
}
export function buildLock(def) {
	return { crsf_version: def.profile.crsf_version, profile_rules_digest: profileLockDigest(def.profile), controls: Object.fromEntries([...def.controls.controls].sort((a, b) => a.id.localeCompare(b.id)).map((c) => [c.id, lockEntry(c)])) };
}
function checkLock(def, ctx) {
	const errors = []; const err = (code, detail) => errors.push({ code, detail });
	const lock = def['framework-lock']; const version = def.profile.crsf_version;
	const now = buildLock(def);
	const changed = [];
	for (const [id, old] of Object.entries(lock.controls)) {
		const cur = now.controls[id];
		if (!cur) { changed.push({ id, kind: 'REMOVED', old }); continue; }
		const diffs = Object.keys(old).filter((k) => canonical(old[k]) !== canonical(cur[k]));
		if (diffs.length) changed.push({ id, kind: 'CHANGED', diffs, old, cur });
	}
	for (const id of Object.keys(now.controls)) if (!lock.controls[id]) changed.push({ id, kind: 'ADDED' });
	const profileChanged = lock.profile_rules_digest !== now.profile_rules_digest;
	if (!changed.length && !profileChanged) return errors;
	if (lock.crsf_version === version) {
		if (profileChanged) err('PROFILE_CHANGED_WITHOUT_VERSION', 'profile rules differ from framework-lock.json at the same crsf_version');
		for (const ch of changed) {
			const reduction = ch.kind === 'CHANGED' && (ch.diffs.includes('minimum_evidence_level') && ctx.levels.indexOf(ch.cur.minimum_evidence_level) < ctx.levels.indexOf(ch.old.minimum_evidence_level));
			const weakened = ch.kind === 'CHANGED' && ch.diffs.includes('release_class') && ch.old.release_class === 'RELEASE_BLOCKING';
			err(reduction ? 'THRESHOLD_REDUCED_SILENTLY' : weakened ? 'RELEASE_CLASS_CHANGED_SILENTLY' : ch.kind === 'REMOVED' ? 'CONTROL_DELETED_SILENTLY' : 'FRAMEWORK_CHANGED_WITHOUT_VERSION', `${ch.id}${ch.diffs ? ` (${ch.diffs.join(', ')})` : ''}`);
		}
		return errors;
	}
	// version bumped: every change must be recorded for this version
	const entry = def['framework-changes'].versions.find((v) => v.crsf_version === version);
	if (!entry) { err('VERSION_WITHOUT_CHANGE_RECORD', version); return errors; }
	for (const ch of changed) {
		const rec = entry.changes.find((x) => x.id === ch.id);
		if (!rec) { err('CHANGE_NOT_RECORDED', `${ch.id} (${ch.kind})`); continue; }
		const reduction = ch.kind === 'CHANGED' && ch.diffs.includes('minimum_evidence_level') && ctx.levels.indexOf(ch.cur.minimum_evidence_level) < ctx.levels.indexOf(ch.old.minimum_evidence_level);
		if (reduction && rec.kind !== 'THRESHOLD_REDUCTION') err('THRESHOLD_REDUCTION_NOT_DECLARED', ch.id);
		if (ch.kind === 'REMOVED') {
			if (rec.kind !== 'REMOVED' || !Array.isArray(rec.asvs_reconciliation)) err('DELETION_NOT_RECONCILED', ch.id);
			for (const req of ch.old.external_requirement_ids.filter((x) => /^V\d/.test(x))) {
				const item = def['asvs-applicability'].items.find((i) => i.req_id === req);
				const stillMapped = def.controls.controls.some((c) => c.external_requirement_ids.includes(req));
				if (item?.applicability === 'APPLICABLE' && !stillMapped) err('DELETION_LEAVES_ASVS_UNMAPPED', `${ch.id} -> ${req}`);
			}
		}
	}
	if (profileChanged && !entry.changes.some((x) => x.id === 'PROFILE')) err('CHANGE_NOT_RECORDED', 'PROFILE');
	err('LOCK_UPDATE_REQUIRED', `framework-lock.json is at ${lock.crsf_version}; regenerate with crsf-gen --write`);
	return errors;
}

/* ================================================================== drift */
const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
export function affectedDomains(def, paths) {
	const rules = def['drift-model'].rules;
	const out = []; const unmatched = [];
	for (const file of paths) {
		const hit = rules.filter((r) => glob(r.pattern).test(file) || (r.pattern.startsWith('*.') && file.endsWith(r.pattern.slice(1))));
		if (!hit.length) unmatched.push(file);
		out.push({ path: file, domains: [...new Set(hit.flatMap((r) => r.domains))].sort() });
	}
	const domains = [...new Set(out.flatMap((o) => o.domains))].sort();
	return { paths: out, domains, unmatched, full_rerun_required: unmatched.length > 0, note: def['drift-model'].note };
}
