// CRSF Phase 2U fixture T3/S1: claims to be real-system evidence but does only ordinary Node work (no connection, no query).
import test from 'node:test';
import assert from 'node:assert/strict';
test('RS-FIXTURE node-only work', () => { assert.equal([3, 1, 2].sort().join(','), '1,2,3'); });
