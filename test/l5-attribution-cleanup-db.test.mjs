/*
	Restaudit L5, 16.10.2026 - die Bereinigung beim Abgleich (GET /api/position-
	attributions) gegen ECHTEN Postgres.

	Die Datenschutzinformation verspricht: nachweislich veraltete Zuordnungen loeschen
	wir "beim naechsten Abgleich". Deshalb bleibt die Bereinigung im GET - aber:
	- nur Zeilen der Sitzungs-Wallet,
	- nur auf positiven Nachweis (Abfrage erfolgreich UND Cover/Position fehlt),
	- nur, solange die Zeile seit dem Lesen nicht neu bestaetigt wurde (confirmed_at).

	Echter Handler, echter Datenbank-Code (src/db.mjs, supabase-js), echte Tabelle mit
	allen Migrationen. Jede Anfrage auf eigener Verbindung (test-support/pg-postgrest.mjs).
	Nur die externen Abfragen (Positionen, Covers) sind Nachbauten; Zeitstempel kommen
	wie bei PostgREST als Text mit voller Genauigkeit zurueck.

	Laeuft nur mit einem Wegwerf-Postgres (dieselben Variablen wie M1-DB), sonst
	sichtbar uebersprungen.
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
const HOST = 'l5-db-test.invalid';

process.env.SUPABASE_URL = `https://${HOST}`;
process.env.SUPABASE_SECRET_KEY = 'l5-db-test-not-a-key';
process.env.DASHBOARD_SESSION_SECRET = 'l5-db-test-secret-0123456789abcdef-0123456789';
process.env.APP_BASE_URL = 'https://coverraccoon.com';

let pg, dbUrl, rest, sql;
const connect = async () => { const c = new pg.Client({ connectionString: dbUrl, statement_timeout: 20_000 }); await c.connect(); return c; };
globalThis.fetch = (input, init) => rest.fetch(input, init);

const db = await import('../src/db.mjs');
const { createAttributionsHandler } = await import('../api/position-attributions.mjs');
const { createDashboardSession, SESSION_COOKIE } = await import('../src/dashboard-auth.mjs');

async function setup() {
	pg = (await import(MODULE)).default;
	// Wie PostgREST: timestamptz als Text mit Mikrosekunden, nicht als JS-Date (Millisekunden).
	pg.types.setTypeParser(1184, (text) => text);
	if (!/^postgres:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(URL_)) throw new Error('Nur gegen einen lokalen Wegwerf-Postgres.');
	const admin = new pg.Client({ connectionString: URL_ });
	await admin.connect();
	const name = `l5_${process.pid}`;
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
	rest = postgrestOverPg({ host: HOST, connect, maxConnections: 20 });
	await rest.warm(20);
	sql = await connect();
}

/* ------------------------------------------------------------- Daten -- */

const A = '0x' + 'a5'.repeat(20);
const B = '0x' + 'b5'.repeat(20);
const CORE = 'aave-v3-ethereum-core';
const LIDO = 'aave-v3-ethereum-lido';
const ETHERFI = 'aave-v3-ethereum-etherfi';
const NEXUS = { state: 'MATCHED', productId: 97, productName: 'Aave v3' };
const position = (deploymentKey) => ({ deploymentKey, label: deploymentKey, nexus: NEXUS, supplied: [{ symbol: 'USDC', amount: '100' }], borrowed: [] });
const positionsOf = (wallet, { markets = [CORE, LIDO, ETHERFI], unavailable = [] } = {}) => ({
	ok: true, wallet, complete: !unavailable.length,
	positions: markets.filter((m) => !unavailable.includes(m)).map(position),
	checkedDeployments: [CORE, LIDO, ETHERFI].map((deploymentKey) => ({ deploymentKey, status: unavailable.includes(deploymentKey) ? 'UNAVAILABLE' : 'OK' }))
});
const cover = (coverId, extra = {}) => ({ coverId, productId: 97, productName: 'Aave v3', status: 'active', amount: '1', asset: { symbol: 'USDC' }, endsAt: '2027-01-01T00:00:00.000Z', ...extra });
const coversOf = (wallet, covers) => ({ apiVersion: 'agent.v1', wallet, covers });

