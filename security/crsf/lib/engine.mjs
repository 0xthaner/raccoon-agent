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
import { summarizeReceipt } from './pg-observer.mjs';

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
	// Phase 2U: DECLARED mode takes real-system claims as recorded; only the observed run (runner receipts) can confirm them.
	return { mode: 'DECLARED', evidence, mutations, observations: {} };
}

/*
	Phase 2W: meta-derived properties (profile.meta_control_derivation). A meta
	property is a statement about the framework's own evidence graph - for
	CR-VERIFY-004 P1 that every concurrency control has real-Postgres evidence with
	genuine concurrent execution. It is never satisfied by an evidence item of its
	own (that would only relabel application tests); the engine derives it from the
	underlying properties in the same evaluation, at the meta control's own minimum
	level and type. In DECLARED mode the underlying claims are taken as recorded;
	security:verify recomputes them from the observed run.
*/
export const isConcurrencyClaim = (c, p) => c.domain === 'CR-CONC' || /concurren/i.test(p.text);
export const metaProperties = (profile) => new Set((profile.meta_control_derivation?.rules ?? []).map((r) => `${r.control}.${r.property}`));
/** The canonical concurrency set: every property the profile marks plus every one the classifier finds, minus the meta-derived ones. */
export function canonicalConcurrencyProperties(def) {
	const meta = metaProperties(def.profile);
	const keys = new Set((def.profile.real_system_observation?.concurrency?.properties ?? []).map((x) => `${x.control}.${x.property}`));
	for (const c of def.controls.controls) for (const p of c.properties) if (isConcurrencyClaim(c, p)) keys.add(`${c.id}.${p.id}`);
	return [...keys].filter((k) => !meta.has(k)).sort();
}
/** A mutation case holds when it ended as declared in this run; a declared gap (SURVIVED) never holds. */
const mutationHolds = (m, res) => m.expected_result !== 'SURVIVED' && (res === m.expected_result || (m.expected_result === 'EQUIVALENT' && res === 'SURVIVED'));
/** Did this real-system item run in the current run, with its capabilities, and did the runner observe Postgres use and overlap? */
function observedConcurrentRun(ctx, e, outcomes) {
	if (outcomes.mode === 'DECLARED') return { id: e.id, ok: true };
	const rule = ctx.p.real_system_observation;
	const no = (why) => ({ id: e.id, ok: false, why });
	for (const cap of (e.execution?.environment ?? []).filter((x) => x !== 'node')) {
		if (rule?.capabilities?.[cap] !== 'pg-observer') return no(`no runner-side observer for capability ${cap}`);
		if (outcomes.capabilities?.[cap]?.available !== true) return no(`capability ${cap} missing in this run`);
	}
	if (outcomes.evidence[e.id] !== 'PASS') return no(`did not pass in this run (${outcomes.evidence[e.id] ?? 'NOT_RUN'})`);
	const o = outcomes.observations?.[e.id];
	if (!o || o.upstream_kind !== 'postgres') return no('not observed by the runner against the real postgres');
	const use = summarizeReceipt(o.receipt, rule.concurrency);
	if (!use.postgres_use) return no('runner observed no Postgres use');
	if (!use.concurrency) return no('runner observed no concurrent execution');
	return { id: e.id, ok: true };
}
/** Gaps of one canonical concurrency property (empty = genuinely satisfied for the meta rule). */
function concurrencyPropertyGaps(ctx, def, key, meta, results, outcomes, ledger) {
	const [cid, pid] = key.split('.');
	const c = ctx.ctlById.get(cid), r = results[cid];
	if (!c || !r || !c.properties.some((p) => p.id === pid)) return ['unknown or unevaluated control property'];
	const gaps = [];
	const covers = coversFor(ctx, def, c);
	// A: the application control is satisfied at its own required level
	if (r.security !== 'PASS_AUTOMATED' || !r.detail[pid]?.satisfied_by.length) gaps.push(`control ${r.security}`);
	// G: no violation, no open finding on the property
	if (covers.some(({ cv }) => cv.result === 'VIOLATION' && cv.properties.includes(pid))) gaps.push('VIOLATION recorded');
	const open = ledger.filter((f) => f.status === 'OPEN' && f.mapping?.control === cid && f.mapping?.property === pid);
	if (open.length) gaps.push(`open finding ${open.map((f) => f.id).join(',')}`);
	// B-E, H: real-system evidence at the meta control's level that ran now, with its capabilities, observed use and overlap
	const types = ctx.p.required_types_by_level[meta.minimum_evidence_level] ?? [];
	const candidates = covers.filter(({ e, cv }) => cv.result === 'SUPPORTS' && cv.scope === 'FULL' && cv.properties.includes(pid) && e.reproducible && types.includes(ctx.evidenceClass[e.type]) && rank(ctx, e.level) >= rank(ctx, meta.minimum_evidence_level)).map(({ e }) => e);
	if (!candidates.length) gaps.push(`no ${types.join('/')} evidence at >= ${meta.minimum_evidence_level}`);
	else {
		const runs = candidates.map((e) => observedConcurrentRun(ctx, e, outcomes));
		if (!runs.some((x) => x.ok)) gaps.push(runs.map((x) => `${x.id} ${x.why}`).join(', '));
	}
	// F: every mutation case for the property ended as declared in this run
	const bad = def.mutations.cases.filter((m) => m.targets.some((t) => t.control === cid && t.property === pid))
		.map((m) => [m, outcomes.mutations[m.id]?.result ?? 'NOT_RUN']).filter(([m, res]) => !mutationHolds(m, res));
	if (bad.length) gaps.push(`mutation ${bad.map(([m, res]) => `${m.id}=${res}`).join(', ')}`);
	return gaps;
}
/** OBSERVED_CONCURRENCY_COVERAGE: every canonical concurrency property genuinely satisfied in this run, and the rule's own known-bad cases killed. */
function deriveObservedConcurrencyCoverage(ctx, def, rule, results, outcomes) {
	const meta = ctx.ctlById.get(rule.control);
	const ledger = [...findingLedger(def).values()];
	const canonical = canonicalConcurrencyProperties(def);
	const failing = [];
	for (const key of canonical) {
		const gaps = concurrencyPropertyGaps(ctx, def, key, meta, results, outcomes, ledger);
		if (gaps.length) failing.push(`${key}: ${gaps.join('; ')}`);
	}
	if (!canonical.length) failing.push('no concurrency property in the canonical set');
	const own = def.mutations.cases.filter((m) => m.targets.some((t) => t.control === rule.control && t.property === rule.property));
	const ownBad = own.map((m) => [m, outcomes.mutations[m.id]?.result ?? 'NOT_RUN']).filter(([m, res]) => !mutationHolds(m, res));
	if (ownBad.length) failing.push(`rule mutation ${ownBad.map(([m, res]) => `${m.id}=${res}`).join(', ')}`);
	if (!own.some((m) => m.expected_result === 'KILLED' && m.detection === 'behavioral')) failing.push('rule has no behavioural KILLED mutation case');
	return { rule: rule.rule, ok: failing.length === 0, level: meta.minimum_evidence_level, properties: canonical.length, failing };
}
const META_RULES = { OBSERVED_CONCURRENCY_COVERAGE: deriveObservedConcurrencyCoverage };
function deriveMetaProperty(ctx, def, rule, results, outcomes) {
	const fn = META_RULES[rule.rule];
	if (!fn || !ctx.ctlById.get(rule.control)) return { rule: rule.rule, ok: false, level: null, properties: 0, failing: [`unknown meta rule ${rule.rule} or control ${rule.control}`] };
	return fn(ctx, def, rule, results, outcomes);
}

