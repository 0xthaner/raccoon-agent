/*
	AUDIT-2026-10-12 F1: `pending_links` traegt vier Arten von Zeilen - echte
	Telegram-Verknuepfungen (chat_id = private Chat-ID), Dashboard-Zugangscodes
	(`dashboard:<code>`), gemerkte getrennte Wallets (`unlinked:...`) und
	Widerrufsmarken (`revoked:<wallet>`, Code `revoked_wallet_<wallet>`, also
	VORHERSAGBAR, zehn Jahre gueltig, used_at leer).

	/api/link und /api/link/verify schlugen den Code nach, ohne die Art zu
	pruefen. Damit verriet `GET /api/link?code=revoked_wallet_<wallet>` ohne
	Anmeldung, ob und wann sich eine beliebige Wallet abgemeldet hatte (die
	Widerrufszeit stand als Nonce im SIWE-Text), und ein Angreifer konnte mit
	der eigenen Wallet eine Widerrufsmarke "verbrauchen" und dabei dauerhafte
	monitored_wallets-/wallet_links-Zeilen an einer Schein-Chat-ID anlegen.

	Jetzt: nur das exakte Codeformat aus newLinkRequest erreicht die Datenbank,
	und nur eine Zeile mit privater Chat-ID gilt als Verknuepfung.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { telegramExpectation, telegramSiweMessage, verifyExpectedSiweSignature } from '../src/siwe-auth.mjs';
import * as linking from '../src/linking.mjs';
import * as requestQuery from '../src/request-query.mjs';

const urlOf = (path, query = {}) => { const qs = new URLSearchParams(query).toString(); return qs ? `${path}?${qs}` : path; };

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
function loadHandler(source, deps) {
	const body = source.replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
	return new Function(...Object.keys(deps), `${body}\nreturn handler;`)(...Object.values(deps));
}
function response() {
	return { headers: {}, status(n) { this.code = n; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(body) { this.body = body; return this; } };
}

const VICTIM = '0x1111111111111111111111111111111111111111';
const LINK_CODE = 'Abcdefghijklmnopqrstuv_-';
const now = Date.now();
const ROWS = {
	[`revoked_wallet_${VICTIM}`]: { code: `revoked_wallet_${VICTIM}`, chat_id: `revoked:${VICTIM}`, nonce: '1760000000000', expires_at: now + 3650 * 86_400_000, used_at: null },
	// Dieselben Arten mit einem Code im gueltigen Format: die Zeilenart allein muss reichen.
	DashboardAccessCodeXYZ12: { chat_id: 'dashboard:DashboardAccessCodeXYZ12', nonce: VICTIM, expires_at: now + 60_000, used_at: null },
	RevokedMarkerShapedCode1: { chat_id: `revoked:${VICTIM}`, nonce: '1760000000000', expires_at: now + 60_000, used_at: null },
	UnlinkedShapedCode000001: { chat_id: `unlinked:123:${VICTIM}`, nonce: VICTIM, expires_at: now + 60_000, used_at: null },
	NegativeChatIdCode000001: { chat_id: '-100123', nonce: 'ab'.repeat(16), expires_at: now + 60_000, used_at: null },
	[LINK_CODE]: { chat_id: '123456789', nonce: 'ab'.repeat(16), expires_at: now + 599_000, used_at: null }
};

function linkDeps(lookups) {
	return {
		isAddress: (v) => /^0x[0-9a-fA-F]{40}$/.test(v),
		getPendingLink: async (code) => { lookups.push(code); return ROWS[code] ?? null; },
		signingMessage: (p) => `SIWE nonce=${p.nonce}`,
		enforceRateLimit: async () => true, enforceRateLimitFor: async () => true,
		ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {},
		isTelegramLinkCode: linking.isTelegramLinkCode, isTelegramLinkRow: linking.isTelegramLinkRow,
		telegramTarget: async (chatId) => linking.telegramTargetOf({ id: Number(chatId), type: 'private', username: 'raccoon_user' }, chatId),
		queryParams: requestQuery.queryParams, singleQueryValue: requestQuery.singleQueryValue,
		process: { env: {} }, fetch: async () => { throw new Error('no network'); }
	};
}

test('F1 GET /api/link: a predictable revocation code is no oracle for another wallet', async () => {
	const lookups = [];
	const handler = loadHandler(read('api/link.mjs'), linkDeps(lookups));
	for (const query of [{ code: `revoked_wallet_${VICTIM}` }, { code: `revoked_wallet_${VICTIM}`, wallet: '0x2222222222222222222222222222222222222222' }]) {
		const res = response();
		await handler({ method: 'GET', url: urlOf('/api/link', query), headers: {} }, res);
		assert.equal(res.code, 410, JSON.stringify(query));
		assert.doesNotMatch(JSON.stringify(res.body), /1760000000000|telegram|message/);
	}
	assert.deepEqual(lookups, [], 'ein fremdes Codeformat erreicht die Datenbank gar nicht');
});

test('F1 GET /api/link: only private-chat link rows are links, whatever the code looks like', async () => {
	const handler = loadHandler(read('api/link.mjs'), linkDeps([]));
	for (const code of ['DashboardAccessCodeXYZ12', 'RevokedMarkerShapedCode1', 'UnlinkedShapedCode000001', 'NegativeChatIdCode000001']) {
		const res = response();
		await handler({ method: 'GET', url: urlOf('/api/link', { code, wallet: '0x2222222222222222222222222222222222222222' }), headers: {} }, res);
		assert.equal(res.code, 410, code);
		assert.equal(res.body.message, undefined, code);
	}
	const ok = response();
	await handler({ method: 'GET', url: urlOf('/api/link', { code: LINK_CODE, wallet: '0x2222222222222222222222222222222222222222' }), headers: {} }, ok);
	assert.equal(ok.code, 200);
	assert.match(ok.body.message, /nonce=abab/);
});

async function verifyAttempt(code, rows = ROWS) {
	const previous = process.env.APP_BASE_URL;
	process.env.APP_BASE_URL = 'https://coverraccoon.com';
	try {
		// Oeffentliche, unbefuellte Offline-Testadresse; nie von Anwendungscode importiert.
		const attacker = privateKeyToAccount(`0x${'02'.repeat(32)}`);
		const row = rows[code];
		const params = { wallet: attacker.address, nonce: row?.nonce ?? 'ab'.repeat(16), expiresAt: row?.expires_at ?? now, issuedAt: (row?.expires_at ?? now) - 600_000, code, target: '@raccoon_user' };
		let signature = '0x';
		try { signature = await attacker.signMessage({ message: telegramSiweMessage(params) }); } catch { /* Nonce ungeeignet: Signatur bleibt leer */ }
		const consumed = [];
		const handler = loadHandler(read('api/link/verify.mjs'), {
			ANMELDUNG_PAUSIERT: false, pauseAntwort: () => {}, requireSameOrigin: () => true, requireJson: () => true,
			enforceRateLimit: async () => true, enforceRateLimitFor: async () => true,
			getPendingLink: async (c) => rows[c] ?? null,
			isTelegramLinkCode: linking.isTelegramLinkCode, isTelegramLinkRow: linking.isTelegramLinkRow,
			telegramTarget: async (chatId) => linking.telegramTargetOf({ id: Number(chatId), type: 'private', username: 'raccoon_user' }, chatId),
			isAddress: (v) => /^0x[0-9a-fA-F]{40}$/.test(v),
			linkSiweExpectation: (p) => telegramExpectation({ ...p, issuedAt: p.expiresAt - 600_000 }),
			signingMessage: (p) => telegramSiweMessage({ ...p, issuedAt: p.expiresAt - 600_000 }),
			verifyWalletSiweSignature: verifyExpectedSiweSignature,
			consumePendingLink: async (c) => { consumed.push(c); return { status: 'linked', chatId: rows[c].chat_id }; },
			recordSecurityEvent: async () => {}, SECURITY_EVENT: {}, securityFingerprint: () => 'fp',
			getLanguage: async () => 'en', newDashboardAccess: async () => null,
			process: { env: { TELEGRAM_BOT_TOKEN: 'offline-placeholder' } }, fetch: async () => ({ ok: true })
		});
		const res = response();
		await handler({ method: 'POST', body: { code, wallet: attacker.address, signature }, headers: {} }, res);
		return { res, consumed };
	} finally {
		if (previous === undefined) delete process.env.APP_BASE_URL; else process.env.APP_BASE_URL = previous;
	}
}

