/*
	Wallet-Timeouts und verspaetete Antworten (24.10.2026). Ein Timeout bricht die
	Anfrage an MetaMask/WalletConnect nicht ab; die Wallet kann spaeter noch
	antworten. Diese Tests halten Wallet-Antworten zurueck, lassen die Zeit mit
	Fake-Timern ablaufen und loesen die Antwort DANACH auf. Eine solche spaete
	Antwort darf weder Challenge noch Signatur noch Login-POST ausloesen.
	Keine echte Wallet, keine echte Signatur, kein Netz.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from '../test-support/browser-world.mjs';
import {
	createLoginAttempts, walletStep, walletErrorMessage, WalletTimeoutError, StaleAttemptError, WALLET_TIMEOUTS,
	eoaLoginTexts, ensureMainnetAccount, ensureAppKitMainnetAccount, guardedChallengeSignSubmit
} from '../web/src/eoa-login.js';

const T = eoaLoginTexts('en');
const WALLET = '0x' + 'ab'.repeat(20);
const SIGNATURE = '0x' + '11'.repeat(65);
const LINK = '?code=LinkCode0123456789abcdef';

function deferred() {
	let resolve, reject;
	const promise = new Promise((a, b) => { resolve = a; reject = b; });
	return { promise, resolve, reject };
}

/* ----------------------------- Bausteine -------------------------------- */

test('walletStep: rechtzeitige Antwort kommt durch', async () => {
	const attempt = createLoginAttempts().begin();
	assert.equal(await walletStep(Promise.resolve('ok'), { attempt, ms: 1000, message: 'zu spaet' }), 'ok');
	assert.equal(attempt.isCurrent(), true);
});

test('walletStep: Timeout beendet den Versuch, die spaete Antwort wird verworfen', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const attempt = createLoginAttempts().begin();
	const wallet = deferred();
	const step = walletStep(wallet.promise, { attempt, ms: WALLET_TIMEOUTS.sign, message: T.signTimeout });
	t.mock.timers.tick(WALLET_TIMEOUTS.sign);
	await assert.rejects(step, (e) => e instanceof WalletTimeoutError && e.message === T.signTimeout);
	assert.equal(attempt.isCurrent(), false);
	wallet.resolve(SIGNATURE); // verspaetet
	await assert.rejects(step, WalletTimeoutError); // bleibt abgelehnt
});

test('walletStep: Antwort fuer einen beendeten Versuch wird zu StaleAttemptError', async () => {
	const versuche = createLoginAttempts();
	const attempt = versuche.begin();
	const wallet = deferred();
	const step = walletStep(wallet.promise, { attempt, ms: 60_000, message: 'x' });
	versuche.invalidate(); // Logout
	wallet.resolve(SIGNATURE);
	await assert.rejects(step, StaleAttemptError);
});

test('walletStep: Timer eines schon beendeten Versuchs meldet keinen Timeout', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const versuche = createLoginAttempts();
	const attempt = versuche.begin();
	const step = walletStep(new Promise(() => {}), { attempt, ms: 60_000, message: 'x' });
	versuche.invalidate();
	t.mock.timers.tick(60_000);
	await assert.rejects(step, StaleAttemptError);
});

test('createLoginAttempts: hoechstens ein Versuch; Entwerten gibt die Sperre erst mit end() frei (M1)', () => {
	const versuche = createLoginAttempts();
	const erster = versuche.begin();
	assert.equal(versuche.begin(), null, 'paralleler Versuch abgewiesen');
	versuche.invalidate(); // Abmelden
	assert.equal(erster.isCurrent(), false, 'sofort entwertet');
	assert.equal(versuche.begin(), null, 'Sperre bleibt, bis das Aufraeumen des alten Versuchs fertig ist');
	erster.end(); // finally des alten Versuchs
	const zweiter = versuche.begin();
	assert.ok(zweiter && zweiter.id !== erster.id);
	erster.end(); // ein doppeltes end() des alten Versuchs gibt die neue Sperre nicht frei
	assert.equal(zweiter.isCurrent(), true);
	assert.equal(versuche.busy, true);
	zweiter.end();
	assert.equal(versuche.busy, false);
});

test('walletStep: Entwerten bricht einen wartenden Schritt sofort ab, auch ohne Wallet-Antwort (M1)', async () => {
	const versuche = createLoginAttempts();
	const attempt = versuche.begin();
	const step = walletStep(new Promise(() => {}), { attempt, ms: 60_000, message: 'x' });
	versuche.invalidate();
	await assert.rejects(step, StaleAttemptError); // ohne Timer-Ablauf
});

