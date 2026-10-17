/**
 * Datenbank-Berechtigungen gegen echtes Postgres (CRSF Phase 2C, CR-DB-001, CR-DB-002).
 *
 * Bisher nur manuell in Produktion geprueft. Hier reproduzierbar:
 * 1. Wegwerf-Datenbank, Rollen anon/authenticated/service_role wie in Supabase,
 * 2. VOR den Migrationen die Supabase-Standardrechte nachgebildet (USAGE auf
 *    public; ALL auf neue Tabellen, Funktionen und Sequenzen fuer anon,
 *    authenticated, service_role) - sonst bestuende der Test trivial, weil eine
 *    nackte Datenbank niemandem etwas gibt,
 * 3. alle Migrationen,
 * 4. Pruefung im Katalog UND im Verhalten: unter SET ROLE anon/authenticated wird
 *    wirklich gelesen, geschrieben und aufgerufen und 42501 erwartet.
 *
 * Nicht nachgebildet: CREATE-Rechte von Supabase auf dem Schema public und
 * Objekte, die supabase_admin anlegt (siehe Migration 20260924170000).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dropTestDatabase } from '../test-support/drop-test-db.mjs';

const URL_ = process.env.M1_DB_TEST_PG_URL;
const MODULE = process.env.M1_DB_TEST_PG_MODULE;
const skip = !URL_ || !MODULE ? 'M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE nicht gesetzt (Wegwerf-Postgres noetig)' : false;
const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url);
const API_ROLES = ['anon', 'authenticated'];
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

/** RPCs the runtime calls (src/, api/: `.rpc('...')`) - service_role must reach exactly these. */
const RUNTIME_RPCS = ['alert_subscriptions_page', 'check_agent_rate_limit', 'consume_wallet_link_v2', 'revoke_dashboard_sessions_atomic', 'upsert_position_attribution_limited'];
/** Legacy, no runtime caller, service_role only (known hardening item: drop it in a later migration). */
const LEGACY_SERVICE_RPCS = ['consume_wallet_link'];
/** Internal helpers called only by other functions: no role may execute them. */
const INTERNAL_HELPERS = ['link_wallet_to_chat_limited', 'lock_chat_wallets'];
/** Current SECURITY DEFINER set; a new definer function must be added here deliberately. */
const SECURITY_DEFINER = ['alert_subscriptions_page', 'check_agent_rate_limit', 'consume_wallet_link', 'consume_wallet_link_v2', 'link_wallet_to_chat_limited', 'lock_chat_wallets'];

let pg, dbUrl, c;

