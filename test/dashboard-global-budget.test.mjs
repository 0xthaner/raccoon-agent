/**
 * AGENT-HARD-003: globales Abuse-Budget fuer Challenge-Erzeugung und Login.
 *
 * Deterministisch und offline wie link-code-rate-limit.test.mjs: `src/db.mjs`
 * zieht beim Import Supabase-Zugangsdaten und laesst sich hier nicht laden.
 * Geprueft wird deshalb die Form und die REIHENFOLGE der Schranken - dass das
 * globale Budget NACH den engeren IP-/Wallet-Schranken und VOR der teuren
 * Arbeit (getCode/Insert bzw. Signatur/ERC-1271/Nonce/Session) greift. Das
 * Zusaetzlich pruefen VM-Tests die echten Handler-/Limiter-Funktionen mit
 * gemockten Abhaengigkeiten. Das atomare DB-Zaehlen selbst wird hier nicht
 * ausgefuehrt (enforceRateLimitFor + check_agent_rate_limit bleiben unveraendert).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHmac } from 'node:crypto';
import { queryParams, singleQueryValue } from '../src/request-query.mjs';

const dashboard = readFileSync('api/dashboard.mjs', 'utf8');
const sicherheit = readFileSync('src/http-security.mjs', 'utf8');

const idx = (s) => dashboard.indexOf(s);
const CHAL_GLOBAL = "enforceRateLimitFor(response, 'dashboard-challenge-global', 'all', 600, 600)";
const LOGIN_GLOBAL = "enforceRateLimitFor(response, 'dashboard-login-global', 'all', 200, 600)";

/* ---- Budget-Werte -------------------------------------------------------- */

test('1 globales Challenge-Budget: 600 / 600s, konstanter Diskriminator', () => {
	assert.match(dashboard, /enforceRateLimitFor\(response, 'dashboard-challenge-global', 'all', 600, 600\)/);
});

test('2 globales Login-Budget: 200 / 600s, konstanter Diskriminator', () => {
	assert.match(dashboard, /enforceRateLimitFor\(response, 'dashboard-login-global', 'all', 200, 600\)/);
});

/* ---- Challenge-Reihenfolge (A-E) ----------------------------------------- */

test('A malformed Wallet faellt VOR dem globalen Budget durch (isAddress)', () => {
	const addr = idx("if (!isAddress(wallet)) return response.status(400)");
	assert.ok(addr > -1 && addr < idx(CHAL_GLOBAL), 'isAddress muss vor dem globalen Budget stehen');
});

test('B/C globales Budget steht NACH IP- und Wallet-Schranke', () => {
	const ip = idx("enforceRateLimit(request, response, 'dashboard-challenge', 20, 600)");
	const wal = idx("enforceRateLimitFor(response, 'dashboard-challenge-wallet', wallet.toLowerCase(), 10, 600)");
	const global = idx(CHAL_GLOBAL);
	assert.ok(ip > -1 && wal > -1 && global > -1);
	assert.ok(ip < global, 'IP-Schranke muss vor dem globalen Budget stehen');
	assert.ok(wal < global, 'Wallet-Schranke muss vor dem globalen Budget stehen');
});

test('D/E globales Budget steht VOR getCode und VOR dem Challenge-Insert', () => {
	const global = idx(CHAL_GLOBAL);
	const getCode = idx('isDeployedContract(wallet)');
	const store = idx('storeDashboardChallenge(');
	const create = idx('createDashboardChallenge(wallet');
	assert.ok(global > -1 && getCode > -1 && store > -1 && create > -1);
	assert.ok(global < getCode, 'globales Budget muss vor getCode stehen');
	assert.ok(global < create, 'globales Budget muss vor der Challenge-Erzeugung stehen');
	assert.ok(global < store, 'globales Budget muss vor dem DB-Insert stehen');
});

test('B/C/D/E ein Block bricht mit return ab (keine spaetere Arbeit)', () => {
	// Das Muster `if (!await enforceRateLimitFor(...global...)) return;` garantiert,
	// dass bei Erschoepfung nichts dahinter laeuft.
	assert.match(dashboard, /if \(!await enforceRateLimitFor\(response, 'dashboard-challenge-global', 'all', 600, 600\)\) return;/);
});