test('onIdle: laeuft nach dem Ende eines Versuchs, nicht nach einer Aufraeum-Sperre', () => {
	const versuche = createLoginAttempts();
	let aufrufe = 0;
	versuche.onIdle(() => { aufrufe++; });
	versuche.begin().end();
	assert.equal(aufrufe, 1);
	versuche.begin({ cleanup: true }).end();
	assert.equal(aufrufe, 1, 'kein endloses Wieder-Aufraeumen');
});

test('walletErrorMessage: Timeout, Ablehnung, gesperrt, Netz, Provider-Fehler, eigene Meldung', () => {
	assert.equal(walletErrorMessage(new WalletTimeoutError(T.connectTimeout), T), T.connectTimeout);
	assert.equal(walletErrorMessage(Object.assign(new Error('User rejected the request.'), { code: 4001 }), T), T.rejected);
	assert.equal(walletErrorMessage(Object.assign(new Error("Request of type 'wallet_requestPermissions' already pending"), { code: -32002 }), T), T.locked);
	assert.equal(walletErrorMessage(new TypeError('Failed to fetch'), T), T.network);
	assert.equal(walletErrorMessage(Object.assign(new Error('WebSocket connection closed abnormally'), { code: 1006 }), T), T.network);
	// unbekannter Provider-Fehler: fester Text, kein Provider-Innenleben in der Oberflaeche
	const intern = walletErrorMessage(Object.assign(new Error('Internal JSON-RPC error: secret-stack'), { code: -32603 }), T);
	assert.equal(intern, T.providerError);
	// eigene Meldungen bleiben unveraendert, auch wenn sie "network" enthalten
	for (const eigene of [T.chainChanged, T.switchFailed, T.notMainnet, T.accountChanged, 'Verbindungscode wurde bereits verwendet.']) {
		assert.equal(walletErrorMessage(new Error(eigene), T), eigene);
	}
});

test('ensureMainnetAccount: haengender Netzwechsel endet als Timeout, nicht als "anderes Netz"', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const attempt = createLoginAttempts().begin();
	const calls = [];
	const provider = { request: ({ method }) => { calls.push(method); return method === 'eth_chainId' ? Promise.resolve('0x89') : new Promise(() => {}); } };
	const step = (p) => walletStep(p, { attempt, ms: WALLET_TIMEOUTS.switchChain, message: T.switchTimeout });
	const result = ensureMainnetAccount(provider, WALLET, { texts: T, step });
	await new Promise((r) => setImmediate(r));
	t.mock.timers.tick(WALLET_TIMEOUTS.switchChain);
	await assert.rejects(result, (e) => e.message === T.switchTimeout);
	assert.equal(calls.includes('eth_accounts'), false);
});

test('ensureAppKitMainnetAccount: haengendes switchNetwork endet als Timeout', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const attempt = createLoginAttempts().begin();
	let gelesen = 0;
	const modal = { switchNetwork: () => new Promise(() => {}), getChainId: () => { gelesen++; return 1; }, getAddress: () => WALLET };
	const step = (p) => walletStep(p, { attempt, ms: WALLET_TIMEOUTS.switchChain, message: T.switchTimeout });
	const result = ensureAppKitMainnetAccount({ modal, network: { id: 1 }, expectedAddress: WALLET, texts: T, step });
	t.mock.timers.tick(WALLET_TIMEOUTS.switchChain);
	await assert.rejects(result, (e) => e.message === T.switchTimeout);
	assert.equal(gelesen, 0);
});

test('guardedChallengeSignSubmit: ungueltig gewordener Versuch postet nicht', async () => {
	let gueltig = true;
	let posts = 0;
	await assert.rejects(guardedChallengeSignSubmit({
		texts: T, isCurrent: () => gueltig,
		getChallenge: async () => ({ ok: true, message: 'm', token: 't' }),
		sign: async () => { gueltig = false; return SIGNATURE; },
		submit: async () => { posts++; return { ok: true }; }
	}), StaleAttemptError);
	assert.equal(posts, 0);
});

/* ------------------------ Echte Seite: Browser-Wallet -------------------- */

const linkRoutes = () => ({
	'GET /api/config': { body: { reownProjectId: 'test-project-id', telegramUsername: 'Raccoon_Agent_Bot', anmeldungPausiert: false } },
	'GET /api/link': { body: { ok: true, message: 'Link this wallet for Telegram @alice_owner.', telegram: { target: '@alice_owner', username: 'alice_owner', name: 'Alice' } } },
	'POST /api/link/verify': { body: { ok: true } },
	'POST /api/dashboard': { body: { ok: true, freshSignatureRequired: false } },
	'DELETE /api/dashboard': { body: { ok: true } }
});

