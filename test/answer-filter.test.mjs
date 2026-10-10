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

/* Keine Deckungs- oder Leistungszusagen (10.10.2026). */

const GUARANTEES = [
	'Das ist gedeckt.', 'Ja, das ist gedeckt.', 'Du bist gedeckt.', 'Der Schaden ist gedeckt.', 'Der Claim wird angenommen.',
	'Der Claim wird genehmigt.', 'Nexus zahlt.', 'Du bekommst eine Auszahlung.', 'Das ist versichert.', 'Das fällt sicher unter das Cover.',
	'This is covered.', 'Your claim will be paid.', 'Your claim will be approved.', 'Wenn die Voraussetzungen erfüllt sind, bist du gedeckt.',
	'If the oracle is manipulated, you are covered.', 'Ja, das ist gedeckt, aber ob Nexus zahlt, entscheidet das Assessment.',
	"You're fully covered for that.", 'Nexus Mutual will pay you.', 'Dein Claim wird sicher bezahlt.', 'Der Hack wäre damit gedeckt.',
	'Du bist dann voll abgesichert.', 'It is covered under clause 2.2.', 'You will get a payout.', 'Guaranteed payout within 30 days.',
	// Luecke aus dem Offline-Dry-Run W1-W14 (10.10.2026): Possessiv und Verstaerker vor dem Objekt.
	'Nexus wird deinen Schaden sicher bezahlen.', 'Nexus wird den Schaden sicher bezahlen.', 'Nexus wird deinen Verlust bezahlen.',
	'Nexus wird dir den Schaden erstatten.', 'Nexus Mutual wird deinen Schaden auszahlen.', 'Nexus wird dir sicher eine Auszahlung leisten.'
];
const LEGITIMATE = [
	'the wording lists Oracle Manipulation as a Covered Event',
	'The wording lists Oracle Manipulation as a Covered Event.',
	'Oracle Manipulation is listed as a Covered Event, subject to the conditions in clause 2.2.',
	'Das Wording nennt Oracle Manipulation als Covered Event, wenn die dort genannten Voraussetzungen erfüllt sind.',
	'Der Wortlaut beschreibt dieses Ereignis grundsätzlich als möglichen Covered Event.',
	'Die Bedingungen enthalten hierfür folgende Voraussetzungen: ein Fehler von mehr als 2,5 %.',
	'Ob dein konkreter Vorfall diese Voraussetzungen erfüllt und ein Claim anerkannt wird, entscheidet der Nexus Mutual Claims-Prozess.',
	'Eine Leistungs- oder Deckungszusage kann der Raccoon Agent nicht geben.',
	'Whether you are covered depends on the claims assessment.', 'Das ist nicht automatisch gedeckt.',
	'Das heißt nicht, dass jeder Verlust gedeckt ist.', 'Gedeckte Ereignisse sind laut Wording Smart-Contract-Bugs und Oracle Failure.',
	'Ausgeschlossen sind unter anderem Verluste durch Phishing.', 'The Claim Amount is the loss minus the 5% deductible.',
	'Nexus Mutual describes its claims process as discretionary.', 'This cover is a Single Protocol Cover.',
	'Der Claim muss innerhalb der Grace Period eingereicht werden.', 'Ob Nexus zahlt, entscheidet das Claims-Assessment.',
	'It is not covered if the event occurred before the cover period.', 'Nexus Mutual may pay the Claim Amount subject to the following conditions.',
	'Ob Nexus deinen Schaden bezahlt, entscheidet das Claims-Assessment.', 'Nexus zahlt nicht automatisch.',
	'Das Wording nennt Oracle Manipulation als Covered Event.', 'Ob ein Claim anerkannt oder bezahlt wird, entscheidet das Assessment.',
	'Eine Auszahlung kann nicht zugesagt werden.', 'Ob Nexus deinen Schaden bezahlen wird, entscheidet das Assessment.',
	'Nexus wird deinen Schaden nicht automatisch bezahlen.'
];

test('Deckungs- und Zahlungszusagen werden durch den Entscheidungshinweis ersetzt', () => {
	for (const text of GUARANTEES) {
		const result = filterAnswer(text);
		assert.equal(result.zusagenErsetzt, 1, text);
		assert.match(result.text, /entscheidet das Claims-Assessment von Nexus Mutual|determined by Nexus Mutual’s claims assessment/, text);
		assert.doesNotMatch(result.text, /\b(?:ist gedeckt|bist gedeckt|wird angenommen|wird genehmigt|Nexus zahlt\.|is covered|will be paid|will be approved)\b/i, text);
	}
});

test('Beschreibungen des Wordings und eingeschraenkte Aussagen bleiben unveraendert', () => {
	for (const text of LEGITIMATE) {
		const result = filterAnswer(text);
		assert.equal(result.text, text, text);
		assert.equal(result.zusagenErsetzt, 0, text);
	}
});

test('nur der Zusage-Satz wird ersetzt, Rest und Quellen bleiben', () => {
	const url = 'https://api.nexusmutual.io/ipfs/QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY';
	const result = filterAnswer(`Das Wording nennt Oracle Manipulation als Covered Event. Ja, das ist gedeckt. Nexus zahlt dann.\n${url}`);
	assert.equal(result.zusagenErsetzt, 2);
	assert.equal(result.text.split('entscheidet das Claims-Assessment').length - 1, 1, 'Hinweis nur einmal');
	assert.ok(result.text.startsWith('Das Wording nennt Oracle Manipulation als Covered Event. '));
	assert.ok(result.text.endsWith(`\n${url}`));
	assert.doesNotMatch(result.text, /[ \t]$/m);
});
