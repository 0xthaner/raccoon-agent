/**
 * Lokale Dev-Fixture fuer die DeFi-Positionen (12.10.2026).
 *
 * Beweist: nur der Vite-Entwicklungsserver kann sie einschalten, ein
 * Produktions-Build enthaelt sie nicht (auch nicht mit gesetzter Variable),
 * nichts im Browser schaltet sie ein, das Backend kennt sie nicht, und sie
 * laeuft durch die echten Render-Funktionen. Kein Netz, keine RPC.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const fixture = await import('../web/src/fixtures/positions-fixture.js');
const main = readFileSync(new URL('../web/src/main.js', import.meta.url), 'utf8');
const fixtureSource = readFileSync(new URL('../web/src/fixtures/positions-fixture.js', import.meta.url), 'utf8');
const MARKERS = /DEV-FIXTURE|positions-fixture|fixtureVariant|0x000000000000000000000000000000000000f1c5|VITE_POSITIONS_FIXTURE|900001/;

function filesUnder(dir) {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? filesUnder(path) : [path];
	});
}

/* ------------------------------------------------ C/I/B: Produktions-Build ---- */

test('C/I/B: a production build with VITE_POSITIONS_FIXTURE=true contains no fixture and still calls /api/positions', () => {
	const out = mkdtempSync(join(tmpdir(), 'raccoon-prodbuild-'));
	try {
		execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', 'web', '--config', 'vite.config.js', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
			env: { ...process.env, VITE_POSITIONS_FIXTURE: 'true', NODE_ENV: 'production' },
			stdio: 'pipe'
		});
		const files = filesUnder(out);
		assert.ok(files.some((f) => /assets\/main-.*\.js$/.test(f)), 'main bundle gebaut');
		assert.ok(!files.some((f) => /fixture/i.test(f)), 'kein Fixture-Chunk');
		for (const file of files.filter((f) => /\.(js|html|css)$/.test(f))) {
			assert.doesNotMatch(readFileSync(file, 'utf8'), MARKERS, file);
		}
		const bundle = readFileSync(files.find((f) => /assets\/main-.*\.js$/.test(f)), 'utf8');
		assert.match(bundle, /\/api\/positions/, 'Produktion fragt immer die echte, angemeldete Route');
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});

/* ------------------------------------------------ A: Entwicklungsserver ---- */