/* ---- Login-Reihenfolge (I-P) --------------------------------------------- */

test('I ungueltiger Token/Struktur faellt VOR dem globalen Login-Budget durch (401)', () => {
	const struktur = idx('challenge.wallet !== wallet.toLowerCase()');
	assert.ok(struktur > -1 && struktur < idx(LOGIN_GLOBAL), 'Strukturpruefung muss vor dem globalen Budget stehen');
});

test('J/K globales Login-Budget steht NACH IP- und Wallet-Schranke', () => {
	const ip = idx("enforceRateLimit(request, response, 'dashboard-login', 10, 600)");
	const wal = idx("enforceRateLimitFor(response, 'dashboard-login-wallet', wallet.toLowerCase(), 10, 600)");
	const global = idx(LOGIN_GLOBAL);
	assert.ok(ip > -1 && wal > -1 && global > -1);
	assert.ok(ip < global, 'IP-Schranke muss vor dem globalen Login-Budget stehen');
	assert.ok(wal < global, 'Wallet-Schranke muss vor dem globalen Login-Budget stehen');
});

test('L/M/N/O globales Login-Budget steht VOR Signatur/ERC-1271, Nonce-Consume und Session', () => {
	const global = idx(LOGIN_GLOBAL);
	const verify = idx('verifyWalletSiweSignature({');
	const consume = idx('consumeDashboardChallenge(');
	const session = idx('createDashboardSession(');
	assert.ok(global > -1 && verify > -1, 'globales Budget und Signaturpruefung muessen existieren');
	assert.ok(global < verify, 'globales Budget muss vor der Signatur-/ERC-1271-Pruefung stehen');
	// Nonce-Consume und Session entstehen erst nach erfolgreicher Verifikation,
	// also zwangslaeufig hinter dem globalen Budget.
	assert.ok(consume > -1 && global < consume, 'globales Budget muss vor dem Nonce-Consume stehen');
	assert.ok(session > -1 && global < session, 'globales Budget muss vor der Bearer-Session stehen');
	assert.ok(global < idx('sessionCookieHeader(wallet)'), 'globales Budget muss vor der Cookie-Session stehen');
});

test('L/M/N/O ein Block bricht mit return ab (keine Verifikation/Session)', () => {
	assert.match(dashboard, /if \(!await enforceRateLimitFor\(response, 'dashboard-login-global', 'all', 200, 600\)\) return;/);
});

/* ---- Wallet-/IP-Unabhaengigkeit (Q-T) ------------------------------------ */

