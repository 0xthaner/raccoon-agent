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
	assert.equal(facts.PRODUCT_RESOLUTION, 'UNAMBIGUOUS');
	assert.equal(facts.PRODUCT_IDENTITY.productId, 97);
	assert.equal(facts.PRODUCT_IDENTITY.typeName, 'Single Protocol Cover');
	assert.equal(facts.PRODUCT_IDENTITY.gracePeriodDays, 35);
	assert.deepEqual(facts.LIVE_FACTS.pricing, { minAnnualPricePct: 0.88, maxAnnualPricePct: 2.85 });
	assert.deepEqual(facts.LIVE_FACTS.capacity, [{ symbol: 'ETH', amount: 5530 }, { symbol: 'USDC', amount: 14867698 }]);
	assert.equal(facts.AUTHORITATIVE_WORDING.wordingUrl, `https://api.nexusmutual.io/ipfs/${WORDING}`);
	assert.ok(aufrufe.every((a) => a.startsWith('https://api.nexusmutual.io/')), 'nur die offizielle Nexus-API');
});

test('ohne Produktnamen in der Frage gibt es keinen Fakten-Block', async () => {
	const { fetchImpl } = nexus();
	assert.deepEqual(await getNexusProductFacts('Wie funktioniert ein Claim?', { fetchImpl }), { PRODUCT_RESOLUTION: 'NO_MATCH' });
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
	assert.equal(facts.PRODUCT_IDENTITY.status, 'DEPRECATED');
	assert.equal(facts.LIVE_FACTS.status, 'NOT_SOLD');
	assert.equal(facts.LIVE_FACTS.pricing, undefined);
	assert.ok(!aufrufe.some((a) => a.includes('/v2/capacity/')), 'Kapazitaet wird gar nicht erst geholt');
});

test('eine Rueckfrage ohne Produktnamen bezieht sich auf das gerade besprochene Produkt', async () => {
	// Echter Verlauf vom 01.10.2026: "Was kostet a Versicherung fuer AAVE" -> "Ja und was ist da versichert?"
	const { fetchImpl } = nexus();
	let gemerkt = null;
	await getNexusProductFacts('Was kostet a Versicherung für Aave v3', { fetchImpl, onProducts: (ids) => { gemerkt = ids; } });
	assert.deepEqual(gemerkt, [97]);
	const facts = await getNexusProductFacts('Ja und was ist da versichert?', { fetchImpl, previousProductIds: gemerkt });
	assert.equal(facts.PRODUCT_IDENTITY.fromContext, true);
	assert.equal(facts.PRODUCT_IDENTITY.officialName, 'Aave v3');
	assert.equal(facts.AUTHORITATIVE_WORDING.status, 'AVAILABLE');
	// Ohne Vorgeschichte bleibt es bei "kein Produkt".
	assert.equal((await getNexusProductFacts('Ja und was ist da versichert?', { fetchImpl })).PRODUCT_RESOLUTION, 'NO_MATCH');
	// Ein neu genanntes Produkt schlaegt den Kontext.
	assert.equal((await getNexusProductFacts('Und Sky Savings Rate?', { fetchImpl, previousProductIds: [97] })).PRODUCT_IDENTITY.productId, 238);
});

test('mehrere Treffer fuehren zur Rueckfrage', async () => {
	const { fetchImpl } = nexus();
	const facts = await getNexusProductFacts('Aave v3 oder Sky Savings Rate?', { fetchImpl });
	assert.equal(facts.PRODUCT_RESOLUTION, 'AMBIGUOUS');
});

test('faellt Nexus aus, sagt der Block das, statt etwas zu erfinden', async () => {
	const { fetchImpl } = nexus({ ausfall: true });
	assert.deepEqual(await getNexusProductFacts('Aave v3', { fetchImpl }), { PRODUCT_RESOLUTION: 'UNAVAILABLE', reason: 'CATALOG_UNAVAILABLE' });
	_test.reset();
	const ohneKapazitaet = nexus({ kapazitaetAusfall: true });
	const facts = await getNexusProductFacts('Aave v3', { fetchImpl: ohneKapazitaet.fetchImpl });
	assert.equal(facts.LIVE_FACTS.status, 'UNAVAILABLE');
	assert.equal(facts.AUTHORITATIVE_WORDING.status, 'AVAILABLE');
});

test('der Bot bekommt keine Bewertungen und keinen Verkaufsweg mehr', () => {
	const alles = `${productKnowledge}\n${nexusBasics}`;
	for (const verboten of [/Raccoon Score/i, /gap check/i, /analysis page/i, /Coverraccoon API/i, /checkout link/i]) {
		assert.doesNotMatch(alles, verboten);
	}
	assert.match(nexusBasics, /not an insurance company/);
	assert.match(nexusBasics, /does not establish statutory rights/);
	assert.doesNotMatch(nexusBasics, /do not have a legal right to a claim payout/);
});