const dashboardRoutes = () => ({
	'GET /api/config': { body: { reownProjectId: 'test-project-id', telegramUsername: 'Raccoon_Agent_Bot', anmeldungPausiert: false } },
	'GET /api/dashboard': (url) => url.searchParams.get('wallet')
		? { body: { ok: true, message: 'coverraccoon.com wants you to sign in', token: 'challenge-token' } }
		: { status: 401, body: { ok: false, code: 'NO_SESSION' } },
	'POST /api/dashboard': { status: 401, body: { ok: false, error: 'rejected' } }
});

/** Steuerbare Browser-Wallet: `hold` haelt Antworten zurueck, `fail` lehnt ab. */
function controllableWallet({ chain = '0x1', hold = [], fail = {} } = {}) {
	const calls = [];
	const held = {};
	const listeners = {};
	let chainId = chain;
	return {
		calls, held, listeners,
		on(type, fn) { (listeners[type] ??= []).push(fn); },
		removeListener(type, fn) { listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn); },
		emit(type, value) { for (const fn of listeners[type] ?? []) fn(value); },
		request({ method }) {
			calls.push(method);
			if (fail[method]) return Promise.reject(fail[method]);
			if (hold.includes(method)) { const d = deferred(); (held[method] ??= []).push(d); return d.promise; }
			if (method === 'eth_requestAccounts' || method === 'eth_accounts') return Promise.resolve([WALLET]);
			if (method === 'eth_chainId') return Promise.resolve(chainId);
			if (method === 'wallet_switchEthereumChain') { chainId = '0x1'; return Promise.resolve(null); }
			if (method === 'personal_sign') return Promise.resolve(SIGNATURE);
			if (method === 'wallet_revokePermissions') return Promise.resolve(null);
			return Promise.reject(new Error(`unsupported ${method}`));
		}
	};
}

async function settle(page) { for (let i = 0; i < 6; i++) await page.settle(); }
async function click(page, selector) { page.dom.document.querySelector(selector).click(); await settle(page); }
async function tick(t, page, ms) { t.mock.timers.tick(ms); await settle(page); }
const statusText = (page) => page.dom.document.querySelector('#status').textContent;
const count = (page, key) => page.calls.filter((c) => c.key === key).length;
const methodCount = (wallet, method) => wallet.calls.filter((m) => m === method).length;

test('1/2 erfolgreiche Verbindung und SIWE-Anmeldung: genau eine Signatur, genau ein POST', async () => {
	const wallet = controllableWallet({ chain: '0x89' });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), ethereum: wallet });
	await click(page, '#injected');
	assert.equal(methodCount(wallet, 'personal_sign'), 1);
	assert.equal(count(page, 'POST /api/link/verify'), 1);
	assert.match(statusText(page), /Everything is set up/);
});

test('3/7 eth_requestAccounts haengt: Timeout nach 120 s, spaete Freigabe startet nichts und wird entzogen', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const wallet = controllableWallet({ hold: ['eth_requestAccounts'] });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), ethereum: wallet });
	await click(page, '#injected');
	await tick(t, page, WALLET_TIMEOUTS.connect - 1);
	assert.equal(statusText(page), 'Browser-Wallet wird verbunden …', 'vor Ablauf noch wartend');
	await tick(t, page, 1);
	assert.equal(statusText(page), T.connectTimeout);
	wallet.held.eth_requestAccounts[0].resolve([WALLET]); // verspaetete Freigabe
	await settle(page);
	assert.equal(methodCount(wallet, 'eth_chainId'), 0, 'kein weiterer Schritt');
	assert.equal(methodCount(wallet, 'personal_sign'), 0);
	assert.equal(count(page, 'GET /api/link') - 1, 0, 'keine Challenge (nur die Kontoanzeige beim Laden)');
	assert.equal(count(page, 'POST /api/link/verify'), 0);
	assert.equal(methodCount(wallet, 'wallet_revokePermissions'), 1, 'spaete Freigabe wieder entzogen');
	assert.equal(statusText(page), T.connectTimeout, 'spaete Antwort ueberschreibt die Meldung nicht');
});

test('4 wallet_switchEthereumChain haengt: Timeout nach 60 s, keine Challenge', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const wallet = controllableWallet({ chain: '0x89', hold: ['wallet_switchEthereumChain'] });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), ethereum: wallet });
	await click(page, '#injected');
	await tick(t, page, WALLET_TIMEOUTS.switchChain);
	assert.equal(statusText(page), T.switchTimeout);
	wallet.held.wallet_switchEthereumChain[0].resolve(null);
	await settle(page);
	assert.equal(methodCount(wallet, 'eth_accounts'), 0);
	assert.equal(count(page, 'GET /api/link'), 1);
	assert.equal(methodCount(wallet, 'personal_sign'), 0);
});

