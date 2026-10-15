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
	SAFEAPP_COOKIE,
	resolveDashboardSession,
	verifyDashboardToken,
	SESSION_COOKIE
} = await import('../src/dashboard-auth.mjs');
const { isDeployedContract, CODE_CACHE_TTL_MS } = await import('../src/contract-detect.mjs');

const WALLET_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WALLET_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function cookieReq(token) { return { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } }; }
// Safe-App-Sitzung (15.10.2026): an die Stelle des Bearers tritt das partitionierte
// Safe-App-Cookie (nur Contract-Sitzungen). Die Faelle A-G gelten unveraendert.
const contract = (wallet) => createDashboardSession(wallet, Date.now(), 'contract');
function safeAppReq(token) { return { headers: { cookie: `${SAFEAPP_COOKIE}=${encodeURIComponent(token)}` } }; }
function bothReq(cookieToken, safeAppToken) {
	return { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookieToken)}; ${SAFEAPP_COOKIE}=${encodeURIComponent(safeAppToken)}` } };
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
	// Jeweils frischer Cache: die reine Klassifikation, nicht der Cache-Treffer.
	assert.equal(await isDeployedContract(WALLET_A, { getCode: async () => '0x6080', cache: new Map() }), true);
	assert.equal(await isDeployedContract(WALLET_A, { getCode: async () => '0x', cache: new Map() }), false);
	assert.equal(await isDeployedContract(WALLET_A, { getCode: async () => null, cache: new Map() }), false);
});

test('isDeployedContract: ohne Schluessel/Client wirft (Aufrufer faellt fail closed)', async () => {
	const saved = process.env.ALCHEMY_API_KEY;
	delete process.env.ALCHEMY_API_KEY;
	try {
		// Frischer Cache erzwingt den RPC-/Konfig-Pfad (kein alter Treffer).
		await assert.rejects(() => isDeployedContract(WALLET_A, { cache: new Map() }));
	} finally {
		if (saved !== undefined) process.env.ALCHEMY_API_KEY = saved;
	}
});

/* ---- AGENT-HARD-001: getCode-Cache (60 s, best effort) ------------------- */

test('Cache-Treffer innerhalb TTL: getCode wird nur einmal aufgerufen', async () => {
	const cache = new Map();
	const now = 1_000_000;
	let calls = 0;
	const getCode = async () => { calls += 1; return '0x6080'; };
	assert.equal(await isDeployedContract(WALLET_A, { getCode, cache, now }), true);
	// Zweiter Aufruf innerhalb des Fensters -> Treffer, kein weiterer RPC.
	assert.equal(await isDeployedContract(WALLET_A, { getCode, cache, now: now + CODE_CACHE_TTL_MS - 1 }), true);
	assert.equal(calls, 1);
});

test('Cache-Ablauf nach TTL: getCode wird erneut aufgerufen', async () => {
	const cache = new Map();
	const now = 2_000_000;
	let calls = 0;
	const getCode = async () => { calls += 1; return '0x6080'; };
	assert.equal(await isDeployedContract(WALLET_A, { getCode, cache, now }), true);
	// Nach Ablauf der TTL erneut auswerten.
	assert.equal(await isDeployedContract(WALLET_A, { getCode, cache, now: now + CODE_CACHE_TTL_MS + 1 }), true);
	assert.equal(calls, 2);
});

test('Cache ist pro Wallet getrennt (normalisiert)', async () => {
	const cache = new Map();
	const now = 3_000_000;
	let calls = 0;
	// Gross-/Kleinschreibung derselben Adresse trifft denselben Key.
	assert.equal(await isDeployedContract(WALLET_A, { getCode: async () => { calls += 1; return '0x6080'; }, cache, now }), true);
	assert.equal(await isDeployedContract(WALLET_A.toUpperCase(), { getCode: async () => { calls += 1; return '0x6080'; }, cache, now }), true);
	assert.equal(calls, 1);
	// Andere Wallet -> eigener Eintrag, eigener RPC.
	assert.equal(await isDeployedContract(WALLET_B, { getCode: async () => { calls += 1; return '0x'; }, cache, now }), false);
	assert.equal(calls, 2);
});

test('RPC-Fehler wird NICHT gecacht (Klassifikation bleibt offen)', async () => {
	const cache = new Map();
	const now = 4_000_000;
	let calls = 0;
	const failing = async () => { calls += 1; throw new Error('RPC down'); };
	await assert.rejects(() => isDeployedContract(WALLET_A, { getCode: failing, cache, now }));
	// Kein Eintrag entstanden: der naechste Aufruf fragt erneut.
	assert.equal(cache.size, 0);
	assert.equal(await isDeployedContract(WALLET_A, { getCode: async () => { calls += 1; return '0x6080'; }, cache, now }), true);
	assert.equal(calls, 2);
});

/* ---- Bearer nicht mehr angenommen --------------------------------------- */

test('Authorization: Bearer wird nicht mehr gelesen - auch nicht mit gueltigem Contract-Token', () => {
	for (const authorization of [`Bearer ${contract(WALLET_A)}`, `bearer ${contract(WALLET_A)}`, `Bearer ${createDashboardSession(WALLET_A)}`]) {
		assert.deepEqual(resolveDashboardSession({ headers: { authorization } }), { conflict: false, session: null });
	}
});

test('Token wird nie aus Query/Body gelesen', () => {
	const tok = contract(WALLET_A);
	assert.equal(resolveDashboardSession({ headers: {}, query: { token: tok }, body: { token: tok } }).session, null);
});

/* ---- Strict-Cookie + Safe-App-Cookie Konflikt (A-G) ----------------------- */

test('A: nur gueltiges Strict-Cookie -> Cookie-Session', () => {
	const r = resolveDashboardSession(cookieReq(createDashboardSession(WALLET_A)));
	assert.equal(r.conflict, false);
	assert.equal(r.session.wallet, WALLET_A);
});

test('B: nur gueltiges Safe-App-Cookie (Contract) -> Safe-App-Session', () => {
	const r = resolveDashboardSession(safeAppReq(contract(WALLET_B)));
	assert.equal(r.conflict, false);
	assert.equal(r.session.wallet, WALLET_B);
	assert.equal(r.session.kind, 'contract');
});

test('B2: eine EOA- oder Alt-Sitzung unter dem Safe-App-Namen wird nie angenommen', () => {
	assert.equal(resolveDashboardSession(safeAppReq(createDashboardSession(WALLET_B, Date.now(), 'eoa'))).session, null);
	assert.equal(resolveDashboardSession(safeAppReq(createDashboardSession(WALLET_B))).session, null, 'Standardart eoa');
});

test('C: beide gueltig + gleiche Wallet -> akzeptiert', () => {
	const r = resolveDashboardSession(bothReq(contract(WALLET_A), contract(WALLET_A)));
	assert.equal(r.conflict, false);
	assert.equal(r.session.wallet, WALLET_A);
});

test('D: beide gueltig + verschiedene Wallets -> CONFLICT, keine Session', () => {
	const r = resolveDashboardSession(bothReq(createDashboardSession(WALLET_A), contract(WALLET_B)));
	assert.equal(r.conflict, true);
	assert.equal(r.session, null);
});

test('E: Strict-Cookie ungueltig + Safe-App-Cookie gueltig -> Safe-App', () => {
	const r = resolveDashboardSession(bothReq('garbage.token', contract(WALLET_B)));
	assert.equal(r.conflict, false);
	assert.equal(r.session.wallet, WALLET_B);
});

test('F: Safe-App-Cookie ungueltig + Strict-Cookie gueltig -> Strict-Cookie', () => {
	const r = resolveDashboardSession({ headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(createDashboardSession(WALLET_A))}; ${SAFEAPP_COOKIE}=garbage.token` } });
	assert.equal(r.conflict, false);
	assert.equal(r.session.wallet, WALLET_A);
});

test('G: beide ungueltig -> keine Session', () => {
	const r = resolveDashboardSession({ headers: { cookie: `${SESSION_COOKIE}=nope; ${SAFEAPP_COOKIE}=nope.nope` } });
	assert.equal(r.conflict, false);
	assert.equal(r.session, null);
});

test('Challenge-Token wird nie als Session akzeptiert (type=challenge)', () => {
	const { token } = createDashboardChallenge(WALLET_A);
	assert.equal(resolveDashboardSession(safeAppReq(token)).session, null);
	assert.equal(resolveDashboardSession(cookieReq(token)).session, null);
});
