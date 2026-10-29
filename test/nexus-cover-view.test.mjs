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
import { readFileSync } from 'node:fs';
import { createRecordingDom } from '../test-support/recording-dom.mjs';

const NOW = Date.UTC(2026, 9, 18, 12);
const WORDING = 'https://api.nexusmutual.io/ipfs/QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY';
const DISCLAIMER = 'Suggested cover amount is an estimate based on detected economic exposure. It does not guarantee that the same amount would be payable in a claim. Nexus Mutual terms and claim assessment govern.';

const DETAILS = {
	ok: true, available: true, status: 'AVAILABLE', provider: 'Nexus Mutual', productName: 'Aave v3', productTypeName: 'Single Protocol Cover',
	position: { protocol: 'Aave v3', network: 'Ethereum', market: 'Core', deploymentKey: 'aave-v3-ethereum-core' },
	exposure: { calculationMethod: 'AAVE_NET_EXPOSURE_V1', currency: 'USD', grossExposure: '26000.62345678', debt: '6000.00000001', suggestedExposure: '20000.62345677', disclaimers: ['SUGGESTED_AMOUNT_ONLY'] },
	assets: [
		{ symbol: 'ETH', decimals: 18, selectable: true, capacity: '3671.27', quoteMax: '3671.27', maxFromExposure: '5.0001558641925', suggestedAmount: '5.0001558641925', suggestedLimitedBy: 'EXPOSURE', conversion: { referenceToken: 'WETH', priceUsd: '4000' } },
		{ symbol: 'USDC', decimals: 6, selectable: true, capacity: '8712444.805266', quoteMax: '8712444.805266', maxFromExposure: '20000.623456', suggestedAmount: '20000.623456', suggestedLimitedBy: 'EXPOSURE', conversion: { referenceToken: 'USDC', priceUsd: '1' } },
		{ symbol: 'cbBTC', decimals: 8, selectable: false, reason: 'PRICE_UNAVAILABLE', capacity: '107.18' }
	],
	periodDays: { min: 28, max: 365, presets: [30, 90, 180, 365] },
	proofOfLoss: { inputTypes: ['address'] }, gracePeriodDays: 35,
	wording: { cid: 'QmQQ88vaZkgEY9qXKPtq7Se6caSjB2RTqF1GAnBLW1k8EY', url: WORDING }, annex: null, quoteTtlSeconds: 60
};
const QUOTE = { provider: 'Nexus Mutual', productName: 'Aave v3', productTypeName: 'Single Protocol Cover', coverAsset: 'ETH', requestedAmount: '1', offeredAmount: '1.000105426868420486', roundingDelta: '0.000105426868420486', roundingPercent: '0.02', roundingNotice: false, exposureAmount: '5.0001558641925', aboveExposure: false, premiumBasis: 'OFFERED_AMOUNT', periodDays: 90, premium: '0.009', premiumAsset: 'ETH', annualPricePercent: '3.65', quoteFetchedAt: new Date(NOW).toISOString(), quoteExpiresAt: new Date(NOW + 60_000).toISOString(), freshness: 'FRESH' };

async function mount({ details = DETAILS, quote = QUOTE, language = 'en', quoteStatus = 200, quoteCode = 'QUOTE_UNAVAILABLE', errorBody = {} } = {}) {
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
			return quoteStatus === 200 ? { status: 200, body: { ok: true, status: 'QUOTED', quote } } : { status: quoteStatus, body: { ok: false, code: quoteCode, ...errorBody } };
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
		'Proof of loss requirement', 'Wallet address(es) must be designated when cover is purchased.', 'Grace period', '35 days', 'General cover wording (Nexus Mutual, Single Protocol Cover)', DISCLAIMER, 'Get quote']) {
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
		for (const part of ['Supplied', '26000.62345678 USD', 'Debt', '6000.00000001 USD', 'Detected net exposure (deposits − debt)', '20000.62345677 USD', 'Cover through CoverRaccoon', 'Not available yet',
			'We are finalising the required Nexus Mutual terms and proof-of-loss flow before enabling wallet confirmations.']) assert.ok(all.includes(part), `missing: ${part}`);
		view.button('Get quote').click();
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(view.text().includes('For information only. A quote is not insurance cover, and cover cannot be taken out through CoverRaccoon yet.'));
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
	for (const part of ['Indicative live quote from Nexus Mutual.', 'ETH · 90 days', 'Requested cover amount', '1 ETH', 'Cover amount offered by Nexus Mutual', '1.000105426868420486 ETH',
		'Premium (for the offered amount)', '0.009 ETH', 'Annual price', '3.65 %', 'Valid until', 'A quote is not insurance cover']) assert.ok(all.includes(part), `missing: ${part}`);
	assert.ok(!all.includes('Technical rounding'), 'no rounding row at 0.02 %');
	assert.ok(!all.includes('above your detected net exposure'), 'no exposure warning within the exposure');
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
	assert.ok(failing.text().includes('Nexus Mutual could not return a valid quote for this amount right now.'));
	assert.doesNotMatch(failing.text(), /Premium/);
});

