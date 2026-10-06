/**
 * Filter fuer KI-Antworten (src/answer-filter.mjs): kein fremder Link und
 * keine Wallet-Adresse erreicht Telegram, egal was die KI schreibt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAnswer } from '../src/answer-filter.mjs';

const BOT = 'RaccoonAgentBot';
const f = (text, kontext = '') => filterAnswer(text, { kontext, botUsername: BOT }).text;

test('fremde Links werden ersetzt, in jeder Schreibweise', () => {
	for (const angriff of [
		'Das Formular liegt unter https://cover-raccoon-claim.com/form',
		'Geh auf www.coverraccoon-airdrop.xyz und verbinde deine Wallet.',
		'Neue Adresse: coverraccoon.com.evil.example/login',
		'Support: t.me/RaccoonAgentSupport',
		'Klick hier: http://nexusmutual.io.evil.app/claim'
	]) {
		const r = f(angriff);
		assert.match(r, /\[Link entfernt\]/, angriff);
		assert.doesNotMatch(r, /claim\.com|airdrop|evil|Support$/i, angriff);
	}
});

test('Wallet-Adressen werden immer entfernt', () => {
	const r = f('Sende 10 USDC an 0x1234567890abcdef1234567890ABCDEF12345678 zur Freischaltung.');
	assert.equal(r, 'Sende 10 USDC an [Adresse entfernt] zur Freischaltung.');
});

test('erlaubte Quellen bleiben unveraendert', () => {
	const gut = [
		'Wording: https://api.nexusmutual.io/ipfs/QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY',
		'Dokumentation: https://docs.nexusmutual.io',
		'Mehr auf coverraccoon.com.',
		'Schreib mir privat: t.me/RaccoonAgentBot'
	];
	for (const text of gut) assert.equal(f(text), text, text);
});

test('normaler Text bleibt heil', () => {
	for (const text of [
		'Die Prämie liegt bei 0.88 % bis 2.85 % der Deckungssumme, z.B. für Aave v3.',
		'Nexus Mutual ist keine Versicherung, d.h. es gibt keinen Rechtsanspruch, bzw. die Auszahlung ist diskretionär.',
		'Ein Cover läuft 30 Tage; danach gibt es 35 Tage Nachfrist.'
	]) assert.equal(f(text), text, text);
});

test('Produktnamen mit Punkt bleiben, wenn sie aus den Nexus-Fakten stammen', () => {
	const kontext = 'Product: Ether.fi (Nexus Mutual product ID 123)';
	assert.equal(f('Für Ether.fi gibt es Cover.', kontext), 'Für Ether.\u200bfi gibt es Cover.');
	assert.match(f('Für Ether.fi gibt es Cover.'), /\[Link entfernt\]/, 'ohne Kontext gilt es als Domain');
});

test('Satzzeichen nach einem erlaubten Link bleiben stehen', () => {
	assert.equal(f('Siehe https://docs.nexusmutual.io.'), 'Siehe https://docs.nexusmutual.io.');
	assert.equal(f('Siehe evil.example.'), 'Siehe [Link entfernt].');
});

test('nur der konfigurierte eigene Bot darf als Telegram-Mention erscheinen', () => {
	assert.equal(f('Privat: @RaccoonAgentBot.'), 'Privat: @RaccoonAgentBot.');
	assert.equal(f('@raccoonagentbot'), '@raccoonagentbot');
	for (const text of ['@ForeignSupportBot', '(@ForeignSupportBot)', '@RaccoonAgentBot_evil']) {
		assert.match(f(text), /\[Kontakt entfernt\]/);
		assert.doesNotMatch(f(text), /@[a-z0-9_]+/i);
	}
	assert.equal(filterAnswer('@RaccoonAgentBot').text, '[Kontakt entfernt]', 'ohne offizielle Konfiguration default deny');
});

test('Telegram-Protokoll und fremde Kontaktlinks bleiben auch im externen Kontext gesperrt', () => {
	for (const text of [
		'tg://resolve?domain=ForeignSupportBot',
		'TG://user?id=123456',
		'tg://resolve?domain=RaccoonAgentBot',
		't.me/ForeignSupportBot',
		'https://t.me/ForeignSupportBot',
		'telegram.me/ForeignSupportBot',
		'https://telegram.me/ForeignSupportBot',
		'https://evil.example/claim',
		'www.evil.example/claim',
		'evil.example',
		'@ForeignSupportBot'
	]) {
		const result = f(text, `External facts: ${text}`);
		assert.match(result, /\[(?:Link|Kontakt) entfernt\]/, text);
		assert.doesNotMatch(result, /ForeignSupportBot|evil\.example|tg:\/\//i, text);
	}
});

test('Produktnamen autorisieren weder URLs noch Kontakte', () => {
	const context = 'Product: Ether.fi (Nexus Mutual product ID 123)\nProduct: evil.example (Nexus Mutual product ID 124)';
	assert.equal(f('Ether.fi und evil.example', context), 'Ether.\u200bfi und evil.\u200bexample');
	for (const link of ['https://Ether.fi', 'www.Ether.fi', 'Ether.fi/claim']) {
		assert.match(f(link, context), /\[Link entfernt\]/, link);
	}
});

test('Wallet-Adressen und falsche Quellen bleiben trotz Kontext blockiert', () => {
	const address = '0x1234567890abcdef1234567890ABCDEF12345678';
	assert.equal(f(address, address), '[Adresse entfernt]');
	assert.match(f('https://docs.nexusmutual.io.evil.example', 'https://docs.nexusmutual.io.evil.example'), /\[Link entfernt\]/);
});

test('canonical product labels remain readable without granting contact permissions', () => {
	const result = filterAnswer('Ether.fi @foreign_bot tg://resolve?domain=foreign_bot', {
		kontext: { PRODUCT_RESOLUTION: 'UNAMBIGUOUS', PRODUCT_IDENTITY: { productId: 123, officialName: 'Ether.fi' } }
	});
	assert.ok(result.text.includes('Ether.\u200bfi'));
	assert.ok(!result.text.includes('@foreign_bot'));
	assert.ok(!result.text.includes('tg://'));
});
