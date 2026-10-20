/**
 * Nexus P3 (18.10.2026): die Cover-Anzeige im Dashboard (web/src/nexus-cover.js).
 *
 * Laeuft im aufzeichnenden Mini-DOM (test-support/recording-dom.mjs): jede
 * Markup-Senke wirft, jede URL wird protokolliert. Ein aufzeichnender
 * Wallet-Provider (window.ethereum) haelt fest, ob die Anzeige je eine
 * Wallet-Methode aufruft - sie darf es nie.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingDom } from '../test-support/recording-dom.mjs';

const NOW = Date.UTC(2026, 9, 18, 12);
const WORDING = 'https://api.nexusmutual.io/ipfs/QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY';
const DISCLAIMER = 'Suggested cover amount is an estimate based on detected economic exposure. It does not guarantee that the same amount would be payable in a claim. Nexus Mutual terms and claim assessment govern.';

const DETAILS = {
	ok: true, available: true, status: 'AVAILABLE', provider: 'Nexus Mutual', productName: 'Aave v3', productTypeName: 'Single Protocol Cover',
	position: { protocol: 'Aave v3', network: 'Ethereum', market: 'Core', deploymentKey: 'aave-v3-ethereum-core' },
	exposure: { calculationMethod: 'AAVE_NET_EXPOSURE_V1', currency: 'USD', grossExposure: '26000.62345678', debt: '6000.00000001', suggestedExposure: '20000.62345677', disclaimers: ['SUGGESTED_AMOUNT_ONLY'] },
	assets: [
		{ symbol: 'ETH', decimals: 18, selectable: true, capacity: '3671.27', maxFromExposure: '5.0001558641925', maxAmount: '5.0001558641925', limitedBy: 'EXPOSURE', conversion: { referenceToken: 'WETH', priceUsd: '4000' } },
		{ symbol: 'USDC', decimals: 6, selectable: true, capacity: '8712444.805266', maxFromExposure: '20000.623456', maxAmount: '20000.623456', limitedBy: 'EXPOSURE', conversion: { referenceToken: 'USDC', priceUsd: '1' } },
		{ symbol: 'cbBTC', decimals: 8, selectable: false, reason: 'PRICE_UNAVAILABLE', capacity: '107.18' }
	],
	periodDays: { min: 28, max: 365, presets: [30, 90, 180, 365] },
	proofOfLoss: { inputTypes: ['address'] }, gracePeriodDays: 35,
	wording: { cid: 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY', url: WORDING }, annex: null, quoteTtlSeconds: 60
};
const QUOTE = { provider: 'Nexus Mutual', productName: 'Aave v3', productTypeName: 'Single Protocol Cover', coverAsset: 'ETH', coverAmount: '1', periodDays: 90, premium: '0.009', premiumAsset: 'ETH', annualPricePercent: '3.65', quoteFetchedAt: new Date(NOW).toISOString(), quoteExpiresAt: new Date(NOW + 60_000).toISOString(), freshness: 'FRESH' };

async function mount({ details = DETAILS, quote = QUOTE, language = 'en', quoteStatus = 200 } = {}) {
	const dom = createRecordingDom();
	const walletCalls = [];
	globalThis.document = dom.document;
	globalThis.window = { ethereum: { request: async (args) => { walletCalls.push(args); return null; }, on() {}, removeListener() {} } };
	const { createCoverPanel } = await import('../web/src/nexus-cover.js');
	const posts = [];
	const timers = [];
	let clock = NOW;
	const panel = createCoverPanel({
		deploymentKey: 'aave-v3-ethereum-core', language, now: () => clock, setTimer: (fn, ms) => timers.push({ fn, ms }),
		post: async (body) => {
			posts.push(body);
			if (body.action === 'details') return { status: 200, body: details };
			return quoteStatus === 200 ? { status: 200, body: { ok: true, status: 'QUOTED', quote } } : { status: quoteStatus, body: { ok: false, code: 'QUOTE_UNAVAILABLE' } };
		}
	});
	dom.document.body.appendChild(panel.element);
	await panel.load();
	const byClass = (name) => dom.all().filter((el) => el.classList.contains(name));
	const button = (label) => dom.all().find((el) => el.tagName === 'BUTTON' && el.textContent === label);
	return { dom, panel, posts, walletCalls, timers, byClass, button, text: () => panel.element.textContent, advance: (ms) => { clock += ms; } };
}

test('VIEW details show provider, product, exposure, suggested amount, capacity, proof of loss, grace period, terms and the disclaimer', async () => {
	const { text, dom, posts } = await mount();
	const all = text();
	for (const part of ['Nexus Mutual', 'Aave v3 · Single Protocol Cover', 'Position protocol', 'Ethereum', '20000.62345677 USD', 'Suggested cover amount', '5.0001558641925 ETH', 'Available capacity', '3671.27 ETH',
		'Proof of loss requirement', 'Wallet address(es) must be designated when cover is purchased.', 'Grace period', '35 days', 'Cover wording (Nexus Mutual)', DISCLAIMER, 'Get quote']) {
		assert.ok(all.includes(part), `missing: ${part}`);
	}
	assert.deepEqual(posts, [{ action: 'details', deploymentKey: 'aave-v3-ethereum-core' }]);
	assert.deepEqual(dom.log.urls.map((u) => u.value), [WORDING], 'only the validated wording link');
	assert.ok(!all.includes('Product annex'), 'no annex for product 97');
	assert.deepEqual(dom.all().filter((el) => el.tagName === 'BUTTON').map((el) => el.textContent), ['ETH', 'USDC', '30 days', '90 days', '180 days', '365 days', 'Get quote'], 'cbBTC without a trusted price is not offered');
	assert.doesNotMatch(all, /\b(Buy|Purchase|Insure now)\b|fully insured|guaranteed payout|covered loss|approved claim/i);
	assert.equal(dom.log.violations.length, 0);});

test('VIEW Aave figures and the purchase stop: supplied, debt, exposure, and cover through CoverRaccoon not available - also without a readiness field', async () => {
	for (const details of [DETAILS, { ...DETAILS, readiness: { status: 'BLOCKED', reasons: ['NEXUS_TERMS_UNCONFIRMED', 'NEXUS_PROOF_OF_LOSS_UNCONFIRMED', 'WALLET_EXECUTION_NOT_AVAILABLE'] } }]) {
		const view = await mount({ details });
		const all = view.text();
		for (const part of ['Supplied', '26000.62345678 USD', 'Debt', '6000.00000001 USD', 'Suggested exposure (deposits − debt)', '20000.62345677 USD', 'Cover through CoverRaccoon', 'Not available yet',
			'We are finalising the required Nexus Mutual terms and proof-of-loss flow before enabling wallet confirmations.']) assert.ok(all.includes(part), `missing: ${part}`);
		view.button('Get quote').click();
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(view.text().includes('For information only. Cover cannot be taken out through CoverRaccoon yet.'));
		assert.equal(view.dom.all().filter((el) => el.tagName === 'BUTTON').at(-1).textContent, 'Get quote', 'the quote is the last action; nothing after it');
		assert.deepEqual(view.walletCalls, []);
	}
	const de = await mount({ language: 'de' });
	assert.match(de.text(), /Abschluss über CoverRaccoonNoch nicht möglich/);
	assert.match(de.text(), /Einlagen26000\.62345678 USD/);
	const lido = await mount({ details: { ok: true, available: false, status: 'AMBIGUOUS' }, language: 'de' });
	assert.match(lido.text(), /Für diesen Markt gibt es noch keine Cover-Zuordnung\./);
});

test('VIEW German texts carry the same disclaimer and proof-of-loss information', async () => {
	const { text } = await mount({ language: 'de' });
	assert.match(text(), /garantiert nicht, dass im Schadensfall derselbe Betrag ausgezahlt würde\. Es gelten die Bedingungen und die Schadensprüfung von Nexus Mutual\./);
	assert.match(text(), /Beim Abschluss des Covers müssen Wallet-Adresse\(n\) angegeben werden\./);
	assert.match(text(), /Quote abrufen/);
});

test('VIEW get quote sends only project inputs, shows premium and annual price, then marks the quote stale', async () => {
	const view = await mount();
	view.button('90 days').click();
	view.button('Get quote').click();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(view.posts.at(-1), { action: 'quote', deploymentKey: 'aave-v3-ethereum-core', coverAsset: 'ETH', amount: '5.0001558641925', periodDays: 90 });
	assert.ok(!('productId' in view.posts.at(-1)));
	const all = view.text();
	for (const part of ['Indicative live quote from Nexus Mutual.', '1 ETH · 90 days', 'Premium', '0.009 ETH', 'Annual price', '3.65 %', 'Valid until']) assert.ok(all.includes(part), `missing: ${part}`);
	assert.equal(view.timers.length, 1);
	assert.equal(view.timers[0].ms, 60_050);
	view.advance(60_000);
	view.timers[0].fn();
	assert.ok(view.text().includes('This quote has expired. Request a new quote.'));
	assert.ok(!view.text().includes('Indicative live quote from Nexus Mutual.'));
	assert.equal(view.byClass('cover-quote-stale').length, 1);
});

test('VIEW manual duration inside the range works; outside the range is refused without a request', async () => {
	const view = await mount();
	const period = view.dom.all().find((el) => el.classList.contains('cover-period'));
	period.value = '45';
	view.button('Get quote').click();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(view.posts.at(-1).periodDays, 45);
	for (const value of ['27', '366', 'abc', '30.5']) {
		const before = view.posts.length;
		const field = view.dom.all().find((el) => el.classList.contains('cover-period'));
		field.value = value;
		view.button('Get quote').click();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(view.posts.length, before, value);
		assert.ok(view.text().includes('The duration must be between 28 and 365 days.'), value);
	}
});

test('VIEW quote and details never call a wallet method', async () => {
	const view = await mount();
	view.button('USDC').click();
	view.button('Get quote').click();
	await new Promise((resolve) => setImmediate(resolve));
	view.button('ETH').click();
	view.button('Get quote').click();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(view.posts.filter((p) => p.action === 'quote').length, 2);
	assert.deepEqual(view.walletCalls, [], 'no eth_*/wallet_* request from the cover panel');
});