/* ------------------------------------------------- Sprache und Kleinbetrag (20.10.2026) -- */

const ENGLISH_LABELS = ['Position protocol', 'Network', 'Supplied', 'Debt', 'Detected net exposure', 'Requested cover amount', 'offered by Nexus', 'Technical rounding', 'not insurance cover', 'Suggested cover amount', 'Converted with the Aave oracle price', 'Available capacity',
	'Proof of loss requirement', 'Grace period', 'Cover through CoverRaccoon', 'Not available yet', 'We are finalising', 'Terms', 'Cover wording', 'Suggested cover amount is an estimate',
	'binding terms', 'Cover asset', 'Cover amount', 'Maximum (Nexus capacity)', 'Duration', 'Get quote', 'Requesting quote', 'Indicative live quote', 'This quote has expired', 'Premium', 'Annual price',
	'Quoted at', 'Valid until', 'For information only', 'days', 'Wallet address(es) must'];
const READINESS = { status: 'BLOCKED', reasons: ['NEXUS_TERMS_UNCONFIRMED', 'NEXUS_PROOF_OF_LOSS_UNCONFIRMED', 'WALLET_EXECUTION_NOT_AVAILABLE'] };

async function quoted(view) {
	const get = view.dom.all().find((el) => el.tagName === 'BUTTON' && el.classList.contains('cover-get-quote'));
	get.click();
	await new Promise((resolve) => setImmediate(resolve));
}

test('VIEW-LANG-DE the whole cover panel is German: figures, readiness, terms, disclaimer, form, quote states and errors', async () => {
	const view = await mount({ language: 'de', details: { ...DETAILS, readiness: READINESS } });
	const before = view.text();
	for (const part of ['Nexus Mutual', 'Aave v3 · Single Protocol Cover', 'Protokoll der Position', 'Netzwerk', 'Einlagen', 'Schulden', 'Erkanntes Netto-Engagement (Einlagen − Schulden)',
		'Vorgeschlagene Cover-Summe', 'Umgerechnet mit dem Aave-Orakelpreis', 'Verfügbare Kapazität', 'Nachweis im Schadensfall', 'Beim Abschluss des Covers müssen Wallet-Adresse(n) angegeben werden.',
		'Nachfrist', '35 Tage', 'Abschluss über CoverRaccoon', 'Noch nicht möglich', 'Wir stellen die erforderlichen Bedingungen', 'Bedingungen', 'Allgemeines Cover-Wording (Nexus Mutual, Single Protocol Cover)',
		'Verbindlich sind die verlinkten Bedingungen', 'Die vorgeschlagene Cover-Summe ist eine Schätzung', 'Cover-Asset', 'Gewünschte Deckungssumme (ETH)', 'Höchstens (Nexus-Kapazität)', '3671.27 ETH', 'Laufzeit (Tage)', '30 Tage', 'Quote abrufen']) {
		assert.ok(before.includes(part), `missing: ${part}`);
	}
	await quoted(view);
	const after = view.text();
	for (const part of ['Unverbindliche Live-Quote von Nexus Mutual.', 'Angefragte Deckungssumme', 'Von Nexus Mutual angebotene Deckungssumme', 'Prämie (für die angebotene Summe)', 'Jahrespreis', 'Abgerufen um', 'Gültig bis', 'Nur zur Information.', 'Eine Quote bedeutet noch keinen Versicherungsschutz']) assert.ok(after.includes(part), `missing: ${part}`);
	view.advance(61_000);
	view.panel.render();
	assert.ok(view.text().includes('Diese Quote ist abgelaufen. Bitte eine neue Quote abrufen.'));
	for (const english of ENGLISH_LABELS) assert.ok(!view.text().includes(english) && !before.includes(english), `English left: ${english}`);
	assert.deepEqual(view.walletCalls, []);
	for (const [code, message] of [['QUOTE_UNAVAILABLE', 'Nexus Mutual konnte für diesen Betrag derzeit keine gültige Quote liefern.'], ['QUOTE_AMOUNT_TOO_SMALL', 'Für diesen sehr kleinen Betrag kann derzeit keine Nexus-Quote erstellt werden.']]) {
		const failing = await mount({ language: 'de', quoteStatus: code === 'QUOTE_UNAVAILABLE' ? 503 : 422, quoteCode: code });
		await quoted(failing);
		assert.ok(failing.text().includes(message), code);
		assert.doesNotMatch(failing.text(), /Prämie|Premium/);
	}
	const loading = await mount({ language: 'de' });
	loading.panel.state.pending = true;
	loading.panel.render();
	assert.ok(loading.text().includes('Quote wird abgerufen …'));
});