test('F1 POST /api/link/verify: an own-wallet signature never consumes a revocation, access or unlinked row', async () => {
	for (const code of [`revoked_wallet_${VICTIM}`, 'DashboardAccessCodeXYZ12', 'RevokedMarkerShapedCode1', 'UnlinkedShapedCode000001', 'NegativeChatIdCode000001']) {
		const { res, consumed } = await verifyAttempt(code);
		assert.equal(res.code, 410, code);
		assert.deepEqual(consumed, [], code);
	}
	const { res, consumed } = await verifyAttempt(LINK_CODE);
	assert.equal(res.code, 200, 'eine echte Verknuepfung funktioniert weiter');
	assert.deepEqual(consumed, [LINK_CODE]);
});

test('F1 helpers: exact newLinkRequest code format and private-chat rows only', () => {
	assert.equal(linking.isTelegramLinkCode(LINK_CODE), true);
	for (const bad of [`revoked_wallet_${VICTIM}`, 'unlinked_' + 'a'.repeat(24), 'a'.repeat(23), 'a'.repeat(25), 'a'.repeat(32), 'Abcdefghijklmnopqrstuv+/', '', null, undefined, 42, ['a'.repeat(24)]]) {
		assert.equal(linking.isTelegramLinkCode(bad), false, String(bad));
	}
	assert.equal(linking.isTelegramLinkRow({ chat_id: '123456789' }), true);
	for (const chat of [`revoked:${VICTIM}`, 'dashboard:x', 'unlinked:1:0x', '-100123', '0', '0123', '', '1'.repeat(21), 123, null]) {
		assert.equal(linking.isTelegramLinkRow({ chat_id: chat }), false, String(chat));
	}
	assert.equal(linking.isTelegramLinkRow(null), false);
});

