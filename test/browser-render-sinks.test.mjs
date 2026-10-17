/**
 * CRSF Phase 2P, CR-BROWSER-004 P1 ("no HTML sinks receive untrusted data") und
 * P2 ("no eval/dynamic code"), zur Laufzeit.
 *
 * Der echte web/src/main.js (und guide.js) laeuft im aufzeichnenden Mini-DOM
 * (test-support/recording-dom.mjs). Jede Antwort, die das Frontend von /api/*
 * liest, ist feindselig: Markup, Ereignis-Attribute, javascript:/data:-Adressen,
 * kodierte Varianten. Durchlaufen werden alle Darstellungswege, die solche Werte
 * erreichen: Dashboard (Covers, Telegram), DeFi-Positionen, Cover-Zuordnungen,
 * Telegram-Verknuepfung (?code=), Dashboard-Link (?access=), Sitzungsfehler,
 * pausierte Anmeldung, Konfiguration.
 *
 * Bewiesen wird je Weg:
 *   - keine Markup-Senke (innerHTML, outerHTML, insertAdjacentHTML, srcdoc,
 *     document.write, createContextualFragment, DOMParser) wird je benutzt;
 *   - Elemente entstehen nur mit festen, harmlosen Tags; kein on*-Attribut;
 *   - jede gesetzte Adresse (href/src/action) ist https auf einem festen Host
 *     (eigene Domain, t.me, app.nexusmutual.io) - nie javascript:/data:/vbscript:;
 *   - die feindseligen Werte erscheinen als TEXT (sie haben den Text-Weg genommen);
 *   - eval, Function und Zeichenketten-Timer werden nie aufgerufen; dynamisches
 *     import() nur mit festen Modulnamen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from '../test-support/browser-world.mjs';

const WALLET = '0x' + 'ab'.repeat(20);
export const HOSTILE = [
	'<script>window.__xss=1</script>',
	'<img src=x onerror=window.__xss=1>',
	'"><svg onload=window.__xss=1>',
	`'"><iframe srcdoc="<script>parent.__xss=1</script>">`,
	'javascript:window.__xss=1',
	'JaVaScRiPt:window.__xss=1',
	' \tjavascript:window.__xss=1',
	'data:text/html,<script>window.__xss=1</script>',
	'vbscript:msgbox(1)',
	'//evil.example/x',
	'&lt;img src=x onerror=1&gt;',
	'%3Cscript%3Ewindow.__xss=1%3C/script%3E',
	'<a href="javascript:window.__xss=1">x</a>',
	'</strong><style>*{}</style>'
];
const SAFE_TAGS = new Set(['div', 'span', 'small', 'strong', 'p', 'a', 'button', 'article', 'section', 'h3', 'h4', 'pre']);
const HOSTS = new Set(['coverraccoon.com', 't.me', 'app.nexusmutual.io']);
const FUTURE = new Date(Date.now() + 20 * 86_400_000).toISOString();

const dashboard = (h, extra = {}) => ({
	ok: true, wallet: WALLET, checkedAt: new Date().toISOString(), telegramLinked: true,
	agentSettings: { alertThresholds: [30, h], weeklySummary: true },
	covers: [
		{ status: 'active', productId: 97, productName: h, coverId: 5, amount: h, asset: { symbol: h }, endsAt: FUTURE },
		{ status: 'active', productId: 97, productName: null, coverId: h, amount: '1', asset: { symbol: 'ETH' }, endsAt: FUTURE }
	],
	...extra
});
const positions = (h) => ({
	ok: true, wallet: WALLET, complete: false,
	positions: [
		{ deploymentKey: h, label: h, nexus: { state: 'MATCHED', productId: 97, productName: h }, supplied: [{ symbol: h, amount: h, usdValue: h, isCollateral: true }], borrowed: [{ symbol: h, amount: '1', usdValue: '1' }], totals: { suppliedUsd: '1', debtUsd: h, netUsd: '0', healthFactor: h } },
		{ deploymentKey: 'aave-v3-ethereum-core', label: h, nexus: { state: 'MATCHED', productId: 97, productName: h }, supplied: [{ symbol: 'USDC', amount: '1', usdValue: '1', isCollateral: false }], borrowed: [], totals: { suppliedUsd: '1', debtUsd: '0', netUsd: '1', healthFactor: null } }
	],
	checkedDeployments: [{ deploymentKey: 'a', label: h, status: 'UNAVAILABLE' }, { deploymentKey: 'b', label: h, status: 'OK' }]
});
const config = (h, paused = false) => ({ ok: true, telegramUsername: h, reownProjectId: h, anmeldungPausiert: paused });

/** Die gemeinsamen Zusagen fuer jeden Lauf. */
function assertTextOnly(page, label, { expectText = [] } = {}) {
	const { log } = page.dom;
	assert.deepEqual(log.violations, [], `${label}: HTML parsing sink used`);
	for (const tag of log.created) assert.ok(SAFE_TAGS.has(tag), `${label}: element <${tag}> created`);
	for (const a of log.attributes) assert.doesNotMatch(a.name, /^on/i, `${label}: event-handler attribute ${a.name}`);
	for (const u of log.urls) {
		const parsed = new URL(u.value, 'https://coverraccoon.com/');
		assert.equal(parsed.protocol, 'https:', `${label}: ${u.attr}=${JSON.stringify(u.value)} is not https (navigation sink)`);
		assert.ok(HOSTS.has(parsed.host), `${label}: ${u.attr}=${JSON.stringify(u.value)} leaves the fixed hosts (navigation sink)`);
	}
	const text = page.dom.textOf();
	for (const t of expectText) assert.ok(text.includes(t), `${label}: hostile value not rendered as text: ${JSON.stringify(t)}`);
	assert.deepEqual(page.code.eval, [], `${label}: eval called`);
	assert.deepEqual(page.code.Function, [], `${label}: Function constructor called`);
	assert.deepEqual(page.code.timers, [], `${label}: string timer`);
	for (const s of page.code.imports) assert.match(s, /^(\.\/[a-z-]+\.js|@reown\/appkit(-adapter-ethers|\/networks)?|@safe-global\/safe-apps-sdk)$/, `${label}: dynamic import of ${s}`);
}

