/**
 * SIWE-Zeitbindung (CRSF Phase 2B, CR-AUTH-001 P4).
 *
 * Issued-at und Expiration-time einer Nachricht muessen exakt den vom Server
 * ausgestellten Werten der Challenge entsprechen - nicht nur "irgendwann
 * gueltig" sein. Hier sind die Nachrichten korrekt aufgebaut und in jedem
 * anderen Feld richtig; nur die Zeit weicht von der Erwartung ab. Ohne diese
 * Bindung koennte ein Client die Zeitfelder selbst waehlen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTION_ORIGIN, SIWE_CLOCK_SKEW_MS, checkSiweMessage, dashboardExpectation, dashboardSiweMessage } from '../src/siwe-auth.mjs';

const WALLET = '0x1111111111111111111111111111111111111111';
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const REQUEST_ID = 'ffeeddccbbaa99887766554433221100';
const ISSUED_AT = 1_800_000_000_000;
const EXPIRES_AT = ISSUED_AT + 5 * 60_000;
const NOW = ISSUED_AT + 1_000;

function inProduction(run) {
	const keys = { APP_BASE_URL: PRODUCTION_ORIGIN, NODE_ENV: undefined, VERCEL_ENV: 'production' };
	const previous = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
	for (const [k, v] of Object.entries(keys)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
	try { return run(); } finally { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const expected = () => dashboardExpectation({ wallet: WALLET, nonce: NONCE, issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, requestId: REQUEST_ID });
const message = (issuedAt, expiresAt) => dashboardSiweMessage({ wallet: WALLET, nonce: NONCE, issuedAt, expiresAt, requestId: REQUEST_ID });

test('SIWE-TIME: the exactly issued message is valid (positive control)', () => {
	inProduction(() => assert.equal(checkSiweMessage(message(ISSUED_AT, EXPIRES_AT), expected(), NOW), 'VALID'));
});

test('SIWE-TIME: an issued-at that differs from the challenge is refused, earlier or later', () => {
	inProduction(() => {
		for (const delta of [-60_000, -1_000, 1_000, SIWE_CLOCK_SKEW_MS - 1]) {
			assert.equal(checkSiweMessage(message(ISSUED_AT + delta, EXPIRES_AT), expected(), NOW), 'ISSUED_AT_INVALID', `issued-at ${delta} ms off`);
		}
	});
});

test('SIWE-TIME: an expiration-time that differs from the challenge is refused, even while the challenge is still open', () => {
	inProduction(() => {
		for (const delta of [3_600_000, 60_000, 1_000, -1_000]) {
			assert.equal(checkSiweMessage(message(ISSUED_AT, EXPIRES_AT + delta), expected(), NOW), 'EXPIRED', `expiration-time ${delta} ms off`);
		}
	});
});
