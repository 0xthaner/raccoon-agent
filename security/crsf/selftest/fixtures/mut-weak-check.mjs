// CRSF self-test fixture M: a weak test that still passes against the known-bad variant. Not part of the repository test suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureValue } from './mut-target.mjs';
test('CRSF fixture: weak check (only the type)', () => { assert.equal(typeof fixtureValue(), 'number'); });
