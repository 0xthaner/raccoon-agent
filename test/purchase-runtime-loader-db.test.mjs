/**
 * Nexus P4H (20.10.2026): fester Lader gegen die ECHTE Datenbank (alle Migrationen, Wegwerf-Postgres).
 *
 *   M1_DB_TEST_PG_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *   M1_DB_TEST_PG_MODULE=/pfad/zu/node_modules/pg/lib/index.js \
 *   node --test test/purchase-runtime-loader-db.test.mjs
 * Ohne diese Variablen wird der Test uebersprungen (scripts/skip-policy.mjs, exakt mit Datei und Name).
 *
 * Belegt: createIntent + markBuilt -> die feste Lesefunktion liefert genau die Zeile, der Lader baut
 * daraus den Intent mit dem gespeicherten Hash (BUILT, ohne tx_hash und cover_id); OPEN, SUBMITTED und
 * unbekannte ids werden nicht geladen; anon und authenticated duerfen die Funktion nicht ausfuehren,
 * service_role schon; sie ist SECURITY INVOKER, STABLE, mit festem search_path, ohne dynamisches SQL und
 * ohne Schreibzugriff, und an den Tabellenrechten aendert sich nichts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openPurchaseDb, rpcOn, intentFor, freshWallet, hash32 } from '../test-support/purchase-intent-pg.mjs';
const L = await import('../src/purchase-runtime-loader.mjs');
const D = await import('../src/purchase-intent-db.mjs');
const I = await import('../src/purchase-intent.mjs');

const skip = !process.env.M1_DB_TEST_PG_URL || !process.env.M1_DB_TEST_PG_MODULE ? 'M1_DB_TEST_PG_URL / M1_DB_TEST_PG_MODULE nicht gesetzt (Wegwerf-Postgres noetig)' : false;
const FN = 'get_cover_purchase_intent_for_execution';

test('PURCHASE-LOADER-DB', { skip, timeout: 600_000 }, async (t) => {
	const { sql, close } = await openPurchaseDb('p4h_loader');
	t.after(close);
	const client = rpcOn(sql);
	const repository = { loadIntentForExecution: (id) => D.loadIntentForExecution(client, { id }) };
	const nowS = () => Math.floor(Date.now() / 1000);
	const open = async () => {
		const intent = intentFor(freshWallet());
		assert.equal((await D.createIntent(client, { intent, clientRequestId: randomUUID() })).status, 'created');
		return intent;
	};
	const built = async () => {
		const intent = await open();
		const calldataHash = hash32(`p4h-calldata-${intent.id}`);
		assert.equal((await D.markBuilt(client, { intent, calldataHash })).status, 'built');
		return { intent, calldataHash };
	};

	await t.test('P4H-DB-LOAD the fixed read function returns exactly the persisted BUILT row and the loader reconstructs its P4A hash', async () => {
		const { intent, calldataHash } = await built();
		const res = await L.loadPurchaseForExecution({ repository, intentId: intent.id, now: nowS() });
		assert.equal(res.status, 'LOADED', JSON.stringify(res.errors));
		const p = res.purchase;
		assert.deepEqual({ ...p.intent }, intent);
		const stored = (await sql.query(`select '0x' || encode(intent_hash, 'hex') as h, built_at, build_deadline from public.cover_purchase_intents where id = $1`, [intent.id])).rows[0];
		assert.equal(p.intentHash, stored.h);
		assert.equal(I.computePurchaseIntentHash(p.intent), stored.h, 'reconstructed P4A hash = stored hash');
		assert.equal(p.calldataHash, calldataHash);
		assert.equal(p.status, 'BUILT');
		assert.equal(p.txHash, null);
		assert.equal(p.coverId, null);
		// Zeiten: built_at aufgerundet, build_deadline abgerundet (Fenster nur enger)
		assert.equal(p.builtAt, Math.ceil(new Date(stored.built_at).getTime() / 1000));
		assert.equal(p.buildDeadline, Math.floor(new Date(stored.build_deadline).getTime() / 1000));
		assert.ok(p.buildDeadline > p.builtAt && p.buildDeadline - p.builtAt <= 120);
		// genau die Spalten der Funktion, nichts sonst
		const raw = (await sql.query(`select public.${FN}($1) as v`, [intent.id])).rows[0].v;
		assert.deepEqual(Object.keys(raw), ['intent', 'status']);
		assert.ok(!('client_request_id' in raw.intent) && !('tx_nonce' in raw.intent) && !('status_reason' in raw.intent) && !('created_at' in raw.intent));
	});

	await t.test('P4H-DB-STATUS OPEN, SUBMITTED and unknown ids are not loadable', async () => {
		const o = await open();
		assert.equal((await L.loadPurchaseForExecution({ repository, intentId: o.id, now: nowS() })).status, 'INVALID_STATUS');
		const { intent, calldataHash } = await built();
		assert.equal((await D.markSubmitted(client, { id: intent.id, wallet: intent.wallet, calldataHash, txHash: hash32(`tx-${intent.id}`), txNonce: 1 })).status, 'submitted');
		assert.equal((await L.loadPurchaseForExecution({ repository, intentId: intent.id, now: nowS() })).status, 'INVALID_STATUS');
		assert.equal((await L.loadPurchaseForExecution({ repository, intentId: randomUUID(), now: nowS() })).status, 'NOT_FOUND');
	});

	const asRole = async (role, statement, params = []) => { await sql.query('begin'); try { await sql.query(`set local role ${role}`); await sql.query(statement, params); return 'OK'; } catch (e) { return e.code ?? e.message; } finally { await sql.query('rollback'); } };

	await t.test('P4H-DB-PRIVILEGES only service_role may execute the read function; it is an invoker read with a pinned search_path and introduces no write right', async () => {
		const { intent } = await built();
		const sig = `public.${FN}(uuid)`;
		for (const role of ['anon', 'authenticated', 'public']) {
			assert.equal((await sql.query(`select has_function_privilege($1, $2, 'EXECUTE') as x`, [role, sig])).rows[0].x, false, role);
		}
		const acl = (await sql.query(`select proacl::text[] as acl from pg_proc where oid = $1::regprocedure`, [sig])).rows[0].acl ?? [];
		assert.ok(acl.every((e) => !/^(anon|authenticated)?=/.test(e)), `no PUBLIC, anon or authenticated entry: ${acl}`);
		for (const role of ['anon', 'authenticated']) assert.equal(await asRole(role, `select public.${FN}($1)`, [intent.id]), '42501', role);
		assert.equal((await sql.query(`select has_function_privilege('service_role', $1, 'EXECUTE') as x`, [sig])).rows[0].x, true);
		assert.equal(await asRole('service_role', `select public.${FN}($1)`, [intent.id]), 'OK');
		const fn = (await sql.query(`select prosecdef, provolatile, proconfig, prosrc from pg_proc where oid = $1::regprocedure`, [sig])).rows[0];
		assert.equal(fn.prosecdef, false, 'SECURITY INVOKER');
		assert.equal(fn.provolatile, 's', 'STABLE');
		assert.ok((fn.proconfig ?? []).includes('search_path=public, pg_temp'));
		assert.doesNotMatch(fn.prosrc, /\bexecute\b|format\s*\(|\binsert\b|\bupdate\b|\bdelete\b|\btruncate\b/i);
		for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
			assert.equal((await sql.query(`select has_table_privilege('service_role', 'public.cover_purchase_intents', $1) as x`, [p])).rows[0].x, false, `service_role ${p}`);
			for (const role of ['anon', 'authenticated']) assert.equal((await sql.query(`select has_table_privilege($1, 'public.cover_purchase_intents', $2) as x`, [role, p])).rows[0].x, false, `${role} ${p}`);
		}
	});
});
