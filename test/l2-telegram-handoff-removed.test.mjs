/*
	Restaudit L2, 16.10.2026 - der unsignierte Telegram-Handoff ist entfernt.

	`newTelegramHandoff` / `createTelegramHandoff` / `consumeTelegramHandoff` und
	die Datenbankfunktion `consume_telegram_handoff` banden eine Wallet ohne
	Wallet-Signatur an einen Chat. Seit HARD-004 rief sie niemand mehr auf; jetzt
	sind Code, Funktion und Tabelle weg (Migration 20261016120000).

	Der einzige Bindungsweg: pending_links-Code -> Wallet-Signatur -> Pruefung ->
	consume_wallet_link_v2 -> monitored_wallets. Dieser Test beweist, dass er
	weiter die Signatur verlangt und dass kein zweiter Weg zurueckkommt.

	Die Postgres-Seite (Funktion und Tabelle nach der letzten Migration
	verschwunden, Rechte) prueft m1-wallet-limit-db.test.mjs gegen echten Postgres.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';

process.env.SUPABASE_URL ??= 'https://offline.invalid';
process.env.SUPABASE_SECRET_KEY ??= 'l2-handoff-test-not-a-key';
process.env.APP_BASE_URL = 'https://coverraccoon.com';

const linking = await import('../src/linking.mjs');
const db = await import('../src/db.mjs');
const { telegramExpectation, telegramSiweMessage, verifyExpectedSiweSignature } = await import('../src/siwe-auth.mjs');

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const filesIn = (dir, ext = /\.(mjs|js)$/) => readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: true })
	.filter((f) => ext.test(f)).map((f) => `${dir}/${f}`.split('\\').join('/'));
// Was Bot, API und Frontend ausliefern. scripts/ sind Betreiberwerkzeuge mit eigenem
// Schluessel (verify-agent.mjs legt dort bewusst eine Test-Chat-Zeile an), kein Pfad
// fuer Nutzer - sie zaehlen nur bei der Suche nach den toten Namen mit.
const PRODUCTION = [...filesIn('src'), ...filesIn('api'), ...filesIn('web/src')];
const RUNTIME = [...PRODUCTION, ...filesIn('scripts')];
const MIGRATIONS = filesIn('supabase/migrations', /\.sql$/).sort();

/* ------------------------------------------------- A/B: toter Pfad entfernt -- */

test('L2-A/B: no module exports a handoff helper', () => {
	for (const name of ['newTelegramHandoff', 'createTelegramHandoff', 'consumeTelegramHandoff']) {
		assert.equal(name in linking, false, `linking.${name}`);
		assert.equal(name in db, false, `db.${name}`);
	}
});

test('L2-A/B: no runtime file names the handoff helpers, the old RPC or its table', () => {
	const dead = /\b(newTelegramHandoff|createTelegramHandoff|consumeTelegramHandoff|consume_telegram_handoff|telegram_handoffs)\b/;
	assert.ok(RUNTIME.length > 20, 'Laufzeitdateien gefunden');
	for (const file of RUNTIME) assert.doesNotMatch(read(file), dead, file);
});

/* ------------------------------- C/E: Bindung nur nach gepruefter Signatur -- */