test('5/8/16/17 personal_sign haengt: Timeout nach 60 s, spaete Signatur loest keinen POST aus, keine Wiederholung', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const wallet = controllableWallet({ hold: ['personal_sign'] });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), ethereum: wallet });
	await click(page, '#injected');
	assert.equal(methodCount(wallet, 'personal_sign'), 1);
	await tick(t, page, WALLET_TIMEOUTS.sign);
	assert.equal(statusText(page), T.signTimeout);
	wallet.held.personal_sign[0].resolve(SIGNATURE); // verspaetete Signatur
	await settle(page);
	await tick(t, page, 10 * 60_000);
	assert.equal(count(page, 'POST /api/link/verify'), 0, 'kein Login-POST');
	assert.equal(methodCount(wallet, 'personal_sign'), 1, 'keine automatische Wiederholung');
	assert.equal(methodCount(wallet, 'wallet_revokePermissions'), 1, 'Freigabe nach dem Versuch entzogen');
});

test('17 Dashboard: spaete Signatur nach Timeout erzeugt keinen Login-POST', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const wallet = controllableWallet({ hold: ['personal_sign'] });
	const page = await loadPage('main.js', { routes: dashboardRoutes(), ethereum: wallet });
	await click(page, '#injected');
	await tick(t, page, WALLET_TIMEOUTS.sign);
	wallet.held.personal_sign[0].resolve(SIGNATURE);
	await settle(page);
	assert.equal(count(page, 'POST /api/dashboard'), 0);
	assert.equal(statusText(page), T.signTimeout);
});

test('9 Logout waehrend ausstehender Signatur: spaete Antwort meldet nicht an', async () => {
	const wallet = controllableWallet({ hold: ['personal_sign'] });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), ethereum: wallet });
	await click(page, '#injected');
	await click(page, '#logout');
	wallet.held.personal_sign[0].resolve(SIGNATURE);
	await settle(page);
	assert.equal(count(page, 'POST /api/link/verify'), 0);
	assert.equal(count(page, 'DELETE /api/dashboard'), 1);
});

test('9b Timer des abgemeldeten Versuchs ueberschreibt die Statuszeile des neuen Versuchs nicht', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const wallet = controllableWallet({ hold: ['personal_sign', 'eth_requestAccounts'] });
	wallet.held.eth_requestAccounts = [];
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), ethereum: wallet });
	// erster Versuch: Freigabe sofort, Signatur haengt
	await click(page, '#injected');
	wallet.held.eth_requestAccounts[0].resolve([WALLET]);
	await settle(page);
	assert.equal(methodCount(wallet, 'personal_sign'), 1);
	await click(page, '#logout');
	await tick(t, page, 30_000);
	// zweiter Versuch: wartet auf die Freigabe
	await click(page, '#injected');
	assert.equal(statusText(page), 'Browser-Wallet wird verbunden …');
	await tick(t, page, 30_000); // hier laeuft der Signatur-Timer des ersten Versuchs ab
	assert.equal(statusText(page), 'Browser-Wallet wird verbunden …', 'alte Meldung ueberschreibt nicht');
	wallet.held.personal_sign[0].resolve(SIGNATURE);
	wallet.held.eth_requestAccounts[1].resolve([WALLET]);
	await settle(page);
	wallet.held.personal_sign[1].resolve(SIGNATURE);
	await settle(page);
	assert.equal(count(page, 'POST /api/link/verify'), 1, 'nur der neue Versuch meldet an');
});

test('10 Wallet trennt waehrend ausstehender Signatur: spaete Antwort meldet nicht an', async () => {
	const wallet = controllableWallet({ hold: ['personal_sign'] });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), ethereum: wallet });
	await click(page, '#injected');
	wallet.emit('disconnect', { code: 4900 });
	wallet.held.personal_sign[0].resolve(SIGNATURE);
	await settle(page);
	assert.equal(count(page, 'POST /api/link/verify'), 0);
	assert.equal((wallet.listeners.disconnect ?? []).length, 0, 'Listener entfernt');
	assert.equal((wallet.listeners.chainChanged ?? []).length, 0, 'Listener entfernt');
});

test('11/15 nach Timeout ist ein zweiter manueller Versuch moeglich und gelingt', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const wallet = controllableWallet({ hold: ['personal_sign'] });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), ethereum: wallet });
	await click(page, '#injected');
	await tick(t, page, WALLET_TIMEOUTS.sign);
	assert.equal(statusText(page), T.signTimeout);
	assert.equal(page.dom.document.querySelector('#injected').disabled, false);
	wallet.held.personal_sign[0].resolve(SIGNATURE); // alte Antwort verspaetet
	await click(page, '#injected');
	wallet.held.personal_sign[1].resolve(SIGNATURE); // neue Antwort
	await settle(page);
	assert.equal(count(page, 'POST /api/link/verify'), 1, 'genau ein POST - der des neuen Versuchs');
	assert.match(statusText(page), /Everything is set up/);
});

