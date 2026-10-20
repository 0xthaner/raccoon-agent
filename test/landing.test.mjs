/*
	Oeffentliche Landingpage (20.10.2026): web/src/landing.js und der Abschnitt
	.landing in web/index.html.

	  - LAND-GUARD: die Landing ist reine Darstellung. landing.js importiert
	    nichts, fragt kein Netz, keine Wallet und keinen Speicher an und setzt
	    keine Adresse; im Landing-Markup gibt es keine Formulare und keine
	    externen Ziele. Die Anmeldung bleibt das eine bestehende Fenster (#connect).
	  - LAND-COPY: jeder Text existiert auf Deutsch und Englisch, die Demo ist als
	    Demo beschriftet, und es gibt keine absoluten Sicherheits- oder
	    Deckungsversprechen und keine behauptete Partnerschaft.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LANDING_TEXTS, applyLandingLanguage } from '../web/src/landing.js';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const withoutComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const html = read('web/index.html');
const landingStart = html.indexOf('<div class="landing" id="landing">');
const landingEnd = html.indexOf('<section class="dashboard" id="dashboard"');
const landing = html.slice(landingStart, landingEnd);
const connectStart = landing.indexOf('<section class="connect"');
const landingOwn = landing.slice(0, connectStart);
const code = withoutComments(read('web/src/landing.js'));

test('LAND-GUARD landing.js imports nothing and calls no network, wallet, storage or URL sink', () => {
	assert.doesNotMatch(code, /^\s*import\s|\bimport\(/m, 'no import');
	assert.doesNotMatch(code, /\bfetch\b|XMLHttpRequest|WebSocket|sendBeacon|EventSource|\/api\//, 'no network');
	assert.doesNotMatch(code, /\.request\(|window\.ethereum|\beth_[a-z]|\bwallet_[a-z]|personal_sign|signTypedData|signMessage|sendTransaction|writeContract|sendCalls|createWalletClient|\bapprove\(|buyCover|[Pp]urchase|openai|OpenAI/, 'no wallet, purchase or agent call');
	assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|document\.cookie/, 'no storage');
	assert.doesNotMatch(code, /\.(href|src|action|formAction|innerHTML|outerHTML)\s*=|insertAdjacentHTML|setAttribute\(|location\s*\.\s*(hash|href)\s*=|location\.assign|location\.replace|history\./, 'no URL or markup sink');
});

test('LAND-GUARD the landing markup has no form, input or external target; the only login is the existing #connect panel', () => {
	assert.ok(landingStart > 0 && landingEnd > landingStart && connectStart > 0, 'landing section found before the dashboard');
	assert.doesNotMatch(landingOwn, /<form|<input|<textarea|<iframe|<script|\son[a-z]+=/i);
	for (const [, href] of landingOwn.matchAll(/href="([^"]*)"/g)) assert.match(href, /^#[a-z-]+$/, `in-page link only: ${href}`);
	assert.equal((html.match(/id="walletconnect"/g) ?? []).length, 1, 'one wallet login button');
	assert.equal((html.match(/class="connect"/g) ?? []).length, 1, 'one login panel');
	assert.match(html, /<script type="module" src="\/src\/landing\.js"><\/script>/);
});

test('LAND-COPY every data-l key exists in German and English, and the language switch sets them', () => {
	const keys = [...landing.matchAll(/data-l="([A-Za-z0-9]+)"/g)].map((m) => m[1]);
	assert.ok(keys.length > 60);
	for (const key of keys) {
		assert.equal(typeof LANDING_TEXTS.de[key], 'string', `de ${key}`);
		assert.equal(typeof LANDING_TEXTS.en[key], 'string', `en ${key}`);
	}
	const nodes = keys.map((key) => ({ dataset: { l: key }, textContent: '' }));
	const doc = { querySelectorAll: () => nodes };
	applyLandingLanguage(doc, 'en');
	assert.equal(nodes.find((n) => n.dataset.l === 'trustTitle').textContent, 'Non-custodial by design');
	applyLandingLanguage(doc, 'de');
	assert.equal(nodes.find((n) => n.dataset.l === 'ctaOpen').textContent, 'Dashboard öffnen');
});

test('LAND-COPY no absolute security or coverage promise, no claimed partnership, demo labelled as demo', () => {
	const all = [landingOwn, ...Object.values(LANDING_TEXTS).flatMap(Object.values)].join('\n');
	assert.doesNotMatch(all, /impossible to hack|unhackable|guaranteed|garantiert|funds cannot be lost|audited|certified|zertifiziert|geprüft von|partner|official|offiziell|stay protected|fully protected|insured|versichert/i);
	assert.match(LANDING_TEXTS.en.previewCaption, /demo data/);
	assert.match(LANDING_TEXTS.de.previewCaption, /Demo-Daten/);
	assert.match(LANDING_TEXTS.en.provTitle, /protocols such as Nexus Mutual/);
	assert.match(landingOwn, /class="lp-window" aria-hidden="true"/, 'the demo window is not read out as real data');
});
