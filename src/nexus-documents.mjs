/*
	WORDING UND ANNEX ALS QUELLTEXT FUER DEN AGENTEN.

	Bis 09.10.2026 hat der Agent Wording und Annex nur verlinkt. Jetzt liest
	er sie, aber nur fuer genau das Produkt, das der deterministische Resolver
	in nexus-facts.mjs festgelegt hat, und nur von den Adressen, die der
	Nexus-Katalog fuer dieses Produkt nennt:

	  Katalog-Produkt (productId) -> wordingUrl / annexUrl
	    -> PDF von api.nexusmutual.io/ipfs/<CID> (Zeitlimit, Groessendeckel)
	    -> Text (pdf-text.mjs) -> Abschnitte mit Herkunft
	    -> wenige passende Abschnitte, per Stichwort ausgewaehlt
	    -> Modell erklaert diese Abschnitte, Links bleiben dran

	Was nicht sicher lesbar ist, faellt geschlossen aus: dann bekommt das
	Modell keinen Text, und es bleibt bei den Links. Ein Wording ohne seinen
	Annex wird nie allein verwendet - der Annex geht laut Wording vor und kann
	gedeckte Ereignisse ausschliessen.

	Der Dokumenttext ist fremder Inhalt. Er landet nur im Datenkanal des
	Modells, nie in den Anweisungen, und keine URL darin wird je abgerufen.
*/

import { createHash } from 'node:crypto';
import { extractPdfLines } from './pdf-text.mjs';
import { normalize } from './nexus-facts.mjs';

const DOCUMENT_URL = /^https:\/\/api\.nexusmutual\.io\/ipfs\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_DOCUMENT_BYTES = 6 * 1024 * 1024;
const DOCUMENT_TTL_MS = 24 * 60 * 60 * 1000;
// Ein Fehlschlag wird kurz gemerkt, damit wiederholte Fragen dasselbe defekte
// oder haengende Dokument nicht jedes Mal neu laden und parsen.
const FAILURE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 64;
const MAX_SECTION_CHARS = 1_600;
const MAX_PASSAGES = 6;
const MAX_PASSAGE_BUDGET = 7_000;
const MAX_ANNEX_PASSAGES = 2;

const documentCache = new Map();

export class DocumentUnavailableError extends Error {
	constructor(reason) { super(reason); this.reason = reason; }
}

export function isAuthoritativeDocumentUrl(url) {
	return typeof url === 'string' && DOCUMENT_URL.test(url);
}

/* ---------------------------------------------------------------- Fetch -- */

