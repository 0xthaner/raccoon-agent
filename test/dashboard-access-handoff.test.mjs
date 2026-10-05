/**
 * AGENT-SEC-A2 / AGENT-AUTH-002: der Telegram-Zugangslink authentifiziert nicht
 * mehr UND verbraucht den Einmalcode nicht mehr per GET.
 *
 * EHRLICHE EINORDNUNG: der Zugangspfad liegt im Vercel-Handler, der beim Import
 * `src/db.mjs` laedt und damit eine echte Datenbankverbindung verlangt. Ein
 * Aufruf des Handlers im Test wuerde entweder gegen die Produktionsdatenbank
 * laufen oder eine Datenbank mit anderer Semantik nachbauen; beides ist
 * ausgeschlossen. Die Aussagen ueber diese Zweige sind deshalb STRUKTURELL:
 * geprueft wird der Zweig selbst, nicht eine Ausfuehrung. Die ausfuehrbaren
 * Verhaltenstests der Sitzungs- und Secretgrenzen stehen in
 * `dashboard-auth-boundaries.test.mjs`, die der Same-Origin-Grenze in
 * `same-origin-boundary.test.mjs`.
 *
 * Offline: keine Datenbank, kein Netzwerk, kein Telegram, kein Browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SESSION_COOKIE } from '../src/dashboard-auth.mjs';

function source(relative) {
	return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

/** Der GET-Zugangszweig, von seinem Beginn bis zum Wallet-Zweig. */
function getAccessBranch() {
	const code = source('../api/dashboard.mjs');
	const start = code.indexOf('const access = typeof request.query.access');
	const end = code.indexOf('const wallet = typeof request.query.wallet');
	assert.ok(start > 0 && end > start, 'GET-Zugangszweig nicht gefunden');
	return code.slice(start, end);
}

/** Der POST-Handler ab der Methodenschranke. */
function postHandler() {
	const code = source('../api/dashboard.mjs');
	const start = code.indexOf("if (request.method !== 'POST')");
	assert.ok(start > 0, 'POST-Handler nicht gefunden');
	return code.slice(start);
}

/** Der Zugangszweig INNERHALB des POST, bis zum Login-Rate-Limit. */
function postAccessBranch() {
	const post = postHandler();
	const start = post.indexOf('if (typeof body.access === ');
	const end = post.indexOf("enforceRateLimit(request, response, 'dashboard-login'");
	assert.ok(start > 0 && end > start, 'POST-Zugangszweig nicht gefunden');
	return post.slice(start, end);
}

/* ------------------------------------------------------------------------- *
 * AGENT-AUTH-002: GET ist read-only und verbraucht nichts
 * ------------------------------------------------------------------------- */

test('AUTH002-1 der GET-Zugangszweig verbraucht den Code NICHT', () => {
	const branch = getAccessBranch();
	assert.equal(branch.includes('consumeDashboardAccess'), false, 'kein Consume im GET');
	assert.equal(branch.includes('recordAgentEvent'), false, 'kein Audit-/Zustandsschreiben im GET');
});

test('AUTH002-2 der GET-Zugangszweig ist read-only und weist nur auf POST', () => {
	const branch = getAccessBranch();
	assert.ok(branch.includes("code: 'ACCESS_REDEEM_VIA_POST'"));
	assert.ok(branch.includes('response.status(405)'));
	// Kein Handoffzustand, keine Wallet-Aufloesung, kein Cookie, keine Daten im GET.
	assert.equal(branch.includes('WALLET_SIGNATURE_REQUIRED'), false);
	assert.equal(/set-cookie/i.test(branch), false);
	assert.equal(branch.includes('sessionCookieHeader'), false);
	assert.equal(branch.includes(SESSION_COOKIE), false);
	assert.equal(branch.includes('dashboardData('), false);
});

/* ------------------------------------------------------------------------- *
 * AGENT-AUTH-002: der Consume liegt jetzt im POST (same-origin, JSON)
 * ------------------------------------------------------------------------- */

