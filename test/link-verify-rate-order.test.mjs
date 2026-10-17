/**
 * CRSF Phase 2M, CR-RESOURCE-001 P2 ("link verify limits before verification"):
 * POST /api/link/verify fragt Telegram (getChat), prueft die Signatur (offline
 * ECDSA, sonst ERC-1271 ueber Alchemy UND Infura), verbraucht den Link und
 * schreibt dem Chat. Alles erst nach
 *   wallet-link-verify (IP) -> Code-Format -> wallet-link-code (je Code)
 *   -> Link lesen/Strukturpruefung -> wallet-link-verify-global.
 *
 * Echt laufen: api/link/verify.mjs, src/http-security.mjs, die Link-Helfer aus
 * src/linking.mjs (telegramTarget mit aufzeichnendem fetch, signingMessage,
 * linkSiweExpectation) und verifyWalletSiweSignature auf zwei offline
 * Draht-Providern. Ersetzt: Zaehlerspeicher und Datenbank (Spione).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { guards, loadHandler, providers, response, firstIndex, SECURITY_EVENT } from '../test-support/rate-order-world.mjs';

Object.assign(process.env, { SUPABASE_URL: 'https://supabase.test.invalid', SUPABASE_SECRET_KEY: 'test-secret-key', DASHBOARD_SESSION_SECRET: 'link-verify-rate-order-secret-0123456789ab-01', APP_BASE_URL: 'https://coverraccoon.com', TELEGRAM_BOT_TOKEN: 'test-token' });
const auth = await import('../src/dashboard-auth.mjs');
const { siweOrigin } = await import('../src/siwe-auth.mjs');
const linking = await import('../src/linking.mjs');
const signatures = await import('../src/contract-signature.mjs');

// Oeffentliche, unbefuellte Offline-Schluessel; nie von Anwendungscode importiert.
const OWNER = privateKeyToAccount(`0x${'07'.repeat(32)}`);
const STRANGER = privateKeyToAccount(`0x${'08'.repeat(32)}`);
const CODE = 'LinkVerifyCodeAbCdEf0123';
const CHAT = '4242';
const GATES = ['wallet-link-verify', 'wallet-link-code', 'wallet-link-verify-global'];
// Ein fester Ablauf: der signierte Text haengt daran, er muss beim Signieren und Pruefen gleich sein.
const EXPIRES = Date.now() + 300_000;
const row = (extra = {}) => ({ code: CODE, chat_id: CHAT, nonce: 'a1b2c3d4e5f6a7b8', expires_at: EXPIRES, used_at: null, ...extra });
const telegramFetch = (trace) => async (url) => {
	const method = new URL(String(url)).pathname.split('/').pop();
	trace.push(`TELEGRAM ${method}`);
	return Response.json({ ok: true, result: method === 'getChat' ? { id: Number(CHAT), type: 'private', first_name: 'Test', username: 'link_user' } : { message_id: 1 } });
};

function world({ deny = null, pending = row() } = {}) {
	const trace = [];
	const g = guards({ deny, dashboardSecretConfigured: auth.dashboardSecretConfigured, siweOrigin, trace });
	const rpc = providers({ trace });
	const tg = telegramFetch(trace);
	const deps = {
		isAddress, ...g, MAX_WALLETS_PER_CHAT: 10,
		getPendingLink: async () => { trace.push('DB pending'); return pending; },
		consumePendingLink: async () => { trace.push('DB consume'); return { status: 'linked', chatId: CHAT }; },
		getLanguage: async () => 'de',
		isTelegramLinkCode: linking.isTelegramLinkCode, isTelegramLinkRow: linking.isTelegramLinkRow,
		linkSiweExpectation: linking.linkSiweExpectation, signingMessage: linking.signingMessage,
		telegramTarget: (chatId) => linking.telegramTarget(chatId, { fetchImpl: tg }),
		newDashboardAccess: async () => { trace.push('DB access'); return { code: 'x', expiresAt: Date.now() }; },
		verifyWalletSiweSignature: (params) => { trace.push('VERIFY signature'); return signatures.verifyWalletSiweSignature(params, { providers: rpc.clients }); },
		fetch: tg, process,
		recordSecurityEvent: async () => {}, securityFingerprint: () => 'fp', SECURITY_EVENT, ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}
	};
	return { handler: loadHandler('api/link/verify.mjs', deps), trace, limits: g.limits, sizes: g.sizes, rpc };
}

async function signedBody(signer = STRANGER) {
	const target = await linking.telegramTarget(CHAT, { fetchImpl: telegramFetch([]) });
	const p = row();
	const message = linking.signingMessage({ wallet: OWNER.address, nonce: p.nonce, expiresAt: p.expires_at, code: CODE, target: target.target });
	return { code: CODE, wallet: OWNER.address, signature: await signer.signMessage({ message }) };
}
async function verify(w, body) {
	const r = response();
	await w.handler({ method: 'POST', url: '/api/link/verify', body, headers: { origin: 'https://coverraccoon.com', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.61' } }, r);
	return r;
}
function work(w) {
	const c = w.rpc.count();
	return { getChat: w.trace.filter((t) => t === 'TELEGRAM getChat').length, verify: w.trace.filter((t) => t === 'VERIFY signature').length, rpc: c.alchemy + c.infura, writes: w.trace.filter((t) => ['DB consume', 'DB access', 'TELEGRAM sendMessage'].includes(t)) };
}
const NONE = { getChat: 0, verify: 0, rpc: 0, writes: [] };

for (const [i, gate] of GATES.entries()) {
	test(`LINK-VERIFY-ORDER denied at ${gate}`, async () => {
		const w = world({ deny: gate });
		const r = await verify(w, await signedBody());
		assert.deepEqual(work(w), NONE, `link verify: expensive work after a denied ${gate}`);
		assert.equal(r.code, 429);
		assert.deepEqual(w.limits.filter((s) => s.startsWith('wallet-link')), GATES.slice(0, i + 1), `link verify: gates after ${gate}`);
		if (i < 2) assert.ok(!w.trace.includes('DB pending'), 'link not read before the per-code gate admits');
	});
}

test('LINK-VERIFY-ORDER invalid code format: 410 after the IP gate, no per-code gate, no work', async () => {
	const w = world();
	const r = await verify(w, { ...(await signedBody()), code: 'not-a-code' });
	assert.deepEqual(work(w), NONE);
	assert.equal(r.code, 410);
	assert.deepEqual(w.limits, ['wallet-link-verify']);
});

test('LINK-VERIFY-ORDER expired, used or unknown link and malformed signature data: no global charge, no getChat, no verification', async () => {
	for (const [label, pending, patch] of [['expired', row({ expires_at: Date.now() - 1 }), {}], ['used', row({ used_at: Date.now() - 1 }), {}], ['unknown', null, {}], ['bad wallet', row(), { wallet: '0xnope' }], ['no signature', row(), { signature: 42 }]]) {
		const w = world({ pending });
		const r = await verify(w, { ...(await signedBody()), ...patch });
		assert.deepEqual(work(w), NONE, label);
		assert.ok([400, 410].includes(r.code), `${label}: ${r.code}`);
		assert.ok(!w.limits.includes('wallet-link-verify-global'), `${label}: global charged`);
	}
});

test('LINK-VERIFY-ORDER admitted: all three gates before getChat and the verification', async () => {
	const w = world();
	await verify(w, await signedBody(OWNER));
	const first = Math.min(firstIndex(w.trace, 'TELEGRAM'), firstIndex(w.trace, 'VERIFY'));
	assert.deepEqual(w.trace.slice(0, first).filter((t) => t.startsWith('limit')).map((t) => t.slice(6)), GATES);
});

test('LINK-VERIFY-ORDER admitted, owner key: one getChat, verified offline, consumed once, chat notified', async () => {
	const w = world();
	const r = await verify(w, await signedBody(OWNER));
	assert.equal(r.code, 200);
	assert.deepEqual(work(w), { getChat: 1, verify: 1, rpc: 0, writes: ['DB consume', 'DB access', 'TELEGRAM sendMessage'] });
});

test('LINK-VERIFY-ORDER admitted, foreign key: ERC-1271 asked at both providers, fails closed, nothing consumed', async () => {
	const w = world();
	const r = await verify(w, await signedBody(STRANGER));
	assert.equal(r.code, 401);
	const c = w.rpc.count();
	assert.ok(c.alchemy > 0 && c.infura > 0, `providers ${JSON.stringify(c)}`);
	assert.deepEqual({ ...work(w), rpc: 'n' }, { getChat: 1, verify: 1, rpc: 'n', writes: [] });
});

test('LINK-VERIFY-ORDER budget sizes are the documented ones (per 600 s)', async () => {
	const w = world();
	await verify(w, await signedBody(OWNER));
	assert.deepEqual(w.sizes, { 'wallet-link-verify': [10, 600], 'wallet-link-code': [5, 600], 'wallet-link-verify-global': [200, 600] });
});
