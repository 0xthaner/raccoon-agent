// CRSF Phase 2U fixture S4: writes a receipt-shaped file (temp directory only) instead of using Postgres.
import test from 'node:test';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
test('RS-FIXTURE file receipt', () => {
	const f = path.join(tmpdir(), `crsf-pg-receipt-${process.pid}.json`);
	writeFileSync(f, JSON.stringify({ observer: 'crsf-pg-observer/1', databases: { crsf: { authenticated: 5, completed: 50, max_busy: 5, overlap_events: 50 } } }));
	rmSync(f);
});
