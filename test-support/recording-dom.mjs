/*
	Aufzeichnendes Mini-DOM fuer CRSF Phase 2P (CR-BROWSER-004).

	Kein Browser-Ersatz: es bildet nur die DOM-Schnittstellen nach, die das
	Frontend benutzt, und HAELT FEST, wie geschrieben wird.
	- Text (textContent, createTextNode, append(String)) wird als Daten gespeichert
	  und nie geparst - wie im DOM-Standard.
	- Jede Schnittstelle, die eine Zeichenkette als Markup parst (innerHTML,
	  outerHTML, insertAdjacentHTML, document.write/writeln,
	  Range#createContextualFragment, DOMParser, srcdoc), wird protokolliert und
	  wirft. Die Seite kann so keinen Markup-Pfad unbemerkt benutzen.
	- URL-Attribute (href, src, action, formAction) und setAttribute werden mit
	  ihrem Element protokolliert; createElement mit dem Tag.
*/
const PARSE_SINKS = ['innerHTML', 'outerHTML', 'srcdoc'];

export function createRecordingDom() {
	const log = { violations: [], urls: [], created: [], attributes: [], texts: [] };
	const violation = (what, value) => { log.violations.push({ what, value: String(value) }); throw new Error(`HTML parsing sink used: ${what}`); };

	class Node {
		constructor() { this.childNodes = []; this.parentNode = null; this.listeners = {}; }
		get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
		set textContent(value) {
			for (const c of this.childNodes) c.parentNode = null;
			const text = String(value ?? '');
			this.childNodes = text ? [new Text(text, this)] : [];
			if (text) log.texts.push(text);
		}
		appendChild(child) { child.parentNode?.removeChild(child); child.parentNode = this; this.childNodes.push(child); return child; }
		removeChild(child) { this.childNodes = this.childNodes.filter((c) => c !== child); child.parentNode = null; return child; }
		append(...items) { for (const item of items) this.appendChild(typeof item === 'string' ? textNode(item) : item); }
		prepend(...items) { const nodes = items.map((i) => (typeof i === 'string' ? textNode(i) : i)); for (const n of nodes) { n.parentNode?.removeChild(n); n.parentNode = this; } this.childNodes.unshift(...nodes); }
		replaceChildren(...items) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...items); }
		remove() { this.parentNode?.removeChild(this); }
		after(...items) {
			const parent = this.parentNode; if (!parent) return;
			const nodes = items.map((i) => (typeof i === 'string' ? textNode(i) : i));
			const at = parent.childNodes.indexOf(this) + 1;
			for (const n of nodes) { n.parentNode?.removeChild(n); n.parentNode = parent; }
			parent.childNodes.splice(at, 0, ...nodes);
		}
		addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
		removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
		dispatchEvent(event) { for (const fn of this.listeners[event.type] ?? []) fn.call(this, event); return true; }
	}
	class Text extends Node {
		constructor(data, parent = null) { super(); this.data = data; this.parentNode = parent; this.nodeType = 3; }
		get textContent() { return this.data; }
		set textContent(value) { this.data = String(value ?? ''); }
	}
	const textNode = (value) => { const t = new Text(String(value)); log.texts.push(t.data); return t; };

	class Element extends Node {
		constructor(tag) {
			super();
			this.tagName = String(tag).toUpperCase();
			this.nodeType = 1;
			this.attrs = new Map();
			this.className = '';
			this.hidden = false; this.disabled = false; this.checked = false;
			this.style = { cssText: '' };
			this.dataset = {};
			const self = this;
			this.classList = {
				_set() { return new Set(self.className.split(/\s+/).filter(Boolean)); },
				add(...n) { const s = this._set(); n.forEach((x) => s.add(x)); self.className = [...s].join(' '); },
				remove(...n) { const s = this._set(); n.forEach((x) => s.delete(x)); self.className = [...s].join(' '); },
				toggle(n, force) { const s = this._set(); const on = force ?? !s.has(n); if (on) s.add(n); else s.delete(n); self.className = [...s].join(' '); return on; },
				contains(n) { return this._set().has(n); }
			};
		}
		get id() { return this.attrs.get('id') ?? ''; }
		set id(v) { this.attrs.set('id', String(v)); }
		setAttribute(name, value) { log.attributes.push({ tag: this.tagName, name: String(name), value: String(value) }); if (/^on/i.test(name)) violation(`setAttribute(${name})`, value); this.attrs.set(String(name), String(value)); if (['href', 'src', 'action', 'formaction'].includes(String(name).toLowerCase())) log.urls.push({ tag: this.tagName, attr: name, value: String(value) }); }
		getAttribute(name) { return this.attrs.get(name) ?? null; }
		removeAttribute(name) { this.attrs.delete(name); }
		insertAdjacentHTML(_where, html) { violation('insertAdjacentHTML', html); }
		focus() { dom.document.activeElement = this; }
		click() { this.dispatchEvent({ type: 'click', target: this }); }
		closest() { return null; }
		getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
		querySelector(sel) { return query(this, sel)[0] ?? null; }
		querySelectorAll(sel) { return query(this, sel); }
	}
	for (const name of PARSE_SINKS) {
		Object.defineProperty(Element.prototype, name, { get() { return ''; }, set(value) { violation(name, value); } });
	}
	for (const attr of ['href', 'src', 'action', 'formAction']) {
		Object.defineProperty(Element.prototype, attr, {
			get() { return this.attrs.get(attr) ?? ''; },
			set(value) { const v = String(value); this.attrs.set(attr, v); log.urls.push({ tag: this.tagName, attr, value: v }); }
		});
	}

	function all(root) { const out = []; const walk = (n) => { for (const c of n.childNodes) if (c instanceof Element) { out.push(c); walk(c); } }; walk(root); return out; }
	function matchesCompound(el, sel) {
		const parts = sel.match(/[#.]?[a-z0-9_-]+|\[[^\]]+\]/gi) ?? [];
		return parts.length > 0 && parts.join('') === sel && parts.every((p) => matchOne(el, p));
	}
	function matchOne(el, p) {
		if (p.startsWith('#')) return el.id === p.slice(1);
		if (p.startsWith('.')) return el.classList.contains(p.slice(1));
		const attr = /^\[([a-z-]+)(?:="([^"]*)")?\]$/i.exec(p);
		if (attr) return attr[2] === undefined ? el.attrs.has(attr[1]) : el.attrs.get(attr[1]) === attr[2];
		return el.tagName === p.toUpperCase();
	}
	/** Unterstuetzt: #id, .klasse, tag, [attr], [attr="wert"], Verbund und Nachfahre ("a b"). */
	function query(root, sel) {
		const steps = sel.trim().split(/\s+/);
		let scope = [root];
		for (const step of steps) scope = [...new Set(scope.flatMap((s) => all(s).filter((el) => matchesCompound(el, step))))];
		return scope;
	}
	/** Baut die statische Vorlage (z. B. web/index.html) als Ausgangs-DOM; nicht protokolliert. */
	const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
	function loadTemplate(html) {
		const bodyHtml = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
		const stack = [body];
		const token = /<!--[\s\S]*?-->|<\/([a-z0-9-]+)\s*>|<([a-z0-9-]+)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/gi;
		for (const m of bodyHtml.matchAll(token)) {
			const top = stack.at(-1);
			if (m[1]) { const i = stack.map((e) => e.tagName).lastIndexOf(m[1].toUpperCase()); if (i > 0) stack.length = i; continue; }
			if (m[2]) {
				const el = new Element(m[2]);
				for (const a of (m[3] ?? '').matchAll(/([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
					const name = a[1].toLowerCase(); const value = a[2] ?? a[3] ?? a[4] ?? '';
					el.attrs.set(name, value);
					if (name === 'class') el.className = value;
					if (name === 'hidden') el.hidden = true;
					if (name.startsWith('data-')) el.dataset[name.slice(5).replace(/-([a-z])/g, (_x, c) => c.toUpperCase())] = value;
				}
				top.childNodes.push(el); el.parentNode = top;
				if (!VOID.has(m[2].toLowerCase()) && !/\/>$/.test(m[0]) && m[2].toLowerCase() !== 'script') stack.push(el);
				continue;
			}
			if (m[4] && m[4].trim()) { const t = new Text(m[4], top); top.childNodes.push(t); }
		}
	}

	const body = new Element('body');
	const documentElement = new Element('html');
	documentElement.appendChild(body);
	const document = {
		body, documentElement, title: 'CoverRaccoon', hidden: false, activeElement: null, listeners: {},
		createElement(tag) { log.created.push(String(tag)); return new Element(tag); },
		createTextNode: (value) => textNode(value),
		querySelector: (sel) => query(documentElement, sel)[0] ?? null,
		querySelectorAll: (sel) => query(documentElement, sel),
		getElementById(id) { return this.querySelector(`#${id}`); },
		addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
		removeEventListener() {},
		write: (html) => violation('document.write', html),
		writeln: (html) => violation('document.writeln', html),
		createRange: () => ({ createContextualFragment: (html) => violation('Range#createContextualFragment', html) })
	};
	const dom = { document, log, Element, Text, loadTemplate, all: () => all(documentElement), textOf: () => documentElement.textContent };
	dom.DOMParser = class { parseFromString(html) { return violation('DOMParser#parseFromString', html); } };
	return dom;
}
