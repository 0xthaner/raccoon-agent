/*
	TEXT AUS DEN NEXUS-WORDING- UND ANNEX-PDFS.

	Alle 163 Wording- und Annex-Dokumente, die Nexus am 09.10.2026 ausgeliefert
	hat, sind PDFs aus dem Google-Docs-Renderer (Skia): Flate-komprimierte
	Inhaltsstroeme, Type0-Schriften mit Identity-H und ToUnicode-Tabelle, keine
	Verschluesselung, drei mit Objekt-Streams. Dieser Leser kann genau das und
	nicht mehr. Alles andere - fehlende ToUnicode-Tabelle, unbekannter Filter,
	Verschluesselung, zu grosse Stroeme - wirft einen Fehler, und der Agent
	verlinkt dann wie bisher nur die Dokumente.

	Ausgefuehrt wird nichts: keine Schriftprogramme, keine Bilder, kein
	JavaScript, keine Links. Entpackt werden nur Seiteninhalte, ToUnicode-
	Tabellen und Objekt-Streams, jeweils mit Groessendeckel, damit eine
	Bild- oder Zip-Bombe nicht den Speicher fuellt.

	Sicherheitsreview 10.10.2026: Jede Schleife, deren Laenge das PDF
	bestimmt, zahlt in ein gemeinsames Arbeitsbudget (Budget); Regexe ueber
	PDF-Daten haben nur beschraenkte Quantoren. Fehlende Objekte, Seiten-
	inhalte oder XObjects und unsichtbarer Text brechen ab, statt still
	Teile zu ueberspringen - ein Wording ohne seine Ausschluss-Seite waere
	schlimmer als gar keins.
*/

import { constants, inflateSync } from 'node:zlib';

const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_INFLATED = 24 * 1024 * 1024;
const MAX_PAGES = 120;
const MAX_LINES = 20_000;
const MAX_FORM_DEPTH = 4;
const MAX_FORM_CALLS = 2_000;
const MAX_OBJECTS = 100_000;
const MAX_NESTING = 64;
const MAX_FONTS = 128;
const MAX_CMAP_ENTRIES = 0x20000;
const MAX_CMAP_TARGET_UNITS = 16;
const MAX_WIDTH_ENTRIES = 0x20000;
// Summe aller CMap- und Breiteneintraege eines Dokuments; echte Nexus-PDFs liegen weit darunter.
const MAX_TABLE_ENTRIES = 1_000_000;
const MAX_GLYPHS = 2_000_000;
const MAX_TEXT_CHARS = 1_000_000;
const MAX_TITLE_CHARS = 300;
// Lexer-Zeichen, Operatoren, Tabelleneintraege: das Mehrfache des groessten echten Dokuments.
const MAX_WORK = 40_000_000;

export class PdfFormatError extends Error {}

const fail = (reason) => { throw new PdfFormatError(reason); };

class Budget {
	constructor(limit = MAX_WORK) { this.limit = limit; this.used = 0; this.entries = 0; }
	spend(units) {
		this.used += units;
		if (this.used > this.limit) fail('work limit exceeded');
	}
	entry() {
		if (++this.entries > MAX_TABLE_ENTRIES) fail('font tables too large');
		this.spend(1);
	}
}

/* ---------------------------------------------------------------- Lexer -- */

const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITER = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));

class Ref { constructor(num) { this.num = num; } }
class Name { constructor(value) { this.value = value; } }
class Str { constructor(bytes) { this.bytes = bytes; } }
class Op { constructor(value) { this.value = value; } }
const END = Symbol('end');

class Lexer {
	constructor(text, pos = 0, budget = new Budget()) { this.s = text; this.pos = pos; this.budget = budget; }

	skipSpace() {
		const s = this.s;
		while (this.pos < s.length) {
			const c = s.charCodeAt(this.pos);
			if (WHITESPACE.has(c)) this.pos++;
			else if (c === 37) { while (this.pos < s.length && !/[\r\n]/.test(s[this.pos])) this.pos++; }
			else break;
		}
	}

