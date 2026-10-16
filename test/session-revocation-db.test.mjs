/**
 * Sitzungs-Widerruf gegen echtes Postgres (CRSF Phase 2B, CR-SESSION-007, CR-CONC-005).
 *
 * Bisher war der Widerruf nur per Quelltext belegt. Hier laeuft er echt:
 * - alle Migrationen auf einer Wegwerf-Datenbank, der echte supabase-js-Client aus
 *   src/db.mjs ueber test-support/pg-postgrest.mjs (eine Anfrage = ein Statement),
 * - Abmelden ueber den echten Dashboard-Handler (DELETE /api/dashboard),
 * - danach wird jedes vorher ausgestellte Token derselben Wallet an JEDEM
 *   authentisierten Endpunkt abgelehnt (Dashboard lesen, Aktion anfordern,
 *   Telegram trennen, Positionen, Zuordnungen); andere Wallets und neue
 *   Sitzungen bleiben unberuehrt,
 * - gleichzeitige Widerrufe derselben Wallet senken den Stichtag nie.
 *
 * Nur gegen einen lokalen Wegwerf-Postgres (M1_DB_TEST_PG_URL); sonst Skip nach
 * der gemeinsamen Skip-Regel (scripts/skip-policy.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { postgrestOverPg } from '../test-support/pg-postgrest.mjs';
import { dropTestDatabase } from '../test-support/drop-test-db.mjs';

const URL_ = process.env.M1_DB_TEST_PG_URL;
const MODULE = process.env.M1_DB_TEST_PG_MODULE;
const skip = !URL_ || !MODULE ? 'M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE nicht gesetzt (Wegwerf-Postgres noetig)' : false;
const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url);
const HOST = 'revoke-db-test.invalid';

process.env.SUPABASE_URL = `https://${HOST}`;
process.env.SUPABASE_SECRET_KEY = 'revoke-db-test-not-a-key';
process.env.DASHBOARD_SESSION_SECRET = 'revoke-db-test-secret-0123456789abcdef-0123456789';
process.env.APP_BASE_URL = 'https://coverraccoon.com';
delete process.env.ALCHEMY_API_KEY;
delete process.env.INFURA_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;

let pg, dbUrl, rest, sql;
const connect = async () => { const c = new pg.Client({ connectionString: dbUrl, statement_timeout: 20_000 }); await c.connect(); return c; };
globalThis.fetch = (input, init) => rest.fetch(input, init);

const db = await import('../src/db.mjs');
const { default: dashboard } = await import('../api/dashboard.mjs');
const { createPositionsHandler } = await import('../api/positions.mjs');
const { createAttributionsHandler } = await import('../api/position-attributions.mjs');
const { createDashboardSession, SESSION_COOKIE } = await import('../src/dashboard-auth.mjs');

async function setup() {
	pg = (await import(MODULE)).default;
	pg.types.setTypeParser(1184, (text) => text);
	// Wie PostgREST: bigint als JSON-Zahl, nicht als Text (pg liefert int8 sonst als String).
	pg.types.setTypeParser(20, (text) => { const n = Number(text); if (!Number.isSafeInteger(n)) throw new Error('int8 ausserhalb von Number'); return n; });
	if (!/^postgres:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(URL_)) throw new Error('Nur gegen einen lokalen Wegwerf-Postgres.');
	const admin = new pg.Client({ connectionString: URL_ });
	await admin.connect();
	const name = `revoke_${process.pid}`;
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
	rest = postgrestOverPg({ host: HOST, connect, maxConnections: 30 });
	await rest.warm(30);
	sql = await connect();
}

const A = '0x' + 'a7'.repeat(20);
const B = '0x' + 'b7'.repeat(20);
const W = '0x' + 'c7'.repeat(20);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cookieOf = (token) => `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
let ip = 0;

async function call(handler, { method = 'GET', url = '/api/dashboard', token, body } = {}) {
	const res = { statusCode: null, body: null, headers: {}, headersSent: false, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
	const headers = { 'x-forwarded-for': `10.7.0.${(ip++ % 250) + 1}`, origin: 'https://coverraccoon.com', 'sec-fetch-site': 'same-origin' };
	if (token) headers.cookie = cookieOf(token);
	if (body !== undefined) headers['content-type'] = 'application/json';
	await handler({ method, url, headers, body, query: {} }, res);
	return res;
}

const positions = createPositionsHandler({ getPositions: async (wallet) => ({ ok: true, wallet, complete: true, positions: [], checkedDeployments: [] }), isRevoked: (w, t) => db.isDashboardSessionRevoked(w, t), rateLimit: async () => true, rateLimitFor: async () => true });
const attributions = createAttributionsHandler({
	getPositions: async (wallet) => ({ ok: true, wallet, complete: true, positions: [], checkedDeployments: ['aave-v3-ethereum-core', 'aave-v3-ethereum-lido', 'aave-v3-ethereum-etherfi'].map((deploymentKey) => ({ deploymentKey, status: 'OK' })) }),
	getCovers: async (wallet) => ({ apiVersion: 'agent.v1', wallet, covers: [] }),
	listRows: (wallet) => db.listPositionAttributions(wallet), upsertRow: (r) => db.upsertPositionAttribution(r),
	deleteRow: (w, d, c) => db.deletePositionAttribution(w, d, c), deleteStaleRow: (w, d, c, t) => db.deleteStalePositionAttribution(w, d, c, t),
	isRevoked: (w, t) => db.isDashboardSessionRevoked(w, t), rateLimit: async () => true, rateLimitFor: async () => true
});

/** Every authenticated endpoint, read and write. Returns label -> status code. */
async function everyEndpoint(token) {
	// A thrown error means the request got past the session check into data work.
	const status = async (promise) => { try { return (await promise).statusCode; } catch (error) { return `threw after the session check: ${error.message}`; } };
	return {
		'GET /api/dashboard': await status(call(dashboard, { token })),
		'POST /api/dashboard (action challenge)': await status(call(dashboard, { method: 'POST', token, body: { action: 'session-revoke' } })),
		'DELETE /api/dashboard?telegram=1': await status(call(dashboard, { method: 'DELETE', url: '/api/dashboard?telegram=1', token })),
		'GET /api/positions': await status(call(positions, { url: '/api/positions', token })),
		'GET /api/position-attributions': await status(call(attributions, { url: '/api/position-attributions', token }))
	};
}
const storedCutoff = async (wallet) => Number((await sql.query(`select nonce from public.pending_links where chat_id = $1`, [`revoked:${wallet}`])).rows[0]?.nonce ?? NaN);

