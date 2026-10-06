/*
	AGENT-SAFE: Frontend-Safe-App-Flow (web/src/safe-app.js).
	Alles gemockt: SDK + fetch injiziert. Keine echte Safe-/Netz-Interaktion.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSafeContext, runSafeLogin, SAFE_LOGIN_CHAIN_ID } from '../web/src/safe-app.js';

// Synthetische Platzhalter - keine realen Wallet-Adressen im Repo.
const SAFE = '0x5afe000000000000000000000000000000005afe';
const OWNER = '0x1111111111111111111111111111111111111111';
const SIWE = 'coverraccoon.com wants you to sign in ...';

function makeSdk({ offchainSeq = ['0xFINALSIG'], threshold = 2, signMessageResult = { messageHash: '0xhash' } } = {}) {
	let i = 0;
	const calls = { setSafeSettings: [], signMessage: [], getOffChainSignature: [] };
	return {
		calls,
		eth: { setSafeSettings: async (p) => { calls.setSafeSettings.push(p); return p?.[0]; } },
		txs: { signMessage: async (m) => { calls.signMessage.push(m); return signMessageResult; } },
		safe: { getOffChainSignature: async (h) => { calls.getOffChainSignature.push(h); return offchainSeq[Math.min(i++, offchainSeq.length - 1)]; } }
	};
}

function makeFetch(routes) {
	const calls = [];
	const fetchFn = async (url, options = {}) => {
		calls.push({ url, options });
		const body = options.body ? JSON.parse(options.body) : null;
		const result = routes(url, options, body);
		return { json: async () => result };
	};
	fetchFn.calls = calls;
	return fetchFn;
}

const okRoutes = () => (url, options) => {
	if (url.startsWith('/api/dashboard?wallet=')) return { ok: true, message: SIWE, token: 'challenge-token' };
	if (url === '/api/dashboard' && options.method === 'POST') return { ok: true, wallet: SAFE.toLowerCase(), covers: [], sessionToken: 'SESSION_TOKEN' };
	return { ok: false };
};

const info2of2 = { safeAddress: SAFE, chainId: 1, threshold: 2, owners: [OWNER, '0x2222222222222222222222222222222222222222'], isReadOnly: false };

test('erfolgreicher 2/2-Flow: Zustandsfolge, Identitaet = Safe, Bearer zurueck', async () => {
	const sdk = makeSdk({ offchainSeq: ['', '', '0xFINALSIG'], threshold: 2 });
	const fetchFn = makeFetch(okRoutes());
	const states = [];
	const out = await runSafeLogin({
		sdk, info: info2of2, fetchFn,
		onState: (s) => states.push(s),
		pollIntervalMs: 0, waitFn: async () => {}, now: (() => { let t = 0; return () => (t += 1000); })()
	});
	assert.deepEqual(states, ['SAFE_CONTEXT_DETECTED', 'CHALLENGE_CREATED', 'SIGNATURE_PENDING', 'WAITING_FOR_OWNERS', 'SIGNATURE_READY', 'VERIFYING', 'AUTHENTICATED']);
	assert.equal(out.sessionToken, 'SESSION_TOKEN');
	// signMessage bekam exakt die serverseitige SIWE-Nachricht
	assert.equal(sdk.calls.signMessage[0], SIWE);
	// offChainSigning wurde aktiviert
	assert.deepEqual(sdk.calls.setSafeSettings[0], [{ offChainSigning: true }]);
	// POST: Identity = Safe-Adresse, Bearer-Transport-Header, keine Owner-Adresse
	const post = fetchFn.calls.find((c) => c.url === '/api/dashboard' && c.options.method === 'POST');
	const body = JSON.parse(post.options.body);
	assert.equal(body.wallet, SAFE);
	assert.notEqual(body.wallet.toLowerCase(), OWNER.toLowerCase());
	assert.equal(post.options.headers['X-Dashboard-Transport'], 'bearer');
	assert.equal(body.signature, '0xFINALSIG');
});

test('Chain != 1 -> REJECTED, kein Challenge-Fetch, kein Login', async () => {
	const sdk = makeSdk();
	const fetchFn = makeFetch(okRoutes());
	const states = [];
	await assert.rejects(() => runSafeLogin({ sdk, info: { ...info2of2, chainId: 137 }, fetchFn, onState: (s) => states.push(s) }));
	assert.deepEqual(states, ['REJECTED']);
	assert.equal(fetchFn.calls.length, 0);
});

test('Poll bleibt leer -> EXPIRED, kein Login-POST', async () => {
	const sdk = makeSdk({ offchainSeq: [''] });
	const fetchFn = makeFetch(okRoutes());
	const states = [];
	await assert.rejects(() => runSafeLogin({
		sdk, info: info2of2, fetchFn, onState: (s) => states.push(s),
		pollIntervalMs: 0, pollTimeoutMs: 10, waitFn: async () => {}, now: (() => { let t = 0; return () => (t += 5); })()
	}));
	assert.ok(states.includes('EXPIRED'));
	assert.ok(!states.includes('AUTHENTICATED'));
	assert.equal(fetchFn.calls.filter((c) => c.options.method === 'POST').length, 0);
});

test('Backend lehnt ab -> REJECTED, keine Session', async () => {
	const sdk = makeSdk({ offchainSeq: ['0xSIG'] });
	const fetchFn = makeFetch((url) => {
		if (url.startsWith('/api/dashboard?wallet=')) return { ok: true, message: SIWE, token: 'tok' };
		return { ok: false, error: 'Wallet-Signatur konnte nicht bestätigt werden.' };
	});
	const states = [];
	await assert.rejects(() => runSafeLogin({ sdk, info: info2of2, fetchFn, onState: (s) => states.push(s), pollIntervalMs: 0, waitFn: async () => {}, now: (() => { let t = 0; return () => (t += 1000); })() }));
	assert.ok(states.includes('REJECTED'));
	assert.ok(!states.includes('AUTHENTICATED'));
});

test('kein messageHash vom SDK -> REJECTED', async () => {
	const sdk = makeSdk({ signMessageResult: {} });
	const fetchFn = makeFetch(okRoutes());
	const states = [];
	await assert.rejects(() => runSafeLogin({ sdk, info: info2of2, fetchFn, onState: (s) => states.push(s), pollIntervalMs: 0, waitFn: async () => {}, now: () => 0 }));
	assert.ok(states.includes('REJECTED'));
});

test('detectSafeContext: getInfo liefert Safe -> ctx; Timeout/Fehler -> null', async () => {
	class SdkOk { safe = { getInfo: async () => info2of2 }; }
	const ok = await detectSafeContext(async () => SdkOk, { timeoutMs: 50 });
	assert.equal(ok.info.safeAddress, SAFE);

	class SdkHang { safe = { getInfo: () => new Promise(() => {}) }; }
	const hang = await detectSafeContext(async () => SdkHang, { timeoutMs: 20 });
	assert.equal(hang, null);

	const err = await detectSafeContext(async () => { throw new Error('no sdk'); }, { timeoutMs: 20 });
	assert.equal(err, null);
});

test('SAFE_LOGIN_CHAIN_ID ist Mainnet', () => { assert.equal(SAFE_LOGIN_CHAIN_ID, 1); });
