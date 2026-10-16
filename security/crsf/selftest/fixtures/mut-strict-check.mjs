// CRSF fixture (VERIFY-005): a strict check that detects the mutation of mut-target.mjs, plus an unrelated failure source. Not part of the repository test suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureValue } from './mut-target.mjs';
test('CRSF fixture: strict value check', () => { assert.equal(fixtureValue(), 1); });
test('CRSF fixture: unrelated check', () => { assert.equal(process.env.CRSF_FIXTURE_BREAK_UNRELATED, undefined); });
