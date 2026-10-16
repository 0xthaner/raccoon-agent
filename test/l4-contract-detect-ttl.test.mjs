/*
	Restaudit L4, 16.10.2026 - die Contract-Erkennung (isDeployedContract, EIN Provider)
	waehlt nur die Lebensdauer der Login-Challenge. Sie darf nie autorisieren.

	Echter Handler (api/dashboard.mjs), echte Contract-Erkennung (src/contract-detect.mjs)
	mit einem steuerbaren getCode-Provider, der luegen, haengen, scheitern oder Unsinn
	liefern kann. Die eigentliche Anmeldung laeuft ueber die echte Pruefung
	(verifyWalletSiweAuthority): EOA offline, Contracts per ERC-1271 ueber ZWEI ehrliche,
	simulierte Provider - unabhaengig vom TTL-Provider. Die Challenge-Tabelle ist ein
	Abbild mit derselben Regel wie in Postgres (H2: nur unbenutzt, nur gebundene Wallet,
	nur vor expires_at).
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicClient, custom, isAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';

process.env.APP_BASE_URL = 'https://coverraccoon.com';
process.env.DASHBOARD_SESSION_SECRET = 'l4-contract-detect-secret-0123456789abcdef-0123';
delete process.env.ALCHEMY_API_KEY;

const auth = await import('../src/dashboard-auth.mjs');
const { verifyWalletSiweAuthority, noContractCodeByQuorum } = await import('../src/contract-signature.mjs');
const { isDeployedContract } = await import('../src/contract-detect.mjs');

const EOA = privateKeyToAccount(`0x${'06'.repeat(32)}`); // oeffentlicher, unbefuellter Offline-Testschluessel
const STRANGER = privateKeyToAccount(`0x${'07'.repeat(32)}`);
const SAFE = '0x5afe00000000000000000000000000000000c00c';
const SAFE_CODE = '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e';
const SIG_OWNER = `0x${'a1'.repeat(65)}`;
const SIG_NOT_OWNER = `0x${'c3'.repeat(65)}`;
const MAGIC = `0x1626ba7e${'0'.repeat(56)}`;
const NOT_MAGIC = `0xffffffff${'0'.repeat(56)}`;
const MIN = 60_000;

/* -------------------------------------------------------------------- Welt -- */

