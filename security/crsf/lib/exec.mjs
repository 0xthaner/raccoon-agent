/*
	CRSF execution layer: environment capabilities, targeted test execution and
	mutation (known-bad) execution in a disposable workspace.

	Nothing here writes to the repository working tree. Mutations are applied to a
	temporary copy of the tracked (and untracked, non-ignored) files; the copy is
	deleted in `finally` and on process exit.
*/
import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedSkip } from '../../../scripts/skip-policy.mjs';

const EXECUTOR = fileURLToPath(new URL('./node-test-exec.mjs', import.meta.url));

/* ------------------------------------------------------------ capabilities */
export function detectCapabilities(env = process.env) {
	const pgUrl = env.M1_DB_TEST_PG_URL ?? '';
	const pgModule = env.M1_DB_TEST_PG_MODULE ?? '';
	const nodeMajor = Number(process.versions.node.split('.')[0]);
	return {
		node: { available: nodeMajor === 24, version_major: nodeMajor, required: '24.x' },
		postgres: { available: Boolean(pgUrl && pgModule && existsSync(pgModule)), via: 'M1_DB_TEST_PG_URL + M1_DB_TEST_PG_MODULE (disposable Postgres only)' },
		git: { available: hasGit() },
		production_access: { available: false, reason: 'never used by security:verify; production evidence is recorded manually' }
	};
}
function hasGit() {
	try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const ENV_REQUIREMENT = { node: 'node', postgres: 'postgres' };
export function missingCapabilities(requirements, caps) {
	return (requirements ?? []).filter((r) => !caps[ENV_REQUIREMENT[r] ?? r]?.available);
}

/** Child environment: no inherited secrets. Same placeholders as CI (.github/workflows/ci.yml). */
export function childEnv(caps, env = process.env) {
	const out = {
		PATH: env.PATH ?? '', HOME: env.HOME ?? os.tmpdir(), TMPDIR: env.TMPDIR ?? os.tmpdir(), LANG: 'C.UTF-8',
		SUPABASE_URL: 'https://example.invalid', SUPABASE_SECRET_KEY: 'crsf-dummy-not-a-real-key'
	};
	if (caps.postgres.available) { out.M1_DB_TEST_PG_URL = env.M1_DB_TEST_PG_URL; out.M1_DB_TEST_PG_MODULE = env.M1_DB_TEST_PG_MODULE; }
	return out;
}

/* -------------------------------------------------------------- execution */
export function runTests(files, { cwd, env, timeoutMs = 300_000 }) {
	const p = spawnSync(process.execPath, [EXECUTOR, ...files], { cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
	const line = (p.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('{"results"')).at(-1);
	if (p.error || !line) return { ok: false, error: p.error ? String(p.error.code ?? p.error.message) : `executor produced no result (exit ${p.status})`, results: [] };
	return { ok: true, results: JSON.parse(line).results };
}

/** Classifies raw outcomes with the shared skip policy. Pure; used by self-tests. */
export function classifyOutcomes(results, env) {
	const c = { tests: results.length, pass: 0, fail: [], cancelled: [], todo: [], allowed_skips: [], unexpected_skips: [] };
	for (const r of results) {
		const id = `${r.file} :: ${r.name}`;
		if (r.outcome === 'pass') c.pass++;
		else if (r.outcome === 'fail') c.fail.push(id);
		else if (r.outcome === 'cancelled') c.cancelled.push(id);
		else if (r.outcome === 'todo') c.todo.push(id);
		else if (r.outcome === 'skip') (isAllowedSkip(id, env) ? c.allowed_skips : c.unexpected_skips).push(id);
	}
	return c;
}

/* --------------------------------------------------------------- workspace */
const live = new Set();
process.on('exit', () => { for (const dir of live) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort on exit */ } } });

export function createWorkspace(repoRoot) {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'crsf-mutation-'));
	live.add(dir);
	const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
	for (const rel of listed) {
		const from = path.join(repoRoot, rel);
		if (!existsSync(from)) continue; // deleted in the working tree
		mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		cpSync(from, path.join(dir, rel));
	}
	symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'));
	return {
		dir,
		dispose() { rmSync(dir, { recursive: true, force: true }); live.delete(dir); }
	};
}