test('12 Nutzer lehnt die Verbindung ab: klare Meldung, keine Challenge, neuer Versuch moeglich', async () => {
	const wallet = controllableWallet({ fail: { eth_requestAccounts: Object.assign(new Error('User rejected the request.'), { code: 4001 }) } });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), ethereum: wallet });
	await click(page, '#injected');
	assert.equal(statusText(page), T.rejected);
	assert.equal(count(page, 'GET /api/link'), 1);
	await click(page, '#injected');
	assert.equal(methodCount(wallet, 'eth_requestAccounts'), 2, 'zweiter Klick startet neu');
});

test('12b Wallet gesperrt bzw. Anfrage offen (-32002): eigene Meldung', async () => {
	const wallet = controllableWallet({ fail: { eth_requestAccounts: Object.assign(new Error('already pending'), { code: -32002 }) } });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), ethereum: wallet });
	await click(page, '#injected');
	assert.equal(statusText(page), T.locked);
});

test('13 Nutzer lehnt die SIWE-Signatur ab: kein POST, keine Wiederholung', async () => {
	const wallet = controllableWallet({ fail: { personal_sign: Object.assign(new Error('User denied message signature.'), { code: 4001 }) } });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), ethereum: wallet });
	await click(page, '#injected');
	assert.equal(statusText(page), T.rejected);
	assert.equal(count(page, 'POST /api/link/verify'), 0);
	assert.equal(methodCount(wallet, 'personal_sign'), 1);
});

test('14 parallele Anmeldeversuche: zweiter Klick startet keinen zweiten Versuch', async () => {
	const wallet = controllableWallet({ hold: ['eth_requestAccounts'] });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), ethereum: wallet });
	await click(page, '#injected');
	await click(page, '#injected');
	await click(page, '#walletconnect');
	assert.equal(methodCount(wallet, 'eth_requestAccounts'), 1);
	assert.equal(statusText(page), T.busy);
	assert.equal(page.code.imports.length, 0, 'WalletConnect wurde gar nicht erst geladen');
	wallet.held.eth_requestAccounts[0].resolve([WALLET]);
	await settle(page);
	assert.equal(count(page, 'POST /api/link/verify'), 1, 'der erste Versuch laeuft regulaer zu Ende');
});

/* --------------------------- Echte Seite: WalletConnect ------------------- */

/** AppKit-Stummel. `connect: false` = die Wallet koppelt nie; `holdSign` haelt personal_sign zurueck. */
function appKit({ connect = true, holdSign = false } = {}) {
	const calls = [];
	const held = [];
	let address = null;
	const listeners = new Set();
	const provider = {
		request({ method }) {
			calls.push(method);
			if (method !== 'personal_sign') return Promise.reject(new Error(`unsupported ${method}`));
			if (!holdSign) return Promise.resolve(SIGNATURE);
			const d = deferred(); held.push(d); return d.promise;
		}
	};
	const modal = {
		subscribeWalletConnectUri() {}, getWalletConnectUri: () => ({}),
		subscribeAccount(fn) { listeners.add(fn); return () => listeners.delete(fn); },
		async open() { calls.push('open'); if (connect) modal.connectNow(); },
		connectNow() { address = WALLET; for (const fn of [...listeners]) fn({ isConnected: true, status: 'connected', address }); },
		async close() { calls.push('close'); }, getAddress: () => address, getWalletProvider: () => provider,
		async switchNetwork() { calls.push('switchNetwork'); }, getChainId: () => 1, subscribeNetwork: () => () => {},
		async disconnect() { calls.push('disconnect'); address = null; }
	};
	const imports = {
		'@reown/appkit': { createAppKit: () => modal },
		'@reown/appkit-adapter-ethers': { EthersAdapter: class {} },
		'@reown/appkit/networks': { mainnet: { id: 1 } }
	};
	return { calls, held, imports, modal, listeners };
}

test('18 WalletConnect-Login funktioniert weiter: Signatur, POST, danach getrennt', async () => {
	const kit = appKit();
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), imports: kit.imports });
	await click(page, '#walletconnect');
	assert.equal(kit.calls.filter((m) => m === 'personal_sign').length, 1);
	assert.equal(count(page, 'POST /api/link/verify'), 1);
	assert.ok(kit.calls.includes('switchNetwork'));
	assert.ok(kit.calls.includes('disconnect'));
	assert.equal(page.dom.document.querySelector('#walletconnect').disabled, false);
});

