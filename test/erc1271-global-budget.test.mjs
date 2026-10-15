/*
	META-AUDIT M-2 (15.10.2026): ein globales Budget vor JEDER ERC-1271-Pruefung.

	Die Dual-RPC-Pruefung einer Contract-Signatur kostet je Versuch rund zehn
	RPC-Aufrufe bei zwei Providern. Der Login hatte dafuer ein globales Budget
	(konstanter Schluessel 'all'), die frische Bestaetigung und die Telegram-
	Verknuepfung nicht: dort deckelten nur IP-, Wallet- bzw. Code-Grenzen, die sich
	mit vielen IPs, eigenen Contract-Wallets bzw. frischen Link-Codes umgehen lassen.

	Hier wird zur LAUFZEIT geprueft, nicht am Quelltext:
	- verweigert das globale Budget, gibt es KEINEN RPC-Aufruf, keinen Telegram-
	  Aufruf, keinen Verbrauch und keine Wirkung (429);
	- sonst steht vor dem ersten RPC-Aufruf eine globale Pruefung (Schluessel 'all').
	Der Verifier ist der echte Dual-RPC-Code mit simulierten Providern.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hashMessage, isAddress } from 'viem';
import { simChain, dualProviders, ownerSignature } from '../test-support/dual-rpc-sim.mjs';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';

process.env.APP_BASE_URL = 'https://coverraccoon.com';
process.env.DASHBOARD_SESSION_SECRET = 'erc1271-global-budget-secret-0123456789abcdef';
delete process.env.TELEGRAM_BOT_TOKEN;

const auth = await import('../src/dashboard-auth.mjs');
const linking = await import('../src/linking.mjs');
const { verifyWalletSiweAuthority, verifyWalletSiweSignature, noContractCodeByQuorum } = await import('../src/contract-signature.mjs');

const SAFE = '0x5afe00000000000000000000000000000000a00a';
const HEAD = 20_000_000n;
const chain = () => simChain({ head: HEAD, safes: { [SAFE]: { history: [{ from: 0n, owners: ['b2'], threshold: 1 }] } } });
const JUNK_CONTRACT_SIG = `0x${'cd'.repeat(97)}`; // Contract-foermig, offline nie gueltig -> Dual-RPC-Pfad

/** Gemeinsames Ereignisprotokoll: Rate-Limit-Pruefungen, RPC-Aufrufe, Telegram, Wirkungen. */
function harness({ denyGlobal = false } = {}) {
	const events = [];
	const rpcLog = () => { events.push('rpc'); }; // gibt undefined zurueck -> Simulator antwortet normal
	const behave = Object.fromEntries(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'].map((m) => [m, rpcLog]));
	const { providers } = dualProviders(chain(), { behave }, { behave });
	const limiter = async (response, scope, key) => {
		events.push(`limit:${scope}:${key === 'all' ? 'GLOBAL' : 'scoped'}`);
		if (denyGlobal && key === 'all') { response.status(429).json({ ok: false }); return false; }
		return true;
	};
	const firstRpc = () => events.indexOf('rpc');
	const globalBeforeRpc = () => { const g = events.findIndex((e) => e.endsWith(':GLOBAL')); return g >= 0 && (firstRpc() < 0 || g < firstRpc()); };
	return { events, providers, limiter, firstRpc, globalBeforeRpc };
}

const res = () => ({ statusCode: null, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.body = b; return this; } });
async function call(handler, { method = 'GET', url = '/api/dashboard', headers = {}, body } = {}) {
	const r = res();
	await handler({ method, url, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body }, r);
	return r;
}

