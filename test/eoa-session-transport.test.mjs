/*
	EOA-Meta-Audit 15.10.2026, Befunde M1 und H1 - gegen den ECHTEN Login-Handler
	(api/dashboard.mjs), echten SIWE-Text, echtes HMAC, echte ECDSA-Pruefung und die
	echte Dual-RPC-ERC-1271-Pruefung auf der simulierten Kette.

	M1: Ein Client konnte mit `x-dashboard-transport: bearer` bei JEDEM Login - auch
	einer gewoehnlichen EOA im normalen Browser - ein 7-Tage-Sitzungstoken in den
	JS-lesbaren Body bekommen. Damit war der HttpOnly-Schutz des Cookies durch einen
	Header aushebelbar, den ein kompromittiertes Frontend selbst setzt. Jetzt
	entscheidet die serverseitig BEWIESENE Autoritaet: eine EOA bekommt nie ein
	Bearer-Token. (Restrisiko Safe-App: siehe Test "M1 residual".)

	H1: Signaturen mit gueltiger 65-Byte-Form, bei denen viem.verifyMessage WIRFT,
	duerfen nie authentisieren. Die bisherigen Tests scheiterten alle schon an der
	Laengen-Regex und erreichten den Ausnahme-Zweig nie.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hashMessage, isAddress, verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { simChain, dualProviders, ownerSignature } from '../test-support/dual-rpc-sim.mjs';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';

process.env.APP_BASE_URL = 'https://coverraccoon.com';
process.env.DASHBOARD_SESSION_SECRET = 'eoa-session-transport-secret-0123456789abcdef';

const auth = await import('../src/dashboard-auth.mjs');
const cs = await import('../src/contract-signature.mjs');
const siwe = await import('../src/siwe-auth.mjs');

const OWNER = privateKeyToAccount(`0x${'05'.repeat(32)}`);
const SAFE = '0x5afe00000000000000000000000000000000c00c';
const chain = () => simChain({ head: 20_000_000n, safes: { [SAFE]: { history: [{ from: 0n, owners: ['b2'], threshold: 1 }] } } });

function server({ providers = dualProviders(chain()).providers } = {}) {
	const effects = { consumed: [], events: [] };
	const source = readFileSync(new URL('../api/dashboard.mjs', import.meta.url), 'utf8').replace(/^import [^;]*;\n/gm, '').replace('export default async function handler', 'async function handler');
	const deps = {
		isAddress, queryParams, singleQueryValue, ...auth,
		verifyWalletSiweAuthority: (params) => cs.verifyWalletSiweAuthority(params, { providers }),
		verifyOnchainDashboardLoginApproval: (params) => cs.verifyOnchainDashboardLoginApproval(params, { providers }),
		noContractCodeByQuorum: (wallet) => cs.noContractCodeByQuorum(wallet, { providers }),
		isDeployedContract: async () => false,
		consumeDashboardChallenge: async (nonce, wallet) => { effects.consumed.push(nonce); return true; },
		isDashboardChallengeOpen: async () => true, storeDashboardChallenge: async () => {},
		getWalletCovers: async () => ({ covers: [] }), getWalletLinkStateByWallet: async () => ({ linked: false, link: null }),
		isDashboardSessionRevoked: async () => false, recordAgentEvent: async () => {}, consumeDashboardAccess: async () => null,
		getLanguage: async () => 'de', beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		revokeDashboardSessions: async () => Date.now(), unlinkWalletByWallet: async () => [], unlinkWalletFromAllChats: async () => [],
		enforceRateLimit: async () => true, enforceRateLimitFor: async () => true, requireJson: () => true, requireSameOrigin: () => true,
		recordSecurityEvent: async (type) => { effects.events.push(type); }, securityFingerprint: () => 'fp',
		SECURITY_EVENT: { SIWE_SIGNATURE_INVALID: 'invalid', SIWE_REPLAY_BLOCKED: 'replay', ERC1271_RPC_DISAGREEMENT: 'disagreement', ACCESS_CODE_INVALID: 'access' },
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}
	};
	const handler = new Function(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps));
	return { handler, effects };
}
const response = () => ({ headers: {}, status(n) { this.code = n; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, json(b) { this.body = b; return this; } });
async function post(srv, body, headers = {}) {
	const res = response();
	await srv.handler({ method: 'POST', url: '/api/dashboard', headers: { 'content-type': 'application/json', ...headers }, body }, res);
	return res;
}
const cookieToken = (res) => { const m = /__Host-raccoon_dashboard=([^;]+)/.exec(String(res.headers['set-cookie'] ?? '')); return m ? decodeURIComponent(m[1]) : null; };

/** Jeder String irgendwo im JSON-Body, der als gueltige Dashboard-Sitzung durchgeht = JS-lesbare Sitzung. */
function jsReadableSessions(body) {
	const found = [];
	const walk = (v) => {
		if (typeof v === 'string' && auth.verifyDashboardSession(v)) found.push(v);
		else if (v && typeof v === 'object') Object.values(v).forEach(walk);
	};
	walk(body);
	return found;
}