test('AUTH002-3 der Consume liegt hinter Same-Origin und JSON, vor dem Login-Zweig', () => {
	const post = postHandler();
	const sameOrigin = post.indexOf('requireSameOrigin(request, response)');
	const json = post.indexOf('requireJson(request, response)');
	const consume = post.indexOf('consumeDashboardAccess(body.access)');
	const login = post.indexOf("enforceRateLimit(request, response, 'dashboard-login'");
	assert.ok(sameOrigin > 0 && json > 0, 'Same-Origin und JSON werden erzwungen');
	assert.ok(sameOrigin < consume && json < consume, 'Same-Origin/JSON stehen VOR dem Consume');
	// Cross-Origin faellt damit, bevor irgendetwas verbraucht wird (siehe
	// same-origin-boundary.test.mjs fuer den ausfuehrbaren 403-Beweis).
	assert.ok(consume < login, 'der Access-Zweig steht vor dem Login-Zweig');
});

test('AUTH002-4 der POST-Zugangszweig greift nur ohne Login-Felder', () => {
	const branch = postAccessBranch();
	// Eine echte Anmeldung (token+signature) darf NICHT als Access behandelt werden.
	assert.ok(branch.includes('body.token === undefined'));
	assert.ok(branch.includes('body.signature === undefined'));
	assert.ok(branch.includes("typeof body.access === 'string' && body.access"));
});

test('AUTH002-5 der POST-Zugangszweig liefert genau den Handoffzustand, keine Session', () => {
	const branch = postAccessBranch();
	assert.ok(branch.includes('await consumeDashboardAccess(body.access)'));
	const payload = branch.slice(branch.indexOf("{ ok: false, code: 'WALLET_SIGNATURE_REQUIRED'"));
	assert.ok(payload.startsWith("{ ok: false, code: 'WALLET_SIGNATURE_REQUIRED', wallet: wallet.toLowerCase() }"));
	// Keine Session, kein Cookie, keine Dashboard-/Cover-/Telegramdaten.
	assert.equal(/set-cookie/i.test(branch), false);
	assert.equal(branch.includes('sessionCookieHeader'), false);
	assert.equal(branch.includes('createDashboardSession'), false);
	assert.equal(branch.includes('dashboardData('), false);
	assert.equal(branch.includes('telegramLinked'), false);
});

test('AUTH002-6 ein nicht aufloesbarer Code wird abgelehnt, ohne Leak', () => {
	const branch = postAccessBranch();
	assert.ok(branch.includes("code: 'ACCESS_CODE_INVALID'"));
	assert.ok(branch.includes('response.status(410)'));
	const messages = branch.match(/error: '[^']*'/g) ?? [];
	assert.equal(messages.length, 1);
	for (const message of messages) {
		for (const leak of ['pending_links', 'nonce', 'stack', 'Error', 'code']) {
			assert.equal(message.includes(leak), false, leak);
		}
	}
});

test('AUTH002-7 der Audit-Aufruf traegt keinen rohen Code', () => {
	const branch = postAccessBranch();
	const calls = branch.match(/recordAgentEvent\((\{[^)]*\})\)/g) ?? [];
	assert.equal(calls.length, 1);
	const argument = calls[0].slice('recordAgentEvent('.length, -1);
	assert.ok(argument.includes("eventType: 'dashboard.access_link_consumed'"));
	const withoutStrings = argument.replace(/'[^']*'/g, "''");
	const fields = withoutStrings.slice(1, -1).split(',').map((part) => part.split(':')[0].trim()).filter(Boolean);
	assert.deepEqual(fields.slice().sort(), ['eventType', 'source', 'wallet']);
	assert.equal(argument.includes('...'), false);
	assert.equal(argument.includes('metadata'), false);
	assert.equal(/\baccess\b/.test(withoutStrings), false);
});

