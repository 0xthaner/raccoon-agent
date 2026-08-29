/**
 * AGENT-SEC-A2: der Telegram-Zugangslink authentifiziert nicht mehr.
 *
 * EHRLICHE EINORDNUNG: der Zugangspfad liegt im Vercel-Handler, der beim Import
 * `src/db.mjs` laedt und damit eine echte Datenbankverbindung verlangt. Ein
 * Aufruf des Handlers im Test wuerde entweder gegen die Produktionsdatenbank
 * laufen oder eine Datenbank mit anderer Semantik nachbauen; beides ist
 * ausgeschlossen. Die Aussagen ueber diesen Zweig sind deshalb STRUKTURELL:
 * geprueft wird der Zweig selbst, nicht eine Ausfuehrung. Das ist fuer eine
 * ENTFERNUNG (kein Cookie, keine Daten) tragfaehig und wird im Bericht als
 * solche ausgewiesen. Die ausfuehrbaren Verhaltenstests der Sitzungs- und
 * Secretgrenzen stehen in `dashboard-auth-boundaries.test.mjs`.
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

/** Der Zugangszweig des Handlers, von seinem Beginn bis zum Wallet-Zweig. */
function accessBranch() {
	const code = source('../api/dashboard.mjs');
	const start = code.indexOf('const access = typeof request.query.access');
	const end = code.indexOf('const wallet = typeof request.query.wallet');
	assert.ok(start > 0 && end > start, 'Zugangszweig nicht gefunden');
	return code.slice(start, end);
}

/* ------------------------------------------------------------------------- *
 * Der Zugangscode erzeugt keine Anmeldung
 * ------------------------------------------------------------------------- */

test('A2-3 der Zugangszweig setzt kein Cookie', () => {
	const branch = accessBranch();
	assert.equal(/set-cookie/i.test(branch), false);
	assert.equal(branch.includes('sessionCookieHeader'), false);
	assert.equal(branch.includes(SESSION_COOKIE), false);
});

test('A2-4 der Zugangszweig erzeugt keine Session', () => {
	const branch = accessBranch();
	assert.equal(branch.includes('createDashboardSession'), false);
	assert.equal(branch.includes('resolveLogout'), false);
});

test('A2-5 bis A2-7 der Zugangszweig liefert keine Dashboard-, Cover- oder Telegramdaten', () => {
	const branch = accessBranch();
	assert.equal(branch.includes('dashboardData('), false);
	assert.equal(branch.includes('getWalletCovers'), false);
	assert.equal(branch.includes('getWalletLinkByWallet'), false);
	// Die Felder der Dashboardantwort selbst, nicht das blosse Wort: ein
	// erklaerender Kommentar darf `Telegram` nennen, die Antwort nicht liefern.
	assert.equal(branch.includes('telegramLinked'), false);
	assert.equal(branch.includes('telegramStartCode'), false);
	assert.equal(branch.includes('agentSettings'), false);
	assert.equal(branch.includes('covers'), false);
});

test('A2-1 und A2-2 der Zugangszweig liefert genau den Handoffzustand', () => {
	const branch = accessBranch();
	assert.ok(branch.includes("code: 'WALLET_SIGNATURE_REQUIRED'"));
	assert.ok(branch.includes('ok: false'));
	// Genau drei Felder, kein Datenanhang.
	const payload = branch.slice(branch.indexOf("{ ok: false, code: 'WALLET_SIGNATURE_REQUIRED'"));
	assert.ok(payload.startsWith("{ ok: false, code: 'WALLET_SIGNATURE_REQUIRED', wallet: wallet.toLowerCase() }"));
});

test('A2-8 bis A2-11 ein nicht aufloesbarer Code wird abgelehnt', () => {
	const branch = accessBranch();
	assert.ok(branch.includes("code: 'ACCESS_CODE_INVALID'"));
	assert.ok(branch.includes('response.status(410)'));
	// Kein Datenbankdetail, kein Code, kein Token in einer oeffentlichen
	// Fehlermeldung. Geprueft werden die Zeichenketten selbst, nicht ein
	// Zeichenfenster um sie herum.
	const messages = branch.match(/error: '[^']*'/g) ?? [];
	assert.equal(messages.length, 1);
	for (const message of messages) {
		for (const leak of ['pending_links', 'nonce', 'stack', 'Error', 'code']) {
			assert.equal(message.includes(leak), false, leak);
		}
	}
});

test('A2-12 der Verbrauch bleibt die bestehende atomare Grenze', () => {
	const branch = accessBranch();
	assert.ok(branch.includes('await consumeDashboardAccess(access)'));

	// Unveraendert: eine bedingte Aktualisierung, Erfolg nur bei genau einer
	// Zeile. Zwei gleichzeitige Aufrufe koennen deshalb nicht beide gewinnen.
	const db = source('../src/db.mjs');
	const consume = db.slice(db.indexOf('export async function consumeDashboardAccess'), db.indexOf('export async function storeDashboardChallenge'));
	assert.ok(consume.includes(".is('used_at', null)"));
	assert.ok(consume.includes(".gt('expires_at'"));
	assert.ok(consume.includes(".like('chat_id', 'dashboard:%')"));
	assert.ok(consume.includes('rows[0]?.nonce ?? null'));
});

/* ------------------------------------------------------------------------- *
 * Walletbindung und Signaturzwang
 * ------------------------------------------------------------------------- */

