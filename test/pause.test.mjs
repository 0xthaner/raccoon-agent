/**
 * Anmeldung pausiert (src/pause.mjs): keine neue Anmeldung, keine neue
 * Verknuepfung - aber Abmelden, Trennen und bestehende Sitzungen bleiben.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ANMELDUNG_PAUSIERT } from '../src/pause.mjs';

const quelle = (pfad) => readFileSync(new URL(pfad, import.meta.url), 'utf8');

test('der Anmelde-Schalter ist freigeschaltet (Dashboard-Login aktiv)', () => {
	// Bewusst freigeschaltet (release: enable dashboard authentication).
	// AGENT_ANTWORTEN_PAUSIERT bleibt unberuehrt pausiert.
	assert.equal(ANMELDUNG_PAUSIERT, false);
});

test('jeder Weg zu einer neuen Anmeldung lehnt ab, bevor etwas entsteht', () => {
	const dashboard = quelle('../api/dashboard.mjs');
	assert.match(dashboard, /if \(access && ANMELDUNG_PAUSIERT\) return pauseAntwort\(response\);/);
	assert.match(dashboard, /if \(wallet && ANMELDUNG_PAUSIERT\) return pauseAntwort\(response\);/);
	// Login (POST) wird pausiert, BEVOR der Access-Code verbraucht oder die
	// Signatur geprueft wird. AGENT-AUTH-002 hat den Access-Consume in den POST
	// verschoben; der Pause-Check bleibt die erste Schranke des POST und steht
	// damit vor Access-Consume UND vor dem Login-Zweig.
	const postStart = dashboard.indexOf("if (request.method !== 'POST')");
	const pausePost = dashboard.indexOf('if (ANMELDUNG_PAUSIERT) return pauseAntwort(response);', postStart);
	const accessConsume = dashboard.indexOf('consumeDashboardAccess(body.access)', postStart);
	const loginLimit = dashboard.indexOf("enforceRateLimit(request, response, 'dashboard-login'", postStart);
	assert.ok(pausePost > 0, 'POST-Login pausiert');
	assert.ok(pausePost < accessConsume && pausePost < loginLimit, 'Pause steht vor Access-Consume und Login');
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
	assert.doesNotMatch(bot, /consumeTelegramHandoff\(/);
	assert.equal((bot.match(/(?:&& ANMELDUNG_PAUSIERT|if \(ANMELDUNG_PAUSIERT)\) \{\n\t*await sendMessage\([^,]+, PAUSE_TEXT/g) ?? []).length, 2);
});

test('die Seite meldet die Pause statt der Knoepfe', () => {
	assert.match(quelle('../api/config.mjs'), /anmeldungPausiert: ANMELDUNG_PAUSIERT/);
	const main = quelle('../web/src/main.js');
	assert.match(main, /if \(config\.anmeldungPausiert\) return zeigeAnmeldungPausiert\(\);/);
	assert.match(quelle('../web/index.html'), /\.actions\[hidden\]/);
});
