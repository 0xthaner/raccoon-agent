/*
	CRSF self-test state helpers (Phase 2U, F-2T-2). Used by
	security/crsf/selftest/framework-selftest.mjs; they only transform an
	in-memory definition and never write to the repository.
*/
import { generate } from '../generator/crsf-gen.mjs';

const clone = (x) => structuredClone(x);

/** Removes every mutation case targeting `control` and keeps the known-bad evidence consistent (ids, covers). */
export function dropMutationsFor(d, control) {
	d.mutations.cases = d.mutations.cases.filter((m) => !m.targets.some((t) => t.control === control));
	const live = new Set(d.mutations.cases.map((m) => m.id));
	for (const e of d.evidence.evidence.filter((x) => x.execution?.runner === 'mutation')) {
		e.execution.mutation_ids = e.execution.mutation_ids.filter((id) => live.has(id));
		e.covers = e.covers.filter((cv) => cv.control !== control);
		e.control_ids = [...new Set(e.covers.map((cv) => cv.control))].sort();
	}
	d.evidence.evidence = d.evidence.evidence.filter((e) => e.execution?.runner !== 'mutation' || e.execution.mutation_ids.length);
}
/**
 * Fixture N target (Phase 2U, F-2T-2): a release-blocking control whose recorded
 * status is honestly MISSING_EVIDENCE. If the definition has one, that control.
 * Otherwise (every release-blocking control satisfied) the first one loses all
 * of its evidence and mutation cases and the computed fields are regenerated, so
 * the definition is consistent with MISSING_EVIDENCE before N forges PASS.
 */
export function forgedPassTarget(d) {
	const open = d.controls.controls.find((c) => c.release_class === 'RELEASE_BLOCKING' && c.security_status === 'MISSING_EVIDENCE');
	if (open) return open;
	const target = [...d.controls.controls].filter((c) => c.release_class === 'RELEASE_BLOCKING').sort((a, b) => a.id.localeCompare(b.id))[0];
	dropMutationsFor(d, target.id);
	for (const e of d.evidence.evidence) e.covers = e.covers.filter((cv) => cv.control !== target.id);
	d.evidence.evidence = d.evidence.evidence.filter((e) => e.covers.length);
	Object.assign(d, generate(d));
	const regenerated = d.controls.controls.find((c) => c.id === target.id);
	if (regenerated.security_status !== 'MISSING_EVIDENCE') throw new Error(`fixture N: ${target.id} still ${regenerated.security_status} without evidence`);
	return regenerated;
}

/**
 * Fixture Z6 state (Phase 2W, F-2W-1): every release-blocking status edited to
 * PASS_AUTOMATED while at least one of them honestly is not - taken from the
 * definition if one is open, otherwise built by forgedPassTarget. Without that,
 * the forged statuses would equal the recomputation once nothing is open and the
 * fixture could not show the edit.
 */
export function forgeAllReleaseBlockingPass(d) {
	forgedPassTarget(d);
	for (const c of d.controls.controls.filter((x) => x.release_class === 'RELEASE_BLOCKING')) c.security_status = 'PASS_AUTOMATED';
}

/**
 * Phase 2U (F-2T-2): synthetic state in which every release-blocking control is
 * satisfied. Each open one gets a declared real-system item covering all of its
 * properties (meta-derived controls excepted); computed fields are regenerated. Used to prove the self-test stays
 * valid once nothing is open - never written to the repository.
 */
export function allReleaseControlsSatisfied(base) {
	const d = clone(base);
	const template = d.evidence.evidence.find((e) => e.type === 'real-system');
	// Phase 2W: meta-derived controls are never covered directly - they follow from the others once those are satisfied.
	const meta = new Set((d.profile.meta_control_derivation?.rules ?? []).map((r) => r.control));
	for (const c of d.controls.controls.filter((x) => x.release_class === 'RELEASE_BLOCKING' && !x.security_status.startsWith('PASS') && !meta.has(x.id))) {
		d.evidence.evidence.push({ ...clone(template), id: `EV-SYNTH-${c.id}`, covers: [{ control: c.id, properties: c.properties.map((p) => p.id), scope: 'FULL', result: 'SUPPORTS', note: 'synthetic self-test state' }], control_ids: [c.id], coverage: 'FULL', reason_for_partial: null });
	}
	Object.assign(d, generate(d));
	return d;
}

