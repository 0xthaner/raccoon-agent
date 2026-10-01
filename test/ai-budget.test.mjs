/**
 * Begrenzung fuer KI-Antworten (src/ai-budget.mjs) und die Anzeige des
 * Telegram-Kontos beim Verknuepfen (api/link.mjs, web/src/main.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allowAiRequest, AI_LIMITS } from '../src/ai-budget.mjs';

function zaehler() {
	const stand = new Map();
	const aufrufe = [];
	return {
		aufrufe,
		check: async (schluessel, max) => {
			aufrufe.push(schluessel);
			const n = (stand.get(schluessel) ?? 0) + 1;
			stand.set(schluessel, n);
			return n <= max;
		},
		key: (scope, wert) => `${scope}:${wert}`
	};
}

test('privat: 30 KI-Antworten je Stunde, danach Schluss', async () => {
	const z = zaehler();
	let erlaubt = 0;
	for (let i = 0; i < 40; i++) if (await allowAiRequest({ chatId: 1 }, z)) erlaubt++;
	assert.equal(erlaubt, AI_LIMITS.privat.max);
	assert.equal(AI_LIMITS.privat.max, 30);
});

test('Gruppe: ein einzelner Absender kommt nur auf 10, die Gruppe insgesamt auf 40', async () => {
	const z = zaehler();
	let spammer = 0;
	for (let i = 0; i < 25; i++) if (await allowAiRequest({ chatId: -100, senderId: 7, isGroup: true }, z)) spammer++;
	assert.equal(spammer, 10);
	let alle = spammer;
	for (let absender = 100; absender < 200; absender++) if (await allowAiRequest({ chatId: -100, senderId: absender, isGroup: true }, z)) alle++;
	assert.equal(alle, AI_LIMITS.gruppe.max);
});

test('der Kostendeckel ueber alle Chats greift auch, wenn jeder Chat neu ist', async () => {
	const z = zaehler();
	let erlaubt = 0;
	for (let chat = 0; chat < 700; chat++) if (await allowAiRequest({ chatId: chat }, z)) erlaubt++;
	assert.equal(erlaubt, AI_LIMITS.gesamt.max);
});

test('faellt die Zaehlung aus, bleibt privat offen und die Gruppe zu', async () => {
	const kaputt = { check: async () => { throw new Error('db weg'); }, key: (s, w) => `${s}:${w}` };
	assert.equal(await allowAiRequest({ chatId: 1 }, kaputt), true);
	assert.equal(await allowAiRequest({ chatId: -1, senderId: 2, isGroup: true }, kaputt), false);
	const ohneGeheimnis = { check: async () => true, key: () => null };
	assert.equal(await allowAiRequest({ chatId: 1 }, ohneGeheimnis), false, 'ohne Geheimnis keine Zaehlung, also keine KI');
});

test('der Bot prueft die Grenze, bevor die KI gefragt wird', () => {
	const bot = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
	const privat = bot.slice(bot.indexOf('async function handleNaturalLanguage('));
	assert.ok(privat.indexOf('allowAiRequest(') < privat.indexOf('classifyAgentIntent('));
	const gruppe = bot.slice(bot.indexOf('async function handleGroupMessage('));
	assert.ok(gruppe.indexOf('allowAiRequest(') < gruppe.indexOf('classifyAgentIntent('));
});

test('die Verknuepfungsseite zeigt das Telegram-Konto, nur als Text', () => {
	const api = readFileSync(new URL('../api/link.mjs', import.meta.url), 'utf8');
	assert.match(api, /getChat\?chat_id=/);
	assert.match(api, /result\.result\?\.type !== 'private'/, 'nur private Chats');
	const main = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');
	const block = main.slice(main.indexOf('async function zeigeTelegramKonto('), main.indexOf('zeigeTelegramKonto();'));
	assert.match(block, /fett\.textContent = anzeige/);
	assert.doesNotMatch(block, /innerHTML|insertAdjacentHTML/);
});
