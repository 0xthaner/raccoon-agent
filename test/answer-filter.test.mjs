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
	assert.equal(f('Für Ether.fi gibt es Cover.', kontext), 'Für Ether.fi gibt es Cover.');
	assert.match(f('Für Ether.fi gibt es Cover.'), /\[Link entfernt\]/, 'ohne Kontext gilt es als Domain');
});

test('Satzzeichen nach einem erlaubten Link bleiben stehen', () => {
	assert.equal(f('Siehe https://docs.nexusmutual.io.'), 'Siehe https://docs.nexusmutual.io.');
	assert.equal(f('Siehe evil.example.'), 'Siehe [Link entfernt].');
});