async function setup() {
	pg = (await import(MODULE)).default;
	if (!/^postgres:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(URL_)) throw new Error('Nur gegen einen lokalen Wegwerf-Postgres.');
	const admin = new pg.Client({ connectionString: URL_ });
	await admin.connect();
	const name = `dbpriv_${process.pid}`;
	await admin.query(`drop database if exists ${name} with (force)`);
	await admin.query(`create database ${name}`);
	for (const role of ['anon', 'authenticated', 'service_role', 'supabase_admin']) {
		await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role}; end if; end $$`);
	}
	await admin.end();
	dbUrl = URL_.replace(/\/[^/]*$/, `/${name}`);
	c = new pg.Client({ connectionString: dbUrl });
	await c.connect();
	// Supabase-Standardrechte nachbilden (vor jeder Migration).
	await c.query(`grant usage on schema public to anon, authenticated, service_role;
		alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
		alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
		alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`);
	for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) await c.query(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
}

const tables = async () => (await c.query(`select c.oid, c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') order by c.relname`)).rows;
const functions = async () => (await c.query(`select p.oid, p.proname, p.oid::regprocedure::text as sig, p.prosecdef, p.pronargs, p.proargtypes::regtype[]::text[] as argtypes from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by p.proname`)).rows;

/** Runs `sql` as `role` inside a rolled-back transaction; returns the SQLSTATE or 'OK'. */
async function asRole(role, sql) {
	await c.query('begin');
	try {
		await c.query(`set local role ${role}`);
		await c.query(sql);
		return 'OK';
	} catch (error) {
		return error.code ?? String(error.message);
	} finally {
		await c.query('rollback');
	}
}
const nullArgs = (fn) => fn.argtypes.map((t) => `null::${t}`).join(', ');

test('DBPRIV-DB', { skip, timeout: 300_000 }, async (t) => {
	await setup();
	t.after(async () => { await c?.end(); await dropTestDatabase(pg, URL_, dbUrl); });

	await t.test('DBPRIV: every public table has row level security enabled', async () => {
		const rows = await tables();
		assert.ok(rows.length >= 10, `expected the application tables, got ${rows.length}`);
		assert.deepEqual(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname), [], 'tables without RLS');
	});

	await t.test('DBPRIV: anon and authenticated hold no table privilege at all (catalog)', async () => {
		const leaks = [];
		for (const table of await tables()) for (const role of API_ROLES) for (const p of TABLE_PRIVILEGES) {
			if ((await c.query('select has_table_privilege($1, $2::oid, $3) as x', [role, table.oid, p])).rows[0].x) leaks.push(`${role} ${p} ${table.relname}`);
		}
		assert.deepEqual(leaks, []);
	});

	await t.test('DBPRIV: anon and authenticated really cannot read or write any table (behaviour, 42501)', async () => {
		const outcomes = [];
		for (const { relname } of await tables()) for (const role of API_ROLES) {
			outcomes.push(`${role} select ${relname}: ${await asRole(role, `select * from public.${relname} limit 1`)}`);
			outcomes.push(`${role} delete ${relname}: ${await asRole(role, `delete from public.${relname}`)}`);
			outcomes.push(`${role} insert ${relname}: ${await asRole(role, `insert into public.${relname} default values`)}`);
		}
		assert.deepEqual(outcomes.filter((o) => !o.endsWith(': 42501')), [], 'every attempt must be refused with 42501');
	});

	await t.test('DBPRIV: no API role (and not service_role) can create objects in public', async () => {
		for (const role of [...API_ROLES, 'service_role']) {
			assert.equal((await c.query(`select has_schema_privilege($1, 'public', 'CREATE') as x`, [role])).rows[0].x, false, `${role} CREATE (catalog)`);
			assert.equal(await asRole(role, 'create table public.crsf_probe (x int)'), '42501', `${role} CREATE (behaviour)`);
		}
	});

	// CRSF 2Q, historische Korrektur AGENT-SEC-A7 / 638f10a: die Standardrechte sind
	// geschlossen - eine KUENFTIGE Tabelle (oder Sequenz) des Owners erbt keine Rechte
	// fuer anon/authenticated, auch wenn ihre Migration das Revoke vergisst.
	await t.test('DBPRIV: default privileges are closed - a table created after all migrations grants anon/authenticated nothing', async () => {
		await c.query('begin');
		try {
			await c.query('create table public.crsf_future_table (id bigserial primary key, x int)');
			const leaks = [];
			for (const role of API_ROLES) {
				for (const p of TABLE_PRIVILEGES) if ((await c.query(`select has_table_privilege($1, 'public.crsf_future_table', $2) as x`, [role, p])).rows[0].x) leaks.push(`${role} ${p} table`);
				for (const p of ['USAGE', 'SELECT', 'UPDATE']) if ((await c.query(`select has_sequence_privilege($1, 'public.crsf_future_table_id_seq', $2) as x`, [role, p])).rows[0].x) leaks.push(`${role} ${p} sequence`);
			}
			assert.deepEqual(leaks, [], 'a new table inherits API-role privileges from the default privileges');
		} finally {
			await c.query('rollback');
		}
	});

	await t.test('DBPRIV: function execute rights match the allowlist exactly', async () => {
		const fns = await functions();
		const names = fns.map((f) => f.proname).sort();
		assert.deepEqual(names, [...RUNTIME_RPCS, ...LEGACY_SERVICE_RPCS, ...INTERNAL_HELPERS].sort(), 'no unknown public function');
		const service = [];
		for (const fn of fns) {
			for (const role of API_ROLES) {
				assert.equal((await c.query(`select has_function_privilege($1, $2::oid, 'EXECUTE') as x`, [role, fn.oid])).rows[0].x, false, `${role} may not execute ${fn.sig}`);
				assert.equal(await asRole(role, `select public.${fn.proname}(${nullArgs(fn)})`), '42501', `${role} calling ${fn.sig}`);
			}
			const publicExec = (await c.query(`select exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as x from pg_proc p where p.oid = $1`, [fn.oid])).rows[0].x;
			assert.equal(publicExec, false, `PUBLIC may not execute ${fn.sig}`);
			if ((await c.query(`select has_function_privilege('service_role', $1::oid, 'EXECUTE') as x`, [fn.oid])).rows[0].x) service.push(fn.proname);
		}
		assert.deepEqual(service.sort(), [...RUNTIME_RPCS, ...LEGACY_SERVICE_RPCS].sort(), 'service_role reaches exactly the runtime RPCs (+ the documented legacy one)');
		for (const helper of INTERNAL_HELPERS) {
			const fn = fns.find((f) => f.proname === helper);
			assert.equal(await asRole('service_role', `select public.${helper}(${nullArgs(fn)})`), '42501', `internal helper ${helper} is not callable even by service_role`);
		}
	});

	await t.test('DBPRIV: service_role can use what the runtime needs (positive control)', async () => {
		assert.equal(await asRole('service_role', 'select count(*) from public.position_cover_attributions'), 'OK');
		assert.equal(await asRole('service_role', `select public.check_agent_rate_limit('crsf-probe', 5, 60)`), 'OK');
	});

	await t.test('DBPRIV: SECURITY DEFINER set is exactly the reviewed one, each with a fixed search_path', async () => {
		const fns = await functions();
		assert.deepEqual(fns.filter((f) => f.prosecdef).map((f) => f.proname).sort(), [...SECURITY_DEFINER].sort());
		const unpinned = (await c.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) s where s like 'search_path=%')`)).rows.map((r) => r.proname);
		assert.deepEqual(unpinned, [], 'every function pins search_path');
	});
});
