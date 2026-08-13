const cache = new Map();
const catalogCache = new Map();
const CACHE_MS = 5 * 60_000;
const MAX_ENTRIES = 64;
const MAX_CATALOG_MATCHES = 4;

const topicTerms = {
	'coverraccoon.overview': ['coverraccoon', 'raccoon', 'plattform', 'platform', 'macht', 'about'],
	'cover.basics': ['cover', 'schutz', 'onchain', 'risiko', 'risk', 'wording', 'versicherung', 'insurance'],
	'cover.gap-check': ['gap', 'lücke', 'luecke', 'gedeckt', 'deckung', 'coverage', 'excluded', 'ausgeschlossen', 'conditional', 'bedingt'],
	'cover.score': ['score', 'bewertung', 'rating', 'punkte', 'stark', 'schwach'],
	'cover.audience': ['retail', 'team', 'nutzer', 'user', 'anspruch', 'zielgruppe'],
	'cover.provider-broker': ['broker', 'aggregator', 'risikoträger', 'risikotraeger', 'underwriter', 'vermittler'],
	'cover.buying': ['kaufen', 'kauf', 'buy', 'approve', 'freigabe', 'prämie', 'premium', 'provision'],
	'cover.renewal': ['verlängerung', 'verlaengerung', 'renewal', 'renew', 'verlängern', 'verlaengern'],
	'cover.nft-wallet': ['nft', 'wallet', 'owner', 'besitz', 'ethereum'],
	'broker.opencover': ['opencover', 'broker', 'aggregator'],
	'nexus.overview': ['nexus', 'mutual', 'anbieter', 'provider', 'versicherung', 'insurance', 'discretionary', 'mitglied'],
	'nexus.mechanics': ['funktion', 'ablauf', 'pool', 'stake', 'staking', 'nxm', 'kapital', 'premium', 'prämie', 'reward'],
	'nexus.coverage': ['gedeckt', 'deckung', 'cover', 'schutz', 'hack', 'exploit', 'depeg', 'ausgeschlossen', 'coverage', 'excluded'],
	'nexus.conditions': ['bedingung', 'wording', 'grace', 'frist', 'selbstbehalt', 'deductible', 'waiting', 'nachweis'],
	'nexus.claims': ['claim', 'schaden', 'auszahlung', 'committee', 'abgelehnt', 'accepted', 'payout'],
	'nexus.market': ['preis', 'price', 'kapazität', 'capacity', 'produkt', 'market', 'kaufen', 'buy']
};

export function parseKnowledgeResponse(result) {
	if (result?.apiVersion !== 'agent-knowledge.v1' || !Array.isArray(result.entries)) return [];
	return result.entries.slice(0, MAX_ENTRIES).flatMap((entry) => {
		if (!entry || entry.access !== 'public' || typeof entry.id !== 'string' || typeof entry.title !== 'string' || typeof entry.content !== 'string' || typeof entry.sourceUrl !== 'string' || typeof entry.updatedAt !== 'string') return [];
		let url;
		try { url = new URL(entry.sourceUrl); } catch { return []; }
		if (url.protocol !== 'https:' || url.hostname !== 'coverraccoon.com') return [];
		return [{
			id: entry.id.slice(0, 80), title: entry.title.slice(0, 160), content: entry.content.slice(0, 6_000),
			sourceUrl: url.toString(), updatedAt: entry.updatedAt.slice(0, 10), origin: String(entry.origin ?? 'unknown').slice(0, 32)
		}];
	});
}

export function selectKnowledge(entries, question, limit = 4) {
	const text = String(question ?? '').toLowerCase();
	const queryWords = new Set(words(text));
	return [...entries].map((entry, index) => ({
		entry, index,
		score: (topicTerms[entry.id] ?? []).reduce((sum, term) => sum + (text.includes(term) ? 3 : 0), 0)
			+ words(`${entry.id} ${entry.title}`).reduce((sum, word) => sum + (queryWords.has(word) ? 1 : 0), 0)
	})).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, Math.max(1, limit)).map(({ entry }) => entry);
}

export async function getCoverraccoonKnowledge(question, language = 'de', fetchImpl = fetch) {
	const baseUrl = (process.env.COVER_DATA_BASE_URL?.trim() || 'https://coverraccoon.com').replace(/\/$/, '');
	const apiLanguage = language === 'de' ? 'de' : 'en';
	let entries = cache.get(apiLanguage);
	if (!entries || entries.expiresAt <= Date.now()) {
		try {
			const response = await fetchImpl(`${baseUrl}/api/agent/v1/knowledge?lang=${apiLanguage}`, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(8_000)
			});
			if (!response.ok) return '';
			const parsed = parseKnowledgeResponse(await response.json());
			if (!parsed.length) return '';
			entries = { value: parsed, expiresAt: Date.now() + CACHE_MS };
			cache.set(apiLanguage, entries);
		} catch {
			return '';
		}
	}
	return selectKnowledge(entries.value, question).map((entry) => [
		`[${entry.id}] ${entry.title}`,
		entry.content,
		`Source: ${entry.sourceUrl}`,
		`Updated: ${entry.updatedAt} · Origin: ${entry.origin}`
	].join('\n')).join('\n\n');
}

function words(value) {
	return String(value ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]{3,}/g) ?? [];
}

