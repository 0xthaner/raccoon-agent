/*
	Restaudit M1, 15.10.2026 - die DATENBANK-Seite gegen einen ECHTEN Postgres.

	Laeuft nur mit einem Wegwerf-Postgres (nie Produktion!), sonst sichtbar
	uebersprungen - auch in der CI, die keinen Postgres hat:

	  M1_DB_TEST_PG_URL=postgres://postgres@127.0.0.1:54329/postgres \
	  M1_DB_TEST_PG_MODULE=/pfad/zu/node_modules/pg/lib/index.js \
	  node --test test/m1-wallet-limit-db.test.mjs

	Der Test legt eine eigene Datenbank an, spielt ALLE Migrationen ein und
	prueft dann: Wallet-Limit je Chat (auch bei gleichzeitigen Verknuepfungen
	ueber getrennte Verbindungen), dass am Limit nichts geschrieben und kein Code
	verbraucht wird, die Seitenabfrage der Erinnerungs-Abos und die Rechte.
	`pg` ist bewusst keine Abhaengigkeit des Projekts.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dropTestDatabase } from '../test-support/drop-test-db.mjs';

const URL_ = process.env.M1_DB_TEST_PG_URL;
const MODULE = process.env.M1_DB_TEST_PG_MODULE;
const skip = !URL_ || !MODULE ? 'M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE nicht gesetzt (Wegwerf-Postgres noetig)' : false;
const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url);
const MAX = 10;

let pg, dbUrl;
async function setup() {
	pg = (await import(MODULE)).default;
	if (!/^postgres:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(URL_)) throw new Error('Nur gegen einen lokalen Wegwerf-Postgres.');
	const admin = new pg.Client({ connectionString: URL_ });
	await admin.connect();
	const name = `m1_${process.pid}`;
	await admin.query(`drop database if exists ${name}`);
	await admin.query(`create database ${name}`);
	for (const role of ['anon', 'authenticated', 'service_role', 'supabase_admin']) {
		await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role}; end if; end $$`);
	}
	await admin.end();
	dbUrl = URL_.replace(/\/[^/]*$/, `/${name}`);
	const c = await client();
	for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) await c.query(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
	await c.end();
}
async function client() { const c = new pg.Client({ connectionString: dbUrl, statement_timeout: 20_000 }); await c.connect(); return c; }
/** n eigene Verbindungen, IMMER geschlossen - auch wenn eine Abfrage scheitert. */
async function withConnections(n, fn) {
	const conns = await Promise.all(Array.from({ length: n }, () => client()));
	try { return await fn(conns); } finally { await Promise.allSettled(conns.map((k) => k.end())); }
}

const wallet = (n) => `0x${n.toString(16).padStart(40, '0')}`;
async function pending(c, code, chat) {
	await c.query(`insert into public.pending_links (code, chat_id, nonce, expires_at) values ($1, $2, $3, now() + interval '10 minutes')`, [code, chat, 'ab'.repeat(16)]);
}
async function consume(c, code, w) { return (await c.query('select public.consume_wallet_link_v2($1, $2) as r', [code, w])).rows[0].r; }
async function count(c, chat) { return Number((await c.query('select count(*) from public.monitored_wallets where chat_id = $1', [chat])).rows[0].count); }

