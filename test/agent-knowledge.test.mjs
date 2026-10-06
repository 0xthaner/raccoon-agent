import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { productKnowledge } from '../src/agent-knowledge.mjs';

test('product knowledge states the safety boundary and excludes autonomous purchases', () => {
	assert.match(productKnowledge, /never asks the wallet for a transaction, token approval, or typed-data signature/i);
	assert.match(productKnowledge, /does not prepare, open, or link to any checkout/i);
	assert.match(productKnowledge, /never asks for or stores a seed phrase/i);
	// Seit 01.10.2026 live von der Kette; der fruehere Weg ueber die Coverraccoon Agent API darf nicht mehr behauptet werden.
	assert.match(productKnowledge, /read live from the Ethereum blockchain/i);
	// Telegram zeigt Markdown als Rohtext (kein parse_mode); die Anweisung muss reinen Text verlangen.
	const quelle = readFileSync(new URL('../src/agent-knowledge.mjs', import.meta.url), 'utf8');
	assert.equal(quelle.split('Write plain text only: no Markdown').length - 1, 2, 'privat und Gruppe');
	assert.doesNotMatch(productKnowledge, /Coverraccoon Agent API/i);
	assert.match(productKnowledge, /public Nexus Mutual product data/i);
	assert.match(productKnowledge, /no wallet address, personal cover data, or Telegram chat ID/i);
	assert.match(productKnowledge, /In Telegram groups, the bot responds only/i);
	assert.match(productKnowledge, /Personal requests are continued in a private chat/i);
});

const answerSource = readFileSync(new URL('../src/agent-knowledge.mjs', import.meta.url), 'utf8');
const answerPrompts = [...answerSource.matchAll(/instructions: `([^`]+)`/g)].map((match) => match[1]);
for (const question of [
	'Must Nexus legally pay my loss in Austria?',
	'Muss Nexus meinen Verlust nach österreichischem Recht bezahlen?',
	'Kann ich den Verlust steuerlich absetzen?'
]) {
	test(`legal policy covers jurisdiction/tax uncertainty: ${question}`, () => {
		assert.equal(answerPrompts.length, 2);
		for (const prompt of answerPrompts) {
			assert.match(prompt, /jurisdiction-specific legal, tax or regulatory questions/);
			assert.match(prompt, /supplied product information does not establish the local legal position/);
			assert.match(prompt, /never give a definitive yes\/no legal conclusion/);
			assert.match(prompt, /Distinguish Nexus Mutual's description/);
			assert.match(prompt, /qualified legal or tax review/);
		}
	});
}

test('knowledge permits describing discretionary process without deciding statutory rights', async () => {
	const { nexusBasics } = await import('../src/agent-knowledge.mjs');
	assert.match(nexusBasics, /describes its own claims process as discretionary/);
	assert.match(nexusBasics, /does not establish statutory rights, mandatory consumer rights/);
	assert.match(nexusBasics, /Austrian or any other local law/);
	assert.doesNotMatch(nexusBasics, /Members do not have a legal right/);
	for (const prompt of answerPrompts) {
		assert.match(prompt, /Product-name matches do not establish suitability/);
		assert.match(prompt, /do not give prices or capacity before selection is unambiguous/);
	}
});
