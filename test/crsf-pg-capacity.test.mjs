/**
 * Nexus P4F (20.10.2026): test-infrastructure precondition of security:verify, not
 * application security evidence. The disposable Postgres has to carry all real-system
 * evidence groups at the same time. Below the documented capacity the verify stops
 * early with a clear infrastructure error (exit 3) instead of a false FAIL (P4E: 162
 * "too many clients" at max_connections=300).
 * Offline: a stand-in pg module answers SHOW max_connections; no real Postgres is needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_PG_MAX_CONNECTIONS, pgCapacityVerdict, probePgCapacity } from '../security/crsf/lib/pg-capacity.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A stand-in for the pg package: Client.query records the SQL and answers max_connections = value. */
function fakePg(value, dir) {
	const file = path.join(dir, `pg-${value}.cjs`);
	writeFileSync(file, `const fs = require('node:fs');
class Client { constructor(o) { this.o = o; } async connect() {} async end() {}
	async query(sql) { fs.appendFileSync(${JSON.stringify(path.join(dir, 'sql.log'))}, sql + '\\n'); return { rows: [{ max_connections: ${JSON.stringify(String(value))} }] }; } }
module.exports = { Client };\n`);
	return file;
}

test('PG-CAPACITY the documented minimum is 600 connections; anything lower or unreadable is refused', () => {
	assert.equal(REQUIRED_PG_MAX_CONNECTIONS, 600);
	assert.deepEqual(pgCapacityVerdict('600'), { ok: true, value: 600, required: 600, error: null });
	assert.equal(pgCapacityVerdict('1000').ok, true);
	assert.equal(pgCapacityVerdict(600).ok, true);
	for (const v of ['599', '300', '100']) assert.deepEqual(pgCapacityVerdict(v), { ok: false, value: Number(v), required: 600, error: 'INSUFFICIENT_MAX_CONNECTIONS' });
	for (const v of [undefined, null, '', 'abc', '600 ', '-1', '0', '06', '1e3', {}]) assert.equal(pgCapacityVerdict(v).error, 'UNREADABLE_MAX_CONNECTIONS', String(v));
});

test('PG-CAPACITY the probe only reads the setting and reports failures as unusable', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'crsf-pgcap-'));
	try {
		assert.deepEqual(await probePgCapacity({ url: 'postgres://x@127.0.0.1:1/x', module: fakePg(300, dir) }), { ok: false, value: 300, required: 600, error: 'INSUFFICIENT_MAX_CONNECTIONS' });
		assert.equal((await probePgCapacity({ url: 'postgres://x@127.0.0.1:1/x', module: fakePg(600, dir) })).ok, true);
		assert.deepEqual(readFileSync(path.join(dir, 'sql.log'), 'utf8').trim().split('\n'), ['SHOW max_connections', 'SHOW max_connections']);
		const missing = await probePgCapacity({ url: 'postgres://x@127.0.0.1:1/x', module: path.join(dir, 'missing.cjs') });
		assert.equal(missing.ok, false);
		assert.match(missing.error, /^PROBE_FAILED: /);
	} finally { rmSync(dir, { recursive: true, force: true }); }
	assert.doesNotMatch(readFileSync(path.join(REPO, 'security/crsf/lib/pg-capacity.mjs'), 'utf8'), /ALTER SYSTEM|\bSET\b|pg_reload_conf|set_config/);
});

test('PG-CAPACITY security:verify stops before executing anything when the disposable Postgres is too small (exit 3)', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'crsf-pgcap-'));
	try {
		const out = path.join(dir, 'out');
		const p = spawnSync(process.execPath, ['scripts/security-verify.mjs', '--no-mutations', '--out', out], {
			cwd: REPO, encoding: 'utf8', timeout: 120_000,
			env: { PATH: process.env.PATH ?? '', HOME: dir, M1_DB_TEST_PG_URL: 'postgres://x@127.0.0.1:1/x', M1_DB_TEST_PG_MODULE: fakePg(300, dir) }
		});
		assert.equal(p.status, 3, p.stderr.slice(-500));
		assert.match(p.stderr, /TEST INFRASTRUCTURE PRECONDITION FAILED: disposable Postgres max_connections 300 \(INSUFFICIENT_MAX_CONNECTIONS\); required >= 600/);
		assert.doesNotMatch(p.stderr, /executing node-test evidence/);
		assert.throws(() => readFileSync(path.join(out, 'crsf-report.json')), 'no report is written');
	} finally { rmSync(dir, { recursive: true, force: true }); }
	// the probe runs before any evidence is executed
	const verify = readFileSync(path.join(REPO, 'scripts/security-verify.mjs'), 'utf8');
	assert.ok(verify.indexOf('probePgCapacity({') < verify.indexOf('executeNodeTestEvidence(items'));
});