	token() {
		const start = this.pos;
		const tok = this.read();
		this.budget.spend(1 + Math.max(0, this.pos - start));
		return tok;
	}

	read() {
		this.skipSpace();
		const s = this.s;
		if (this.pos >= s.length) return END;
		const c = s[this.pos];
		if (c === '/') {
			let end = this.pos + 1;
			while (end < s.length && !WHITESPACE.has(s.charCodeAt(end)) && !DELIMITER.has(s.charCodeAt(end))) end++;
			const raw = s.slice(this.pos + 1, end);
			this.pos = end;
			return new Name(raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
		}
		if (c === '(') return this.literal();
		if (c === '<') {
			if (s[this.pos + 1] === '<') { this.pos += 2; return '<<'; }
			const end = s.indexOf('>', this.pos);
			if (end < 0) fail('unterminated hex string');
			let hex = s.slice(this.pos + 1, end).replace(/\s+/g, '');
			this.pos = end + 1;
			if (!/^[0-9a-fA-F]*$/.test(hex)) fail('bad hex string');
			if (hex.length % 2) hex += '0';
			let bytes = '';
			for (let i = 0; i < hex.length; i += 2) bytes += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
			return new Str(bytes);
		}
		if (c === '>') {
			if (s[this.pos + 1] === '>') { this.pos += 2; return '>>'; }
			fail('stray >');
		}
		if (c === '[' || c === ']' || c === '{' || c === '}') { this.pos++; return c; }
		if (c === ')') fail('stray )');
		let end = this.pos;
		while (end < s.length && !WHITESPACE.has(s.charCodeAt(end)) && !DELIMITER.has(s.charCodeAt(end))) end++;
		const word = s.slice(this.pos, end);
		this.pos = end;
		if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
		return new Op(word);
	}

	literal() {
		const s = this.s;
		let depth = 1, out = '';
		this.pos++;
		while (this.pos < s.length) {
			const c = s[this.pos++];
			if (c === '\\') {
				const n = s[this.pos++];
				const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
				if (n in map) out += map[n];
				else if (/[0-7]/.test(n)) {
					let oct = n;
					while (oct.length < 3 && /[0-7]/.test(s[this.pos])) oct += s[this.pos++];
					out += String.fromCharCode(parseInt(oct, 8) & 0xff);
				} else if (n === '\r') { if (s[this.pos] === '\n') this.pos++; }
				else if (n !== '\n') out += n;
			} else if (c === '(') { depth++; out += c; }
			else if (c === ')') { if (--depth === 0) return new Str(out); out += c; }
			else out += c;
		}
		fail('unterminated string');
	}

	/** Ein vollstaendiges Objekt; "n g R" wird zur Referenz. */
	object(tok = this.token(), depth = 0) {
		if (depth > MAX_NESTING) fail('nesting too deep');
		if (tok === '<<') {
			const dict = Object.create(null);
			for (;;) {
				const key = this.token();
				if (key === '>>') return dict;
				if (!(key instanceof Name)) fail('bad dictionary key');
				dict[key.value] = this.object(this.token(), depth + 1);
			}
		}
		if (tok === '[') {
			const arr = [];
			for (;;) {
				const t = this.token();
				if (t === ']') return arr;
				if (t === END) fail('unterminated array');
				arr.push(this.object(t, depth + 1));
			}
		}
		if (typeof tok === 'number' && Number.isInteger(tok) && tok >= 0) {
			const save = this.pos;
			const gen = this.token();
			if (typeof gen === 'number' && Number.isInteger(gen)) {
				const r = this.token();
				if (r instanceof Op && r.value === 'R') return new Ref(tok);
			}
			this.pos = save;
			return tok;
		}
		if (tok === END) fail('unexpected end');
		return tok;
	}
}

/* --------------------------------------------------------- Object table -- */

// Beschraenkte Quantoren und kein Start mitten in einer Ziffernfolge: sonst
// waechst die Laufzeit quadratisch mit langen Ziffern- oder Leerraumketten.
const DIRECT_LENGTH = /(?<!\d)(\d{1,10})[ \t\r\n\f\0]{1,64}\d{1,5}[ \t\r\n\f\0]{1,64}obj[ \t\r\n\f\0]{0,64}(\d{1,10})[ \t\r\n\f\0]{0,64}endobj/g;
const OBJECT_HEADER = /(?<!\d)(\d{1,10})[ \t\r\n\f\0]{1,64}(\d{1,5})[ \t\r\n\f\0]{1,64}obj\b/g;

function readObjects(s, budget) {
	const directLengths = new Map();
	for (const m of s.matchAll(DIRECT_LENGTH)) directLengths.set(Number(m[1]), Number(m[2]));
	const objects = new Map();
	const header = new RegExp(OBJECT_HEADER.source, 'g');
	let m;
	while ((m = header.exec(s))) {
		if (objects.size >= MAX_OBJECTS) fail('too many objects');
		const lexer = new Lexer(s, header.lastIndex, budget);
		const value = lexer.object();
		const after = lexer.token();
		let data = null;
		if (after instanceof Op && after.value === 'stream') {
			let start = lexer.pos;
			if (s[start] === '\r') start++;
			if (s[start] === '\n') start++;
			const length = value?.Length instanceof Ref ? directLengths.get(value.Length.num) : value?.Length;
			let end = Number.isInteger(length) && length >= 0 ? start + length : -1;
			if (end < 0 || !/^\s*endstream/.test(s.slice(end, end + 32))) {
				end = s.indexOf('endstream', start);
				if (end < 0) fail('unterminated stream');
				while (end > start && /[\r\n]/.test(s[end - 1])) end--;
			}
			data = s.slice(start, end);
			budget.spend(data.length);
			header.lastIndex = s.indexOf('endstream', end) + 9;
		} else {
			header.lastIndex = Math.max(header.lastIndex, lexer.pos);
		}
		objects.set(Number(m[1]), { value, data });
	}
	return objects;
}

class Document {
	constructor(bytes) {
		this.s = Buffer.from(bytes).toString('latin1');
		if (!this.s.startsWith('%PDF-')) fail('not a PDF');
		if (/\/Encrypt\b/.test(this.s)) fail('encrypted PDF');
		this.inflated = 0;
		this.formCalls = 0;
		this.fontCount = 0;
		this.resourceFonts = new Map();
		this.budget = new Budget();
		this.objects = readObjects(this.s, this.budget);
		this.expandObjectStreams();
	}