test('AUTH002-8 der Verbrauch bleibt die bestehende atomare, single-use Grenze', () => {
	const db = source('../src/db.mjs');
	const consume = db.slice(db.indexOf('export async function consumeDashboardAccess'), db.indexOf('export async function storeDashboardChallenge'));
	assert.ok(consume.includes(".is('used_at', null)"));
	assert.ok(consume.includes(".gt('expires_at'"));
	assert.ok(consume.includes(".like('chat_id', 'dashboard:%')"));
	assert.ok(consume.includes('rows[0]?.nonce ?? null'));
});

/* ------------------------------------------------------------------------- *
 * Client: Einloesen per POST, nicht mehr per GET
 * ------------------------------------------------------------------------- */

test('AUTH002-9 der Client loest den Code per POST ein, nicht per GET', () => {
	const code = source('../web/src/main.js');
	const restore = code.slice(code.indexOf('async function restoreDashboard'), code.indexOf('async function', code.indexOf('async function restoreDashboard') + 1));
	// Kein GET mit Access-Code mehr, irgendwo in der Datei.
	assert.equal(code.includes('/api/dashboard?access='), false, 'kein GET-Consume mehr');
	// Der Access-Zweig schickt POST + JSON an /api/dashboard.
	assert.ok(restore.includes("method: 'POST'"));
	assert.ok(restore.includes('JSON.stringify({ access })'));
	assert.ok(restore.includes("'content-type': 'application/json'"));
	// Uebergabe an den bestehenden Signaturflow bleibt.
	assert.ok(restore.includes("handoff.code === 'WALLET_SIGNATURE_REQUIRED'"));
	assert.ok(restore.includes('expectedWallet = handoff.wallet.toLowerCase()'));
});

test('AUTH002-10 der Code verlaesst die URL vor dem POST', () => {
	const code = source('../web/src/main.js');
	const restore = code.slice(code.indexOf('async function restoreDashboard'));
	const cleanup = restore.indexOf("history.replaceState({}, '', '/')");
	const request = restore.indexOf("method: 'POST'");
	assert.ok(cleanup > 0 && request > cleanup, 'die Bereinigung muss vor dem Aufruf stehen');
});

test('AUTH002-11 der Code wird nicht gespeichert und nicht ausgegeben', () => {
	const code = source('../web/src/main.js');
	assert.equal(/localStorage\.setItem\([^)]*access/i.test(code), false);
	assert.equal(/sessionStorage\.setItem\([^)]*access/i.test(code), false);
	assert.equal(/console\.[a-z]+\([^)]*access/i.test(code), false);
});

/* ------------------------------------------------------------------------- *
 * Unveraendert: nur der Anmeldepfad stellt ein Cookie aus; SIWE-Login steht
 * ------------------------------------------------------------------------- */

test('A2-20 nur der Anmeldepfad stellt ein Cookie aus, hinter Signatur und Nonceverbrauch', () => {
	const code = source('../api/dashboard.mjs');
	const minting = code.split('\n').filter((line) => line.includes('sessionCookieHeader('));
	assert.equal(minting.length, 1);
	const mint = code.indexOf('sessionCookieHeader(');
	assert.ok(code.indexOf('verifyExpectedSiweSignature(') < mint);
	assert.ok(code.indexOf('await consumeDashboardChallenge(') < mint);
});

test('A2-13 der SIWE-Login-Flow des Clients ist unveraendert (Challenge, Signatur)', () => {
	const code = source('../web/src/main.js');
	assert.ok(code.includes('/api/dashboard?wallet='), 'Challenge weiter per GET ?wallet=');
	assert.ok(code.includes("method: 'personal_sign'"));
});

/* ------------------------------------------------------------------------- *
 * Telegram-Linking bleibt unberuehrt
 * ------------------------------------------------------------------------- */

test('AUTH002-12 der Telegram-Linking-Pfad ist unveraendert', () => {
	const verify = source('../api/link/verify.mjs');
	assert.ok(verify.includes('consumePendingLink(code, wallet)'));
	assert.ok(verify.includes('verifyExpectedSiweSignature('));
	// Die Verknuepfungssignatur erzeugt weiterhin KEINE Dashboard-Session.
	assert.equal(verify.includes('sessionCookieHeader'), false);
	assert.equal(verify.includes('createDashboardSession'), false);
});
