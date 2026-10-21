/**
 * CRSF Phase 2P, CR-BROWSER-004: Strukturpruefung des Browser-Quelltexts am
 * Syntaxbaum (Vites parseAst), nicht am Text - Kommentare, Zeichenketten und
 * Zeilenumbrueche koennen sie nicht taeuschen.
 *
 * P2 ("no eval/dynamic code"): in web/src/**.js gibt es
 *   - keinen Aufruf von eval (auch nicht als window.eval / ['eval']),
 *   - keinen Function-Konstruktor (Function(...), new Function(...)),
 *   - keinen Timer mit Zeichenkette (setTimeout/setInterval nur mit Funktion),
 *   - kein import() mit berechnetem Modulnamen.
 * P1 (Markup- und Adress-Senken): keine Zuweisung an innerHTML/outerHTML/srcdoc,
 * kein insertAdjacentHTML/document.write/createContextualFragment/DOMParser,
 * kein setAttribute mit on*-Namen oder berechnetem Namen. Jede Zuweisung an
 * href/src/action ist im Inventar (README, CR-BROWSER-004) erfasst; eine neue
 * Adress-Senke laesst den Test scheitern, bis sie dort eingetragen und
 * eingeordnet ist.
 *
 * Laufzeitgegenstueck: test/browser-render-sinks.test.mjs (echter main.js mit
 * Fallen fuer eval/Function/String-Timer) und test/csp-browser-enforced.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAst } from 'vite';

const ROOT = 'web/src';
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
export const BROWSER_FILES = files(ROOT).sort();

/*
	Inventar der Adress-Senken (Datei, Eigenschaft, Form des Werts). Einordnung
	siehe README "CR-BROWSER-004 browser-side inventory":
	- nexus: fester Wert aus NEXUS_PRODUCT_PAGES, gegen https://app.nexusmutual.io/... geprueft;
	- telegram: Vorlage mit festem "https://t.me/" vorne (Schema und Host fest);
	- dashboard: Literal '/'.
	- nexus-cover (P3, 18.10.2026): Wording-/Annex-Link nur nach Pruefung gegen
	  ^https://api.nexusmutual.io/ipfs/<CID>$ (IPFS_URL), sonst kein Link.
*/
const URL_SINKS = [
	'web/src/main.js href Identifier(url)',
	'web/src/main.js href ConditionalExpression(TemplateLiteral:https://t.me/|TemplateLiteral:https://t.me/)',
	'web/src/main.js href TemplateLiteral:https://t.me/',
	'web/src/main.js href Literal:/',
	'web/src/nexus-cover.js href Identifier(url)',
	// Uniswap v3 (21.10.2026): derselbe Wording-Link, nur nach derselben IPFS-Pruefung wie nexus-cover.js
	'web/src/uniswap-cover.js href Identifier(url)'
];

function walk(node, visit, parent = null) {
	if (Array.isArray(node)) { for (const n of node) walk(n, visit, parent); return; }
	if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
	visit(node, parent);
	for (const key of Object.keys(node)) if (key !== 'parent') walk(node[key], visit, node);
}
const propName = (m) => (m?.type === 'MemberExpression' ? (m.computed ? (m.property.type === 'Literal' ? String(m.property.value) : null) : m.property.name) : null);
const calleeName = (c) => (c?.type === 'Identifier' ? c.name : propName(c));
const valueShape = (v) => {
	if (v.type === 'Literal') return `Literal:${v.value}`;
	if (v.type === 'TemplateLiteral') return `TemplateLiteral:${v.quasis[0].value.cooked}`;
	if (v.type === 'Identifier') return `Identifier(${v.name})`;
	if (v.type === 'ConditionalExpression') return `ConditionalExpression(${valueShape(v.consequent)}|${valueShape(v.alternate)})`;
	return v.type;
};

