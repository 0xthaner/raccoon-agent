/*
	Cover-Zuordnung im Dashboard (14.10.2026): oeffentliche Daten plus vom Nutzer
	bestaetigte, serverseitig gespeicherte Zuordnungen. Keine privaten
	Proof-of-Loss-Daten, keine neue Signatur.

	Laeuft gegen die ECHTEN Funktionen aus web/src/main.js (resolveAttribution,
	loadAttributions, assignCover, removeCoverAssignment, renderPositions ...) in
	einem kleinen Test-DOM, inklusive Klicks auf die echten Buttons. Der Server ist
	ein Nachbau mit einem Speicher je Wallet (die echte Server-Pruefung testet
	test/position-attributions-api.test.mjs).
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const main = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');

function fakeDom() {
	const nodes = new Map();
	const make = (tag) => ({
		tag, className: '', children: [], _text: '',
		set textContent(v) { this._text = String(v); this.children = []; }, get textContent() { return this._text + this.children.map((c) => c.textContent).join(' | '); },
		appendChild(c) { this.children.push(c); return c; }, replaceChildren() { this.children = []; this._text = ''; },
		addEventListener(type, fn) { (this.listeners ??= {})[type] = fn; }, click() { return this.listeners?.click?.(); }
	});
	for (const id of ['#position-list', '#positions-title', '#positions-checked']) nodes.set(id, make('div'));
	return { document: { createElement: make, querySelector: (s) => nodes.get(s) ?? null }, nodes };
}

/** Server-Nachbau: ein Speicher je Wallet; die Wallet kommt aus der "Sitzung", nie aus dem Body. */
function fakeServer() {
	const stores = new Map();
	const server = {
		session: null, calls: [], fail: { list: false, save: false, remove: false },
		storeOf: (wallet) => { if (!stores.has(wallet)) stores.set(wallet, new Map()); return stores.get(wallet); },
		api: {
			list: async () => {
				server.calls.push(['list', server.session]);
				if (server.fail.list) return { ok: false, status: 503, json: async () => ({ ok: false }) };
				return { ok: true, status: 200, json: async () => ({ ok: true, attributions: [...server.storeOf(server.session).values()], pending: 0 }) };
			},
			save: async (relation) => {
				server.calls.push(['save', server.session, relation]);
				if (server.fail.save) return { ok: false, status: 503, json: async () => ({ ok: false, code: 'ATTRIBUTIONS_UNAVAILABLE' }) };
				const attribution = { deploymentKey: relation.deploymentKey, coverId: relation.coverId, productId: 97, source: 'user_confirmed', confirmedAt: '2026-10-14T10:00:00.000Z' };
				server.storeOf(server.session).set(`${relation.deploymentKey}|${relation.coverId}`, attribution);
				return { ok: true, status: 200, json: async () => ({ ok: true, attribution }) };
			},
			remove: async (relation) => {
				server.calls.push(['remove', server.session, relation]);
				if (server.fail.remove) return { ok: false, status: 503, json: async () => ({ ok: false }) };
				const deleted = server.storeOf(server.session).delete(`${relation.deploymentKey}|${relation.coverId}`);
				return { ok: true, status: 200, json: async () => ({ ok: true, deleted }) };
			}
		}
	};
	return server;
}