function loadHandler(source, deps) {
	const body = source.replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
	return new Function(...Object.keys(deps), `${body}\nreturn handler;`)(...Object.values(deps));
}
function response() {
	return { headers: {}, status(n) { this.code = n; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(body) { this.body = body; return this; } };
}

const LINK_CODE = 'L2linkCodeAbcdefghijk_-0';
const OTHER_CODE = 'L2otherCodeAbcdefghij_-0';
const expiresAt = Date.now() + 599_000;
const ROWS = {
	[LINK_CODE]: { chat_id: '424242', nonce: 'cd'.repeat(16), expires_at: expiresAt, used_at: null },
	[OTHER_CODE]: { chat_id: '515151', nonce: 'ef'.repeat(16), expires_at: expiresAt, used_at: null }
};
// Oeffentliche, unbefuellte Offline-Testschluessel; nie von Anwendungscode importiert.
const owner = privateKeyToAccount(`0x${'03'.repeat(32)}`);
const stranger = privateKeyToAccount(`0x${'04'.repeat(32)}`);
const messageFor = (code, wallet) => telegramSiweMessage({ wallet, nonce: ROWS[code].nonce, expiresAt, issuedAt: expiresAt - 600_000, code, target: '@raccoon_user' });

async function verify(body, { outcome = (code) => ({ status: 'linked', chatId: ROWS[code].chat_id }) } = {}) {
	const consumed = [];
	const notified = [];
	const handler = loadHandler(read('api/link/verify.mjs'), {
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}, requireSameOrigin: () => true, requireJson: () => true,
		enforceRateLimit: async () => true, enforceRateLimitFor: async () => true,
		getPendingLink: async (c) => ROWS[c] ?? null,
		isTelegramLinkCode: linking.isTelegramLinkCode, isTelegramLinkRow: linking.isTelegramLinkRow,
		telegramTarget: async (chatId) => linking.telegramTargetOf({ id: Number(chatId), type: 'private', username: 'raccoon_user' }, chatId),
		isAddress: (v) => /^0x[0-9a-fA-F]{40}$/.test(v),
		linkSiweExpectation: (p) => telegramExpectation({ ...p, issuedAt: p.expiresAt - 600_000 }),
		signingMessage: (p) => telegramSiweMessage({ ...p, issuedAt: p.expiresAt - 600_000 }),
		verifyWalletSiweSignature: verifyExpectedSiweSignature,
		consumePendingLink: async (c, w) => { consumed.push([c, w]); return outcome(c); },
		MAX_WALLETS_PER_CHAT: db.MAX_WALLETS_PER_CHAT,
		recordSecurityEvent: async () => {}, SECURITY_EVENT: {}, securityFingerprint: () => 'fp',
		getLanguage: async () => 'en', newDashboardAccess: async () => null,
		process: { env: { TELEGRAM_BOT_TOKEN: 'offline-placeholder' } },
		fetch: async (url, init) => { notified.push(JSON.parse(init.body).text); return { ok: true }; }
	});
	const res = response();
	await handler({ method: 'POST', body, headers: {} }, res);
	return { res, consumed, notified };
}

test('L2-C/E: POST /api/link/verify binds nothing without a valid signature of exactly this wallet, code and chat', async () => {
	const own = await owner.signMessage({ message: messageFor(LINK_CODE, owner.address) });
	const cases = {
		'no signature': { code: LINK_CODE, wallet: owner.address },
		'empty signature': { code: LINK_CODE, wallet: owner.address, signature: '0x' },
		'garbage signature': { code: LINK_CODE, wallet: owner.address, signature: `0x${'ab'.repeat(65)}` },
		'someone else signs for the wallet': { code: LINK_CODE, wallet: owner.address, signature: await stranger.signMessage({ message: messageFor(LINK_CODE, owner.address) }) },
		'own signature claimed for another wallet': { code: LINK_CODE, wallet: stranger.address, signature: own },
		'signature for another link code / chat': { code: LINK_CODE, wallet: owner.address, signature: await owner.signMessage({ message: messageFor(OTHER_CODE, owner.address) }) },
		'signature over a free-form text': { code: LINK_CODE, wallet: owner.address, signature: await owner.signMessage({ message: `link ${owner.address} to 424242` }) }
	};
	for (const [label, body] of Object.entries(cases)) {
		const { res, consumed } = await verify(body);
		assert.ok([400, 401].includes(res.code), `${label}: ${res.code}`);
		assert.deepEqual(consumed, [], `${label}: nichts verbraucht, nichts gebunden`);
	}
	const { res, consumed } = await verify({ code: LINK_CODE, wallet: owner.address, signature: own });
	assert.equal(res.code, 200, 'die gueltige Signatur bindet weiterhin');
	assert.deepEqual(consumed, [[LINK_CODE, owner.address]]);
});

