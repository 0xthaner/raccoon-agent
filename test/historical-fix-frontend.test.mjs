/**
 * CRSF Phase 2Q, CR-VERIFY-003: Verhaltenstests fuer die historischen
 * Frontend-Korrekturen AGENT-SEC-F1, F2, W2, W3 und A2 (Frontend-Teil).
 *
 * Bisher waren W2 (Trennen nach der Signatur), W3 (Freigabe entziehen) und A2
 * (Code vor dem Netzaufruf aus der Adresse) nur am Quelltext geprueft. Hier laeuft
 * der ECHTE web/src/main.js im aufzeichnenden Mini-DOM (test-support/browser-world.mjs)
 * mit der echten index.html; ersetzt sind nur Wallet (window.ethereum bzw. ein
 * AppKit-Stummel per import()) und die Server-Antworten.
 *
 * Geprueft wird jeweils das beobachtbare Verhalten der Korrektur:
 *   F1 - die Erfolgsmeldung von finish() entsteht ohne Markup-Senke;
 *   F2 - der "Zurueck zu Telegram"-Verweis entsteht nur aus einem Namen im
 *        Telegram-Format, sonst gibt es keinen Verweis;
 *   W2 - nach der Signatur wird die WalletConnect-Sitzung getrennt (auch bei Fehlschlag);
 *   W3 - nach der Signatur entzieht die Seite der Browser-Wallet die Freigabe;
 *   A2 - der Zugangscode verlaesst die sichtbare Adresse VOR dem Netzaufruf
 *        und wird nur per POST eingeloest;
 *   M-3 (verbleibender Teil von 7207f7e) - AppKit startet ohne Senden, Empfangen,
 *        Tauschen, Onramp, E-Mail- und Social-Login;
 *   0f3a6ef - AppKit bekommt die eigene Schrift (sonst laedt es acht Fremd-Preloads).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from '../test-support/browser-world.mjs';

const WALLET = '0x' + 'ab'.repeat(20);
const SIGNATURE = '0x' + '11'.repeat(65);
const LINK = '?code=LinkCode0123456789abcdef';

function browserWallet() {
	const calls = [];
	return {
		calls, on() {}, removeListener() {},
		async request({ method }) {
			calls.push(method);
			if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [WALLET];
			if (method === 'eth_chainId') return '0x1';
			if (method === 'personal_sign') return SIGNATURE;
			if (method === 'wallet_revokePermissions') return null;
			throw new Error(`unsupported ${method}`);
		}
	};
}

/** AppKit-Stummel: verbindet beim open() sofort WALLET auf Mainnet. */
function appKit() {
	const calls = [];
	const options = [];
	let address = null;
	const listeners = [];
	const provider = { async request({ method }) { calls.push(method); if (method === 'personal_sign') return SIGNATURE; throw new Error(`unsupported ${method}`); } };
	const modal = {
		subscribeWalletConnectUri() {}, getWalletConnectUri: () => ({}),
		subscribeAccount(fn) { listeners.push(fn); return () => {}; },
		async open() { calls.push('open'); address = WALLET; for (const fn of listeners) fn({ isConnected: true, address }); },
		async close() {}, getAddress: () => address, getWalletProvider: () => provider,
		async switchNetwork() {}, getChainId: () => 1, subscribeNetwork: () => () => {},
		async disconnect() { calls.push('disconnect'); address = null; }
	};
	const imports = {
		'@reown/appkit': { createAppKit: (o) => { options.push(o); return modal; } },
		'@reown/appkit-adapter-ethers': { EthersAdapter: class {} },
		'@reown/appkit/networks': { mainnet: { id: 1 } }
	};
	return { calls, imports, options };
}

const linkRoutes = ({ telegramUsername = 'Raccoon_Agent_Bot', verifyOk = true } = {}) => ({
	'GET /api/config': { body: { reownProjectId: 'test-project-id', telegramUsername, anmeldungPausiert: false } },
	'GET /api/link': { body: { ok: true, message: 'Link this wallet for Telegram @alice_owner.', telegram: { target: '@alice_owner', username: 'alice_owner', name: 'Alice' } } },
	'POST /api/link/verify': verifyOk ? { body: { ok: true } } : { status: 409, body: { ok: false, error: 'Verbindungscode wurde bereits verwendet.' } }
});

async function run(page, selector) {
	page.dom.document.querySelector(selector).click();
	for (let i = 0; i < 6; i++) await page.settle();
}
const statusLinks = (page) => page.dom.document.querySelector('#status').querySelectorAll('a').map((a) => a.href);