/** Builds the evaluation context once per definition. */
export function context(def) {
	const p = def.profile;
	const ctlById = new Map(def.controls.controls.map((c) => [c.id, c]));
	const evById = new Map(def.evidence.evidence.map((e) => [e.id, e]));
	const casesByEvidence = new Map();
	for (const m of def.mutations.cases) { if (!casesByEvidence.has(m.evidence_id)) casesByEvidence.set(m.evidence_id, []); casesByEvidence.get(m.evidence_id).push(m); }
	const concurrencyProps = new Set((p.real_system_observation?.concurrency?.properties ?? []).map((x) => `${x.control}.${x.property}`));
	const metaRules = p.meta_control_derivation?.rules ?? [];
	return { p, levels: p.evidence_levels.map((l) => l.id), ctlById, evById, casesByEvidence, evidenceClass: p.evidence_type_classes, structural: structuralProperties(def), concurrencyProps, metaRules, metaProps: metaProperties(p) };
}

/*
	Phase 2U (F-2T-1): real-system evidence earns credit only for what the runner
	OBSERVED, never for what the item declares. Every non-node capability of the
	item needs a runner-side observer (profile.real_system_observation), the
	receipt must come from the real upstream (not the self-test fake), the server
	must have confirmed use (authenticated connection + completed statement), and a
	property marked as a concurrency claim additionally needs observed overlapping
	execution. In DECLARED mode (generator, recorded statuses) the claim is taken as
	recorded; security:verify recomputes from the observed run.
*/
export function realSystemObserved(ctx, e, controlId, propertyId, outcomes) {
	if (outcomes.mode === 'DECLARED') return { ok: true };
	const rule = ctx.p.real_system_observation;
	const o = outcomes.observations?.[e.id];
	if (!rule || !o) return { ok: false, why: 'real-system use not observed by the runner' };
	for (const cap of (e.execution?.environment ?? []).filter((x) => x !== 'node')) {
		if (rule.capabilities?.[cap] !== 'pg-observer') return { ok: false, why: `no runner-side observer for capability ${cap}` };
		if (o.upstream_kind !== 'postgres') return { ok: false, why: `observation not made against the real ${cap}` };
	}
	const use = summarizeReceipt(o.receipt, rule.concurrency);
	if (!use.postgres_use) return { ok: false, why: 'runner observed no Postgres use' };
	if (ctx.concurrencyProps.has(`${controlId}.${propertyId}`) && !use.concurrency) return { ok: false, why: 'runner observed no concurrent execution' };
	return { ok: true };
}

