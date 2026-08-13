import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKnowledgeResponse, selectKnowledge } from '../src/coverraccoon-knowledge.mjs';

const entries = parseKnowledgeResponse({ apiVersion: 'agent-knowledge.v1', entries: [
	{ id: 'nexus.overview', title: 'Overview', content: 'Nexus Mutual overview content.', sourceUrl: 'https://coverraccoon.com/cover/nexus-mutual', updatedAt: '2026-07-14', origin: 'mixed', access: 'public' },
	{ id: 'nexus.claims', title: 'Claims', content: 'Claims committee and payouts.', sourceUrl: 'https://coverraccoon.com/cover/nexus-mutual/claims', updatedAt: '2026-07-14', origin: 'mixed', access: 'public' }
] });

test('knowledge response accepts only versioned Coverraccoon sources', () => {
	assert.equal(entries.length, 2);
	assert.equal(parseKnowledgeResponse({ apiVersion: 'wrong', entries: [] }).length, 0);
	assert.equal(parseKnowledgeResponse({ apiVersion: 'agent-knowledge.v1', entries: [{ ...entries[0], sourceUrl: 'https://evil.example/' }] }).length, 0);
	assert.equal(parseKnowledgeResponse({ apiVersion: 'agent-knowledge.v1', entries: [{ ...entries[0], access: 'premium' }] }).length, 0);
});

test('knowledge selection prioritizes the relevant topic', () => {
	assert.equal(selectKnowledge(entries, 'Wie funktioniert ein Claim und die Auszahlung?', 1)[0].id, 'nexus.claims');
});