test('HIST AGENT-SEC-W3 after the signature the page revokes the browser wallet permission (success and failure)', async () => {
	for (const verifyOk of [true, false]) {
		const wallet = browserWallet();
		const page = await loadPage('main.js', { search: LINK, routes: linkRoutes({ verifyOk }), ethereum: wallet });
		await run(page, '#injected');
		const signed = wallet.calls.indexOf('personal_sign');
		assert.ok(signed >= 0, `verifyOk=${verifyOk}: the flow never reached the signature (${wallet.calls.join(',')})`);
		assert.ok(wallet.calls.lastIndexOf('wallet_revokePermissions') > signed, `verifyOk=${verifyOk}: permission not revoked after the signature (${wallet.calls.join(',')})`);
	}
});

test('HIST AGENT-SEC-W2 after the signature the WalletConnect session is disconnected (success and failure)', async () => {
	for (const verifyOk of [true, false]) {
		const kit = appKit();
		const page = await loadPage('main.js', { search: LINK, routes: linkRoutes({ verifyOk }), imports: kit.imports });
		await run(page, '#walletconnect');
		const signed = kit.calls.indexOf('personal_sign');
		assert.ok(signed >= 0, `verifyOk=${verifyOk}: the flow never reached the signature (${kit.calls.join(',')})`);
		assert.ok(kit.calls.lastIndexOf('disconnect') > signed, `verifyOk=${verifyOk}: WalletConnect session left open after the signature (${kit.calls.join(',')})`);
	}
});

test('HIST AGENT-SEC-F1 the link success message is built from elements - no markup sink in finish()', async () => {
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), ethereum: browserWallet() });
	await run(page, '#injected');
	assert.deepEqual(page.dom.log.violations, [], 'finish() used an HTML parsing sink');
	const status = page.dom.document.querySelector('#status');
	assert.equal(status.querySelectorAll('strong').length, 1, `no success heading: ${status.textContent}`);
	assert.ok(statusLinks(page).includes('/'), 'dashboard link missing');
});

test('HIST AGENT-SEC-F2 the back-to-Telegram link exists only for a Telegram-format bot name', async () => {
	const good = await loadPage('main.js', { search: LINK, routes: linkRoutes({ telegramUsername: 'Raccoon_Agent_Bot' }), ethereum: browserWallet() });
	await run(good, '#injected');
	assert.deepEqual(statusLinks(good).sort(), ['/', 'https://t.me/Raccoon_Agent_Bot']);
	for (const hostile of ['evil.example/phish', 'x/../../evil', 'bot?start=steal', 'a b', '@evil#frag']) {
		const page = await loadPage('main.js', { search: LINK, routes: linkRoutes({ telegramUsername: hostile }), ethereum: browserWallet() });
		await run(page, '#injected');
		const status = page.dom.document.querySelector('#status');
		assert.equal(status.querySelectorAll('strong').length, 1, `${hostile}: flow did not finish`);
		assert.deepEqual(statusLinks(page), ['/'], `${JSON.stringify(hostile)} became a link target`);
	}
});

test('HIST AGENT-SEC-A2 the access code leaves the visible URL before the network call and is redeemed only by POST', async () => {
	const page = await loadPage('main.js', { search: '?access=AccessCode0123456789abcdef', routes: {
		'GET /api/config': { body: { reownProjectId: '', telegramUsername: 'Raccoon_Agent_Bot', anmeldungPausiert: false } },
		'POST /api/dashboard': { body: { ok: false, code: 'WALLET_SIGNATURE_REQUIRED', wallet: WALLET } }
	} });
	const cleared = page.events.indexOf('history.replaceState /');
	const redeemed = page.events.indexOf('fetch POST /api/dashboard');
	assert.ok(redeemed >= 0, `access code never redeemed (${page.events.join(' | ')})`);
	assert.ok(cleared >= 0 && cleared < redeemed, `the code stayed in the URL during the network call (${page.events.join(' | ')})`);
	const posts = page.calls.filter((c) => c.key === 'POST /api/dashboard');
	assert.deepEqual(posts.map((c) => JSON.parse(c.body)), [{ access: 'AccessCode0123456789abcdef' }]);
	assert.equal(page.calls.some((c) => c.key.startsWith('GET') && c.url.includes('AccessCode')), false, 'the code went out in a GET URL');
});

test('HIST META-AUDIT M-3 / 0f3a6ef AppKit starts with value-moving features off and with the own font (no third-party preloads)', async () => {
	const kit = appKit();
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), imports: kit.imports });
	await run(page, '#walletconnect');
	assert.equal(kit.options.length, 1, 'AppKit was not created');
	const [options] = kit.options;
	assert.deepEqual(options.features, { analytics: false, email: false, socials: [], send: false, receive: false, swaps: false, onramp: false });
	assert.equal(options.enableCoinbase, false);
	assert.equal(options.basic, true, 'AppKit fetches the remote project configuration, which overrides features');
	assert.match(options.themeVariables?.['--apkt-font-family'] ?? '', /^'Satoshi'/, 'no own font: AppKit preloads fonts.reown.com');
	assert.deepEqual(options.networks.map((n) => n.id), [1]);
});