// Explicitly synthetic additions exercise catalogue-name collisions.
async function collisionCatalog() {
	const { fetchImpl } = nexus();
	return getCatalog(async (url) => String(url).endsWith('/v2/products')
		? { ok: true, json: async () => [...PRODUCTS,
			{ id: 900001, name: 'Aave v4', productType: 0 },
			{ id: 900002, name: 'Current', productType: 0 },
			{ id: 900003, name: 'Exactly', productType: 0, isDeprecated: true }
		] } : fetchImpl(url));
}

test('ordinary current/exactly words cannot select catalogue names or hide Aave', async () => {
	const catalog = await collisionCatalog();
	for (const question of ['What is the current capacity and premium for Aave?', 'Aave current capacity', 'Aave']) {
		assert.deepEqual(matchProducts(question, catalog).map((p) => p.name), ['Aave v3', 'Aave v4']);
	}
	assert.deepEqual(matchProducts('Confirm this costs exactly 0.001%', catalog), []);
	assert.deepEqual(matchProducts('currently or inexactly', catalog), []);
});

test('ambiguous names require explicit product references with token boundaries', async () => {
	const catalog = await collisionCatalog();
	for (const phrase of ['Current cover', 'Current product', 'product Current', 'cover Current']) {
		assert.deepEqual(matchProducts(`Tell me about ${phrase}`, catalog).map((p) => p.name), ['Current']);
	}
	assert.deepEqual(matchProducts('Tell me about product Exactly', catalog).map((p) => p.name), ['Exactly']);
	assert.deepEqual(matchProducts('Tell me about product Currently', catalog), []);
});

test('explicit unrelated product does not suppress a named protocol family', async () => {
	const catalog = await collisionCatalog();
	assert.deepEqual(matchProducts('Current cover and Aave', catalog).map((p) => p.name), ['Aave v3', 'Aave v4', 'Current']);
	assert.deepEqual(matchProducts('Aave v3 current capacity', catalog).map((p) => p.name), ['Aave v3']);
});

test('unresolved candidates expose identity only and never fetch capacity', async () => {
	const catalog = await collisionCatalog();
	const calls = [];
	const facts = await getNexusProductFacts('What is the current capacity and premium for Aave?', {
		fetchImpl: async (url) => { calls.push(url); throw new Error('No capacity request permitted'); }
	});
	for (const product of catalog.filter((p) => ['Aave v3', 'Aave v4'].includes(p.name))) {
		assert.ok(facts.CANDIDATES.some(p => p.productId === product.id && p.officialName === product.name));
	}
	assert.equal(facts.PRODUCT_RESOLUTION, 'AMBIGUOUS');
	assert.deepEqual(Object.keys(facts).sort(), ['CANDIDATES', 'PRODUCT_RESOLUTION']);
	assert.deepEqual(calls, []);
});

test('selected product keeps capacity bound to its ID; mismatched ID is unavailable', async () => {
	await collisionCatalog();
	const calls = [];
	const facts = await getNexusProductFacts('Aave v3', { fetchImpl: async (url) => {
		calls.push(String(url));
		return { ok: true, json: async () => ({ ...CAPACITY, productId: 900002 }) };
	} });
	assert.deepEqual(calls, ['https://api.nexusmutual.io/v2/capacity/97']);
	assert.equal(facts.LIVE_FACTS.status, 'UNAVAILABLE');
	assert.equal(facts.LIVE_FACTS.pricing, undefined);
});

test('canonical resolver exposes explicit states and catalogue-derived identity', async () => {
	const { resolveProduct } = await import('../src/nexus-facts.mjs');
	const catalog = await collisionCatalog();
	const aave = resolveProduct('current capacity for Aave', catalog);
	assert.equal(aave.state, 'AMBIGUOUS');
	assert.deepEqual(aave.candidates.map(p => p.officialName), ['Aave v3', 'Aave v4']);
	for (const name of ['Aave v3', 'Aave v4', 'Current cover', 'product Exactly']) {
		const resolved = resolveProduct(name, catalog);
		assert.equal(resolved.state, 'UNAMBIGUOUS');
		assert.equal(resolved.productId, resolved.product.productId);
		assert.ok(resolved.product.aliases.includes(resolved.product.normalizedName));
	}
	for (const q of ['exactly 1%', 'Current market capacity', 'Sky investment']) {
		assert.deepEqual(resolveProduct(q, catalog), { state: 'NO_MATCH' });
	}
});

test('canonical facts preserve source timestamps across cache hits and never mix products', async () => {
	await collisionCatalog();
	const calls = [];
	const fetchImpl = async url => {
		const id = Number(String(url).split('/').pop()); calls.push(id);
		return { ok: true, json: async () => ({ ...CAPACITY, productId: id, minAnnualPrice: id === 97 ? '0.01' : '0.02', maxAnnualPrice: '0.03' }) };
	};
	const start = Date.now();
	const v3 = await getNexusProductFacts('Aave v3', { fetchImpl, now: start });
	const v4 = await getNexusProductFacts('Aave v4', { fetchImpl, now: start + 1 });
	const cached = await getNexusProductFacts('Aave v3', { fetchImpl, now: start + 1000 });
	assert.equal(v3.LIVE_FACTS.pricing.minAnnualPricePct, 1);
	assert.equal(v4.LIVE_FACTS.pricing.minAnnualPricePct, 2);
	assert.deepEqual(cached.LIVE_FACTS, v3.LIVE_FACTS);
	assert.deepEqual(calls, [97, 900001]);
	for (const context of [v3, v4]) {
		assert.equal(context.LIVE_FACTS.productId, context.PRODUCT_IDENTITY.productId);
		assert.equal(context.AUTHORITATIVE_WORDING.productId, context.PRODUCT_IDENTITY.productId);
		assert.equal(context.LIVE_FACTS.officialName, context.PRODUCT_IDENTITY.officialName);
		assert.ok(context.LIVE_FACTS.sourceEndpoint.endsWith('/' + context.PRODUCT_IDENTITY.productId));
		assert.ok(context.LIVE_FACTS.fetchedAt);
		assert.equal(context.CANDIDATES, undefined);
	}
});