/** Eine "Seite": Uebersetzungen + Positions-Block aus main.js, mit dem Server-Nachbau verdrahtet. */
function load(server = fakeServer(), lang = 'de') {
	const { document } = fakeDom();
	const translations = main.slice(main.indexOf('const translations = {'), main.indexOf("let language = localStorage.getItem('raccoon_language')"));
	const slice = main.slice(main.indexOf('function formatAmount('), main.indexOf('function renderDashboard('));
	const page = new Function('document', 'window', 'lang', 'language', 'server', `${translations}
		const t = translations[lang];
		function renderUniswapSection() {} // der Uniswap-Abschnitt hat eigene Tests (uniswap-v3-dashboard.test.mjs)
		function addTextElement(parent, tag, value, className = '') { const el = document.createElement(tag); if (className) el.className = className; el.textContent = String(value ?? ''); parent.appendChild(el); return el; }
		function formatDate(iso) { return iso ? iso.slice(0, 10) : '—'; }
		function authFetch() { throw new Error('im Test laeuft alles ueber den Server-Nachbau'); }
		let positionsState = { wallet: null, status: 'idle', data: null };
		${slice}
		attributionApi = server.api;
		function place(dashboardWallet, positionsWallet, data, covers) {
			window.dashboardData = { wallet: dashboardWallet, covers };
			resetAttributionState();
			positionsState = { wallet: positionsWallet, status: 'ok', data: { wallet: positionsWallet, ...data } };
			coverAttributionSlots = covers.filter((cover) => cover.status === 'active').map((cover) => { const slot = document.createElement('div'); slot.hidden = true; return { cover, slot }; });
			renderPositions();
		}
		return {
			ATTRIBUTION,
			// Wie loadPositions: Positionen zeigen, dann die gespeicherten Zuordnungen laden.
			async show(wallet, data, covers) { server.session = wallet; place(wallet, wallet, data, covers); await loadAttributions(wallet); },
			async showMismatch(dashboardWallet, positionsWallet, data, covers) { server.session = dashboardWallet; place(dashboardWallet, positionsWallet, data, covers); await loadAttributions(positionsWallet); },
			loading(wallet) { resetAttributionState(); positionsState = { wallet, status: 'loading', data: null }; renderPositions(); },
			current: () => currentAttribution(),
			assign: (key, coverId) => assignCover(key, coverId),
			remove: (key, coverId) => removeCoverAssignment(key, coverId),
			store: () => attributionStore,
			slots: () => coverAttributionSlots,
			list: () => document.querySelector('#position-list')
		};`)(document, {}, lang, lang, server);
	return page;
}

const allNodes = (node) => [node, ...node.children.flatMap(allNodes)];
const byClass = (node, className) => allNodes(node).filter((n) => String(n.className).split(' ').includes(className));
const buttons = (node, label) => allNodes(node).filter((n) => n.tag === 'button' && (label == null || n._text === label));
/** Zuordnungs-Knoepfe; der Nexus-P3-Knopf "Cover-Details ansehen" (nur Anzeige) zaehlt nicht dazu und wird einzeln geprueft. */
const attributionButtons = (node) => buttons(node).filter((n) => !String(n.className).includes('cover-details-action'));
const statusOf = (page, key) => page.current()?.byPosition.get(key)?.state ?? null;
const visibleSlots = (page) => page.slots().filter(({ slot }) => !slot.hidden).map(({ slot }) => slot.textContent);

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NEXUS = { state: 'MATCHED', productId: 97, productName: 'Aave v3' };
const position = (key, label) => ({
	deploymentKey: key, label, nexus: NEXUS,
	supplied: [{ symbol: 'USDC', amount: '100', usdValue: '100', isCollateral: true }], borrowed: [],
	totals: { suppliedUsd: '100', debtUsd: '0', netUsd: '100', healthFactor: null }
});
const CORE = position('aave-v3-ethereum-core', 'Core');
const LIDO = position('aave-v3-ethereum-lido', 'Lido / Prime');
const markets = (unavailable = []) => [['aave-v3-ethereum-core', 'Core'], ['aave-v3-ethereum-lido', 'Lido / Prime'], ['aave-v3-ethereum-etherfi', 'EtherFi']]
	.map(([deploymentKey, label]) => ({ deploymentKey, label, status: unavailable.includes(label) ? 'UNAVAILABLE' : 'OK' }));
const data = (positions, unavailable = []) => ({ ok: true, complete: unavailable.length === 0, checkedDeployments: markets(unavailable), positions });
const cover = (coverId, extra = {}) => ({ coverId, productId: 97, productName: 'Aave v3', status: 'active', amount: '10000', asset: { symbol: 'USDC' }, endsAt: '2026-11-28T00:00:00.000Z', ...extra });

