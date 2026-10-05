/**
 * AGENT-API-001/002/003: Body-Groesse header-unabhaengig, CSP-Report begrenzt,
 * Cron-Antwort ohne interne Fehlertexte.
 *
 * Offline. `src/http-security.mjs` zieht `src/db.mjs`, das beim Import
 * SUPABASE-Variablen verlangt - hier mit Dummy-Werten gesetzt (kein Netz, kein
 * echter Client-Aufruf). Die geprueften Funktionen (bodyTooLarge, requireJson)
 * fassen die Datenbank nicht an.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SECRET_KEY ||= 'dummy-secret-key-for-import-only';
const { bodyTooLarge, requireJson } = await import('../src/http-security.mjs');

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function fakeResponse() {
	const seen = { status: null, body: null };
	return { seen, status(c) { seen.status = c; return this; }, json(b) { seen.body = b; return this; }, end() { return this; }, setHeader() { return this; } };
}

/* ------------------------------------------------------------------------- *
 * AGENT-API-001 Body Size
 * ------------------------------------------------------------------------- */

test('AGENT-API-001 uebergrosser Body mit korrektem Content-Length wird abgelehnt', () => {
	const big = 'x'.repeat(9000);
	assert.equal(bodyTooLarge({ headers: { 'content-length': String(9000) }, body: big }, 8192), true);
});

test('AGENT-API-001 uebergrosser Body OHNE Content-Length wird ebenfalls abgelehnt', () => {
	const big = 'x'.repeat(9000);
	assert.equal(bodyTooLarge({ headers: {}, body: big }, 8192), true);
});

test('AGENT-API-001 ungueltiger Content-Length umgeht die Pruefung nicht', () => {
	const big = { data: 'x'.repeat(9000) };
	assert.equal(bodyTooLarge({ headers: { 'content-length': 'abc' }, body: big }, 8192), true);
	// Auch ein gefaelschter kleiner Content-Length darf einen grossen Body nicht durchlassen.
	assert.equal(bodyTooLarge({ headers: { 'content-length': '10' }, body: big }, 8192), true);
});

test('AGENT-API-001 normaler Body wird akzeptiert', () => {
	assert.equal(bodyTooLarge({ headers: {}, body: { update_id: 1, message: { text: 'hallo' } } }, 1_000_000), false);
	assert.equal(bodyTooLarge({ headers: { 'content-length': '20' }, body: 'kurz' }, 8192), false);
});

test('AGENT-API-001 nicht serialisierbarer Body gilt als zu gross (fail closed)', () => {
	const zyklisch = {}; zyklisch.self = zyklisch;
	assert.equal(bodyTooLarge({ headers: {}, body: zyklisch }, 8192), true);
});

test('AGENT-API-001 requireJson lehnt grossen Body ohne Content-Length ab (413)', () => {
	const res = fakeResponse();
	const ok = requireJson({ headers: { 'content-type': 'application/json' }, body: 'x'.repeat(20_000) }, res);
	assert.equal(ok, false);
	assert.equal(res.seen.status, 413);
});

test('AGENT-API-001 requireJson akzeptiert normalen JSON-Body', () => {
	const res = fakeResponse();
	const ok = requireJson({ headers: { 'content-type': 'application/json' }, body: { a: 1 } }, res);
	assert.equal(ok, true);
	assert.equal(res.seen.status, null);
});

test('AGENT-API-001 telegram.mjs und csp-report.mjs nutzen bodyTooLarge, nicht nur Content-Length', () => {
	const tg = src('../api/telegram.mjs');
	assert.ok(tg.includes('bodyTooLarge(request, 1_000_000)'));
	assert.equal(/Number\(request\.headers\['content-length'\]\)/.test(tg), false);
	const csp = src('../api/csp-report.mjs');
	assert.ok(csp.includes('bodyTooLarge(request, MAX)'));
	assert.equal(/const laenge = Number\(request\.headers\['content-length'\]\)/.test(csp), false);
});

/* ------------------------------------------------------------------------- *
 * AGENT-API-002 CSP Rate Limit
 * ------------------------------------------------------------------------- */

test('AGENT-API-002 csp-report ist rate-limitiert und loggt keinen rohen Payload', () => {
	const csp = src('../api/csp-report.mjs');
	assert.ok(csp.includes("enforceRateLimit(request, response, 'csp-report'"));
	// Nur Direktive + normalisierter Origin werden geloggt, nicht der ganze Body.
	assert.ok(csp.includes('console.log(`csp-report richtlinie=${richtlinie} blockiert=${host}`)'));
	assert.equal(/console\.log\([^)]*\broh\b/.test(csp), false, 'kein Log des Rohbodys');
	assert.equal(/console\.log\([^)]*JSON\.stringify/.test(csp), false);
});

/* ------------------------------------------------------------------------- *
 * AGENT-API-003 Cron Error Disclosure
 * ------------------------------------------------------------------------- */

test('AGENT-API-003 alerts.mjs gibt keine internen Fehlertexte nach aussen', () => {
	const a = src('../api/alerts.mjs');
	// Der frueher durchgereichte rohe Fehlertext ist weg.
	assert.equal(a.includes('fehler: error?.message'), false);
	assert.equal(a.includes('{ fehler: error?.message'), false);
	// Nach aussen nur Zahl oder generisches 'fehler'.
	assert.ok(a.includes("bereinigt[tabelle] = 'fehler'"));
	assert.ok(a.includes('bereinigt = { ok: false }'));
	// Server-seitiges Log nennt nur den Tabellennamen, keine Meldung.
	assert.ok(a.includes('console.error(`purgeOldRecords: ${tabelle} nicht bereinigt`)'));
	assert.equal(/console\.error\([^)]*error\?\.message/.test(a), false);
	// Die Antwort baut nicht mehr direkt auf dem rohen purge-Ergebnis auf.
	assert.equal(/\.\.\.result, bereinigt: await purgeOldRecords/.test(a), false);
});