test('6/15 WalletConnect koppelt nicht: Timeout nach 120 s, Knopf wieder frei, spaete Kopplung signiert nicht', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const kit = appKit({ connect: false });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), imports: kit.imports });
	await click(page, '#walletconnect');
	assert.equal(page.dom.document.querySelector('#walletconnect').disabled, true);
	await tick(t, page, WALLET_TIMEOUTS.connect);
	assert.equal(statusText(page), T.connectTimeout);
	assert.equal(page.dom.document.querySelector('#walletconnect').disabled, false);
	kit.modal.connectNow(); // verspaetete Kopplung
	await settle(page);
	assert.equal(kit.calls.includes('personal_sign'), false);
	assert.equal(count(page, 'POST /api/link/verify'), 0);
	assert.equal(kit.modal.getAddress(), null, 'verspaetete Kopplung sofort getrennt (M2)');
});

test('WalletConnect-Signatur haengt: bestehender 60-s-Timeout, spaete Signatur ohne POST', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const kit = appKit({ holdSign: true });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), imports: kit.imports });
	await click(page, '#walletconnect');
	await tick(t, page, WALLET_TIMEOUTS.sign);
	assert.equal(statusText(page), T.signTimeout);
	kit.held[0].resolve(SIGNATURE);
	await settle(page);
	assert.equal(count(page, 'POST /api/link/verify'), 0);
	assert.equal(kit.calls.filter((m) => m === 'personal_sign').length, 1);
});

test('WalletConnect: Wallet trennt waehrend der Signatur -> spaete Antwort meldet nicht an', async () => {
	const kit = appKit({ holdSign: true });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), imports: kit.imports });
	await click(page, '#walletconnect');
	for (const fn of [...kit.listeners]) fn({ isConnected: false, status: 'disconnected' });
	kit.held[0].resolve(SIGNATURE);
	await settle(page);
	assert.equal(count(page, 'POST /api/link/verify'), 0);
});

test('WalletConnect: kurz fehlende Adresse waehrend switchNetwork bricht nicht ab', async () => {
	const kit = appKit();
	kit.modal.switchNetwork = async () => { for (const fn of [...kit.listeners]) fn({ isConnected: false, status: 'connected' }); };
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), imports: kit.imports });
	await click(page, '#walletconnect');
	assert.equal(count(page, 'POST /api/link/verify'), 1);
});

/* ---------------- Review M1/M2: altes Aufraeumen, verwaiste Sitzung ------- */

/**
 * WalletConnect-Stummel mit echter Trennwirkung: personal_sign scheitert, wenn
 * die Sitzung, ueber die angefragt wurde, inzwischen getrennt ist. Jede Kopplung
 * bekommt eine eigene Sitzungsnummer.
 */
function realisticKit({ connect = true } = {}) {
	const kit = appKit({ connect, holdSign: true });
	let sitzung = 0;
	let aktiv = null;
	const origConnect = kit.modal.connectNow;
	kit.modal.connectNow = () => { aktiv = ++sitzung; kit.calls.push(`pair#${aktiv}`); origConnect(); };
	const origDisconnect = kit.modal.disconnect;
	kit.modal.disconnect = async () => { kit.calls.push(`disconnect#${aktiv}`); aktiv = null; await origDisconnect(); };
	const provider = kit.modal.getWalletProvider();
	const origRequest = provider.request;
	provider.request = (args) => {
		const meine = aktiv;
		return origRequest(args).then((v) => { if (aktiv !== meine || meine === null) throw Object.assign(new Error('session closed'), { code: 4100 }); return v; });
	};
	return { ...kit, aktiveSitzung: () => aktiv };
}

/** Browser-Wallet mit echter Freigabe: personal_sign braucht eine bestehende Freigabe. */
function permissionWallet(opts) {
	const wallet = controllableWallet(opts);
	let freigabe = false;
	const request = wallet.request.bind(wallet);
	wallet.request = (args) => {
		const p = request(args);
		if (args.method === 'eth_requestAccounts') return p.then((v) => { freigabe = true; return v; });
		if (args.method === 'wallet_revokePermissions') { freigabe = false; return p; }
		if (args.method === 'personal_sign') return p.then((v) => { if (!freigabe) throw Object.assign(new Error('Unauthorized'), { code: 4100 }); return v; });
		return p;
	};
	return wallet;
}

