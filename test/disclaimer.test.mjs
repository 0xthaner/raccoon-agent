/**
 * Hinweise vor dem Verbinden: ohne Haekchen kein Verbinden, und der
 * Haftungssatz traegt die Ausnahmen, ohne die er gegenueber Verbrauchern
 * unwirksam waere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

test('beide Verbinden-Knoepfe gehen durch das Hinweis-Overlay', () => {
	assert.match(main, /wcButton\.addEventListener\('click', \(\) => mitHinweisen\(verbindeWalletConnect\)\);/);
	assert.match(main, /injectedButton\.addEventListener\('click', \(\) => mitHinweisen\(verbindeBrowserWallet\)\);/);
	// Und beide Wege pruefen selbst noch einmal, falls sie je anders aufgerufen werden.
	for (const weg of ['verbindeWalletConnect', 'verbindeBrowserWallet']) {
		const start = main.indexOf(`async function ${weg}() {`);
		assert.ok(start > 0, weg);
		assert.match(main.slice(start, start + 80), /if \(!hinweiseAkzeptiert\) return;/, weg);
	}
});

test('ohne Haekchen startet nichts, mit Haekchen genau der gedrueckte Weg', () => {
	const start = main.indexOf('function mitHinweisen(aktion) {');
	const block = main.slice(start, main.indexOf('\n}', start));
	assert.match(block, /if \(hinweiseAkzeptiert\) return aktion\(\);/);
	assert.match(block, /wartendeAktion = aktion;/);
	assert.match(block, /hinweisWeiter\.disabled = true;/);
	const weiter = main.slice(main.indexOf("hinweisWeiter.addEventListener('click'"));
	assert.match(weiter.slice(0, 400), /if \(!hinweisHaken\.checked\) return;/);
	assert.match(weiter.slice(0, 600), /aktion\?\.\(\);/);
	assert.match(html, /<button type="button" id="disclaimer-continue" disabled>/);
	assert.match(html, /<div class="disclaimer-overlay" id="disclaimer-overlay" hidden>/);
});

test('die Zustimmung gilt je Textfassung', () => {
	assert.match(main, /const HINWEISE_FASSUNG = 'hinweise-\d{4}-\d{2}-\d{2}';/);
	assert.match(main, /localStorage\.getItem\('raccoon_hinweise'\) === HINWEISE_FASSUNG/);
});

test('der Haftungsausschluss nennt die zwingenden Ausnahmen, deutsch und englisch', () => {
	for (const quelle of [html, main]) {
		assert.match(quelle, /Soweit gesetzlich zulässig/);
		assert.match(quelle, /Vorsatz und grobe Fahrlässigkeit, für Personenschäden und nach zwingenden gesetzlichen Vorschriften/);
	}
	assert.match(main, /intent and gross negligence, for personal injury and under mandatory statutory provisions/);
	const impressum = readFileSync(new URL('../web/impressum.html', import.meta.url), 'utf8');
	assert.match(impressum, /Vorsatz und grobe Fahrlässigkeit, für Personenschäden und nach zwingenden gesetzlichen Vorschriften/);
});

test('der Hinweis auf experimentell und moegliche Verluste steht zuerst, deutsch und englisch', () => {
	assert.match(html, /<li id="disclaimer-1">Der Raccoon Agent ist experimentell und befindet sich in Entwicklung\./);
	assert.match(main, /'Der Raccoon Agent ist experimentell[^']*Verluste[^']*Totalverlust verbunden\.'/);
	assert.match(main, /'Raccoon Agent is experimental[^']*losses[^']*total loss\.'/);
	assert.equal((html.match(/id="disclaimer-\d"/g) ?? []).length, 6);
});

test('das Overlay verlinkt Datenschutz und Impressum', () => {
	assert.match(html, /<input type="checkbox" id="disclaimer-ok" \/>/);
	assert.match(html, /href="\/datenschutz"/);
	assert.match(html, /href="\/impressum" id="disclaimer-imprint"/);
});