/*
	Phase 2D: property-specific STRUCTURAL evidence rule (profile.structural_property_rule).
	Only for (control, property) pairs that are BOTH allowlisted in the profile AND
	marked evidence_basis STRUCTURAL in the control. Everything else keeps the
	control's normal minimum level; checkIntegrity rejects any mismatch.
*/
function structuralProperties(def) {
	const allowed = new Set((def.profile.structural_property_rule?.allowed ?? []).map((a) => `${a.control}.${a.property}`));
	const out = new Set();
	for (const c of def.controls.controls) for (const p of c.properties) if (p.evidence_basis === 'STRUCTURAL' && allowed.has(`${c.id}.${p.id}`)) out.add(`${c.id}.${p.id}`);
	return out;
}
/** Is `e` complete structural evidence under the profile rule? */
function structuralOk(ctx, e) {
	const rule = ctx.p.structural_property_rule; const s = e.structural;
	if (!rule || !s) return false;
	return rule.evidence_types.includes(e.type) && e.reproducible === true && isExecutable(e) && typeof s.primitive === 'string' && s.primitive.length > 0
		&& /^[A-Za-z0-9_./-]+:\d+$/.test(s.call_site ?? '') && s.standard_library === true && s.client_selectable === false;
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
	const all = (ctx.casesByEvidence.get(e.id) ?? []).filter((m) => m.targets.some((t) => t.control === controlId && t.property === propertyId));
	// EQUIVALENT cases are neutral: never proof, never a gap - but always listed in the report.
	const cases = all.filter((m) => m.expected_result !== 'EQUIVALENT');
	if (!cases.length) return { ok: false, why: all.length ? 'only EQUIVALENT cases target this property' : 'no mutation case targets this property' };
	const res = cases.map((m) => ({ m, r: outcomes.mutations[m.id]?.result ?? 'NOT_RUN' }));
	const bad = res.filter(({ r }) => ['SURVIVED', 'KILLED_OTHER', 'INVALID'].includes(r));
	if (bad.length) return { ok: false, why: `mutation ${bad.map(({ m, r }) => `${m.id}=${r}`).join(', ')}` };
	// Phase 2C (F-2C-2): a variant that did not run is unverified - never credit a property while any of its cases is NOT_RUN.
	const notRun = res.filter(({ r }) => r === 'NOT_RUN');
	if (notRun.length) return { ok: false, why: `mutation not run: ${notRun.map(({ m }) => m.id).join(', ')}` };
	const behavioral = res.filter(({ m, r }) => r === 'KILLED' && m.detection === 'behavioral');
	if (!behavioral.length) return { ok: false, why: 'only static-detection kills' };
	return { ok: true, why: behavioral.map(({ m }) => m.id).join(', ') };
}

