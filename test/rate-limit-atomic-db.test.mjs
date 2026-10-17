/*
	CRSF CR-RESOURCE-002 P1 - "admitted requests <= max under concurrency" fuer
	public.check_agent_rate_limit, gegen ECHTEN Postgres mit echter Gleichzeitigkeit.

	Rennen: Zaehlen als Lesen-dann-Schreiben verliert Erhoehungen, wenn mehrere
	Aufrufe denselben alten Zaehlerstand lesen - dann werden mehr als `max`
	Anfragen zugelassen. Die Funktion zaehlt mit einem einzigen
	INSERT ... ON CONFLICT DO UPDATE requests = requests + 1 RETURNING; die
	Zeilensperre reiht gleichzeitige Erhoehungen ein.

	Deterministische Schranke: Verbindung A ruft die Funktion in einer offenen
	Transaktion auf und haelt damit die Zeilensperre des Zaehlers. N weitere
	Aufrufe auf je EIGENER Verbindung starten; der Test wartet, bis Postgres alle N
	als wartend meldet (pg_stat_activity, wait_event_type Lock) - erst dann gibt A
	frei. So haben alle N ihren Aufruf begonnen, bevor irgendeine Erhoehung
	sichtbar ist: genau die Verschraenkung, in der ein Lesen-dann-Schreiben
	Erhoehungen verliert. Zusaetzlich gleichzeitige Runden ohne Schranke.

	Nur mit Wegwerf-Postgres (M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE), sonst
	sichtbar uebersprungen.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dropTestDatabase } from '../test-support/drop-test-db.mjs';

const URL_ = process.env.M1_DB_TEST_PG_URL;
const MODULE = process.env.M1_DB_TEST_PG_MODULE;
const skip = !URL_ || !MODULE ? 'M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE nicht gesetzt (Wegwerf-Postgres noetig)' : false;
const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url);

let pg, dbUrl;
const connect = async () => { const c = new pg.Client({ connectionString: dbUrl, statement_timeout: 20_000 }); await c.connect(); return c; };

async function setup() {
	pg = (await import(MODULE)).default;
	if (!/^postgres:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(URL_)) throw new Error('Nur gegen einen lokalen Wegwerf-Postgres.');
	const admin = new pg.Client({ connectionString: URL_ });
	await admin.connect();
	const name = `rl_${process.pid}`;
	await admin.query(`drop database if exists ${name}`);
	await admin.query(`create database ${name}`);
	for (const role of ['anon', 'authenticated', 'service_role', 'supabase_admin']) {
		await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role}; end if; end $$`);
	}
	await admin.end();
	dbUrl = URL_.replace(/\/[^/]*$/, `/${name}`);
	const c = await connect();
	for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) await c.query(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
	await c.end();
}

const WINDOW = 3600;
const call = async (c, key, max) => (await c.query('select public.check_agent_rate_limit($1, $2, $3) as ok', [key, WINDOW, max])).rows[0].ok;
const stored = async (c, key) => Number((await c.query('select coalesce(sum(requests), 0) as n from public.api_rate_limits where key_hash = $1', [key])).rows[0].n);
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: nicht innerhalb ${ms} ms`)), ms))]);

test('RL-DB', { skip, timeout: 600_000 }, async (t) => {
	await setup();
	t.after(() => dropTestDatabase(pg, URL_, dbUrl));
	const conns = await Promise.all(Array.from({ length: 31 }, () => connect()));
	const [admin, gate, ...workers] = conns;
	const pidOf = async (c) => (await c.query('select pg_backend_pid() as pid')).rows[0].pid;
	const workerPids = await Promise.all(workers.map(pidOf));
	try {
		await t.test('RL-DB gate: with the counter row locked, N callers on separate connections all wait; on release at most max are admitted and no increment is lost', async () => {
			for (const [n, max, round] of [[10, 3, 0], [29, 5, 1], [29, 1, 2], [20, 25, 3], [29, 10, 4]]) {
				const key = `rl-gate-${round}-${process.pid}`;
				await gate.query('begin');
				assert.equal(await call(gate, key, max), true, 'the gate call is the first request');
				const pending = workers.slice(0, n).map((c) => call(c, key, max));
				// deterministic gate: every caller has started and is blocked on the counter before anything is released
				const pids = workerPids.slice(0, n);
				let waiting = 0;
				for (let i = 0; i < 200 && waiting < n; i++) {
					waiting = Number((await admin.query(`select count(*) as n from pg_stat_activity where pid = any($1) and wait_event_type = 'Lock'`, [pids])).rows[0].n);
					if (waiting < n) await new Promise((r) => setTimeout(r, 25));
				}
				assert.equal(waiting, n, `N=${n}: all callers are blocked behind the gate before release`);
				await gate.query('commit');
				const results = await within(Promise.all(pending), 20_000, 'callers after release');
				const admitted = 1 + results.filter(Boolean).length;
				assert.equal(admitted, Math.min(max, n + 1), `N=${n}, max=${max}: admitted requests`);
				assert.ok(admitted <= max, `N=${n}, max=${max}: ${admitted} admitted - more than max`);
				assert.equal(await stored(admin, key), n + 1, `N=${n}: every request was counted (no lost increment)`);
			}
		});

		await t.test('RL-DB race: N simultaneous first requests for a fresh key on separate connections admit exactly max', async () => {
			for (let round = 0; round < 10; round++) {
				const key = `rl-race-${round}-${process.pid}`;
				const max = 1 + (round % 4) * 3;
				const results = await within(Promise.all(workers.map((c) => call(c, key, max))), 20_000, 'simultaneous callers');
				assert.equal(results.filter(Boolean).length, Math.min(max, workers.length), `round ${round}, max=${max}`);
				assert.equal(await stored(admin, key), workers.length, `round ${round}: every request counted`);
			}
		});

		await t.test('RL-DB keys are independent: two keys raced together each admit their own max', async () => {
			const a = `rl-a-${process.pid}`, b = `rl-b-${process.pid}`;
			const results = await within(Promise.all(workers.map((c, i) => call(c, i % 2 ? b : a, 4))), 20_000, 'two keys');
			assert.equal(results.filter((ok, i) => ok && i % 2 === 0).length, 4);
			assert.equal(results.filter((ok, i) => ok && i % 2 === 1).length, 4);
		});
	} finally {
		await Promise.allSettled(conns.map((c) => c.end()));
	}
});
