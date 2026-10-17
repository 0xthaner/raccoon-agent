// CRSF Phase 2U fixture G1 (genuine): statements on several connections released together, so they overlap at the server.
import test from 'node:test';
import { connectPg } from './pg-wire.mjs';
test('RS-FIXTURE concurrent statements', async () => {
	const conns = await Promise.all([0, 1, 2].map(() => connectPg(process.env.M1_DB_TEST_PG_URL)));
	for (let round = 0; round < 2; round++) await Promise.all(conns.map((k, i) => k.query(`select ${round * 10 + i}`)));
	for (const k of conns) k.end();
});
