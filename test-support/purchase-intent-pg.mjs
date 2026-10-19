/*
	Nexus P4D (19.10.2026): Wegwerf-Postgres fuer die Kauf-Intent-Tests.

	- eigene Datenbank, Supabase-Rollen und -Standardrechte nachgebildet (wie
	  test/db-privileges-db.test.mjs), dann ALLE Migrationen;
	- rpcOn(conn): ein Client mit rpc(name, args) wie supabase-js, fuer den echten
	  Helfer src/purchase-intent-db.mjs; jeder Aufruf ist genau ein
	  `select public.<name>(p_x => $n, ...)`;
	- race(n, fn): n EIGENE Verbindungen, jede oeffnet eine Transaktion und wartet
	  an einer Schranke (geteilte Advisory-Sperre, die der Test exklusiv haelt).
	  Freigegeben wird erst, wenn die Datenbank n gleichzeitig wartende
	  Verbindungen meldet (pg_locks) - sonst scheitert der Lauf. Damit ist die
	  Ueberlappung im Test selbst nachgewiesen, unabhaengig vom Observer des
	  Runners.

	Nur gegen einen lokalen Wegwerf-Postgres (M1_DB_TEST_PG_URL), nie Produktion.
*/
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { keccak256 } from 'viem';
import { dropTestDatabase } from './drop-test-db.mjs';

const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url);
export const GATE_KEY = 4_242_017;

export async function openPurchaseDb(prefix) {
	const URL_ = process.env.M1_DB_TEST_PG_URL;
	const pg = (await import(process.env.M1_DB_TEST_PG_MODULE)).default;
	if (!/^postgres:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(URL_)) throw new Error('Nur gegen einen lokalen Wegwerf-Postgres.');
	const admin = new pg.Client({ connectionString: URL_ });
	await admin.connect();
	const name = `${prefix}_${process.pid}`;
	await admin.query(`drop database if exists ${name} with (force)`);
	await admin.query(`create database ${name}`);
	for (const role of ['anon', 'authenticated', 'service_role', 'supabase_admin']) {
		await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role}; end if; end $$`);
	}
	await admin.end();
	const dbUrl = URL_.replace(/\/[^/]*$/, `/${name}`);
	const connect = async () => { const c = new pg.Client({ connectionString: dbUrl, statement_timeout: 30_000 }); await c.connect(); return c; };
	const sql = await connect();
	// Supabase-Standardrechte nachbilden (vor jeder Migration), sonst waere die Rechtepruefung trivial.
	await sql.query(`grant usage on schema public to anon, authenticated, service_role;
		alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
		alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
		alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`);
	for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) await sql.query(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
	return { pg, sql, connect, close: async () => { await sql.end().catch(() => {}); await dropTestDatabase(pg, URL_, dbUrl); } };
}

/** supabase-js-artiger Client ueber EINE Verbindung; Name nur aus festen Kleinbuchstaben. */
export function rpcOn(conn) {
	return {
		async rpc(name, args) {
			if (!/^[a-z_]+$/.test(name)) throw new Error('bad function name');
			const keys = Object.keys(args);
			try {
				const r = await conn.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as v`, keys.map((k) => args[k]));
				return { data: r.rows[0].v, error: null };
			} catch (error) {
				return { data: null, error: { code: error.code, message: error.message } };
			}
		}
	};
}

/* ------------------------------------------------------------------ Daten -- */

let counter = 0;
export const freshWallet = () => `0x${(0xd400000000n + BigInt(++counter) + BigInt(process.pid) * 1_000_000n).toString(16).padStart(40, '0')}`;
export const ZERO = '0x0000000000000000000000000000000000000000';
export const TEST_CID = 'QmQPWELjoGp6zqfrELz2xeafuPgtSBfvVF1pjX3DvuFsah';
export const hash32 = (label) => keccak256(new TextEncoder().encode(String(label)));
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Kanonischer P4A-Intent, frisch gegen die echte Uhr (die Datenbank prueft gegen now()). */
export function intentFor(wallet, patch = {}) {
	const ack = nowSeconds() - 5;
	return {
		id: randomUUID(), wallet, chainId: 1, deploymentKey: 'aave-v3-ethereum-core', productId: 97, productTypeId: 0, coverAssetId: 6,
		amountRaw: '1000000000', periodDays: 30, quotePremiumRaw: '3000578', maxPremiumRaw: '3030584', quoteFetchedAt: ack - 10, capacityFetchedAt: ack - 10,
		wordingCid: 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY', annexCid: null, termsHash: hash32('terms'), proofOfLossCid: TEST_CID,
		commissionRatio: 0, commissionDestination: ZERO, pinVersion: 'nexus-pin-1:broker-v2.12.1:cover-v3.3.0', acknowledgedAt: ack, expiresAt: ack + 600, ...patch
	};
}

/* ------------------------------------------------------------- Gleichzeitig -- */

/** n eigene Verbindungen. */
export async function connections(connect, n) {
	return Promise.all(Array.from({ length: n }, () => connect()));
}

async function waitForWaiters(holder, n, timeoutMs = 15_000) {
	const until = Date.now() + timeoutMs;
	let waiting = 0;
	while (Date.now() < until) {
		waiting = (await holder.query(`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = $1 and objsubid = 1 and not granted`, [GATE_KEY])).rows[0].n;
		if (waiting >= n) return waiting;
		await new Promise((r) => setTimeout(r, 20));
	}
	return waiting;
}

/**
 * Laesst fn(client, i, conn) auf n eigenen Verbindungen gleichzeitig laufen. Jede Verbindung steht in
 * einer offenen Transaktion an der Schranke; erst wenn die Datenbank n gleichzeitig wartende
 * Verbindungen meldet, wird freigegeben. Liefert { waiting, results }.
 */
export async function race(connect, n, fn) {
	const conns = await connections(connect, n);
	const holder = await connect();
	await holder.query('select pg_advisory_lock($1)', [GATE_KEY]);
	let released = false;
	try {
		const running = conns.map((k, i) => (async () => {
			await k.query('begin');
			try {
				await k.query('select pg_advisory_xact_lock_shared($1)', [GATE_KEY]);
				const value = await fn(rpcOn(k), i, k);
				await k.query('commit');
				return value;
			} catch (error) {
				await k.query('rollback').catch(() => {});
				throw error;
			}
		})());
		const waiting = await waitForWaiters(holder, n);
		await holder.query('select pg_advisory_unlock($1)', [GATE_KEY]);
		released = true;
		const settled = await Promise.allSettled(running);
		const failed = settled.filter((s) => s.status === 'rejected');
		if (failed.length) throw failed[0].reason;
		return { waiting, results: settled.map((s) => s.value) };
	} finally {
		if (!released) await holder.query('select pg_advisory_unlock($1)', [GATE_KEY]).catch(() => {});
		await holder.end().catch(() => {});
		await Promise.allSettled(conns.map((k) => k.end()));
	}
}
