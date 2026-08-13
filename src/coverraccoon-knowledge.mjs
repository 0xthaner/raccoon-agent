const cache = new Map();
const CACHE_MS = 5 * 60_000;
const MAX_ENTRIES = 8;

const topicTerms = {
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
	return [...entries].map((entry, index) => ({
		entry, index,
		score: (topicTerms[entry.id] ?? []).reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0)
	})).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, Math.max(1, limit)).map(({ entry }) => entry);
}

export async function getCoverraccoonKnowledge(question, language = 'de', fetchImpl = fetch) {
	const apiKey = process.env.COVER_AGENT_KNOWLEDGE_API_KEY?.trim() || '';
	const baseUrl = (process.env.COVER_DATA_BASE_URL?.trim() || 'https://coverraccoon.com').replace(/\/$/, '');
	if (!apiKey) return '';
	const apiLanguage = language === 'de' ? 'de' : 'en';
	let entries = cache.get(apiLanguage);
	if (!entries || entries.expiresAt <= Date.now()) {
		try {
			const response = await fetchImpl(`${baseUrl}/api/agent/v1/knowledge?lang=${apiLanguage}`, {
				headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
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