/** Handler mit eigener Sicht auf die Aussenwelt; Datenbank ist fuer alle dieselbe. */
function handlerWith({ positions = (w) => positionsOf(w), covers = (w) => coversOf(w, [cover(1), cover(2), cover(3)]) } = {}) {
	return createAttributionsHandler({
		getPositions: async (wallet) => positions(wallet),
		getCovers: async (wallet) => covers(wallet),
		listRows: (wallet) => db.listPositionAttributions(wallet),
		upsertRow: (relation) => db.upsertPositionAttribution(relation),
		deleteRow: (wallet, deploymentKey, coverId) => db.deletePositionAttribution(wallet, deploymentKey, coverId),
		deleteStaleRow: (wallet, deploymentKey, coverId, confirmedAt) => db.deleteStalePositionAttribution(wallet, deploymentKey, coverId, confirmedAt),
		isRevoked: async () => false, rateLimit: async () => true, rateLimitFor: async () => true
	});
}
async function call(handler, { method = 'GET', wallet = A, body, query = {} } = {}) {
	const res = { statusCode: null, body: null, headers: {}, headersSent: false, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; this.headersSent = true; return this; } };
	const qs = new URLSearchParams(query).toString();
	await handler({ method, url: qs ? `/api/position-attributions?${qs}` : '/api/position-attributions', headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(createDashboardSession(wallet))}`, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) }, body }, res);
	return res;
}
async function seed(wallet, relations) {
	for (const [deploymentKey, coverId] of relations) {
		await sql.query(`insert into public.position_cover_attributions (wallet, protocol_key, protocol_version, deployment_key, product_id, cover_id) values ($1, 'aave', 'v3', $2, 97, $3)`, [wallet, deploymentKey, coverId]);
	}
}
const rowsOf = async (wallet) => (await sql.query('select deployment_key, cover_id::int as cover_id, confirmed_at from public.position_cover_attributions where wallet = $1 order by deployment_key, cover_id', [wallet])).rows;
const keys = (rows) => rows.map((r) => `${r.deployment_key}#${r.cover_id}`);
const writesDuring = async (fn) => { const before = rest.state.requests.length; await fn(); return rest.state.requests.slice(before).filter((r) => !r.startsWith('GET ')); };

/** Haengt etwas, scheitert der Test benannt statt am Zeitlimit des Runners. */
const within = (promise, label, ms = 5_000) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`haengt: ${label}`)), ms); })]).finally(() => clearTimeout(timer)); };

/** Ein Tor: die Aussenwelt-Abfrage wartet, bis es geoeffnet wird. `arrived` scheitert nach 5 s. */
function gate() {
	let open; const opened = new Promise((resolve) => { open = resolve; });
	let reached; const arrival = new Promise((resolve) => { reached = resolve; });
	return { wait: async () => { reached(); await opened; }, open, get arrived() { return within(arrival, 'GET erreicht die Abfrage nicht'); } };
}