function loadDashboard(h, effects) {
	const source = readFileSync(new URL('../api/dashboard.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
	const challenges = new Map();
	const deps = {
		isAddress, queryParams, singleQueryValue, ...auth,
		verifyWalletSiweAuthority: (params) => verifyWalletSiweAuthority(params, { providers: h.providers }),
		noContractCodeByQuorum: (wallet) => noContractCodeByQuorum(wallet, { providers: h.providers }),
		isDeployedContract: async () => true,
		getWalletCovers: async () => ({ covers: [] }), getWalletLinkStateByWallet: async () => ({ linked: true, link: null }),
		storeDashboardChallenge: async ({ nonce, wallet, expiresAt }) => { challenges.set(nonce, { wallet: wallet.toLowerCase(), expiresAt, used: false }); },
		consumeDashboardChallenge: async (nonce, wallet) => { h.events.push('consume'); const row = challenges.get(nonce); if (!row || row.used || row.wallet !== wallet.toLowerCase()) return false; row.used = true; return true; },
		isDashboardSessionRevoked: async () => false, recordAgentEvent: async () => {}, consumeDashboardAccess: async () => null,
		getLanguage: async () => 'de', beginTelegramDelivery: async () => null, finishTelegramDelivery: async () => {},
		revokeDashboardSessions: async () => { effects.push('revoke'); return Date.now(); },
		unlinkWalletByWallet: async () => { effects.push('unlink'); return []; },
		unlinkWalletFromAllChats: async () => { effects.push('unlink-all'); return []; },
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {},
		enforceRateLimit: async () => true, enforceRateLimitFor: h.limiter,
		requireSameOrigin: () => true, requireJson: () => true,
		recordSecurityEvent: async () => {}, securityFingerprint: () => 'fp', SECURITY_EVENT: {}
	};
	return { handler: new Function(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps)), challenges };
}
const safeCookie = () => ({ cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.createDashboardSession(SAFE, Date.now(), 'contract'))}` });

/* ------------------------------------------------ frische Bestaetigung (M-2) */

for (const [purpose, url] of [['telegram-disconnect', '/api/dashboard?telegram=1'], ['session-revoke', '/api/dashboard']]) {
	test(`M-2 fresh authority (${purpose}): a denied global budget stops BEFORE any RPC - no verify, no consume, no effect`, async () => {
		const h = harness({ denyGlobal: true });
		const effects = [];
		const { handler } = loadDashboard(h, effects);
		const action = auth.createActionChallenge(SAFE, purpose);
		const r = await call(handler, { method: 'DELETE', url, headers: safeCookie(), body: { token: action.token, signature: ownerSignature(['b2'], hashMessage(action.message)) } });
		assert.equal(r.statusCode, 429);
		assert.equal(h.firstRpc(), -1, 'kein einziger RPC-Aufruf');
		assert.ok(!h.events.includes('consume'), 'Challenge nicht verbraucht');
		assert.deepEqual(effects, [], 'keine Wirkung');
	});

	test(`M-2 fresh authority (${purpose}): with budget available, a GLOBAL check precedes the first RPC call`, async () => {
		const h = harness();
		const effects = [];
		const { handler } = loadDashboard(h, effects);
		const action = auth.createActionChallenge(SAFE, purpose);
		const r = await call(handler, { method: 'DELETE', url, headers: safeCookie(), body: { token: action.token, signature: JUNK_CONTRACT_SIG } });
		assert.equal(r.statusCode, 401, 'Muell-Signatur bleibt ungueltig');
		assert.ok(h.firstRpc() >= 0, 'der Dual-RPC-Pfad lief');
		assert.ok(h.globalBeforeRpc(), `globales Budget vor dem ersten RPC: ${h.events.slice(0, 8).join(' ')}`);
	});
}

/* ------------------------------------------- Telegram-Verknuepfung (M-2, neu) */

function loadLinkVerify(h, effects) {
	const source = readFileSync(new URL('../api/link/verify.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
	const CODE = 'LinkCodeForBudget_012345';
	const deps = {
		isAddress, ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {},
		requireSameOrigin: () => true, requireJson: () => true,
		enforceRateLimit: async () => true, enforceRateLimitFor: h.limiter,
		getPendingLink: async () => ({ code: CODE, chat_id: '123456789', nonce: 'ab'.repeat(16), expires_at: Date.now() + 540_000, used_at: null }),
		isTelegramLinkCode: linking.isTelegramLinkCode, isTelegramLinkRow: linking.isTelegramLinkRow,
		telegramTarget: async () => { h.events.push('telegram'); return { username: 'owner_b', name: 'B', target: '@owner_b' }; },
		linkSiweExpectation: linking.linkSiweExpectation, signingMessage: linking.signingMessage,
		verifyWalletSiweSignature: (params) => verifyWalletSiweSignature(params, { providers: h.providers }),
		consumePendingLink: async () => { h.events.push('consume'); effects.push('link'); return '123456789'; },
		recordSecurityEvent: async () => {}, SECURITY_EVENT: {}, securityFingerprint: () => 'fp',
		getLanguage: async () => 'en', newDashboardAccess: async () => null,
		process: { env: {} }, fetch: async () => ({ ok: true })
	};
	return { handler: new Function(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps)), CODE };
}

test('M-2 Telegram link verify: a denied global budget stops BEFORE any RPC and before Telegram getChat', async () => {
	const h = harness({ denyGlobal: true });
	const effects = [];
	const { handler, CODE } = loadLinkVerify(h, effects);
	const r = await call(handler, { method: 'POST', url: '/api/link/verify', body: { code: CODE, wallet: SAFE, signature: JUNK_CONTRACT_SIG } });
	assert.equal(r.statusCode, 429);
	assert.equal(h.firstRpc(), -1, 'kein RPC');
	assert.ok(!h.events.includes('telegram'), 'kein Telegram-Aufruf');
	assert.ok(!h.events.includes('consume'));
	assert.deepEqual(effects, []);
});

test('M-2 Telegram link verify: with budget available, a GLOBAL check precedes the first RPC call', async () => {
	const h = harness();
	const effects = [];
	const { handler, CODE } = loadLinkVerify(h, effects);
	const r = await call(handler, { method: 'POST', url: '/api/link/verify', body: { code: CODE, wallet: SAFE, signature: JUNK_CONTRACT_SIG } });
	assert.equal(r.statusCode, 401);
	assert.ok(h.firstRpc() >= 0, 'der Dual-RPC-Pfad lief');
	assert.ok(h.globalBeforeRpc(), `globales Budget vor dem ersten RPC: ${h.events.slice(0, 8).join(' ')}`);
});

/* ------------------------------------------------------------ Login (Regression) */

test('M-2 login (regression): a denied global budget stops before any RPC; otherwise a global check precedes it', async () => {
	for (const denyGlobal of [true, false]) {
		const h = harness({ denyGlobal });
		const { handler, challenges } = loadDashboard(h, []);
		const c = auth.createDashboardChallenge(SAFE, Date.now(), auth.DASHBOARD_CHALLENGE_TTL_CONTRACT_MS);
		const d = auth.verifyDashboardToken(c.token);
		challenges.set(d.nonce, { wallet: SAFE, expiresAt: d.exp, used: false });
		const r = await call(handler, { method: 'POST', body: { wallet: SAFE, token: c.token, signature: JUNK_CONTRACT_SIG } });
		if (denyGlobal) { assert.equal(r.statusCode, 429); assert.equal(h.firstRpc(), -1); }
		else { assert.equal(r.statusCode, 401); assert.ok(h.globalBeforeRpc()); }
	}
});

/* ------------------------------------------------------------------ Inventar */

test('M-2 inventory: every production ERC-1271 entry point is one of the three budget-tested ones', () => {
	const sites = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.mjs$/.test(name)) {
				const lines = readFileSync(path, 'utf8').split('\n');
				lines.forEach((line, i) => { if (/\bverifyWalletSiwe(?:Authority|Signature)\(\{/.test(line) && !/^\s*(\*|\/\/)/.test(line)) sites.push(path); });
			}
		}
	};
	walk('api');
	// src/web.mjs ist der lokale Entwicklungsserver (nicht auf Vercel) und bleibt aussen vor.
	assert.deepEqual(sites.sort(), ['api/dashboard.mjs', 'api/dashboard.mjs', 'api/link/verify.mjs'],
		'neuer ERC-1271-Aufruf? Dann braucht er ein globales Budget UND einen Laufzeittest in dieser Datei');
});
