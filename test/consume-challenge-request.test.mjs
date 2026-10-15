/*
	EOA-Meta-Audit 15.10.2026, Befund H2: der Einmal-Verbrauch der Login-Challenge.

	Alle Handler-Tests mocken consumeDashboardChallenge, und der Quelltext-Waechter
	R36 sah seit aa78b6c das Entfernen von vier der fuenf Filter nicht mehr (die
	Lese-Funktion isDashboardChallengeOpen liegt im selben Ausschnitt).

	Dieser Test laeuft gegen den ECHTEN Code in src/db.mjs mit dem ECHTEN supabase-js-
	Client; nur der Transport (fetch) ist ersetzt. Er haelt fest, welche Anfrage beim
	Datenbankdienst ankommt: genau EIN bedingtes PATCH (= ein UPDATE ... WHERE ...
	RETURNING in PostgREST) mit allen vier Bedingungen, ohne vorheriges Lesen.

	WAS ER NICHT BEWEIST (Evidenzklasse B): dass Postgres dieses UPDATE unter
	gleichzeitigen Anfragen atomar ausfuehrt. Dafuer braucht es eine echte
	Postgres/PostgREST-Instanz; lokal gibt es keine (kein psql/postgres/docker/
	supabase-CLI). Die Atomaritaet bleibt deshalb PARTIAL - siehe Bericht.

	Sicherheit des Tests: SUPABASE_URL zeigt auf eine nicht aufloesbare Domain
	(.invalid, RFC 6761) - selbst wenn das Ersetzen von fetch versagte, erreicht
	keine Anfrage die echte Datenbank.
*/
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SECRET_KEY = 'consume-challenge-request-test-not-a-key';

const calls = [];
let reply = () => [{ nonce: 'n' }];
globalThis.fetch = async (input, init = {}) => {
	const url = new URL(typeof input === 'string' ? input : input.url);
	assert.equal(url.hostname, 'supabase.invalid', 'nie eine echte Datenbank');
	calls.push({ method: init.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams.entries()), prefer: new Headers(init.headers).get('prefer') });
	const { status = 200, body } = (() => { const r = reply(); return Array.isArray(r) ? { body: r } : r; })();
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};

const db = await import('../src/db.mjs');

const NONCE = 'a'.repeat(32);
const WALLET = '0xAbC0000000000000000000000000000000000001';

async function consume(rows) {
	calls.length = 0;
	reply = () => rows;
	const result = await db.consumeDashboardChallenge(NONCE, WALLET);
	return { result, calls: [...calls] };
}

test('H2 consume sends exactly ONE conditional PATCH - no read before the write (no read-then-write)', async () => {
	const before = Date.now();
	const { calls: sent } = await consume([{ nonce: NONCE }]);
	const after = Date.now();
	assert.equal(sent.length, 1, 'genau eine Anfrage');
	const [call] = sent;
	assert.equal(call.method, 'PATCH');
	assert.equal(call.path, '/rest/v1/dashboard_challenges');
	assert.equal(call.prefer, 'return=representation', 'nur die tatsaechlich geaenderten Zeilen zaehlen');
	// alle vier Bedingungen im SELBEN Statement
	assert.equal(call.query.nonce, `eq.${NONCE}`, 'Nonce-Bedingung');
	assert.equal(call.query.wallet, `eq.${WALLET.toLowerCase()}`, 'Wallet-Bedingung (kleingeschrieben wie gespeichert)');
	assert.equal(call.query.used_at, 'is.null', 'nur unbenutzte Challenge');
	assert.match(call.query.expires_at ?? '', /^gt\./, 'nur nicht abgelaufene Challenge');
	const cutoff = Date.parse(call.query.expires_at.slice(3));
	assert.ok(cutoff >= before - 1000 && cutoff <= after + 1000, 'Ablaufgrenze ist JETZT, nicht verschoben');
	assert.equal(call.query.select, 'nonce');
});

test('H2 consume succeeds only when the database reports exactly one changed row', async () => {
	assert.equal((await consume([{ nonce: NONCE }])).result, true);
	assert.equal((await consume([])).result, false, '0 Zeilen: verbraucht, abgelaufen, falsche Wallet');
	assert.equal((await consume([{ nonce: NONCE }, { nonce: NONCE }])).result, false, 'mehr als eine Zeile: nie Erfolg');
});

test('H2 a database error never counts as consumed (throws, the login does not continue)', async () => {
	calls.length = 0;
	reply = () => ({ status: 500, body: { message: 'boom', code: 'XX000' } });
	await assert.rejects(db.consumeDashboardChallenge(NONCE, WALLET));
});

test('H2 the mode-B read check is read-only and carries the same three guards', async () => {
	calls.length = 0;
	reply = () => ({ status: 200, body: { nonce: NONCE } });
	await db.isDashboardChallengeOpen(NONCE, WALLET);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].method, 'GET', 'nur lesen - verbrauchen darf allein consumeDashboardChallenge');
	assert.equal(calls[0].query.used_at, 'is.null');
	assert.match(calls[0].query.expires_at ?? '', /^gt\./);
	assert.equal(calls[0].query.wallet, `eq.${WALLET.toLowerCase()}`);
});
