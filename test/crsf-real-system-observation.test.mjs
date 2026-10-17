/**
 * CRSF Phase 2U - F-2T-1 and F-2T-2.
 *
 * F-2T-1: real-system (E5) evidence earns credit only for what the runner-side
 * observer saw - server-confirmed Postgres use and, for concurrency claims,
 * overlapping execution - never for declared type, environment or test output.
 * F-2T-2: self-test fixture N holds whether or not a release-blocking control
 * is still open.
 *
 * Needs no database: the observer relays to the self-test fake upstream
 * (security/crsf/lib/pg-fake-upstream.mjs) or to a server that never answers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { loadDefinition, loadSchemas, evaluate, context, realSystemObserved } from '../security/crsf/lib/engine.mjs';
import { startPgObserver, summarizeReceipt } from '../security/crsf/lib/pg-observer.mjs';
import { startFakeUpstream } from '../security/crsf/lib/pg-fake-upstream.mjs';
import { runObservedTests, authenticObservation, childEnv, detectCapabilities, executeNodeTestEvidence } from '../security/crsf/lib/exec.mjs';
import { allReleaseControlsSatisfied, runDefinitionFixtures, definitionErrors } from '../security/crsf/selftest/framework-selftest.mjs';
import { connectPg } from '../security/crsf/selftest/fixtures/pg-wire.mjs';

const CRSF = path.resolve('security/crsf');
const definition = () => loadDefinition(CRSF, path.resolve('security/mutation/cases.json'));
const THRESHOLDS = { min_concurrent_connections: 2, min_overlap_events: 2 };
const FIX = 'security/crsf/selftest/fixtures/';
const item = (id) => ({ id, type: 'real-system', execution: { runner: 'node-test', environment: ['node', 'postgres'] } });
const observedAs = (id, receipt) => ({ mode: 'OBSERVED', evidence: { [id]: 'PASS' }, mutations: {}, observations: receipt === undefined ? {} : { [id]: { upstream_kind: 'postgres', receipt } } });

async function throughObserver(fn, upstreamOptions) {
	const fake = await startFakeUpstream(upstreamOptions);
	const observer = await startPgObserver({ upstream: { host: '127.0.0.1', port: fake.port } });
	try {
		await fn(`postgres://crsf@127.0.0.1:${observer.port}/crsf_test`);
		await new Promise((r) => setTimeout(r, 50));
		return observer.receipt();
	} finally { await observer.close(); await fake.close(); }
}

test('E5-OBS engine: a node-only test declared real-system [node, postgres] gets no credit (T3)', () => {
	const run = runObservedTests([{ id: 'T3', files: [`${FIX}rs-node-only.mjs`] }], { cwd: process.cwd(), env: childEnv(detectCapabilities()), upstream: { fake: { delayMs: 5 } }, timeoutMs: 60_000 });
	assert.ok(run.ok, run.error);
	const g = run.groups[0];
	assert.deepEqual(g.results.map((r) => r.outcome), ['pass'], 'the fake item\'s own test passes');
	const def = definition();
	def.evidence.evidence.push({ ...structuredClone(def.evidence.evidence.find((e) => e.type === 'real-system')), id: 'EV-FAKE-REAL-PG', covers: [{ control: 'CR-VERIFY-004', properties: ['P1'], scope: 'FULL', result: 'SUPPORTS', note: 'T3' }], control_ids: ['CR-VERIFY-004'], execution: { runner: 'node-test', test_files: [`${FIX}rs-node-only.mjs`], environment: ['node', 'postgres'], timeout_ms: 60_000, expected_result: 'PASS', known_bad_required: false } });
	const c = evaluate(def, observedAs('EV-FAKE-REAL-PG', g.receipt)).controls.find((x) => x.id === 'CR-VERIFY-004');
	assert.notEqual(c.security_status, 'PASS_AUTOMATED');
	assert.ok(c.property_coverage.P1.insufficient.some((x) => x.startsWith('EV-FAKE-REAL-PG') && x.includes('runner observed no Postgres use')), JSON.stringify(c.property_coverage.P1));
	const none = realSystemObserved(context(def), item('EV-X'), 'CR-DB-001', 'P1', observedAs('EV-X', undefined));
	assert.deepEqual(none, { ok: false, why: 'real-system use not observed by the runner' });
});

test('E5-OBS observer: only server-confirmed use counts - client bytes to a silent server are no use', async () => {
	const silent = net.createServer((s) => { s.on('data', () => {}); s.on('error', () => {}); });
	await new Promise((r) => silent.listen(0, '127.0.0.1', r));
	const observer = await startPgObserver({ upstream: { host: '127.0.0.1', port: silent.address().port } });
	try {
		const sock = net.connect(observer.port, '127.0.0.1');
		await new Promise((r) => sock.once('connect', r));
		const params = Buffer.from('user\0crsf\0database\0crsf_test\0\0');
		const start = Buffer.alloc(8); start.writeInt32BE(8 + params.length, 0); start.writeInt32BE(196608, 4);
		const q = (t) => { const b = Buffer.from(`${t}\0`); const h = Buffer.alloc(5); h.write('Q', 0, 'latin1'); h.writeInt32BE(4 + b.length, 1); return Buffer.concat([h, b]); };
		sock.write(Buffer.concat([start, params, q('select 1'), q('select 2'), q('select 3')]));
		await new Promise((r) => setTimeout(r, 150));
		const receipt = observer.receipt();
		sock.destroy();
		assert.equal(receipt.connections_total, 1);
		assert.deepEqual(Object.values(receipt.databases).map((d) => [d.authenticated, d.completed]).flat().filter((n) => n > 0), [], JSON.stringify(receipt));
		assert.equal(summarizeReceipt(receipt, THRESHOLDS).postgres_use, false);
	} finally { await observer.close(); silent.close(); }
	const real = await throughObserver(async (url) => { const c = await connectPg(url); await c.query('select 1'); c.end(); });
	assert.equal(summarizeReceipt(real, THRESHOLDS).postgres_use, true, 'an answered statement is use');
});

test('E5-OBS observer: strictly sequential statements on several connections are not concurrency, overlapping ones are', async () => {
	const sequential = await throughObserver(async (url) => {
		const conns = [await connectPg(url), await connectPg(url), await connectPg(url)];
		for (let i = 0; i < 9; i++) await conns[i % 3].query(`select ${i}`);
		for (const c of conns) c.end();
	});
	assert.deepEqual(summarizeReceipt(sequential, THRESHOLDS), { postgres_use: true, concurrency: false }, JSON.stringify(sequential));
	const overlapping = await throughObserver(async (url) => {
		const conns = await Promise.all([0, 1, 2].map(() => connectPg(url)));
		for (let round = 0; round < 2; round++) await Promise.all(conns.map((c, i) => c.query(`select ${round}${i}`)));
		for (const c of conns) c.end();
	});
	assert.deepEqual(summarizeReceipt(overlapping, THRESHOLDS), { postgres_use: true, concurrency: true }, JSON.stringify(overlapping));
	const transactions = await throughObserver(async (url) => {
		const a = await connectPg(url), b = await connectPg(url);
		for (let round = 0; round < 2; round++) { await a.query('BEGIN'); await b.query('BEGIN'); await a.query('select 1'); await b.query('select 2'); await a.query('COMMIT'); await b.query('COMMIT'); }
		a.end(); b.end();
	});
	assert.equal(summarizeReceipt(transactions, THRESHOLDS).concurrency, true, 'interleaved open transactions are concurrent execution');
});

test('E5-OBS engine: a concurrency claim needs observed concurrent execution, Postgres use alone is not enough', async () => {
	const sequential = await throughObserver(async (url) => { const a = await connectPg(url), b = await connectPg(url); for (let i = 0; i < 4; i++) await [a, b][i % 2].query('select 1'); a.end(); b.end(); });
	const ctx = context(definition());
	const out = observedAs('EV-SEQ', sequential);
	assert.deepEqual(realSystemObserved(ctx, item('EV-SEQ'), 'CR-CONC-001', 'P1', out), { ok: false, why: 'runner observed no concurrent execution' });
	assert.deepEqual(realSystemObserved(ctx, item('EV-SEQ'), 'CR-DB-001', 'P1', out), { ok: true }, 'a non-concurrency property only needs use');
	assert.deepEqual(realSystemObserved(ctx, item('EV-SEQ'), 'CR-CONC-001', 'P1', { ...out, observations: { 'EV-SEQ': { upstream_kind: 'selftest-fake', receipt: sequential } } }), { ok: false, why: 'observation not made against the real postgres' });
});

test('E5-OBS runner: only a receipt signed with the run key and carrying the run nonce is accepted', () => {
	const key = 'k'.repeat(64), nonce = 'n'.repeat(32);
	const body = JSON.stringify({ nonce, upstream_kind: 'postgres', groups: [{ id: 'X' }] });
	const sign = (b, k = key) => `{"observed":${b},"mac":"${createHmac('sha256', k).update(b).digest('hex')}"}`;
	assert.equal(authenticObservation(`{"observed":${body},"mac":"${'0'.repeat(64)}"}`, key, nonce), null, 'right nonce, forged MAC');
	assert.equal(authenticObservation(sign(body, 'other-key'), key, nonce), null, 'signed with another key');
	assert.equal(authenticObservation(sign(JSON.stringify({ nonce: 'old', groups: [] })), key, nonce), null, 'replayed nonce');
	assert.deepEqual(authenticObservation(`noise\n${sign(body)}\n`, key, nonce)?.groups, [{ id: 'X' }]);
	// End to end: a test that writes a forged line into the executor's stdout via /proc changes nothing.
	const run = runObservedTests([{ id: 'S7', files: [`${FIX}rs-proc-forge.mjs`] }], { cwd: process.cwd(), env: childEnv(detectCapabilities()), upstream: { fake: { delayMs: 5 } }, timeoutMs: 60_000 });
	assert.ok(run.ok, run.error);
	assert.deepEqual(run.groups.map((g) => g.id), ['S7']);
	assert.equal(summarizeReceipt(run.groups[0].receipt, THRESHOLDS).postgres_use, false);
});

test('E5-OBS runner: without the postgres capability a real-system item is NOT_RUN and never observed', () => {
	const caps = { ...detectCapabilities({}), postgres: { available: false } };
	const r = executeNodeTestEvidence([{ id: 'EV-RS', type: 'real-system', execution: { runner: 'node-test', test_files: [`${FIX}rs-concurrent.mjs`], environment: ['node', 'postgres'] } }], { cwd: process.cwd(), env: childEnv(caps, {}), caps });
	assert.equal(r.outcomes['EV-RS'], 'NOT_RUN');
	assert.deepEqual(r.observations, {});
});

test('CRSF-SELFTEST-STATES fixture N holds in the current state and once every release-blocking control is satisfied', () => {
	const schemas = loadSchemas(path.join(CRSF, 'schema'));
	const current = definition();
	const synthetic = allReleaseControlsSatisfied(current);
	assert.ok(synthetic.controls.controls.filter((c) => c.release_class === 'RELEASE_BLOCKING').every((c) => c.security_status === 'PASS_AUTOMATED'), 'synthetic state: every release-blocking control satisfied');
	assert.deepEqual(definitionErrors(synthetic, schemas), [], 'synthetic state is a valid definition');
	for (const [label, d] of [['current', current], ['all satisfied', synthetic]]) {
		const n = runDefinitionFixtures(d, schemas).find((f) => f.id === 'N');
		assert.ok(n.rejected, `${label}: a forged PASS without evidence is caught (${n.codes.join(', ')})`);
	}
});