	expandObjectStreams() {
		for (const [, obj] of [...this.objects]) {
			if (obj.value?.Type?.value !== 'ObjStm') continue;
			const { N: count, First: first } = obj.value;
			if (!Number.isInteger(count) || count < 0 || count > MAX_OBJECTS) fail('bad object stream count');
			const data = this.decode(obj);
			if (!Number.isInteger(first) || first < 0 || first > data.length) fail('bad object stream offset');
			const lexer = new Lexer(data, 0, this.budget);
			const pairs = [];
			for (let i = 0; i < count; i++) {
				const pair = [lexer.token(), lexer.token()];
				if (!pair.every((n) => Number.isInteger(n) && n >= 0)) fail('bad object stream');
				pairs.push(pair);
			}
			for (const [num, offset] of pairs) {
				if (this.objects.has(num)) continue;
				if (this.objects.size >= MAX_OBJECTS) fail('too many objects');
				this.objects.set(num, { value: new Lexer(data, first + offset, this.budget).object(), data: null });
			}
		}
	}

	resolve(value, depth = 0) {
		if (!(value instanceof Ref)) return value;
		if (depth > 16) fail('reference loop');
		const obj = this.objects.get(value.num);
		return obj ? this.resolve(obj.value, depth + 1) : null;
	}

	stream(value) {
		const obj = value instanceof Ref ? this.objects.get(value.num) : null;
		return obj?.data != null ? obj : null;
	}