test('L5-DB', { skip, timeout: 300_000 }, async (t) => {
	await setup();
	t.after(() => dropTestDatabase(pg, URL_, dbUrl));
	try {

	t.beforeEach(async () => { await sql.query('delete from public.position_cover_attributions'); });

	await t.test('L5-A: a GET by wallet A deletes only A\'s provably stale rows - B\'s identical relations stay', async () => {
		await seed(A, [[CORE, 1], [LIDO, 2]]);
		await seed(B, [[CORE, 1], [LIDO, 2]]);
		const r = await call(handlerWith({ covers: (w) => coversOf(w, [cover(2)]) }), { wallet: A });
		assert.equal(r.statusCode, 200);
		// Lido/Prime: Altbestand bleibt gespeichert, gilt aber nie als Zuordnung (25.10.2026).
		assert.deepEqual(r.body.attributions.map((a) => a.coverId), []);
		assert.deepEqual(r.body.unconfirmed.map((a) => [a.coverId, a.coverageScope]), [[2, 'UNCONFIRMED']]);
		assert.equal(r.body.removed, 1);
		assert.deepEqual(keys(await rowsOf(A)), [`${LIDO}#2`]);
		assert.deepEqual(keys(await rowsOf(B)), [`${CORE}#1`, `${LIDO}#2`], 'Wallet B unberuehrt');
	});

	await t.test('L5-B: a wallet in query or body never changes whose rows are read or cleaned', async () => {
		await seed(B, [[CORE, 1]]);
		const h = handlerWith({ covers: (w) => coversOf(w, []) });
		const viaQuery = await call(h, { wallet: A, query: { wallet: B } });
		assert.equal(viaQuery.statusCode, 400);
		assert.deepEqual(keys(await rowsOf(B)), [`${CORE}#1`]);
		const asA = await call(h, { wallet: A });
		assert.deepEqual([asA.statusCode, asA.body.attributions.length], [200, 0]);
		assert.deepEqual(keys(await rowsOf(B)), [`${CORE}#1`], 'A sieht und loescht B nie');
	});

	await t.test('L5-C/D/E: provider failure, timeout, malformed or partial data deletes nothing and shows nothing as current', async () => {
		const cases = {
			'positions throws': { positions: () => { throw new Error('rpc down'); } },
			'covers throws': { covers: () => { throw new Error('index down'); } },
			'covers timeout': { covers: () => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 20)) },
			'covers malformed (no array)': { covers: (w) => ({ wallet: w, covers: 'none' }) },
			'covers for another wallet': { covers: () => coversOf(B, []) },
			'positions for another wallet': { positions: () => positionsOf(B, { markets: [] }) },
			'positions partial (markets unavailable)': { positions: (w) => positionsOf(w, { markets: [], unavailable: [CORE, LIDO] }) },
			'positions null': { positions: () => null }
		};
		for (const [label, view] of Object.entries(cases)) {
			await sql.query('delete from public.position_cover_attributions');
			await seed(A, [[CORE, 1], [LIDO, 2]]);
			let r;
			const writes = await writesDuring(async () => { r = await call(handlerWith(view)); });
			assert.equal(r.statusCode, 200, label);
			assert.deepEqual(r.body.attributions, [], `${label}: nichts als aktuell gezeigt`);
			assert.equal(r.body.pending, 2, label);
			assert.deepEqual(writes, [], `${label}: kein Schreibzugriff`);
			assert.deepEqual(keys(await rowsOf(A)), [`${CORE}#1`, `${LIDO}#2`], `${label}: nichts geloescht`);
		}
	});

	await t.test('L5-F/G: a stale row is deleted, a valid row survives, an empty but complete cover list counts as proof', async () => {
		await seed(A, [[CORE, 1], [LIDO, 2], [ETHERFI, 3]]);
		const r = await call(handlerWith({ covers: (w) => coversOf(w, [cover(1, { status: 'expired' }), cover(2)]) }));
		assert.deepEqual([r.body.attributions.map((a) => a.coverId), r.body.unconfirmed.map((a) => a.coverId), r.body.removed], [[], [2], 2]);
		assert.deepEqual(keys(await rowsOf(A)), [`${LIDO}#2`]);
		const empty = await call(handlerWith({ covers: (w) => coversOf(w, []) }));
		assert.deepEqual([empty.body.attributions.length, empty.body.removed], [0, 1], 'vollstaendige Antwort "keine Covers" ist ein Nachweis');
		assert.deepEqual(await rowsOf(A), []);
	});

	await t.test('L5-H/I: a re-confirmation that lands while a GET is reconciling on an older view is never deleted', async () => {
		await seed(A, [[CORE, 1]]);
		const [before] = await rowsOf(A);
		const g = gate();
		// GET sieht die Welt, in der Cover 1 abgelaufen ist - aber erst nachdem es die Zeile gelesen hat.
		const staleView = handlerWith({ covers: async (w) => { await g.wait(); return coversOf(w, [cover(1, { status: 'expired' })]); } });
		const reading = call(staleView);
		await g.arrived;
		// Waehrenddessen bestaetigt der Nutzer dieselbe Relation neu (seine Sicht: gueltig).
		const confirmed = await call(handlerWith(), { method: 'POST', body: { deploymentKey: CORE, coverId: 1 } });
		assert.equal(confirmed.statusCode, 200);
		const [after] = await rowsOf(A);
		assert.notEqual(after.confirmed_at, before.confirmed_at, 'POST hat confirmed_at erneuert');
		g.open();
		const r = await within(reading, 'GET endet nicht');
		assert.equal(r.statusCode, 200);
		assert.equal(r.body.removed, 0, 'veraltete Sicht loescht keine frische Bestaetigung');
		assert.deepEqual(keys(await rowsOf(A)), [`${CORE}#1`], 'die bestaetigte Zuordnung bleibt');
	});

	await t.test('L5-H/I: without a re-confirmation the same stale row IS removed by that GET (the guard is not a no-op)', async () => {
		await seed(A, [[CORE, 1]]);
		const g = gate();
		const reading = call(handlerWith({ covers: async (w) => { await g.wait(); return coversOf(w, [cover(1, { status: 'expired' })]); } }));
		await g.arrived;
		g.open();
		assert.equal((await within(reading, 'GET endet nicht')).body.removed, 1);
		assert.deepEqual(await rowsOf(A), []);
	});

	await t.test('L5-J: GET cleanup racing a user DELETE: both succeed, the row is gone once, nothing else is touched', async () => {
		await seed(A, [[CORE, 1], [LIDO, 2]]);
		const g = gate();
		const reading = call(handlerWith({ covers: async (w) => { await g.wait(); return coversOf(w, [cover(2)]); } }));
		await g.arrived;
		const removed = await call(handlerWith(), { method: 'DELETE', body: { deploymentKey: CORE, coverId: 1 } });
		assert.deepEqual([removed.statusCode, removed.body.deleted], [200, true]);
		g.open();
		const r = await within(reading, 'GET endet nicht');
		assert.deepEqual([r.statusCode, r.body.removed, r.body.attributions.map((a) => a.coverId), r.body.unconfirmed.map((a) => a.coverId)], [200, 0, [], [2]]);
		assert.deepEqual(keys(await rowsOf(A)), [`${LIDO}#2`]);
		const again = await call(handlerWith(), { method: 'DELETE', body: { deploymentKey: CORE, coverId: 1 } });
		assert.deepEqual([again.statusCode, again.body.deleted], [200, false], 'DELETE bleibt idempotent');
	});

	await t.test('L5: concurrent GETs with mixed views and POSTs never lose a confirmation that finished after every read', async () => {
		for (let round = 0; round < 10; round++) {
			await sql.query('delete from public.position_cover_attributions');
			await seed(A, [[CORE, 1]]);
			const reads = [];
			const gates = Array.from({ length: 5 }, () => gate());
			for (const g of gates) reads.push(call(handlerWith({ covers: async (w) => { await g.wait(); return coversOf(w, [cover(1, { status: 'expired' })]); } })));
			await Promise.all(gates.map((g) => g.arrived));
			const confirmed = await call(handlerWith(), { method: 'POST', body: { deploymentKey: CORE, coverId: 1 } });
			assert.equal(confirmed.statusCode, 200);
			for (const g of gates) g.open();
			const results = await within(Promise.all(reads), 'GETs enden nicht');
			assert.ok(results.every((r) => r.statusCode === 200 && r.body.removed === 0), `Runde ${round}`);
			assert.deepEqual(keys(await rowsOf(A)), [`${CORE}#1`], `Runde ${round}: Bestaetigung bleibt`);
		}
	});

	await t.test('L5: the 60-row limit (L1) still counts stored rows; a GET that removes a stale row frees exactly that slot', async () => {
		await seed(A, Array.from({ length: 60 }, (_, i) => [CORE, 100 + i]));
		// Neue Relationen auf Core: Lido/Prime und EtherFi sind seit 25.10.2026 nicht zuordenbar.
		const h = handlerWith({ covers: (w) => coversOf(w, [...Array.from({ length: 59 }, (_, i) => cover(101 + i)), cover(1), cover(2)]) });
		assert.equal((await call(h, { method: 'POST', body: { deploymentKey: CORE, coverId: 1 } })).statusCode, 409, 'veraltete Zeile zaehlt bis zum Abgleich');
		assert.equal((await call(h)).body.removed, 1, 'Cover 100 ist nicht mehr in der Wallet');
		assert.equal((await call(h, { method: 'POST', body: { deploymentKey: CORE, coverId: 1 } })).statusCode, 200);
		assert.equal((await call(h, { method: 'POST', body: { deploymentKey: CORE, coverId: 2 } })).statusCode, 409);
		assert.equal((await rowsOf(A)).length, 60);
	});

	} finally {
		await sql?.end();
		await rest?.close();
	}
});