test('REVOKE-DB', { skip, timeout: 300_000 }, async (t) => {
	await setup();
	try {
		await t.test('REVOKE: logout revokes every earlier session of the wallet at every authenticated endpoint', async () => {
			const old1 = createDashboardSession(A, Date.now() - 2_000, 'eoa');
			const old2 = createDashboardSession(A, Date.now() - 1_000, 'eoa');
			const other = createDashboardSession(B, Date.now() - 1_000, 'eoa');
			assert.equal((await call(positions, { url: '/api/positions', token: old1 })).statusCode, 200, 'positive control before logout');
			assert.equal((await call(attributions, { url: '/api/position-attributions', token: old1 })).statusCode, 200, 'positive control before logout');

			const logout = await call(dashboard, { method: 'DELETE', token: old2 });
			assert.equal(logout.statusCode, 200, JSON.stringify(logout.body));
			const cutoff = await storedCutoff(A);
			assert.ok(Number.isFinite(cutoff), 'a cutoff row exists in Postgres');

			for (const [label, token] of [['the logged-out session', old2], ['an older parallel session', old1]]) {
				for (const [endpoint, status] of Object.entries(await everyEndpoint(token))) assert.equal(status, 401, `${label}: ${endpoint}`);
			}
			assert.equal((await call(positions, { url: '/api/positions', token: other })).statusCode, 200, 'another wallet is untouched');
			await sleep(5);
			const fresh = createDashboardSession(A, Date.now(), 'eoa');
			assert.ok(Date.now() > cutoff);
			assert.equal((await call(positions, { url: '/api/positions', token: fresh })).statusCode, 200, 'a session issued after the logout works');
			assert.equal((await call(attributions, { url: '/api/position-attributions', token: fresh })).statusCode, 200);
		});

		await t.test('REVOKE: a revoked session cannot revoke newer sessions (no extension of the cutoff)', async () => {
			const before = await storedCutoff(A);
			const old = createDashboardSession(A, before - 1, 'eoa');
			const res = await call(dashboard, { method: 'DELETE', token: old });
			assert.equal(res.statusCode, 200);
			assert.equal(await storedCutoff(A), before, 'cutoff unchanged by an already-revoked credential');
		});

		await t.test('REVOKE-CONC: concurrent revokes of one wallet never lower the cutoff', async () => {
			const base = Date.now();
			for (const size of [2, 10, 25]) {
				const requested = Array.from({ length: size }, (_, i) => base + ((i * 7919) % size) * 1_000 + size);
				const results = await rest.race(size, (i) => db.revokeDashboardSessions(W, requested[i]));
				const max = Math.max(...requested);
				assert.equal(await storedCutoff(W), max, `N=${size}: stored cutoff is the maximum of all requests`);
				results.forEach((r, i) => assert.ok(r >= requested[i], `N=${size}: every caller gets at least its own cutoff`));
				const lower = await db.revokeDashboardSessions(W, base);
				assert.equal(lower, max, `N=${size}: a later, lower request returns the higher cutoff`);
				assert.equal(await storedCutoff(W), max, `N=${size}: a later, lower request never lowers the cutoff`);
				assert.equal(await db.isDashboardSessionRevoked(W, max), true, 'issued at the cutoff -> revoked');
				assert.equal(await db.isDashboardSessionRevoked(W, max + 1), false, 'issued after the cutoff -> valid');
			}
			assert.equal(rest.state.timeouts, 0, 'every race was truly concurrent');
			assert.equal((await sql.query(`select count(*)::int as n from public.pending_links where chat_id = $1`, [`revoked:${W}`])).rows[0].n, 1, 'exactly one cutoff row');
		});
	} finally {
		await sql?.end();
		await rest?.close();
		// Wegwerf-Datenbank wieder entfernen, damit wiederholte Laeufe (Mutationen) nichts anhaeufen.
		await dropTestDatabase(pg, URL_, dbUrl);
	}
});