	decode(obj) {
		const filters = [obj.value.Filter].flat().filter(Boolean).map((f) => this.resolve(f));
		const parms = this.resolve(obj.value.DecodeParms);
		if (parms && [parms].flat().some((p) => this.resolve(p)?.Predictor > 1)) fail('predictor not supported');
		let buffer = Buffer.from(obj.data, 'latin1');
		for (const filter of filters) {
			if (filter?.value !== 'FlateDecode') fail(`filter ${filter?.value} not supported`);
			try { buffer = inflateSync(buffer, { maxOutputLength: MAX_STREAM_BYTES, finishFlush: constants.Z_SYNC_FLUSH }); }
			catch { fail('stream too large or corrupt'); }
		}
		this.inflated += buffer.length;
		if (this.inflated > MAX_TOTAL_INFLATED) fail('document too large');
		return buffer.toString('latin1');
	}

	title() {
		for (const { value } of this.objects.values()) {
			if (value && typeof value === 'object' && value.Title instanceof Str && !value.Type) {
				const title = decodeTextString(value.Title.bytes);
				return title.length <= MAX_TITLE_CHARS ? title : null;
			}
		}
		return null;
	}

	pages() {
		const catalog = [...this.objects.values()].map((o) => o.value).filter((v) => v?.Type?.value === 'Catalog').at(-1);
		if (!catalog) fail('no catalog');
		const out = [];
		const seen = new Set();
		const walk = (ref, inherited, depth) => {
			if (depth > 32 || out.length > MAX_PAGES) fail('page tree too deep or too large');
			if (ref instanceof Ref) { if (seen.has(ref.num)) fail('page tree loop'); seen.add(ref.num); }
			const node = this.resolve(ref);
			if (!node) fail('missing page tree node');
			const resources = node.Resources ?? inherited;
			const kids = this.resolve(node.Kids);
			if (node.Type?.value === 'Pages') {
				if (!Array.isArray(kids)) fail('bad page tree');
				this.budget.spend(kids.length);
				for (const kid of kids) walk(kid, resources, depth + 1);
			} else if (node.Type?.value === 'Page') out.push({ node, resources });
			else fail('unexpected page tree node');
		};
		walk(catalog.Pages, null, 0);
		if (!out.length) fail('no pages');
		return out;
	}
}

/* ----------------------------------------------------------------- Fonts -- */

function utf16(bytes) {
	let out = '';
	for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
	return out;
}

function decodeTextString(bytes) {
	return bytes.startsWith('\xfe\xff') ? utf16(bytes.slice(2)) : bytes;
}

function hexToBytes(hex) {
	let out = '';
	for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
	return out;
}

/**
 * ToUnicode-CMap: codespacerange, bfchar und bfrange; mehr steht in den
 * Nexus-PDFs nicht. Linear ueber den Lexer, jeder Eintrag zahlt ins Budget.
 */
export function parseToUnicode(text, budget = new Budget()) {
	const map = new Map();
	let codeLength = null;
	const lexer = new Lexer(text, 0, budget);
	const next = () => {
		const tok = lexer.token();
		if (tok === END) fail('unterminated cmap block');
		return tok;
	};
	const code = (str) => {
		if (!(str instanceof Str) || str.bytes.length < 1 || str.bytes.length > 2) fail('bad cmap code');
		return str.bytes.length === 2 ? (str.bytes.charCodeAt(0) << 8) | str.bytes.charCodeAt(1) : str.bytes.charCodeAt(0);
	};
	const target = (str) => {
		if (!(str instanceof Str) || str.bytes.length % 2 || str.bytes.length > MAX_CMAP_TARGET_UNITS * 2) fail('bad cmap target');
		return utf16(str.bytes);
	};
	const set = (key, value) => {
		map.set(key, value);
		budget.entry();
		if (map.size > MAX_CMAP_ENTRIES) fail('cmap too large');
	};
	for (;;) {
		const tok = lexer.token();
		if (tok === END) break;
		if (!(tok instanceof Op)) continue;
		if (tok.value === 'begincodespacerange') {
			for (let t = next(); !(t instanceof Op && t.value === 'endcodespacerange'); t = next()) {
				if (t instanceof Str && codeLength == null) codeLength = t.bytes.length;
			}
		} else if (tok.value === 'beginbfchar') {
			for (let t = next(); !(t instanceof Op && t.value === 'endbfchar'); t = next()) set(code(t), target(next()));
		} else if (tok.value === 'beginbfrange') {
			for (let t = next(); !(t instanceof Op && t.value === 'endbfrange'); t = next()) {
				const lo = code(t), hi = code(next());
				const dst = lexer.object(next());
				if (hi < lo || hi - lo > 0xffff) fail('bad bfrange');
				if (Array.isArray(dst)) {
					dst.forEach((item, i) => { if (lo + i <= hi) set(lo + i, target(item)); });
				} else {
					const base = target(dst) && dst.bytes;
					if (base.length < 2) fail('bad bfrange target');
					for (let c = lo; c <= hi; c++) {
						const last = base.charCodeAt(base.length - 1) + (c - lo);
						const prev = base.charCodeAt(base.length - 2) + (last >> 8);
						set(c, utf16(base.slice(0, -2) + String.fromCharCode(prev & 0xff, last & 0xff)));
					}
				}
			}
		}
	}
	codeLength ??= 2;
	if (codeLength !== 1 && codeLength !== 2) fail('unsupported code length');
	return { map, codeLength };
}

/** Glyphbreiten (1/1000 em) - nur, um Wortabstaende ohne Leerzeichen-Glyphe zu erkennen. */
function fontWidths(doc, font, type0) {
	const widths = new Map();
	if (type0) {
		const cid = doc.resolve(doc.resolve(font.DescendantFonts)?.[0]);
		const w = doc.resolve(cid?.W) ?? [];
		if (!Array.isArray(w)) fail('bad width array');
		let entries = 0;
		const set = (c, width) => {
			if (++entries > MAX_WIDTH_ENTRIES) fail('width array too large');
			doc.budget.entry();
			widths.set(c, width);
		};
		for (let i = 0; i < w.length;) {
			const first = doc.resolve(w[i]);
			const next = doc.resolve(w[i + 1]);
			if (!Number.isInteger(first)) fail('bad width array');
			if (Array.isArray(next)) {
				next.forEach((width, k) => set(first + k, Number(doc.resolve(width)) || 0));
				i += 2;
			} else {
				const last = next, width = Number(doc.resolve(w[i + 2])) || 0;
				if (!Number.isInteger(last) || last < first || last - first > 0xffff) fail('bad width array');
				for (let c = first; c <= last; c++) set(c, width);
				i += 3;
			}
		}
		return { widths, defaultWidth: Number(doc.resolve(cid?.DW)) || 1000 };
	}
	const first = Number(doc.resolve(font.FirstChar)) || 0;
	const simple = doc.resolve(font.Widths) ?? [];
	if (!Array.isArray(simple) || simple.length > 256) fail('bad width array');
	simple.forEach((width, k) => widths.set(first + k, Number(doc.resolve(width)) || 0));
	return { widths, defaultWidth: 500 };
}

function loadFonts(doc, resources, cache) {
	const resolved = doc.resolve(resources);
	if (resolved && doc.resourceFonts.has(resolved)) return doc.resourceFonts.get(resolved);
	const fonts = Object.create(null);
	const dict = doc.resolve(resolved?.Font) ?? {};
	const entries = Object.entries(dict);
	if (entries.length > MAX_FONTS) fail('too many fonts');
	for (const [name, ref] of entries) {
		const font = doc.resolve(ref);
		const key = font && typeof font === 'object' ? font : null;
		if (key && cache.has(key)) { fonts[name] = cache.get(key); continue; }
		if (++doc.fontCount > MAX_FONTS) fail('too many fonts');
		let info = { supported: false, bold: false };
		const toUnicode = doc.stream(font?.ToUnicode);
		const encoding = doc.resolve(font?.Encoding);
		const type0 = font?.Subtype?.value === 'Type0';
		if (toUnicode && (!type0 || encoding?.value === 'Identity-H')) {
			const cmap = parseToUnicode(doc.decode(toUnicode), doc.budget);
			if (!type0 || cmap.codeLength === 2) info = { supported: true, ...cmap, ...fontWidths(doc, font, type0) };
		}
		info.bold = /bold|black|heavy|semibold/i.test(String(font?.BaseFont?.value ?? '').slice(0, 128));
		if (key) cache.set(key, info);
		fonts[name] = info;
	}
	if (resolved) doc.resourceFonts.set(resolved, fonts);
	return fonts;
}

/* ------------------------------------------------------ Content streams -- */

const mul = (m, n) => [
	m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
	m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
	m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]
];
const IDENTITY = [1, 0, 0, 1, 0, 0];