test('M1 WalletConnect: Trennen des alten Versuchs trifft die Sitzung des neuen nicht', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const kit = realisticKit();
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), imports: kit.imports });
	await click(page, '#walletconnect');                                                    // Versuch 1: Sitzung #1, Signatur haengt
	for (const fn of [...kit.listeners]) fn({ isConnected: true, status: 'disconnected' }); // Wallet meldet Trennung
	await settle(page);
	assert.equal(statusText(page), T.walletDisconnected, 'sofortige Meldung statt 60 s warten');
	assert.equal(page.dom.document.querySelector('#walletconnect').disabled, false);
	await click(page, '#walletconnect');                                                    // Versuch 2: Sitzung #2
	assert.equal(kit.aktiveSitzung(), 2);
	await tick(t, page, WALLET_TIMEOUTS.sign - 1);                                          // alle alten Timer liefen schon ab oder sind weg
	assert.equal(kit.calls.includes('disconnect#2'), false, 'Sitzung des neuen Versuchs unberuehrt');
	assert.equal(page.dom.document.querySelector('#walletconnect').disabled, true, 'Knopf bleibt waehrend Versuch 2 gesperrt');
	kit.held[1].resolve(SIGNATURE);
	await settle(page);
	assert.equal(count(page, 'POST /api/link/verify'), 1, 'Versuch 2 meldet an');
	assert.equal(kit.aktiveSitzung(), null, 'danach getrennt (W2)');
});

test('M1 Browser-Wallet: Freigabe-Entzug des alten Versuchs trifft den neuen nicht', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const wallet = permissionWallet({ hold: ['personal_sign'] });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), ethereum: wallet });
	await click(page, '#injected');
	wallet.emit('disconnect', { code: 4900 });
	await settle(page);
	assert.equal(statusText(page), T.walletDisconnected);
	assert.equal(methodCount(wallet, 'wallet_revokePermissions'), 1, 'alter Versuch hat schon aufgeraeumt');
	await click(page, '#injected');
	const vorher = methodCount(wallet, 'wallet_revokePermissions');
	await tick(t, page, WALLET_TIMEOUTS.sign - 1);
	assert.equal(methodCount(wallet, 'wallet_revokePermissions'), vorher, 'kein Entzug waehrend Versuch 2');
	wallet.held.personal_sign[1].resolve(SIGNATURE);
	await settle(page);
	assert.equal(count(page, 'POST /api/link/verify'), 1);
});

test('M1 waehrend das Aufraeumen des alten Versuchs laeuft, startet kein neuer', async () => {
	const kit = realisticKit();
	let trennen;
	const origDisconnect = kit.modal.disconnect;
	kit.modal.disconnect = () => new Promise((r) => { trennen = () => origDisconnect().then(r); });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), imports: kit.imports });
	await click(page, '#walletconnect');
	for (const fn of [...kit.listeners]) fn({ isConnected: true, status: 'disconnected' });
	await settle(page);                       // Versuch 1 steht im Trennen
	await click(page, '#injected');
	assert.equal(statusText(page), T.busy);
	trennen();
	await settle(page);
	await click(page, '#walletconnect');
	assert.ok(kit.calls.filter((c) => c === 'open').length >= 2, 'nach dem Aufraeumen wieder moeglich');
});

test('M1 Browser-Wallet: waehrend der alte Versuch die Freigabe entzieht, startet kein neuer', async () => {
	const wallet = permissionWallet({ hold: ['personal_sign', 'wallet_revokePermissions'] });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), ethereum: wallet });
	await click(page, '#injected');
	wallet.emit('disconnect', { code: 4900 });
	await settle(page);                       // alter Versuch steht im Entzug
	assert.equal(methodCount(wallet, 'wallet_revokePermissions'), 1);
	await click(page, '#injected');
	assert.equal(statusText(page), T.busy);
	assert.equal(methodCount(wallet, 'eth_requestAccounts'), 1, 'kein zweites eth_requestAccounts waehrend des Entzugs');
	wallet.held.wallet_revokePermissions[0].resolve(null);
	await settle(page);
	await click(page, '#injected');
	assert.equal(methodCount(wallet, 'eth_requestAccounts'), 2, 'danach wieder moeglich');
});

test('M1 Abmelden scheitert (kein Neuladen): alter Versuch raeumt auf, neuer gelingt', async () => {
	const wallet = permissionWallet({ hold: ['personal_sign'] });
	const routes = { ...linkRoutes(), 'DELETE /api/dashboard': { status: 503, body: { ok: false } } };
	const page = await loadPage('main.js', { search: LINK, routes, ethereum: wallet });
	await click(page, '#injected');
	await click(page, '#logout');
	assert.equal(page.window.location.reloaded, 0);
	assert.equal(methodCount(wallet, 'wallet_revokePermissions'), 1, 'alter Versuch sofort aufgeraeumt');
	await click(page, '#injected');
	wallet.held.personal_sign[0].resolve(SIGNATURE); // spaete Antwort des alten
	wallet.held.personal_sign[1].resolve(SIGNATURE);
	await settle(page);
	assert.equal(count(page, 'POST /api/link/verify'), 1, 'nur der neue Versuch');
});