function acceptable(ctx, e, c, propertyId, outcomes) {
	if (e.known_bad_result === 'SURVIVED' && e.execution?.runner !== 'mutation') return { ok: false, why: 'known-bad check survived' };
	if (e.structural && ctx.structural.has(`${c.id}.${propertyId}`)) {
		if (!structuralOk(ctx, e)) return { ok: false, why: 'structural evidence incomplete (primitive, call_site, standard_library, client_selectable, executable)' };
		const o = outcomes.evidence[e.id];
		return o === 'PASS' ? { ok: true, structural: true } : { ok: false, why: `execution ${o ?? 'NOT_RUN'}` };
	}
	const cls = ctx.evidenceClass[e.type];
	const required = ctx.p.required_types_by_level[c.minimum_evidence_level] ?? [];
	if (isExecutable(e)) {
		const o = outcomes.evidence[e.id];
		if (e.execution.runner === 'mutation') {
			const kb = knownBadEffective(ctx, e, c.id, propertyId, outcomes);
			if (!kb.ok) return kb;
		} else if (o !== 'PASS') return { ok: false, why: `execution ${o ?? 'NOT_RUN'}` };
		if (e.type === 'real-system') { const rs = realSystemObserved(ctx, e, c.id, propertyId, outcomes); if (!rs.ok) return rs; }
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

const NO_DEVIATION = { props: new Set(), type: null, ids: [] };
export function evaluateControl(ctx, def, c, outcomes, deviation = NO_DEVIATION, derived = {}) {
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
		const sats = [], partial = [], insufficient = [], structural = [];
		const isMeta = ctx.metaProps.has(`${c.id}.${p.id}`);
		for (const { e, cv } of covers) {
			if (cv.result !== 'SUPPORTS' || !cv.properties.includes(p.id)) continue;
			if (cv.scope === 'PARTIAL') { partial.push(e.id); continue; }
			const a = acceptable(ctx, e, c, p.id, outcomes);
			// Phase 2W: a meta-derived property never takes credit from an evidence item of its own.
			if (isMeta) { insufficient.push(`${e.id}(${e.level}: ${a.ok ? 'not counted for a meta-derived property' : a.why})`); continue; }
			// A structural property (profile allowlist only) is met at the rule's own minimum level.
			const minimum = a.structural ? ctx.p.structural_property_rule.minimum_level : c.minimum_evidence_level;
			if (a.ok && rank(ctx, e.level) >= rank(ctx, minimum)) { sats.push(e); if (a.structural) structural.push(e.id); }
			else insufficient.push(`${e.id}(${e.level}${e.reproducible ? '' : ',non-reproducible'}${a.ok ? '' : `: ${a.why}`})`);
		}
		detail[p.id] = { satisfied_by: sats.map((e) => e.id), partial_only: partial, insufficient };
		if (structural.length) detail[p.id].structurally_verified_by = structural;
		if (isMeta) { const d = derived[p.id] ?? { rule: 'UNEVALUATED', ok: false, level: null, properties: 0, failing: ['meta derivation not evaluated'] }; detail[p.id].derived = { rule: d.rule, ok: d.ok, level: d.level, properties: d.properties, failing: d.failing }; }
		if (sats.some((e) => !e.reproducible)) anyManual = true;
	}
	const met = (k) => detail[k].satisfied_by.length > 0 || detail[k].derived?.ok === true;
	const unsat = (ids) => ids.filter((k) => !detail[k].deviated && !met(k) && !defects.some((d) => d.pid === k));
	const derivedWhy = (k) => { const d = detail[k].derived; return d && !d.ok ? ` (derived ${d.rule}: ${d.failing.slice(0, 4).join(' | ')}${d.failing.length > 4 ? ` | +${d.failing.length - 4} more` : ''})` : ''; };
	const why = (k) => `${k} unsatisfied${derivedWhy(k)}${detail[k].partial_only.length ? ` (partial only: ${detail[k].partial_only.join(',')})` : ''}${detail[k].insufficient.length ? ` (below ${c.minimum_evidence_level}/not acceptable: ${detail[k].insufficient.join(',')})` : ''}`;
	const all = c.properties.map((p) => p.id);
	let security, sreason;
	if (defects.length) { security = 'FAIL'; sreason = defects.map((d) => d.text).join('; '); }
	else if (unsat(all).length) { security = 'MISSING_EVIDENCE'; sreason = unsat(all).map(why).join('; '); }
	else if (deviated.size) { security = 'INFORMATIONAL'; sreason = `${[...deviated].join('+')} covered by accepted ${deviation.type} deviation; all ${all.length - deviated.size} remaining sub-properties satisfied at >= ${c.minimum_evidence_level}; no defect`; }
	else {
		security = anyManual ? 'PASS_MANUAL' : 'PASS_AUTOMATED';
		// Properties met ONLY by structural evidence are named: structurally verified, not mutation-proven.
		const structuralOnly = all.filter((k) => detail[k].structurally_verified_by && detail[k].structurally_verified_by.length === detail[k].satisfied_by.length);
		const derivedProps = all.filter((k) => detail[k].derived?.ok);
		sreason = structuralOnly.length
			? `all ${all.length} sub-properties satisfied; ${structuralOnly.join('+')} structurally verified (${ctx.p.structural_property_rule.minimum_level}, not behaviourally mutation-proven), the rest at >= ${c.minimum_evidence_level}`
			: `all ${all.length} sub-properties satisfied at >= ${c.minimum_evidence_level}${derivedProps.length ? ` (${derivedProps.map((k) => `${k} derived by ${detail[k].derived.rule} over ${detail[k].derived.properties} properties`).join('; ')})` : ''}`;
	}
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
/** Evaluates every control; controls with meta-derived properties last, from the results of all others (Phase 2W). */
function evaluateAll(ctx, def, outcomes, deviationOf) {
	const out = {};
	const metaControls = new Set(ctx.metaRules.map((r) => r.control));
	for (const c of def.controls.controls) if (!metaControls.has(c.id)) out[c.id] = evaluateControl(ctx, def, c, outcomes, deviationOf(c.id));
	for (const c of def.controls.controls) if (metaControls.has(c.id)) {
		const derived = Object.fromEntries(ctx.metaRules.filter((r) => r.control === c.id).map((r) => [r.property, deriveMetaProperty(ctx, def, r, out, outcomes)]));
		out[c.id] = evaluateControl(ctx, def, c, outcomes, deviationOf(c.id), derived);
	}
	return out;
}

export function evaluate(def, outcomes) {
	const ctx = context(def);
	const baseline = evaluateAll(ctx, def, outcomes, () => NO_DEVIATION);
	const deviationResults = Object.fromEntries(def.deviations.deviations.map((d) => [d.id, validateDeviation(ctx, def, d, baseline)]));
	const devStatus = Object.fromEntries(Object.entries(deviationResults).map(([k, v]) => [k, v.status]));
	const deviations = Object.fromEntries(def.controls.controls.map((c) => [c.id, deviatedFor(def, devStatus, c.id)]));
	const final = Object.values(deviations).some((dv) => dv.ids.length) ? evaluateAll(ctx, def, outcomes, (id) => (deviations[id].ids.length ? deviations[id] : NO_DEVIATION)) : baseline;
	const controls = def.controls.controls.map((c) => {
		const dv = deviations[c.id];
		const r = final[c.id];
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
		for (const p of c.properties) if (p.evidence_basis === 'STRUCTURAL' && !ctx.structural.has(`${c.id}.${p.id}`)) err('STRUCTURAL_BASIS_NOT_ALLOWED', `${c.id}.${p.id}: not in profile.structural_property_rule.allowed`);
	}
	for (const a of def.profile.structural_property_rule?.allowed ?? []) if (!ctx.structural.has(`${a.control}.${a.property}`)) err('STRUCTURAL_ALLOWLIST_UNMARKED', `${a.control}.${a.property}: allowlisted but the property is unknown or not marked evidence_basis STRUCTURAL`);
	// Phase 2U: every concurrency claim (domain CR-CONC, or a property text naming concurrency) is marked in the profile; marked entries must exist.
	const marked = new Set((def.profile.real_system_observation?.concurrency?.properties ?? []).map((x) => `${x.control}.${x.property}`));
	for (const c of def.controls.controls) for (const p of c.properties) if (isConcurrencyClaim(c, p) && !marked.has(`${c.id}.${p.id}`)) err('CONCURRENCY_CLAIM_UNMARKED', `${c.id}.${p.id}: not in profile.real_system_observation.concurrency.properties`);
	for (const k of marked) { const [cid, pid] = k.split('.'); if (!ctx.ctlById.get(cid)?.properties.some((p) => p.id === pid)) err('CONCURRENCY_CLAIM_UNKNOWN', k); }
	// Phase 2W: a meta rule names a real property, keeps its control at a real-system level, and no real-system item covers it directly.
	for (const r of ctx.metaRules) {
		const c = ctx.ctlById.get(r.control);
		if (!c?.properties.some((p) => p.id === r.property) || !META_RULES[r.rule]) { err('META_RULE_UNKNOWN', `${r.control}.${r.property} (${r.rule})`); continue; }
		if (!(def.profile.required_types_by_level[c.minimum_evidence_level] ?? []).includes('real-system')) err('META_RULE_NOT_REAL_SYSTEM', `${r.control}: minimum ${c.minimum_evidence_level} does not require real-system evidence`);
	}
	for (const e of def.evidence.evidence) for (const cv of e.covers) for (const pid of cv.properties) if (ctx.metaProps.has(`${cv.control}.${pid}`) && e.type === 'real-system' && cv.result === 'SUPPORTS') err('META_PROPERTY_DIRECT_EVIDENCE', `${e.id} -> ${cv.control}.${pid}: a meta-derived property is computed from the evidence graph, not covered by an item`);
	const cap = def.profile.evidence_level_cap_by_type ?? {};
	for (const e of def.evidence.evidence) {
		// Phase 2C (F-2C-3): a self-declared level may not exceed what the evidence type can show.
		if (cap[e.type] && ctx.levels.indexOf(e.level) > ctx.levels.indexOf(cap[e.type])) err('LEVEL_EXCEEDS_TYPE', `${e.id}: ${e.type} capped at ${cap[e.type]}, declared ${e.level}`);
		// Phase 2D (F-2D-1): "real-system" must actually need real infrastructure; a plain node test cannot call itself real-system.
		if (e.type === 'real-system' && e.reproducible && !(e.execution?.environment ?? []).some((x) => x !== 'node')) err('REAL_SYSTEM_WITHOUT_INFRASTRUCTURE', `${e.id}: real-system evidence must require a real-system capability (e.g. postgres)`);
		// Phase 2U (F-2T-1): only the runner can observe real-system use, so such evidence must be executable and unfiltered (an observation covers whole files).
		if (e.type === 'real-system' && e.reproducible && (!isExecutable(e) || e.execution.runner !== 'node-test' || e.execution.test_names?.length)) err('REAL_SYSTEM_NOT_OBSERVABLE', `${e.id}: real-system evidence must be a node-test item over whole files`);
		for (const cv of e.covers) {
			const c = ctx.ctlById.get(cv.control);
			if (!c) { err('UNKNOWN_CONTROL_REFERENCE', `${e.id} -> ${cv.control}`); continue; }
			for (const pid of cv.properties) if (!c.properties.some((p) => p.id === pid)) err('UNKNOWN_PROPERTY_REFERENCE', `${e.id} -> ${cv.control}.${pid}`);
			if (cv.scope === 'PARTIAL' && !cv.note) err('PARTIAL_WITHOUT_REASON', `${e.id} -> ${cv.control}`);
		}
		if (e.structural) {
			const targets = e.covers.flatMap((cv) => cv.properties.map((p) => `${cv.control}.${p}`));
			if (!targets.length || targets.some((t) => !ctx.structural.has(t))) err('STRUCTURAL_EVIDENCE_MISPLACED', `${e.id}: structural evidence may only cover allowlisted structural properties`);
			if (!structuralOk(ctx, e)) err('STRUCTURAL_EVIDENCE_INCOMPLETE', e.id);
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
			const counted = cases.filter((m) => m.expected_result !== 'EQUIVALENT');
			const declaredKb = !counted.length ? 'MIXED' : counted.every((m) => m.expected_result === 'KILLED') ? 'KILLED' : counted.every((m) => m.expected_result === 'SURVIVED') ? 'SURVIVED' : 'MIXED';
			if (declaredKb === 'MIXED' || e.known_bad_result !== declaredKb) err('KNOWN_BAD_RESULT_MISMATCH', `${e.id}: declared ${e.known_bad_result}, cases ${declaredKb}`);
			if (!e.known_bad_checked) err('KNOWN_BAD_FLAG', e.id);
		} else if (e.type === 'known-bad' && e.reproducible) err('KNOWN_BAD_WITHOUT_MUTATION_RUNNER', `${e.id}: reproducible known-bad evidence must be backed by mutation cases`);
	}
	for (const m of def.mutations.cases) {
		if (!ctx.evById.has(m.evidence_id)) err('UNKNOWN_EVIDENCE_REFERENCE', `${m.id} -> ${m.evidence_id}`);
		for (const t of m.targets) { const c = ctx.ctlById.get(t.control); if (!c || !c.properties.some((p) => p.id === t.property)) err('UNKNOWN_CONTROL_REFERENCE', `${m.id} -> ${t.control}.${t.property}`); }
		if (m.expected_result === 'KILLED' && !m.expected_failures.length) err('MUTATION_WITHOUT_EXPECTED_FAILURE', m.id);
		if (m.expected_result === 'EQUIVALENT' && !(m.equivalence?.kind && typeof m.equivalence.proof === 'string' && m.equivalence.proof.length >= 80)) err('EQUIVALENT_WITHOUT_PROOF', m.id);
		if (m.expected_result !== 'EQUIVALENT' && m.equivalence) err('EQUIVALENCE_ON_NON_EQUIVALENT', m.id);
		if (m.expected_result === 'EQUIVALENT' && m.expected_failures.length) err('EQUIVALENT_WITH_EXPECTED_FAILURE', m.id);
		if (m.layering === 'MULTI_LAYER' && (m.edits.length < 2 || !(typeof m.layering_rationale === 'string' && m.layering_rationale.length >= 40))) err('MULTI_LAYER_WITHOUT_RATIONALE', m.id);
		if (m.layering !== 'MULTI_LAYER' && m.layering_rationale) err('RATIONALE_WITHOUT_MULTI_LAYER', m.id);
	}
	// Phase 2E: a finding recorded as FIXED must cite behavioural KILLED mutation cases that target exactly the
	// violated property, and no VIOLATION for that property may remain - "fixed" cannot be declared, only proven.
	for (const ch of def['framework-changes'].versions.flatMap((v) => v.changes)) {
		const f = ch.finding;
		if (!f || f.status_after !== 'FIXED') continue;
		const why = [];
		if (ch.kind !== 'FINDING_FIXED') why.push(`kind ${ch.kind} is not FINDING_FIXED`);
		const cases = f.mutation_ids.map((id) => def.mutations.cases.find((m) => m.id === id));
		if (cases.some((m) => !m || m.expected_result !== 'KILLED' || m.detection !== 'behavioral' || !m.targets.some((t) => t.control === f.control && t.property === f.property))) why.push(`mutation cases must exist, be behavioural KILLED and target ${f.control}.${f.property}`);
		if (def.evidence.evidence.some((e) => e.covers.some((c) => c.control === f.control && c.properties.includes(f.property) && c.result === 'VIOLATION'))) why.push(`a VIOLATION of ${f.control}.${f.property} is still recorded`);
		if (why.length) err('FINDING_FIX_NOT_PROVEN', `${ch.id}: ${why.join('; ')}`);
	}
	// Phase 2J (F-2J-1): every finding is typed and every application finding is mapped or explicitly unmapped;
	// a mapping must name a real control property, and an OPEN mapped finding must be visible as a VIOLATION there.
	const knownProperty = (control, property) => Boolean(ctx.ctlById.get(control)?.properties.some((p) => p.id === property));
	for (const ch of def['framework-changes'].versions.flatMap((v) => v.changes)) {
		if (ch.kind === 'NEW_FINDING') {
			const why = [];
			if (!FINDING_CLASSES.includes(ch.finding_class)) why.push('finding_class missing');
			if (ch.finding_class === 'APPLICATION' && !ch.mapping) why.push('mapping missing (map to a control property or declare it unmapped with a reason)');
			if (why.length) err('FINDING_RECORD_INCOMPLETE', `${ch.id}: ${why.join('; ')}`);
		}
		if (['NEW_FINDING', 'FINDING_MAPPED'].includes(ch.kind) && ch.mapping?.control && !knownProperty(ch.mapping.control, ch.mapping.property)) err('FINDING_MAPPING_UNKNOWN', `${ch.id} -> ${ch.mapping.control}.${ch.mapping.property}`);
		if (ch.kind === 'FINDING_MAPPED' && !ch.mapping?.control) err('FINDING_RECORD_INCOMPLETE', `${ch.id}: FINDING_MAPPED must name a control property`);
		if (ch.finding && !knownProperty(ch.finding.control, ch.finding.property)) err('FINDING_MAPPING_UNKNOWN', `${ch.id} -> ${ch.finding.control}.${ch.finding.property}`);
	}
	const ledger = findingLedger(def);
	for (const f of ledger.values()) {
		if (f.duplicate) err('DUPLICATE_FINDING', f.id);
		if (!blocksRelease(f) || !f.mapping?.control) continue;
		if (!def.evidence.evidence.some((e) => e.covers.some((c) => c.control === f.mapping.control && c.properties.includes(f.mapping.property) && c.result === 'VIOLATION'))) err('FINDING_NOT_REFLECTED', `${f.id}: OPEN and mapped to ${f.mapping.control}.${f.mapping.property}, but no VIOLATION is recorded there`);
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
		if (r.security_status.startsWith('PASS') || r.security_status === 'INFORMATIONAL') for (const [pid, v] of Object.entries(r.property_coverage)) if (!v.deviated && !v.satisfied_by.length && v.derived?.ok !== true) err('PASS_WITHOUT_EVIDENCE', `${c.id}.${pid}`);
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

/* ====================================================== pinned sources */
/**
 * Phase 2D (CR-VERIFY-011): the derivation inputs are pinned. The vendored
 * requirement file must match its recorded checksum, and the applicability list
 * must cover exactly its requirements at their levels. `read(path)` returns the
 * bytes of a repository file.
 */
export function checkPinnedSources(def, read) {
	const errors = []; const err = (code, detail) => errors.push({ code, detail });
	for (const v of def.sources.vendored) if (sha256(read(v.path)) !== v.sha256) err('VENDORED_CHECKSUM', v.path);
	const pinned = JSON.parse(read(def['asvs-applicability'].input).toString('utf8')).requirements;
	const items = def['asvs-applicability'].items;
	if (pinned.length !== items.length) err('ASVS_COUNT_MISMATCH', `${items.length} != ${pinned.length}`);
	for (const r of pinned) { const i = items.find((x) => x.req_id === r.req_id); if (!i) err('ASVS_REQUIREMENT_MISSING', r.req_id); else if (i.level !== `L${r.L}`) err('ASVS_LEVEL_MISMATCH', r.req_id); }
	return errors;
}

/* ========================================================= findings ledger */
/**
 * Phase 2J (F-2J-1): the findings ledger, replayed from framework-changes in version order.
 * NEW_FINDING opens a finding (typed, application findings mapped or explicitly unmapped);
 * FINDING_MAPPED changes its mapping; FINDING_FIXED closes it (an application finding only with a
 * proven FIXED block); FINDING_WITHDRAWN closes it with a documented resolution.
 */
export const FINDING_CLASSES = ['APPLICATION', 'FRAMEWORK', 'INFORMATIONAL'];
export function findingLedger(def) {
	const ledger = new Map();
	for (const v of def['framework-changes'].versions) for (const ch of v.changes) {
		if (ch.kind === 'NEW_FINDING') {
			if (ledger.has(ch.id)) { ledger.get(ch.id).duplicate = true; continue; }
			ledger.set(ch.id, { id: ch.id, finding_class: ch.finding_class ?? null, mapping: ch.mapping ?? null, status: 'OPEN', opened_in: v.crsf_version, closed_in: null });
			continue;
		}
		const f = ledger.get(ch.id);
		if (!f) continue;
		if (ch.kind === 'FINDING_MAPPED') f.mapping = ch.mapping ?? null;
		else if (ch.kind === 'FINDING_FIXED' && (f.finding_class !== 'APPLICATION' || ch.finding?.status_after === 'FIXED')) {
			Object.assign(f, { status: 'FIXED', closed_in: v.crsf_version });
			if (ch.finding) f.mapping = { control: ch.finding.control, property: ch.finding.property };
		} else if (ch.kind === 'FINDING_WITHDRAWN' && typeof ch.resolution === 'string' && ch.resolution.length >= 40) Object.assign(f, { status: 'WITHDRAWN', closed_in: v.crsf_version });
	}
	return ledger;
}
/** An OPEN application finding blocks the release; framework findings and informational notes do not. */
export const blocksRelease = (f) => f.status === 'OPEN' && f.finding_class === 'APPLICATION';
/** OPEN application findings without a control property: no control status can show them, so they fail the release directly. */
export const openUnmappedFindings = (def) => [...findingLedger(def).values()].filter((f) => blocksRelease(f) && !f.mapping?.control).map((f) => f.id).sort();
/** The release assertion. An open unmapped application finding is a FAIL regardless of control statuses. */
export function releaseAssertion({ frameworkValid, releaseBlockingStatuses, evidenceFailures = 0, guardProblems = 0, openUnmapped = [] }) {
	if (!frameworkValid) return 'NOT_EVALUABLE';
	if (openUnmapped.length || releaseBlockingStatuses.includes('FAIL') || evidenceFailures || guardProblems) return 'FAIL';
	return releaseBlockingStatuses.every((s) => s === 'PASS_AUTOMATED') ? 'PASS' : 'INCOMPLETE_EVIDENCE';
}

/* =========================================================== version lock */
/** Phase 2D (CR-VERIFY-011): the derivation of a control - what it requires and from which source - is locked too, not only its threshold. */
export const DERIVATION_FIELDS = ['title', 'domain', 'source_refs', 'derivation_type', 'external_requirement', 'coverraccoon_requirement', 'applicability_reason', 'profile_level', 'applies_to', 'threat', 'expected_property', 'automation'];
export const derivationOf = (c) => Object.fromEntries(DERIVATION_FIELDS.map((k) => [k, c[k] ?? null]));
export function lockEntry(c) {
	return { release_class: c.release_class, minimum_evidence_level: c.minimum_evidence_level, applicability: c.applicability, external_requirement_ids: c.external_requirement_ids, properties_digest: sha256(c.properties), derivation_digest: sha256(derivationOf(c)) };
}
export function profileLockDigest(profile) {
	return sha256({ release_classes: profile.release_classes, minimum_levels: profile.minimum_levels, required_types_by_level: profile.required_types_by_level, acceptance_rules: profile.acceptance_rules, deviation_rules: profile.deviation_rules, evidence_levels: profile.evidence_levels, evidence_level_cap_by_type: profile.evidence_level_cap_by_type ?? null, structural_property_rule: profile.structural_property_rule ?? null,
		// Phase 2W: the concurrency marking and the meta rules decide what CR-VERIFY-004 requires - both are locked.
		real_system_observation: profile.real_system_observation ?? null, meta_control_derivation: profile.meta_control_derivation ?? null });
}
/** Change kinds that may alter what a control requires (properties or derivation) - each needs documented before/after wording. */
export const REQUIREMENT_CHANGE_KINDS = ['REQUIREMENT_CLARIFICATION', 'PROPERTY_ADDED', 'EVIDENCE_BASIS_CHANGE'];
export function buildLock(def) {
	return { crsf_version: def.profile.crsf_version, profile_rules_digest: profileLockDigest(def.profile), controls: Object.fromEntries([...def.controls.controls].sort((a, b) => a.id.localeCompare(b.id)).map((c) => [c.id, lockEntry(c)])),
		findings: Object.fromEntries([...findingLedger(def).values()].sort((a, b) => a.id.localeCompare(b.id)).map((f) => [f.id, { finding_class: f.finding_class, opened_in: f.opened_in }])) };
}
function checkLock(def, ctx) {
	const errors = []; const err = (code, detail) => errors.push({ code, detail });
	const lock = def['framework-lock']; const version = def.profile.crsf_version;
	const now = buildLock(def);
	// Phase 2J (F-2J-1): findings are append-only. A finding once locked can be closed (fixed or withdrawn
	// with a documented resolution) but never deleted or retyped - otherwise an open finding could vanish.
	for (const [id, old] of Object.entries(lock.findings ?? {})) {
		const cur = now.findings[id];
		if (!cur) err('FINDING_DELETED_SILENTLY', id);
		else if (cur.finding_class !== old.finding_class && old.finding_class !== null) err('FINDING_RECLASSIFIED_SILENTLY', `${id}: ${old.finding_class} -> ${cur.finding_class}`);
	}
	const findingsChanged = lock.findings !== undefined && canonical(lock.findings) !== canonical(now.findings);
	if (findingsChanged && lock.crsf_version === version) err('FINDINGS_CHANGED_WITHOUT_VERSION', 'the findings ledger differs from framework-lock.json at the same crsf_version');
	const changed = [];
	for (const [id, old] of Object.entries(lock.controls)) {
		const cur = now.controls[id];
		if (!cur) { changed.push({ id, kind: 'REMOVED', old }); continue; }
		const diffs = Object.keys(old).filter((k) => canonical(old[k]) !== canonical(cur[k]));
		if (diffs.length) changed.push({ id, kind: 'CHANGED', diffs, old, cur });
	}
	for (const id of Object.keys(now.controls)) if (!lock.controls[id]) changed.push({ id, kind: 'ADDED' });
	const profileChanged = lock.profile_rules_digest !== now.profile_rules_digest;
	if (!changed.length && !profileChanged) {
		if (lock.crsf_version !== version) {
			if (!def['framework-changes'].versions.some((v) => v.crsf_version === version)) err('VERSION_WITHOUT_CHANGE_RECORD', version);
			else err('LOCK_UPDATE_REQUIRED', `framework-lock.json is at ${lock.crsf_version}; regenerate with crsf-gen --write`);
		}
		return errors;
	}
	if (lock.crsf_version === version) {
		if (profileChanged) err('PROFILE_CHANGED_WITHOUT_VERSION', 'profile rules differ from framework-lock.json at the same crsf_version');
		for (const ch of changed) {
			const reduction = ch.kind === 'CHANGED' && (ch.diffs.includes('minimum_evidence_level') && ctx.levels.indexOf(ch.cur.minimum_evidence_level) < ctx.levels.indexOf(ch.old.minimum_evidence_level));
			const weakened = ch.kind === 'CHANGED' && ch.diffs.includes('release_class') && ch.old.release_class === 'RELEASE_BLOCKING';
			const has = (k) => ch.kind === 'CHANGED' && ch.diffs.includes(k);
			const code = reduction ? 'THRESHOLD_REDUCED_SILENTLY' : weakened ? 'RELEASE_CLASS_CHANGED_SILENTLY' : ch.kind === 'REMOVED' ? 'CONTROL_DELETED_SILENTLY'
				: has('applicability') ? 'APPLICABILITY_CHANGED_SILENTLY' : has('external_requirement_ids') || has('derivation_digest') ? 'DERIVATION_CHANGED_SILENTLY' : has('properties_digest') ? 'PROPERTIES_CHANGED_SILENTLY' : 'FRAMEWORK_CHANGED_WITHOUT_VERSION';
			err(code, `${ch.id}${ch.diffs ? ` (${ch.diffs.join(', ')})` : ''}`);
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
		if (ch.kind === 'CHANGED' && ch.diffs.includes('applicability') && rec.kind !== 'APPLICABILITY_CHANGE') err('APPLICABILITY_CHANGE_NOT_DECLARED', ch.id);
		// Phase 2D: a changed requirement (properties or derivation) must carry its exact before/after wording, a rationale and why it is not a weakening.
		const requirementChanged = ch.kind === 'CHANGED' && (ch.diffs.includes('properties_digest') || ch.diffs.includes('derivation_digest') || ch.diffs.includes('external_requirement_ids'));
		if (requirementChanged) {
			const why = [];
			if (!REQUIREMENT_CHANGE_KINDS.includes(rec.kind)) why.push(`kind ${rec.kind} is not one of ${REQUIREMENT_CHANGE_KINDS.join('/')}`);
			if (!(typeof rec.rationale === 'string' && rec.rationale.length >= 40)) why.push('rationale missing');
			if (!(typeof rec.why_not_weakening === 'string' && rec.why_not_weakening.length >= 40)) why.push('why_not_weakening missing');
			if (ch.diffs.includes('properties_digest') && (sha256(rec.before?.properties ?? null) !== ch.old.properties_digest || sha256(rec.after?.properties ?? null) !== ch.cur.properties_digest)) why.push('before/after properties do not match the lock and the definition');
			if (ch.diffs.includes('derivation_digest') && (sha256(rec.before?.derivation ?? null) !== ch.old.derivation_digest || sha256(rec.after?.derivation ?? null) !== ch.cur.derivation_digest)) why.push('before/after derivation does not match the lock and the definition');
			if (why.length) err('REQUIREMENT_CHANGE_NOT_DOCUMENTED', `${ch.id}: ${why.join('; ')}`);
		}
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
