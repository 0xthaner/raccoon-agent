/**
 * AGENT-UX-1: nach dem Trennen wieder verbinden.
 *
 * Der Fehler war keiner in der Verknuepfung, sondern in der Auskunft darueber:
 * `/start` mit Verbindungscode hat die Wallet verknuepft und im selben Durchlauf
 * gemeldet, sie sei "bereits aktiv". Wer eben getrennt hatte, las das als
 * "es ist nichts passiert".
 *
 * Offline: geprueft wird die Form des Ablaufs in der Quelle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bot = readFileSync('src/bot.mjs', 'utf8');

test('1 der Rueckgabewert der Verknuepfung wird ausgewertet, nicht verworfen', () => {
	assert.match(bot, /const frischVerknuepft = startCode \? Boolean\(await consumeTelegramHandoff\(/);
	assert.equal(/if \(startCode\) await consumeTelegramHandoff\(/.test(bot), false,
		'der alte, verwerfende Aufruf steht noch da');
});

test('2 eine frische Verknuepfung meldet Verbindung, keine Bestandsmeldung', () => {
	assert.match(bot, /frischVerknuepft \? verbunden : schonAktiv/);
});

test('3 die Verbindungsmeldung gibt es in allen drei Sprachen', () => {
	for (const stueck of ['Verbunden 🦝', 'Connected 🦝', '已连接 🦝']) {
		assert.ok(bot.includes(stueck), `${stueck} fehlt`);
	}
});

test('4 "bereits aktiv" bleibt fuer den Fall ohne frische Verknuepfung erhalten', () => {
	assert.match(bot, /Raccoon Agent ist bereits aktiv/);
	assert.match(bot, /Raccoon Agent is already active/);
});

test('5 die Auswertung steht vor der Abfrage der bestehenden Verknuepfung', () => {
	const verknuepft = bot.indexOf('const frischVerknuepft');
	const abfrage = bot.indexOf('const existingWallet = await getWalletLink');
	assert.ok(verknuepft > -1 && abfrage > -1);
	assert.ok(verknuepft < abfrage, 'sonst ist der Wert bei der Meldung noch nicht bekannt');
});

test('6 Trennen entfernt die Verknuepfung wirklich, meldet also zu Recht Erfolg', () => {
	const db = readFileSync('src/db.mjs', 'utf8');
	const block = db.slice(db.indexOf('export async function unlinkWallet('));
	assert.match(block, /from\('monitored_wallets'\)\.delete\(\)\.eq\('chat_id'/);
	assert.match(block, /from\('wallet_links'\)\.delete\(\)\.eq\('chat_id'/);
});
