// CRSF Phase 2U fixture S5: uses only a mocked pg object; no socket is ever opened.
import test from 'node:test';
import assert from 'node:assert/strict';
test('RS-FIXTURE mocked pg', async () => {
	const pg = { Client: class { async connect() {} async query() { return { rows: [{ ok: 1 }] }; } async end() {} } };
	const c = new pg.Client({ connectionString: process.env.M1_DB_TEST_PG_URL });
	await c.connect();
	await Promise.all([c.query('select 1'), c.query('select 2')]);
	assert.equal((await c.query('select 1')).rows[0].ok, 1);
	await c.end();
});
