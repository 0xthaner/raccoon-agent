/*
	CRSF test-infrastructure precondition (Nexus P4F, 20.10.2026). This is not evidence
	about application security.

	security:verify runs every real-system evidence group concurrently: Promise.all in
	observed-test-exec.mjs, one observer per group, 11 Postgres groups at P4E. All of
	them hit the same disposable Postgres. During the P4E full verify a server with
	max_connections=300 ran out of slots: 162 "too many clients" refusals, after which
	the group executors died. Tests then failed although nothing was wrong with the
	code. The documented safe minimum is 600, twice the capacity that was exhausted;
	the third P4E run passed with 600.

	The probe only reads the setting (SHOW max_connections) and changes nothing. It is
	used only against the disposable Postgres in M1_DB_TEST_PG_URL, never against
	production. Concurrency, overlap requirements, tests and E5 thresholds stay as they
	are; with too little capacity the verify stops early with a clear infrastructure
	error instead of producing a false FAIL.
*/
import { createRequire } from 'node:module';

export const REQUIRED_PG_MAX_CONNECTIONS = 600;

/** Pure verdict on the value reported by SHOW max_connections. */
export function pgCapacityVerdict(raw, required = REQUIRED_PG_MAX_CONNECTIONS) {
	const text = typeof raw === 'number' ? String(raw) : raw;
	if (typeof text !== 'string' || !/^[1-9][0-9]{0,6}$/.test(text)) return { ok: false, value: null, required, error: 'UNREADABLE_MAX_CONNECTIONS' };
	const value = Number(text);
	return value >= required ? { ok: true, value, required, error: null } : { ok: false, value, required, error: 'INSUFFICIENT_MAX_CONNECTIONS' };
}

/** Reads max_connections from the disposable Postgres (read-only). `module`: path of the pg package (M1_DB_TEST_PG_MODULE). */
export async function probePgCapacity({ url, module }) {
	let client = null;
	try {
		const pg = createRequire(import.meta.url)(module);
		client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
		await client.connect();
		const { rows } = await client.query('SHOW max_connections');
		return pgCapacityVerdict(rows[0]?.max_connections);
	} catch (error) {
		return { ok: false, value: null, required: REQUIRED_PG_MAX_CONNECTIONS, error: `PROBE_FAILED: ${error.code ?? error.message}` };
	} finally {
		await client?.end().catch(() => {});
	}
}
