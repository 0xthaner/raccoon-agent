import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getCatalog, getNexusProductFacts, classifyNexusQuery, _test } from '../src/nexus-facts.mjs';
import { classifyAgentIntent } from '../src/agent-intent.mjs';

const products = [
 { id: 97, name: 'Aave v3' }, { id: 449, name: 'Aave v4' },
 { id: 438, name: 'Current' }, { id: 81, name: 'Exactly', isDeprecated: true },
 ...Array.from({ length: 15 }, (_, i) => ({ id: 1000 + i, name: `Synthetic Protocol ${i}` }))
].map(p => ({ ...p, productType: 0, category: 'synthetic' }));
const calls = [];
const fetchImpl = async url => {
 calls.push(String(url));
 if (String(url).endsWith('/v2/products')) return { ok: true, json: async () => products };
 if (String(url).endsWith('/v2/product-types')) return { ok: true, json: async () => [{ id: 0, name: 'Protocol Cover' }] };
 throw new Error('No capacity fetch allowed');
};
test.beforeEach(() => { _test.reset(); calls.length = 0; });

for (const q of ['Welche Produkte gibt es?', 'Was kann man bei Nexus absichern?', 'What products are available?', 'Was kann ich versichern?', 'Was kann ich versichern welche Produkte gibt es?', 'Welche Covers gibt es bei Nexus?', 'show me available Nexus products', 'what can I cover?']) {
 test(`bounded canonical catalogue discovery: ${q}`, async () => {
  const catalog = await getCatalog(fetchImpl);
  assert.equal(classifyNexusQuery(q, catalog), 'CATALOG_DISCOVERY');
  const context = await getNexusProductFacts(q, { fetchImpl, previousProductIds: [97] });
  assert.equal(context.QUERY_MODE, 'CATALOG_DISCOVERY');
  assert.equal(context.CATALOG.products.length, 12);
  assert.equal(context.CATALOG.totalActive, 18);
  assert.equal(context.CATALOG.additionalProducts, 6);
  assert.ok(context.CATALOG.products.every(p => p.status === 'ACTIVE' && p.productId !== 81));
  assert.ok(context.CATALOG.fetchedAt);
  assert.equal(context.CATALOG.sourceEndpoint, 'https://api.nexusmutual.io/v2/products');
  for (const p of context.CATALOG.products) assert.deepEqual(Object.keys(p).sort(), ['category','officialName','productId','productType','status','typeName']);
  assert.doesNotMatch(JSON.stringify(context), /pricing|capacity|wordingUrl|annexUrl/);
  assert.ok(calls.every(url => !url.includes('/capacity/')));
  assert.equal((await classifyAgentIntent(q, 'de', async () => { throw new Error('No model'); })).intent, 'explain_product');
 });
}
for (const q of ['Welche Aave Covers gibt es?', 'What products are available for Aave?', 'What is the current capacity for Aave?']) {
 test(`family precedence: ${q}`, async () => {
  const catalog = await getCatalog(fetchImpl);
  assert.equal(classifyNexusQuery(q, catalog), 'PRODUCT_FAMILY');
  const context = await getNexusProductFacts(q, { fetchImpl });
  assert.equal(context.PRODUCT_RESOLUTION, 'AMBIGUOUS');
  assert.deepEqual(context.CANDIDATES.map(p => p.officialName), ['Aave v3','Aave v4']);
  assert.equal(context.LIVE_FACTS, undefined);
  assert.equal(context.CATALOG, undefined);
  assert.ok(calls.every(url => !url.includes('/capacity/')));
 });
}
test('general and explicit detail modes retain existing behaviour', async () => {
 const catalog = await getCatalog(fetchImpl);
 for (const q of ['Was ist Nexus Mutual?', 'How does Nexus Mutual work?']) {
  assert.equal(classifyNexusQuery(q, catalog), 'GENERAL');
  assert.deepEqual(await getNexusProductFacts(q, { fetchImpl }), { PRODUCT_RESOLUTION: 'NO_MATCH' });
 }
 assert.equal(classifyNexusQuery('Tell me about Current cover', catalog), 'PRODUCT_DETAIL');
 const detail = await getNexusProductFacts('Tell me about Current cover', { fetchImpl });
 assert.equal(detail.PRODUCT_RESOLUTION, 'UNAMBIGUOUS');
 assert.equal(detail.PRODUCT_IDENTITY.productId, 438);
});
test('catalogue errors stay controlled and personal requests are not discovery', async () => {
 assert.equal((await classifyAgentIntent('show my covers')).intent, 'show_covers');
 assert.equal((await getNexusProductFacts('Welche Produkte gibt es?', { fetchImpl: async () => { throw new Error('offline'); } })).PRODUCT_RESOLUTION, 'UNAVAILABLE');
});
test('both answer prompts explicitly authorize only bounded catalogue identities', () => {
 const source = readFileSync(new URL('../src/agent-knowledge.mjs', import.meta.url), 'utf8');
 assert.equal(source.split('For QUERY_MODE CATALOG_DISCOVERY').length - 1, 2);
 assert.equal(source.split('Never give pricing, capacity, wording or annex for catalogue discovery').length - 1, 2);
 assert.match(source, /application\/project behind Raccoon Agent/);
});
