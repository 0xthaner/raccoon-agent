/**
 * AGENT-SEC-A5: Schranken gegen das Erraten eines Verbindungscodes.
 *
 * Deterministisch und offline, wie die uebrigen Grenztests: `src/db.mjs` zieht
 * beim Import Supabase-Zugangsdaten und laesst sich hier nicht laden. Geprueft
 * wird deshalb die Form der Grenze - dass es sie gibt, an welcher Groesse sie
 * haengt und an welcher Stelle sie greift. Das tatsaechliche Zaehlen erledigt
 * `check_agent_rate_limit` in der Datenbank.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sicherheit = readFileSync('src/http-security.mjs', 'utf8');
const verify = readFileSync('api/link/verify.mjs', 'utf8');

test('1 es gibt eine Schranke, die an einem Wert statt an der IP haengt', () => {
	assert.match(sicherheit, /export async function enforceRateLimitFor\(/);
});

test('2 der Wert geht nur als HMAC in den Schluessel, nie im Klartext', () => {
	const block = sicherheit.slice(sicherheit.indexOf('export async function enforceRateLimitFor('));
	assert.match(block, /createHmac\('sha256', secret\)\.update\(String\(wert\)\)/);
	// Kein Schluessel, der den Wert selbst traegt.
	assert.equal(/checkRateLimit\(`\$\{scope\}:\$\{wert\}`/.test(block), false);
});

test('3 ohne Secret faellt die Schranke zu, statt durchzulassen', () => {
	const block = sicherheit.slice(sicherheit.indexOf('export async function enforceRateLimitFor('));
	const absturz = block.indexOf("response.status(503)");
	const zaehlen = block.indexOf('checkRateLimit');
	assert.ok(absturz > -1, 'der 503-Pfad fehlt');
	assert.ok(absturz < zaehlen, 'die Konfigurationspruefung muss vor dem Zaehlen stehen');
});

test('4 die Verifikation begrenzt pro IP UND pro Code', () => {
	assert.match(verify, /enforceRateLimit\(request, response, 'wallet-link-verify'/);
	assert.match(verify, /enforceRateLimitFor\(response, 'wallet-link-code', code/);
});

test('5 die Code-Schranke greift, bevor der Code nachgeschlagen oder verbraucht wird', () => {
	const schranke = verify.indexOf("enforceRateLimitFor(response, 'wallet-link-code'");
	const nachschlagen = verify.indexOf('getPendingLink(code)');
	const verbrauchen = verify.indexOf('consumePendingLink(code');
	assert.ok(schranke > -1 && nachschlagen > -1 && verbrauchen > -1);
	assert.ok(schranke < nachschlagen, 'die Schranke steht hinter dem Nachschlagen');
	assert.ok(schranke < verbrauchen, 'die Schranke steht hinter dem Verbrauchen');
});

test('6 ein unbrauchbarer Code faellt vor jeder Datenbankberuehrung durch', () => {
	const pruefung = verify.indexOf("typeof code !== 'string'");
	assert.ok(pruefung > -1, 'die Typpruefung fehlt');
	assert.ok(pruefung < verify.indexOf('getPendingLink(code)'));
	assert.match(verify, /code\.length > 128/);
});

test('7 die Code-Schranke ist enger als die IP-Schranke', () => {
	const proIp = /enforceRateLimit\(request, response, 'wallet-link-verify', (\d+), (\d+)\)/.exec(verify);
	const proCode = /enforceRateLimitFor\(response, 'wallet-link-code', code, (\d+), (\d+)\)/.exec(verify);
	assert.ok(proIp && proCode);
	assert.ok(Number(proCode[1]) <= Number(proIp[1]), 'pro Code darf nicht mehr erlaubt sein als pro IP');
});

test('8 die bestehende IP-Schranke wurde nicht entschaerft', () => {
	assert.match(sicherheit, /export async function enforceRateLimit\(request, response, scope, maxRequests, windowSeconds\)/);
	assert.match(sicherheit, /createHmac\('sha256', secret\)\.update\(requestIp\(request\)\)/);
});