function runContent(doc, content, resources, emit, ctm0, fontCache, depth) {
	if (depth > MAX_FORM_DEPTH) fail('form nesting too deep');
	const fonts = loadFonts(doc, resources, fontCache);
	const lexer = new Lexer(content, 0, doc.budget);
	const stack = [];
	let operands = [];
	let ctm = ctm0, tm = IDENTITY, tlm = IDENTITY, leading = 0;
	let font = null, size = 0, charSpacing = 0, wordSpacing = 0, scale = 1;
	const advance = (tx) => { tm = mul([1, 0, 0, 1, tx, 0], tm); };

	const show = (str) => {
		if (!font) fail('text without font');
		if (!font.supported) fail('font without ToUnicode map');
		const start = mul(tm, ctm);
		const runSize = Math.abs(size) * Math.hypot(start[2], start[3]);
		for (let i = 0; i + font.codeLength <= str.bytes.length; i += font.codeLength) {
			const code = font.codeLength === 2 ? (str.bytes.charCodeAt(i) << 8) | str.bytes.charCodeAt(i + 1) : str.bytes.charCodeAt(i);
			const mapped = font.map.get(code);
			const m = mul(tm, ctm);
			const width = ((font.widths.get(code) ?? font.defaultWidth) / 1000) * size;
			const tx = (width + charSpacing + (font.codeLength === 1 && code === 32 ? wordSpacing : 0)) * scale;
			advance(tx);
			const end = mul(tm, ctm);
			emit({ text: mapped ?? '\ufffd', unmapped: mapped == null ? 1 : 0, x: m[4], y: m[5], end: end[4], size: runSize, bold: font.bold });
		}
	};
	const nextLine = (tx, ty) => { tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm; };

	for (;;) {
		const tok = lexer.token();
		if (tok === END) break;
		if (!(tok instanceof Op)) { operands.push(lexer.object(tok)); if (operands.length > 64) fail('operand overflow'); continue; }
		const op = tok.value;
		const n = operands.map((o) => (typeof o === 'number' ? o : NaN));
		switch (op) {
			case 'q': if (stack.length > 64) fail('graphics stack overflow'); stack.push(ctm); break;
			case 'Q': ctm = stack.pop() ?? ctm; break;
			case 'cm': if (n.length === 6 && n.every(Number.isFinite)) ctm = mul(n, ctm); break;
			case 'BT': tm = tlm = IDENTITY; break;
			// Unsichtbarer Text (3) und reiner Clip (7) waeren fuer Leser nicht sichtbar.
			case 'Tr': if (n[0] === 3 || n[0] === 7) fail('invisible text not supported'); break;
			case 'Tc': charSpacing = n[0] || 0; break;
			case 'Tw': wordSpacing = n[0] || 0; break;
			case 'Tz': scale = (n[0] ?? 100) / 100; break;
			case 'Tf': font = fonts[operands[0]?.value] ?? null; size = n[1] || 0; break;
			case 'TL': leading = n[0] || 0; break;
			case 'Td': nextLine(n[0] || 0, n[1] || 0); break;
			case 'TD': leading = -(n[1] || 0); nextLine(n[0] || 0, n[1] || 0); break;
			case 'Tm': if (n.length === 6 && n.every(Number.isFinite)) tm = tlm = n; break;
			case 'T*': nextLine(0, -leading); break;
			case 'Tj': if (operands[0] instanceof Str) show(operands[0]); break;
			case "'": nextLine(0, -leading); if (operands[0] instanceof Str) show(operands[0]); break;
			case '"': wordSpacing = n[0] || 0; charSpacing = n[1] || 0; nextLine(0, -leading); if (operands[2] instanceof Str) show(operands[2]); break;
			case 'TJ':
				for (const part of Array.isArray(operands[0]) ? operands[0] : []) {
					if (part instanceof Str) show(part);
					else if (typeof part === 'number') advance((-part / 1000) * size * scale);
				}
				break;
			case 'BI': {
				const end = content.indexOf('EI', lexer.pos);
				if (end < 0) fail('unterminated inline image');
				lexer.pos = end + 2;
				break;
			}
			case 'Do': {
				const xobjects = doc.resolve(doc.resolve(resources)?.XObject) ?? {};
				const form = doc.stream(xobjects[operands[0]?.value]);
				if (!form) fail('missing XObject');
				if (form.value.Subtype?.value === 'Form') {
					if (++doc.formCalls > MAX_FORM_CALLS) fail('too many form invocations');
					const matrix = Array.isArray(form.value.Matrix) && form.value.Matrix.length === 6 ? form.value.Matrix.map(Number) : IDENTITY;
					runContent(doc, doc.decode(form), form.value.Resources ?? resources, emit, mul(matrix, ctm), fontCache, depth + 1);
				}
				break;
			}
			default: break;
		}
		operands = [];
	}
}