async function readLimited(response, maxBytes) {
	const reader = response.body?.getReader?.();
	if (!reader) {
		const buffer = Buffer.from(await response.arrayBuffer());
		if (buffer.length > maxBytes) throw new DocumentUnavailableError('DOCUMENT_TOO_LARGE');
		return buffer;
	}
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new DocumentUnavailableError('DOCUMENT_TOO_LARGE');
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

async function fetchPdf(url, fetchImpl, { timeoutMs, maxBytes }) {
	let response;
	try {
		response = await fetchImpl(url, { headers: { accept: 'application/pdf' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
	} catch {
		throw new DocumentUnavailableError('FETCH_FAILED');
	}
	if (!response?.ok) throw new DocumentUnavailableError('HTTP_ERROR');
	const type = String(response.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (type !== 'application/pdf') throw new DocumentUnavailableError('UNSUPPORTED_CONTENT_TYPE');
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) throw new DocumentUnavailableError('DOCUMENT_TOO_LARGE');
	try {
		return await readLimited(response, maxBytes);
	} catch (error) {
		if (error instanceof DocumentUnavailableError) throw error;
		throw new DocumentUnavailableError('FETCH_FAILED');
	}
}

/* ------------------------------------------------------------- Sections -- */

const letters = (text) => text.replace(/[^A-Za-z]/g, '');

function isHeading(line, bodySize, previousHeading) {
	const text = line.text;
	if (text.length > 100 || /[,;]$/.test(text) || !/[A-Za-z]{3}/.test(text)) return false;
	if (text === previousHeading) return false; // wiederholte Tabellenkoepfe
	const caps = letters(text);
	if (line.bold) return true;
	if (caps.length >= 4 && caps === caps.toUpperCase()) return true;
	if (/^PART [A-Z]\b/.test(text)) return true;
	return line.size > bodySize + 1.5;
}

/** Lange Abschnitte an Klausel- oder Definitionsgrenzen teilen, nie mitten in einer Zeile. */
function chunk(lines) {
	const parts = [];
	let current = [];
	let length = 0;
	for (const line of lines) {
		const boundary = /^(\d+(\.\d+)*\.?\s|[a-z]\.\s|-\s|"[^"]{2,60}"\s+means\b)/i.test(line);
		if (current.length && length + line.length > MAX_SECTION_CHARS && (boundary || length > MAX_SECTION_CHARS * 1.5)) {
			parts.push(current);
			current = [];
			length = 0;
		}
		current.push(line);
		length += line.length + 1;
	}
	if (current.length) parts.push(current);
	return parts;
}

export function parseSections(lines, { productId, documentKind, sourceUrl, title = null }) {
	const sizes = new Map();
	for (const line of lines) sizes.set(line.size, (sizes.get(line.size) ?? 0) + line.text.length);
	const bodySize = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
	const raw = [];
	let current = { heading: title ?? (documentKind === 'annex' ? 'Annex' : 'Cover wording'), lines: [] };
	let titleBlock = true;
	for (const line of lines) {
		if (titleBlock && line.size > bodySize + 1.5) { current.lines.push(line.text); continue; }
		titleBlock = false;
		if (isHeading(line, bodySize, current.heading)) {
			if (current.lines.length) raw.push(current);
			current = { heading: line.text, lines: [] };
		} else {
			current.lines.push(line.text);
		}
	}
	if (current.lines.length) raw.push(current);
	const sections = [];
	for (const section of raw) {
		const parts = chunk(section.lines);
		parts.forEach((part, i) => sections.push({
			productId,
			documentKind,
			sourceUrl,
			sectionIndex: sections.length,
			heading: parts.length > 1 && i > 0 ? `${section.heading} (cont.)` : section.heading,
			text: part.join('\n')
		}));
	}
	return sections;
}

/* -------------------------------------------------------------- Documents -- */

function cacheKey(productId, url) {
	return `${productId}|${url}`;
}

function remember(key, entry) {
	documentCache.delete(key);
	documentCache.set(key, entry);
	while (documentCache.size > MAX_CACHE_ENTRIES) documentCache.delete(documentCache.keys().next().value);
}

export async function fetchAuthoritativeDocument({ productId, kind, url }, { fetchImpl = fetch, now = Date.now(), timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_DOCUMENT_BYTES } = {}) {
	if (!Number.isSafeInteger(productId) || productId < 0) throw new DocumentUnavailableError('INVALID_PRODUCT');
	if (kind !== 'wording' && kind !== 'annex') throw new DocumentUnavailableError('INVALID_KIND');
	if (!isAuthoritativeDocumentUrl(url)) throw new DocumentUnavailableError('URL_NOT_AUTHORITATIVE');
	const key = cacheKey(productId, url);
	const cached = documentCache.get(key);
	if (cached?.failure && now - cached.at < FAILURE_TTL_MS) throw new DocumentUnavailableError(cached.failure);
	if (cached?.document && now - cached.at < DOCUMENT_TTL_MS && cached.document.kind === kind) return cached.document;
	try {
		const document = await loadDocument({ productId, kind, url }, fetchImpl, { now, timeoutMs, maxBytes });
		remember(key, { at: now, document });
		return document;
	} catch (error) {
		const reason = error instanceof DocumentUnavailableError ? error.reason : 'DOCUMENT_ERROR';
		remember(key, { at: now, failure: reason });
		throw new DocumentUnavailableError(reason);
	}
}

async function loadDocument({ productId, kind, url }, fetchImpl, { now, timeoutMs, maxBytes }) {
	const bytes = await fetchPdf(url, fetchImpl, { timeoutMs, maxBytes });
	let extracted;
	try { extracted = extractPdfLines(bytes); }
	catch { throw new DocumentUnavailableError('UNSUPPORTED_DOCUMENT_FORMAT'); }
	const title = extracted.title || null;
	const document = Object.freeze({
		productId,
		kind,
		url,
		fetchedAt: new Date(now).toISOString(),
		contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
		title,
		sections: Object.freeze(parseSections(extracted.lines, { productId, documentKind: kind, sourceUrl: url, title }).map(Object.freeze))
	});
	if (!document.sections.length) throw new DocumentUnavailableError('NO_SECTIONS');
	return document;
}

/**
 * Wording und (falls im Katalog vorhanden) Annex genau eines Katalog-Produkts.
 * Alles oder nichts: faellt ein Teil aus, gibt es keine Dokumente.
 */
export async function getProductDocuments(product, options = {}) {
	if (!Number.isSafeInteger(product?.productId)) throw new DocumentUnavailableError('INVALID_PRODUCT');
	if (!product.wordingUrl) throw new DocumentUnavailableError('WORDING_UNAVAILABLE');
	if (product.productTerms === 'UNSUPPORTED') throw new DocumentUnavailableError('PRODUCT_TERMS_UNSUPPORTED');
	if (product.productTerms === 'ANNEX' && !product.annexUrl) throw new DocumentUnavailableError('ANNEX_UNAVAILABLE');
	const wanted = [{ kind: 'wording', url: product.wordingUrl }];
	if (product.annexUrl) wanted.push({ kind: 'annex', url: product.annexUrl });
	const documents = await Promise.all(wanted.map(({ kind, url }) => fetchAuthoritativeDocument({ productId: product.productId, kind, url }, options)));
	for (const document of documents) {
		if (document.productId !== product.productId) throw new DocumentUnavailableError('PRODUCT_MISMATCH');
	}
	return { productId: product.productId, documents };
}

/* ------------------------------------------------------------ Retrieval -- */

const QUESTION_TYPES = {
	coverage: /\b(what (?:does|do|is) .{1,60} cover|gedeckt\w*|deckt|abgedeckt|deckung\w*|versichert\w*|abgesichert|absichern|schutzt|geschutzt|covered|covers|coverage|insured|protected|protection|leistung\w*|bedingungen|wording|annex|anhang|terms|conditions|was ist (?:da|dabei|darin) drin)\b/,
	exclusion: /\b(ausschluss\w*|ausgeschlossen\w*|nicht (?:gedeckt|versichert|abgedeckt)|exclu\w*|not covered|ausnahme\w*)\b/,
	claim: /\b(claim\w*|schaden\w*|anspruch\w*|auszahl\w*|ausbezahlt|erstatt\w*|entschadig\w*|payout|pay out|paid|pays|reimburs\w*|einreichen|submit\w*|selbstbehalt|deductible|nachfrist|grace|wartezeit|cool ?down|zahlt|bezahlt|refund\w*|verlust\w*|verlier\w*|verloren|loss|losses|lose)\b/
};

/** Fragebegriff (DE/EN, normalisiert) -> Begriff im englischen Dokument. */
const TERMS = [
	[/\b(orakel\w*|oracle\w*)\b/, /oracle/gi],
	[/\bmanipul\w*/, /manipulat/gi],
	[/\bliquidat\w*/, /liquidat/gi],
	[/\b(governance|ubernahme|takeover\w*)\b/, /governance/gi],
	[/\b(hack\w*|exploit\w*|bugs?|code ?fehler|fehler im code|smart ?contracts?|sicherheitslucke\w*)\b/, /smart contract|code bug|unintended/gi],
	[/\b(phishing|private? ?keys?|privat\w* schlussel\w*|seed\w*|malware)\b/, /phishing|private key|malware|compromised wallet/gi],
	[/\b(de ?peg\w*|stablecoin\w*)\b/, /de-?peg|stablecoin/gi],
	[/\b(kurs\w*|preis\w*|prices?|price movement\w*|volatil\w*)\b/, /market price|price movement|price feed/gi],
	[/\b(bridge\w*|brucke\w*)\b/, /bridg/gi],
	[/\b(rug ?pull\w*|betrug\w*|scam\w*)\b/, /rug pull|confiscat|stealing/gi],
	[/\b(frontend|website|webseite|user interface|benutzeroberflache|ui)\b/, /user interface|website/gi],
	[/\b(selbstbehalt|deductible)\b/, /deductible/gi],
	[/\b(wartezeit|cool ?down)\b/, /cool down/gi],
	[/\b(nachfrist|grace)\b/, /grace period/gi],
	[/\b(frist\w*|wie lange|how long|deadline|zeitraum|zeitlich\w*)\b/, /grace period|cool down/gi],
	[/\b(chains?|netzwerk\w*|networks?|l2|layer 2|non evm)\b/, /chain|network|ethereum virtual machine/gi],
	[/\b(kyc|mitglied\w*|members?|membership)\b/, /member|know your customer/gi],
	[/\b(markt|markte|markets?|hubs?|vaults?|pools?|strateg\w*)\b/, /market|hub|vault|pool|strateg/gi],
	[/\b(admin\w*|pause\w*|pausier\w*)\b/, /administrative|pausing/gi],
	[/\b(transfer\w*|nft|ubertrag\w*)\b/, /transfer|cover nft/gi],
	[/\b(limit\w*|hochst\w*|maximal\w*|sublimit\w*|obergrenze\w*)\b/, /limit|cover amount/gi]
];

const SECTION_TYPES = {
	coverage: { heading: /covered event|designated|scope|covered (?:vault|market|protocol|asset)|^terms$/i, text: /covered events?|designated (?:protocol|hub|market|vault)|covered (?:vault|market)/i },
	exclusion: { heading: /exclu/i, text: /exclu|not be able to submit a claim/i },
	claim: { heading: /claim|redeem|deductible/i, text: /claim amount|submit a claim|cool down|grace period/i }
};

export function classifyWordingQuestion(question) {
	const q = ` ${normalize(String(question ?? '').replace(/ß/g, 'ss'))} `;
	const types = Object.entries(QUESTION_TYPES).filter(([, re]) => re.test(q)).map(([type]) => type);
	const terms = TERMS.filter(([re]) => re.test(q)).map(([, documentTerm]) => documentTerm);
	if (!types.length && !terms.length) return null;
	return { types: types.length ? types : ['coverage'], terms };
}

const count = (re, text) => Math.min(3, (text.match(re) ?? []).length);

function scoreSection(section, { types, terms }) {
	let score = 0;
	for (const type of types) {
		const rule = SECTION_TYPES[type];
		if (rule.heading.test(section.heading)) score += 8;
		else if (rule.text.test(section.text)) score += 3;
	}
	for (const term of terms) score += count(term, section.heading) * 6 + count(term, section.text) * 5;
	if (section.documentKind === 'annex') {
		// Im Annex begrenzen auch ausgeschlossene Maerkte oder Ereignisse die Deckung.
		if (types.includes('coverage') && /exclu|designated|covered/i.test(section.heading)) score += 8;
		if (score > 0) score += 4;
	}
	return score;
}

/** Wenige passende Abschnitte, nur aus den Dokumenten genau dieses Produkts. */
export function selectPassages(productDocuments, question) {
	const classification = classifyWordingQuestion(question);
	if (!classification) return null;
	const { productId, documents } = productDocuments;
	const sections = documents.flatMap((document) => document.sections).filter((section) => section.productId === productId);
	const scored = sections
		.map((section) => ({ section, score: scoreSection(section, classification) }))
		.sort((a, b) => b.score - a.score || a.section.sectionIndex - b.section.sectionIndex);
	// Schwache Treffer nur, wenn nichts Besseres da ist.
	const floor = Math.max(1, (scored[0]?.score ?? 0) * 0.4);
	const ranked = scored.filter(({ score }) => score >= floor);
	// Der Annex geht dem Wording vor; seine besten Abschnitte kommen zuerst.
	const annex = ranked.filter(({ section }) => section.documentKind === 'annex').slice(0, MAX_ANNEX_PASSAGES);
	// Wie Wording und Annex zueinander stehen, sagt das Wording selbst - diese Stelle kommt mit.
	const precedence = annex.length
		? sections.filter((s) => s.documentKind === 'wording' && /\bannex\b[^.]{0,60}\bprevail/i.test(s.text)).slice(0, 1).map((section) => ({ section }))
		: [];
	const chosen = [];
	let budget = MAX_PASSAGE_BUDGET;
	for (const { section } of [...annex, ...precedence, ...ranked]) {
		if (chosen.length >= MAX_PASSAGES || chosen.includes(section)) continue;
		if (section.text.length > budget) continue;
		chosen.push(section);
		budget -= section.text.length;
	}
	const order = (s) => (s.documentKind === 'wording' ? 0 : 1) * 1e6 + s.sectionIndex;
	return {
		productId,
		questionTypes: classification.types,
		passages: chosen.sort((a, b) => order(a) - order(b)).map((s) => ({
			productId: s.productId,
			source: s.documentKind,
			heading: s.heading,
			text: s.text,
			sourceUrl: s.sourceUrl,
			sectionIndex: s.sectionIndex
		}))
	};
}

/**
 * Modellkontext fuer eine Deckungsfrage zu genau einem aufgeloesten Produkt.
 * null: die Frage betrifft das Wording nicht, es wird nichts geladen.
 * Wirft nie; Ausfaelle werden zu status UNAVAILABLE.
 */
export async function getWordingPassages(product, question, options = {}) {
	if (!classifyWordingQuestion(question)) return null;
	const base = { productId: product?.productId ?? null, officialName: product?.officialName ?? null };
	try {
		const productDocuments = await getProductDocuments(product, options);
		const selection = selectPassages(productDocuments, question);
		const documents = productDocuments.documents.map(({ kind, url, title, fetchedAt, contentHash }) => ({ kind, url, title, fetchedAt, contentHash }));
		if (!selection?.passages.length) return { ...base, status: 'NO_RELEVANT_PASSAGES', documents };
		return {
			...base,
			status: 'AVAILABLE',
			completeness: 'EXCERPTS_ONLY',
			questionTypes: selection.questionTypes,
			documents,
			passages: selection.passages
		};
	} catch (error) {
		return { ...base, status: 'UNAVAILABLE', reason: error instanceof DocumentUnavailableError ? error.reason : 'DOCUMENT_ERROR' };
	}
}

export const _test = { reset: () => documentCache.clear(), cacheSize: () => documentCache.size };
