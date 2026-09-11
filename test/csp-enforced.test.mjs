/**
 * AGENT-SEC-A7: die enge CSP wird durchgesetzt.
 *
 * Sie lief zuerst als `Content-Security-Policy-Report-Only` mit und hat in fuenf
 * vollstaendigen Durchlaeufen keinen einzigen Verstoss gemeldet - Browser-Wallet
 * wie QR-Weg. Jetzt blockiert sie, und meldet weiterhin: `report-uri` bleibt in
 * der scharfen Regel stehen, damit ein uebersehener Host sichtbar wird, statt
 * nur still zu scheitern.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const konfiguration = JSON.parse(readFileSync('vercel.json', 'utf8'));
const kopfzeilen = Object.fromEntries(konfiguration.headers.flatMap((g) => g.headers).map((k) => [k.key, k.value]));
const csp = kopfzeilen['Content-Security-Policy'];
const richtlinie = (name) => (csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name} `)) ?? '');

test('1 alle bisherigen Kopfzeilen stehen weiter', () => {
	for (const name of ['Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options',
		'Referrer-Policy', 'Permissions-Policy', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy']) {
		assert.ok(kopfzeilen[name], `${name} fehlt`);
	}
});

test('2 es gibt nur noch eine Regel, und die blockiert', () => {
	assert.ok(csp, 'Content-Security-Policy fehlt');
	assert.equal('Content-Security-Policy-Report-Only' in kopfzeilen, false,
		'die meldende Fassung ist jetzt die scharfe und gehoert entfernt');
});

test('3 script-src bleibt ohne unsafe-inline', () => {
	assert.equal(richtlinie('script-src'), "script-src 'self'");
});

test('4 kein pauschales https: oder wss: mehr', () => {
	for (const name of ['connect-src', 'img-src', 'frame-src']) {
		const wert = richtlinie(name);
		assert.ok(wert, `${name} fehlt`);
		assert.equal(/\bhttps:(\s|$)/.test(wert), false, `${name} traegt noch ein pauschales https:`);
		assert.equal(/\bwss:(\s|$)/.test(wert), false, `${name} traegt noch ein pauschales wss:`);
	}
});

test('5 die gemessenen Hosts sind vollstaendig erfasst', () => {
	const verbinden = richtlinie('connect-src');
	for (const host of ['https://api.web3modal.org', 'https://verify.walletconnect.org',
		'https://pulse.walletconnect.org', 'wss://relay.walletconnect.org', 'https://rpc.walletconnect.org']) {
		assert.ok(verbinden.includes(host), `${host} fehlt in connect-src`);
	}
	// Die Wallet-Symbole kommen als Bilder von api.web3modal.org, nicht nur als fetch.
	assert.ok(richtlinie('img-src').includes('https://api.web3modal.org'));
	assert.ok(richtlinie('frame-src').includes('https://verify.walletconnect.org'));
});

test('6 die festen Sperren sind unveraendert', () => {
	for (const fest of ["default-src 'self'", "object-src 'none'", "base-uri 'none'",
		"frame-ancestors 'none'", "form-action 'self'", 'upgrade-insecure-requests']) {
		assert.ok(csp.includes(fest), `${fest} fehlt`);
	}
});

test('7 Verstoesse werden weiterhin gemeldet, nicht nur blockiert', () => {
	assert.match(csp, /report-uri \/api\/csp-report/);
	assert.match(csp, /report-to csp/);
	assert.match(kopfzeilen['Reporting-Endpoints'], /csp="\/api\/csp-report"/);
});

test('8 walletlink bleibt draussen - der Verbinder ist abgeschaltet', () => {
	assert.equal(csp.includes('walletlink.org'), false);
	assert.match(readFileSync('web/src/main.js', 'utf8'), /enableCoinbase: false/);
});

test('9 die Sammelstelle speichert nichts und meldet keine Seitenadresse zurueck', () => {
	const quelle = readFileSync('api/csp-report.mjs', 'utf8');
	assert.equal(/document-uri|documentURI|referrer/.test(quelle.replace(/\/\*[\s\S]*?\*\//g, '')), false);
	assert.equal(/db\.mjs|supabase/i.test(quelle), false);
	assert.match(quelle, /status\(204\)/);
});
