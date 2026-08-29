/**
 * AGENT-SEC-A1: Berechtigungsgrenzen des Dashboards.
 *
 * Deterministisch und offline: keine Datenbank, kein Netzwerk, kein Telegram.
 * Es werden weder Secrets noch Nonces, Signaturen oder Sessiontokens
 * ausgegeben; geprueft wird immer nur ihre Form oder ihre Wirkung.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	CLEAR_SESSION_COOKIES,
	LEGACY_SESSION_COOKIE,
	MIN_DASHBOARD_SECRET_LENGTH,
	SESSION_COOKIE,
	SESSION_COOKIE_OPTIONS,
	createDashboardChallenge,
	createDashboardSession,
	dashboardSecretConfigured,
	readSessionCookie,
	resolveLogout,
	sessionCookieHeader,
	verifyDashboardSession,
	verifyDashboardToken
} from '../src/dashboard-auth.mjs';

/** Frei erfundene Testwerte, lang genug fuer die neue Mindestlaenge. */
const TEST_DASHBOARD_SECRET = 'test-dashboard-secret-0123456789abcdef';
const TEST_TELEGRAM_SECRET = 'test-telegram-webhook-secret-0123456789';
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';

function withEnv(values, run) {
	const previous = {};
	for (const [key, value] of Object.entries(values)) {
		previous[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/**
 * AGENT-SEC-A3: die Challengeerzeugung braucht zusaetzlich die trusted Origin,
 * weil die Nachricht seither Domain und URI traegt. Fest auf die
 * Productionorigin, damit die Tests nicht von der lokalen `.env` abhaengen.
 */
function withDashboardSecret(run) {
	return withEnv({
		DASHBOARD_SESSION_SECRET: TEST_DASHBOARD_SECRET,
		TELEGRAM_WEBHOOK_SECRET: TEST_TELEGRAM_SECRET,
		APP_BASE_URL: 'https://agent.coverraccoon.com'
	}, run);
}

function requestWithCookie(header) {
	return { headers: header === null ? {} : { cookie: header } };
}

function source(relative) {
	return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

/* ------------------------------------------------------------------------- *
 * Teil A, Telegram erzeugt keine Dashboard-Session
 * ------------------------------------------------------------------------- */

test('A3 die Telegram-Verifikation importiert keine Sessionerzeugung', () => {
	const code = source('../api/link/verify.mjs');
	assert.equal(/import[^;]*createDashboardSession/.test(code), false);
	assert.equal(/import[^;]*sessionCookieHeader/.test(code), false);
	assert.equal(code.includes("from '../../src/dashboard-auth.mjs'"), false);
});

test('A4 die Telegram-Verifikation ruft keine Sessionerzeugung auf', () => {
	const code = source('../api/link/verify.mjs');
	assert.equal(code.includes('createDashboardSession('), false);
	assert.equal(code.includes('sessionCookieHeader('), false);
});

test('A2 die Telegram-Verifikation setzt ueberhaupt kein Cookie', () => {
	const code = source('../api/link/verify.mjs');
	assert.equal(/set-cookie/i.test(code), false);
	assert.equal(code.includes(SESSION_COOKIE), false);
});

test('A5 ein Sessioncookie entsteht nur an der einen dafuer zustaendigen Stelle', () => {
	// Verhalten: `sessionCookieHeader` liefert ein Cookie, das als Session gilt.
	const header = withDashboardSecret(() => sessionCookieHeader(WALLET));
	const token = decodeURIComponent(header.slice(`${SESSION_COOKIE}=`.length, header.indexOf(';')));
	assert.equal(withDashboardSecret(() => verifyDashboardSession(token))?.wallet, WALLET.toLowerCase());

	// Grenze: `createDashboardSession` wird ausserhalb seiner Definition nur an
	// dieser einen Stelle aufgerufen, und kein Endpunkt ausser dem Dashboard
	// bezieht sie. Wer sie nicht bezieht, kann keine Dashboardberechtigung geben.
	const auth = source('../src/dashboard-auth.mjs');
	assert.equal((auth.match(/createDashboardSession\(/g) ?? []).length, 2);
	assert.equal(source('../api/link/verify.mjs').includes('createDashboardSession'), false);
	assert.equal(source('../api/dashboard.mjs').includes('createDashboardSession'), false);
});

/* ------------------------------------------------------------------------- *
 * Teil B, Logout widerruft serverseitig
 * ------------------------------------------------------------------------- */

test('B7 und B8 ein gueltiger Logout widerruft genau einmal die richtige Wallet', async () => {
	const calls = [];
	const audits = [];
	const result = await resolveLogout({
		session: { wallet: WALLET },
		revoke: async (wallet) => { calls.push(wallet); },
		audit: async (wallet) => { audits.push(wallet); }
	});
	assert.deepEqual(calls, [WALLET]);
	assert.deepEqual(audits, [WALLET]);
	assert.equal(result.status, 200);
	assert.equal(result.body.ok, true);
	assert.equal(result.revoked, true);
});

test('B12 ein Logout ohne Session bleibt idempotent und widerruft nichts', async () => {
	for (const session of [null, undefined, {}, { wallet: '' }]) {
		const calls = [];
		const result = await resolveLogout({ session, revoke: async (w) => { calls.push(w); }, audit: async () => {} });
		assert.equal(calls.length, 0);
		assert.equal(result.status, 200);
		assert.equal(result.body.ok, true);
		assert.equal(result.revoked, false);
	}
});

test('B13 ein ungueltiges Cookie fuehrt zu keiner Walletinvalidierung', async () => {
	const calls = [];
	const session = withDashboardSecret(() =>
		verifyDashboardSession(readSessionCookie(requestWithCookie(`${SESSION_COOKIE}=nicht.gueltig`)))
	);
	assert.equal(session, null);
	await resolveLogout({ session, revoke: async (w) => { calls.push(w); }, audit: async () => {} });
	assert.equal(calls.length, 0);
});

test('B14 und B17 ein Widerrufsfehler meldet keinen Erfolg und schreibt kein Audit', async () => {
	const audits = [];
	const result = await resolveLogout({
		session: { wallet: WALLET },
		revoke: async () => { throw new Error('relation "pending_links" does not exist'); },
		audit: async (wallet) => { audits.push(wallet); }
	});
	assert.equal(result.status, 503);
	assert.equal(result.body.ok, false);
	assert.equal(result.revoked, false);
	assert.equal(audits.length, 0);
});

test('B15 die Fehlermeldung traegt keine interne Ursache nach aussen', async () => {
	const result = await resolveLogout({
		session: { wallet: WALLET },
		revoke: async () => { throw new Error('relation "pending_links" does not exist at 0x/db.mjs:198'); },
		audit: async () => {}
	});
	const serialised = JSON.stringify(result.body);
	for (const leak of ['pending_links', 'relation', 'db.mjs', 'Error', 'stack', '198']) {
		assert.equal(serialised.includes(leak), false, leak);
	}
});

test('B9 und B10 der Logout loescht beide Cookienamen', () => {
	assert.equal(CLEAR_SESSION_COOKIES.length, 2);
	assert.ok(CLEAR_SESSION_COOKIES.some((item) => item.startsWith(`${SESSION_COOKIE}=;`)));
	assert.ok(CLEAR_SESSION_COOKIES.some((item) => item.startsWith(`${LEGACY_SESSION_COOKIE}=;`)));
	for (const item of CLEAR_SESSION_COOKIES) {
		assert.ok(item.includes('Max-Age=0'));
		assert.ok(item.includes('HttpOnly'));
		assert.ok(item.includes('Secure'));
		assert.ok(item.includes('SameSite=Strict'));
		assert.ok(item.includes('Path=/'));
		assert.equal(/Domain=/i.test(item), false);
	}
});

test('B16 die Telegram-Trennung widerruft keine Dashboard-Session', () => {
	// Der Zweig fuer `?telegram=1` endet mit seinem eigenen `return`, bevor der
	// Logoutblock beginnt. Er beruehrt `revokeDashboardSessions` nicht.
	const code = source('../api/dashboard.mjs');
	const branch = code.slice(code.indexOf("request.query.telegram === '1'"), code.indexOf('AGENT-SEC-A1'));
	assert.ok(branch.includes('unlinkWalletByWallet'));
	assert.equal(branch.includes('revokeDashboardSessions'), false);
	assert.equal(branch.includes('resolveLogout'), false);
});

/* ------------------------------------------------------------------------- *
 * Teil C, Secret-Trennung
 * ------------------------------------------------------------------------- */

test('C18 und C22 nur das Dashboard-Secret signiert Dashboardtokens', () => {
	const token = withDashboardSecret(() => createDashboardSession(WALLET));
	const verified = withDashboardSecret(() => verifyDashboardSession(token));
	assert.equal(verified?.wallet, WALLET);
});

test('C19 und C20 ein fehlendes Dashboard-Secret faellt zu, auch mit gesetztem Telegram-Secret', () => {
	withEnv({ DASHBOARD_SESSION_SECRET: undefined, TELEGRAM_WEBHOOK_SECRET: TEST_TELEGRAM_SECRET }, () => {
		assert.equal(dashboardSecretConfigured(), false);
		assert.throws(() => createDashboardChallenge(WALLET));
		assert.throws(() => createDashboardSession(WALLET));
	});
});

test('C21 ein mit dem Telegram-Secret signierter Token wird abgelehnt', () => {
	const forged = withEnv(
		{ DASHBOARD_SESSION_SECRET: TEST_TELEGRAM_SECRET, TELEGRAM_WEBHOOK_SECRET: TEST_TELEGRAM_SECRET },
		() => createDashboardSession(WALLET)
	);
	const verified = withDashboardSecret(() => verifyDashboardSession(forged));
	assert.equal(verified, null);
});

test('C24 ein zu kurzes Secret gilt als nicht gesetzt', () => {
	withEnv({ DASHBOARD_SESSION_SECRET: 'kurz', TELEGRAM_WEBHOOK_SECRET: TEST_TELEGRAM_SECRET }, () => {
		assert.equal(dashboardSecretConfigured(), false);
		assert.throws(() => createDashboardSession(WALLET));
	});
	withEnv({ DASHBOARD_SESSION_SECRET: 'x'.repeat(MIN_DASHBOARD_SECRET_LENGTH) }, () => {
		assert.equal(dashboardSecretConfigured(), true);
	});
});

test('C23 die Rate-Limit-Identitaet haengt allein am Dashboard-Secret', () => {
	const code = source('../src/http-security.mjs');
	assert.ok(code.includes('dashboardSecretConfigured'));
	const rate = code.slice(code.indexOf('function rateSecret'), code.indexOf('export function requireJson'));
	assert.equal(rate.includes('TELEGRAM_WEBHOOK_SECRET'), false);
	assert.ok(code.includes("response.status(503)"));
});

test('C25 Secretwerte erscheinen nicht in Fehlermeldungen', () => {
	withEnv({ DASHBOARD_SESSION_SECRET: 'kurz-aber-geheim' }, () => {
		try {
			createDashboardSession(WALLET);
			assert.fail('erwartete Ablehnung');
		} catch (error) {
			assert.equal(String(error.message).includes('kurz-aber-geheim'), false);
		}
	});
});

/* ------------------------------------------------------------------------- *
 * Teil D, Legacy-Cookie authentifiziert nicht mehr
 * ------------------------------------------------------------------------- */

test('D26 das Host-Cookie wird gelesen', () => {
	assert.equal(readSessionCookie(requestWithCookie(`${SESSION_COOKIE}=abc`)), 'abc');
});

test('D27 und D29 das Legacy-Cookie authentifiziert nicht mehr', () => {
	assert.equal(readSessionCookie(requestWithCookie(`${LEGACY_SESSION_COOKIE}=abc`)), null);
	assert.equal(readSessionCookie(requestWithCookie(`${LEGACY_SESSION_COOKIE}=abc; andere=1`)), null);
	// Auch eine gueltige Session zaehlt unter dem alten Namen nicht mehr.
	const token = withDashboardSecret(() => createDashboardSession(WALLET));
	const session = withDashboardSecret(() =>
		verifyDashboardSession(readSessionCookie(requestWithCookie(`${LEGACY_SESSION_COOKIE}=${encodeURIComponent(token)}`)))
	);
	assert.equal(session, null);
});

test('D29 kein Lesepfad im Handler kennt den alten Namen', () => {
	const code = source('../api/dashboard.mjs');
	assert.equal(code.includes(LEGACY_SESSION_COOKIE), false);
	assert.equal(code.includes('cookieOf('), false);
	assert.equal((code.match(/readSessionCookie\(request\)/g) ?? []).length, 2);
});

test('D30 bis D32 das Sessioncookie bleibt host-only und streng', () => {
	const header = withDashboardSecret(() => sessionCookieHeader(WALLET));
	assert.ok(header.startsWith(`${SESSION_COOKIE}=`));
	assert.ok(SESSION_COOKIE.startsWith('__Host-'));
	assert.ok(header.includes('Path=/'));
	assert.ok(header.includes('HttpOnly'));
	assert.ok(header.includes('Secure'));
	assert.ok(header.includes('SameSite=Strict'));
	assert.equal(/Domain=/i.test(header), false);
});

/* ------------------------------------------------------------------------- *
 * Regression, unveraenderte Grenzen
 * ------------------------------------------------------------------------- */

test('R33 und R34 die Challenge traegt SIWE, die Nonceform bleibt', () => {
	// AGENT-SEC-A3, 29.08.2026: diese Erwartung stand auf dem alten
	// proprietaeren Klartext und darauf, dass KEIN SIWE vorkommt. A3 ersetzt
	// genau dieses Format; die Nonceform bleibt unveraendert.
	const { message, token } = withDashboardSecret(() => createDashboardChallenge(WALLET));
	const data = withDashboardSecret(() => verifyDashboardToken(token));
	assert.equal(data.type, 'challenge');
	assert.match(data.nonce, /^[a-f0-9]{32}$/);
	assert.match(data.rid, /^[a-f0-9]{32}$/);
	assert.ok(Number.isFinite(data.iat));

	assert.ok(message.startsWith('agent.coverraccoon.com wants you to sign in with your Ethereum account:\n'));
	assert.ok(message.includes(`\nNonce: ${data.nonce}\n`));
	assert.ok(message.includes(`\nRequest ID: ${data.rid}`));
	assert.ok(message.includes('\nChain ID: 1\n'));
	assert.ok(message.includes('\nURI: https://agent.coverraccoon.com\n'));
	// Und der alte Klartext ist weg.
	assert.equal(message.startsWith('Raccoon Agent\n'), false);
	assert.equal(message.includes('Zweck: Persönliches Cover-Dashboard öffnen.'), false);
});

test('R34b zwei Challenges tragen verschiedene Nonces', () => {
	const [first, second] = withDashboardSecret(() => [
		verifyDashboardToken(createDashboardChallenge(WALLET).token),
		verifyDashboardToken(createDashboardChallenge(WALLET).token)
	]);
	assert.notEqual(first.nonce, second.nonce);
});

test('R35 die Sessionlaufzeit bleibt sieben Tage', () => {
	// Gegenwartsnah, sonst weist die Ablaufpruefung den Token korrekt ab. Die
	// gepruefte Groesse ist die Differenz und damit unabhaengig von der Uhr.
	const now = Date.now();
	const data = withDashboardSecret(() => verifyDashboardToken(createDashboardSession(WALLET, now)));
	assert.equal(data.exp - data.iat, 7 * 24 * 60 * 60_000);
	assert.ok(SESSION_COOKIE_OPTIONS.includes('Max-Age=604800'));
});

test('R35b eine Session gilt nur fuer die signierte Wallet', () => {
	const token = withDashboardSecret(() => createDashboardSession(WALLET));
	const data = withDashboardSecret(() => verifyDashboardSession(token));
	assert.equal(data.wallet, WALLET.toLowerCase());
	assert.notEqual(data.wallet, OTHER_WALLET.toLowerCase());
});

test('R36 die atomare Challenge-Verbrauchslogik ist unveraendert', () => {
	const code = source('../src/db.mjs');
	const consume = code.slice(code.indexOf('export async function consumeDashboardChallenge'), code.indexOf('export async function checkRateLimit'));
	assert.ok(consume.includes(".is('used_at', null)"));
	assert.ok(consume.includes(".gt('expires_at'"));
	assert.ok(consume.includes(".eq('wallet'"));
	assert.ok(consume.includes(".eq('nonce', nonce)"));
	assert.ok(consume.includes('rows.length === 1'));
});

test('R37 der Login setzt das Host-Cookie an genau einer Stelle', () => {
	const code = source('../api/dashboard.mjs');

	// AGENT-SEC-A2b, 29.08.2026: die Erwartung stand auf zwei. Die zweite
	// Ausstellung gehoerte zum unsignierten Telegram-Zugangslink und ist in A2
	// aus Sicherheitsgruenden entfernt. Steigt die Zahl wieder, ist ein zweiter
	// Sessionpfad zurueck und dieser Test faellt.
	assert.equal((code.match(/sessionCookieHeader\(wallet\)/g) ?? []).length, 1);
	assert.equal(/set-cookie['"],\s*`__Host-/.test(code), false);

	// Die eine Ausstellung liegt hinter Signaturpruefung und Nonceverbrauch.
	const mint = code.indexOf('sessionCookieHeader(wallet)');
	assert.ok(mint > 0);
	assert.ok(code.indexOf('await verifyMessage(') < mint);
	assert.ok(code.indexOf('await consumeDashboardChallenge(') < mint);

	// Und sie liegt nicht im Zugangscodezweig.
	const accessStart = code.indexOf('const access = typeof request.query.access');
	const accessEnd = code.indexOf('const wallet = typeof request.query.wallet');
	assert.ok(accessStart > 0 && accessEnd > accessStart);
	assert.ok(mint > accessEnd, 'die Ausstellung darf nicht im Zugangszweig liegen');

	// Und der Telegram-Verknuepfungsendpunkt stellt ueberhaupt keine aus.
	assert.equal(source('../api/link/verify.mjs').includes('sessionCookieHeader'), false);
});

test('R38 bis R42 der Client signiert nur und schreibt nichts', () => {
	const code = source('../web/src/main.js');
	assert.ok(code.includes("method: 'personal_sign'"));
	for (const forbidden of [
		'eth_sendTransaction',
		'wallet_sendCalls',
		'eth_signTransaction',
		'eth_signTypedData',
		'signTypedData',
		'writeContract',
		'sendTransaction'
	]) {
		assert.equal(code.includes(forbidden), false, forbidden);
	}
	assert.equal(/\bapprove\s*\(/.test(code), false);
	assert.equal(/\bpermit\s*\(/.test(code), false);
});