export function parseAnalysisCatalog(result) {
	if (String(result?.apiVersion) !== '1' || !Array.isArray(result.analyses)) return [];
	return result.analyses.slice(0, 500).flatMap((entry) => {
		if (!entry || typeof entry.name !== 'string' || typeof entry.product !== 'string' || typeof entry.provider !== 'string' || typeof entry.web !== 'string') return [];
		let web;
		try { web = new URL(entry.web); } catch { return []; }
		if (web.protocol !== 'https:' || web.hostname !== 'coverraccoon.com' || !web.pathname.startsWith('/cover/')) return [];
		return [{
			name: entry.name.slice(0, 180), subject: String(entry.subject ?? '').slice(0, 180),
			provider: entry.provider.slice(0, 80), product: entry.product.slice(0, 120), web: web.toString(),
			score: Number.isFinite(entry.raccoonScore) ? entry.raccoonScore : null,
			asOf: String(entry.asOf ?? '').slice(0, 10)
		}];
	});
}

export function selectAnalysisCatalog(entries, question, limit = MAX_CATALOG_MATCHES) {
	const query = new Set(words(question).filter((word) => !['analyse', 'analysis', 'review', 'bewertung', 'komplett', 'complete', 'full', 'vollstandig', 'cover', 'produkt', 'product', 'bitte', 'zeige', 'show'].includes(word)));
	if (!query.size) return [];
	return entries.map((entry, index) => {
		const searchable = new Set(words(`${entry.name} ${entry.subject} ${entry.provider} ${entry.product}`));
		const score = [...query].reduce((sum, word) => sum + (searchable.has(word) ? 1 : 0), 0);
		return { entry, index, score };
	}).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map(({ entry }) => entry);
}

async function loadAnalysisCatalog(fetchImpl) {
	const baseUrl = (process.env.COVER_DATA_BASE_URL?.trim() || 'https://coverraccoon.com').replace(/\/$/, '');
	let entries = catalogCache.get(baseUrl);
	if (!entries || entries.expiresAt <= Date.now()) {
		try {
			const response = await fetchImpl(`${baseUrl}/api/cover/v1/analyses`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
			if (!response.ok) return null;
			const parsed = parseAnalysisCatalog(await response.json());
			if (!parsed.length) return null;
			entries = { value: parsed, expiresAt: Date.now() + CACHE_MS };
			catalogCache.set(baseUrl, entries);
		} catch { return null; }
	}
	return { baseUrl, entries: entries.value };
}

export async function getCoverAnalysisReferences(question, fetchImpl = fetch) {
	const catalog = await loadAnalysisCatalog(fetchImpl);
	if (!catalog) return '';
	return selectAnalysisCatalog(catalog.entries, question).map((entry) => [
		`Product: ${entry.name}`,
		entry.subject ? `Subject: ${entry.subject}` : '',
		`Public summary score: ${entry.score ?? 'not scored'}`,
		`Full analysis page: ${entry.web}`,
		`Analysis date: ${entry.asOf || 'unknown'}`
	].filter(Boolean).join('\n')).join('\n\n');
}

function localText(value, language) {
	if (typeof value === 'string') return value;
	if (!value || typeof value !== 'object') return '';
	return String(value[language === 'de' ? 'de' : 'en'] ?? value.en ?? '').slice(0, 1_000);
}

export function parseGapCheck(result, language = 'de') {
	if (!result || !Array.isArray(result.coverage) || !Array.isArray(result.redFlags) || typeof result.web !== 'string') return null;
	let web;
	try { web = new URL(result.web); } catch { return null; }
	if (web.protocol !== 'https:' || web.hostname !== 'coverraccoon.com' || !web.pathname.startsWith('/cover/')) return null;
	const coverage = result.coverage.slice(0, 20).flatMap((item) => {
		if (!item || !['covered', 'conditional', 'excluded'].includes(item.status)) return [];
		const risk = localText(item.risk, language);
		const note = localText(item.note, language);
		return risk && note ? [{ risk, status: item.status, note }] : [];
	});
	const redFlags = result.redFlags.slice(0, 20).map((item) => localText(item, language)).filter(Boolean);
	if (!coverage.length) return null;
	return { coverage, redFlags, web: web.toString(), asOf: String(result.asOf ?? '').slice(0, 10) };
}

export async function getCoverGapCheck(question, language = 'de', fetchImpl = fetch) {
	if (!/\b(gap|lücke|luecke|deckt|gedeckt|deckung|coverage|cover|risiko|risk|ausschluss|ausgeschlossen|excluded|bedingt|conditional|red.?flag|hack|exploit|depeg|oracle|slashing)\w*/i.test(String(question ?? ''))) return '';
	const catalog = await loadAnalysisCatalog(fetchImpl);
	if (!catalog) return '';
	const match = selectAnalysisCatalog(catalog.entries, question, 1)[0];
	if (!match) return '';
	try {
		const response = await fetchImpl(`${catalog.baseUrl}/api/cover/v1/analyses/${encodeURIComponent(match.provider)}/${encodeURIComponent(match.product)}/check`, {
			headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000)
		});
		if (!response.ok) return '';
		const check = parseGapCheck(await response.json(), language);
		if (!check) return '';
		return [
			`Product: ${match.name}`,
			...check.coverage.map((item) => `${item.risk}: ${item.status}. ${item.note}`),
			...(check.redFlags.length ? ['Public red flags:', ...check.redFlags.map((flag) => `- ${flag}`)] : []),
			`Full analysis page: ${check.web}`,
			`Checked as of: ${check.asOf || match.asOf || 'unknown'}`
		].join('\n');
	} catch { return ''; }
}