test('M1-DB', { skip, timeout: 240_000 }, async (t) => {
	await setup();
	t.after(() => dropTestDatabase(pg, URL_, dbUrl));
	const c = await client();
	try {

	await t.test('A/B: a chat links up to 10 wallets; wallet 11 is rejected with a stable result and NOTHING is written', async () => {
		const chat = '1001';
		for (let i = 1; i <= MAX; i++) {
			await pending(c, `codeA${i}`, chat);
			assert.deepEqual(await consume(c, `codeA${i}`, wallet(i)), { status: 'linked', chat_id: chat }, `Wallet ${i}`);
		}
		assert.equal(await count(c, chat), MAX);
		const before = (await c.query('select wallet, linked_at from public.wallet_links where chat_id = $1', [chat])).rows;
		await pending(c, 'codeA11', chat);
		assert.deepEqual(await consume(c, 'codeA11', wallet(11)), { status: 'wallet_limit', chat_id: chat });
		assert.equal(await count(c, chat), MAX, 'keine elfte Zeile');
		assert.deepEqual((await c.query('select wallet, linked_at from public.wallet_links where chat_id = $1', [chat])).rows, before, 'Primaerverknuepfung unveraendert');
		assert.equal((await c.query(`select used_at from public.pending_links where code = 'codeA11'`)).rows[0].used_at, null, 'Code bleibt unverbraucht');
	});

	await t.test('already-linked wallets keep working at the limit; another chat is unaffected', async () => {
		await pending(c, 'codeA-relink', '1001');
		assert.deepEqual(await consume(c, 'codeA-relink', wallet(3).toUpperCase().replace('0X', '0x')), { status: 'linked', chat_id: '1001' });
		assert.equal(await count(c, '1001'), MAX);
		await pending(c, 'codeOther', '2002');
		assert.equal((await consume(c, 'codeOther', wallet(11))).status, 'linked');
	});

	await t.test('invalid, used and expired codes stay invalid', async () => {
		assert.deepEqual(await consume(c, 'nope', wallet(1)), { status: 'invalid' });
		assert.deepEqual(await consume(c, 'codeA1', wallet(1)), { status: 'invalid' }, 'schon verbraucht');
		await c.query(`insert into public.pending_links (code, chat_id, nonce, expires_at) values ('old', '3003', 'x', now() - interval '1 minute')`);
		assert.deepEqual(await consume(c, 'old', wallet(1)), { status: 'invalid' });
	});

	await t.test('C: 40 concurrent link attempts for one chat over separate connections never exceed the limit', async () => {
		for (let round = 0; round < 5; round++) {
			const chat = `40${round}`;
			for (let i = 0; i < 40; i++) await pending(c, `race${round}-${i}`, chat);
			const results = await withConnections(40, (conns) => Promise.all(conns.map((k, i) => consume(k, `race${round}-${i}`, wallet(1000 + i)))));
			assert.equal(results.filter((r) => r.status === 'linked').length, MAX, `Runde ${round}: genau ${MAX} verknuepft`);
			assert.equal(results.filter((r) => r.status === 'wallet_limit').length, 40 - MAX);
			assert.equal(await count(c, chat), MAX, `Runde ${round}: Zeilen`);
			assert.equal(Number((await c.query('select count(*) from public.pending_links where chat_id = $1 and used_at is not null', [chat])).rows[0].count), MAX, 'nur verknuepfte Codes verbraucht');
		}
	});

	await t.test('the same code raced over separate connections links once', async () => {
		await pending(c, 'same', '5005');
		const results = await withConnections(10, (conns) => Promise.all(conns.map((k, i) => consume(k, 'same', wallet(2000 + i)))));
		assert.equal(results.filter((r) => r.status === 'linked').length, 1);
		assert.equal(await count(c, '5005'), 1);
	});

	await t.test('the legacy entry points enforce the same limit (no second path without it)', async () => {
		await pending(c, 'legacy', '1001');
		assert.equal((await c.query(`select public.consume_wallet_link('legacy', $1) as r`, [wallet(50)])).rows[0].r, null);
		assert.equal(await count(c, '1001'), MAX);
		// Restaudit L2: der unsignierte Handoff-Weg existiert nach der letzten Migration nicht mehr.
		const gone = (await c.query(`select to_regprocedure('public.consume_telegram_handoff(text,text)') as fn, to_regclass('public.telegram_handoffs') as tbl`)).rows[0];
		assert.deepEqual(gone, { fn: null, tbl: null });
		await pending(c, 'legacyOk', '6006');
		assert.equal((await c.query(`select public.consume_wallet_link('legacyOk', $1) as r`, [wallet(52)])).rows[0].r, '6006');
	});

	await t.test('alert_subscriptions_page: keyset order, bounds, page cap 200, only enabled, language default', async () => {
		await c.query('delete from public.monitored_wallets');
		const rows = [];
		for (let i = 0; i < 450; i++) rows.push([`9${String(i % 150).padStart(3, '0')}`, wallet(i), i % 7 !== 0]);
		for (const [chat, w, enabled] of rows) await c.query('insert into public.monitored_wallets (chat_id, wallet, alerts_enabled) values ($1, $2, $3)', [chat, w, enabled]);
		await c.query(`insert into public.user_preferences (chat_id, language) values ('9001', 'en') on conflict (chat_id) do update set language = 'en'`);
		const expected = rows.filter((r) => r[2]).map(([chat, w]) => `${chat}|${w}`).sort();
		const page = async (after, through, size) => (await c.query('select * from public.alert_subscriptions_page($1, $2, $3, $4, $5)', [after?.[0] ?? null, after?.[1] ?? null, through?.[0] ?? null, through?.[1] ?? null, size])).rows;
		assert.equal((await page(null, null, 100000)).length, 200, 'serverseitig auf 200 gedeckelt');
		const seen = [];
		let after = null;
		for (;;) { const p = await page(after, null, 37); if (!p.length) break; seen.push(...p.map((r) => `${r.chat_id}|${r.wallet}`)); after = [p.at(-1).chat_id, p.at(-1).wallet]; }
		assert.deepEqual(seen, expected, 'jede aktive Zeile genau einmal, deterministisch sortiert');
		const cut = expected[100].split('|');
		const upTo = (await page(null, cut, 200)).map((r) => `${r.chat_id}|${r.wallet}`);
		assert.deepEqual(upTo, expected.slice(0, 101), 'through ist inklusiv');
		assert.equal((await page(null, null, 200)).find((r) => r.chat_id === '9001').language, 'en');
		assert.equal((await page(null, null, 200)).find((r) => r.chat_id === '9002').language, 'de');
	});

	await t.test('grants: only service_role reaches the new functions; internal helpers reach nobody; run state server-only', async () => {
		const can = async (role, fn) => (await c.query('select has_function_privilege($1, $2, \'execute\') as ok', [role, fn])).rows[0].ok;
		for (const fn of ['public.consume_wallet_link_v2(text,text)', 'public.alert_subscriptions_page(text,text,text,text,integer)', 'public.consume_wallet_link(text,text)']) {
			assert.equal(await can('service_role', fn), true, fn);
			for (const role of ['anon', 'authenticated']) assert.equal(await can(role, fn), false, `${role} ${fn}`);
		}
		for (const fn of ['public.link_wallet_to_chat_limited(text,text)', 'public.lock_chat_wallets(text)']) {
			for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await can(role, fn), false, `${role} ${fn}`);
		}
		for (const role of ['anon', 'authenticated']) assert.equal((await c.query(`select has_table_privilege($1, 'public.alert_run_state', 'select') as ok`, [role])).rows[0].ok, false);
		assert.equal((await c.query(`select relrowsecurity from pg_class where oid = 'public.alert_run_state'::regclass`)).rows[0].relrowsecurity, true);
	});

	} finally { await c.end(); }
});