/** Applies exact, once-only text edits. Returns a restore function; throws (after restoring) if an anchor is not unique. */
export function applyEdits(dir, edits) {
	const originals = new Map();
	const restore = () => { for (const [file, text] of originals) writeFileSync(file, text); };
	try {
		for (const { file, find, replace } of edits) {
			const abs = path.join(dir, file);
			if (!abs.startsWith(dir + path.sep)) throw new Error(`edit outside workspace: ${file}`);
			const text = readFileSync(abs, 'utf8');
			if (!originals.has(abs)) originals.set(abs, text);
			const count = text.split(find).length - 1;
			if (count !== 1) throw new Error(`anchor in ${file} occurs ${count} times (must be exactly once)`);
			writeFileSync(abs, text.replace(find, () => replace));
		}
	} catch (error) { restore(); throw error; }
	return restore;
}

const matches = (expect, r) => new RegExp(expect.test).test(r.name) && (!expect.message || new RegExp(expect.message).test(r.message));

/**
 * Executes one mutation case in an existing workspace.
 * KILLED   - at least one expected failure occurred and nothing was cancelled
 * KILLED_OTHER - tests failed, but none of the expected failures (wrong reason; never counts)
 * SURVIVED - all mapped tests still pass (never counts as known-bad proof)
 * INVALID  - anchor not unique, executor error, or no tests ran
 */
export function runMutation(mutation, ws, env, timeoutMs) {
	let restore;
	try { restore = applyEdits(ws.dir, mutation.edits); } catch (error) { return { result: 'INVALID', reason: error.message, intended: [], other: [] }; }
	try {
		const run = runTests(mutation.tests, { cwd: ws.dir, env, timeoutMs });
		if (!run.ok) return { result: 'INVALID', reason: run.error, intended: [], other: [] };
		if (!run.results.length) return { result: 'INVALID', reason: 'no tests ran', intended: [], other: [] };
		const failing = run.results.filter((r) => r.outcome === 'fail' || r.outcome === 'cancelled');
		const skipped = run.results.filter((r) => r.outcome === 'skip');
		if (skipped.length) return { result: 'INVALID', reason: `skipped tests under mutation: ${skipped.map((r) => r.name).join(', ')}`, intended: [], other: [] };
		const intended = failing.filter((r) => r.outcome === 'fail' && mutation.expected_failures.some((e) => matches(e, r)));
		const cancelled = failing.filter((r) => r.outcome === 'cancelled');
		const id = (r) => `${r.file} :: ${r.name}`;
		if (!failing.length) return { result: 'SURVIVED', reason: 'all mapped tests pass against the known-bad variant', intended: [], other: [] };
		if (intended.length && !cancelled.length) return { result: 'KILLED', reason: 'expected failure observed', intended: intended.map(id), other: failing.filter((r) => !intended.includes(r)).map(id) };
		return { result: 'KILLED_OTHER', reason: cancelled.length ? 'killed via cancellation/timeouts' : 'tests failed, but not the expected ones', intended: [], other: failing.map((r) => `${id(r)} :: ${r.message.slice(0, 120)}`) };
	} finally { restore(); }
}

/** Baseline: the unmutated workspace must pass every mapped test of the cases about to run. */
export function runBaseline(files, ws, env, timeoutMs) {
	const run = runTests(files, { cwd: ws.dir, env, timeoutMs });
	if (!run.ok) return { ok: false, reason: run.error };
	const c = classifyOutcomes(run.results, env);
	const bad = [...c.fail, ...c.cancelled, ...c.todo, ...c.unexpected_skips, ...c.allowed_skips];
	return { ok: bad.length === 0 && c.tests > 0, reason: bad.length ? `baseline not clean: ${bad.slice(0, 5).join('; ')}` : c.tests ? 'ok' : 'no tests', tests: c.tests };
}