test('A: only the Vite dev server exposes DEV=true together with the fixture switch', async () => {
	const { createServer } = await import('vite');
	process.env.VITE_POSITIONS_FIXTURE = 'true';
	const server = await createServer({ configFile: false, root: 'web', mode: 'development', logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
	try {
		const result = await server.transformRequest('/src/main.js');
		assert.match(result.code, /"DEV":\s*true/);
		assert.match(result.code, /"VITE_POSITIONS_FIXTURE":\s*"true"/);
		assert.match(result.code, /import\(["']\/src\/fixtures\/positions-fixture\.js["']\)/, 'Fixture im Dev-Server erreichbar');
	} finally {
		delete process.env.VITE_POSITIONS_FIXTURE;
		await server.close();
	}
	assert.equal(fixture.fixtureVariant('true'), 'true');
	assert.equal(fixture.fixtureVariant('no-cover'), 'no-cover');
	for (const value of [undefined, '', 'false', '1', 'yes', 'TRUE']) assert.equal(fixture.fixtureVariant(value), null, String(value));
});

/* --------------------------------------- D/E: nichts im Browser schaltet sie ein ---- */

test('D/E: activation depends only on build-time import.meta.env, never on URL, storage, cookies or headers', () => {
	const guards = main.match(/if \(import\.meta\.env\.DEV && import\.meta\.env\.VITE_POSITIONS_FIXTURE\) \{[\s\S]*?\n\t\}/g) ?? [];
	assert.equal(guards.length, 2, 'genau zwei Stellen: Dashboard-Start und Positionsabfrage');
	for (const block of guards) assert.doesNotMatch(block, /location|URLSearchParams|searchParams|localStorage|sessionStorage|document\.cookie|hash|headers|prompt\(/);
	const imports = [...main.matchAll(/import\(['"]\.\/fixtures\/positions-fixture\.js['"]\)/g)].length;
	assert.equal(imports, 2, 'nur innerhalb der beiden Schutzbloecke');
	assert.equal(guards.join('\n').split("import('./fixtures/positions-fixture.js')").length - 1, 2);
	assert.doesNotMatch(main, /^import .*fixture/m, 'kein statischer Import');
	assert.doesNotMatch(fixtureSource, /location|URLSearchParams|localStorage|sessionStorage|cookie|fetch\(|document\.|window\./, 'Fixture ist reine Daten');
	assert.equal(fixture.positionsFixture('true', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), null, 'nie fuer eine echte Wallet');
});

/* ------------------------------------------------ F: Backend unberuehrt ---- */

test('F: no server file knows the fixture; routes and auth are unchanged in kind', () => {
	const server = [...filesUnder('api'), ...filesUnder('src')].filter((f) => /\.m?js$/.test(f));
	for (const file of server) assert.doesNotMatch(readFileSync(file, 'utf8'), /fixture|VITE_POSITIONS_FIXTURE/i, file);
	assert.deepEqual(filesUnder('api').map((f) => f.replace(/\\/g, '/')).sort(), ['api/alerts.mjs', 'api/config.mjs', 'api/csp-report.mjs', 'api/dashboard.mjs', 'api/link.mjs', 'api/link/verify.mjs', 'api/positions.mjs', 'api/telegram.mjs'], 'keine neue Route');
	const positionsApi = readFileSync('api/positions.mjs', 'utf8');
	assert.match(positionsApi, /resolveSession = resolveDashboardSession/);
	assert.match(positionsApi, /WALLET_PARAMETER_NOT_ALLOWED/);
	assert.match(positionsApi, /isRevoked\(session\.wallet/);
});

/* ------------------------------------------- G/H: echte Render-Funktionen ---- */

function fakeDom() {
	const nodes = new Map();
	const make = (tag) => ({
		tag, className: '', children: [], _text: '',
		set textContent(v) { this._text = String(v); this.children = []; }, get textContent() { return this._text + this.children.map((c) => c.textContent).join(' | '); },
		appendChild(c) { this.children.push(c); return c; }, replaceChildren() { this.children = []; this._text = ''; }
	});
	for (const id of ['#position-list', '#positions-title', '#positions-note', '#positions-checked']) nodes.set(id, make('div'));
	return { document: { createElement: make, querySelector: (s) => nodes.get(s) ?? null }, nodes };
}

/** Fuehrt die echten renderPositions/formatAmount/formatUsd aus main.js aus. */
function renderReal(positions, dashboard, lang = 'de') {
	const start = main.indexOf('function formatAmount(');
	const end = main.indexOf('function renderDashboard(');
	const translations = main.slice(main.indexOf('const translations = {'), main.indexOf("let language = localStorage.getItem('raccoon_language')"));
	const { document, nodes } = fakeDom();
	const slots = new Function('document', 'window', 'lang', 'state', 'language', `${translations}
		const t = translations[lang];
		function addTextElement(parent, tag, value, className = '') { const el = document.createElement(tag); if (className) el.className = className; el.textContent = String(value ?? ''); parent.appendChild(el); return el; }
		function formatDate(iso) { return iso ? iso.slice(0, 10) : '—'; }
		let positionsState = state;
		${main.slice(start, end)}
		coverAttributionSlots = (window.dashboardData?.covers ?? []).filter((cover) => cover.status === 'active').map((cover) => { const slot = document.createElement('div'); slot.hidden = true; return { cover, slot }; });
		renderPositions();
		return coverAttributionSlots;`)(document, { dashboardData: dashboard }, lang, { wallet: fixture.FIXTURE_WALLET, status: 'ok', data: positions }, lang);
	const list = nodes.get('#position-list');
	list.attributionSlots = slots;
	return list;
}

const allNodes = (node) => [node, ...node.children.flatMap(allNodes)];
const byClass = (node, className) => allNodes(node).filter((n) => String(n.className).split(' ').includes(className));

test('G/H: fixture with cover renders through the real renderer: summary, clean cards, attribution only in the top cover list', () => {
	const now = Date.parse('2026-10-12T10:00:00Z');
	const dashboard = fixture.dashboardFixture('true', now);
	const positions = fixture.positionsFixture('true', dashboard.wallet, now);
	const list = renderReal(positions, dashboard);
	const [summary] = byClass(list, 'protocol-summary');
	assert.match(summary.textContent, /Gesamt eingezahlt \| .*15\.390,00/);
	assert.match(summary.textContent, /Gesamt geliehen \| .*2\.000,00/);
	assert.match(summary.textContent, /Nettoposition \| .*13\.390,00/);
	assert.match(summary.textContent, /EtherFi konnte derzeit nicht gelesen werden\. Die Summen enthalten nur verfügbare Märkte\./);
	assert.match(summary.textContent, /Passendes Nexus-Produkt verfügbar \| Aave v3 · Produkt #97/);
	assert.match(summary.textContent, /Wallet-Cover-Status \| 1 aktives Cover gefunden \| Produkt bei Nexus ansehen/);
	const [core, lido, etherfi] = byClass(list, 'position-card');
	assert.match(core.textContent, /^Aave v3 · Core \| Erkannte DeFi-Position/);
	assert.match(core.textContent, /Eingezahlt \| USDC \| 8\.250 USDC \| .*8\.250,00 \| als Sicherheit/);
	assert.match(core.textContent, /WETH \| 1,35 WETH \| .*4\.180,00 \| als Sicherheit/);
	assert.match(core.textContent, /Geliehen \| USDT \| 2\.000 USDT/);
	assert.match(core.textContent, /Nettoposition \| .*10\.430,00 \| Eingezahlter Wert minus geliehener Wert/);
	assert.match(core.textContent, /Health Factor \| 2,31/);
	assert.match(core.textContent, /Nexus \| Passendes Produkt verfügbar \| Wallet-Cover \| Aktives Aave-v3-Cover gefunden \| Positionszuordnung \| Nicht verifiziert$/);
	assert.match(lido.textContent, /wstETH \| 0,8 wstETH \| .*2\.960,00 \| nicht als Sicherheit/);
	assert.match(lido.textContent, /Health Factor \| keine Schulden/);
	assert.match(etherfi.textContent, /^Aave v3 · EtherFi \| Status \| Nicht verfügbar \|/);
	for (const card of [core, lido, etherfi]) assert.doesNotMatch(card.textContent, /Cover #|Produkt #97|10\.000|Ablauf/);
	assert.equal(byClass(list, 'nexus-covers').length, 0, 'keine zweite Cover-Liste');
	assert.doesNotMatch(list.textContent, /Cover #900001/, 'Cover-Details nur oben unter "Deine Covers"');
	const [slot] = list.attributionSlots;
	assert.equal(slot.cover.coverId, 900001);
	assert.equal(slot.slot.hidden, false);
	assert.equal(slot.slot.textContent, 'Positionszuordnung | Nicht verifiziert');
	assert.ok(Date.parse(dashboard.covers[0].endsAt) > now, 'Ablauf liegt in der Zukunft');
});

test('H: no-cover variant: neutral wallet status, one primary action, three-row card status with an empty attribution', () => {
	const dashboard = fixture.dashboardFixture('no-cover');
	assert.deepEqual(dashboard.covers, []);
	const list = renderReal(fixture.positionsFixture('no-cover', dashboard.wallet), dashboard);
	const [summary] = byClass(list, 'protocol-summary');
	assert.match(summary.textContent, /Passendes Nexus-Produkt verfügbar/);
	assert.match(summary.textContent, /Wallet-Cover-Status \| Kein aktives passendes Cover erkannt \| Cover bei Nexus ansehen/);
	assert.equal(byClass(list, 'nexus-action').length, 1, 'genau eine Aktion');
	assert.equal(byClass(summary, 'primary').length, 1, 'und die steht in der Zusammenfassung');
	for (const card of byClass(list, 'position-card').filter((c) => !String(c.className).includes('position-unavailable'))) {
		assert.match(card.textContent, /Nexus \| Passendes Produkt verfügbar \| Wallet-Cover \| Kein aktives passendes Cover erkannt \| Positionszuordnung \| —$/);
	}
	assert.doesNotMatch(list.textContent, /Cover #|unversichert|nicht versichert|uninsured/);
	assert.deepEqual(list.attributionSlots, []);
	const en = renderReal(fixture.positionsFixture('no-cover', dashboard.wallet), dashboard, 'en');
	assert.match(en.textContent, /Matching Nexus product available/);
	assert.match(en.textContent, /No active matching cover detected \| View cover on Nexus/);
});

test('H: fixture data has the real API shape, fake values only and no coverage wording', () => {
	const positions = fixture.positionsFixture('true', fixture.FIXTURE_WALLET);
	assert.deepEqual(Object.keys(positions).sort(), ['blockNumber', 'chainId', 'checkedDeployments', 'complete', 'fetchedAt', 'ok', 'positions', 'scope', 'wallet']);
	for (const p of positions.positions) {
		assert.deepEqual(p.nexus, { state: 'MATCHED', productId: 97, productName: 'Aave v3' });
		for (const field of ['suppliedUsd', 'debtUsd', 'netUsd']) assert.equal(typeof p.totals[field], 'string');
		assert.equal(p.wallet, fixture.FIXTURE_WALLET);
	}
	const core = positions.positions[0].totals;
	assert.equal(Number(core.suppliedUsd) - Number(core.debtUsd), Number(core.netUsd), 'in sich stimmig');
	assert.doesNotMatch(JSON.stringify([positions, fixture.dashboardFixture('true')]), /covered|insured|protected|guarantee|uncovered|recommended|gedeckt|versichert|geschützt/i);
	assert.match(fixture.FIXTURE_WALLET, /^0x0{36}f1c5$/, 'offensichtliche Platzhalter-Adresse');
});