for (const [i, h] of HOSTILE.entries()) {
	test(`BROWSER-RENDER dashboard, positions and attributions with hostile value #${i} render text only`, async () => {
		const page = await loadPage('main.js', { routes: {
			'GET /api/config': { body: config(h) },
			'GET /api/dashboard': { body: dashboard(h) },
			'GET /api/positions': { body: positions(h) },
			'GET /api/position-attributions': { body: { ok: true, attributions: [{ deploymentKey: h, coverId: 5, source: 'user_confirmed' }, { deploymentKey: 'aave-v3-ethereum-core', coverId: 5, source: 'user_confirmed' }] } }
		} });
		await page.settle();
		assertTextOnly(page, `dashboard #${i}`, { expectText: [h] });
		assert.ok(page.calls.some((c) => c.key === 'GET /api/positions'), 'positions were loaded');
		assert.ok(page.dom.log.urls.some((u) => u.value.startsWith('https://app.nexusmutual.io/cover/product/97')), 'nexus link rendered from the fixed table');
	});

	test(`BROWSER-RENDER Telegram link page (?code=) with hostile account and error #${i} renders text only`, async () => {
		const ok = await loadPage('main.js', { search: '?code=LinkCode0123456789abcdef', routes: {
			'GET /api/config': { body: config(h) },
			'GET /api/link': { body: { ok: true, telegram: { target: h, username: h, name: h } } }
		} });
		assertTextOnly(ok, `link #${i}`, { expectText: [h] });
		const failed = await loadPage('main.js', { search: '?code=LinkCode0123456789abcdef', routes: {
			'GET /api/config': { body: config(h, true) },
			'GET /api/link': { body: { ok: false, error: h } }
		} });
		assertTextOnly(failed, `link error #${i}`, { expectText: [h] });
	});

	test(`BROWSER-RENDER dashboard link (?access=) and session errors with hostile values #${i} render text only`, async () => {
		const expired = await loadPage('main.js', { search: '?access=AccessCode0123456789', routes: {
			'GET /api/config': { body: config(h) },
			'POST /api/dashboard': { status: 410, body: { ok: false, error: h } }
		} });
		assertTextOnly(expired, `access expired #${i}`, { expectText: [h] });
		const handoff = await loadPage('main.js', { search: '?access=AccessCode0123456789', routes: {
			'GET /api/config': { body: config(h) },
			'POST /api/dashboard': { body: { ok: false, code: 'WALLET_SIGNATURE_REQUIRED', wallet: `${h}${h}` } }
		} });
		assertTextOnly(handoff, `access handoff #${i}`);
		const restore = await loadPage('main.js', { routes: {
			'GET /api/config': { body: config(h) },
			'GET /api/dashboard': { body: { ok: false, code: 'WALLET_SIGNATURE_REQUIRED', wallet: `${h}${h}` } }
		} });
		assertTextOnly(restore, `restore #${i}`);
	});
}