test('L2-C/E: the bot\'s local link server (src/web.mjs) also binds nothing without a valid signature', async () => {
	const { createServer } = await import('node:http');
	const path = await import('node:path');
	const consumed = [];
	const source = read('src/web.mjs').replace(/^import [^;]*;\n/gm, '').replace('export function startWebServer', 'function startWebServer');
	const startWebServer = new Function('createServer', 'readFile', 'extname', 'join', 'normalize', 'isAddress', 'consumePendingLink', 'getPendingLink',
		'isTelegramLinkCode', 'isTelegramLinkRow', 'linkSiweExpectation', 'signingMessage', 'telegramTarget', 'verifyWalletSiweSignature', 'console',
		`${source}\nreturn startWebServer;`)(
		createServer, async () => { throw new Error('no files'); }, path.extname, path.join, path.normalize,
		(v) => /^0x[0-9a-fA-F]{40}$/.test(v),
		async (c, w) => { consumed.push([c, w]); return { status: 'linked', chatId: ROWS[c].chat_id }; },
		async (c) => ROWS[c] ?? null,
		linking.isTelegramLinkCode, linking.isTelegramLinkRow,
		(p) => telegramExpectation({ ...p, issuedAt: p.expiresAt - 600_000 }),
		(p) => telegramSiweMessage({ ...p, issuedAt: p.expiresAt - 600_000 }),
		async (chatId) => linking.telegramTargetOf({ id: Number(chatId), type: 'private', username: 'raccoon_user' }, chatId),
		verifyExpectedSiweSignature, { log: () => {} });
	const server = startWebServer({ port: 0, onLinked: async () => {} });
	await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
	const post = async (body) => (await fetch(`http://127.0.0.1:${server.address().port}/api/link/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status;
	try {
		const own = await owner.signMessage({ message: messageFor(LINK_CODE, owner.address) });
		for (const body of [
			{ code: LINK_CODE, wallet: owner.address },
			{ code: LINK_CODE, wallet: owner.address, signature: '0x' },
			{ code: LINK_CODE, wallet: owner.address, signature: await stranger.signMessage({ message: messageFor(LINK_CODE, owner.address) }) },
			{ code: LINK_CODE, wallet: stranger.address, signature: own },
			{ code: LINK_CODE, wallet: owner.address, signature: await owner.signMessage({ message: messageFor(OTHER_CODE, owner.address) }) }
		]) {
			assert.ok([400, 401].includes(await post(body)));
		}
		assert.deepEqual(consumed, [], 'ohne gueltige Signatur nichts verbraucht');
		assert.equal(await post({ code: LINK_CODE, wallet: owner.address, signature: own }), 200);
		assert.deepEqual(consumed, [[LINK_CODE, owner.address]]);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});

test('L2-F: at the wallet limit the endpoint reports WALLET_LIMIT and announces no link', async () => {
	const signature = await owner.signMessage({ message: messageFor(LINK_CODE, owner.address) });
	const { res, notified } = await verify({ code: LINK_CODE, wallet: owner.address, signature }, { outcome: (code) => ({ status: 'wallet_limit', chatId: ROWS[code].chat_id }) });
	assert.equal(res.code, 409);
	assert.equal(res.body.code, 'WALLET_LIMIT');
	assert.equal(notified.length, 1);
	assert.match(notified[0], new RegExp(`${db.MAX_WALLETS_PER_CHAT} wallets, the maximum`));
	assert.equal(db.MAX_WALLETS_PER_CHAT, 10);
});

test('L2-D: the binding RPC is consume_wallet_link_v2, and it is the only binding RPC runtime code calls', async () => {
	const calls = [];
	const client = {
		rpc: async (name, args) => { calls.push([name, args]); return { data: { status: 'invalid' }, error: null }; },
		from: () => { throw new Error('nothing else for an invalid code'); }
	};
	assert.deepEqual(await db.consumePendingLink('code', '0xABC', { client }), { status: 'invalid', chatId: null });
	assert.deepEqual(calls, [['consume_wallet_link_v2', { link_code: 'code', linked_wallet: '0xabc' }]]);
	// Jede RPC, die Laufzeitcode ueberhaupt aufruft. Bindende Funktionen ausser v2 duerfen nicht dabei sein.
	const called = new Set(RUNTIME.flatMap((file) => [...read(file).matchAll(/\.rpc\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1])));
	assert.deepEqual([...called].sort(), ['alert_subscriptions_page', 'check_agent_rate_limit', 'consume_wallet_link_v2', 'revoke_dashboard_sessions_atomic']);
});

test('L2-E: runtime code never inserts a wallet-chat binding itself', () => {
	for (const file of PRODUCTION) {
		const source = read(file);
		assert.doesNotMatch(source, /from\('monitored_wallets'\)\s*\.(insert|upsert)\(/, `${file}: monitored_wallets`);
		assert.doesNotMatch(source, /from\('wallet_links'\)\s*\.insert\(/, `${file}: wallet_links`);
	}
	// consumePendingLink nur aus den beiden Verify-Endpunkten; dort erst nach der Signaturpruefung.
	const callers = PRODUCTION.filter((file) => /consumePendingLink\(/.test(read(file)) && file !== 'src/db.mjs');
	assert.deepEqual(callers.sort(), ['api/link/verify.mjs', 'src/web.mjs']);
	for (const file of callers) {
		const source = read(file);
		const check = source.search(/verifyWalletSiweSignature\(\{ message, signature, expected \}\)/);
		assert.ok(check > 0 && check < source.indexOf('consumePendingLink(code, wallet)'), `${file}: Signatur vor Verbrauch`);
	}
});

/* ------------------------------------------------- G: Link-Code-Grenzen -- */

test('L2-G: link-code limits are unchanged (10 per chat, 300 global, per 10 minutes)', () => {
	assert.deepEqual({ ...linking.LINK_CODE_CHAT_LIMIT }, { max: 10, windowSeconds: 600 });
	assert.deepEqual({ ...linking.LINK_CODE_GLOBAL_LIMIT }, { max: 300, windowSeconds: 600 });
	assert.equal(linking.LINK_LIFETIME_MS, 10 * 60 * 1000);
});

/* ------------------------------------------- H/I: Schema-Ziel der Migrationen -- */

const statements = (sql) => sql.replace(/--[^\n]*/g, '').split(/;\s*(?:\n|$)/).map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
const history = MIGRATIONS.flatMap((file) => statements(read(file)).map((sql) => ({ file, sql })));

test('L2-H: after the latest migration consume_telegram_handoff and telegram_handoffs no longer exist', () => {
	const last = (re) => history.filter(({ sql }) => re.test(sql)).at(-1);
	assert.equal(last(/\bconsume_telegram_handoff\b/).sql, 'drop function public.consume_telegram_handoff(text, text)');
	assert.equal(last(/\btelegram_handoffs\b/).sql, 'drop table public.telegram_handoffs');
	const drop = statements(read('supabase/migrations/20261016120000_l2_drop_telegram_handoff.sql')).join('\n');
	assert.doesNotMatch(drop, /\bcascade\b/i, 'kein CASCADE');
	assert.doesNotMatch(drop, /\bgrant\b/i, 'keine neuen Rechte');
	assert.doesNotMatch(drop, /consume_wallet_link|monitored_wallets|wallet_links|pending_links/, 'aktiver Pfad unberuehrt');
	assert.equal(MIGRATIONS.at(-1), 'supabase/migrations/20261016120000_l2_drop_telegram_handoff.sql');
});

test('L2-I: anon and authenticated get no grant anywhere, and every binding function is closed to them', () => {
	for (const { file, sql } of history) {
		if (/^grant\b/i.test(sql)) assert.doesNotMatch(sql, /\bto\b.*\b(anon|authenticated|public)\b/i, `${file}: ${sql}`);
		assert.doesNotMatch(sql, /^create policy/i, `${file}: ${sql}`);
	}
	for (const fn of ['consume_wallet_link_v2', 'consume_wallet_link', 'link_wallet_to_chat_limited', 'lock_chat_wallets']) {
		const created = history.findLastIndex(({ sql }) => new RegExp(`^create (or replace )?function public\\.${fn}\\(`).test(sql));
		assert.ok(created >= 0, fn);
		const revoked = history.findIndex(({ sql }, i) => i > created && new RegExp(`^revoke all on function public\\.${fn}\\(.*\\) from public, anon, authenticated`).test(sql));
		assert.ok(revoked > created, `${fn}: nach der letzten Definition fuer public, anon, authenticated gesperrt`);
	}
});