/** Alle Befunde in `source` (Datei `file`): { kind, detail }. */
export function scan(source, file = 'inline.js') {
	const ast = parseAst(source);
	const functionNames = new Set();
	walk(ast, (n) => {
		if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression') && n.id) functionNames.add(n.id.name);
		if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(n.type)) for (const p of n.params) if (p.type === 'Identifier') functionNames.add(p.name);
		if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && ['ArrowFunctionExpression', 'FunctionExpression'].includes(n.init?.type)) functionNames.add(n.id.name);
	});
	const found = [];
	walk(ast, (n) => {
		if (n.type === 'CallExpression' || n.type === 'NewExpression') {
			const name = calleeName(n.callee);
			if (name === 'eval') found.push({ kind: 'eval', detail: file });
			if (name === 'Function') found.push({ kind: 'Function', detail: file });
			if (['setTimeout', 'setInterval'].includes(name)) {
				const first = n.arguments[0];
				const ok = first && (['ArrowFunctionExpression', 'FunctionExpression'].includes(first.type) || (first.type === 'Identifier' && functionNames.has(first.name)));
				if (!ok) found.push({ kind: 'string-timer', detail: `${file} ${name}(${first?.type})` });
			}
			if (['insertAdjacentHTML', 'write', 'writeln', 'createContextualFragment', 'parseFromString'].includes(name)) found.push({ kind: 'html-sink', detail: `${file} ${name}()` });
			if (name === 'DOMParser') found.push({ kind: 'html-sink', detail: `${file} DOMParser` });
			if (name === 'setAttribute') {
				const attr = n.arguments[0];
				if (attr?.type !== 'Literal') found.push({ kind: 'computed-attribute', detail: `${file} setAttribute(${attr?.type})` });
				else if (/^on/i.test(String(attr.value)) || /^(srcdoc|style)$/i.test(String(attr.value))) found.push({ kind: 'html-sink', detail: `${file} setAttribute(${attr.value})` });
				else if (/^(href|src|action|formaction|xlink:href)$/i.test(String(attr.value))) found.push({ kind: 'url-sink', detail: `${file} ${String(attr.value).toLowerCase()} ${valueShape(n.arguments[1])}` });
			}
		}
		if (n.type === 'ImportExpression' && !(n.source.type === 'Literal' && typeof n.source.value === 'string')) found.push({ kind: 'dynamic-import', detail: `${file} import(${n.source.type})` });
		if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression') {
			const name = propName(n.left);
			if (n.left.computed && n.left.property.type !== 'Literal') found.push({ kind: 'computed-property-write', detail: `${file} [${n.left.property.type}] =` });
			if (['innerHTML', 'outerHTML', 'srcdoc'].includes(name)) found.push({ kind: 'html-sink', detail: `${file} .${name} =` });
			if (['href', 'src', 'action', 'formAction'].includes(name)) found.push({ kind: 'url-sink', detail: `${file} ${name.toLowerCase()} ${valueShape(n.right)}` });
		}
	});
	return found;
}

const all = BROWSER_FILES.flatMap((file) => scan(readFileSync(file, 'utf8'), file.split(path.sep).join('/')));

test('BROWSER-STRUCT the scan covers every browser module', () => {
	for (const f of ['main.js', 'guide.js', 'safe-app.js', 'eoa-login.js', 'onchain-login.js', 'wallet-methods.js', 'analytics.js', 'eye.js', 'fixtures/positions-fixture.js']) {
		assert.ok(BROWSER_FILES.includes(path.join(ROOT, f)), `${f} not scanned`);
	}
});

test('BROWSER-STRUCT P2 no eval, Function constructor, string timer or computed import() in web/src', () => {
	assert.deepEqual(all.filter((f) => ['eval', 'Function', 'string-timer', 'dynamic-import'].includes(f.kind)), []);
});

test('BROWSER-STRUCT P1 no HTML-parsing sink, no event-handler or computed attribute, no computed property write', () => {
	assert.deepEqual(all.filter((f) => ['html-sink', 'computed-attribute', 'computed-property-write'].includes(f.kind)), []);
});

test('BROWSER-STRUCT P1 every URL sink is in the reviewed inventory', () => {
	assert.deepEqual(all.filter((f) => f.kind === 'url-sink').map((f) => f.detail).sort(), [...URL_SINKS].sort());
});

test('BROWSER-STRUCT the scanner detects each forbidden form (self-check)', () => {
	const kinds = (src) => scan(src).map((f) => f.kind);
	assert.deepEqual(kinds('eval("1")'), ['eval']);
	assert.deepEqual(kinds('window["eval"]("1")'), ['eval']);
	assert.deepEqual(kinds('new Function("return 1")'), ['Function']);
	assert.deepEqual(kinds('setTimeout("x()", 1)'), ['string-timer']);
	assert.deepEqual(kinds('const s = "x()"; setInterval(s, 1)'), ['string-timer']);
	assert.deepEqual(kinds('import(name)'), ['dynamic-import']);
	assert.deepEqual(kinds('el.innerHTML = v'), ['html-sink']);
	assert.deepEqual(kinds('el["outerHTML"] = v'), ['html-sink']);
	assert.deepEqual(kinds('el.insertAdjacentHTML("beforeend", v)'), ['html-sink']);
	assert.deepEqual(kinds('document.write(v)'), ['html-sink']);
	assert.deepEqual(kinds('el.setAttribute("onclick", v)'), ['html-sink']);
	assert.deepEqual(kinds('el.setAttribute(name, v)'), ['computed-attribute']);
	assert.deepEqual(kinds('el[key] = v'), ['computed-property-write']);
	assert.deepEqual(kinds('a.href = data.url'), ['url-sink']);
	assert.deepEqual(kinds('// el.innerHTML = v\nconst s = "eval(1)";'), []);
	assert.deepEqual(kinds('setTimeout(() => 1, 1); function f() {} setTimeout(f, 1)'), []);
});
