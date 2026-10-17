/**
 * CRSF Phase 2M, CR-RESOURCE-001 P3 ("challenge issuance limits before getCode"):
 * GET /api/dashboard?wallet=... stellt eine Login-Challenge aus. Vorher fragt der
 * Server Alchemy per eth_getCode, ob die Wallet ein Contract ist (laengere TTL fuer
 * Safes), und speichert die Challenge. Beides erst nach
 *   dashboard-read (IP) -> Adresspruefung -> dashboard-challenge (IP)
 *   -> dashboard-challenge-wallet -> dashboard-challenge-global.
 *
 * Die zweite Challenge-Ausgabe mit getCode - die Aktions-Challenge einer
 * Alt-Sitzung (POST {action}, eth_getCode bei Alchemy UND Infura) - deckt
 * test/dashboard-legacy-rate-order.test.mjs (F-2F-1).
 *
 * Echt laufen: api/dashboard.mjs, src/http-security.mjs, src/dashboard-auth.mjs
 * und isDeployedContract (src/contract-detect.mjs) mit eigenem, leerem Cache auf
 * einem offline Draht-Provider. Ersetzt: Zaehlerspeicher und Datenbank.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAddress } from 'viem';
import { guards, loadHandler, providers, response, firstIndex, SECURITY_EVENT } from '../test-support/rate-order-world.mjs';

process.env.DASHBOARD_SESSION_SECRET = 'challenge-rate-order-secret-0123456789abcd-01';
process.env.APP_BASE_URL = 'https://coverraccoon.com';
const auth = await import('../src/dashboard-auth.mjs');
const { siweOrigin } = await import('../src/siwe-auth.mjs');
const { queryParams, singleQueryValue } = await import('../src/request-query.mjs');
const { isDeployedContract } = await import('../src/contract-detect.mjs');

const WALLET = '0x' + 'c3'.repeat(20);
const SAFE_CODE = '0x608060405234801561001057600080fd5b50';
const GATES = ['dashboard-read', 'dashboard-challenge', 'dashboard-challenge-wallet', 'dashboard-challenge-global'];

function world({ deny = null, code = '0x' } = {}) {
	const trace = [];
	const g = guards({ deny, dashboardSecretConfigured: auth.dashboardSecretConfigured, siweOrigin, trace });
	const rpc = providers({ trace, answer: (method) => (method === 'eth_getCode' ? code : undefined) });
	const cache = new Map();
	const stored = [];
	const deps = {
		isAddress, queryParams, singleQueryValue, ...auth, ...g,
		isDeployedContract: (address) => isDeployedContract(address, { client: rpc.clients.alchemy, cache }),
		storeDashboardChallenge: async (row) => { trace.push('DB store'); stored.push(row); },
		verifyWalletSiweAuthority: async () => { throw new Error('not on this path'); },
		verifyOnchainDashboardLoginApproval: async () => { throw new Error('not on this path'); },
		noContractCodeByQuorum: async () => { throw new Error('not on this path'); },
		getWalletCovers: async () => ({ covers: [] }), getWalletLinkStateByWallet: async () => ({ linked: false, link: null }),
		isDashboardSessionRevoked: async () => false, isDashboardChallengeOpen: async () => false, consumeDashboardChallenge: async () => false,
		revokeDashboardSessions: async () => Date.now(), unlinkWalletByWallet: async () => [], unlinkWalletFromAllChats: async () => [],
		consumeDashboardAccess: async () => null, recordAgentEvent: async () => {}, getLanguage: async () => 'de',
		beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}, recordSecurityEvent: async () => {}, securityFingerprint: () => 'fp', SECURITY_EVENT
	};
	return { handler: loadHandler('api/dashboard.mjs', deps), trace, limits: g.limits, sizes: g.sizes, rpc, stored };
}

async function challenge(w, wallet = WALLET) {
	const r = response();
	await w.handler({ method: 'GET', url: `/api/dashboard?wallet=${wallet}`, headers: { 'x-forwarded-for': '198.51.100.51' } }, r);
	return r;
}
const work = (w) => { const c = w.rpc.count(); return { getCode: c.alchemy + c.infura, stored: w.stored.length }; };
const ttlMinutes = (r) => { const t = auth.verifyDashboardToken(r.body.token); return (t.exp - t.iat) / 60_000; };

for (const [i, gate] of GATES.entries()) {
	test(`CHALLENGE-ORDER denied at ${gate}`, async () => {
		const w = world({ deny: gate, code: SAFE_CODE });
		const r = await challenge(w);
		assert.deepEqual(work(w), { getCode: 0, stored: 0 }, `challenge: provider/store work after a denied ${gate}`);
		assert.equal(r.code, 429);
		assert.deepEqual(w.limits, GATES.slice(0, i + 1), `challenge: gates after ${gate}`);
	});
}

test('CHALLENGE-ORDER invalid address: 400 after the read gate, no challenge gate, no getCode', async () => {
	const w = world();
	const r = await challenge(w, '0xnot-an-address');
	assert.deepEqual(work(w), { getCode: 0, stored: 0 });
	assert.equal(r.code, 400);
	assert.deepEqual(w.limits, ['dashboard-read']);
});

test('CHALLENGE-ORDER admitted: all four gates before the single getCode, then one stored challenge', async () => {
	const w = world();
	const r = await challenge(w);
	assert.equal(r.code, 200);
	const firstRpc = firstIndex(w.trace, 'RPC');
	assert.deepEqual(w.trace.slice(0, firstRpc).filter((t) => t.startsWith('limit')).map((t) => t.slice(6)), GATES, 'gates before getCode');
	assert.deepEqual(w.trace.filter((t) => !t.startsWith('limit')), ['RPC alchemy eth_getCode', 'DB store']);
});

test('CHALLENGE-ORDER admitted: provider classification unchanged (EOA 5 min, contract 30 min, provider error fails closed to 5 min)', async () => {
	for (const [code, minutes, label] of [['0x', 5, 'EOA'], [SAFE_CODE, 30, 'contract'], [undefined, 5, 'provider error']]) {
		const w = world({ code });
		const r = await challenge(w);
		assert.equal(r.code, 200, label);
		assert.equal(ttlMinutes(r), minutes, label);
		assert.deepEqual(work(w), { getCode: 1, stored: 1 }, label);
		assert.equal(w.stored[0].wallet, WALLET, label);
	}
});

test('CHALLENGE-ORDER budget sizes are the documented ones (per 600 s)', async () => {
	const w = world();
	await challenge(w);
	assert.deepEqual(w.sizes, { 'dashboard-read': [120, 600], 'dashboard-challenge': [20, 600], 'dashboard-challenge-wallet': [10, 600], 'dashboard-challenge-global': [600, 600] });
});
