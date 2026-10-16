/**
 * Token-Grenzen der Dashboard-Sitzung (CRSF Phase 2B, CR-SESSION-002 P2/P3,
 * CR-SESSION-003 P1/P2, CR-SESSION-005 P2).
 *
 * Reine Verhaltenstests gegen src/dashboard-auth.mjs - echte, HMAC-signierte
 * Tokens, keine Datenbank, kein Netz:
 * - abgelaufene Sitzungs- und Aktions-Tokens gelten nicht,
 * - kein Token-Typ (challenge, session, action) ist gegen einen anderen
 *   austauschbar, und eine Aktions-Bestaetigung gilt nur fuer ihren Zweck,
 * - `Authorization: Bearer` mit einem gueltigen Sitzungstoken authentisiert nie.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DASHBOARD_SESSION_SECRET = 'session-boundary-test-secret-0123456789abcdef';
process.env.APP_BASE_URL = 'https://coverraccoon.com';
const auth = await import('../src/dashboard-auth.mjs');

const WALLET = '0x1111111111111111111111111111111111111111';
const DAY = 24 * 60 * 60_000;
const cookieHeader = (token) => ({ headers: { cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}` } });

test('SESSION-TOKENS: fresh session and action tokens are accepted (positive control)', () => {
	const session = auth.createDashboardSession(WALLET, Date.now(), 'eoa');
	assert.equal(auth.verifyDashboardSession(session)?.wallet, WALLET);
	assert.equal(auth.resolveDashboardSession(cookieHeader(session)).session?.wallet, WALLET);
	const action = auth.createActionChallenge(WALLET, 'session-revoke');
	assert.equal(auth.verifyActionChallenge(action.token, 'session-revoke')?.purpose, 'session-revoke');
});

test('SESSION-EXPIRY: an expired session token is refused, EOA (7 d) and contract (24 h)', () => {
	for (const [kind, ttl] of [['eoa', 7 * DAY], ['contract', DAY]]) {
		const expired = auth.createDashboardSession(WALLET, Date.now() - ttl - 1_000, kind);
		assert.equal(auth.verifyDashboardSession(expired), null, `${kind}: verify`);
		assert.equal(auth.resolveDashboardSession(cookieHeader(expired)).session, null, `${kind}: resolve`);
		assert.equal(auth.verifyDashboardToken(expired), null, `${kind}: generic verify`);
	}
});

test('SESSION-EXPIRY: an expired action confirmation is refused', () => {
	for (const purpose of ['telegram-disconnect', 'session-revoke']) {
		const expired = auth.createActionChallenge(WALLET, purpose, Date.now() - auth.ACTION_CHALLENGE_TTL_MS - 1_000);
		assert.equal(auth.verifyActionChallenge(expired.token, purpose), null, purpose);
	}
});

test('SESSION-TYPES: challenge, session and action tokens are never interchangeable', () => {
	const challenge = auth.createDashboardChallenge(WALLET).token;
	const session = auth.createDashboardSession(WALLET, Date.now(), 'eoa');
	const action = auth.createActionChallenge(WALLET, 'session-revoke').token;
	assert.equal(auth.verifyDashboardSession(challenge), null, 'challenge as session');
	assert.equal(auth.verifyDashboardSession(action), null, 'action as session');
	assert.equal(auth.resolveDashboardSession(cookieHeader(challenge)).session, null, 'challenge cookie');
	assert.equal(auth.resolveDashboardSession(cookieHeader(action)).session, null, 'action cookie');
	assert.equal(auth.verifyActionChallenge(session, 'session-revoke'), null, 'session as action');
	assert.equal(auth.verifyActionChallenge(challenge, 'session-revoke'), null, 'challenge as action');
});

test('SESSION-TYPES: an action confirmation is bound to its purpose', () => {
	const disconnect = auth.createActionChallenge(WALLET, 'telegram-disconnect').token;
	const revoke = auth.createActionChallenge(WALLET, 'session-revoke').token;
	assert.equal(auth.verifyActionChallenge(disconnect, 'session-revoke'), null);
	assert.equal(auth.verifyActionChallenge(revoke, 'telegram-disconnect'), null);
	assert.equal(auth.verifyActionChallenge(revoke, 'unknown-purpose'), null);
});

test('SESSION-BEARER: a valid session token in Authorization: Bearer never authenticates', () => {
	const session = auth.createDashboardSession(WALLET, Date.now(), 'eoa');
	for (const authorization of [`Bearer ${session}`, `bearer ${session}`, session]) {
		assert.equal(auth.resolveDashboardSession({ headers: { authorization } }).session, null, authorization.slice(0, 7));
	}
	// With a valid cookie the cookie decides; the Bearer header adds nothing.
	const other = auth.createDashboardSession('0x2222222222222222222222222222222222222222', Date.now(), 'eoa');
	const both = auth.resolveDashboardSession({ headers: { cookie: cookieHeader(session).headers.cookie, authorization: `Bearer ${other}` } });
	assert.equal(both.session?.wallet, WALLET);
});
