/*
	Dashboard-Neugestaltung (20.10.2026): Navigation, Uebersicht, Positionstabelle,
	Covers, Agent und Einstellungen (web/src/dashboard-shell.js, web/index.html).

	Zwei Arten von Zusagen:
	  - DASH-GUARD: die Neugestaltung ist reine Darstellung. Die Schale importiert
	    nichts, fragt kein Netz und keine Wallet an; im ganzen Browser-Code gibt es
	    weiterhin genau dieselben API-Pfade und Wallet-Methoden, und unter api/
	    ist keine Route dazugekommen (insbesondere keine Kauf-Route).
	  - DASH-VIEW: was die Schale aus echten Dashboard-Daten macht - Kennzahlen,
	    Hinweise, Tabelle, Covers - mit der echten main.js im aufzeichnenden DOM,
	    ohne interne Kennungen und ohne Wortwahl, die Deckung oder Schutz verspricht.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { loadPage } from '../test-support/browser-world.mjs';
import { DASHBOARD_VIEWS, EXPIRING_SOON_DAYS, daysLeft, expiringCovers, pastCovers, positionRows, positionStatus, summarize, viewFromHash } from '../web/src/dashboard-shell.js';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const withoutComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const walk = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).flatMap((f) => (statSync(new URL(`../${dir}/${f}`, import.meta.url)).isDirectory() ? walk(`${dir}/${f}`) : [`${dir}/${f}`]));
const shell = withoutComments(read('web/src/dashboard-shell.js'));
const browserFiles = walk('web/src').filter((f) => f.endsWith('.js'));

/* ----------------------------------------------------------- DASH-GUARD -- */