/* ---------------------------------------------------------------- Lines -- */

function clean(text) {
	return text.normalize('NFKC')
		.replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, '')
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ')
		.replace(/[\u25cf\u2022\u25e6\u25aa\u25a0\u2023\u2043]/g, '-')
		.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Liest ein PDF und liefert Zeilen mit Seite, Schriftgroesse und Fett-Anteil.
 * Wirft PdfFormatError fuer alles, was dieser Leser nicht sicher versteht.
 */
export function extractPdfLines(bytes) {
	const doc = new Document(bytes);
	const lines = [];
	let glyphs = 0, unmapped = 0, chars = 0;
	const fontCache = new Map();
	const pages = doc.pages();
	for (const [index, { node, resources }] of pages.entries()) {
		let line = null;
		const flush = () => {
			if (line) {
				const text = clean(line.text);
				if (text && !/^\d{1,3}$/.test(text)) lines.push({ page: index + 1, text, size: Math.round(line.size * 10) / 10, bold: line.bold / Math.max(1, line.chars) > 0.8 });
				chars += text.length;
				if (lines.length > MAX_LINES || chars > MAX_TEXT_CHARS) fail('too much text');
			}
			line = null;
		};
		const emit = (run) => {
			glyphs += 1;
			unmapped += run.unmapped;
			if (glyphs > MAX_GLYPHS) fail('too many glyphs');
			const visible = run.text.replace(/\s/g, '').length;
			const tolerance = Math.max(1, run.size * 0.45);
			if (line && Math.abs(run.y - line.y) <= tolerance) {
				// Wortabstand ohne Leerzeichen-Glyphe: Luecke ab etwa einem Fuenftel em.
				const gap = run.x - line.end;
				if ((gap > run.size * 0.2 || gap < -run.size) && !/\s/.test(line.text.at(-1) ?? '') && !/^\s/.test(run.text)) line.text += ' ';
				line.text += run.text;
				if (line.text.length > MAX_TEXT_CHARS) fail('too much text');
			} else {
				flush();
				line = { y: run.y, text: run.text, size: 0, bold: 0, chars: 0 };
			}
			line.end = run.end;
			line.size = Math.max(line.size, run.size);
			line.bold += run.bold ? visible : 0;
			line.chars += visible;
		};
		const refs = node.Contents == null ? [] : [doc.resolve(node.Contents) instanceof Array ? doc.resolve(node.Contents) : [node.Contents]].flat();
		const contents = refs.map((ref) => {
			const stream = doc.stream(ref);
			if (!stream) fail('missing page content');
			return doc.decode(stream);
		}).join('\n');
		runContent(doc, contents, resources, emit, IDENTITY, fontCache, 0);
		flush();
	}
	if (!glyphs || !lines.length) fail('no extractable text');
	if (unmapped) fail('unmapped glyphs');
	return { title: doc.title() ? clean(doc.title()) : null, pages: pages.length, lines };
}
