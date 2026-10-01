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

test('beide Verbinden-Knoepfe pruefen die Zustimmung, bevor etwas passiert', () => {
	for (const knopf of ['wcButton', 'injectedButton']) {
		const start = main.indexOf(`${knopf}.addEventListener('click', async () => {`);
		assert.ok(start > 0, knopf);
		assert.match(main.slice(start, start + 120), /if \(!hinweiseAkzeptiert\) return;/, knopf);
	}
});

test('kein Weg schaltet die Knoepfe an der Zustimmung vorbei frei', () => {
	assert.doesNotMatch(main, /\.disabled = false/);
	assert.match(main, /function enable\(\) \{ knoepfeFreigeben\(\); \}/);
	assert.match(main, /wcButton\.disabled = !hinweiseAkzeptiert;/);
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

test('der Kasten steht vor den Knoepfen und verlinkt Datenschutz und Impressum', () => {
	assert.ok(html.indexOf('id="disclaimer"') < html.indexOf('id="walletconnect"'));
	assert.match(html, /<input type="checkbox" id="disclaimer-ok" \/>/);
	assert.match(html, /href="\/datenschutz"/);
	assert.match(html, /href="\/impressum" id="disclaimer-imprint"/);
});