test('DASH-GUARD the dashboard shell imports nothing and calls no network, wallet or storage API', () => {
	assert.doesNotMatch(shell, /^\s*import\s|\bimport\(/m, 'no import');
	assert.doesNotMatch(shell, /\bfetch\b|XMLHttpRequest|WebSocket|sendBeacon|EventSource|\/api\//, 'no network');
	// Gross-/Kleinschreibung zaehlt: "Ethereum" im Anzeigetext ist kein Wallet-Zugriff.
	assert.doesNotMatch(shell, /\.request\(|window\.ethereum|\beth_[a-z]|\bwallet_[a-z]|personal_sign|signTypedData|signMessage|sendTransaction|writeContract|sendCalls|createWalletClient|\.approve\b|\bapprove\(|buyCover|[Pp]urchase/, 'no wallet or purchase');
	assert.doesNotMatch(shell, /localStorage|sessionStorage|indexedDB|document\.cookie/, 'no storage');
	assert.doesNotMatch(shell, /\.(href|src|action|formAction)\s*=|setAttribute\(\s*['"](href|src|action)/, 'no URL sink of its own');
});

test('DASH-GUARD the browser code keeps exactly the known API paths and wallet methods (no purchase or signing addition)', () => {
	const paths = new Set();
	const methods = new Set();
	for (const file of browserFiles) {
		const code = withoutComments(read(file));
		for (const m of code.matchAll(/['"`](\/api\/[a-z0-9/-]+)/g)) paths.add(m[1]);
		for (const m of code.matchAll(/method:\s*['"]([A-Za-z_]+)['"]/g)) methods.add(m[1]);
	}
	assert.deepEqual([...paths].sort(), ['/api/config', '/api/dashboard', '/api/link', '/api/link/verify', '/api/nexus/quote', '/api/position-attributions', '/api/positions']);
	assert.deepEqual([...methods].sort(), ['DELETE', 'POST', 'eth_accounts', 'eth_chainId', 'eth_requestAccounts', 'personal_sign', 'wallet_revokePermissions', 'wallet_switchEthereumChain']);
});

test('DASH-GUARD no new backend route under api/', () => {
	assert.deepEqual(walk('api').sort(), ['api/alerts.mjs', 'api/config.mjs', 'api/csp-report.mjs', 'api/dashboard.mjs', 'api/link.mjs', 'api/link/verify.mjs', 'api/nexus/quote.mjs', 'api/position-attributions.mjs', 'api/positions.mjs', 'api/telegram.mjs']);
	for (const file of walk('api')) assert.doesNotMatch(file, /purchase|buy|checkout|order|execut|transaction|sign/i, file);
});

test('DASH-GUARD main.js uses only the two exported shell entry points; no server module reaches the shell', () => {
	const main = read('web/src/main.js');
	assert.match(main, /^import \{ mountDashboardNav, renderDashboardShell \} from '\.\/dashboard-shell\.js';$/m);
	assert.equal((main.match(/dashboard-shell/g) ?? []).length, 2, 'the import and the comment that names the module');
	for (const file of [...walk('src'), ...walk('api')]) assert.doesNotMatch(read(file), /dashboard-shell/, file);
	// Der Telegram-Link der Agent-Seite entsteht aus demselben, inventarisierten Ausdruck wie der Telegram-Knopf.
	assert.match(main, /for \(const action of \[telegramAction, agentAction\]\.filter\(Boolean\)\)/);
});

/* ------------------------------------------------------------ DASH-VIEW -- */

const WALLET = '0x' + 'cd'.repeat(20);
const NOW = Date.parse('2026-10-20T12:00:00Z');
const inDays = (n) => new Date(NOW + n * 86_400_000).toISOString();
const market = (key, label, state = 'MATCHED') => ({
	deploymentKey: key, label,
	supplied: [{ symbol: 'USDC', amount: '100', usdValue: '100', isCollateral: true }], borrowed: [{ symbol: 'USDT', amount: '10', usdValue: '10' }],
	totals: { suppliedUsd: '100', debtUsd: '10', netUsd: '90', healthFactor: '3' },
	nexus: state === 'MATCHED' ? { state, productId: 97, productName: 'Aave v3' } : { state }
});
const attribution = (entries) => ({ byPosition: new Map(Object.entries(entries).map(([key, state]) => [key, { state, covers: [] }])) });

test('DASH-VIEW the five views and the hash route; anything else falls back to the overview', () => {
	assert.deepEqual(DASHBOARD_VIEWS, ['overview', 'positions', 'covers', 'agent', 'settings']);
	for (const view of DASHBOARD_VIEWS) assert.equal(viewFromHash(`#${view}`), view);
	for (const hash of [undefined, '', '#', '#alerts', '#activity', '#javascript:alert(1)', '#positions/x', 'positions?']) assert.equal(viewFromHash(hash), 'overview', String(hash));
	const html = read('web/index.html');
	const links = [...html.matchAll(/<a class="nav-item" href="#([a-z]+)" data-view-link="([a-z]+)"/g)].map((m) => [m[1], m[2]]);
	assert.deepEqual(links, DASHBOARD_VIEWS.map((v) => [v, v]), 'exactly five navigation links, no Alerts or Activity page');
	for (const view of DASHBOARD_VIEWS) assert.match(html, new RegExp(`id="view-${view}"`));
});

test('DASH-VIEW cover status per position follows the existing attribution only', () => {
	const a = attribution({ auto: 'AUTO_UNAMBIGUOUS', mine: 'USER_CONFIRMED', open: 'USER_CONFIRMATION_REQUIRED', none: 'NO_ACTIVE_COVER' });
	assert.equal(positionStatus(market('auto', 'A'), a), 'ATTRIBUTED');
	assert.equal(positionStatus(market('mine', 'B'), a), 'ATTRIBUTED');
	assert.equal(positionStatus(market('open', 'C'), a), 'CONFIRM');
	assert.equal(positionStatus(market('none', 'D'), a), 'NO_ACTIVE_COVER');
	assert.equal(positionStatus(market('other', 'E'), a), 'UNKNOWN', 'matched product but no attribution entry');
	assert.equal(positionStatus(market('auto', 'A'), null), 'UNKNOWN', 'no attribution yet (e.g. different wallet)');
	for (const state of ['NO_PRODUCT', 'UNSUPPORTED', 'PRODUCT_DEPRECATED']) assert.equal(positionStatus(market('x', 'X', state), a), 'UNAVAILABLE');
	assert.equal(positionStatus(market('x', 'X', 'CATALOG_UNAVAILABLE'), a), 'UNKNOWN');
	assert.equal(positionStatus({ nexus: { state: '<b>' } }, a), 'UNKNOWN');
});

test('DASH-VIEW summary: counts, attention items and unread markets come only from existing data', () => {
	const positionsState = { status: 'ok', data: {
		positions: [market('a', 'Core'), market('b', 'Lido'), market('c', 'Gone', 'NO_PRODUCT')],
		checkedDeployments: [{ label: 'Core', status: 'OK' }, { label: 'Lido', status: 'OK' }, { label: 'EtherFi', status: 'UNAVAILABLE' }]
	} };
	const data = { wallet: WALLET, telegramLinked: false, covers: [
		{ coverId: 1, productId: 97, productName: 'Aave v3', status: 'active', amount: '5', asset: { symbol: 'ETH' }, endsAt: inDays(4) },
		{ coverId: 2, productId: 97, productName: 'Aave v3', status: 'active', amount: '5', asset: { symbol: 'ETH' }, endsAt: inDays(90) },
		{ coverId: 3, productId: 97, productName: 'Aave v3', status: 'expired', amount: '5', asset: { symbol: 'ETH' }, endsAt: inDays(-10) },
		{ coverId: 4, productId: 97, productName: 'Aave v3', status: 'superseded', amount: '5', asset: { symbol: 'ETH' }, endsAt: inDays(-2) }
	] };
	const s = summarize({ data, positionsState, attribution: attribution({ a: 'NO_ACTIVE_COVER', b: 'USER_CONFIRMATION_REQUIRED' }), now: NOW });
	assert.equal(s.positionsDetected, 3);
	assert.equal(s.withoutActiveCover, 2, 'no active cover (a) plus no cover available (c)');
	assert.deepEqual(s.rows.map((r) => r.status), ['NO_ACTIVE_COVER', 'CONFIRM', 'UNAVAILABLE', 'NOT_READ']);
	assert.deepEqual(s.attention.map((i) => i.kind), ['NO_ACTIVE_COVER', 'CONFIRM', 'EXPIRING', 'UNKNOWN', 'TELEGRAM']);
	assert.equal(s.attention[2].cover.coverId, 1);
	assert.deepEqual(expiringCovers(data, NOW).map((e) => [e.cover.coverId, e.days]), [[1, 4]]);
	assert.deepEqual(pastCovers(data).map((c) => c.coverId), [4, 3], 'expired and replaced covers, latest end first');
	assert.equal(EXPIRING_SOON_DAYS, 30);
	assert.equal(daysLeft(inDays(30), NOW), 30);
	assert.equal(daysLeft('not a date', NOW), null);
	// Ohne Positionsdaten keine erfundenen Zahlen.
	for (const status of ['idle', 'loading', 'error']) {
		const empty = summarize({ data: { ...data, telegramLinked: true }, positionsState: { status, data: null }, attribution: null, now: NOW });
		assert.equal(empty.positionsDetected, null, status);
		assert.equal(empty.withoutActiveCover, null, status);
		assert.deepEqual(empty.rows, []);
		assert.equal(empty.attention.some((i) => i.kind === 'UNKNOWN'), status === 'error', status);
		assert.equal(empty.attention.some((i) => i.kind === 'TELEGRAM'), false);
	}
	assert.deepEqual(positionRows({ status: 'ok', data: { positions: 'x', checkedDeployments: null } }, null), [], 'wrong types do not throw');
});

const FORBIDDEN = /verifiziert|verified|versichert|gedeckt|geschützt|abgesichert|insured|covered|protected|guarantee|garantiert|claim eligible|anspruchsberechtigt|Buy|Kaufen|Purchase/i;
const SHELL_NODES = ['#view-overview', '#positions-table', '#positions-lead', '#covers-expiring', '#covers-past', '#covers-note', '#view-agent', '#notify-details', '#view-settings'];

async function dashboardPage({ language = 'en', dashboard, positions }) {
	return loadPage('main.js', { storage: { raccoon_language: language }, routes: {
		'GET /api/config': { body: { ok: true, telegramUsername: 'Raccoon_Agent_Bot', reownProjectId: 'x' } },
		'GET /api/dashboard': { body: dashboard },
		'GET /api/positions': positions ? { body: positions } : { status: 503, body: { ok: false } },
		'GET /api/position-attributions': { body: { ok: true, attributions: [] } }
	} });
}
const text = (page, selector) => page.dom.document.querySelector(selector)?.textContent ?? '';

test('DASH-VIEW the real page renders overview, table, covers, agent and settings as text, without internal identifiers or coverage promises', async () => {
	const dashboard = { ok: true, wallet: WALLET, checkedAt: new Date().toISOString(), telegramLinked: true, agentSettings: { alertThresholds: [7, 0], weeklySummary: true }, covers: [
		{ coverId: 11, productId: 97, productName: 'Aave v3', status: 'active', amount: '10000', asset: { symbol: 'USDC' }, endsAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
		{ coverId: 12, productId: 97, productName: 'Aave v3', status: 'expired', amount: '2', asset: { symbol: 'ETH' }, endsAt: '2026-01-01T00:00:00.000Z' }
	] };
	const positions = { ok: true, wallet: WALLET, complete: true, fetchedAt: new Date().toISOString(),
		positions: [market('aave-v3-ethereum-core', 'Core')], checkedDeployments: [{ deploymentKey: 'aave-v3-ethereum-core', label: 'Core', status: 'OK' }] };
	for (const language of ['en', 'de']) {
		const page = await dashboardPage({ language, dashboard, positions });
		await page.settle();
		assert.equal(text(page, '#metric-positions'), '1', language);
		assert.equal(text(page, '#metric-uncovered'), '0', `${language}: the one position has its one cover (1:1)`);
		assert.match(text(page, '#positions-table'), language === 'en' ? /Aave v3.*Ethereum.*Core.*Cover attributed/ : /Aave v3.*Ethereum.*Core.*Cover zugeordnet/);
		assert.match(text(page, '#attention-list'), /Cover #11/, `${language}: the cover expiring in 5 days`);
		assert.match(text(page, '#covers-expiring'), /Cover #11/);
		assert.match(text(page, '#covers-past'), /Cover #12/);
		assert.match(text(page, '#notify-details'), language === 'en' ? /7 days before, expiry day/ : /7 Tage vorher, Ablauftag/);
		const agent = page.dom.document.querySelector('#agent-action');
		assert.equal(agent.hidden, false);
		assert.equal(agent.href, 'https://t.me/Raccoon_Agent_Bot');
		for (const selector of SHELL_NODES) {
			const value = text(page, selector);
			assert.doesNotMatch(value, /aave-v3-ethereum|deploymentKey|#97|Produkt #|Product #|productId/, `${language} ${selector}: internal identifier`);
			assert.doesNotMatch(value, FORBIDDEN, `${language} ${selector}: ${value.slice(0, 160)}`);
		}
		assert.equal(page.dom.document.querySelector('#view-overview').hidden, false);
		for (const view of ['positions', 'covers', 'agent', 'settings']) assert.equal(page.dom.document.querySelector(`#view-${view}`).hidden, true, view);
	}
});

test('DASH-VIEW without position data the overview shows neutral placeholders, never invented numbers', async () => {
	const page = await dashboardPage({ dashboard: { ok: true, wallet: WALLET, checkedAt: new Date().toISOString(), telegramLinked: false, agentSettings: null, covers: [] } });
	await page.settle();
	assert.equal(text(page, '#metric-positions'), '—');
	assert.equal(text(page, '#metric-uncovered'), '—');
	assert.match(text(page, '#positions-table'), /Positions could not be loaded right now\./);
	assert.match(text(page, '#attention-list'), /not available right now/);
	assert.match(text(page, '#attention-list'), /Telegram expiry reminders are not connected/);
	assert.match(text(page, '#covers-expiring'), /No cover expires within the next 30 days/);
	assert.match(text(page, '#notify-details'), /once Telegram is connected/);
});

test('DASH-VIEW an attention action switches the view through the fixed fragment only', async () => {
	const page = await dashboardPage({ dashboard: { ok: true, wallet: WALLET, checkedAt: new Date().toISOString(), telegramLinked: false, agentSettings: null, covers: [] } });
	await page.settle();
	const buttons = page.dom.all().filter((el) => el.className === 'attention-action');
	assert.ok(buttons.length >= 1);
	assert.equal(buttons.at(-1).tagName, 'BUTTON');
	buttons.at(-1).click();
	assert.equal(page.window.location.hash, 'settings');
	assert.deepEqual(page.dom.log.urls.filter((u) => !/^https:\/\/t\.me\//.test(u.value)), [], 'no other URL written');
});
