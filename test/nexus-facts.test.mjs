/**
 * Produktfakten direkt von Nexus Mutual (src/nexus-facts.mjs).
 *
 * Offline. Die Fixture folgt den echten Antworten von api.nexusmutual.io am
 * 01.10.2026 (Produkt 97 "Aave v3", Typ 0 "Single Protocol Cover").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getNexusProductFacts, matchProducts, getCatalog, _test } from '../src/nexus-facts.mjs';
import { productKnowledge, nexusBasics } from '../src/agent-knowledge.mjs';

const WORDING = 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY';
const PRODUCTS = [
	{ id: 97, name: 'Aave v3', coverAssets: [{ assetSymbol: 'ETH' }, { assetSymbol: 'USDC' }], isDeprecated: false, metadata: '', productType: 0, isPrivate: false, category: 'lending' },
	{ id: 1, name: 'Aave v2', coverAssets: [{ assetSymbol: 'ETH' }], isDeprecated: true, metadata: '', productType: 0, isPrivate: false, category: 'lending' },
	{ id: 238, name: 'Sky Savings Rate (sUSDS)', coverAssets: [{ assetSymbol: 'USDC' }], isDeprecated: false, metadata: '', productType: 0, isPrivate: false },
	{ id: 500, name: 'Geheim', coverAssets: [], isDeprecated: false, metadata: '', productType: 0, isPrivate: true }
];
const TYPES = [{ id: 0, name: 'Single Protocol Cover', gracePeriod: '3024000', metadata: WORDING }];
const CAPACITY = {
	productId: 97,
	availableCapacity: [
		{ amount: '5530141618981657254031', asset: { symbol: 'ETH', decimals: 18 } },
		{ amount: '14867698181997', asset: { symbol: 'USDC', decimals: 6 } },
		{ amount: '216588230000000000000000', asset: { symbol: 'NXM', decimals: 18 } }
	],
	minAnnualPrice: '0.0088',
	maxAnnualPrice: '0.028463691338098063'
};

function nexus({ ausfall = false, kapazitaetAusfall = false } = {}) {
	const aufrufe = [];
	const fetchImpl = async (url) => {
		aufrufe.push(String(url));
		if (ausfall) return { ok: false, status: 503, json: async () => ({}) };
		if (String(url).endsWith('/v2/products')) return { ok: true, json: async () => PRODUCTS };
		if (String(url).endsWith('/v2/product-types')) return { ok: true, json: async () => TYPES };
		if (String(url).includes('/v2/capacity/')) return kapazitaetAusfall ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, json: async () => CAPACITY };
		throw new Error(`unerwartet ${url}`);
	};
	return { fetchImpl, aufrufe };
}

test.beforeEach(() => _test.reset());

test('nennt eine Frage ein Produkt, kommen dessen Fakten von Nexus', async () => {
	const { fetchImpl, aufrufe } = nexus();
	const facts = await getNexusProductFacts('Was deckt Aave v3 eigentlich?', { fetchImpl });
	assert.match(facts, /Product: Aave v3 \(Nexus Mutual product ID 97\)/);
	assert.match(facts, /Cover type: Single Protocol Cover/);
	assert.match(facts, /Claim grace period after expiry: 35 days/);
	assert.match(facts, /0\.88% to 2\.85% of the cover amount/);
	assert.match(facts, /5,530 ETH, 14,867,698 USDC/);
	assert.doesNotMatch(facts, /NXM/, 'NXM ist kein Cover-Asset fuer Kaeufer');
	assert.match(facts, new RegExp(`Official cover wording \\(authoritative\\): https://api\\.nexusmutual\\.io/ipfs/${WORDING}`));
	assert.ok(aufrufe.every((a) => a.startsWith('https://api.nexusmutual.io/')), 'nur die offizielle Nexus-API');
});

test('ohne Produktnamen in der Frage gibt es keinen Fakten-Block', async () => {
	const { fetchImpl } = nexus();
	assert.equal(await getNexusProductFacts('Wie funktioniert ein Claim?', { fetchImpl }), null);
});

test('der laengere Name gewinnt, eingestellte Produkte nur ohne Alternative', async () => {
	const { fetchImpl } = nexus();
	const katalog = await getCatalog(fetchImpl);
	assert.deepEqual(matchProducts('aave v3 bitte', katalog).map((p) => p.id), [97]);
	assert.deepEqual(matchProducts('Aave v2?', katalog).map((p) => p.id), [1], 'nur ein eingestelltes passt');
	assert.deepEqual(matchProducts('Sky Savings Rate', katalog).map((p) => p.id), [238], 'Name ohne Klammerzusatz');
	assert.deepEqual(matchProducts('Geheim', katalog), [], 'private Produkte nie');
	assert.deepEqual(matchProducts('Was deckt Aave?', katalog).map((p) => p.id), [97], 'erstes Wort, nur laufende Produkte');
	assert.deepEqual(matchProducts('Wie geht ein Claim?', katalog), [], 'kurze Allerweltswoerter treffen nichts');
});

test('eingestellte Produkte bekommen keinen Preis von 0 Prozent', async () => {
	const { fetchImpl, aufrufe } = nexus();
	const facts = await getNexusProductFacts('Aave v2', { fetchImpl });
	assert.match(facts, /DEPRECATED, no longer sold/);
	assert.match(facts, /Price and capacity: none, the product is no longer sold/);
	assert.doesNotMatch(facts, /0% to 0%/);
	assert.ok(!aufrufe.some((a) => a.includes('/v2/capacity/')), 'Kapazitaet wird gar nicht erst geholt');
});

test('mehrere Treffer fuehren zur Rueckfrage', async () => {
	const { fetchImpl } = nexus();
	const facts = await getNexusProductFacts('Aave v3 oder Sky Savings Rate?', { fetchImpl });
	assert.match(facts, /Several Nexus Mutual products match/);
});

test('faellt Nexus aus, sagt der Block das, statt etwas zu erfinden', async () => {
	const { fetchImpl } = nexus({ ausfall: true });
	assert.equal(await getNexusProductFacts('Aave v3', { fetchImpl }), 'Nexus Mutual product data is unavailable right now.');
	_test.reset();
	const ohneKapazitaet = nexus({ kapazitaetAusfall: true });
	const facts = await getNexusProductFacts('Aave v3', { fetchImpl: ohneKapazitaet.fetchImpl });
	assert.match(facts, /Price: unavailable right now/);
	assert.match(facts, /Capacity: unavailable right now/);
	assert.match(facts, /Official cover wording/, 'der Rest bleibt');
});

test('der Bot bekommt keine Bewertungen und keinen Verkaufsweg mehr', () => {
	const alles = `${productKnowledge}\n${nexusBasics}`;
	for (const verboten of [/Raccoon Score/i, /gap check/i, /analysis page/i, /Coverraccoon API/i, /checkout link/i]) {
		assert.doesNotMatch(alles, verboten);
	}
	assert.match(nexusBasics, /not an insurance company/);
	assert.match(nexusBasics, /no legal right to a claim payout|do not have a legal right to a claim payout/);
});
