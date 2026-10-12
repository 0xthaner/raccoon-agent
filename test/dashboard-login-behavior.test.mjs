/*
	AUDIT-2026-10-12: Mutationspruefung ergab, dass KEIN Test anschlug, wenn der
	Dashboard-Login das Signaturergebnis ignoriert (`if (verified !== 'VALID')`
	entfernt). Alle bisherigen Pruefungen waren Quelltext-Reihenfolgen, die beim
	Entfernen der Zeile still bestehen. Hier laeuft der echte Handler mit echtem
	SIWE-Text, echter Challenge (HMAC) und echten Offline-Signaturen.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

process.env.APP_BASE_URL = 'https://coverraccoon.com';
process.env.DASHBOARD_SESSION_SECRET = 'audit-test-secret-0123456789abcdef-0123456789';
delete process.env.ALCHEMY_API_KEY; // Contract-Pfad: kein RPC, fail closed

const auth = await import('../src/dashboard-auth.mjs');
const { verifyWalletSiweSignature } = await import('../src/contract-signature.mjs');

// Oeffentliche, unbefuellte Offline-Schluessel; nie von Anwendungscode importiert.
const OWNER = privateKeyToAccount(`0x${'03'.repeat(32)}`);
const STRANGER = privateKeyToAccount(`0x${'04'.repeat(32)}`);

function loadHandler(deps) {
	const source = readFileSync(new URL('../api/dashboard.mjs', import.meta.url), 'utf8');
	const body = source.replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
	return new Function(...Object.keys(deps), `${body}\nreturn handler;`)(...Object.values(deps));
}
function response() {
	return { headers: {}, status(n) { this.code = n; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.body = b; return this; } };
}

function setup({ consumeResult = true, storedWallet = OWNER.address } = {}) {
	const effects = { consumed: [], events: [] };
	const handler = loadHandler({
		isAddress, getWalletCovers: async () => ({ covers: [] }),
		...auth,
		verifyWalletSiweSignature, isDeployedContract: async () => false,
		beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		consumeDashboardAccess: async () => null,
		// Wie die echte Tabelle: verbraucht nur, wenn die gespeicherte Wallet passt (src/db.mjs).
		consumeDashboardChallenge: async (nonce, wallet) => { effects.consumed.push([nonce, wallet.toLowerCase()]); return consumeResult && wallet.toLowerCase() === storedWallet.toLowerCase(); },
		getLanguage: async () => 'de', getWalletLinkStateByWallet: async () => ({ linked: false, link: null }),
		isDashboardSessionRevoked: async () => false, recordAgentEvent: async () => {}, revokeDashboardSessions: async () => Date.now(),
		storeDashboardChallenge: async () => {}, unlinkWalletByWallet: async () => [],
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {},
		enforceRateLimit: async () => true, enforceRateLimitFor: async () => true, requireJson: () => true, requireSameOrigin: () => true,
		recordSecurityEvent: async (type) => { effects.events.push(type); }, securityFingerprint: () => 'fp', SECURITY_EVENT: { SIWE_SIGNATURE_INVALID: 'invalid', SIWE_REPLAY_BLOCKED: 'replay', ACCESS_CODE_INVALID: 'access' }
	});
	return { handler, effects };
}

async function login({ challengeFor = OWNER.address, claimed = OWNER.address, signer = OWNER, consumeResult, tamper = (m) => m, bearer = false } = {}) {
	const { handler, effects } = setup({ consumeResult, storedWallet: challengeFor });
	const challenge = auth.createDashboardChallenge(challengeFor);
	const signature = await signer.signMessage({ message: tamper(challenge.message, challenge) });
	const res = response();
	await handler({ method: 'POST', query: {}, headers: bearer ? { 'x-dashboard-transport': 'bearer' } : {}, body: { wallet: claimed, token: challenge.token, signature } }, res);
	return { res, effects };
}

const cookieSet = (res) => String(res.headers['set-cookie'] ?? '').includes(`${auth.SESSION_COOKIE}=`) && !String(res.headers['set-cookie']).includes('Max-Age=0');

test('LOGIN valid owner signature: 200, one consume, one session cookie for exactly that wallet', async () => {
	const { res, effects } = await login();
	assert.equal(res.code, 200);
	assert.equal(effects.consumed.length, 1);
	assert.ok(cookieSet(res));
	const token = decodeURIComponent(/=([^;]+)/.exec(res.headers['set-cookie'])[1]);
	assert.equal(auth.verifyDashboardSession(token).wallet, OWNER.address.toLowerCase());
	assert.equal(res.body.sessionToken, undefined, 'Bearer nur auf ausdrueckliche Anforderung');
});

test('LOGIN signature by another key: 401, no consume, no cookie, security event', async () => {
	const { res, effects } = await login({ signer: STRANGER });
	assert.equal(res.code, 401);
	assert.deepEqual(effects.consumed, []);
	assert.equal(cookieSet(res), false);
	assert.equal(res.body.sessionToken, undefined);
	// Ohne RPC endet der Contract-Pfad in RPC_UNAVAILABLE und zaehlt nicht als Angriff.
	assert.deepEqual(effects.events, []);
});

test('LOGIN owner signs a different text (tampered SIWE): 401, nothing issued', async () => {
	const { res, effects } = await login({ tamper: (m) => m.replace('coverraccoon.com', 'evil.example') });
	assert.equal(res.code, 401);
	assert.deepEqual(effects.consumed, []);
	assert.equal(cookieSet(res), false);
});

test('LOGIN challenge for A, claimed wallet B with B\'s own signature: 401 before any verification', async () => {
	// B signiert den Text so, wie er fuer B aus A's Challenge gebaut wuerde: die
	// Challenge ist an A gebunden, B bekommt weder Verbrauch noch Sitzung.
	const asB = (_message, challenge) => auth.dashboardMessage(auth.verifyDashboardToken(challenge.token), STRANGER.address);
	const { res, effects } = await login({ challengeFor: OWNER.address, claimed: STRANGER.address, signer: STRANGER, tamper: asB });
	assert.equal(res.code, 401);
	assert.deepEqual(effects.consumed, []);
	assert.equal(cookieSet(res), false);
});

test('LOGIN replay (consume fails): 409, no cookie, no bearer', async () => {
	const { res } = await login({ consumeResult: false, bearer: true });
	assert.equal(res.code, 409);
	assert.equal(cookieSet(res), false);
	assert.equal(res.body.sessionToken, undefined);
});

test('LOGIN bearer transport only changes transport, never identity', async () => {
	const { res } = await login({ bearer: true });
	assert.equal(res.code, 200);
	assert.equal(auth.verifyDashboardSession(res.body.sessionToken).wallet, OWNER.address.toLowerCase());
});

test('LOGIN a challenge token is never accepted as a session, and a session never as a challenge', async () => {
	const challenge = auth.createDashboardChallenge(OWNER.address);
	assert.equal(auth.verifyDashboardSession(challenge.token), null);
	const { handler } = setup();
	const res = response();
	const session = auth.createDashboardSession(OWNER.address);
	await handler({ method: 'POST', query: {}, headers: {}, body: { wallet: OWNER.address, token: session, signature: await OWNER.signMessage({ message: challenge.message }) } }, res);
	assert.equal(res.code, 401);
	assert.equal(cookieSet(res), false);
});