test('BROWSER-RENDER wrongly typed dashboard fields (hostile id, missing asset, bad date) still never reach a markup sink', async () => {
	for (const h of HOSTILE) {
		const page = await loadPage('main.js', { routes: {
			'GET /api/config': { body: config(h) },
			'GET /api/dashboard': { body: dashboard(h, { covers: [{ status: h, productId: h, productName: h, coverId: [h], amount: { h }, asset: null, endsAt: h }] }) },
			'GET /api/positions': { body: { ...positions(h), positions: [{ deploymentKey: [h], label: [h], nexus: { state: h, productId: h, productName: [h] }, supplied: [{ symbol: [h], amount: { h }, usdValue: h }], borrowed: [], totals: { suppliedUsd: h, debtUsd: h, netUsd: h, healthFactor: h } }] } }
		} });
		await page.settle();
		assertTextOnly(page, `type confusion ${JSON.stringify(h)}`);
	}
});

test('BROWSER-RENDER the Telegram button never leaves https://t.me, whatever /api/config returns', async () => {
	for (const h of [...HOSTILE, 'x@evil.example', 'x/../../evil', '\\\\evil.example', 'x?start=1#']) {
		const page = await loadPage('main.js', { routes: { 'GET /api/config': { body: config(h) }, 'GET /api/dashboard': { body: dashboard('n', { telegramLinked: false }) }, 'GET /api/positions': { body: positions('n') } } });
		await page.settle();
		const tg = page.dom.log.urls.filter((u) => u.value.includes('t.me'));
		assert.ok(tg.length > 0, `${JSON.stringify(h)}: Telegram button rendered`);
		for (const u of tg) assert.equal(new URL(u.value).host, 't.me', `${JSON.stringify(h)}: Telegram link host`);
	}
});

test('BROWSER-RENDER the user guide (guide.js) writes text only', async () => {
	const page = await loadPage('guide.js', { storage: { raccoon_language: 'en' } });
	assertTextOnly(page, 'guide');
});

test('BROWSER-RENDER the recording DOM detects a markup sink (self-check)', async () => {
	const page = await loadPage('guide.js');
	const el = page.dom.document.createElement('div');
	assert.throws(() => { el.innerHTML = '<b>x</b>'; });
	assert.throws(() => page.dom.document.write('<b>x</b>'));
	assert.throws(() => el.insertAdjacentHTML('beforeend', '<b>x</b>'));
	assert.equal(page.dom.log.violations.length, 3);
});