test('VIEW-LANG-EN English panel and the two quote error states', async () => {
	const view = await mount({ details: { ...DETAILS, readiness: READINESS } });
	for (const part of ['Position protocol', 'Supplied', 'Debt', 'Cover through CoverRaccoon', 'Not available yet', 'Get quote']) assert.ok(view.text().includes(part), part);
	assert.doesNotMatch(view.text(), /Einlagen|Schulden|Quote abrufen|Noch nicht möglich/);
	const tiny = await mount({ quoteStatus: 422, quoteCode: 'QUOTE_AMOUNT_TOO_SMALL' });
	await quoted(tiny);
	assert.ok(tiny.text().includes('A Nexus quote cannot currently be created for this very small amount.'));
	assert.doesNotMatch(tiny.text(), /capacity is|insufficient capacity|not enough capacity/i, 'no capacity claim');
	assert.deepEqual(tiny.walletCalls, []);
});

test('VIEW-LANG-SWITCH an open panel follows the app language without reloading: quote, inputs and requests stay', async () => {
	const view = await mount({ details: { ...DETAILS, readiness: READINESS } });
	view.button('USDC').click();
	await quoted(view);
	const posts = view.posts.length;
	assert.ok(view.text().includes('Indicative live quote from Nexus Mutual.'));
	view.panel.setLanguage('de');
	assert.ok(view.text().includes('Unverbindliche Live-Quote von Nexus Mutual.'));
	assert.ok(view.text().includes('Abschluss über CoverRaccoon') && view.text().includes('Quote abrufen'));
	for (const english of ['Get quote', 'Supplied', 'Indicative live quote', 'Not available yet']) assert.ok(!view.text().includes(english), english);
	assert.equal(view.panel.state.asset, 'USDC', 'selected asset kept');
	assert.ok(view.panel.state.quote, 'quote kept');
	assert.equal(view.posts.length, posts, 'a language switch sends no request');
	view.panel.setLanguage('en');
	assert.ok(view.text().includes('Get quote') && !view.text().includes('Quote abrufen'));
	view.panel.setLanguage('fr');
	assert.ok(view.text().includes('Get quote'), 'unknown language falls back to English');
	assert.deepEqual(view.walletCalls, []);
});

/* ------------------------------- Freie Quote und Aufrundung (29.10.2026) -- */

const ANNEX = 'https://api.nexusmutual.io/ipfs/QmWAdgxbaPGj6umcoZJk5xwc8K5rxZRSFx5DSyMxNfSkuJ';

test('VIEW-FREE a requested amount above the exposure is allowed in the form, shown with the exposure and a no-cover hint', async () => {
	const above = { ...QUOTE, requestedAmount: '1', offeredAmount: '1.000105426868420486', exposureAmount: '0.0000925205', aboveExposure: true };
	for (const [language, parts] of [
		['en', ['Requested cover amount', '1 ETH', 'Cover amount offered by Nexus Mutual', '1.000105426868420486 ETH', 'Detected net exposure', '0.0000925205 ETH', 'The requested amount is above your detected net exposure. A quote is not insurance cover']],
		['de', ['Angefragte Deckungssumme', 'Von Nexus Mutual angebotene Deckungssumme', 'Erkanntes Netto-Engagement', '0.0000925205 ETH', 'Die angefragte Summe liegt über deinem erkannten Netto-Engagement. Eine Quote bedeutet noch keinen Versicherungsschutz']]
	]) {
		const view = await mount({ language, quote: above });
		view.panel.state.amount = '1';
		view.panel.render();
		await quoted(view);
		assert.equal(view.posts.at(-1).amount, '1', 'the amount above the exposure is sent as typed');
		for (const part of parts) assert.ok(view.text().includes(part), `${language} missing: ${part}`);
		assert.equal(view.byClass('cover-warning').length, 1);
		assert.deepEqual(view.walletCalls, []);
	}
});

