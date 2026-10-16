#!/usr/bin/env node
/*
	CRSF generator: fills the COMPUTED fields of the definition from its
	authoritative inputs and renders CRSF-1.0.md. It never changes an input
	(control definitions, evidence mapping, mutation cases, deviation records,
	applicability decisions, profile thresholds).

	  node security/crsf/generator/crsf-gen.mjs --check   # exit 1 if any computed field or the Markdown is stale
	  node security/crsf/generator/crsf-gen.mjs --write   # rewrite computed fields + CRSF-1.0.md

	framework-lock.json is written only when it is missing (bootstrap) or when the
	crsf_version was bumped AND every control change is recorded in
	framework-changes.json for that version. A silent change at the same version
	is refused, so the lock cannot be used to launder a weakened threshold.
*/
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDefinition, declaredOutcomes, evaluate, buildLock, checkIntegrity } from '../lib/engine.mjs';
import { renderMarkdown } from './gen-md.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MUTATIONS = path.resolve(ROOT, '../mutation/cases.json');

const serialize = (data) => JSON.stringify(data, null, '\t') + '\n';

export function generate(def) {
	const ev = evaluate(def, declaredOutcomes(def));
	const byId = new Map(ev.controls.map((c) => [c.id, c]));
	// input fields first, computed fields after
	const controls = { ...def.controls };
	controls.controls = def.controls.controls.map((c) => {
		const computed = byId.get(c.id);
		const input = strip(c, CONTROL_COMPUTED);
		const { id, ...rest } = computed;
		return { ...input, ...rest };
	});
	const ctlById = new Map(def.controls.controls.map((c) => [c.id, c]));
	const evidence = { ...def.evidence, evidence: def.evidence.evidence.map((e) => {
		const partial = e.covers.filter((cv) => cv.scope === 'PARTIAL' || cv.properties.length < (ctlById.get(cv.control)?.properties.length ?? 0));
		return { ...e,
			control_ids: [...new Set(e.covers.map((cv) => cv.control))].sort(),
			coverage: partial.length ? 'PARTIAL' : 'FULL',
			reason_for_partial: partial.length ? partial.map((cv) => `${cv.control}[${cv.properties.join(',')}]: ${cv.note ?? 'covers a subset of sub-properties'}`).join('; ') : null };
	}) };
	const deviations = { ...def.deviations, deviations: def.deviations.deviations.map((d) => {
		const v = ev.deviations[d.id];
		return { ...strip(d, ['status', 'validation']), status: v.status, validation: { unmet_criteria: v.unmet_criteria, machine_check_failures: v.machine_check_failures } };
	}) };
	const asvsById = new Map(ev.asvs.map((a) => [a.req_id, a]));
	const asvs = { ...def['asvs-applicability'], items: def['asvs-applicability'].items.map((i) => {
		const a = asvsById.get(i.req_id);
		return { req_id: i.req_id, level: i.level, applicability: i.applicability, reason: i.reason, controls: a.controls, conformance_status: a.conformance_status, release_relevance: a.release_relevance ?? 'NONE' };
	}) };
	return { controls, evidence, deviations, 'asvs-applicability': asvs };
}
const CONTROL_COMPUTED = ['required_evidence_types', 'current_evidence_ids', 'property_coverage', 'conformance_status', 'conformance_status_reason', 'security_status', 'security_status_reason', 'deviation_ids', 'independence'];
const strip = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

function main() {
	const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--check') ? 'check' : null;
	if (!mode) { console.error('usage: crsf-gen.mjs --check | --write'); process.exitCode = 64; return; }
	const def = loadDefinition(ROOT, MUTATIONS);
	if (!def['framework-lock']) def['framework-lock'] = buildLock(def);
	const generated = generate(def);
	const stale = [];
	for (const [name, data] of Object.entries(generated)) {
		const file = path.join(ROOT, `${name}.json`);
		if (readFileSync(file, 'utf8') !== serialize(data)) stale.push(`${name}.json`);
	}
	const nextDef = { ...def, ...generated };
	const md = renderMarkdown(nextDef);
	const mdFile = path.join(ROOT, 'CRSF-1.0.md');
	if (!existsSync(mdFile) || readFileSync(mdFile, 'utf8') !== md) stale.push('CRSF-1.0.md');

	// lock handling
	const lockFile = path.join(ROOT, 'framework-lock.json');
	let lockAction = 'unchanged';
	if (!existsSync(lockFile)) lockAction = 'bootstrap';
	else {
		const lockErrors = checkIntegrity(nextDef, declaredOutcomes(nextDef)).errors.filter((e) => /LOCK|VERSION|SILENTLY|CHANGE_NOT|THRESHOLD|DELETION|PROFILE_CHANGED/.test(e.code));
		if (lockErrors.length === 1 && lockErrors[0].code === 'LOCK_UPDATE_REQUIRED') lockAction = 'update';
		else if (lockErrors.length) lockAction = `refused: ${lockErrors.map((e) => `${e.code} ${e.detail}`).join('; ')}`;
	}
	if (mode === 'check') {
		if (stale.length) { console.error(`crsf-gen: stale generated output: ${stale.join(', ')} (run --write)`); process.exitCode = 1; }
		if (lockAction !== 'unchanged') { console.error(`crsf-gen: framework lock ${lockAction}`); process.exitCode = 1; }
		if (!process.exitCode) console.log('crsf-gen: generated fields and CRSF-1.0.md are up to date');
		return;
	}
	for (const [name, data] of Object.entries(generated)) writeFileSync(path.join(ROOT, `${name}.json`), serialize(data));
	writeFileSync(mdFile, md);
	if (lockAction === 'bootstrap' || lockAction === 'update') writeFileSync(lockFile, serialize(buildLock(nextDef)));
	else if (lockAction.startsWith('refused')) { console.error(`crsf-gen: framework lock NOT updated - ${lockAction}`); process.exitCode = 1; }
	console.log(`crsf-gen: wrote ${Object.keys(generated).map((n) => `${n}.json`).join(', ')}, CRSF-1.0.md; lock ${lockAction}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
