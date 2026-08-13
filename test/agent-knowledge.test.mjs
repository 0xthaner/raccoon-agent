import test from 'node:test';
import assert from 'node:assert/strict';
import { productKnowledge } from '../src/agent-knowledge.mjs';

test('product knowledge states the safety boundary and excludes autonomous purchases', () => {
	assert.match(productKnowledge, /never executed autonomously/i);
	assert.match(productKnowledge, /never asks for or stores a seed phrase/i);
	assert.match(productKnowledge, /public verified Coverraccoon knowledge/i);
	assert.match(productKnowledge, /no wallet address, personal cover data, or Telegram chat ID/i);
	assert.match(productKnowledge, /In Telegram groups, the bot responds only/i);
	assert.match(productKnowledge, /Personal requests are continued in a private chat/i);
});
