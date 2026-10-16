/*
	Restaudit H2, 16.10.2026 - Einmal-Verbrauch von Login-Challenge und Dashboard-
	Zugangscode unter ECHTER Gleichzeitigkeit gegen ECHTEN Postgres.

	consume-challenge-request.test.mjs haelt fest, WELCHE Anfrage src/db.mjs schickt:
	genau ein bedingtes PATCH (PostgREST: ein UPDATE ... WHERE nonce, wallet,
	used_at is null, expires_at > jetzt ... RETURNING), Erfolg nur bei genau einer
	zurueckgegebenen Zeile. Offen war, ob Postgres das unter gleichzeitigen Anfragen
	nur EINMAL gelingen laesst. Das prueft dieser Test:

	- Der ECHTE Code (src/db.mjs mit dem echten supabase-js-Client, und eine Ebene
	  hoeher der echte Login-Handler api/dashboard.mjs mit echter Offline-Signatur).
	- Jede Anfrage laeuft auf einer EIGENEN Postgres-Verbindung; eine Schranke gibt
	  alle N Anfragen derselben Art erst frei, wenn alle N angekommen sind - die
	  Statements laufen wirklich gleichzeitig, nicht nacheinander.
	- Transport: die PostgREST-Anfrage wird in genau das eine Statement uebersetzt,
	  das PostgREST ausfuehrt (ein UPDATE/INSERT/SELECT je Anfrage, eigene
	  Transaktion, READ COMMITTED). Mit M1_DB_TEST_POSTGREST_URL laufen dieselben
	  Anfragen stattdessen durch ein echtes PostgREST gegen dieselbe Datenbank.

	Laeuft nur mit einem Wegwerf-Postgres (wie M1-DB, dieselben Variablen), sonst
	sichtbar uebersprungen:

	  M1_DB_TEST_PG_URL=postgres://postgres@127.0.0.1:54329/postgres \
	  M1_DB_TEST_PG_MODULE=/pfad/zu/node_modules/pg/lib/index.js \
	  node --test test/h2-challenge-concurrency-db.test.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';
import { dropTestDatabase } from '../test-support/drop-test-db.mjs';

const URL_ = process.env.M1_DB_TEST_PG_URL;
const MODULE = process.env.M1_DB_TEST_PG_MODULE;
const POSTGREST = process.env.M1_DB_TEST_POSTGREST_URL?.replace(/\/$/, '') || null;
const skip = !URL_ || !MODULE ? 'M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE nicht gesetzt (Wegwerf-Postgres noetig)' : false;
const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url);
const SIZES = [2, 10, 40];
const ROUNDS = 5;

process.env.SUPABASE_URL = 'https://h2-db-test.invalid';
process.env.SUPABASE_SECRET_KEY = 'h2-db-test-not-a-key';
process.env.APP_BASE_URL = 'https://coverraccoon.com';
process.env.DASHBOARD_SESSION_SECRET = 'h2-db-test-secret-0123456789abcdef-0123456789';
delete process.env.ALCHEMY_API_KEY; // kein RPC; EOA-Signaturen werden offline geprueft

/* ------------------------------------------- Postgres, Verbindungen, Schranke -- */

let pg, dbUrl;
const idle = [];
const all = [];
async function connect() { const c = new pg.Client({ connectionString: dbUrl, statement_timeout: 20_000 }); await c.connect(); all.push(c); return c; }
async function acquire() { return idle.pop() ?? await connect(); }

/**
	Gibt Anfragen einer Art erst frei, wenn `size` Stueck angekommen sind (null = keine
	Schranke). Kommen nicht alle an (ein Teil der Aufrufer endet vorher), loest eine
	Frist die Wartenden nach 1 s - gezaehlt in `barrierTimeouts`, damit ein Haenger nie
	als Gleichzeitigkeit durchgeht.
*/
let barrier = null;
let barrierTimeouts = 0;
async function arrive(kind) {
	if (!barrier) return;
	const slot = (barrier[kind] ??= { count: 0, waiters: [], timer: null });
	slot.count++;
	const release = () => { clearTimeout(slot.timer); for (const go of slot.waiters.splice(0)) go(); };
	if (slot.count >= barrier.size) { release(); return; }
	slot.timer ??= setTimeout(() => { barrierTimeouts++; release(); }, 1_000);
	await new Promise((resolve) => slot.waiters.push(resolve));
}

