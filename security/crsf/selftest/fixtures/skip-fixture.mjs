// CRSF self-test fixture K: an unexpected skip. Not part of the repository test suite.
import { test } from 'node:test';
test('CRSF fixture: silently skipped security test', { skip: 'fixture' }, () => {});