test('M2 verspaetete Kopplung waehrend ein neuer Browser-Wallet-Versuch laeuft: getrennt, sobald er fertig ist', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const kit = realisticKit({ connect: false });
	const wallet = permissionWallet({ hold: ['personal_sign'] });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), imports: kit.imports, ethereum: wallet });
	await click(page, '#walletconnect');
	await tick(t, page, WALLET_TIMEOUTS.connect);   // WC-Versuch laeuft ab
	await click(page, '#injected');                  // neuer Versuch, haengt an der Signatur
	kit.modal.connectNow();                          // spaete WC-Kopplung, waehrend Versuch 2 laeuft
	await settle(page);
	assert.equal(kit.aktiveSitzung(), 1, 'waehrend Versuch 2 nicht angefasst');
	wallet.held.personal_sign[0].resolve(SIGNATURE);
	await settle(page);
	assert.equal(count(page, 'POST /api/link/verify'), 1);
	assert.equal(kit.aktiveSitzung(), null, 'danach getrennt');
	assert.equal(kit.calls.includes('personal_sign'), false, 'ueber die verwaiste Sitzung wurde nie angefragt');
});

test('M1/M2 spaete Browser-Freigabe waehrend eines WalletConnect-Versuchs: entzogen, sobald er fertig ist', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const kit = realisticKit();
	const wallet = permissionWallet({ hold: ['eth_requestAccounts'] });
	const page = await loadPage('main.js', { search: LINK, routes: linkRoutes(), imports: kit.imports, ethereum: wallet });
	await click(page, '#injected');
	await tick(t, page, WALLET_TIMEOUTS.connect);    // Browser-Versuch laeuft ab
	await click(page, '#walletconnect');             // WC-Versuch, haengt an der Signatur
	wallet.held.eth_requestAccounts[0].resolve([WALLET]); // spaete Freigabe
	await settle(page);
	assert.equal(methodCount(wallet, 'wallet_revokePermissions'), 0, 'waehrend des WC-Versuchs nicht');
	kit.held[0].resolve(SIGNATURE);
	await settle(page);
	assert.equal(count(page, 'POST /api/link/verify'), 1);
	assert.equal(methodCount(wallet, 'wallet_revokePermissions'), 1, 'danach entzogen');
});

test('M2 Safe-Bestaetigung haelt dieselbe Sperre (sonst saehe ihre Sitzung verwaist aus)', async () => {
	const { readFileSync } = await import('node:fs');
	const main = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');
	const fn = main.slice(main.indexOf('async function signiereMitWalletConnect('), main.indexOf('async function endSession('));
	const begin = fn.indexOf('loginVersuche.begin()');
	const connect = fn.indexOf('connectWithModal(modal, versuch)');
	const trennen = fn.lastIndexOf('await trenneWalletConnect(modal);');
	const ende = fn.lastIndexOf('versuch.end();');
	assert.ok(begin > 0 && begin < connect && trennen < ende, 'Sperre vor dem Verbinden, frei erst nach dem Trennen');
	assert.doesNotMatch(main, /createLoginAttempts\(\)\.begin\(\)/, 'kein Verbinden ohne die gemeinsame Sperre');
});

/* ------------------------------ Invarianten ------------------------------ */

test('Timeouts wie vorgegeben; Challenge 15 s und Safe-Bestaetigung unveraendert', async () => {
	const { readFileSync } = await import('node:fs');
	const main = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');
	assert.deepEqual({ ...WALLET_TIMEOUTS }, { connect: 120_000, switchChain: 60_000, sign: 60_000 });
	assert.match(main, /fetch\(`\/api\/dashboard\?wallet=\$\{encodeURIComponent\(wallet\)\}`, \{ signal: AbortSignal\.timeout\(15000\) \}\)/);
	assert.match(main, /5 \* 60_000/);
	// keine neuen Wallet-Methoden: nur die bekannten Aufrufe (HTTP-Methoden ausgenommen)
	const eoa = readFileSync(new URL('../web/src/eoa-login.js', import.meta.url), 'utf8');
	const methods = (quelle) => [...new Set([...quelle.matchAll(/method: '([a-z]+_[A-Za-z]+)'/g)].map((m) => m[1]))].sort();
	assert.deepEqual(methods(main), ['eth_chainId', 'eth_requestAccounts', 'personal_sign', 'wallet_revokePermissions']);
	assert.deepEqual(methods(eoa), ['eth_accounts', 'eth_chainId', 'wallet_switchEthereumChain']);
});
