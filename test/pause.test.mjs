/**
 * Anmeldung pausiert (src/pause.mjs): keine neue Anmeldung, keine neue
 * Verknuepfung - aber Abmelden, Trennen und bestehende Sitzungen bleiben.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ANMELDUNG_PAUSIERT } from '../src/pause.mjs';

const quelle = (pfad) => readFileSync(new URL(pfad, import.meta.url), 'utf8');

test('der Schalter steht auf pausiert', () => {
	assert.equal(ANMELDUNG_PAUSIERT, true);
});

test('jeder Weg zu einer neuen Anmeldung lehnt ab, bevor etwas entsteht', () => {
	const dashboard = quelle('../api/dashboard.mjs');
	assert.match(dashboard, /if \(access && ANMELDUNG_PAUSIERT\) return pauseAntwort\(response\);/);
	assert.match(dashboard, /if \(wallet && ANMELDUNG_PAUSIERT\) return pauseAntwort\(response\);/);
	// Login (POST) vor jeder Pruefung der Signatur
	const post = dashboard.indexOf("if (ANMELDUNG_PAUSIERT) return pauseAntwort(response);\n\tif (!await enforceRateLimit(request, response, 'dashboard-login'");
	assert.ok(post > 0, 'POST-Login pausiert');
	for (const pfad of ['../api/link.mjs', '../api/link/verify.mjs']) {
		assert.match(quelle(pfad), /if \(ANMELDUNG_PAUSIERT\) return pauseAntwort\(response\);/, pfad);
	}
});

test('Abmelden, Telegram trennen und bestehende Sitzungen bleiben moeglich', () => {
	const dashboard = quelle('../api/dashboard.mjs');
	const del = dashboard.slice(dashboard.indexOf("if (request.method === 'DELETE')"));
	assert.doesNotMatch(del.slice(0, 800), /ANMELDUNG_PAUSIERT/);
	const lesen = dashboard.slice(dashboard.indexOf('const saved = readSessionCookie('));
	assert.doesNotMatch(lesen.slice(0, 300), /ANMELDUNG_PAUSIERT/);
});

test('der Bot erzeugt waehrend der Pause keine Verknuepfungslinks und loest keine Uebergabe ein', () => {
	const bot = quelle('../src/bot.mjs');
	assert.match(bot, /if \(ANMELDUNG_PAUSIERT\) return \{ inline_keyboard: rows \};/);
	assert.match(bot, /startCode && !ANMELDUNG_PAUSIERT \? Boolean\(await consumeTelegramHandoff/);
	assert.equal((bot.match(/&& ANMELDUNG_PAUSIERT\) \{\n\t*await sendMessage\([^,]+, PAUSE_TEXT/g) ?? []).length, 2);
});

test('die Seite meldet die Pause statt der Knoepfe', () => {
	assert.match(quelle('../api/config.mjs'), /anmeldungPausiert: ANMELDUNG_PAUSIERT/);
	const main = quelle('../web/src/main.js');
	assert.match(main, /if \(config\.anmeldungPausiert\) return zeigeAnmeldungPausiert\(\);/);
	assert.match(quelle('../web/index.html'), /\.actions\[hidden\]/);
});