const COLUMN = /^[a-z_]+$/;
const TABLES = new Set(['dashboard_challenges', 'pending_links']);

/** Eine PostgREST-Anfrage -> genau das eine Statement, das PostgREST dafuer ausfuehrt. */
function statementFor(method, table, params, body) {
	if (!TABLES.has(table)) throw new Error(`unerwartete Tabelle ${table}`);
	const values = [];
	const where = [];
	let select = '*';
	for (const [key, raw] of params) {
		if (key === 'select') { select = raw.split(',').map((c) => { if (!COLUMN.test(c)) throw new Error(c); return c; }).join(', '); continue; }
		if (key === 'columns') continue;
		if (!COLUMN.test(key)) throw new Error(`Spalte ${key}`);
		const dot = raw.indexOf('.');
		const operator = raw.slice(0, dot);
		const value = raw.slice(dot + 1);
		if (operator === 'eq') { values.push(value); where.push(`${key} = $${values.length}`); }
		else if (operator === 'gt') { values.push(value); where.push(`${key} > $${values.length}`); }
		else if (operator === 'lt') { values.push(value); where.push(`${key} < $${values.length}`); }
		else if (operator === 'like') { values.push(value.replace(/\*/g, '%')); where.push(`${key} like $${values.length}`); }
		else if (operator === 'is' && value === 'null') where.push(`${key} is null`);
		else throw new Error(`Filter ${key}=${raw}`);
	}
	const filter = where.length ? ` where ${where.join(' and ')}` : '';
	if (method === 'GET') return { text: `select ${select} from public.${table}${filter}`, values };
	if (method === 'DELETE') return { text: `delete from public.${table}${filter} returning ${select}`, values };
	if (method === 'PATCH') {
		const sets = Object.entries(body).map(([column, value]) => { if (!COLUMN.test(column)) throw new Error(column); values.push(value); return `${column} = $${values.length}`; });
		return { text: `update public.${table} set ${sets.join(', ')}${filter} returning ${select}`, values };
	}
	if (method === 'POST') {
		const rows = [].concat(body);
		const columns = Object.keys(rows[0]);
		const tuples = rows.map((row) => `(${columns.map((column) => { values.push(row[column]); return `$${values.length}`; }).join(', ')})`);
		return { text: `insert into public.${table} (${columns.join(', ')}) values ${tuples.join(', ')} returning ${select}`, values };
	}
	throw new Error(`Methode ${method}`);
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
	const url = new URL(typeof input === 'string' ? input : input.url);
	if (url.hostname !== 'h2-db-test.invalid') throw new Error(`unerwarteter Abruf ${url.hostname}`);
	const method = (init.method ?? 'GET').toUpperCase();
	const table = url.pathname.replace('/rest/v1/', '');
	await arrive(`${method} ${table}`);
	if (POSTGREST) {
		// Dieselbe Anfrage an ein echtes PostgREST (ohne den Test-Schluessel als JWT).
		const headers = new Headers(init.headers);
		headers.delete('authorization'); headers.delete('apikey');
		return realFetch(`${POSTGREST}/${table}${url.search}`, { ...init, headers });
	}
	const client = await acquire();
	try {
		const { rows } = await client.query(statementFor(method, table, url.searchParams, init.body ? JSON.parse(init.body) : null));
		const prefer = new Headers(init.headers).get('prefer') ?? '';
		if (method !== 'GET' && !prefer.includes('return=representation')) return new Response(null, { status: method === 'POST' ? 201 : 204 });
		return Response.json(rows, { status: method === 'POST' ? 201 : 200 });
	} catch (error) {
		return Response.json({ message: error.message, code: error.code }, { status: 400 });
	} finally {
		idle.push(client);
	}
};

const db = await import('../src/db.mjs');
const auth = await import('../src/dashboard-auth.mjs');
const { verifyWalletSiweAuthority } = await import('../src/contract-signature.mjs');

