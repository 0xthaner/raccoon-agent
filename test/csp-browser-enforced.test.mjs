/**
 * CRSF Phase 2P, CR-BROWSER-004 P3 ("CSP forbids unsafe-eval"), im echten Browser.
 *
 * test/csp-enforced.test.mjs liest die Richtlinie nur als Text. Hier wird sie
 * so ausgeliefert, wie Vercel es tut - die Kopfzeilen aus vercel.json, je Pfad
 * nach deren `source`-Mustern zusammengesetzt - und ein headless Chrome fuehrt
 * eine Probe aus (Skript von der eigenen Herkunft, wie das gebaute Frontend).
 * Geprueft wird, was der Browser TATSAECHLICH zulaesst:
 *   - eval, new Function, setTimeout(String) -> blockiert (kein unsafe-eval);
 *   - eingefuegtes Inline-Skript, on*-Attribut, javascript:-Adresse -> blockiert
 *     (die CSP faengt auch einen kuenftigen HTML-Senken-Fehler ab);
 *   - <object> -> blockiert (object-src 'none'); <base href> -> blockiert
 *     (base-uri 'none'); fremdes Skript -> blockiert (script-src 'self');
 *   - fetch zu einer fremden https-Herkunft -> blockiert (connect-src nennt die
 *     WalletConnect-Gegenstellen einzeln, kein pauschales https:; d18c95b, CRSF 2Q).
 * Gegenprobe ohne CSP: dieselbe Probe darf dort alles ausfuehren - sonst waere
 * die Probe selbst taub, und ein Bestehen bewiese nichts.
 *
 * Die Pfade decken beide CSP-Regeln ab ("/" fuer die Safe-App-Einbettung und
 * "/(.+)" fuer alles andere), einschliesslich der umgeschriebenen Seiten.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { startChrome } from '../test-support/headless-chrome.mjs';

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));

/** Kopfzeilen fuer `pathname` wie Vercel: jede passende Regel, spaetere ueberschreiben. */
export function headersFor(pathname) {
	const out = new Map();
	for (const rule of vercel.headers) {
		if (!new RegExp(`^${rule.source}$`).test(pathname)) continue;
		for (const { key, value } of rule.headers) out.set(key.toLowerCase(), value);
	}
	return out;
}

const PROBE = `
window.__result = { violations: [] };
document.addEventListener('securitypolicyviolation', (e) => window.__result.violations.push(e.effectiveDirective));
const r = window.__result;
const tryRun = (name, fn) => { try { fn(); r[name] = r[name] ?? 'ran'; } catch (e) { r[name] = e.name; } };
window.__hit = (name) => { r[name] = 'executed'; };
tryRun('eval', () => { eval("window.__hit('eval')"); });
tryRun('function', () => { new Function("window.__hit('function')")(); });
tryRun('stringTimer', () => { setTimeout("window.__hit('stringTimer')", 0); });
const s = document.createElement('script'); s.textContent = "window.__hit('inlineScript')"; document.body.append(s);
const img = document.createElement('img'); img.setAttribute('onerror', "window.__hit('inlineHandler')"); img.src = '/missing.png'; document.body.append(img);
const a = document.createElement('a'); a.href = "javascript:window.__hit('javascriptUrl')"; document.body.append(a); a.click();
const ext = document.createElement('script'); ext.src = 'http://localhost:' + location.port + '/foreign.js'; document.body.append(ext);
const o = document.createElement('object'); o.data = '/plugin.html'; o.type = 'text/html'; document.body.append(o);
fetch('https://127.0.0.1:1/connect-probe').catch(() => {});
const b = document.createElement('base'); b.href = 'http://localhost:' + location.port + '/'; document.head.append(b);
setTimeout(() => { window.__done = true; }, 800);
`;
const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body><script src="/probe.js"></script></body></html>';

function serve({ withCsp }) {
	const server = createServer((request, response) => {
		const { pathname } = new URL(request.url, 'http://127.0.0.1');
		const headers = withCsp ? Object.fromEntries(headersFor(pathname)) : {};
		delete headers['strict-transport-security'];
		const csp = headers['content-security-policy'];
		// upgrade-insecure-requests wuerde lokale http-Unterressourcen auf https heben; der Rest bleibt wortgleich.
		if (csp) headers['content-security-policy'] = csp.split(';').map((d) => d.trim()).filter((d) => d !== 'upgrade-insecure-requests').join('; ');
		if (pathname === '/probe.js') { response.writeHead(200, { ...headers, 'content-type': 'text/javascript' }); return response.end(PROBE); }
		if (pathname === '/foreign.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); return response.end("window.__hit('foreignScript')"); }
		if (pathname === '/plugin.html') { response.writeHead(200, { 'content-type': 'text/html' }); return response.end('<p>plugin</p>'); }
		if (pathname === '/api/csp-report') { response.writeHead(204); return response.end(); }
		if (pathname === '/missing.png') { response.writeHead(404, headers); return response.end(); }
		response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
		response.end(PAGE);
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const PATHS = ['/', '/link', '/guide', '/datenschutz', '/index.html'];
const BLOCKED = ['eval', 'function', 'stringTimer', 'inlineScript', 'inlineHandler', 'javascriptUrl', 'foreignScript'];

test('CSP-BROWSER every page path gets exactly one enforced CSP from vercel.json, and no HTML file carries its own', () => {
	for (const p of PATHS) {
		const h = headersFor(p);
		assert.ok(h.get('content-security-policy'), `${p}: no Content-Security-Policy`);
		assert.equal(h.has('content-security-policy-report-only'), false);
	}
	assert.equal(vercel.outputDirectory, 'dist-web', 'vercel.json serves the Vite build');
	for (const file of ['index.html', 'guide.html', 'impressum.html', 'datenschutz.html']) {
		assert.doesNotMatch(readFileSync(`web/${file}`, 'utf8'), /http-equiv/i, `web/${file} must not carry a competing meta policy`);
	}
});

test('CSP-BROWSER headless Chrome enforces the vercel.json policy: no eval, no inline or injected script, no object/base', async (t) => {
	const chrome = await startChrome();
	const withCsp = await serve({ withCsp: true });
	const without = await serve({ withCsp: false });
	t.after(async () => { await chrome.close(); withCsp.close(); without.close(); });

	// Gegenprobe: ohne Richtlinie fuehrt die Probe alles aus.
	const open = await chrome.visit(`http://127.0.0.1:${without.address().port}/`);
	for (const name of BLOCKED) assert.equal(open[name], 'executed', `control run without CSP: ${name} did not execute (probe is deaf)`);
	assert.deepEqual(open.violations, []);

	for (const p of PATHS) {
		const r = await chrome.visit(`http://127.0.0.1:${withCsp.address().port}${p}`);
		assert.equal(r.eval, 'EvalError', `${p}: eval was not blocked (unsafe-eval?)`);
		assert.equal(r.function, 'EvalError', `${p}: new Function was not blocked`);
		for (const name of BLOCKED) assert.notEqual(r[name], 'executed', `${p}: ${name} executed under the CSP`);
		for (const directive of ['script-src', 'object-src', 'base-uri', 'connect-src']) {
			assert.ok(r.violations.some((v) => v === directive || v.startsWith(`${directive}-`)), `${p}: no ${directive} violation reported (${r.violations.join(', ')})`);
		}
		assert.ok(r.violations.includes('object-src'), `${p}: <object> was not blocked by object-src`);
	}
});