test('missing wording fails closed without fetching or exposing price/capacity', async () => {
	const calls = [];
	const facts = await getNexusProductFacts('Aave v3', { fetchImpl: async url => {
		calls.push(String(url));
		return { ok: true, json: async () => String(url).endsWith('/v2/products') ? PRODUCTS : [{ ...TYPES[0], metadata: 'invalid CID' }] };
	} });
	assert.equal(facts.verification, 'WORDING_UNAVAILABLE');
	assert.equal(facts.AUTHORITATIVE_WORDING.status, 'UNAVAILABLE');
	assert.equal(facts.LIVE_FACTS.status, 'UNAVAILABLE');
	assert.ok(calls.every(url => !url.includes('/capacity/')));
});

test('invalid prices or amounts never enter verified facts', async () => {
	const { getProductFactsById } = await import('../src/nexus-facts.mjs');
	for (const patch of [{ minAnnualPrice: null }, { availableCapacity: [{ amount: '-1', asset: { symbol: 'ETH', decimals: 18 } }] }]) {
		await assert.rejects(getProductFactsById(97, async () => ({ ok: true, json: async () => ({ ...CAPACITY, ...patch }) })));
	}
});

test('canonical capacity intersects exact normalized cover assets while preserving raw provenance', async () => {
	const { getProductFactsById } = await import('../src/nexus-facts.mjs');
	const snapshot = {
		productId: 438,
		availableCapacity: ['ETH', 'DAI', 'USDC', 'cbBTC', 'NXM'].map(symbol => ({ amount: '123', asset: { symbol, decimals: 0 } })),
		minAnnualPrice: '0.0347', maxAnnualPrice: '0.0347'
	};
	const before = structuredClone(snapshot);
	const fetchImpl = async url => ({ ok: true, json: async () =>
		String(url).endsWith('/v2/products') ? [{ id: 438, name: 'Current', productType: 0, coverAssets: [' eth ', 'USDC', 'cbBTC'].map(assetSymbol => ({ assetSymbol })) }]
		: String(url).endsWith('/v2/product-types') ? TYPES : snapshot
	});
	const context = await getNexusProductFacts('Current cover', { fetchImpl });
	assert.deepEqual(context.LIVE_FACTS.capacity.map(c => c.symbol), ['ETH', 'USDC', 'cbBTC']);
	assert.equal(context.LIVE_FACTS.productId, 438);
	assert.equal(context.PRODUCT_IDENTITY.productId, 438);
	assert.deepEqual(context.LIVE_FACTS.pricing, { minAnnualPricePct: 3.47, maxAnnualPricePct: 3.47 });
	assert.equal(context.LIVE_FACTS.rawSnapshot, undefined, 'raw unsupported assets never sent to model');
	const stored = await getProductFactsById(438, fetchImpl);
	assert.deepEqual(stored.rawSnapshot, before);
	assert.deepEqual(snapshot, before, 'original response unchanged');
	assert.ok(stored.rawSnapshot.availableCapacity.some(c => c.asset.symbol === 'DAI'));
	assert.ok(stored.rawSnapshot.availableCapacity.some(c => c.asset.symbol === 'NXM'));
});

test('supported DAI stays available and missing/empty coverAssets fail closed', async () => {
	for (const coverAssets of [[{ assetSymbol: 'DAI' }], [], undefined]) {
		_test.reset();
		const context = await getNexusProductFacts('Current cover', { fetchImpl: async url => ({ ok: true, json: async () =>
			String(url).endsWith('/v2/products') ? [{ id: 438, name: 'Current', productType: 0, coverAssets }]
			: String(url).endsWith('/v2/product-types') ? TYPES
			: { productId: 438, availableCapacity: ['DAI', 'NXM'].map(symbol => ({ amount: '123', asset: { symbol, decimals: 0 } })), minAnnualPrice: '0.01', maxAnnualPrice: '0.02' }
		}) });
		assert.deepEqual(context.LIVE_FACTS.capacity, coverAssets?.length ? [{ symbol: 'DAI', amount: 123 }] : []);
		assert.equal(context.LIVE_FACTS.capacityStatus, coverAssets?.length ? 'AVAILABLE' : 'UNAVAILABLE');
		assert.equal(context.LIVE_FACTS.productId, 438);
	}
});
