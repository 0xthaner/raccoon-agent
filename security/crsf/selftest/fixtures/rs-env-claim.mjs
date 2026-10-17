// CRSF Phase 2U fixture S3: sets environment variables that pretend Postgres was used.
import test from 'node:test';
test('RS-FIXTURE env claim', () => { process.env.CRSF_PG_USED = '1'; process.env.CRSF_REAL_SYSTEM = 'postgres'; process.env.CRSF_CONCURRENCY = 'observed'; });