function world({ classify = async () => '0x' } = {}) {
	const state = { challenges: new Map(), classifierCalls: [], phase: 'challenge', events: [], erc1271: 0 };
	// Zwei EHRLICHE Provider fuer ERC-1271 (die Autoritaet). Die Safe kennt nur SIG_OWNER.
	const honest = () => createPublicClient({ chain: mainnet, transport: custom({ async request({ method, params }) {
		if (method === 'eth_chainId') return '0x1';
		if (method === 'eth_blockNumber') return '0x1312d00';
		if (method === 'eth_getBlockByNumber') return { number: params[0], hash: `0x${BigInt(params[0]).toString(16).padStart(64, '0')}` };
		if (method === 'eth_getCode') return params[0].toLowerCase() === SAFE ? SAFE_CODE : '0x';
		if (method === 'eth_call') { state.erc1271++; return String(params[0].data).toLowerCase().includes(SIG_OWNER.slice(2)) ? MAGIC : NOT_MAGIC; }
		throw new Error(`unexpected ${method}`);
	} }, { retryCount: 0 }) });
	const providers = { alchemy: honest(), infura: honest() };
	const source = readFileSync(new URL('../api/dashboard.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
	const deps = {
		isAddress, queryParams, singleQueryValue, ...auth,
		verifyWalletSiweAuthority: (params) => verifyWalletSiweAuthority(params, { providers }),
		noContractCodeByQuorum: (wallet) => noContractCodeByQuorum(wallet, { providers }),
		// Die ECHTE Erkennung mit EINEM steuerbaren Provider; jeder Aufruf wird mit der Phase protokolliert.
		isDeployedContract: (wallet) => isDeployedContract(wallet, { cache: new Map(), getCode: (address) => { state.classifierCalls.push(state.phase); return classify(address); } }),
		getWalletCovers: async () => ({ covers: [] }), getWalletLinkStateByWallet: async () => ({ linked: false, link: null }),
		storeDashboardChallenge: async ({ nonce, wallet, expiresAt }) => { state.challenges.set(nonce, { wallet: wallet.toLowerCase(), expiresAt, used: false }); },
		consumeDashboardChallenge: async (nonce, wallet) => { const row = state.challenges.get(nonce); if (!row || row.used || row.wallet !== wallet.toLowerCase() || row.expiresAt <= Date.now()) return false; row.used = true; return true; },
		isDashboardSessionRevoked: async () => false, revokeDashboardSessions: async () => Date.now(), unlinkWalletByWallet: async () => [],
		recordAgentEvent: async () => {}, consumeDashboardAccess: async () => null, getLanguage: async () => 'de',
		beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {}, ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {},
		enforceRateLimit: async () => true, enforceRateLimitFor: async () => true, requireSameOrigin: () => true, requireJson: () => true,
		recordSecurityEvent: async (type) => { state.events.push(type); }, securityFingerprint: () => 'fp',
		SECURITY_EVENT: { ERC1271_RPC_DISAGREEMENT: 'disagreement', SIWE_SIGNATURE_INVALID: 'invalid', SIWE_REPLAY_BLOCKED: 'replay' }
	};
	const handler = new Function(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps));
	return { state, handler };
}

function res() {
	return { statusCode: null, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.body = b; return this; } };
}
const payloadOf = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
const session = (r) => { const c = [].concat(r.headers['set-cookie'] ?? []).find((x) => x.startsWith(`${auth.SESSION_COOKIE}=`) && !x.includes('Max-Age=0')); return c ? payloadOf(decodeURIComponent(c.slice(c.indexOf('=') + 1, c.indexOf(';')))) : null; };

/** Challenge ueber den echten GET-Pfad holen. */
async function challengeFor(w, wallet) {
	w.state.phase = 'challenge';
	const r = res();
	await w.handler({ method: 'GET', url: `/api/dashboard?wallet=${wallet}`, headers: {} }, r);
	assert.equal(r.statusCode, 200, JSON.stringify(r.body));
	assert.equal(session(r), null, 'eine Challenge ist nie eine Sitzung');
	const data = payloadOf(r.body.token);
	return { ...r.body, ttl: data.exp - data.iat, data };
}
async function login(w, { wallet, token, signature }) {
	w.state.phase = 'login';
	const r = res();
	await w.handler({ method: 'POST', url: '/api/dashboard', headers: { 'content-type': 'application/json' }, body: { wallet, token, signature } }, r);
	return r;
}
const eoaSignature = (challenge, signer = EOA) => signer.signMessage({ message: challenge.message });

/** Antworten des TTL-Providers. */
const PROVIDER = {
	'empty 0x': async () => '0x',
	'viem empty (undefined)': async () => undefined,
	'bytecode': async () => SAFE_CODE,
	'timeout': () => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('The request took too long to respond.'), { name: 'TimeoutError' })), 20)),
	'HTTP 500': async () => { throw Object.assign(new Error('HTTP request failed. Status: 500'), { name: 'HttpRequestError', status: 500 }); },
	'malformed 0xzz': async () => '0xzz',
	'malformed odd hex': async () => '0x608',
	'malformed text': async () => 'contract',
	'malformed number': async () => 1,
	'malformed object': async () => ({ code: SAFE_CODE }),
	'null (no code)': async () => null
};

/* -------------------------------------------------------- TTL nur aus getCode -- */

test('L4 TTL: 30 minutes only for well-formed bytecode; empty code, timeout, HTTP errors and malformed answers get 5 minutes', async () => {
	const expected = { 'bytecode': 30 * MIN };
	for (const [label, classify] of Object.entries(PROVIDER)) {
		const w = world({ classify });
		const c = await challengeFor(w, EOA.address);
		assert.equal(c.ttl, expected[label] ?? 5 * MIN, label);
		assert.equal(w.state.challenges.get(c.data.nonce).expiresAt, c.data.exp, `${label}: gespeichertes expires_at = exp der Challenge`);
	}
});

