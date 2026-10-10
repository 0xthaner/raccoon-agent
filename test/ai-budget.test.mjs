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

test('faellt die Zaehlung aus, bleiben privat und Gruppe zu', async () => {
	const kaputt = { check: async () => { throw new Error('db weg'); }, key: (s, w) => `${s}:${w}` };
	assert.equal(await allowAiRequest({ chatId: 1 }, kaputt), false);
	assert.equal(await allowAiRequest({ chatId: -1, senderId: 2, isGroup: true }, kaputt), false);
	const ohneGeheimnis = { check: async () => true, key: () => null };
	assert.equal(await allowAiRequest({ chatId: 1 }, ohneGeheimnis), false, 'ohne Geheimnis keine Zaehlung, also keine KI');
});

test('der Bot prueft die Grenze, bevor die KI gefragt wird', () => {
	const bot = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
	const privat = bot.slice(bot.indexOf('async function handleNaturalLanguage('));
	assert.ok(privat.indexOf('allowAiRequest(') < privat.indexOf('classifyAgentIntent('));
	// Seit 10.10.2026 gibt es keinen Gruppen-Handler mehr, also auch keinen ungeprueften KI-Pfad.
	assert.equal(bot.includes('handleGroupMessage'), false);
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

test('RPC-Fehler an jeder Budgetgrenze sperrt private und Gruppen-Anfragen', async () => {
	for (const isGroup of [false, true]) {
		for (const failedScope of isGroup ? ['ai-absender', 'ai-gruppe', 'ai-gesamt'] : ['ai-privat', 'ai-gesamt']) {
			const calls = [];
			const allowed = await allowAiRequest({ chatId: 1, senderId: 2, isGroup }, {
				key: (scope) => scope,
				check: async (scope) => {
					calls.push(scope);
					if (scope === failedScope) throw new Error('private database detail');
					return true;
				}
			});
			assert.equal(allowed, false);
			assert.equal(calls.at(-1), failedScope);
		}
	}
});

const botSource = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
function botFunction(name, deps) {
	const start = botSource.indexOf(`async function ${name}(`);
	assert.ok(start >= 0);
	const end = botSource.indexOf('\nasync function ', start + 1);
	assert.ok(end > start);
	return new Function(...Object.keys(deps), `${botSource.slice(start, end)}\nreturn ${name};`)(...Object.values(deps));
}

test('Budgetfehler stoppt echte Bot-Handler vor Klassifikation/Generierung; privater Hinweis bleibt statisch', async () => {
	// Seit 10.10.2026 gibt es nur noch den privaten Handler; Gruppen erreichen ihn nie.
	for (const isGroup of [false]) {
		const sent = [];
		let aiCalls = 0;
		const forbiddenAi = async () => { aiCalls++; throw new Error('AI must not run'); };
		const handler = botFunction('handleNaturalLanguage', {
			allowAiRequest: (context) => allowAiRequest(context, {
				key: (scope) => scope,
				check: async () => { throw new Error('private database detail'); }
			}),
			classifyAgentIntent: forbiddenAi,
			answerProductQuestion: forbiddenAi,
			configuredUsername: 'RaccoonAgentBot',
			sendMessage: async (_chat, text) => sent.push(text)
		});
		await handler({ chat: { id: isGroup ? -1 : 1 }, from: { id: 2 }, text: 'Explain Aave' }, 'en');
		assert.equal(aiCalls, 0);
		if (isGroup) assert.deepEqual(sent, [], 'Gruppen bleiben ohne Spam-Fallback still');
		else {
			assert.equal(sent.length, 1);
			assert.match(sent[0], /commands and buttons keep working/);
			assert.doesNotMatch(sent[0], /database|private database detail/);
		}
	}
});

test('statisches /help umgeht AI und bleibt bei defektem AI-Budget verfuegbar', async () => {
	const sent = [];
	const forbidden = () => { throw new Error('AI budget or model must not run for /help'); };
	const handler = botFunction('handleMessage', {
		authenticPrivateMessage: () => true,
		commandOf: (text) => text,
		getLanguage: async () => 'en',
		recordAgentEvent: async () => {},
		telegramTimingMetadata: () => ({}),
		getWalletLink: async () => null,
		dashboardKeyboard: async () => ({}),
		helpTextEn: 'Static help',
		sendMessage: async (_chat, text) => sent.push(text),
		handleNaturalLanguage: forbidden,
		allowAiRequest: forbidden,
		classifyAgentIntent: forbidden
	});
	await handler({ chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/help' });
	assert.deepEqual(sent, ['Static help']);
});
