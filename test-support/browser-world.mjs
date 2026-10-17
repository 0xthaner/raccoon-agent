/*
	Fuehrt den ECHTEN Frontend-Quelltext (web/src/main.js, web/src/guide.js) im
	aufzeichnenden Mini-DOM aus (CRSF Phase 2P, CR-BROWSER-004).

	Ersetzt sind nur die Umgebung (document, window, location, Speicher, fetch) und
	die statischen Importe (echte Module, nur startAnalytics/mountEye als Stummel:
	Analytics bindet ein festes Skript der eigenen Domain ein, das Auge zeichnet auf
	ein Canvas). eval, Function und Zeichenketten-Timer sind Fallen, die jeden
	Aufruf protokollieren; dynamisches import() wird protokolliert und nur fuer
	feste Modulnamen beantwortet.
*/
import { readFileSync } from 'node:fs';
import { createRecordingDom } from './recording-dom.mjs';
import * as walletMethods from '../web/src/wallet-methods.js';
import * as eoaLogin from '../web/src/eoa-login.js';
import * as onchainLogin from '../web/src/onchain-login.js';

const source = (file) => readFileSync(new URL(`../web/src/${file}`, import.meta.url), 'utf8')
	.replace(/^import [^;]*;\n/gm, '')
	.replaceAll('import.meta.env', '__env')
	.replace(/\bimport\(/g, '__import(');

const TEMPLATE = { 'main.js': 'index.html', 'guide.js': 'guide.html' };

/** Antwort fuer fetch: { status, body } je "METHOD /pfad". */
function makeFetch(routes, calls, events) {
	return async (input, init = {}) => {
		const url = new URL(String(input), 'https://coverraccoon.com');
		const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`;
		calls.push({ key, url: url.href, body: init.body ?? null });
		events.push(`fetch ${key}`);
		const route = routes[key] ?? routes[url.pathname];
		const answer = typeof route === 'function' ? route(url, init) : route;
		if (!answer) return Response.json({ ok: false }, { status: 404 });
		return Response.json(answer.body, { status: answer.status ?? 200 });
	};
}

/**
 * Laedt `file` (main.js oder guide.js) mit `search` (z. B. '?code=...') und den
 * fetch-Antworten `routes`. Ergebnis: Mini-DOM, Protokolle, und `settle()`, das
 * wartet, bis alle angestossenen Abfragen und Darstellungen gelaufen sind.
 *
 * Phase 2Q (CR-VERIFY-003): optional `ethereum` (Browser-Wallet als window.ethereum)
 * und `imports` (Modulname -> Modul fuer dynamisches import(), z. B. ein AppKit-
 * Stummel). `events` haelt fetch-Aufrufe und history.replaceState in Reihenfolge.
 */
export async function loadPage(file, { search = '', routes = {}, storage = {}, ethereum = undefined, imports = {} } = {}) {
	const dom = createRecordingDom();
	const calls = [];
	const events = [];
	const code = { eval: [], Function: [], timers: [], imports: [] };
	const store = (initial) => { const m = new Map(Object.entries(initial)); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };
	const location = { search, origin: 'https://coverraccoon.com', protocol: 'https:', host: 'coverraccoon.com', pathname: '/', href: `https://coverraccoon.com/${search}`, reloaded: 0, reload() { this.reloaded++; } };
	const window = {
		dashboardData: undefined, ethereum, devicePixelRatio: 1, listeners: {},
		addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }, removeEventListener() {},
		matchMedia: () => ({ matches: true, addEventListener() {} }), location
	};
	window.self = window; window.top = window;
	const timer = (kind, real) => (fn, ms, ...rest) => {
		if (typeof fn !== 'function') { code.timers.push({ kind, arg: String(fn) }); throw new Error(`${kind} with a string`); }
		return real(fn, ms, ...rest);
	};
	const globals = {
		document: dom.document, window, location, DOMParser: dom.DOMParser,
		history: { replaceState: (_state, _title, url) => { events.push(`history.replaceState ${url}`); } },
		localStorage: store({ raccoon_hinweise: 'hinweise-2026-10-01', raccoon_language: 'en', ...storage }),
		sessionStorage: store({}),
		navigator: { language: 'en-GB', userAgent: 'recording-dom' },
		indexedDB: { databases: async () => [], deleteDatabase: () => ({}) },
		fetch: makeFetch(routes, calls, events),
		confirm: () => true, alert: () => {},
		setTimeout: timer('setTimeout', setTimeout), setInterval: timer('setInterval', setInterval), clearTimeout, clearInterval,
		requestAnimationFrame: () => 0,
		eval: (value) => { code.eval.push(String(value)); throw new Error('eval called'); },
		Function: function (...args) { code.Function.push(args.map(String)); throw new Error('Function constructor called'); },
		__env: { DEV: false, PROD: true },
		__import: async (specifier) => { code.imports.push(String(specifier)); if (Object.hasOwn(imports, specifier)) return imports[specifier]; throw new Error(`dynamic import ${specifier} not available in the recording DOM`); },
		...walletMethods, ...eoaLogin, ...onchainLogin,
		startAnalytics: () => {}, mountEye: () => {}
	};
	// Ausgangs-DOM ist die echte Vorlage (web/index.html bzw. web/guide.html).
	dom.loadTemplate(readFileSync(new URL(`../web/${TEMPLATE[file]}`, import.meta.url), 'utf8'));
	const body = `return (async () => {\n${source(file)}\n})();`;
	const run = new Function(...Object.keys(globals), body);
	const started = run(...Object.values(globals));
	const settle = async () => {
		await started;
		for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
	};
	await settle();
	return { dom, calls, code, window, settle, events };
}