test('L4 TTL: a failed or malformed classification is not cached - the next challenge asks again', async () => {
	let answer = '0xzz';
	const cache = new Map();
	await assert.rejects(isDeployedContract(SAFE, { cache, getCode: async () => answer }));
	assert.equal(cache.size, 0);
	answer = SAFE_CODE;
	assert.equal(await isDeployedContract(SAFE, { cache, getCode: async () => answer }), true);
});

/* ------------------------------------------ Anmeldung haengt nicht davon ab -- */

test('L4-B: an EOA misclassified as contract (30-minute challenge) still needs its own valid signature', async () => {
	const w = world({ classify: PROVIDER.bytecode });
	const c = await challengeFor(w, EOA.address);
	assert.equal(c.ttl, 30 * MIN);
	for (const [label, signature] of [['stranger', await eoaSignature(c, STRANGER)], ['garbage', `0x${'ab'.repeat(65)}`], ['empty', '0x']]) {
		const r = await login(w, { wallet: EOA.address, token: c.token, signature });
		assert.equal(r.statusCode, 401, label);
		assert.equal(session(r), null, label);
	}
	assert.equal(w.state.challenges.get(c.data.nonce).used, false, 'ungueltige Signaturen verbrauchen nichts');
	const ok = await login(w, { wallet: EOA.address, token: c.token, signature: await eoaSignature(c) });
	assert.equal(ok.statusCode, 200);
	assert.equal(session(ok).kind, 'eoa', 'Sitzungsart aus der Pruefung, nicht aus der Erkennung');
	assert.equal(session(ok).exp - session(ok).iat, auth.SESSION_TTL_EOA_MS);
});

test('L4-A: a contract misclassified as EOA (5-minute challenge) still needs ERC-1271 from its owners', async () => {
	const w = world({ classify: PROVIDER['empty 0x'] });
	const c = await challengeFor(w, SAFE);
	assert.equal(c.ttl, 5 * MIN);
	const bad = await login(w, { wallet: SAFE, token: c.token, signature: SIG_NOT_OWNER });
	assert.equal(bad.statusCode, 401);
	assert.equal(session(bad), null);
	assert.ok(w.state.erc1271 > 0, 'ERC-1271 wurde tatsaechlich gefragt');
	const ok = await login(w, { wallet: SAFE, token: c.token, signature: SIG_OWNER });
	assert.equal(ok.statusCode, 200);
	assert.equal(session(ok).kind, 'contract');
	assert.equal(session(ok).exp - session(ok).iat, auth.SESSION_TTL_CONTRACT_MS);
});

test('L4-C/D/E: provider timeout, error or malformed answer authorizes nothing', async () => {
	for (const label of ['timeout', 'HTTP 500', 'malformed 0xzz', 'malformed text', 'malformed object', 'null (no code)']) {
		const w = world({ classify: PROVIDER[label] });
		for (const wallet of [EOA.address, SAFE]) {
			const c = await challengeFor(w, wallet);
			const r = await login(w, { wallet, token: c.token, signature: wallet === SAFE ? SIG_NOT_OWNER : await eoaSignature(c, STRANGER) });
			assert.equal(r.statusCode, 401, `${label} ${wallet}`);
			assert.equal(session(r), null);
		}
	}
});

test('L4: the classification is never consulted while logging in', async () => {
	const w = world({ classify: PROVIDER.bytecode });
	const eoa = await challengeFor(w, EOA.address);
	const safe = await challengeFor(w, SAFE);
	assert.deepEqual(w.state.classifierCalls, ['challenge', 'challenge']);
	await login(w, { wallet: EOA.address, token: eoa.token, signature: await eoaSignature(eoa) });
	await login(w, { wallet: SAFE, token: safe.token, signature: SIG_OWNER });
	await login(w, { wallet: SAFE, token: safe.token, signature: SIG_OWNER });
	assert.deepEqual(w.state.classifierCalls, ['challenge', 'challenge'], 'kein getCode beim Login');
});

