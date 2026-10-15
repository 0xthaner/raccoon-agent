/*
	Safe-App-Metadaten (15.10.2026): Name, Beschreibung und Icon fuer Safe{Wallet}.

	Safe{Wallet} (safe-wallet-monorepo, services/safe-apps/manifest.ts) liest beim
	Hinzufuegen einer eigenen Safe App `${appUrl}/manifest.json` per fetch (CORS) und
	verlangt name, description und icons|iconPath. Das Icon zeigt es per <img> von
	app.safe.global aus an - also cross-origin ohne CORS. Unsere globale Regel
	`Cross-Origin-Resource-Policy: same-origin` blockierte das (ERR_BLOCKED_BY_RESPONSE.
	NotSameOrigin). Jetzt gilt fuer GENAU /safe-app-icon.svg `cross-origin`; fuer jeden
	anderen Pfad bleibt `same-origin`. Damit keine Reihenfolge entscheidet, setzt fuer
	jeden Pfad genau EINE Regel diesen Header.

	Nicht Gegenstand: Oeffnet man CoverRaccoon per direktem Link, ohne die App in Safe
	hinzugefuegt zu haben, zeigt Safe weiter seinen Platzhalter ("unknown") - Safe laedt
	das Manifest dann gar nicht (useSafeAppFromManifest: ohne safeAppData kein Abruf).
	Auch der Hinweis "nicht in der Standardliste" bleibt fuer eigene Safe Apps bestehen.

	Statuscodes und MIME-Typ der ausgelieferten Dateien prueft der Produktions-Smoke;
	lokal gibt es keinen Vercel-Server.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const vercel = JSON.parse(read('vercel.json'));

/** Vercel-`source` (Literale + rohe Regex-Gruppen in Klammern) -> RegExp, wie path-to-regexp fuer diese Formen. */
function sourceToRegExp(source) {
	let out = '';
	let depth = 0;
	for (const ch of source) {
		if (ch === '(') { depth++; out += ch; continue; }
		if (ch === ')') { depth--; out += ch; continue; }
		out += depth > 0 ? ch : ch.replace(/[.*+?^${}|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${out}$`);
}
/** Alle Regeln, die fuer `path` den Header `key` setzen. */
function rulesSetting(path, key) {
	return vercel.headers.filter((rule) => sourceToRegExp(rule.source).test(path))
		.flatMap((rule) => rule.headers.filter((h) => h.key.toLowerCase() === key.toLowerCase()).map((h) => ({ source: rule.source, value: h.value })));
}

/* ============================================================ Manifest */

test('manifest.json is valid JSON with the Safe-required fields: CoverRaccoon, description, local SVG icon', () => {
	const manifest = JSON.parse(read('web/public/manifest.json'));
	assert.deepEqual(manifest, {
		name: 'CoverRaccoon',
		description: 'Monitor onchain cover, wallet protection and DeFi risk from your Safe.',
		iconPath: 'safe-app-icon.svg'
	});
	// Safe{Wallet} isAppManifestValid: name, description und icons|iconPath
	for (const key of ['name', 'description']) assert.equal(typeof manifest[key], 'string');
	assert.ok('iconPath' in manifest || 'icons' in manifest);
	// keine zusaetzlichen Rechte
	assert.equal('safe_apps_permissions' in manifest, false);
});

test('the manifest stays readable from the Safe origin (CORS for app.safe.global, nothing else)', () => {
	assert.deepEqual(rulesSetting('/manifest.json', 'Access-Control-Allow-Origin').map((r) => r.value), ['https://app.safe.global']);
});

/* ================================================================ Icon */

test('safe-app-icon.svg is a square, static SVG without scripts, events, external references or fonts', () => {
	const svg = read('web/public/safe-app-icon.svg');
	assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
	const [, , , w, h] = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg) ?? [];
	assert.ok(w && w === h, 'quadratisch');
	assert.equal(/width="(\d+)" height="\1"/.test(svg), true);
	for (const forbidden of [/<script/i, /\son[a-z]+\s*=/i, /href\s*=/i, /xlink/i, /<image/i, /<foreignObject/i, /<text/i, /font-family/i, /@import/i, /<style/i, /<animate/i, /<set\b/i]) {
		assert.equal(forbidden.test(svg), false, String(forbidden));
	}
	// einzige URL: die xmlns-Kennung; url(...) nur intern
	assert.deepEqual(svg.match(/https?:\/\/[^\s"')]+/g), ['http://www.w3.org/2000/svg']);
	assert.deepEqual([...svg.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]), ['#cr-safe-icon']);
	assert.ok(svg.includes('id="cr-safe-icon"'));
	assert.ok(Buffer.byteLength(svg) < 4096);
});

test('the icon is derived from the existing holo-raccoon mark (same raccoon path)', () => {
	const pathOf = (svg) => /<path d="([^"]+)"/.exec(svg)[1];
	assert.equal(pathOf(read('web/public/safe-app-icon.svg')), pathOf(read('web/public/holo-raccoon.svg')));
});

/* ============================================================= Headers */

test('CORP: exactly one rule per path; only /safe-app-icon.svg is cross-origin, everything else stays same-origin', () => {
	assert.deepEqual(rulesSetting('/safe-app-icon.svg', 'Cross-Origin-Resource-Policy'), [{ source: '/safe-app-icon.svg', value: 'cross-origin' }]);
	for (const path of ['/', '/manifest.json', '/holo-raccoon.svg', '/assets/main-abc.js', '/api/dashboard', '/api/positions', '/guide', '/safe-app-icon.svg.bak', '/safe-app-icon.svgx', '/x/safe-app-icon.svg', '/safe-app-iconXsvg', '/SAFE-APP-ICON.SVG']) {
		const rules = rulesSetting(path, 'Cross-Origin-Resource-Policy');
		assert.equal(rules.length, 1, `${path}: genau eine Regel`);
		assert.equal(rules[0].value, 'same-origin', path);
	}
});

test('the other global security headers and the framing policy are unchanged', () => {
	const global = vercel.headers.find((r) => r.source === '/(.*)');
	assert.deepEqual(global.headers.map((h) => h.key), ['Strict-Transport-Security', 'X-Content-Type-Options', 'Cross-Origin-Opener-Policy', 'Referrer-Policy', 'Permissions-Policy', 'Reporting-Endpoints']);
	const csp = (path) => rulesSetting(path, 'Content-Security-Policy').map((r) => r.value);
	assert.equal(csp('/').length, 1);
	assert.match(csp('/')[0], /frame-ancestors 'self' https:\/\/app\.safe\.global;/);
	assert.match(csp('/')[0], /script-src 'self';/);
	for (const path of ['/safe-app-icon.svg', '/manifest.json', '/guide']) {
		assert.equal(csp(path).length, 1, path);
		assert.match(csp(path)[0], /frame-ancestors 'none';/, path);
		assert.deepEqual(rulesSetting(path, 'X-Frame-Options').map((r) => r.value), ['DENY'], path);
	}
	assert.deepEqual(rulesSetting('/safe-app-icon.svg', 'X-Content-Type-Options').map((r) => r.value), ['nosniff']);
});