test('Q/S globale Budgets sind wallet-unabhaengig (Diskriminator ist "all", nicht die Wallet)', () => {
	assert.equal(/dashboard-(challenge|login)-global', wallet/.test(dashboard), false);
	assert.match(dashboard, /'dashboard-challenge-global', 'all'/);
	assert.match(dashboard, /'dashboard-login-global', 'all'/);
});

test('R/T globale Budgets sind IP-unabhaengig (enforceRateLimitFor am konstanten Wert, nicht enforceRateLimit an der IP)', () => {
	// Die globalen Schranken nutzen die wertbasierte Variante mit konstantem 'all';
	// enforceRateLimit (IP-HMAC) wird dafuer NICHT verwendet.
	assert.equal(/enforceRateLimit\(request, response, 'dashboard-(challenge|login)-global'/.test(dashboard), false);
});

/* ---- 429 / Retry-After / Security-Event / Fail-closed (F,G,H,P) ---------- */

test('F/P beide globalen Schranken nutzen dieselbe 429-Infrastruktur', () => {
	assert.match(sicherheit, /response\.status\(429\)/);
});

test('G/P Retry-After entspricht dem Fenster (gemeinsame Infrastruktur)', () => {
	const block = sicherheit.slice(sicherheit.indexOf('export async function enforceRateLimitFor('));
	assert.match(block, /response\.setHeader\('retry-after', String\(windowSeconds\)\)/);
});

test('H Security-Event uebernimmt den Scope (global unterscheidbar), ohne IP/Token/Nonce', () => {
	const block = sicherheit.slice(sicherheit.indexOf('export async function enforceRateLimitFor('));
	assert.match(block, /recordSecurityEvent\(SECURITY_EVENT\.RATE_LIMIT_BLOCKED, \{ source: 'system', fingerprint: identity\.slice\(0, 12\), scope \}\)/);
});

test('Fail-closed: ohne Secret 503 vor dem Zaehlen (gemeinsame Infrastruktur)', () => {
	const block = sicherheit.slice(sicherheit.indexOf('export async function enforceRateLimitFor('));
	const absturz = block.indexOf('response.status(503)');
	const zaehlen = block.indexOf('checkRateLimit');
	assert.ok(absturz > -1 && absturz < zaehlen, 'die Konfigurationspruefung muss vor dem Zaehlen stehen');
});

test('kein neuer Ad-hoc-Zaehler, kein Sharding, keine Env-Variable fuer die Grenzen', () => {
	// Reine Konstanten, keine process.env-Ableitung der globalen Limits.
	assert.equal(/dashboard-(challenge|login)-global[^)]*process\.env/.test(dashboard), false);
	// Ein Key je Endpoint, kein Shard-Suffix.
	assert.equal(/dashboard-challenge-global:\$\{/.test(dashboard), false);
	assert.equal(/dashboard-login-global:\$\{/.test(dashboard), false);
	assert.equal((dashboard.match(/enforceRateLimitFor\(response, 'dashboard-challenge-global'/g) ?? []).length, 1);
	assert.equal((dashboard.match(/enforceRateLimitFor\(response, 'dashboard-login-global'/g) ?? []).length, 1);
});

test('vollstaendige Challenge- und Login-Reihenfolge bleibt erhalten', () => {
	for (const steps of [
		["if (!isAddress(wallet)) return response.status(400)", "enforceRateLimit(request, response, 'dashboard-challenge',", "enforceRateLimitFor(response, 'dashboard-challenge-wallet',", CHAL_GLOBAL, 'isDeployedContract(wallet)', 'createDashboardChallenge(wallet', 'storeDashboardChallenge('],
		["enforceRateLimit(request, response, 'dashboard-login',", 'const challenge = verifyDashboardToken(token)', "if (challenge?.type !== 'challenge'", "enforceRateLimitFor(response, 'dashboard-login-wallet',", LOGIN_GLOBAL, 'verifyWalletSiweSignature({', 'consumeDashboardChallenge(', 'sessionCookieHeader(wallet)']
	]) {
		let previous = -1;
		for (const step of steps) {
			const current = idx(step);
			assert.ok(current > previous, `Missing or out-of-order step: ${step}`);
			previous = current;
		}
	}
});

// Same source-function VM pattern as dashboard-atomic-revoke.test.mjs.
// Dependencies are mocks: no imported DB client, network or environment changes.
const wallet = `0x${'ab'.repeat(20)}`;
function responseMock() {
	return { headers: {}, code: 200, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
function handlerWith(calls, blocked) {
	const step = (name) => { calls.push(name); return name !== blocked; };
	const handler = dashboard.slice(dashboard.indexOf('export default async function handler')).replace('export default ', '');
	return vm.runInNewContext(`(${handler})`, {
		ANMELDUNG_PAUSIERT: false, queryParams, singleQueryValue,
		isAddress: (value) => /^0x[0-9a-f]{40}$/.test(value ?? ''),
		enforceRateLimit: async (_req, _res, scope) => step(scope),
		enforceRateLimitFor: async (_res, scope) => step(scope),
		requireSameOrigin: () => true, requireJson: () => true,
		verifyDashboardToken: (token) => token === 'valid' ? { type: 'challenge', wallet, nonce: 'test', exp: 1 } : null,
		DASHBOARD_CHALLENGE_TTL_EOA_MS: 300000, DASHBOARD_CHALLENGE_TTL_CONTRACT_MS: 1800000,
		isDeployedContract: async () => { step('getCode'); return false; },
		createDashboardChallenge: () => { step('create'); return { token: 'valid' }; },
		storeDashboardChallenge: async () => step('store'),
		dashboardMessage: () => 'test message', dashboardSiweExpectation: () => ({}),
		verifyWalletSiweSignature: async () => { step('verify'); return 'VALID'; },
		consumeDashboardChallenge: async () => step('consume'),
		sessionCookieHeader: () => { step('cookie'); return 'test cookie'; },
		createDashboardSession: () => { step('bearer'); return 'test token'; },
		recordAgentEvent: async () => {}, dashboardData: async () => ({ ok: true })
	});
}

test('offline handler: malformed challenge and narrower/global blocks stop later work', async () => {
	const stages = ['dashboard-read', 'dashboard-challenge', 'dashboard-challenge-wallet', 'dashboard-challenge-global', 'getCode', 'create', 'store'];
	for (const blocked of [null, 'malformed', ...stages.slice(1, 4)]) {
		const calls = [];
		const response = responseMock();
		await handlerWith(calls, blocked)({ method: 'GET', url: `/api/dashboard?wallet=${blocked === 'malformed' ? 'bad' : wallet}` }, response);
		const expected = blocked === 'malformed' ? stages.slice(0, 1) : blocked ? stages.slice(0, stages.indexOf(blocked) + 1) : stages;
		assert.deepEqual(calls, expected);
		if (blocked === 'malformed') assert.equal(response.code, 400);
	}
});

test('offline handler: login validation and narrower/global blocks precede verification and both sessions', async () => {
	const stages = ['dashboard-login', 'dashboard-login-wallet', 'dashboard-login-global', 'verify', 'consume', 'cookie', 'bearer'];
	for (const blocked of [null, 'token', 'wallet', 'signature', ...stages.slice(0, 3)]) {
		const calls = [];
		const response = responseMock();
		await handlerWith(calls, blocked)({ method: 'POST', query: {}, headers: { 'x-dashboard-transport': 'bearer' }, body: {
			wallet: blocked === 'wallet' ? 'bad' : wallet, token: blocked === 'token' ? 'bad' : 'valid', signature: blocked === 'signature' ? null : 'test'
		} }, response);
		const invalid = ['token', 'wallet', 'signature'].includes(blocked);
		assert.deepEqual(calls, invalid ? stages.slice(0, 1) : blocked ? stages.slice(0, stages.indexOf(blocked) + 1) : stages);
		if (invalid) assert.equal(response.code, 401);
	}
});

test('offline shared limiter: global key, 429, Retry-After, event and fail-closed behavior', async () => {
	const functionSource = sicherheit.slice(sicherheit.indexOf('export async function enforceRateLimitFor('), sicherheit.indexOf('export async function enforceRateLimit(request')).replace('export ', '').trim();
	for (const [scope, max] of [['dashboard-challenge-global', 600], ['dashboard-login-global', 200]]) {
		for (const mode of ['allow', 'block', 'db-error', 'no-secret']) {
			const calls = [];
			const response = responseMock();
			const limiter = vm.runInNewContext(`(${functionSource})`, {
				rateSecret: () => mode === 'no-secret' ? '' : 'offline-test-key', createHmac,
				checkRateLimit: async (...args) => { calls.push(args); if (mode === 'db-error') throw new Error('offline DB failure'); return mode === 'allow'; },
				recordSecurityEvent: async (event, data) => calls.push({ event, ...data }), SECURITY_EVENT: { RATE_LIMIT_BLOCKED: 'blocked' }
			});
			if (mode === 'db-error') await assert.rejects(limiter(response, scope, 'all', max, 600));
			else assert.equal(await limiter(response, scope, 'all', max, 600), mode === 'allow');
			if (mode === 'no-secret') { assert.equal(response.code, 503); assert.deepEqual(calls, []); continue; }
			assert.equal(calls[0][0], `${scope}:${createHmac('sha256', 'offline-test-key').update('all').digest('hex')}`);
			assert.equal(calls[0][1], max);
			assert.equal(calls[0][2], 600);
			if (mode === 'block') {
				assert.equal(response.code, 429);
				assert.equal(response.headers['retry-after'], '600');
				assert.equal(calls[1].event, 'blocked');
				assert.equal(calls[1].scope, scope);
			}
		}
	}
});