async function setup() {
	pg = (await import(MODULE)).default;
	if (!/^postgres:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(URL_)) throw new Error('Nur gegen einen lokalen Wegwerf-Postgres.');
	const admin = new pg.Client({ connectionString: URL_ });
	await admin.connect();
	const name = POSTGREST ? 'h2_postgrest' : `h2_${process.pid}`;
	if (!POSTGREST) {
		await admin.query(`drop database if exists ${name}`);
		await admin.query(`create database ${name}`);
		for (const role of ['anon', 'authenticated', 'service_role', 'supabase_admin']) {
			await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role}; end if; end $$`);
		}
	}
	await admin.end();
	dbUrl = URL_.replace(/\/[^/]*$/, `/${name}`);
	if (!POSTGREST) {
		const c = await connect();
		for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) await c.query(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
	}
	for (let i = 0; i < Math.max(...SIZES); i++) idle.push(await connect());
}

/* ----------------------------------------------------------------- Helfer -- */

const WALLET = '0x' + 'ab'.repeat(20);
let counter = 0;
const nonce = () => randomBytes(16).toString('hex');
const sql = async (text, values) => (await (idle[0] ?? await connect()).query(text, values)).rows;

/** N gleichzeitige Aufrufe, Schranke fuer genau diese Runde. */
async function race(size, fn) {
	barrier = { size };
	try { return await Promise.all(Array.from({ length: size }, (_, i) => fn(i))); }
	finally { barrier = null; }
}

const observed = [];

test('H2-DB', { skip, timeout: 600_000 }, async (t) => {
	await setup();
	if (!POSTGREST) t.after(() => dropTestDatabase(pg, URL_, dbUrl));
	try {

	await t.test('H2 consumeDashboardChallenge: for 2, 10 and 40 concurrent consumers exactly one succeeds, every round', async () => {
		for (const size of SIZES) {
			for (let round = 0; round < ROUNDS; round++) {
				const n = nonce();
				await db.storeDashboardChallenge({ nonce: n, wallet: WALLET, expiresAt: Date.now() + 300_000 });
				const timeoutsBefore = barrierTimeouts;
				const results = await race(size, () => db.consumeDashboardChallenge(n, WALLET));
				const successes = results.filter(Boolean).length;
				assert.equal(barrierTimeouts, timeoutsBefore, 'alle N Statements wurden gemeinsam freigegeben');
				observed.push({ primitive: 'challenge', size, round, successes });
				assert.equal(successes, 1, `N=${size} Runde ${round}: genau ein Erfolg, nicht ${successes}`);
				assert.equal(results.length - successes, size - 1, 'alle anderen abgelehnt');
				const [row] = await sql('select used_at from public.dashboard_challenges where nonce = $1', [n]);
				assert.ok(row.used_at, 'Challenge ist verbraucht');
				assert.equal(await db.consumeDashboardChallenge(n, WALLET), false, 'danach auch nacheinander kein zweiter Erfolg');
			}
		}
	});

	await t.test('H2 consumeDashboardChallenge stays bound to wallet and expiry under concurrency', async () => {
		const other = '0x' + 'cd'.repeat(20);
		// Erst deterministisch: eine fremde Wallet verbraucht die Challenge nie, die gebundene danach schon.
		const bound = nonce();
		await db.storeDashboardChallenge({ nonce: bound, wallet: WALLET, expiresAt: Date.now() + 300_000 });
		assert.equal(await db.consumeDashboardChallenge(bound, other), false, 'fremde Wallet: kein Verbrauch');
		assert.equal((await sql('select used_at from public.dashboard_challenges where nonce = $1', [bound]))[0].used_at, null, 'Challenge unberuehrt');
		assert.equal(await db.consumeDashboardChallenge(bound, WALLET), true, 'gebundene Wallet: Verbrauch');
		const n = nonce();
		await db.storeDashboardChallenge({ nonce: n, wallet: WALLET, expiresAt: Date.now() + 300_000 });
		const results = await race(10, (i) => db.consumeDashboardChallenge(n, i % 2 ? WALLET : other));
		assert.equal(results.filter(Boolean).length, 1);
		assert.ok(results.every((ok, i) => !ok || i % 2 === 1), 'nur die gebundene Wallet');
		const expired = nonce();
		await db.storeDashboardChallenge({ nonce: expired, wallet: WALLET, expiresAt: Date.now() - 1_000 });
		assert.deepEqual(await race(10, () => db.consumeDashboardChallenge(expired, WALLET)), Array(10).fill(false), 'abgelaufen: niemand');
	});

	await t.test('H2 consumeDashboardAccess: one dashboard access code yields the wallet exactly once', async () => {
		for (const size of SIZES) {
			for (let round = 0; round < ROUNDS; round++) {
				const code = `h2access${process.pid}x${++counter}`;
				await db.createDashboardAccess({ code, wallet: WALLET, expiresAt: Date.now() + 300_000 });
				const results = await race(size, () => db.consumeDashboardAccess(code));
				const successes = results.filter((w) => w === WALLET).length;
				observed.push({ primitive: 'access', size, round, successes });
				assert.equal(successes, 1, `N=${size} Runde ${round}: genau ein Erfolg, nicht ${successes}`);
				assert.ok(results.every((w) => w === WALLET || w === null));
			}
		}
	});

	await t.test('H2 auth level: concurrent logins with the same challenge and signature yield exactly one session', async () => {
		const OWNER = privateKeyToAccount(`0x${'05'.repeat(32)}`); // oeffentlicher, unbefuellter Offline-Testschluessel
		const source = readFileSync(new URL('../api/dashboard.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
		for (const size of [10, 40]) {
			for (let round = 0; round < 3; round++) {
				const events = [];
				const deps = {
					isAddress, getWalletCovers: async () => ({ covers: [] }), queryParams, singleQueryValue, ...auth,
					verifyWalletSiweAuthority, isDeployedContract: async () => false,
					beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
					// Die Datenbank-Grenze ist ECHT: Verbrauch und Speichern laufen gegen Postgres.
					consumeDashboardChallenge: db.consumeDashboardChallenge, consumeDashboardAccess: db.consumeDashboardAccess,
					storeDashboardChallenge: db.storeDashboardChallenge, isDashboardChallengeOpen: db.isDashboardChallengeOpen,
					getLanguage: async () => 'de', getWalletLinkStateByWallet: async () => ({ linked: false, link: null }),
					isDashboardSessionRevoked: async () => false, recordAgentEvent: async () => {}, revokeDashboardSessions: async () => Date.now(),
					unlinkWalletByWallet: async () => [], ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {},
					enforceRateLimit: async () => true, enforceRateLimitFor: async () => true, requireJson: () => true, requireSameOrigin: () => true,
					recordSecurityEvent: async (type) => { events.push(type); }, securityFingerprint: () => 'fp',
					SECURITY_EVENT: { SIWE_SIGNATURE_INVALID: 'invalid', SIWE_REPLAY_BLOCKED: 'replay', ACCESS_CODE_INVALID: 'access' }
				};
				const handler = new Function(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps));
				const challenge = auth.createDashboardChallenge(OWNER.address);
				const stored = auth.verifyDashboardToken(challenge.token);
				await db.storeDashboardChallenge({ nonce: stored.nonce, wallet: stored.wallet, expiresAt: stored.exp });
				const signature = await OWNER.signMessage({ message: challenge.message });
				const responses = await race(size, async () => {
					const res = { headers: {}, status(n) { this.code = n; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.body = b; return this; } };
					await handler({ method: 'POST', query: {}, headers: {}, body: { wallet: OWNER.address, token: challenge.token, signature } }, res);
					return res;
				});
				const sessions = responses.filter((r) => r.code === 200 && String(r.headers['set-cookie'] ?? '').includes(`${auth.SESSION_COOKIE}=`));
				observed.push({ primitive: 'login', size, round, successes: sessions.length });
				assert.equal(sessions.length, 1, `N=${size} Runde ${round}: genau eine Sitzung, nicht ${sessions.length}`);
				assert.deepEqual(responses.map((r) => r.code).sort(), [200, ...Array(size - 1).fill(409)], 'alle anderen: 409 bereits verwendet');
				assert.ok(responses.every((r) => r.code === 200 || r.headers['set-cookie'] === undefined), 'keine Sitzung fuer die anderen');
				assert.equal(events.filter((e) => e === 'replay').length, size - 1);
			}
		}
	});

	t.diagnostic(`H2 barrier timeouts: ${barrierTimeouts}`);
	t.diagnostic(`H2 observed: ${JSON.stringify(observed.reduce((acc, o) => { const k = `${o.primitive}@${o.size}`; acc[k] = Math.max(acc[k] ?? 0, o.successes); return acc; }, {}))}`);
	} finally {
		await Promise.allSettled(all.map((c) => c.end()));
	}
});