/* --------------------------------------------- Ablauf und Replay unabhaengig -- */

test('L4-H/I/J: an expired 5-minute challenge stays expired even if the wallet is now classified as contract', async () => {
	const w = world({ classify: PROVIDER.bytecode });
	// Vor 6 Minuten als EOA-Challenge ausgestellt; jetzt meldet der Provider "Contract".
	const issued = Date.now() - 6 * MIN;
	for (const [wallet, sign] of [[EOA.address, (c) => eoaSignature(c)], [SAFE, async () => SIG_OWNER]]) {
		const c = auth.createDashboardChallenge(wallet, issued, auth.DASHBOARD_CHALLENGE_TTL_EOA_MS);
		const data = payloadOf(c.token);
		w.state.challenges.set(data.nonce, { wallet: wallet.toLowerCase(), expiresAt: data.exp, used: false });
		const r = await login(w, { wallet, token: c.token, signature: await sign(c) });
		assert.equal(r.statusCode, 401, `${wallet}: abgelaufen bleibt abgelaufen`);
		assert.equal(session(r), null);
		assert.equal(w.state.challenges.get(data.nonce).used, false);
	}
});

test('L4: the stored expires_at is enforced on its own - a valid token whose stored row expired yields no session', async () => {
	const w = world({ classify: PROVIDER.bytecode });
	const c = await challengeFor(w, EOA.address);
	w.state.challenges.get(c.data.nonce).expiresAt = Date.now() - 1;
	const r = await login(w, { wallet: EOA.address, token: c.token, signature: await eoaSignature(c) });
	assert.equal(r.statusCode, 409);
	assert.equal(session(r), null);
});

test('L4: replay stays blocked whatever the classification', async () => {
	for (const label of ['bytecode', 'empty 0x', 'HTTP 500']) {
		const w = world({ classify: PROVIDER[label] });
		const c = await challengeFor(w, EOA.address);
		const signature = await eoaSignature(c);
		assert.equal((await login(w, { wallet: EOA.address, token: c.token, signature })).statusCode, 200, label);
		const again = await login(w, { wallet: EOA.address, token: c.token, signature });
		assert.equal(again.statusCode, 409, label);
		assert.equal(session(again), null, label);
	}
});

test('L4: challenge expiry comes from the signed exp alone - an expired 5-minute token is invalid, a 30-minute token of the same age is not', () => {
	const issued = Date.now() - 6 * MIN;
	const eoa = auth.createDashboardChallenge(EOA.address, issued, auth.DASHBOARD_CHALLENGE_TTL_EOA_MS);
	const safe = auth.createDashboardChallenge(SAFE, issued, auth.DASHBOARD_CHALLENGE_TTL_CONTRACT_MS);
	assert.equal(auth.verifyDashboardToken(eoa.token), null, 'abgelaufen, egal wie die Wallet heute eingestuft wird');
	assert.equal(auth.verifyDashboardToken(safe.token)?.exp, issued + auth.DASHBOARD_CHALLENGE_TTL_CONTRACT_MS);
});

test('L4: a forged (unsigned) challenge token is refused before any signature check, whatever the classification says', async () => {
	for (const label of ['bytecode', 'empty 0x']) {
		const w = world({ classify: PROVIDER[label] });
		const real = await challengeFor(w, SAFE);
		// Gleicher Inhalt mit spaeterem Ablauf, aber ohne gueltige Server-Signatur (HMAC).
		const forged = `${Buffer.from(JSON.stringify({ ...real.data, exp: Date.now() + 60 * MIN })).toString('base64url')}.${real.token.split('.')[1]}`;
		const before = w.state.erc1271;
		const r = await login(w, { wallet: SAFE, token: forged, signature: SIG_OWNER });
		assert.equal(r.statusCode, 401, label);
		assert.equal(session(r), null);
		assert.equal(w.state.erc1271, before, `${label}: keine Signaturpruefung fuer ein ungueltiges Token`);
		assert.deepEqual(w.state.events, [], `${label}: kein Replay- oder Signaturereignis`);
	}
});
