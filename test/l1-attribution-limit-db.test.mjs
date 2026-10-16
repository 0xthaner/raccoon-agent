/*
	Restaudit L1, 16.10.2026 - hoechstens 60 gespeicherte Cover-Zuordnungen je
	Wallet, auch unter ECHTER Gleichzeitigkeit gegen ECHTEN Postgres.

	Gegen den echten Handler (api/position-attributions.mjs) mit echter Sitzung und
	dem echten Datenbank-Code (src/db.mjs, echter supabase-js-Client). Jede Anfrage
	laeuft auf einer eigenen Verbindung; eine Schranke gibt alle N Anfragen derselben
	Art gemeinsam frei (test-support/pg-postgrest.mjs). Nur die externen Abfragen
	(Positionen per RPC, Covers von Nexus) sind Nachbauten.

	Laeuft nur mit einem Wegwerf-Postgres (dieselben Variablen wie M1-DB), sonst
	sichtbar uebersprungen:

	  M1_DB_TEST_PG_URL=postgres://postgres@127.0.0.1:54329/postgres \
	  M1_DB_TEST_PG_MODULE=/pfad/zu/node_modules/pg/lib/index.js \
	  node --test test/l1-attribution-limit-db.test.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { postgrestOverPg } from '../test-support/pg-postgrest.mjs';

const URL_ = process.env.M1_DB_TEST_PG_URL;
const MODULE = process.env.M1_DB_TEST_PG_MODULE;
const skip = !URL_ || !MODULE ? 'M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE nicht gesetzt (Wegwerf-Postgres noetig)' : false;
const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url);
const HOST = 'l1-db-test.invalid';
const SIZES = [2, 10, 20, 40];
const ROUNDS = 5;

process.env.SUPABASE_URL = `https://${HOST}`;
process.env.SUPABASE_SECRET_KEY = 'l1-db-test-not-a-key';
process.env.DASHBOARD_SESSION_SECRET = 'l1-db-test-secret-0123456789abcdef-0123456789';
process.env.APP_BASE_URL = 'https://coverraccoon.com';

let pg, dbUrl, rest;
const connect = async () => { const c = new pg.Client({ connectionString: dbUrl, statement_timeout: 20_000 }); await c.connect(); return c; };
globalThis.fetch = (input, init) => rest.fetch(input, init);

const db = await import('../src/db.mjs');
const { createAttributionsHandler } = await import('../api/position-attributions.mjs');
const { createDashboardSession, SESSION_COOKIE } = await import('../src/dashboard-auth.mjs');

async function setup() {
	pg = (await import(MODULE)).default;
	if (!/^postgres:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(URL_)) throw new Error('Nur gegen einen lokalen Wegwerf-Postgres.');
	const admin = new pg.Client({ connectionString: URL_ });
	await admin.connect();
	const name = `l1_${process.pid}`;
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
	rest = postgrestOverPg({ host: HOST, connect, maxConnections: 100 });
	await rest.warm(100);
}

/* --------------------------------------------------------- Daten und Helfer -- */

const A = '0x' + 'a7'.repeat(20);
const B = '0x' + 'b8'.repeat(20);
const CORE = 'aave-v3-ethereum-core';
const LIDO = 'aave-v3-ethereum-lido';
const ETHERFI = 'aave-v3-ethereum-etherfi';
const NEXUS = { state: 'MATCHED', productId: 97, productName: 'Aave v3' };
const positionsOf = (wallet) => ({
	ok: true, wallet, complete: true,
	positions: [CORE, LIDO, ETHERFI].map((deploymentKey) => ({ deploymentKey, label: deploymentKey, nexus: NEXUS, supplied: [{ symbol: 'USDC', amount: '100' }], borrowed: [] })),
	checkedDeployments: [CORE, LIDO, ETHERFI].map((deploymentKey) => ({ deploymentKey, status: 'OK' }))
});
const coversOf = (wallet) => ({ apiVersion: 'agent.v1', wallet, covers: Array.from({ length: 400 }, (_, i) => ({ coverId: i + 1, productId: 97, productName: 'Aave v3', status: 'active', amount: '1', asset: { symbol: 'USDC' }, endsAt: '2027-01-01T00:00:00.000Z' })) });

let sql;
const count = async (wallet) => Number((await sql.query('select count(*) from public.position_cover_attributions where wallet = $1', [wallet])).rows[0].count);
async function reset(wallet, rows) {
	await sql.query('delete from public.position_cover_attributions where wallet = $1', [wallet]);
	for (let i = 0; i < rows; i++) {
		await sql.query(`insert into public.position_cover_attributions (wallet, protocol_key, protocol_version, deployment_key, product_id, cover_id) values ($1, 'aave', 'v3', $2, 97, $3)`, [wallet, CORE, 300 + i]);
	}
}
const duplicates = async () => Number((await sql.query('select count(*) from (select wallet, deployment_key, cover_id from public.position_cover_attributions group by 1, 2, 3 having count(*) > 1) d')).rows[0].count);