export function gitInfo(repoRoot) {
	const g = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
	try { return { commit: g('rev-parse', 'HEAD'), branch: g('rev-parse', '--abbrev-ref', 'HEAD'), clean: g('status', '--porcelain') === '' }; } catch { return { commit: null, branch: null, clean: null }; }
}
export function changedPaths(repoRoot, base, head = 'HEAD') {
	return execFileSync('git', ['diff', '--name-only', `${base}..${head}`], { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean).sort();
}

/* ------------------------------------------------- evidence execution */
const nameFilter = (e) => (e.execution.test_names?.length ? (r) => e.execution.test_names.some((n) => new RegExp(n).test(r.name)) : () => true);

/**
 * Runs every executable node-test evidence item whose environment is available.
 * Each test file runs once; results are attributed to evidence items by file
 * (and optional test-name filter). Returns per-item outcomes plus the global
 * guard counters (unexpected skips, cancellations, todos).
 */
export function executeNodeTestEvidence(items, { cwd, env, caps }) {
	const outcomes = {}; const detail = {};
	const runnable = items.filter((e) => !missingCapabilities(e.execution.environment, caps).length);
	for (const e of items.filter((x) => !runnable.includes(x))) { outcomes[e.id] = 'NOT_RUN'; detail[e.id] = { reason: `missing capability: ${missingCapabilities(e.execution.environment, caps).join(', ')}` }; }
	const files = [...new Set(runnable.flatMap((e) => e.execution.test_files))].sort();
	const timeout = Math.max(60_000, ...runnable.map((e) => e.execution.timeout_ms ?? 0));
	const run = files.length ? runTests(files, { cwd, env, timeoutMs: timeout }) : { ok: true, results: [] };
	if (!run.ok) for (const e of runnable) { outcomes[e.id] = 'FAIL'; detail[e.id] = { reason: `executor error: ${run.error}` }; }
	const guard = classifyOutcomes(run.results, env);
	if (run.ok) for (const e of runnable) {
		const mine = run.results.filter((r) => e.execution.test_files.includes(r.file)).filter(nameFilter(e));
		const c = classifyOutcomes(mine, env);
		const bad = [...c.fail, ...c.cancelled, ...c.todo, ...c.unexpected_skips];
		if (!mine.length) { outcomes[e.id] = 'FAIL'; detail[e.id] = { reason: 'no matching tests ran' }; }
		else if (bad.length) { outcomes[e.id] = 'FAIL'; detail[e.id] = { reason: 'failed/cancelled/todo/unexpectedly skipped tests', tests: bad }; }
		else if (c.allowed_skips.length) { outcomes[e.id] = 'NOT_RUN'; detail[e.id] = { reason: 'infrastructure tests skipped under the shared skip policy', tests: c.allowed_skips }; }
		else { outcomes[e.id] = 'PASS'; detail[e.id] = { tests: c.tests }; }
	}
	return { outcomes, detail, guard: { tests: guard.tests, pass: guard.pass, failed: guard.fail, cancelled: guard.cancelled, todo: guard.todo, unexpected_skips: guard.unexpected_skips, allowed_skips: guard.allowed_skips } };
}

/** Runs a probe script (characterisation evidence). PASS = exit 0; its JSON line is recorded. */
export function executeProbe(e, { cwd, env }) {
	const p = spawnSync(process.execPath, [e.execution.script], { cwd, env, encoding: 'utf8', timeout: e.execution.timeout_ms ?? 60_000 });
	const line = (p.stdout ?? '').trim().split('\n').at(-1) ?? '';
	let observation = null;
	try { observation = JSON.parse(line); } catch { /* not JSON */ }
	return { outcome: p.status === 0 && observation ? 'PASS' : 'FAIL', observation };
}

/** Compares declared and observed mutation results. Any difference (except NOT_RUN) is a framework claim violation. */
export function mutationClaimMismatches(cases, results) {
	const out = [];
	for (const m of cases) {
		const r = results[m.id]?.result ?? 'NOT_RUN';
		if (r === 'NOT_RUN') continue;
		if (r !== m.expected_result) out.push({ id: m.id, declared: m.expected_result, observed: r, reason: results[m.id]?.reason ?? '' });
	}
	return out;
}

/** Runs mutation cases in one disposable workspace (baseline first). */
export function executeMutations(cases, { repoRoot, env, caps }) {
	const results = {};
	const runnable = cases.filter((m) => !missingCapabilities(m.environment, caps).length);
	for (const m of cases.filter((x) => !runnable.includes(x))) results[m.id] = { result: 'NOT_RUN', reason: `missing capability: ${missingCapabilities(m.environment, caps).join(', ')}`, intended: [], other: [] };
	if (!runnable.length) return { results, baseline: { ok: true, reason: 'nothing to run' } };
	const ws = createWorkspace(repoRoot);
	try {
		const files = [...new Set(runnable.flatMap((m) => m.tests))].sort();
		const baseline = runBaseline(files, ws, env, 600_000);
		if (!baseline.ok) { for (const m of runnable) results[m.id] = { result: 'INVALID', reason: `baseline: ${baseline.reason}`, intended: [], other: [] }; return { results, baseline }; }
		for (const m of runnable) results[m.id] = runMutation(m, ws, env, m.timeout_ms);
		return { results, baseline };
	} finally { ws.dispose(); }
}
