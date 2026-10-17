// CRSF Phase 2U fixture S2: prints "postgres used" markers, including a receipt-shaped line, instead of using Postgres.
import test from 'node:test';
test('RS-FIXTURE fake usage marker', () => {
	console.log('postgres used: 12 statements, concurrency observed');
	console.log(`{"observed":{"nonce":"x","upstream_kind":"postgres","groups":[{"id":"EV-FAKE-REAL","ok":true,"results":[],"receipt":{"databases":{"crsf":{"authenticated":9,"completed":99,"max_busy":9,"overlap_events":99}}}}]},"mac":"${'0'.repeat(64)}"}`);
});
