/*
	CRSF Phase 2U (F-2T-1): observed test executor (child process of the runner).

	Runs the test files of each real-system evidence item through its own
	runner-side Postgres observer (pg-observer.mjs) and prints ONE signed line:
	  {"observed":{nonce,upstream_kind,groups:[{id,ok,error,results,receipt}]},"mac":"<hmac>"}

	Trust boundary: the configuration - including the real Postgres address, the
	HMAC key and the nonce - arrives on stdin from the runner and is read before
	any test starts; the tests see only the observer address in
	M1_DB_TEST_PG_URL. A test cannot produce an accepted receipt: it does not know
	the key, its own output never reaches this process's stdout, and a line it
	might write there by other means fails the runner's MAC and nonce check.
	upstream "fake" (self-test only) starts pg-fake-upstream.mjs; its receipts are
	marked "selftest-fake" and are never credited as real-system evidence.
*/
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startPgObserver } from './pg-observer.mjs';
import { startFakeUpstream } from './pg-fake-upstream.mjs';

const EXECUTOR = fileURLToPath(new URL('./node-test-exec.mjs', import.meta.url));

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { key, nonce, upstream, groups, timeoutMs = 300_000 } = JSON.parse(input);

function runFiles(files, env) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [EXECUTOR, ...files], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'ignore'] });
		let out = '';
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
		child.stdout.on('data', (c) => { out += c; });
		child.on('close', (code) => {
			clearTimeout(timer);
			const line = out.trim().split('\n').filter((l) => l.startsWith('{"results"')).at(-1);
			resolve(line ? { ok: true, results: JSON.parse(line).results } : { ok: false, error: `executor produced no result (exit ${code})`, results: [] });
		});
	});
}

const fake = upstream.fake ? await startFakeUpstream(upstream.fake) : null;
const target = fake ? { host: '127.0.0.1', port: fake.port } : (() => { const u = new URL(upstream.url); return { host: u.hostname, port: Number(u.port || 5432) }; })();
const out = await Promise.all(groups.map(async ({ id, files }) => {
	const observer = await startPgObserver({ upstream: target });
	const url = new URL(fake ? 'postgres://crsf@127.0.0.1/crsf_selftest' : upstream.url);
	url.hostname = '127.0.0.1';
	url.port = String(observer.port);
	const env = { ...process.env, M1_DB_TEST_PG_URL: url.toString(), ...(upstream.module ? { M1_DB_TEST_PG_MODULE: upstream.module } : {}) };
	const run = await runFiles(files, env);
	const receipt = observer.receipt();
	await observer.close();
	return { id, ok: run.ok, error: run.error ?? null, results: run.results, receipt };
}));
await fake?.close();
const observed = { nonce, upstream_kind: fake ? 'selftest-fake' : 'postgres', groups: out };
const body = JSON.stringify(observed);
process.stdout.write(`{"observed":${body},"mac":"${createHmac('sha256', key).update(body).digest('hex')}"}\n`);
