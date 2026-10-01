import test from 'node:test';
import assert from 'node:assert/strict';
import { productKnowledge } from '../src/agent-knowledge.mjs';

test('product knowledge states the safety boundary and excludes autonomous purchases', () => {
	assert.match(productKnowledge, /never asks the wallet for a transaction, token approval, or typed-data signature/i);
	assert.match(productKnowledge, /does not prepare, open, or link to any checkout/i);
	assert.match(productKnowledge, /never asks for or stores a seed phrase/i);
	// Seit 01.10.2026 live von der Kette; der fruehere Weg ueber die Coverraccoon Agent API darf nicht mehr behauptet werden.
	assert.match(productKnowledge, /read live from the Ethereum blockchain/i);
	assert.doesNotMatch(productKnowledge, /Coverraccoon Agent API/i);
	assert.match(productKnowledge, /public Nexus Mutual product data/i);
	assert.match(productKnowledge, /no wallet address, personal cover data, or Telegram chat ID/i);
	assert.match(productKnowledge, /In Telegram groups, the bot responds only/i);
	assert.match(productKnowledge, /Personal requests are continued in a private chat/i);
});
