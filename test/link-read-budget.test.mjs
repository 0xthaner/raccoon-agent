/**
 * F-2K-1 (CRSF Phase 2L, CR-RESOURCE-001 P5): GET /api/link ruft Telegram getChat
 * (telegramTarget, mit dem Bot-Token) erst, nachdem die Schranken je IP
 * (wallet-link-read), je Code (wallet-link-read-code) und global
 * (wallet-link-read-global) zugelassen haben. Ein gueltiger Code laesst sich ueber
 * wechselnde IPs nicht mehr beliebig oft abfragen.
 *
 * Echt laufen: api/link.mjs, src/http-security.mjs (enforceRateLimit[For], rateKey),
 * src/db.mjs (PostgREST, check_agent_rate_limit, getPendingLink) und
 * src/linking.mjs (telegramTarget). Jeder ausgehende Aufruf laeuft ueber ein
 * Attrappen-fetch: Supabase (Pending-Links; der Rate-Limit-Zaehler zaehlt je
 * Schluessel im festen Fenster wie check_agent_rate_limit und lehnt gezielt ab)
 * und Telegram (getChat wird gezaehlt). Offline, keine echten Schluessel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SECRET = 'link-read-budget-secret-0123456789abcdef-01';
Object.assign(process.env, {
	TELEGRAM_BOT_TOKEN: 'test-token', SUPABASE_URL: 'https://supabase.test.invalid', SUPABASE_SECRET_KEY: 'test-secret-key',
	DASHBOARD_SESSION_SECRET: SECRET, APP_BASE_URL: 'https://coverraccoon.com'
});

const VALID = 'AbCdEfGhIjKlMnOpQrStUv01';
const WALLET = '0x1111111111111111111111111111111111111111';
const iso = (ms) => new Date(ms).toISOString();
const row = (code, extra = {}) => ({ code, chat_id: '4242', nonce: 'n'.repeat(16), expires_at: iso(Date.now() + 300_000), used_at: null, ...extra });
const state = { rows: new Map(), counts: new Map(), deny: null, trace: [], limits: [] };
globalThis.fetch = async (url, options = {}) => {
	const u = new URL(String(url));
	if (u.host === 'supabase.test.invalid') {
		if (u.pathname === '/rest/v1/rpc/check_agent_rate_limit') {
			const { rate_key: key, max_requests: max, window_seconds: window } = JSON.parse(options.body);
			const scope = key.split(':')[0];
			const n = (state.counts.get(key) ?? 0) + 1;
			state.counts.set(key, n);
			const admitted = scope !== state.deny && n <= max;
			state.limits.push({ scope, key, max, window, admitted });
			state.trace.push(`limit ${scope}`);
			return Response.json(admitted);
		}
		if (u.pathname.includes('/rpc/')) return Response.json(true);
		if (u.pathname === '/rest/v1/pending_links') {
			state.trace.push('DB pending_links');
			const found = state.rows.get(u.searchParams.get('code')?.replace(/^eq\./, ''));
			return Response.json(found ? [found] : []);
		}
		return (options.method ?? 'GET') === 'GET' ? Response.json([]) : new Response(null, { status: 201 });
	}
	if (u.host === 'api.telegram.org' && u.pathname.endsWith('/getChat')) {
		state.trace.push('PROVIDER getChat');
		return Response.json({ ok: true, result: { id: 4242, type: 'private', first_name: 'Test', username: 'test_user' } });
	}
	throw new Error(`unexpected outbound request to ${u.host}`);
};

const { default: handler } = await import('../api/link.mjs');
const { LINK_CODE_GLOBAL_LIMIT } = await import('../src/linking.mjs');

function reset({ rows = [row(VALID)], deny = null } = {}) {
	Object.assign(state, { rows: new Map(rows.map((r) => [r.code, r])), counts: new Map(), deny, trace: [], limits: [] });
}
async function get({ code = VALID, wallet = null, ip = '198.51.100.7' } = {}) {
	const qs = new URLSearchParams({ ...(code !== null ? { code } : {}), ...(wallet ? { wallet } : {}) });
	const response = { statusCode: null, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
	const mark = state.trace.length;
	await handler({ method: 'GET', url: `/api/link?${qs}`, headers: { 'x-forwarded-for': ip } }, response);
	const trace = state.trace.slice(mark);
	const first = trace.indexOf('PROVIDER getChat');
	return {
		status: response.statusCode, body: response.body,
		getchat: trace.filter((t) => t === 'PROVIDER getChat').length,
		db: trace.filter((t) => t === 'DB pending_links').length,
		before: (first < 0 ? trace : trace.slice(0, first)).filter((t) => t.startsWith('limit ')).map((t) => t.slice(6)),
		order: trace.filter((t) => t.startsWith('limit wallet-link') || t === 'DB pending_links' || t === 'PROVIDER getChat')
	};
}
const ALL = ['wallet-link-read', 'wallet-link-read-code', 'DB pending_links', 'wallet-link-read-global', 'PROVIDER getChat'];
const asLimits = (xs) => xs.map((x) => x.replace(/^(wallet-link)/, 'limit $1'));

test('LINK-READ-BUDGET A IP denied: no DB read, no getChat', async () => {
	reset({ deny: 'wallet-link-read' });
	const r = await get();
	assert.equal(r.getchat, 0, `getChat ${r.getchat} with the IP limit denied`);
	assert.equal(r.status, 429);
	assert.equal(r.db, 0, 'pending link read with the IP limit denied');
	assert.deepEqual(r.before.filter((s) => s.startsWith('wallet-link')), ['wallet-link-read']);
});

test('LINK-READ-BUDGET B per-code denied: no DB read, no getChat', async () => {
	reset({ deny: 'wallet-link-read-code' });
	const r = await get();
	assert.equal(r.getchat, 0, `getChat ${r.getchat} with the per-code limit denied`);
	assert.equal(r.status, 429);
	assert.equal(r.db, 0, 'pending link read with the per-code limit denied');
	assert.deepEqual(r.before.filter((s) => s.startsWith('wallet-link')), ['wallet-link-read', 'wallet-link-read-code']);
});

test('LINK-READ-BUDGET C global denied: no getChat', async () => {
	for (const wallet of [null, WALLET]) {
		reset({ deny: 'wallet-link-read-global' });
		const r = await get({ wallet });
		assert.equal(r.getchat, 0, `getChat ${r.getchat} with the global limit denied (wallet ${wallet})`);
		assert.equal(r.status, 429, `wallet ${wallet}`);
		assert.deepEqual(r.before.filter((s) => s.startsWith('wallet-link')), ['wallet-link-read', 'wallet-link-read-code', 'wallet-link-read-global']);
	}
});

test('LINK-READ-BUDGET D admitted: response unchanged, one getChat after all three limits', async () => {
	reset();
	const plain = await get();
	assert.equal(plain.status, 200);
	assert.deepEqual(plain.body, { ok: true, telegram: plain.body.telegram });
	assert.ok(plain.body.telegram, 'target described');
	assert.equal(plain.getchat, 1);
	assert.deepEqual(plain.order, asLimits(ALL), `order: ${plain.order}`);
	const withWallet = await get({ wallet: WALLET });
	assert.equal(withWallet.status, 200);
	assert.equal(withWallet.getchat, 1);
	assert.match(withWallet.body.message, /wants you to sign in with your Ethereum account/);
	assert.ok(withWallet.body.message.includes(WALLET));
	assert.deepEqual(withWallet.order, asLimits(ALL), `order: ${withWallet.order}`);
	const sizes = Object.fromEntries(state.limits.map((l) => [l.scope, [l.max, l.window]]));
	assert.deepEqual(sizes['wallet-link-read'], [30, 600]);
	assert.deepEqual(sizes['wallet-link-read-code'], [10, 600]);
	assert.deepEqual(sizes['wallet-link-read-global'], [600, 600]);
	// Global = zwei Lesungen je Code, den der Bot im Fenster hoechstens ausgibt.
	assert.equal(sizes['wallet-link-read-global'][0], 2 * LINK_CODE_GLOBAL_LIMIT.max);
	assert.equal(sizes['wallet-link-read-global'][1], LINK_CODE_GLOBAL_LIMIT.windowSeconds);
	const source = readFileSync(new URL('../api/link.mjs', import.meta.url), 'utf8');
	assert.match(source, /const LINK_READ_CODE_LIMIT = Object\.freeze\(\{ max: 10, windowSeconds: 600 \}\);/);
	assert.match(source, /const LINK_READ_GLOBAL_LIMIT = Object\.freeze\(\{ max: 600, windowSeconds: 600 \}\);/);
});

test('LINK-READ-BUDGET keys: per-code key is the code, global key is constant, neither is shared with /api/link/verify', async () => {
	reset();
	await get();
	const hmac = (v) => createHmac('sha256', SECRET).update(v).digest('hex');
	const key = (scope) => state.limits.find((l) => l.scope === scope).key;
	assert.equal(key('wallet-link-read-code'), `wallet-link-read-code:${hmac(VALID)}`);
	assert.equal(key('wallet-link-read-global'), `wallet-link-read-global:${hmac('all')}`);
	assert.ok(!state.limits.some((l) => ['wallet-link-code', 'wallet-link-verify-global'].includes(l.scope)), 'reading must not consume the verify budgets');
});

test('LINK-READ-BUDGET E invalid code: no limiter beyond IP, no DB, no getChat', async () => {
	for (const code of [null, '', 'short', 'A'.repeat(25), 'AbCdEfGhIjKlMnOpQrStUv0!']) {
		reset();
		const r = await get({ code });
		assert.equal(r.status, 410, `code ${code}`);
		assert.equal(r.getchat, 0);
		assert.equal(r.db, 0);
		assert.deepEqual(r.before.filter((s) => s.startsWith('wallet-link')), ['wallet-link-read']);
	}
});

test('LINK-READ-BUDGET F expired, used, unknown or foreign link: no getChat, global not charged', async () => {
	const cases = {
		expired: row(VALID, { expires_at: iso(Date.now() - 1_000) }),
		used: row(VALID, { used_at: iso(Date.now() - 1_000) }),
		'non-private chat': row(VALID, { chat_id: '-100123' }),
		unknown: null
	};
	for (const [label, r0] of Object.entries(cases)) {
		reset({ rows: r0 ? [r0] : [] });
		const r = await get();
		assert.equal(r.status, 410, label);
		assert.equal(r.getchat, 0, `${label}: getChat`);
		assert.equal(r.db, 1, `${label}: one pending link read`);
		assert.ok(!r.before.includes('wallet-link-read-global'), `${label}: global charged`);
	}
});

test('LINK-READ-BUDGET invalid wallet: 400 without getChat, global not charged', async () => {
	reset();
	const r = await get({ wallet: '0xnot-an-address' });
	assert.equal(r.status, 400);
	assert.equal(r.getchat, 0);
	assert.ok(!r.before.includes('wallet-link-read-global'));
});

test('LINK-READ-BUDGET rotating IPs, one code: getChat bounded by the per-code budget', async () => {
	reset();
	const statuses = [];
	let getchat = 0;
	for (let i = 0; i < 20; i++) {
		const r = await get({ ip: `198.51.100.${i + 10}` });
		statuses.push(r.status);
		getchat += r.getchat;
	}
	assert.equal(getchat, 10, `rotating IPs: ${getchat} getChat calls for one code (bound 10)`);
	assert.deepEqual(statuses, [...Array(10).fill(200), ...Array(10).fill(429)]);
});

test('LINK-READ-BUDGET rotating IPs, many codes: getChat bounded by the global budget', async () => {
	const codes = Array.from({ length: 70 }, (_, i) => `Code${String(i).padStart(4, '0')}AAAAAAAAAAAAAAAA`);
	reset({ rows: codes.map((c) => row(c)) });
	let getchat = 0;
	let ip = 0;
	for (const code of codes) {
		for (let i = 0; i < 12; i++) getchat += (await get({ code, ip: `203.0.${Math.floor(ip / 250)}.${ip++ % 250}` })).getchat;
	}
	assert.equal(getchat, 600, `rotating IPs over 70 codes: ${getchat} getChat calls (global bound 600)`);
});

test('LINK-READ-BUDGET limiter failure fails closed before getChat', async () => {
	reset();
	const original = globalThis.fetch;
	globalThis.fetch = async (url, options) => (String(url).includes('/rpc/check_agent_rate_limit') && JSON.parse(options.body).rate_key.startsWith('wallet-link-read-global') ? new Response('boom', { status: 500 }) : original(url, options));
	let r;
	try { r = await get(); } catch { r = { getchat: state.trace.filter((t) => t === 'PROVIDER getChat').length, status: 'threw' }; } finally { globalThis.fetch = original; }
	assert.equal(r.getchat, 0);
	assert.notEqual(r.status, 200);
});
