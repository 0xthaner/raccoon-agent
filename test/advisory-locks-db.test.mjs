/*
	CRSF CR-CONC-006 - "Locks consistent, deadlock-free and local" gegen ECHTEN
	Postgres mit echter Gleichzeitigkeit (getrennte Verbindungen).

	  P1 locks are transaction-scoped
	  P2 no operation acquires two advisory locks
	  P3 no endless retry around locks

	Inventar: alle Funktionen im Schema public, deren Quelltext eine Advisory-
	Sperre nimmt, und transitiv jede Funktion, die eine solche aufruft (aus
	pg_proc der migrierten Datenbank). Jede davon muss unten als Operation
	ausgefuehrt werden - eine neue sperrende Funktion ohne Test schlaegt fehl.

	Je Operation, deterministisch geschaltet:
	- A ruft die Operation in einer offenen Transaktion auf: Postgres meldet fuer
	  A genau EINE gewaehrte Advisory-Sperre (P2).
	- B ruft dieselbe Operation (gleicher Schluessel) auf eigener Verbindung auf:
	  B wartet - wait_event_type Lock / wait_event advisory - mit genau EINER nicht
	  gewaehrten Advisory-Anforderung; kein Wiederholen, kein Schlafen (P3).
	- A schreibt fest: die Sperre ist weg, B laeuft durch und endet; danach haelt
	  keine Sitzung mehr eine Advisory-Sperre, auch nicht nach Aufrufen ausserhalb
	  einer Transaktion (P1).
	- Dazu je Operation viele gleichzeitige Aufrufe auf getrennten Verbindungen:
	  alle enden, kein Deadlock (40P01), danach keine Sperre mehr.

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
	const name = `locks_${process.pid}`;
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

const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: nicht innerhalb ${ms} ms`)), ms))]);
const wallet = (n) => `0x${n.toString(16).padStart(40, '0')}`;
let seq = 0;

/** Every locking operation: a fresh key per call (same key for A and B), its SQL call and the setup it needs. */
const OPERATIONS = {
	lock_chat_wallets: {
		key: () => `chat-lock-${++seq}`,
		prepare: async () => {},
		sql: (k) => ['select public.lock_chat_wallets($1)', [k]]
	},
	upsert_position_attribution_limited: {
		key: () => wallet(1000 + ++seq),
		prepare: async () => {},
		sql: (k, i = 0) => ['select public.upsert_position_attribution_limited($1, \'aave\', \'v3\', \'aave-v3-ethereum-core\', 97, $2, now())', [k, 1 + i]]
	},
	revoke_dashboard_sessions_atomic: {
		key: () => wallet(5000 + ++seq),
		prepare: async () => {},
		sql: (k, i = 0) => ['select public.revoke_dashboard_sessions_atomic($1, $2)', [k, 1_700_000_000_000 + i]]
	},
	consume_wallet_link_v2: {
		key: () => `chat-v2-${++seq}`,
		prepare: async (admin, chat, n) => { for (let i = 0; i < n; i++) await admin.query(`insert into public.pending_links (code, chat_id, nonce, expires_at) values ($1, $2, 'n', now() + interval '10 minutes')`, [`${chat}-code-${i}`, chat]); },
		sql: (chat, i = 0) => ['select public.consume_wallet_link_v2($1, $2)', [`${chat}-code-${i}`, wallet(90_000 + seq * 100 + i)]]
	},
	consume_wallet_link: {
		key: () => `chat-v1-${++seq}`,
		prepare: async (admin, chat, n) => { for (let i = 0; i < n; i++) await admin.query(`insert into public.pending_links (code, chat_id, nonce, expires_at) values ($1, $2, 'n', now() + interval '10 minutes')`, [`${chat}-code-${i}`, chat]); },
		sql: (chat, i = 0) => ['select public.consume_wallet_link($1, $2)', [`${chat}-code-${i}`, wallet(190_000 + seq * 100 + i)]]
	}
};

