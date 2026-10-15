/*
	Vercel Web Analytics (15.10.2026): URLs tragen Einmalgeheimnisse (?access=,
	?code=, Safe-Parameter). Vor dem Senden geht nur Origin + Pfad raus.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { redactAnalyticsUrl, analyticsBeforeSend, startAnalytics } from '../web/src/analytics.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('every query string and fragment is removed before sending - access codes, link codes, Safe parameters', () => {
	const cases = {
		'https://coverraccoon.com/?access=SECRETaccessCODE123': 'https://coverraccoon.com/',
		'https://coverraccoon.com/link?code=SafeLinkCodeForM3_012345': 'https://coverraccoon.com/link',
		'https://coverraccoon.com/?appUrl=https%3A%2F%2Fcoverraccoon.com&safe=eth:0xabc#x': 'https://coverraccoon.com/',
		'https://coverraccoon.com/guide#start': 'https://coverraccoon.com/guide',
		'https://coverraccoon.com/datenschutz.html?ref=telegram': 'https://coverraccoon.com/datenschutz.html'
	};
	for (const [input, expected] of Object.entries(cases)) {
		assert.equal(redactAnalyticsUrl(input), expected, input);
		const sent = analyticsBeforeSend({ type: 'pageview', url: input });
		assert.equal(sent.url, expected);
		for (const secret of ['SECRETaccessCODE123', 'SafeLinkCodeForM3_012345', '0xabc', 'telegram']) assert.equal(sent.url.includes(secret), false, secret);
	}
});

test('unusable URLs are not sent at all', () => {
	for (const bad of [undefined, null, '', 'not a url', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
		assert.equal(analyticsBeforeSend({ type: 'pageview', url: bad }), null, String(bad));
	}
});

test('startAnalytics wires exactly this beforeSend into @vercel/analytics', () => {
	const calls = [];
	startAnalytics((options) => calls.push(options));
	assert.equal(calls.length, 1);
	assert.equal(calls[0].beforeSend, analyticsBeforeSend);
});

test('both page entries start analytics; no inline script and no CSP change needed', () => {
	assert.match(read('web/src/main.js'), /^import \{ startAnalytics \} from '\.\/analytics\.js';$/m);
	assert.match(read('web/src/main.js'), /^startAnalytics\(\);/m);
	assert.match(read('web/src/guide.js'), /^startAnalytics\(\);/m);
	const vercel = JSON.parse(read('vercel.json'));
	for (const rule of vercel.headers) for (const h of rule.headers) {
		if (h.key === 'Content-Security-Policy') assert.match(h.value, /script-src 'self';/);
	}
	assert.equal(JSON.parse(read('package.json')).dependencies['@vercel/analytics'], '2.0.1', 'exakt gepinnt');
});

test('the privacy policy discloses the page-view statistics and no longer promises "no reach analysis"', () => {
	const policy = read('web/datenschutz.html');
	assert.equal(policy.includes('Keine Werbe- oder Reichweitenanalyse'), false);
	assert.match(policy, /Vercel Web Analytics/);
	assert.match(policy, /Reichweitenmessung:<\/strong>[^<]*Art\. 6 Abs\. 1 lit\. f DSGVO/);
	assert.match(policy, /entfernen wir vor dem Senden/);
});