/* ============================================================ M1 */

for (const transport of ['bearer', 'Bearer', 'BEARER']) {
	test(`M1 an ordinary EOA login with x-dashboard-transport: ${transport} gets NO JS-readable session - HttpOnly cookie only`, async () => {
		const srv = server();
		const challenge = auth.createDashboardChallenge(OWNER.address);
		const signature = await OWNER.signMessage({ message: challenge.message });
		const res = await post(srv, { wallet: OWNER.address, token: challenge.token, signature }, { 'x-dashboard-transport': transport });
		assert.equal(res.code, 200, JSON.stringify(res.body));
		assert.deepEqual(jsReadableSessions(res.body), [], 'kein Sitzungstoken im Body');
		assert.equal(res.body.sessionToken, undefined);
		const cookie = String(res.headers['set-cookie']);
		assert.match(cookie, /; HttpOnly;/);
		assert.match(cookie, /SameSite=Strict/);
		assert.equal(auth.verifyDashboardSession(cookieToken(res)).kind, 'eoa');
	});
}

test('M1 residual (documented, not fixed here): a PROVEN contract-wallet (Safe) login still receives a 24 h bearer on request - never 7 days, never for an EOA', async () => {
	const srv = server();
	const challenge = auth.createDashboardChallenge(SAFE, Date.now(), auth.DASHBOARD_CHALLENGE_TTL_CONTRACT_MS);
	const signature = ownerSignature(['b2'], hashMessage(challenge.message));
	const withBearer = await post(srv, { wallet: SAFE, token: challenge.token, signature }, { 'x-dashboard-transport': 'bearer' });
	assert.equal(withBearer.code, 200, JSON.stringify(withBearer.body));
	const bearer = auth.verifyDashboardSession(withBearer.body.sessionToken);
	assert.equal(bearer.kind, 'contract');
	assert.equal(bearer.exp - bearer.iat, auth.SESSION_TTL_CONTRACT_MS);
	const second = auth.createDashboardChallenge(SAFE, Date.now(), auth.DASHBOARD_CHALLENGE_TTL_CONTRACT_MS);
	const without = await post(srv, { wallet: SAFE, token: second.token, signature: ownerSignature(['b2'], hashMessage(second.message)) });
	assert.deepEqual(jsReadableSessions(without.body), [], 'ohne Anforderung auch fuer Safes kein Bearer');
});

/* ============================================================ H1 */

// Gueltige 65-Byte-Form, aber unbrauchbarer Inhalt. Dass viem wirft, prueft H1-0.
async function malformed(message) {
	const good = await OWNER.signMessage({ message });
	return [
		['v = 0x05', `${good.slice(0, -2)}05`],
		['v = 0x00 + r = s = 0', `0x${'00'.repeat(65)}`],
		['r = s = 0, v = 0x1b', `0x${'00'.repeat(64)}1b`],
		['r = s = n (curve order)', `0x${'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'.repeat(2)}1b`],
		['all 0xff', `0x${'ff'.repeat(65)}`]
	];
}

test('H1-0 precondition: every malformed signature has the accepted 65-byte shape AND makes viem.verifyMessage throw (reaches the exception branch)', async () => {
	const challenge = auth.createDashboardChallenge(OWNER.address);
	for (const [name, signature] of await malformed(challenge.message)) {
		assert.match(signature, /^0x[0-9a-fA-F]{130}$/, `${name}: Form wie EOA_SIGNATURE`);
		await assert.rejects(verifyMessage({ address: OWNER.address, message: challenge.message, signature }), `${name}: viem muss werfen`);
	}
});

test('H1 the shared verifier maps a throwing verifyMessage to INVALID_SIGNATURE_FORMAT, never VALID', async () => {
	const challenge = auth.createDashboardChallenge(OWNER.address);
	const data = auth.verifyDashboardToken(challenge.token);
	for (const [name, signature] of await malformed(challenge.message)) {
		const result = await siwe.verifyExpectedSiweSignature({ message: challenge.message, signature, expected: auth.dashboardSiweExpectation(data) });
		assert.equal(result, 'INVALID_SIGNATURE_FORMAT', name);
	}
});

for (const [label, providers] of [['dual-RPC available (production-like)', undefined], ['RPC outage / no keys', null]]) {
	test(`H1 login with a malformed 65-byte signature is rejected end-to-end (${label}): 401, no consume, no cookie, no session`, async () => {
		const srv = server(providers === null ? { providers: null } : {});
		const challenge = auth.createDashboardChallenge(OWNER.address);
		for (const [name, signature] of await malformed(challenge.message)) {
			const res = await post(srv, { wallet: OWNER.address, token: challenge.token, signature });
			assert.equal(res.code, 401, `${name}: ${JSON.stringify(res.body)}`);
			assert.equal(res.headers['set-cookie'], undefined, name);
			assert.deepEqual(jsReadableSessions(res.body), [], name);
		}
		assert.deepEqual(srv.effects.consumed, [], 'keine Nonce verbraucht');
	});
}