/* ----------------------------------------------------------- Kardinalitaet */

test('1: one position + one cover + complete data -> AUTO_UNAMBIGUOUS', async () => {
	const page = load();
	await page.show(A, data([CORE]), [cover(1)]);
	assert.equal(statusOf(page, CORE.deploymentKey), page.ATTRIBUTION.AUTO);
	const [card] = byClass(page.list(), 'position-card');
	assert.match(card.textContent, /Cover-Zuordnung \| Eindeutig · 1:1 \| Eine aktive passende Position und ein aktives passendes Nexus Cover wurden erkannt\./);
	assert.equal(attributionButtons(page.list()).length, 0, 'nichts zu bestaetigen');
	assert.deepEqual(buttons(page.list()).map((n) => n._text), ['Cover-Details ansehen'], 'nur der Anzeige-Knopf der Position');
	assert.deepEqual(visibleSlots(page), ['Cover-Zuordnung | Eindeutig · 1:1 · Aave v3 · Core']);
	assert.match(byClass(page.list(), 'protocol-summary')[0].textContent, /keine Aussage über die Berechtigung eines Claims oder eine Auszahlung/);
});

test('1b: one position + one cover but an unreadable market -> never "eindeutig"', async () => {
	const page = load();
	await page.show(A, data([CORE], ['EtherFi']), [cover(1)]);
	assert.equal(statusOf(page, CORE.deploymentKey), page.ATTRIBUTION.REQUIRED);
	assert.match(byClass(page.list(), 'protocol-summary')[0].textContent, /Nicht alle unterstützten Märkte konnten gelesen werden/);
	assert.doesNotMatch(page.list().textContent, /Eindeutig/);
});

test('2/3/4: 2:1, 1:2 and 2:2 require confirmation; nothing is paired by order, amount or asset', async () => {
	const page = load();
	await page.show(A, data([CORE, LIDO]), [cover(1)]);
	assert.deepEqual([statusOf(page, CORE.deploymentKey), statusOf(page, LIDO.deploymentKey)], [page.ATTRIBUTION.REQUIRED, page.ATTRIBUTION.REQUIRED]);
	assert.equal(buttons(page.list(), 'Cover zuordnen').length, 2);
	await page.show(A, data([CORE]), [cover(1), cover(2)]);
	assert.match(page.list().textContent, /Wallet-Cover \| 2 aktive Aave-v3-Covers gefunden \| Cover-Zuordnung \| Bestätigung erforderlich/);
	await page.show(A, data([CORE, LIDO]), [cover(1, { amount: '100' }), cover(2, { amount: '100' })]);
	assert.deepEqual([statusOf(page, CORE.deploymentKey), statusOf(page, LIDO.deploymentKey)], [page.ATTRIBUTION.REQUIRED, page.ATTRIBUTION.REQUIRED]);
	assert.doesNotMatch(page.list().textContent, /Eindeutig|Vom Nutzer bestätigt/);
});

test('5: one position + no covers -> NO_ACTIVE_COVER, attribution "—"', async () => {
	const page = load();
	await page.show(A, data([CORE]), []);
	assert.equal(statusOf(page, CORE.deploymentKey), page.ATTRIBUTION.NONE);
	assert.match(page.list().textContent, /Wallet-Cover \| Kein aktives passendes Cover erkannt \| Cover-Zuordnung \| —/);
	assert.equal(attributionButtons(page.list()).length, 0);
	assert.deepEqual(buttons(page.list()).map((n) => n._text), ['Cover-Details ansehen'], 'nur der Anzeige-Knopf der Position');
});