test('VIEW-ROUNDING a rounding above 1 % is shown with delta and percent; above 5 % only the error with both amounts, never a premium', async () => {
	const rounded = { ...QUOTE, requestedAmount: '0.005', offeredAmount: '0.0051465', roundingDelta: '0.0001465', roundingPercent: '2.93', roundingNotice: true, premium: '0.0000111672' };
	const view = await mount({ quote: rounded });
	await quoted(view);
	for (const part of ['Technical rounding', '+0.0001465 ETH (+2.93 %)', 'whole pool allocation steps', 'Premium (for the offered amount)', '0.0000111672 ETH']) assert.ok(view.text().includes(part), `missing: ${part}`);
	const de = await mount({ language: 'de', quote: rounded });
	await quoted(de);
	assert.ok(de.text().includes('Technische Aufrundung') && de.text().includes('+2.93 %'));
	const errorBody = { requestedAmount: '0.001', offeredAmount: '0.00119', roundingPercent: '19.00', maxRoundingPercent: '5' };
	const rejected = await mount({ quoteStatus: 422, quoteCode: 'QUOTE_ROUNDING_EXCEEDED', errorBody });
	await quoted(rejected);
	for (const part of ['rounding above 5 %', 'Requested cover amount: 0.001 ETH', 'Cover amount offered by Nexus Mutual: 0.00119 ETH (+19.00 %)']) assert.ok(rejected.text().includes(part), `missing: ${part}`);
	assert.doesNotMatch(rejected.text(), /Premium \(/);
	const hostile = await mount({ quoteStatus: 422, quoteCode: 'QUOTE_ROUNDING_EXCEEDED', errorBody: { ...errorBody, offeredAmount: '<img src=x>' } });
	await quoted(hostile);
	assert.ok(!hostile.text().includes('<img'), 'only plain decimal texts from the server');
});

test('VIEW-TERMS annex and general wording carry distinct labels', async () => {
	const view = await mount({ details: { ...DETAILS, annex: { cid: 'QmWAdgxbaPGj6umcoZJk5xwc8K5rxZRSFx5DSyMxNfSkuJ', url: ANNEX } } });
	assert.deepEqual(view.dom.log.urls.map((u) => u.value), [WORDING, ANNEX]);
	const links = view.byClass('cover-terms-link').map((el) => el.textContent);
	assert.deepEqual(links, ['General cover wording (Nexus Mutual, Single Protocol Cover)', 'Product annex Aave v3 (designated markets)']);
	const de = await mount({ language: 'de', details: { ...DETAILS, annex: { cid: 'QmWAdgxbaPGj6umcoZJk5xwc8K5rxZRSFx5DSyMxNfSkuJ', url: ANNEX } } });
	assert.deepEqual(de.byClass('cover-terms-link').map((el) => el.textContent), ['Allgemeines Cover-Wording (Nexus Mutual, Single Protocol Cover)', 'Produkt-Anhang Aave v3 (bezeichnete Märkte)']);
});

test('VIEW-LANG-WIRING main.js hands the global language to every open cover panel on a DE/EN switch; no second language state', () => {
	const main = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');
	assert.match(main, /applyLanguage\(button\.dataset\.language\);\n\t\/\/[^\n]*\n\tfor \(const panel of \[\.\.\.coverPanels\.values\(\), \.\.\.uniswapPanels\.values\(\)\]\) panel\.setLanguage\(language\);/);
	assert.match(main, /createUniswapPanel\(\{ tokenId, post: nexusQuoteApi\.post, language \}\)/);
	assert.match(main, /createCoverPanel\(\{ deploymentKey: key, post: nexusQuoteApi\.post, language \}\)/);
	const cover = readFileSync(new URL('../web/src/nexus-cover.js', import.meta.url), 'utf8');
	assert.doesNotMatch(cover, /localStorage|navigator\.language|documentElement\.lang|raccoon_language/, 'the panel keeps no language of its own');
	const uniswap = readFileSync(new URL('../web/src/uniswap-cover.js', import.meta.url), 'utf8');
	assert.doesNotMatch(uniswap, /localStorage|navigator\.language|documentElement\.lang|raccoon_language/, 'the Uniswap panel keeps no language of its own');
});
