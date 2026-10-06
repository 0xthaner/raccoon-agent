/*
	AGENT-SAFE: Backend-Grenzen der nativen Safe-App-Integration.
	Offline: HMAC-Session-Token + injizierte getCode. Kein Netzwerk, keine DB.
*/
import test from 'node:test';
import assert from 'node:assert/strict';

// Dashboard-Secret fuer die HMAC-Signatur (auch unter test:ci ohne .env).
process.env.DASHBOARD_SESSION_SECRET ||= 'test-dashboard-secret-0123456789abcd';
// createDashboardChallenge baut die SIWE-Nachricht; siweOrigin() verlangt die
// Produktions-Origin (dieselbe Festlegung wie in siwe-signature.test.mjs).
process.env.APP_BASE_URL = 'https://coverraccoon.com';

const {
	createDashboardChallenge,
	createDashboardSession,
	DASHBOARD_CHALLENGE_TTL_EOA_MS,
	DASHBOARD_CHALLENGE_TTL_CONTRACT_MS,
	readBearerToken,
	resolveDashboardSession,
	verifyDashboardToken,
	SESSION_COOKIE
} = await import('../src/dashboard-auth.mjs');
const { isDeployedContract } = await import('../src/contract-detect.mjs');

const WALLET_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WALLET_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function cookieReq(token) { return { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } }; }
function bearerReq(token) { return { headers: { authorization: `Bearer ${token}` } }; }
function bothReq(cookieToken, bearerToken) {
	return { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookieToken)}`, authorization: `Bearer ${bearerToken}` } };
}

/* ---- Challenge-TTL ------------------------------------------------------- */

test('EOA-Challenge: 5 Minuten (Default)', () => {
	const now = Date.now();
	const { token } = createDashboardChallenge(WALLET_A, now);
	const data = verifyDashboardToken(token);
	assert.equal(data.exp - now, DASHBOARD_CHALLENGE_TTL_EOA_MS);
	assert.equal(DASHBOARD_CHALLENGE_TTL_EOA_MS, 5 * 60_000);
});

test('Contract-Challenge: 30 Minuten, wenn Server die lange TTL setzt', () => {
	const now = Date.now();
	const { token } = createDashboardChallenge(WALLET_A, now, DASHBOARD_CHALLENGE_TTL_CONTRACT_MS);
	assert.equal(verifyDashboardToken(token).exp - now, DASHBOARD_CHALLENGE_TTL_CONTRACT_MS);
	assert.equal(DASHBOARD_CHALLENGE_TTL_CONTRACT_MS, 30 * 60_000);
});

test('TTL wird defensiv begrenzt (nie < EOA, nie > Contract)', () => {
	const now = Date.now();
	assert.equal(verifyDashboardToken(createDashboardChallenge(WALLET_A, now, 0).token).exp - now, DASHBOARD_CHALLENGE_TTL_EOA_MS);
	assert.equal(verifyDashboardToken(createDashboardChallenge(WALLET_A, now, 999 * 60_000).token).exp - now, DASHBOARD_CHALLENGE_TTL_CONTRACT_MS);
});

/* ---- Contract-Detection (injiziert) -------------------------------------- */

test('isDeployedContract: Bytecode -> true, 0x/null -> false', async () => {
	assert.equal(await isDeployedContract(WALLET_A, { getCode: async () => '0x6080' }), true);
	assert.equal(await isDeployedContract(WALLET_A, { getCode: async () => '0x' }), false);
	assert.equal(await isDeployedContract(WALLET_A, { getCode: async () => null }), false);
});

test('isDeployedContract: ohne Schluessel/Client wirft (Aufrufer faellt fail closed)', async () => {
	const saved = process.env.ALCHEMY_API_KEY;
	delete process.env.ALCHEMY_API_KEY;
	try {
		await assert.rejects(() => isDeployedContract(WALLET_A));
	} finally {
		if (saved !== undefined) process.env.ALCHEMY_API_KEY = saved;
	}
});

/* ---- Bearer-Parsing ------------------------------------------------------ */

test('readBearerToken: gueltig / ungueltig / fehlend', () => {
	const tok = createDashboardSession(WALLET_A);
	assert.equal(readBearerToken(bearerReq(tok)), tok);
	assert.equal(readBearerToken({ headers: {} }), null);
	assert.equal(readBearerToken({ headers: { authorization: 'Basic abc' } }), null);
	assert.equal(readBearerToken({ headers: { authorization: 'Bearer ' } }), null);
	assert.equal(readBearerToken({ headers: { authorization: 'Bearer ' + 'a'.repeat(3000) } }), null);
	// case-insensitive scheme
	assert.equal(readBearerToken({ headers: { authorization: `bearer ${tok}` } }), tok);
});

test('Token wird nie aus Query/Body gelesen (nur Authorization-Header)', () => {
	const tok = createDashboardSession(WALLET_A);
	assert.equal(readBearerToken({ headers: {}, query: { token: tok }, body: { token: tok } }), null);
});

/* ---- Cookie + Bearer Konflikt (A-G) -------------------------------------- */

test('A: nur gueltiges Cookie -> Cookie-Session', () => {
	const r = resolveDashboardSession(cookieReq(createDashboardSession(WALLET_A)));
	assert.equal(r.conflict, false);
	assert.equal(r.session.wallet, WALLET_A);
});

test('B: nur gueltiger Bearer -> Bearer-Session', () => {
	const r = resolveDashboardSession(bearerReq(createDashboardSession(WALLET_B)));
	assert.equal(r.conflict, false);
	assert.equal(r.session.wallet, WALLET_B);
});

test('C: beide gueltig + gleiche Wallet -> akzeptiert', () => {
	const r = resolveDashboardSession(bothReq(createDashboardSession(WALLET_A), createDashboardSession(WALLET_A)));
	assert.equal(r.conflict, false);
	assert.equal(r.session.wallet, WALLET_A);
});

test('D: beide gueltig + verschiedene Wallets -> CONFLICT, keine Session', () => {
	const r = resolveDashboardSession(bothReq(createDashboardSession(WALLET_A), createDashboardSession(WALLET_B)));
	assert.equal(r.conflict, true);
	assert.equal(r.session, null);
});

test('E: Cookie ungueltig + Bearer gueltig -> Bearer', () => {
	const r = resolveDashboardSession(bothReq('garbage.token', createDashboardSession(WALLET_B)));
	assert.equal(r.conflict, false);
	assert.equal(r.session.wallet, WALLET_B);
});

test('F: Bearer ungueltig + Cookie gueltig -> Cookie', () => {
	const r = resolveDashboardSession({ headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(createDashboardSession(WALLET_A))}`, authorization: 'Bearer garbage.token' } });
	assert.equal(r.conflict, false);
	assert.equal(r.session.wallet, WALLET_A);
});

test('G: beide ungueltig -> keine Session', () => {
	const r = resolveDashboardSession({ headers: { cookie: `${SESSION_COOKIE}=nope`, authorization: 'Bearer nope.nope' } });
	assert.equal(r.conflict, false);
	assert.equal(r.session, null);
});

test('Challenge-Token wird nie als Session akzeptiert (type=challenge)', () => {
	const { token } = createDashboardChallenge(WALLET_A);
	// Challenge-Token als Bearer -> verifyDashboardSession lehnt ab (nur type=session)
	assert.equal(resolveDashboardSession(bearerReq(token)).session, null);
});