test('6/7/8: wrong productId, inactive, same-name/wrong-product, string-id and demo covers never participate', async () => {
	const page = load();
	const noise = [cover(10, { productId: 98 }), cover(11, { productId: 1 }), cover(12, { productId: '97' }), cover(13, { status: 'expired' }), cover(14, { status: 'superseded' }), cover(15, { productId: 97.5 }), cover(16, { demo: true })];
	await page.show(A, data([CORE]), noise);
	assert.equal(statusOf(page, CORE.deploymentKey), page.ATTRIBUTION.NONE, 'nur Rauschen: kein passendes Cover');
	await page.show(A, data([CORE]), [...noise, cover(1)]);
	assert.equal(statusOf(page, CORE.deploymentKey), page.ATTRIBUTION.AUTO, 'Rauschen macht 1:1 nicht mehrdeutig');
	assert.deepEqual(page.current().candidateCovers.map((c) => c.coverId), [1]);
	assert.deepEqual(visibleSlots(page).length, 1, 'oben nur das Kandidaten-Cover');
});

/* ------------------------------------------- Bestaetigen, speichern, laden */

test('MANUAL/29: confirming saves on the server; a fresh page load shows it again', async () => {
	const server = fakeServer();
	const page = load(server);
	await page.show(A, data([CORE, LIDO]), [cover(1), cover(2, { amount: '3', asset: { symbol: 'ETH' } }), cover(10, { productId: 98 }), cover(13, { status: 'expired' })]);
	await buttons(page.list(), 'Cover zuordnen')[0].click();
	const [chooser] = byClass(page.list(), 'attribution-chooser');
	assert.deepEqual(byClass(chooser, 'attribution-option-id').map((n) => n._text), ['Cover #1', 'Cover #2']);
	assert.match(chooser.textContent, /Cover #2 \| Aave v3 · Produkt #97 \| 3 ETH \| Ablauf 2026-11-28/);
	assert.doesNotMatch(chooser.textContent, /#10|#13|Produkt #98/);
	await buttons(chooser, 'Dieser Position zuordnen')[1].click();
	assert.deepEqual(server.calls.filter(([kind]) => kind === 'save').map(([, wallet, relation]) => [wallet, relation]), [[A, { deploymentKey: CORE.deploymentKey, coverId: 2 }]], 'nur Markt und Cover, keine Wallet im Body');
	assert.equal(statusOf(page, CORE.deploymentKey), page.ATTRIBUTION.CONFIRMED);
	assert.equal(statusOf(page, LIDO.deploymentKey), page.ATTRIBUTION.REQUIRED);
	const [core] = byClass(page.list(), 'position-card');
	assert.match(core.textContent, /Cover-Zuordnung \| Vom Nutzer bestätigt · Cover #2 \| Diese Zuordnung wurde von dir bestätigt und basiert nicht auf privaten Nexus-Metadaten\./);
	assert.match(byClass(page.list(), 'protocol-summary')[0].textContent, /Diese Zuordnung wurde von dir bestätigt\. CoverRaccoon hat keine privaten Proof-of-Loss-Daten eingesehen\./);
	assert.deepEqual(visibleSlots(page), ['Cover-Zuordnung | Bestätigung erforderlich', 'Cover-Zuordnung | Vom Nutzer bestätigt · Core']);
	// Neu laden: neue Seite, derselbe Server.
	const reloaded = load(server);
	await reloaded.show(A, data([CORE, LIDO]), [cover(1), cover(2)]);
	assert.equal(statusOf(reloaded, CORE.deploymentKey), reloaded.ATTRIBUTION.CONFIRMED);
	assert.match(reloaded.list().textContent, /Vom Nutzer bestätigt · Cover #2/);
});

test('30: wallet B never receives wallet A attributions, on the same page or a new one', async () => {
	const server = fakeServer();
	const page = load(server);
	await page.show(A, data([CORE, LIDO]), [cover(1)]);
	assert.equal(await page.assign(CORE.deploymentKey, 1), true);
	await page.show(B, data([CORE, LIDO]), [cover(1)]);
	assert.equal(page.store().wallet, B);
	assert.equal(statusOf(page, CORE.deploymentKey), page.ATTRIBUTION.REQUIRED, 'B sieht nichts von A');
	assert.deepEqual(server.calls.filter(([kind]) => kind === 'list').map(([, wallet]) => wallet), [A, B]);
	const other = load(server);
	await other.show(B, data([CORE, LIDO]), [cover(1)]);
	assert.doesNotMatch(other.list().textContent, /Vom Nutzer bestätigt/);
	// Zurueck zu A: die Bestaetigung von A ist (vom Server) wieder da.
	await page.show(A, data([CORE, LIDO]), [cover(1)]);
	assert.equal(statusOf(page, CORE.deploymentKey), page.ATTRIBUTION.CONFIRMED);
});

test('30b: positions of another wallet than the dashboard session never get an attribution', async () => {
	const page = load();
	await page.showMismatch(A, B, data([CORE]), [cover(1)]);
	assert.equal(page.current(), null);
	assert.doesNotMatch(page.list().textContent, /Cover-Zuordnung|Eindeutig|Cover zuordnen/);
	assert.equal(await page.assign(CORE.deploymentKey, 1), false);
});

test('31/32: the manual state is always "Vom Nutzer bestätigt", never verified or a coverage claim', async () => {
	const scenarios = [
		async (page) => page.show(A, data([CORE]), [cover(1)]),
		async (page) => page.show(A, data([CORE, LIDO]), [cover(1)]),
		async (page) => { await page.show(A, data([CORE, LIDO]), [cover(1)]); await page.assign(CORE.deploymentKey, 1); },
		async (page) => page.show(A, data([CORE]), [])
	];
	for (const lang of ['de', 'en']) for (const run of scenarios) {
		const page = load(fakeServer(), lang);
		await run(page);
		const text = [page.list().textContent, ...visibleSlots(page)].join(' ')
			.replace(/Ein passendes Nexus-Produkt bedeutet nicht, dass ein konkreter Verlust gedeckt oder ein bestimmter Betrag erstattungsfähig ist\./, '')
			.replace(/A matching Nexus product does not mean that a specific loss is covered or that a particular amount is reimbursable\./, '');
		assert.doesNotMatch(text, /verifiziert|verified|versichert|gedeckt|geschützt|abgesichert|insured|covered|protected|guarantee|garantiert|claim eligible|anspruchsberechtigt/i, `${lang}: ${text.slice(0, 120)}`);
	}
	assert.match(main, /attributionConfirmed: 'Vom Nutzer bestätigt'/);
});

test('33: an automatic 1:1 attribution is never sent to the server', async () => {
	const server = fakeServer();
	const page = load(server);
	await page.show(A, data([CORE]), [cover(1)]);
	assert.equal(statusOf(page, CORE.deploymentKey), page.ATTRIBUTION.AUTO);
	assert.equal(await page.assign(CORE.deploymentKey, 1), false);
	assert.deepEqual(server.calls.filter(([kind]) => kind !== 'list'), []);
	// Auch eine gespeicherte Bestaetigung aendert die live erkannte 1:1-Lage nicht.
	server.storeOf(A).set('x', { deploymentKey: CORE.deploymentKey, coverId: 1, productId: 97, source: 'user_confirmed' });
	await page.show(A, data([CORE]), [cover(1)]);
	assert.equal(statusOf(page, CORE.deploymentKey), page.ATTRIBUTION.AUTO);
});

test('34: removing deletes the stored relation (also after a reload)', async () => {
	const server = fakeServer();
	const page = load(server);
	await page.show(A, data([CORE, LIDO]), [cover(1)]);
	await page.assign(CORE.deploymentKey, 1);
	const [core] = byClass(page.list(), 'position-card');
	await buttons(core, 'Zuordnung entfernen')[0].click();
	assert.deepEqual(server.calls.filter(([kind]) => kind === 'remove').map(([, wallet, relation]) => [wallet, relation]), [[A, { deploymentKey: CORE.deploymentKey, coverId: 1 }]]);
	assert.equal(statusOf(page, CORE.deploymentKey), page.ATTRIBUTION.REQUIRED);
	assert.equal(server.storeOf(A).size, 0);
	const reloaded = load(server);
	await reloaded.show(A, data([CORE, LIDO]), [cover(1)]);
	assert.equal(statusOf(reloaded, CORE.deploymentKey), reloaded.ATTRIBUTION.REQUIRED);
});

test('35: a failed save shows an error and never renders a confirmed state', async () => {
	const server = fakeServer();
	server.fail.save = true;
	const page = load(server);
	await page.show(A, data([CORE, LIDO]), [cover(1)]);
	assert.equal(await page.assign(CORE.deploymentKey, 1), false);
	assert.equal(statusOf(page, CORE.deploymentKey), page.ATTRIBUTION.REQUIRED);
	assert.doesNotMatch(page.list().textContent, /Vom Nutzer bestätigt/);
	assert.match(page.list().textContent, /Die Zuordnung konnte nicht gespeichert werden\. Bitte erneut versuchen\./);
	// Ein fehlgeschlagenes Entfernen laesst die Bestaetigung stehen und sagt es.
	server.fail.save = false;
	await page.assign(CORE.deploymentKey, 1);
	server.fail.remove = true;
	assert.equal(await page.remove(CORE.deploymentKey, 1), false);
	assert.equal(statusOf(page, CORE.deploymentKey), page.ATTRIBUTION.CONFIRMED);
	assert.match(page.list().textContent, /Die Zuordnung konnte nicht entfernt werden/);
});

test('35b: if stored attributions cannot be loaded, nothing is shown as confirmed and assigning is disabled', async () => {
	const server = fakeServer();
	server.storeOf(A).set('x', { deploymentKey: CORE.deploymentKey, coverId: 1, productId: 97, source: 'user_confirmed' });
	server.fail.list = true;
	const page = load(server);
	await page.show(A, data([CORE, LIDO]), [cover(1)]);
	assert.equal(statusOf(page, CORE.deploymentKey), page.ATTRIBUTION.REQUIRED);
	assert.match(page.list().textContent, /Gespeicherte Cover-Zuordnungen konnten gerade nicht geladen werden/);
	assert.ok(buttons(page.list(), 'Cover zuordnen').every((button) => button.disabled === true));
	assert.equal(await page.assign(CORE.deploymentKey, 1), false);
	assert.deepEqual(server.calls.filter(([kind]) => kind === 'save'), []);
});

test('9: assigning a cover of another product, an unknown or inactive cover, or a non-detected market never calls the server', async () => {
	const server = fakeServer();
	const page = load(server);
	await page.show(A, data([CORE, LIDO]), [cover(1), cover(10, { productId: 98 }), cover(13, { status: 'expired' })]);
	for (const [key, id] of [[CORE.deploymentKey, 10], [CORE.deploymentKey, 13], [CORE.deploymentKey, 999], [CORE.deploymentKey, '1'], ['aave-v3-ethereum-etherfi', 1]]) {
		assert.equal(await page.assign(key, id), false, `${key} ${id}`);
	}
	assert.deepEqual(server.calls.filter(([kind]) => kind === 'save'), []);
});

test('11: a stored relation is only shown while its cover is active and the position exists', async () => {
	const server = fakeServer();
	const page = load(server);
	await page.show(A, data([CORE, LIDO]), [cover(1), cover(2)]);
	await page.assign(CORE.deploymentKey, 2);
	await page.show(A, data([CORE, LIDO]), [cover(1), cover(2, { status: 'expired' })]);
	assert.equal(statusOf(page, CORE.deploymentKey), page.ATTRIBUTION.REQUIRED, 'Cover 2 nicht mehr aktiv');
	await page.show(A, data([LIDO]), [cover(1), cover(2)]);
	assert.equal(statusOf(page, CORE.deploymentKey), null, 'Core-Position weg');
	await page.show(A, data([CORE, LIDO]), [cover(1), cover(2, { productId: 98 })]);
	assert.equal(statusOf(page, CORE.deploymentKey), page.ATTRIBUTION.REQUIRED, 'Produkt passt nicht mehr');
});

test('10b: loading and logout clear the page copy; logout does not delete stored relations', async () => {
	const server = fakeServer();
	const page = load(server);
	await page.show(A, data([CORE, LIDO]), [cover(1)]);
	await page.assign(CORE.deploymentKey, 1);
	page.loading(A);
	assert.equal(page.current(), null);
	assert.equal(page.store().links.size, 0);
	assert.ok(page.slots().every(({ slot }) => slot.hidden && slot.textContent === ''));
	assert.equal(server.storeOf(A).size, 1, 'gespeicherte Bestaetigung bleibt');
	const loadPositions = main.slice(main.indexOf('async function loadPositions('), main.indexOf('function formatAmount('));
	assert.match(loadPositions, /resetAttributionState\(\);/);
	assert.match(loadPositions, /if \(positionsState\.status === 'ok'\) loadAttributions\(wallet\);/);
	const endSession = main.slice(main.indexOf('async function endSession('), main.indexOf('function enable()'));
	assert.match(endSession, /resetAttributionState\(\);/);
	assert.doesNotMatch(endSession, /position-attributions/, 'Abmelden loescht keine gespeicherte Zuordnung');
});

/* ---------------------------------------------------------- Grenzen */

function files(dir) {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : [path];
	});
}

test('39/40/41: no private Nexus metadata, no new wallet method, no transaction capability', async () => {
	const sources = ['web/src', 'api', 'src'].flatMap((d) => files(new URL(`../${d}`, import.meta.url).pathname)).filter((f) => /\.(m?js|html)$/.test(f));
	for (const file of sources) {
		const text = readFileSync(file, 'utf8');
		assert.doesNotMatch(text, /viewCoverMetadata|editCoverMetadata|cover-metadata|coverMetadataId|buildCoverMetadataAuthMessage|buildAuthTypedData|x-auth-signature|x-auth-payload|@nexusmutual\/sdk/, file);
		assert.doesNotMatch(text, /signTypedData|eth_signTypedData/, file);
	}
	const { WALLET_METHODEN_ALLE } = await import('../web/src/wallet-methods.js');
	assert.deepEqual(WALLET_METHODEN_ALLE, ['eth_requestAccounts', 'eth_accounts', 'personal_sign', 'wallet_switchEthereumChain']);
	const methods = [...new Set([...main.matchAll(/method: '([a-zA-Z_]+)'/g)].map((m) => m[1]))].sort();
	assert.deepEqual(methods, ['DELETE', 'POST', 'eth_chainId', 'eth_requestAccounts', 'personal_sign', 'wallet_revokePermissions'], 'nur bekannte Methoden; POST/DELETE sind HTTP');
	const block = main.slice(main.indexOf('const ATTRIBUTION = Object.freeze('), main.indexOf('function coverDaysLeft('));
	assert.doesNotMatch(block, /personal_sign|sendTransaction|approve|signMessage|request\(\{|localStorage|sessionStorage|indexedDB|document\.cookie/);
	assert.match(block, /authFetch\('\/api\/position-attributions'/, 'nur der eigene Endpunkt');
	assert.doesNotMatch(block, /https?:\/\//, 'keine fremde Adresse');
});

test('SESSION: the page copy lives only in module memory', () => {
	const slice = main.slice(main.indexOf('let positionsState'), main.indexOf('function renderDashboard('));
	assert.doesNotMatch(slice, /localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State|location\.hash/);
	assert.doesNotMatch(main, /window\.attributionStore|globalThis\.attributionStore/);
});