test('VIEW remote strings are text only; unvalidated links are not rendered', async () => {
	const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
	const details = {
		...DETAILS, productName: hostile, productTypeName: '<b>x</b>',
		wording: { url: 'javascript:alert(1)' }, annex: { url: 'https://evil.example/ipfs/QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY' },
		assets: [{ ...DETAILS.assets[0], symbol: '"><svg onload=alert(1)>', capacity: '<i>1</i>' }]
	};
	const view = await mount({ details, quote: { ...QUOTE, premium: '<script>x</script>', coverAsset: hostile } });
	view.button('Get quote').click();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(view.dom.log.violations.length, 0, 'no markup sink used');
	assert.deepEqual(view.dom.log.urls, [], 'neither javascript: nor a foreign host becomes a link');
	assert.ok(view.text().includes(hostile), 'shown verbatim as text');
	assert.ok(!view.dom.all().some((el) => ['IMG', 'SCRIPT', 'SVG', 'B', 'I'].includes(el.tagName)));
	assert.ok(!view.dom.log.attributes.some((a) => /^on/i.test(a.name)));
});

test('VIEW unavailable, ambiguous and unsupported states show only the neutral status', async () => {
	for (const status of ['AMBIGUOUS', 'UNAVAILABLE', 'UNSUPPORTED']) {
		const view = await mount({ details: { ok: true, available: false, status } });
		assert.match(view.text(), status === 'AMBIGUOUS' ? /^Nexus MutualCover mapping is not available for this market yet\.$/ : /Cover availability cannot currently be determined for this position\./);
		assert.doesNotMatch(view.text(), /Get quote|Premium|Aave v3 ·|Suggested/);
		assert.equal(view.button('Get quote'), undefined);
	}
	const failing = await mount({ quoteStatus: 503 });
	failing.button('Get quote').click();
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(failing.text().includes('Nexus Mutual did not return a valid quote right now.'));
	assert.doesNotMatch(failing.text(), /Premium/);
});
