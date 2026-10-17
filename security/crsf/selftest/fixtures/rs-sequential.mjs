// CRSF Phase 2U fixture S6: real (observer-relayed) connections, but every statement runs strictly after the previous one.
import test from 'node:test';
import { connectPg } from './pg-wire.mjs';
test('RS-FIXTURE sequential statements', async () => {
	const a = await connectPg(process.env.M1_DB_TEST_PG_URL), b = await connectPg(process.env.M1_DB_TEST_PG_URL), c = await connectPg(process.env.M1_DB_TEST_PG_URL);
	for (let i = 0; i < 6; i++) await [a, b, c][i % 3].query(`select ${i}`);
	for (const k of [a, b, c]) k.end();
});