test('LOCKS-DB', { skip, timeout: 600_000 }, async (t) => {
	await setup();
	t.after(() => dropTestDatabase(pg, URL_, dbUrl));
	const conns = await Promise.all(Array.from({ length: 14 }, () => connect()));
	const [admin, a, b, ...many] = conns;
	const pid = async (c) => (await c.query('select pg_backend_pid() as pid')).rows[0].pid;
	const [pidA, pidB] = [await pid(a), await pid(b)];
	const advisory = async (p, granted) => Number((await admin.query(`select count(*) as n from pg_locks where locktype = 'advisory' and pid = $1 and granted = $2`, [p, granted])).rows[0].n);
	// only this test's database: other DB tests may run in parallel on the same server
	const anyAdvisory = async () => Number((await admin.query(`select count(*) as n from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())`)).rows[0].n);
	try {
		await t.test('LOCKS-DB inventory: every public function that takes an advisory lock, directly or through another function, is exercised here', async () => {
			const { rows } = await admin.query(`select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`);
			const locking = new Set(rows.filter((r) => /pg_(try_)?advisory/i.test(r.prosrc)).map((r) => r.proname));
			for (let grew = true; grew;) {
				grew = false;
				for (const r of rows) if (!locking.has(r.proname) && [...locking].some((f) => new RegExp(`\\b${f}\\s*\\(`).test(r.prosrc))) { locking.add(r.proname); grew = true; }
			}
			assert.deepEqual([...locking].sort(), Object.keys(OPERATIONS).sort());
		});

		for (const [name, op] of Object.entries(OPERATIONS)) {
			await t.test(`LOCKS-DB ${name}: one transaction-scoped advisory lock; a second caller waits on it without retrying and runs once it is released`, async () => {
				const key = op.key();
				await op.prepare(admin, key, 2);
				let second = null;
				try {
				await a.query('begin');
				await a.query(...op.sql(key, 0));
				assert.equal(await advisory(pidA, true), 1, `${name}: holds exactly one advisory lock inside its transaction (P2)`);
				second = b.query(...op.sql(key, 1));
				let state = null;
				for (let i = 0; i < 200; i++) {
					state = (await admin.query('select wait_event_type, wait_event, state from pg_stat_activity where pid = $1', [pidB])).rows[0];
					if (state?.wait_event === 'advisory') break;
					await new Promise((r) => setTimeout(r, 25));
				}
				assert.deepEqual([state?.wait_event_type, state?.wait_event], ['Lock', 'advisory'], `${name}: the second caller blocks on the advisory lock (no retry loop, no sleep) (P3)`);
				assert.equal(await advisory(pidB, false), 1, `${name}: the second caller requests exactly one advisory lock (P3)`);
				await a.query('commit');
				assert.equal(await advisory(pidA, true), 0, `${name}: the lock ends with the transaction (P1)`);
				await within(second, 10_000, `${name}: second caller after release`);
				assert.equal(await anyAdvisory(), 0, `${name}: no session keeps an advisory lock after its call (P1)`);
				} finally {
					// after the assertions: leave A and B clean so a failure stays local to this operation
					await a.query('rollback').catch(() => {});
					await a.query('select pg_advisory_unlock_all()').catch(() => {});
					await second?.catch(() => {});
					await b.query('select pg_advisory_unlock_all()').catch(() => {});
				}
			});

			await t.test(`LOCKS-DB ${name}: many simultaneous callers on separate connections all finish, no deadlock, no lock left`, async () => {
				for (let round = 0; round < 3; round++) {
					const key = op.key();
					await op.prepare(admin, key, many.length);
					const results = await within(Promise.allSettled(many.map((c, i) => c.query(...op.sql(key, i)))), 20_000, `${name} round ${round}`);
					const deadlocks = results.filter((r) => r.status === 'rejected' && r.reason?.code === '40P01');
					assert.equal(deadlocks.length, 0, `${name}: deadlock`);
					const errors = results.filter((r) => r.status === 'rejected').map((r) => `${r.reason?.code}: ${r.reason?.message}`);
					assert.deepEqual(errors, [], `${name} round ${round}: every simultaneous call ends without error`);
					assert.equal(await anyAdvisory(), 0, `${name}: no lock left after the round (P1)`);
				}
			});
		}
	} finally {
		await Promise.allSettled(conns.map((c) => c.end()));
	}
});
