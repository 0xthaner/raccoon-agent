import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnalysisCatalog, parseKnowledgeResponse, selectAnalysisCatalog, selectKnowledge } from '../src/coverraccoon-knowledge.mjs';

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

test('analysis catalog accepts only Coverraccoon pages and matches a requested product', () => {
	const catalog = parseAnalysisCatalog({ apiVersion: '1', analyses: [
		{ provider: 'nexus-mutual', product: 'aave-v3', name: 'Aave v3', subject: 'Aave', web: 'https://coverraccoon.com/cover/nexus-mutual/aave-v3', raccoonScore: 81, asOf: '2026-08-01' },
		{ provider: 'nexus-mutual', product: 'curve', name: 'Curve', web: 'https://evil.example/curve' }
	] });
	assert.equal(catalog.length, 1);
	assert.equal(selectAnalysisCatalog(catalog, 'Gib mir die komplette Analyse zu Aave v3')[0].product, 'aave-v3');
});
