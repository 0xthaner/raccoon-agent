/*
	Renders security/crsf/CRSF-1.0.md from the JSON definition. Generated output:
	never edit the Markdown by hand; crsf-gen --check fails when it is stale.
*/
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const tally = (arr, f) => {
	const out = {};
	for (const x of arr) { const k = f(x); out[k] = (out[k] ?? 0) + 1; }
	return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};
const list = (o) => Object.entries(o).map(([k, v]) => `- ${k}: ${v}`);

export function renderMarkdown(def) {
	const p = def.profile;
	const controls = def.controls.controls;
	const evidence = def.evidence.evidence;
	const deviations = def.deviations.deviations;
	const asvs = def['asvs-applicability'].items;
	const cases = def.mutations.cases;
	const L = [];
	L.push(`# CoverRaccoon Security Framework — CRSF ${p.crsf_version}`, '');
	L.push('> Generated from `security/crsf/*.json` by `security/crsf/generator/crsf-gen.mjs`. Do not edit by hand.', '>', '> CoverRaccoon is **mapped against and evaluated against** the pinned sources below. This document is not a certification and makes no compliance claim. The statuses here are the *declared* evaluation of the definition; `npm run security:verify` recomputes them from executed evidence for a specific commit.', '');
	L.push('## 1. Declared evaluation', '', '### Security assurance', '', ...list(tally(controls, (c) => c.security_status)), '');
	L.push('### Release classes', '', ...list(tally(controls, (c) => c.release_class)), '');
	L.push('### Release-blocking controls by security status', '', ...list(tally(controls.filter((c) => c.release_class === 'RELEASE_BLOCKING'), (c) => c.security_status)), '');
	L.push('### Standard conformance (ASVS 5.0.0, applicable requirements)', '', ...list(tally(asvs.filter((i) => i.applicability === 'APPLICABLE'), (i) => i.conformance_status)), '');
	L.push(`ASVS: ${asvs.length} requirements — ${Object.entries(tally(asvs, (i) => i.applicability)).map(([k, v]) => `${k} ${v}`).join(', ')}. Profile: ${esc(p.asvs_target.baseline)}; selected L3: ${p.asvs_target.selected_l3.join(', ')}.`, '');
	L.push('## 2. Evidence levels and rules', '', ...p.evidence_levels.map((l) => `- **${l.id}** — ${esc(l.meaning)}`), '', ...p.acceptance_rules.map((r) => `- ${esc(r)}`), '');
	L.push('## 3. Deviations', '', '| ID | Type | Control | Requirement | Status | Owner sign-off |', '|---|---|---|---|---|---|');
	for (const d of deviations) L.push(`| ${d.id} | ${d.type} | ${d.control_ids.join(', ')} | ${d.external_requirement_ids.join(', ')} | ${d.status} | ${d.owner_signoff} |`);
	L.push('');
	for (const d of deviations.filter((x) => x.status === 'ACCEPTED')) {
		L.push(`### ${d.id}`, '', `- Conflict: ${esc(d.conflicting_requirement)}`, `- Required by: ${esc(d.required_protocol_source.join('; '))} — ${esc(d.required_protocol_requirement)}`, `- Security impact: ${esc(d.security_impact)}`, `- Risk: ${esc(d.risk_assessment)}`, `- Mitigations: ${esc(d.mitigations.join('; '))}`, `- Review triggers: ${d.review_triggers.map((t) => t.code).join(', ')}`);
		for (const q of d.evidence_questions ?? []) L.push(`- Evidence question ${q.id} (${q.status}): ${esc(q.question)} — ${esc(q.answer)} Impact: ${esc(q.impact_classification)}`);
		for (const x of d.evidence_properties ?? []) L.push(`- Evidence property ${x.id}: ${esc(x.evidence)} (counts for security status: ${x.counts_for_security_status ? 'yes' : 'no'})`);
		L.push('');
	}
	L.push('## 4. Controls', '', '| ID | Title | Class | Min | Security | Conformance | Reason |', '|---|---|---|---|---|---|---|');
	for (const c of controls) L.push(`| ${c.id} | ${esc(c.title)} | ${c.release_class} | ${c.minimum_evidence_level} | **${c.security_status}** | ${c.conformance_status} | ${esc(c.security_status_reason)} |`);
	L.push('', '## 5. Evidence', '', '| ID | Type | Level | Runner | Coverage | Reproducible | Proves |', '|---|---|---|---|---|---|---|');
	for (const e of evidence) L.push(`| ${e.id} | ${e.type} | ${e.level} | ${e.execution.runner} | ${e.coverage} | ${e.reproducible ? 'yes' : 'no'} | ${esc(e.property_proven)} |`);
	L.push('', '## 6. Mutation cases', '', `${cases.length} cases in \`security/mutation/cases.json\`. Static-detection kills never count as E4.`, '', '| ID | Targets | Detection | Expected |', '|---|---|---|---|');
	for (const m of cases) L.push(`| ${m.id} | ${m.targets.map((t) => `${t.control}.${t.property}`).join(', ')} | ${m.detection} | ${m.expected_result} |`);
	L.push('', '## 7. ASVS applicable requirements', '', '| Requirement | Level | Controls | Conformance |', '|---|---|---|---|');
	for (const i of asvs.filter((x) => x.applicability === 'APPLICABLE')) L.push(`| ${i.req_id} | ${i.level} | ${i.controls.join(', ')} | ${i.conformance_status} |`);
	L.push('', '## 8. Pinned sources', '', '| ID | Title | Version | Pin |', '|---|---|---|---|');
	for (const s of def.sources.sources) L.push(`| ${s.id} | [${esc(s.title)}](${s.url}) | ${esc(s.version)} | ${esc(s.pin)} |`);
	L.push('', '## 9. Drift model', '', esc(def['drift-model'].mandatory_global), '', '| Path | Domains |', '|---|---|');
	for (const r of def['drift-model'].rules) L.push(`| \`${r.pattern}\` | ${r.domains.join(', ')} |`);
	L.push('', '## 10. Framework versions', '');
	for (const v of def['framework-changes'].versions) L.push(`- **${v.crsf_version}** — ${esc(v.summary)}`);
	L.push('');
	return L.join('\n') + '\n';
}