test('F1 every link entry point uses both guards before signing text or consumption', () => {
	for (const file of ['api/link.mjs', 'api/link/verify.mjs', 'src/web.mjs']) {
		const source = read(file);
		const codeCheck = source.indexOf('isTelegramLinkCode(code)');
		const rowCheck = source.indexOf('isTelegramLinkRow(pending)');
		assert.ok(codeCheck > 0 && codeCheck < source.indexOf('getPendingLink(code)'), file);
		assert.ok(rowCheck > 0 && rowCheck < source.indexOf('signingMessage('), file);
		if (source.includes('consumePendingLink(')) {
			// Im Verbrauchspfad selbst: zwischen dem LETZTEN Nachschlagen und dem Verbrauch.
			const lookup = source.lastIndexOf('getPendingLink(code)');
			const consume = source.indexOf('consumePendingLink(');
			const between = source.slice(source.lastIndexOf('\n', lookup), consume);
			assert.match(between, /isTelegramLinkCode\(code\) \? await getPendingLink\(code\)|getPendingLink\(code\)/, file);
			assert.match(between, /!isTelegramLinkRow\(pending\)/, `${file}: Zeilenart im Verbrauchspfad`);
		}
		// Jede Nachschlage-Stelle hat beide Schranken (web.mjs hat zwei Routen).
		const lookups = source.split('getPendingLink(code)').length - 1;
		assert.equal(source.split('isTelegramLinkCode(code)').length - 1, lookups, `${file}: Formatpruefung je Nachschlagen`);
		assert.equal(source.split('isTelegramLinkRow(pending)').length - 1, lookups, `${file}: Zeilenart je Nachschlagen`);
	}
	// Der Code entsteht genau so, wie isTelegramLinkCode ihn erwartet.
	// Restaudit M1: vor dem Code stehen jetzt die Rate-Limits; das Format ist unveraendert.
	const linking = read('src/linking.mjs');
	const body = linking.slice(linking.indexOf('export async function newLinkRequest('), linking.indexOf('\n}\n', linking.indexOf('export async function newLinkRequest(')));
	assert.match(body, /\n\tconst code = randomBytes\(18\)\.toString\('base64url'\);/);
});

test('F1 the revocation check itself never depended on used_at (consumed marker stays effective)', () => {
	const db = read('src/db.mjs');
	const fn = db.slice(db.indexOf('export async function isDashboardSessionRevoked'), db.indexOf('export async function getLanguage'));
	assert.match(fn, /\.eq\('chat_id', `revoked:\$\{wallet\.toLowerCase\(\)\}`\)/);
	assert.doesNotMatch(fn, /used_at|expires_at/);
});