const handler = createAttributionsHandler({
	getPositions: async (wallet) => positionsOf(wallet),
	getCovers: async (wallet) => coversOf(wallet),
	listRows: (wallet) => db.listPositionAttributions(wallet),
	upsertRow: (relation) => db.upsertPositionAttribution(relation),
	deleteRow: (wallet, deploymentKey, coverId) => db.deletePositionAttribution(wallet, deploymentKey, coverId),
	isRevoked: async () => false,
	// Rate-Limits sind eine eigene Schranke (je Wallet 30 / 10 min) und nicht Gegenstand dieses Tests.
	rateLimit: async () => true, rateLimitFor: async () => true
});
async function post(wallet, deploymentKey, coverId) {
	const res = { statusCode: null, body: null, headers: {}, headersSent: false, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
	await handler({ method: 'POST', url: '/api/position-attributions', headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(createDashboardSession(wallet))}`, 'content-type': 'application/json' }, body: { deploymentKey, coverId } }, res);
	return res;
}
const tally = (responses) => ({ ok: responses.filter((r) => r.statusCode === 200).length, limit: responses.filter((r) => r.statusCode === 409 && r.body?.code === 'TOO_MANY_ATTRIBUTIONS').length, other: responses.filter((r) => r.statusCode !== 200 && r.statusCode !== 409).map((r) => `${r.statusCode}:${r.body?.code}`) });

const observed = [];

test('L1-DB', { skip, timeout: 600_000 }, async (t) => {
	await setup();
	sql = await connect();
	try {

	await t.test('L1 API: 59 stored + N concurrent new relations -> exactly one stored, the rest TOO_MANY, never more than 60', async () => {
		for (const size of SIZES) {
			for (let round = 0; round < ROUNDS; round++) {
				await reset(A, 59);
				const timeouts = rest.state.timeouts;
				const responses = await rest.race(size, (i) => post(A, LIDO, i + 1));
				const final = await count(A);
				const result = tally(responses);
				observed.push({ layer: 'api', size, round, ...result, final });
				assert.ok(final <= 60, `N=${size} Runde ${round}: ${final} Zeilen gespeichert - mehr als 60`);
				assert.deepEqual([result.ok, result.limit, result.other, final], [1, size - 1, [], 60], `N=${size} Runde ${round}`);
				assert.equal(rest.state.timeouts, timeouts, 'alle N Anfragen wurden gemeinsam freigegeben');
				assert.equal(await duplicates(), 0);
			}
		}
	});

	await t.test('L1 API: at the limit a stored relation can still be re-confirmed (idempotent), a new one cannot', async () => {
		await reset(A, 60);
		const again = await post(A, CORE, 300 + 7);
		assert.equal(again.statusCode, 200, 'bestehende Zuordnung erneut bestaetigen');
		const fresh = await post(A, LIDO, 1);
		assert.equal(fresh.statusCode, 409);
		assert.equal(fresh.body.code, 'TOO_MANY_ATTRIBUTIONS');
		assert.equal(await count(A), 60);
	});

	const relation = (wallet, deploymentKey, coverId) => ({ wallet, protocolKey: 'aave', protocolVersion: 'v3', deploymentKey, productId: 97, coverId, now: Date.now() });

	await t.test('L1 DB: 60 stored + 20 concurrent new relations -> nothing stored', async () => {
		await reset(A, 60);
		const outcomes = await rest.race(20, (i) => db.upsertPositionAttribution(relation(A, ETHERFI, i + 1)));
		observed.push({ layer: 'db', case: '60+20', statuses: outcomes.map((o) => o?.status).join(',') });
		assert.deepEqual(outcomes.map((o) => o.status), Array(20).fill('limit'));
		assert.equal(await count(A), 60);
	});

	await t.test('L1 DB: 0 stored + 100 concurrent new relations -> exactly 60 stored', async () => {
		await reset(A, 0);
		const outcomes = await rest.race(100, (i) => db.upsertPositionAttribution(relation(A, [CORE, LIDO, ETHERFI][i % 3], 10 + i)));
		const final = await count(A);
		observed.push({ layer: 'db', case: '0+100', final });
		assert.equal(final, 60);
		assert.equal(outcomes.filter((o) => o.status === 'inserted').length, 60);
		assert.equal(outcomes.filter((o) => o.status === 'limit').length, 40);
	});

	await t.test('L1 DB: two wallets reach 60 independently while racing at the same time', async () => {
		await reset(A, 30);
		await reset(B, 30);
		const outcomes = await rest.race(80, (i) => db.upsertPositionAttribution(relation(i % 2 ? B : A, LIDO, 1 + Math.floor(i / 2))));
		observed.push({ layer: 'db', case: '2x(30+40)', a: await count(A), b: await count(B) });
		assert.equal(await count(A), 60);
		assert.equal(await count(B), 60);
		assert.equal(outcomes.filter((o) => o.status === 'inserted').length, 60);
	});

	await t.test('L1 DB: the same new relation raced 20 times is stored once; the others confirm it, none is refused', async () => {
		await reset(A, 59);
		const outcomes = await rest.race(20, () => db.upsertPositionAttribution(relation(A, LIDO, 5)));
		assert.equal(await count(A), 60);
		assert.equal(await duplicates(), 0);
		assert.deepEqual(outcomes.map((o) => o.status).sort(), ['inserted', ...Array(19).fill('updated')]);
		assert.ok(outcomes.every((o) => o.row?.deployment_key === LIDO && Number(o.row?.cover_id) === 5));
	});

	t.diagnostic(`L1 observed: ${JSON.stringify(observed)}`);
	} finally {
		await sql.end();
		await rest?.close();
	}
});