test('A2-13 der Client uebergibt an den bestehenden Signaturflow', () => {
	const code = source('../web/src/main.js');
	assert.ok(code.includes("dashboard.code === 'WALLET_SIGNATURE_REQUIRED'"));
	assert.ok(code.includes('expectedWallet = dashboard.wallet.toLowerCase()'));
	// Der Flow selbst ist unveraendert: Challenge, Signatur, Verifikation.
	assert.ok(code.includes('/api/dashboard?wallet='));
	assert.ok(code.includes("method: 'personal_sign'"));
});

test('A2-15 und A2-16 eine fremde Wallet bricht vor der Challenge ab', () => {
	const code = source('../web/src/main.js');
	const open = code.slice(code.indexOf('async function openDashboard'), code.indexOf('async function finish'));
	const guard = open.indexOf('expectedWallet');
	const challenge = open.indexOf('/api/dashboard?wallet=');
	assert.ok(guard > 0 && challenge > guard, 'die Pruefung muss vor der Challenge stehen');
	assert.ok(open.includes('.toLowerCase() !== expectedWallet'));
	assert.ok(open.includes('throw new Error'));
});

test('A2-20 nur der Anmeldepfad stellt ein Cookie aus', () => {
	const code = source('../api/dashboard.mjs');
	const minting = code.split('\n').filter((line) => line.includes('sessionCookieHeader('));
	assert.equal(minting.length, 1);
	// Und diese eine Stelle liegt hinter Signaturpruefung und Nonceverbrauch.
	const mint = code.indexOf('sessionCookieHeader(');
	assert.ok(code.indexOf('await verifyMessage(') < mint);
	assert.ok(code.indexOf('await consumeDashboardChallenge(') < mint);
});

/* ------------------------------------------------------------------------- *
 * URL, Speicher und Logs
 * ------------------------------------------------------------------------- */

test('A2-21 der Code verlaesst die URL vor dem Netzaufruf', () => {
	const code = source('../web/src/main.js');
	const restore = code.slice(code.indexOf('async function restoreDashboard'));
	const cleanup = restore.indexOf("history.replaceState({}, '', '/')");
	const request = restore.indexOf('/api/dashboard?access=');
	assert.ok(cleanup > 0 && request > cleanup, 'die Bereinigung muss vor dem Aufruf stehen');
});

test('A2-22 bis A2-25 der Code wird nicht gespeichert und nicht ausgegeben', () => {
	const code = source('../web/src/main.js');
	assert.equal(/localStorage\.setItem\([^)]*access/i.test(code), false);
	assert.equal(/sessionStorage\.setItem\([^)]*access/i.test(code), false);
	assert.equal(/console\.[a-z]+\([^)]*access/i.test(code), false);

	// Serverseitig erscheint der Code weder im Audit noch in einer Antwort.
	const branch = accessBranch();
	assert.equal(/json\(\{[^}]*access/.test(branch), false);

	// AGENT-SEC-A2b, 29.08.2026: die fruehere Pruefung suchte im ganzen
	// `recordAgentEvent`-Aufruf nach dem Wort `access` und traf damit den
	// stabilen Eventnamen `dashboard.access_link_consumed`. Der Name ist
	// fachlich richtig; verboten ist der ROHE CODE als Wert. Geprueft wird
	// deshalb der Feldbestand des Aufrufs, und das Wort wird erst gesucht,
	// nachdem die Zeichenketten entfernt sind.
	const calls = branch.match(/recordAgentEvent\((\{[^)]*\})\)/g) ?? [];
	assert.equal(calls.length, 1);
	const argument = calls[0].slice('recordAgentEvent('.length, -1);
	assert.ok(argument.includes("eventType: 'dashboard.access_link_consumed'"));

	const withoutStrings = argument.replace(/'[^']*'/g, "''");
	const fields = withoutStrings.slice(1, -1).split(',').map((part) => part.split(':')[0].trim()).filter(Boolean);
	assert.deepEqual(fields.slice().sort(), ['eventType', 'source', 'wallet']);

	// Kein Spread, keine freie Metadatenstruktur, kein roher Code als Wert.
	assert.equal(argument.includes('...'), false);
	assert.equal(argument.includes('metadata'), false);
	assert.equal(/\baccess\b/.test(withoutStrings), false);
});

test('A2-26 vor der Bereinigung wird nicht extern navigiert', () => {
	const code = source('../web/src/main.js');
	const restore = code.slice(code.indexOf('async function restoreDashboard'));
	const cleanup = restore.indexOf("history.replaceState({}, '', '/')");
	// Kein Sprung nach aussen zwischen Funktionsbeginn und Bereinigung.
	const before = restore.slice(0, cleanup);
	assert.equal(before.includes('location.href'), false);
	assert.equal(before.includes('location.replace'), false);
	assert.equal(before.includes('window.open'), false);
});

/* ------------------------------------------------------------------------- *
 * Linkscanner
 * ------------------------------------------------------------------------- */

test('A2-29 und A2-30 ein Linkscanner erhaelt weder Session noch Daten', () => {
	// Die Telegram-URL zeigt auf die statische Seite. Der Code wird erst durch
	// den Aufruf aus dem geladenen Client eingeloest; ein Abruf der Seite allein
	// verbraucht ihn nicht.
	for (const producer of ['../api/link/verify.mjs', '../src/bot.mjs', '../src/alerts.mjs']) {
		assert.ok(source(producer).includes('/?access='), producer);
	}
	// Und selbst wer den Zweig erreicht, bekommt nur den Handoffzustand.
	const branch = accessBranch();
	assert.equal(/set-cookie/i.test(branch), false);
	assert.equal(branch.includes('dashboardData('), false);
});
